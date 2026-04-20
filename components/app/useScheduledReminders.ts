import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { Message, Language, LocationConfig, WorldBookEntry, AnchorEntry, TtsConfig, MessageAlertKind } from '../../types';
import type { RelativeReminder, DailyReminder } from '../../store/slices/reminderSlice';
import {
  triggerTimedReminderMessage as triggerTimedReminderMessageAction,
  type ChatActionRefs,
  type ExecuteSendHelpers,
} from './chatActions';
import { getTimePartsInTimezone } from './backupHelpers';

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

      const intervalId = setInterval(() => {
          void checkScheduledReminders();
      }, 1000);
      const timeoutId = setTimeout(() => {
          void checkScheduledReminders();
      }, 1500);

      return () => {
          clearInterval(intervalId);
          clearTimeout(timeoutId);
      };
  }, [flowState, isTalking, isThinking, getRelativeReminders, getDailyReminders, triggerTimedReminderMessage, removeRelativeReminder, markRelativeReminderRetry, markDailyReminderTriggered, markDailyReminderRetry]);
};
