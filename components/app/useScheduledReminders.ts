import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { Message, Language, LocationConfig, WorldBookEntry, AnchorEntry, TtsConfig, MessageAlertKind } from '../../types';
import type { RelativeReminder, DailyReminder } from '../../store/slices/reminderSlice';
import {
  triggerTimedReminderMessage as triggerTimedReminderMessageAction,
  prewarmTimedReminderMessage as prewarmTimedReminderMessageAction,
  type ChatActionRefs,
  type ExecuteSendHelpers,
} from './chatActions';
import {
  shouldKickReminderPrewarm,
  readReminderPrewarm,
  cancelReminderPrewarm,
} from '../../services/reminderPrewarmService';
import { getTimePartsInTimezone } from './backupHelpers';
import { getNextDailyReminderAt, getDueDailyReminderRange } from './reminderScheduling';
import type { TimedReminderContext } from '../../services/reminderPrompt';
import { getCapacitorPlatform, isCapacitorNative } from '../../services/environment';
import {
  EXACT_ALARM_FALLBACK_NOTICE_STORAGE_KEY,
  addAlarmFiredListener,
  cancelAndroidAlarm,
  listScheduledAndroidAlarms,
  scheduleAndroidAlarm,
  type ScheduleAlarmResult,
} from '../../services/androidAlarmService';
import { ensureNativeRingtoneForAlarm } from '../../services/voiceFileService';
import { useAppStore } from '../../store';
import { db } from '../../services/db';
import { getDataRestoreVersion, isDataRestoreBlocked } from '../../services/dataRestoreGate';
import { abandonReminderOccurrence, claimReminderOccurrence, commitReminderMessage, finishReminderOccurrence, isReminderOccurrenceCurrent, markReminderSending, recordPriorDailyMisses, reminderGraceMs } from '../../services/reminderOccurrences';
import type { MessageEntity } from '../../services/db';
import { drainReminderNativeCancellationsLocked, withReminderNativeAlarmLock, REMINDER_NATIVE_CANCEL_KEY } from '../../services/reminderNativeCancellation';
import { DAILY_REMINDER_STORAGE_KEY, KUMIKO_MISSED_REMINDERS_STORAGE_KEY, RELATIVE_REMINDER_STORAGE_KEY } from '../../store/slices/reminderSlice';

type FlowState = 'INTRO' | 'AUTH' | 'CONFIG' | 'APP';

type RunVoicePipeline = ExecuteSendHelpers['runVoicePipeline'];
type AddMessage = (
  role: 'user' | 'model',
  text: string,
  ...rest: any[]
) => string;
type ShowBackgroundMessageNotification = (
  body: string,
  kind?: MessageAlertKind,
  messageId?: string,
) => void;

export interface UseScheduledRemindersParams {
  // Flow / dispatch gate
  flowState: FlowState;
  isTalking: boolean;
  isThinking: boolean;

  // Refs required by triggerTimedReminderMessageAction
  messagesRef: MutableRefObject<Message[]>;
  ttsConfigRef: MutableRefObject<TtsConfig>;

  // Helpers required by triggerTimedReminderMessageAction
  runVoicePipeline: RunVoicePipeline;

  // Reminder store getters / mutators
  getRelativeReminders: () => Promise<RelativeReminder[]> | RelativeReminder[];
  getDailyReminders: () => Promise<DailyReminder[]> | DailyReminder[];
  removeRelativeReminder: (reminderId: string) => Promise<void>;
  markRelativeReminderRetry: (reminderId: string) => Promise<void>;
  markDailyReminderTriggered: (reminderId: string, dateKey: string) => Promise<void>;
  markDailyReminderRetry: (reminderId: string) => Promise<void>;

  // Store values kept in deps for 1:1 preservation with the pre-extraction
  // useCallback (even though triggerTimedReminderMessageAction reads them
  // live via useAppStore.getState() — we keep them here so the callback
  // identity, and therefore the interval reset cadence, matches the
  // original behaviour exactly).
  language: Language;
  contextLimit: number;
  coreMemory: string;
  worldBook: WorldBookEntry[];
  locationConfig: LocationConfig;
  anchors: AnchorEntry[];
  kumikoNotebook: string;
  addMessage: AddMessage;
  showBackgroundMessageNotification: ShowBackgroundMessageNotification;
}

/**
 * Owns the 1-second scheduled-reminder dispatcher and the
 * `triggerTimedReminderMessage` callback it calls. Both lived inline in
 * App.tsx (L1476 + L1666 pre-refactor).
 *
 * Behaviour preserved 1:1:
 * - Polling runs only while flowState === 'APP'
 * - `reminderDispatchingRef` idempotence lock (moved from App.tsx into
 *   this hook via useRef, same observable semantics)
 * - Relative reminders with dueAt <= now (and past retryAt) fire first,
 *   in ascending dueAt order; on success `removeRelativeReminder`, on
 *   failure `markRelativeReminderRetry`.
 * - Daily reminders fire when their hour/minute matches the local
 *   timezone clock, and only once per dateKey; on success
 *   `markDailyReminderTriggered`, on failure `markDailyReminderRetry`.
 * - 1-second setInterval plus a 1.5-second initial setTimeout (belt +
 *   suspenders fast-path for when the tab becomes active mid-second).
 *
 * Note: the dep list for `triggerTimedReminderMessage` intentionally
 * includes several values that the body does not syntactically use
 * (language/contextLimit/coreMemory/worldBook/locationConfig/anchors/
 * kumikoNotebook/addMessage/showBackgroundMessageNotification). The
 * underlying action reads them live from the store; keeping them in
 * deps preserves the original cadence at which the callback identity
 * -- and therefore the polling interval -- is rebuilt.
 */
export const useScheduledReminders = (params: UseScheduledRemindersParams): void => {
  const {
    flowState,
    isTalking,
    isThinking,
    messagesRef,
    ttsConfigRef,
    runVoicePipeline,
    getRelativeReminders,
    getDailyReminders,
    removeRelativeReminder,
    markRelativeReminderRetry,
    markDailyReminderTriggered,
    markDailyReminderRetry,
    language,
    contextLimit,
    coreMemory,
    worldBook,
    locationConfig,
    anchors,
    kumikoNotebook,
    addMessage,
    showBackgroundMessageNotification,
  } = params;

  const reminderDispatchingRef = useRef<boolean>(false);
  // v2.14.27: latest checkScheduledReminders reference. Stored in a ref so
  // the kumikoAlarmFired native-bridge listener (registered in a separate
  // useEffect with stable deps) can force a dispatch tick without
  // re-subscribing every time the polling closure rebuilds.
  const checkScheduledRemindersRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const triggerTimedReminderMessage = useCallback(async (
    // v2.14.29 H10: widen to accept `originalDueAt` so the boot-rescued
    // late-chat path can route to the late prompt template. Daily branch
    // doesn't carry it (recurring reminders never get rescued).
    reminder: TimedReminderContext,
    reminderId?: string,
    deliveryGuard?: { begin: () => Promise<boolean>; current: () => Promise<boolean>; commit: (message: MessageEntity) => Promise<boolean>; messageId: string },
  ): Promise<boolean> => {
    return triggerTimedReminderMessageAction(
      { messagesRef, ttsConfigRef } as Pick<ChatActionRefs, 'messagesRef' | 'ttsConfigRef'>,
      { runVoicePipeline },
      reminder,
      reminderId,
      deliveryGuard,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 1:1 preserve pre-extraction deps; body only uses refs + runVoicePipeline but action reads store live
  }, [language, contextLimit, coreMemory, worldBook, locationConfig, anchors, kumikoNotebook, addMessage, showBackgroundMessageNotification]);

  // v2.14.28 H17.A: kick a T-60s prewarm for upcoming relative reminders so
  // the LLM (and TTS, if voice mode permits) finishes before the trigger
  // moment. Only fires when the app is backgrounded / minimized / locked
  // (document.visibilityState === 'hidden') — foreground users don't need
  // the speed-up since the dispatcher's just-in-time path is already
  // visible to them. Idempotent: startReminderPrewarm bails if a prewarm
  // is already in flight or finished for the same reminder id.
  const triggerPrewarm = useCallback((reminder: RelativeReminder) => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'hidden') return;
    const existing = readReminderPrewarm(reminder.id);
    if (existing && (existing.status === 'pending' || existing.status === 'llm-ready' || existing.status === 'ready')) return;
    void prewarmTimedReminderMessageAction(
      { messagesRef, ttsConfigRef } as Pick<ChatActionRefs, 'messagesRef' | 'ttsConfigRef'>,
      { runVoicePipeline },
      // v2.14.29 H10: pass `originalDueAt` so the prewarmed prompt
      // matches what the live trigger path will use; otherwise the cache
      // hit at T=0 would deliver an on-time reply for a late reminder.
      {
        id: reminder.id,
        event: reminder.event,
        sourceText: reminder.sourceText,
        dueAt: reminder.dueAt,
        originalDueAt: reminder.originalDueAt,
      },
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mirrors triggerTimedReminderMessage deps so identity churns at the same cadence
  }, [language, contextLimit, coreMemory, worldBook, locationConfig, anchors, kumikoNotebook, addMessage, showBackgroundMessageNotification]);

  useEffect(() => {
      if (flowState !== 'APP') return;

      const checkScheduledReminders = async () => {
          if (reminderDispatchingRef.current || isTalking || isThinking || isDataRestoreBlocked()) return;

          reminderDispatchingRef.current = true;
          try {
              const now = Date.now();
              const relatives = await getRelativeReminders();

              // Generate and deliver only after a transactional claim. Old prewarm
              // entries are deliberately discarded: their cache key lacks a version.
              const relativeReminder = relatives
                  .filter(r => !r.paused && r.dueAt <= now && (!r.retryAt || r.retryAt <= now))
                  .sort((a, b) => a.dueAt - b.dueAt)[0];
              const dailyCandidates = (await getDailyReminders()).filter(r => !r.paused && (!r.retryAt || r.retryAt <= now))
                  .map(r => {
                      const range = getDueDailyReminderRange(r, now);
                      return { reminder: r, dueAt: range?.last ?? null, range };
                  })
                  .filter((x): x is { reminder: DailyReminder; dueAt: number; range: NonNullable<typeof x.range> } => x.dueAt !== null && x.dueAt <= now && !!x.range)
                  .sort((a, b) => a.dueAt - b.dueAt);
              const selected = relativeReminder
                  ? { reminder: relativeReminder as RelativeReminder | DailyReminder, dueAt: relativeReminder.originalDueAt ?? relativeReminder.dueAt }
                  : dailyCandidates[0];
              if (!selected) return;
              const { reminder, dueAt } = selected;
              if ('range' in selected && selected.range.priorCount) {
                  const recorded = await recordPriorDailyMisses(selected.reminder as DailyReminder, selected.range, language);
                  if (!recorded) return;
                  const state = useAppStore.getState();
                  state.setMissedReminders(await db.getVal(KUMIKO_MISSED_REMINDERS_STORAGE_KEY, []));
                  state.setMessageAlerts(await db.getVal('kumiko_message_alerts', []));
              }
              const dateKey = 'hour' in reminder ? getTimePartsInTimezone(new Date(dueAt), reminder.timeZone || 'Asia/Tokyo').dateKey : undefined;
              const token = await claimReminderOccurrence(reminder, dueAt, now);
              if (!token) return;
              cancelReminderPrewarm(reminder.id, 'versioned dispatch');
              let delivered = false;
              let recordedMissed = false;
              try {
                  if (now - dueAt > reminderGraceMs(reminder)) {
                      recordedMissed = await finishReminderOccurrence(reminder, dueAt, token, 'missed', dateKey, language);
                  } else {
                      const guard = {
                          begin: async () => !isDataRestoreBlocked() && await markReminderSending(reminder, dueAt, token),
                          current: async () => !isDataRestoreBlocked() && await isReminderOccurrenceCurrent(reminder, dueAt, token),
                          commit: async (message: MessageEntity) => !isDataRestoreBlocked() && await commitReminderMessage(reminder, dueAt, token, message),
                          messageId: `reminder:${reminder.id}:${reminder.version ?? 0}:${dueAt}`,
                      };
                      delivered = await triggerTimedReminderMessage({ ...reminder, dueAt, originalDueAt: now > dueAt + 60_000 ? dueAt : undefined }, undefined, guard);
                      if (delivered) await finishReminderOccurrence(reminder, dueAt, token, 'delivered', dateKey);
                      else await abandonReminderOccurrence(reminder, dueAt, token);
                  }
              } catch (error) {
                  await abandonReminderOccurrence(reminder, dueAt, token);
                  throw error;
              } finally {
                  // Reflect the committed transaction without deleting a newer version.
                  const state = useAppStore.getState();
                  state.setRelativeReminders(await db.getVal(RELATIVE_REMINDER_STORAGE_KEY, []));
                  state.setDailyReminders(await db.getVal(DAILY_REMINDER_STORAGE_KEY, []));
                  if (recordedMissed) {
                      const missed = await db.getVal<any[]>(KUMIKO_MISSED_REMINDERS_STORAGE_KEY, []);
                      const alerts = await db.getVal<any[]>('kumiko_message_alerts', []);
                      state.setMissedReminders(prev => [...prev, ...missed.filter(x => !prev.some(y => y.id === x.id))]);
                      state.setMessageAlerts(prev => [...alerts.filter(x => !prev.some(y => y.id === x.id)), ...prev].slice(0, 50));
                  }
              }
          } finally {
              reminderDispatchingRef.current = false;
          }
      };

      // v2.14.27: keep the latest closure available to the
      // kumikoAlarmFired native bridge listener. The listener lives in a
      // separate useEffect with stable deps (so it doesn't re-subscribe
      // on every render); calling through this ref gives it the same
      // dispatch path the polling interval uses.
      checkScheduledRemindersRef.current = checkScheduledReminders;

      // v2.14.1 H.4: previously the JS poller fired every 1s
      // unconditionally — fine when the tab is active, wasteful when
      // the user has switched apps because the native AlarmManager
      // path (B.2 above) already guarantees minute-accurate wake-ups
      // even from Doze. When document.visibilityState === 'hidden'
      // (Capacitor: app backgrounded; Electron: window minimized;
      // Web: tab in background), drop to a 60s heartbeat. The visibility
      // listener resets the interval so foreground responsiveness is
      // unchanged.
      let intervalId: ReturnType<typeof setInterval>;
      const installInterval = () => {
          if (intervalId) clearInterval(intervalId);
          const period = (typeof document !== 'undefined' && document.visibilityState === 'hidden') ? 60_000 : 1000;
          intervalId = setInterval(() => {
              void checkScheduledReminders();
          }, period);
      };
      installInterval();
      const onVisibilityChange = () => {
          installInterval();
          // On foreground transition, fast-path one immediate check so
          // a reminder that fell due while we were sleeping fires within
          // the first frame instead of after the next 1s tick.
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
              void checkScheduledReminders();
          }
      };
      if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', onVisibilityChange);
      }

      const timeoutId = setTimeout(() => {
          void checkScheduledReminders();
      }, 1500);

      return () => {
          if (intervalId) clearInterval(intervalId);
          clearTimeout(timeoutId);
          if (typeof document !== 'undefined') {
              document.removeEventListener('visibilitychange', onVisibilityChange);
          }
      };
  }, [flowState, isTalking, isThinking, getRelativeReminders, getDailyReminders, triggerTimedReminderMessage, removeRelativeReminder, markRelativeReminderRetry, markDailyReminderTriggered, markDailyReminderRetry]);

  // v2.14.17: one-shot toast when AlarmManager downgrades to inexact.
  // Triggered when scheduleAndroidAlarm returns scheduled=true but exact=false
  // (Android 13+ without SCHEDULE_EXACT_ALARM permission). Uses a localStorage
  // flag so we toast at most once per install — re-toasting on every reconcile
  // pass would be obnoxious. The TaskPanel banner from v2.14.13 is intentionally
  // omitted (single-user app — toast + first-launch system prompt is enough).
  const notifyExactAlarmFallbackOnce = useCallback((result: ScheduleAlarmResult): void => {
    if (typeof window === 'undefined') return;
    if (!result.scheduled || result.exact !== false) return;
    try {
      if (window.localStorage.getItem(EXACT_ALARM_FALLBACK_NOTICE_STORAGE_KEY)) return;
      window.localStorage.setItem(EXACT_ALARM_FALLBACK_NOTICE_STORAGE_KEY, '1');
    } catch {
      return;
    }
    const message = language === 'en'
      ? 'Reminders may fire ±15 min late — open Settings → Apps → Kumiko → Alarms & reminders to grant exact alarms.'
      : '提醒可能会延迟±15分钟触发 — 请到 系统设置 → 应用 → Kumiko → 闹钟与提醒 中授予精准闹钟权限。';
    try {
      useAppStore.getState().setSystemNotice(message);
    } catch (e) {
      console.warn('[useScheduledReminders] setSystemNotice failed:', e);
    }
    try {
      showBackgroundMessageNotification(message, 'reminder');
    } catch (e) {
      console.warn('[useScheduledReminders] showBackgroundMessageNotification failed:', e);
    }
  }, [language, showBackgroundMessageNotification]);

  // B.2 (A6.4): Capacitor-only — additionally sync each pending reminder
  // to the native OS AlarmManager so it fires even after Doze kills the
  // WebView. Reconciliation runs every 30s + on flowState mount; safe
  // because scheduleExact with the same reminderId is idempotent
  // (replaces the existing PendingIntent). Previously synced alarms are
  // explicitly cancelled when their reminder is removed or becomes inactive.
  //
  // Routing:
  //   wantsCall = (ttsConfig.voiceMode !== 'text') AND has any TTS key
  //   so the native receiver knows whether to launch full-screen call
  //   (IncomingCallActivity) or post a text MessagingStyle notification.
  useEffect(() => {
      if (!isCapacitorNative()) return;
      // v2.14.17: belt-and-suspenders platform check (KumikoAlarmsPlugin is
      // Android-only; iOS Capacitor would silently no-op via getPlugin's
      // own guard but skipping the whole reconcile loop is cleaner).
      if (getCapacitorPlatform() !== 'android') return;
      if (flowState !== 'APP') return;

      const lastSyncedIdsRef = new Set<string>();
      const prewarmScheduledAt = new Map<string, number>();
      let reconciling = false;

      const reconcile = async () => {
          if (reconciling || isDataRestoreBlocked()) return;
          reconciling = true;
          const restoreVersion = getDataRestoreVersion();
          const canContinue = () => !isDataRestoreBlocked() && getDataRestoreVersion() === restoreVersion;
          try {
              await withReminderNativeAlarmLock(async () => {
              if (!canContinue()) return;
              await drainReminderNativeCancellationsLocked();
              if (!canContinue()) return;
              const pendingCancellations = await db.getVal<Array<{ id: string }>>(REMINDER_NATIVE_CANCEL_KEY, []);
              if (!canContinue()) return;
              if (pendingCancellations.length) {
                  useAppStore.getState().setSystemNotice(language === 'en'
                      ? 'A reminder was changed in the app, but system cancellation is awaiting confirmation.'
                      : '提醒已在应用内更改，但系统撤销仍待确认。');
              }
              const blockedIds = new Set(pendingCancellations.map(job => job.id));
              const ttsConfig = ttsConfigRef.current;
              const wantsCall = ttsConfig.voiceMode !== 'text' && (
                  !!ttsConfig.fishAudioApiKey
                  || !!ttsConfig.vocuApiKey
                  || ttsConfig.ttsBackend === 'sovits'
              );
              const ringtoneFileId = ttsConfig.ringtoneFileId || '';
              if (wantsCall) {
                  await ensureNativeRingtoneForAlarm(ringtoneFileId, restoreVersion);
              }

              const relatives = await getRelativeReminders();
              const dailies = await getDailyReminders();
              if (!canContinue()) return;

              const seenIds = new Set<string>();

              for (const r of relatives) {
                  if (!canContinue()) return;
                  if (!r || !r.id || r.paused || blockedIds.has(r.id) || !Number.isFinite(r.dueAt) || r.dueAt <= Date.now()) continue;
                  seenIds.add(r.id);
                  const result = await scheduleAndroidAlarm({
                      reminderId: r.id,
                      version: String(r.version ?? 0),
                      at: r.dueAt,
                      event: r.event,
                      text: r.event,
                      wantsCall,
                      ringtoneFileId,
                  });
                  notifyExactAlarmFallbackOnce(result);

                  // Versionless prewarm caches cannot safely survive a modification.
                  // Existing sibling alarms are cancelled by reconciliation.
              }
              for (const d of dailies) {
                  if (!canContinue()) return;
                  if (!d || !d.id || d.paused || blockedIds.has(d.id)) continue;
                  const atMs = getNextDailyReminderAt(d, Date.now());
                  if (atMs === null) continue;
                  // Daily alarms get a stable id to avoid orphaning across days.
                  const alarmId = `daily-${d.id}`;
                  seenIds.add(alarmId);
                  const result = await scheduleAndroidAlarm({
                      reminderId: alarmId,
                      version: String(d.version ?? 0),
                      at: atMs,
                      event: d.event,
                      text: d.event,
                      wantsCall,
                      ringtoneFileId,
                  });
                  notifyExactAlarmFallbackOnce(result);
              }

              // Cancel alarms that were synced previously but are no longer
              // in the store (deleted by user or already fired).
              const persistedIds = await listScheduledAndroidAlarms();
              if (!canContinue()) return;
              for (const stale of new Set([...lastSyncedIdsRef, ...(persistedIds ?? [])])) {
                  if (!canContinue()) return;
                  if (stale === 'kumiko_block_expiry') continue;
                  if (!seenIds.has(stale)) {
                      await cancelAndroidAlarm(stale);
                      prewarmScheduledAt.delete(stale);
                  }
              }
              lastSyncedIdsRef.clear();
              for (const id of seenIds) lastSyncedIdsRef.add(id);
              });
          } catch (e) {
              console.warn('[useScheduledReminders] native alarm sync failed:', e);
          } finally {
              reconciling = false;
          }
      };

      void reconcile();
      const syncInterval = setInterval(() => { void reconcile(); }, 30_000);
      return () => clearInterval(syncInterval);
  }, [flowState, getRelativeReminders, getDailyReminders, ttsConfigRef, notifyExactAlarmFallbackOnce]);

  // v2.14.27: subscribe to the native `kumikoAlarmFired` event. When the
  // KumikoAlarmReceiver fires it silently launches MainActivity with
  // EXTRA_REMINDER_FIRED; MainActivity bridges the payload into this JS
  // event via KumikoAlarmsPlugin.notifyAlarmFired. The 30 s
  // KumikoAlarmGuardianService FGS upgrade keeps the process alive long
  // enough for the LLM round-trip + LocalNotifications post that
  // checkScheduledReminders → triggerTimedReminderMessage performs. This
  // is the "background generation" path the user explicitly asked for in
  // the v2.14.27 hand-off ("我希望后台能生成，不然定时任务相当于没用").
  //
  // Force-tick semantics:
  //   - The dispatcher is the same one the 1s/60s poller uses; running
  //     it here is cheap (idempotent under reminderDispatchingRef).
  //   - We deliberately don't filter by reminderId — the dispatcher reads
  //     `now` and walks the store-sorted reminder list, so a wakeup for
  //     a slightly off-by-one reminder still surfaces the correct one.
  useEffect(() => {
      if (!isCapacitorNative()) return;
      if (getCapacitorPlatform() !== 'android') return;
      if (flowState !== 'APP') return;
      let dispose: (() => void) | undefined;
      let cancelled = false;
      // v2.14.28 H17.A Android: payload-aware listener. Sibling `__prewarm`
      // alarms scheduled in the reconcile loop above route here too — when
      // the suffix is present we run prewarmTimedReminderMessage instead of
      // force-ticking the dispatcher. The original alarm at dueAt will fire
      // 60 s later and consume the prewarm cache via triggerTimedReminderMessage.
      void addAlarmFiredListener(async (payload) => {
          const fired = payload?.reminderId || '';
          if (fired.endsWith('__prewarm')) {
              // Old caches have no occurrence identity; do not generate from them.
              return;
          }
          // Default path (main alarm): fire the dispatcher on the next
          // microtask so the listener callback returns quickly. The
          // dispatcher itself is async and self-guarded against re-entry.
          void Promise.resolve().then(() => checkScheduledRemindersRef.current());
      })
        .then((dispatch) => {
            if (cancelled) {
                try { dispatch(); } catch { /* noop */ }
                return;
            }
            dispose = dispatch;
        })
        .catch((e) => {
            console.warn('[useScheduledReminders] addAlarmFiredListener failed:', e);
        });
      return () => {
          cancelled = true;
          try { dispose?.(); } catch { /* noop */ }
      };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- triggerPrewarm/getRelativeReminders intentionally omitted from deps so the listener registers once per APP mount; both are read live via closure
  }, [flowState]);
};
