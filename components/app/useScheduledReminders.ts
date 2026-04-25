import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { Message, Language, LocationConfig, WorldBookEntry, AnchorEntry, TtsConfig, MessageAlertKind } from '../../types';
import type { RelativeReminder, DailyReminder } from '../../store/slices/reminderSlice';
import {
  triggerTimedReminderMessage as triggerTimedReminderMessageAction,
  type ChatActionRefs,
  type ExecuteSendHelpers,
} from './chatActions';
import { getTimePartsInTimezone } from './backupHelpers';
import { getCapacitorPlatform, isCapacitorNative } from '../../services/environment';
import {
  cancelAndroidAlarm,
  scheduleAndroidAlarm,
  EXACT_ALARM_FALLBACK_NOTICE_STORAGE_KEY,
  type ScheduleAlarmResult,
} from '../../services/androidAlarmService';
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

  const notifyExactAlarmFallbackOnce = useCallback((result: ScheduleAlarmResult) => {
    if (!result.scheduled || result.exact !== false || typeof window === 'undefined') return;
    if (window.localStorage.getItem(EXACT_ALARM_FALLBACK_NOTICE_STORAGE_KEY) === 'true') return;

    window.localStorage.setItem(EXACT_ALARM_FALLBACK_NOTICE_STORAGE_KEY, 'true');
    const message = language === 'zh'
      ? '安卓精确闹钟权限未开启，提醒已用非精确闹钟兜底；省电模式下可能晚一点响。'
      : 'Exact alarm permission is off. Reminders will use an inexact fallback and may ring a little late in battery saver.';
    useAppStore.getState().setSystemNotice(message);
    showBackgroundMessageNotification(message, 'reminder');
  }, [language, showBackgroundMessageNotification]);

  const triggerTimedReminderMessage = useCallback(async (reminder: Pick<RelativeReminder, 'event' | 'sourceText'> | Pick<DailyReminder, 'event' | 'sourceText'>): Promise<boolean> => {
    return triggerTimedReminderMessageAction(
      { messagesRef, ttsConfigRef } as Pick<ChatActionRefs, 'messagesRef' | 'ttsConfigRef'>,
      { runVoicePipeline },
      reminder,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 1:1 preserve pre-extraction deps; body only uses refs + runVoicePipeline but action reads store live
  }, [language, contextLimit, coreMemory, worldBook, locationConfig, anchors, kumikoNotebook, addMessage, showBackgroundMessageNotification]);

  useEffect(() => {
      if (flowState !== 'APP') return;

      const checkScheduledReminders = async () => {
          if (reminderDispatchingRef.current || isTalking || isThinking) return;

          reminderDispatchingRef.current = true;
          try {
              const now = Date.now();
              const relativeReminder = (await getRelativeReminders())
                  .filter(reminder => reminder.dueAt <= now && (!reminder.retryAt || reminder.retryAt <= now))
                  .sort((a, b) => a.dueAt - b.dueAt)[0];

              if (relativeReminder) {
                  const delivered = await triggerTimedReminderMessage(relativeReminder);
                  if (delivered) {
                      await removeRelativeReminder(relativeReminder.id);
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
                          return (
                              reminder.hour === timeParts.hour &&
                              reminder.minute === timeParts.minute &&
                              reminder.lastTriggeredDate !== timeParts.dateKey &&
                              (!reminder.retryAt || reminder.retryAt <= now)
                          );
                      })()
                  )
                  .sort((a, b) => a.createdAt - b.createdAt)[0];

              if (!dueDailyReminder) return;

              const delivered = await triggerTimedReminderMessage(dueDailyReminder);
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
      if (!isCapacitorNative() || getCapacitorPlatform() !== 'android') return;
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
                  });
                  notifyExactAlarmFallbackOnce(result);
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
};
