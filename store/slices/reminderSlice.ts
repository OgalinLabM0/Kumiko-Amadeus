import type { StateCreator } from 'zustand';
import { db } from '../../services/db';
import { resolveReminderTimeZone, validReminderTimeZone } from '../../services/reminderTime';

export const RELATIVE_REMINDER_STORAGE_KEY = 'kumiko_relative_reminders';
export const DAILY_REMINDER_STORAGE_KEY = 'kumiko_daily_reminders';
// v2.14.29 H10 rework: separate keyval for "things she promised to
// remind me of but missed by > 3 days". Decoupled from `kumiko_anchors`
// because the two are different mechanisms: anchors are 15%-probability
// random flashbacks for ambient continuity, while these records are a
// deterministic "still on her mind, surface naturally when relevant"
// list. See plan h10_missed_reminder_rework for the design.
export const KUMIKO_MISSED_REMINDERS_STORAGE_KEY = 'kumiko_missed_reminders';
const REMINDER_RETRY_DELAY_MS = 30000;

export type RelativeReminder = {
  id: string;
  event: string;
  dueAt: number;
  createdAt: number;
  sourceText?: string;
  /** Creation-time clock basis; private scheduling metadata, not character knowledge. */
  timeZone?: string;
  retryAt?: number;
  // v2.14.29 H10 rework: only set when boot rescue re-armed `dueAt`
  // for a reminder that was missed while the app was closed but is
  // still within the 3-day late-chat grace window. The trigger path
  // reads this to pick the "late acknowledgement" prompt template
  // (chatActions.buildTimedReminderSystemPrompt) instead of the
  // on-time "[現在已经到点了]" template, so Kumiko admits she was
  // late instead of pretending the original time just arrived.
  originalDueAt?: number;
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

// v2.14.29 H10 rework: one-shot reminders missed by > 3 days don't
// fire a delayed chat (that would feel weird — Kumiko nagging you to
// take 8am pills at 14:00). Instead they land here and get folded into
// her system prompt every turn so she can naturally bring them up when
// (a) the user mentions a related topic, or (b) she's initiating a
// proactive chat after gapHours >= 3. TTL is 7 days from recordedAt
// (matches the user's "after a week she stops actively bringing it up"
// instinct); after that, boot-time cleanup drops them. Inbox alerts
// stay on their own 50-cap clock.
export type MissedReminderRecord = {
  id: string;
  event: string;
  sourceText?: string;
  originalDueAt: number;
  recordedAt: number;
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
  // v2.14.29 H10: things she promised to remind the user about but
  // missed by > 3 days. Read by services/geminiService when building
  // the system prompt (missedReminderRecallBlock); written by
  // useInitialLoadBootstrap on boot scan and by MessageCenterPanel
  // when the user dismisses the matching inbox alert.
  missedReminders: MissedReminderRecord[];

  setRelativeReminders: (v: RelativeReminder[]) => void;
  setDailyReminders: (v: DailyReminder[]) => void;
  setMissedReminders: (v: MissedReminderRecord[] | ((prev: MissedReminderRecord[]) => MissedReminderRecord[])) => void;
  getRelativeReminders: () => RelativeReminder[];
  getDailyReminders: () => DailyReminder[];
  getMissedReminders: () => MissedReminderRecord[];
  persistRelativeReminders: (reminders: RelativeReminder[]) => Promise<void>;
  persistDailyReminders: (reminders: DailyReminder[]) => Promise<void>;
  persistMissedReminders: (records: MissedReminderRecord[]) => Promise<void>;
  saveRelativeReminder: (event: string, delaySeconds: number, sourceText?: string, timing?: { timeZone?: string; referenceAt?: number; dueAt?: number }) => Promise<void>;
  markRelativeReminderRetry: (reminderId: string) => Promise<void>;
  removeRelativeReminder: (reminderId: string) => Promise<void>;
  saveDailyReminder: (event: string, hour: number, minute: number, sourceText?: string, timeZone?: string) => Promise<void>;
  removeDailyReminder: (reminderId: string) => Promise<void>;
  toggleDailyReminderPaused: (reminderId: string) => Promise<void>;
  markDailyReminderTriggered: (reminderId: string, dateKey: string) => Promise<void>;
  markDailyReminderRetry: (reminderId: string) => Promise<void>;
  removeMissedReminder: (recordId: string) => Promise<void>;
}

type ReminderSliceDeps = {
  locationConfig: { modelTimezone: string; userTimezone: string };
};

export const createReminderSlice: StateCreator<
  ReminderSlice & ReminderSliceDeps,
  [],
  [],
  ReminderSlice
> = (set, get) => ({
  relativeReminders: [],
  dailyReminders: [],
  missedReminders: [],

  setRelativeReminders: (v) => set({ relativeReminders: v }),
  setDailyReminders: (v) => set({ dailyReminders: v }),
  setMissedReminders: (v) => set((s) => ({
    missedReminders: typeof v === 'function' ? v(s.missedReminders) : v,
  })),

  getRelativeReminders: () => get().relativeReminders,
  getDailyReminders: () => get().dailyReminders,
  getMissedReminders: () => get().missedReminders,

  persistRelativeReminders: async (reminders) => {
    set({ relativeReminders: reminders });
    await db.setVal(RELATIVE_REMINDER_STORAGE_KEY, reminders);
  },

  persistDailyReminders: async (reminders) => {
    set({ dailyReminders: reminders });
    await db.setVal(DAILY_REMINDER_STORAGE_KEY, reminders);
  },

  persistMissedReminders: async (records) => {
    set({ missedReminders: records });
    await db.setVal(KUMIKO_MISSED_REMINDERS_STORAGE_KEY, records);
  },

  removeMissedReminder: async (recordId) => {
    const next = get().missedReminders.filter(r => r.id !== recordId);
    await get().persistMissedReminders(next);
  },

  saveRelativeReminder: async (event, delaySeconds, sourceText, timing) => {
    try {
      // v2.14.23: tolerate an empty / pure-punctuation `event`. Prior
      // behaviour silently `return`-ed, which is one of the root causes of
      // the "model agreed to remind me but nothing fired" complaint:
      // sometimes the LLM emits `{ event: "", delay_seconds: 600 }` and
      // we'd drop the whole reminder. We now fall back to a generic label
      // (CJK if the source text contains any Han chars, otherwise English)
      // and log so the issue is still visible to devs.
      const rawSafe = normalizeReminderEvent(event || '');
      const sourceHasCjk = /[\u4e00-\u9fff]/u.test(sourceText || '');
      const safeEvent = rawSafe || (sourceHasCjk ? '提醒你' : 'remind you');
      const safeDelaySeconds = Math.max(1, Math.round(delaySeconds));
      if (!Number.isFinite(safeDelaySeconds) || safeDelaySeconds <= 0) {
        console.warn('[RELATIVE REMINDER] Refusing to save: invalid delay', { delaySeconds });
        return;
      }
      if (!rawSafe) {
        console.warn('[RELATIVE REMINDER] event was empty after normalisation; using generic label', { eventRaw: event, fallback: safeEvent });
      }

      const existing = get().relativeReminders;
      const now = Date.now();
      const referenceAt = Number.isFinite(timing?.referenceAt) ? timing!.referenceAt! : now;
      const dueAt = timing?.dueAt ?? (referenceAt + safeDelaySeconds * 1000);
      if (!Number.isFinite(dueAt) || dueAt <= 0) return;
      const reminder: RelativeReminder = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        event: safeEvent,
        dueAt,
        createdAt: now,
        sourceText: sourceText?.trim() || undefined,
        timeZone: validReminderTimeZone(timing?.timeZone) || resolveReminderTimeZone(sourceText || '', get().locationConfig.userTimezone),
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

  saveDailyReminder: async (event, hour, minute, sourceText, timeZone) => {
    try {
      // v2.14.23: same empty-event fallback as the relative path. Daily
      // reminders are rarer but the LLM sometimes returns
      // `{ event: "", hour: 22, minute: 30 }` and we used to drop them.
      const rawSafe = normalizeReminderEvent(event || '');
      const sourceHasCjk = /[\u4e00-\u9fff]/u.test(sourceText || '');
      const safeEvent = rawSafe || (sourceHasCjk ? '提醒你' : 'remind you');
      if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
        console.warn('[DAILY REMINDER] Refusing to save: invalid hour/minute', { hour, minute });
        return;
      }
      if (!rawSafe) {
        console.warn('[DAILY REMINDER] event was empty after normalisation; using generic label', { eventRaw: event, fallback: safeEvent });
      }

      const existing = get().dailyReminders;
      const reminder: DailyReminder = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        event: safeEvent,
        hour,
        minute,
        timeZone: validReminderTimeZone(timeZone) || resolveReminderTimeZone(sourceText || '', get().locationConfig.userTimezone),
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
