import type { StateCreator } from 'zustand';
import { db } from '../../services/db';

export const RELATIVE_REMINDER_STORAGE_KEY = 'kumiko_relative_reminders';
export const DAILY_REMINDER_STORAGE_KEY = 'kumiko_daily_reminders';
const REMINDER_RETRY_DELAY_MS = 30000;

export type RelativeReminder = {
  id: string;
  event: string;
  dueAt: number;
  createdAt: number;
  sourceText?: string;
  retryAt?: number;
};

export type DailyReminder = {
  id: string;
  event: string;
  hour: number;
  minute: number;
  timeZone: string;
  createdAt: number;
  paused?: boolean;
  lastTriggeredDate?: string;
  sourceText?: string;
  retryAt?: number;
};

export const normalizeReminderEvent = (rawEvent: string): string => {
  return rawEvent
    .replace(/(?:我怕忘(?:了)?|怕忘(?:了)?|怕我忘(?:了)?|免得忘(?:了)?|别忘(?:了)?|我怕自己忘(?:了)?).*$/u, '')
    .replace(/[~～]+/g, ' ')
    .replace(/^[\s,，。.!！？:：;；]+|[\s,，。.!！？:：;；]+$/gu, '')
    .replace(/(?:呗|吧|呀|啊|哦|噢|喔|啦|嘛|呢|哈)+$/u, '')
    .trim();
};

export interface ReminderSlice {
  relativeReminders: RelativeReminder[];
  dailyReminders: DailyReminder[];

  setRelativeReminders: (v: RelativeReminder[]) => void;
  setDailyReminders: (v: DailyReminder[]) => void;
  getRelativeReminders: () => RelativeReminder[];
  getDailyReminders: () => DailyReminder[];
  persistRelativeReminders: (reminders: RelativeReminder[]) => Promise<void>;
  persistDailyReminders: (reminders: DailyReminder[]) => Promise<void>;
  saveRelativeReminder: (event: string, delaySeconds: number, sourceText?: string) => Promise<void>;
  markRelativeReminderRetry: (reminderId: string) => Promise<void>;
  removeRelativeReminder: (reminderId: string) => Promise<void>;
  saveDailyReminder: (event: string, hour: number, minute: number, sourceText?: string) => Promise<void>;
  removeDailyReminder: (reminderId: string) => Promise<void>;
  toggleDailyReminderPaused: (reminderId: string) => Promise<void>;
  markDailyReminderTriggered: (reminderId: string, dateKey: string) => Promise<void>;
  markDailyReminderRetry: (reminderId: string) => Promise<void>;
}

type ReminderSliceDeps = {
  locationConfig: { modelTimezone: string };
};

export const createReminderSlice: StateCreator<
  ReminderSlice & ReminderSliceDeps,
  [],
  [],
  ReminderSlice
> = (set, get) => ({
  relativeReminders: [],
  dailyReminders: [],

  setRelativeReminders: (v) => set({ relativeReminders: v }),
  setDailyReminders: (v) => set({ dailyReminders: v }),

  getRelativeReminders: () => get().relativeReminders,
  getDailyReminders: () => get().dailyReminders,

  persistRelativeReminders: async (reminders) => {
    set({ relativeReminders: reminders });
    await db.setVal(RELATIVE_REMINDER_STORAGE_KEY, reminders);
  },

  persistDailyReminders: async (reminders) => {
    set({ dailyReminders: reminders });
    await db.setVal(DAILY_REMINDER_STORAGE_KEY, reminders);
  },

  saveRelativeReminder: async (event, delaySeconds, sourceText) => {
    try {
      const safeEvent = normalizeReminderEvent(event);
      const safeDelaySeconds = Math.max(1, Math.round(delaySeconds));
      if (!safeEvent) return;

      const existing = get().relativeReminders;
      const reminder: RelativeReminder = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        event: safeEvent,
        dueAt: Date.now() + (safeDelaySeconds * 1000),
        createdAt: Date.now(),
        sourceText: sourceText?.trim() || undefined,
      };
      await get().persistRelativeReminders([...existing, reminder]);
      console.log(`[RELATIVE REMINDER] Saved: ${safeEvent} in ${safeDelaySeconds}s`);
    } catch (e) {
      console.error("[RELATIVE REMINDER] Failed to save reminder", e);
    }
  },

  markRelativeReminderRetry: async (reminderId) => {
    const updated = get().relativeReminders.map(r =>
      r.id === reminderId ? { ...r, retryAt: Date.now() + REMINDER_RETRY_DELAY_MS } : r
    );
    await get().persistRelativeReminders(updated);
  },

  removeRelativeReminder: async (reminderId) => {
    const next = get().relativeReminders.filter(r => r.id !== reminderId);
    await get().persistRelativeReminders(next);
  },

  saveDailyReminder: async (event, hour, minute, sourceText) => {
    try {
      const safeEvent = normalizeReminderEvent(event);
      if (!safeEvent) return;

      const existing = get().dailyReminders;
      const modelTimezone = get().locationConfig.modelTimezone;
      const reminder: DailyReminder = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        event: safeEvent,
        hour,
        minute,
        timeZone: modelTimezone || 'Asia/Tokyo',
        createdAt: Date.now(),
        sourceText: sourceText?.trim() || undefined,
      };
      await get().persistDailyReminders([...existing, reminder]);
      console.log(`[DAILY REMINDER] Saved: ${safeEvent} at ${hour}:${minute.toString().padStart(2, '0')} (${reminder.timeZone})`);
    } catch (e) {
      console.error("[DAILY REMINDER] Failed to save reminder", e);
    }
  },

  removeDailyReminder: async (reminderId) => {
    const next = get().dailyReminders.filter(r => r.id !== reminderId);
    await get().persistDailyReminders(next);
  },

  toggleDailyReminderPaused: async (reminderId) => {
    const next = get().dailyReminders.map(r =>
      r.id === reminderId ? { ...r, paused: !r.paused, retryAt: undefined } : r
    );
    await get().persistDailyReminders(next);
  },

  markDailyReminderTriggered: async (reminderId, dateKey) => {
    const next = get().dailyReminders.map(r =>
      r.id === reminderId ? { ...r, lastTriggeredDate: dateKey, retryAt: undefined } : r
    );
    await get().persistDailyReminders(next);
  },

  markDailyReminderRetry: async (reminderId) => {
    const next = get().dailyReminders.map(r =>
      r.id === reminderId ? { ...r, retryAt: Date.now() + REMINDER_RETRY_DELAY_MS } : r
    );
    await get().persistDailyReminders(next);
  },
});
