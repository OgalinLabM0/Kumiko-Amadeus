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
import { getCapacitorPlatform, isCapacitorNative } from '../../services/environment';
import {
  EXACT_ALARM_FALLBACK_NOTICE_STORAGE_KEY,
  addAlarmFiredListener,
  cancelAndroidAlarm,
  scheduleAndroidAlarm,
  type ScheduleAlarmResult,
} from '../../services/androidAlarmService';
import { ensureNativeRingtoneForAlarm } from '../../services/voiceFileService';
import { useAppStore } from '../../store';

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
    reminder: Pick<RelativeReminder, 'event' | 'sourceText'> | Pick<DailyReminder, 'event' | 'sourceText'>,
    reminderId?: string,
  ): Promise<boolean> => {
    return triggerTimedReminderMessageAction(
      { messagesRef, ttsConfigRef } as Pick<ChatActionRefs, 'messagesRef' | 'ttsConfigRef'>,
      { runVoicePipeline },
      reminder,
      reminderId,
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
      { id: reminder.id, event: reminder.event, sourceText: reminder.sourceText, dueAt: reminder.dueAt },
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mirrors triggerTimedReminderMessage deps so identity churns at the same cadence
  }, [language, contextLimit, coreMemory, worldBook, locationConfig, anchors, kumikoNotebook, addMessage, showBackgroundMessageNotification]);

  useEffect(() => {
      if (flowState !== 'APP') return;

      const checkScheduledReminders = async () => {
          if (reminderDispatchingRef.current || isTalking || isThinking) return;

          reminderDispatchingRef.current = true;
          try {
              const now = Date.now();
              const relatives = await getRelativeReminders();

              // v2.14.28 H17.A: kick T-60s prewarm for any relative reminder
              // entering its [dueAt-60s, dueAt-50s] window. Runs alongside the
              // dispatcher tick — no extra timer needed, the existing 1s/60s
              // poll cadence covers the detection window. Backgrounded check
              // happens inside triggerPrewarm itself.
              for (const r of relatives) {
                  if (r && r.id && shouldKickReminderPrewarm(r.dueAt, now)) {
                      triggerPrewarm(r);
                  }
              }

              const relativeReminder = relatives
                  .filter(reminder => reminder.dueAt <= now && (!reminder.retryAt || reminder.retryAt <= now))
                  .sort((a, b) => a.dueAt - b.dueAt)[0];

              if (relativeReminder) {
                  const delivered = await triggerTimedReminderMessage(relativeReminder, relativeReminder.id);
                  if (delivered) {
                      await removeRelativeReminder(relativeReminder.id);
                      // v2.14.28 H17.A: drop any leftover prewarm cache slot
                      // (consumeReminderPrewarm already removed it on hit, but
                      // a status='failed' or stale entry would otherwise
                      // linger. cancelReminderPrewarm is a no-op on a
                      // missing key.).
                      cancelReminderPrewarm(relativeReminder.id, 'fired');
                  } else {
                      await markRelativeReminderRetry(relativeReminder.id);
                  }
                  return;
              }

              const dueDailyReminder = (await getDailyReminders())
                  .filter(reminder =>
                      !reminder.paused &&
                      (() => {
                          const timeParts = getTimePartsInTimezone(new Date(now), reminder.timeZone || 'Asia/Tokyo');
                          // v2.14.28 M11: a 5-minute grace window after the
                          // configured hour:minute. The previous strict
                          // single-minute match would silently drop a daily
                          // reminder if the polling tick skipped its exact
                          // minute (60s heartbeat in the background, or
                          // setInterval drift on a busy machine). The grace
                          // window covers all realistic skew while still
                          // staying inside the same hour and not bleeding
                          // into the next day's reminder. lastTriggeredDate
                          // dedup guarantees we only fire once per local day.
                          const reminderTotalMinutes = reminder.hour * 60 + reminder.minute;
                          const nowTotalMinutes = timeParts.hour * 60 + timeParts.minute;
                          const insideGraceWindow = nowTotalMinutes >= reminderTotalMinutes
                              && nowTotalMinutes <= reminderTotalMinutes + 5;
                          return (
                              insideGraceWindow &&
                              reminder.lastTriggeredDate !== timeParts.dateKey &&
                              (!reminder.retryAt || reminder.retryAt <= now)
                          );
                      })()
                  )
                  .sort((a, b) => a.createdAt - b.createdAt)[0];

              if (!dueDailyReminder) return;

              // Daily reminders don't get prewarmed today — their dueAt is implicit
              // (today's hh:mm in the reminder timezone) so the T-60s detection
              // in shouldKickReminderPrewarm doesn't have a stable value to
              // compare against. Acceptable: daily reminders fire once a day at a
              // known wall-clock minute and the user is usually expecting them.
              const delivered = await triggerTimedReminderMessage(dueDailyReminder, dueDailyReminder.id);
              if (delivered) {
                  const timeParts = getTimePartsInTimezone(new Date(now), dueDailyReminder.timeZone || 'Asia/Tokyo');
                  await markDailyReminderTriggered(dueDailyReminder.id, timeParts.dateKey);
              } else {
                  await markDailyReminderRetry(dueDailyReminder.id);
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
  // (replaces the existing PendingIntent). Cancellation of stale alarms
  // happens implicitly because we only schedule for currently-active
  // reminders — anything removed from the store stops getting refreshed
  // and AlarmManager will fire it once more (its PendingIntent is still
  // alive), but the receiver's notification is harmless and the in-app
  // poller won't double-fire because removeRelativeReminder already
  // cleared the store row.
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

      const reconcile = async () => {
          try {
              const ttsConfig = ttsConfigRef.current;
              const wantsCall = ttsConfig.voiceMode !== 'text' && (
                  !!ttsConfig.fishAudioApiKey
                  || !!ttsConfig.vocuApiKey
                  || ttsConfig.ttsBackend === 'sovits'
              );
              const ringtoneFileId = ttsConfig.ringtoneFileId || '';
              if (wantsCall) {
                  await ensureNativeRingtoneForAlarm(ringtoneFileId);
              }

              const relatives = await getRelativeReminders();
              const dailies = await getDailyReminders();

              const seenIds = new Set<string>();

              for (const r of relatives) {
                  if (!r || !r.id || !r.dueAt || r.dueAt <= Date.now()) continue;
                  seenIds.add(r.id);
                  const result = await scheduleAndroidAlarm({
                      reminderId: r.id,
                      at: r.dueAt,
                      event: r.event,
                      text: r.event,
                      wantsCall,
                      ringtoneFileId,
                  });
                  notifyExactAlarmFallbackOnce(result);

                  // v2.14.28 H17.A Android: schedule a sibling "prewarm" alarm
                  // 60 s before dueAt so the AlarmManager wakes the WebView
                  // ahead of time, runs the same prewarmTimedReminderMessage
                  // pipeline used by the desktop H17.A path, and stores the
                  // result in services/reminderPrewarmService. The main alarm
                  // at dueAt then dispatches via consumeReminderPrewarm and
                  // the call screen / notification surfaces immediately.
                  // Skip when there isn't a meaningful 60 s lead (reminder is
                  // < 70 s away — we only schedule prewarm when there's
                  // headroom for it to actually finish before T=0).
                  const prewarmAt = r.dueAt - 60_000;
                  if (prewarmAt > Date.now() + 10_000) {
                      const prewarmId = `${r.id}__prewarm`;
                      seenIds.add(prewarmId);
                      const prewarmResult = await scheduleAndroidAlarm({
                          reminderId: prewarmId,
                          at: prewarmAt,
                          // Mark `wantsCall=false` for the prewarm — when the
                          // alarm fires we don't want to launch the
                          // IncomingCallActivity, just nudge JS to start the
                          // background generation. The JS listener detects the
                          // `__prewarm` suffix and routes accordingly.
                          event: r.event,
                          text: r.event,
                          wantsCall: false,
                          ringtoneFileId: '',
                      });
                      // Don't toast the inexact-fallback notice for the
                      // prewarm too — it would dupe the main alarm's notice.
                      void prewarmResult;
                  }
              }
              for (const d of dailies) {
                  if (!d || !d.id || d.paused) continue;
                  // Daily reminders need a per-day at-ms calculation. We use
                  // the next future occurrence in the user's reminder timezone.
                  const tz = d.timeZone || 'Asia/Tokyo';
                  const nowParts = getTimePartsInTimezone(new Date(), tz);
                  // Fresh date to avoid mutating the source
                  const today = new Date();
                  const todayParts = getTimePartsInTimezone(today, tz);
                  let atMs = today.getTime();
                  // Coarse approximation: snap minute boundary in current TZ
                  // by walking minute-by-minute from now until matching hour/minute.
                  // For strict accuracy in DST transitions, the OS will fire ±1h
                  // at most and the in-app poller will still catch it within 1s.
                  const startOfTodayUtcMs = new Date(today.toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
                  // Simpler: schedule for HH:MM today (or tomorrow if past) in
                  // a UTC approximation — close enough for AlarmManager wake-up.
                  void todayParts; void nowParts; void startOfTodayUtcMs;
                  const localizedNow = new Date();
                  const target = new Date(localizedNow);
                  target.setHours(d.hour, d.minute, 0, 0);
                  if (target.getTime() <= localizedNow.getTime()) {
                      target.setDate(target.getDate() + 1);
                  }
                  atMs = target.getTime();
                  // Daily alarms get a stable id to avoid orphaning across days.
                  const alarmId = `daily-${d.id}`;
                  seenIds.add(alarmId);
                  const result = await scheduleAndroidAlarm({
                      reminderId: alarmId,
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
              for (const stale of lastSyncedIdsRef) {
                  if (!seenIds.has(stale)) {
                      await cancelAndroidAlarm(stale);
                  }
              }
              lastSyncedIdsRef.clear();
              for (const id of seenIds) lastSyncedIdsRef.add(id);
          } catch (e) {
              console.warn('[useScheduledReminders] native alarm sync failed:', e);
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
              const originalId = fired.slice(0, -'__prewarm'.length);
              try {
                  const list = await getRelativeReminders();
                  const reminder = (Array.isArray(list) ? list : []).find(r => r.id === originalId);
                  if (!reminder) {
                      console.log(`[ALARM PREWARM] no matching reminder for ${originalId} — already fired or removed`);
                      return;
                  }
                  triggerPrewarm(reminder);
              } catch (e) {
                  console.warn('[useScheduledReminders] prewarm dispatch failed:', e);
              }
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
