import type { StateCreator } from 'zustand';
import { db } from '../../services/db';
import { resolveReminderTimeZone, validReminderTimeZone } from '../../services/reminderTime';
import { drainReminderNativeCancellations, queueReminderNativeCancellation } from '../../services/reminderNativeCancellation';

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
const REMINDER_ACTION_STORAGE_PREFIX = 'kumiko_reminder_action:';

export type ReminderSaveResult =
  | { status: 'saved' | 'existing'; reminderId: string }
  | { status: 'failed' | 'rejected'; reason: string };
export type ReminderLateGraceMinutes = 0 | 10 | 30 | 60;

export type RelativeReminder = {
  id: string;
  version?: number;
  paused?: boolean;
  lateGraceMinutes?: ReminderLateGraceMinutes;
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
  version?: number;
  event: string;
  hour: number;
  minute: number;
  timeZone: string;
  createdAt: number;
  /** Start of the current active period; paused dates are never replayed. */
  activeSince?: number;
  paused?: boolean;
  lateGraceMinutes?: ReminderLateGraceMinutes;
  lastTriggeredDate?: string;
  sourceText?: string;
  retryAt?: number;
};

export type ReminderMutationTarget = {
  id: string;
  kind: 'once' | 'daily';
  expected: RelativeReminder | DailyReminder;
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
  count?: number;
  firstDueAt?: number;
  lastDueAt?: number;
  timeZone?: string;
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
  saveRelativeReminder: (event: string, delaySeconds: number, sourceText?: string, timing?: { timeZone?: string; referenceAt?: number; dueAt?: number; actionId?: string; expectedEpoch?: string }) => Promise<ReminderSaveResult>;
  markRelativeReminderRetry: (reminderId: string) => Promise<void>;
  removeRelativeReminder: (reminderId: string) => Promise<void>;
  toggleRelativeReminderPaused: (reminderId: string) => Promise<void>;
  saveDailyReminder: (event: string, hour: number, minute: number, sourceText?: string, timeZone?: string, options?: { actionId?: string; expectedEpoch?: string }) => Promise<ReminderSaveResult>;
  applyReminderMutation: (actionId: string, target: ReminderMutationTarget, replacement?: RelativeReminder | DailyReminder, options?: { expectedEpoch?: string }) => Promise<ReminderSaveResult>;
  removeDailyReminder: (reminderId: string) => Promise<void>;
  toggleDailyReminderPaused: (reminderId: string) => Promise<void>;
  markDailyReminderTriggered: (reminderId: string, dateKey: string) => Promise<void>;
  markDailyReminderRetry: (reminderId: string) => Promise<void>;
  removeMissedReminder: (recordId: string) => Promise<void>;
  setReminderLateGrace: (kind: 'once' | 'daily', id: string, version: number, minutes: ReminderLateGraceMinutes | undefined) => Promise<ReminderSaveResult>;
}

type ReminderSliceDeps = {
  locationConfig: { modelTimezone: string; userTimezone: string };
};

async function readReminderRecords<T>(key: string): Promise<T[]> {
  const stored = await db.keyval.get(key);
  if (stored && !Array.isArray(stored.value)) throw new Error('Invalid stored reminder records');
  return stored?.value ?? [];
}

function noteCommittedReminderWrite(key: string, value: unknown): void {
  // Match db.setVal's optional window broadcast, only after COMMIT succeeds.
  void import('../../services/preferencesSync')
    .then(({ noteKeyvalPreferenceWrite }) => noteKeyvalPreferenceWrite(key, value))
    .catch(() => {});
}

async function updateReminderRecords<T>(key: string, update: (current: T[]) => T[]): Promise<T[]> {
  const records = await db.transaction('rw', db.keyval, async () => {
    const previous = await readReminderRecords<T>(key);
    const next = update(previous);
    if (key === RELATIVE_REMINDER_STORAGE_KEY || key === DAILY_REMINDER_STORAGE_KEY) {
      for (const old of previous as Array<T & { id: string; version?: number }>) {
        const current = (next as Array<T & { id: string; version?: number }>).find(x => x.id === old.id);
        if (!current || (current.version ?? 0) !== (old.version ?? 0)) await queueReminderNativeCancellation(old.id);
      }
    }
    await db.keyval.put({ key, value: next });
    return next;
  });
  noteCommittedReminderWrite(key, records);
  return records;
}

async function replaceReminderRecords<T>(key: string, records: T[]): Promise<void> {
  await db.transaction('rw', db.keyval, async () => {
    await db.keyval.put({ key, value: records });
  });
  noteCommittedReminderWrite(key, records);
}

async function cancelNativeReminderAlarms(id: string): Promise<void> {
  try {
    await drainReminderNativeCancellations();
  } catch (error) { console.warn('[REMINDER] native cancellation requires reconciliation', error); }
}

function sameReminderSchedule(existing: RelativeReminder | DailyReminder, reminder: RelativeReminder | DailyReminder): boolean {
  if (existing.event !== reminder.event || existing.timeZone !== reminder.timeZone) return false;
  if ('dueAt' in existing && 'dueAt' in reminder) return (existing.originalDueAt ?? existing.dueAt) === reminder.dueAt;
  return 'hour' in existing && 'hour' in reminder && existing.hour === reminder.hour && existing.minute === reminder.minute;
}

// The action receipt survives removal/delivery of a one-shot reminder. A retry
// must report the original commit rather than recreating a delivered task.
async function saveReminderRecord<T extends RelativeReminder | DailyReminder>(
  key: string, reminder: T, actionId: string | undefined, signature: string, expectedEpoch?: string,
): Promise<{ result: ReminderSaveResult; records?: T[] }> {
  const saved = await db.transaction<{ result: ReminderSaveResult; records?: T[] }>('rw', db.keyval, async () => {
    if (expectedEpoch !== undefined) {
      const epoch = (await db.keyval.get('kumiko_turn_epoch_v1'))?.value ?? 'initial';
      if (epoch !== expectedEpoch) return { result: { status: 'rejected', reason: 'stale_epoch' } };
    }
    const records = await readReminderRecords<T>(key);
    if (actionId) {
      const receipt = await db.keyval.get(REMINDER_ACTION_STORAGE_PREFIX + actionId);
      if (receipt) {
        return receipt.value?.signature === signature && receipt.value?.reminderId === reminder.id
          ? { result: { status: 'existing', reminderId: reminder.id }, records }
          : { result: { status: 'rejected', reason: 'action_id_conflict' } };
      }
      // Restored older backups may contain the reminder but no action receipt.
      // Check both kinds before claiming the ID; never overwrite another task.
      const otherKey = key === RELATIVE_REMINDER_STORAGE_KEY ? DAILY_REMINDER_STORAGE_KEY : RELATIVE_REMINDER_STORAGE_KEY;
      const otherRecords = await readReminderRecords<RelativeReminder | DailyReminder>(otherKey);
      const existing = records.find(row => row.id === reminder.id);
      if (otherRecords.some(row => row.id === reminder.id) || (existing && !sameReminderSchedule(existing, reminder))) {
        return { result: { status: 'rejected', reason: 'action_id_conflict' } };
      }
      await db.keyval.put({ key: REMINDER_ACTION_STORAGE_PREFIX + actionId, value: { signature, reminderId: reminder.id } });
      if (existing) return { result: { status: 'existing', reminderId: reminder.id }, records };
    }
    const next = [...records, reminder];
    await db.keyval.put({ key, value: next });
    return { result: { status: 'saved', reminderId: reminder.id }, records: next };
  });
  if (saved.result.status === 'saved') noteCommittedReminderWrite(key, saved.records);
  return saved;
}

function reminderBusinessSnapshot(reminder: RelativeReminder | DailyReminder) {
  const common = { id: reminder.id, version: reminder.version ?? 0, paused: reminder.paused ?? false, event: reminder.event, createdAt: reminder.createdAt,
    sourceText: reminder.sourceText, timeZone: reminder.timeZone, lateGraceMinutes: reminder.lateGraceMinutes };
  return 'hour' in reminder
    ? { ...common, kind: 'daily', hour: reminder.hour, minute: reminder.minute, paused: reminder.paused ?? false }
    : { ...common, kind: 'once', dueAt: reminder.dueAt, originalDueAt: reminder.originalDueAt };
}

function isValidMutationReminder(reminder: RelativeReminder | DailyReminder): boolean {
  if (!reminder || typeof reminder !== 'object' || typeof reminder.id !== 'string' || !reminder.id.trim()
    || typeof reminder.event !== 'string' || !reminder.event.trim()
    || !Number.isFinite(reminder.createdAt) || reminder.createdAt <= 0
    || (reminder.sourceText !== undefined && typeof reminder.sourceText !== 'string')
    || (reminder.lateGraceMinutes !== undefined && ![0, 10, 30, 60].includes(reminder.lateGraceMinutes))) return false;
  if ('hour' in reminder) {
    return !('dueAt' in reminder) && Number.isInteger(reminder.hour) && reminder.hour >= 0 && reminder.hour <= 23
      && Number.isInteger(reminder.minute) && reminder.minute >= 0 && reminder.minute <= 59
      && !!validReminderTimeZone(reminder.timeZone)
      && (reminder.paused === undefined || typeof reminder.paused === 'boolean');
  }
  return !('minute' in reminder) && Number.isFinite(reminder.dueAt) && reminder.dueAt > 0
    && Number.isFinite(new Date(reminder.dueAt).getTime())
    && (reminder.timeZone === undefined || !!validReminderTimeZone(reminder.timeZone))
    && (reminder.originalDueAt === undefined || (Number.isFinite(reminder.originalDueAt) && reminder.originalDueAt > 0));
}

type ReminderMutationCommit = {
  result: ReminderSaveResult;
  relativeReminders?: RelativeReminder[];
  dailyReminders?: DailyReminder[];
};

async function mutateReminderRecord(actionId: string, target: ReminderMutationTarget,
  replacement?: RelativeReminder | DailyReminder, expectedEpoch?: string): Promise<ReminderMutationCommit> {
  const signature = JSON.stringify({ operation: replacement ? 'replace' : 'cancel',
    target: reminderBusinessSnapshot(target.expected),
    replacement: replacement ? reminderBusinessSnapshot(replacement) : null });
  return db.transaction<ReminderMutationCommit>('rw', db.keyval, async () => {
    const epoch = (await db.keyval.get('kumiko_turn_epoch_v1'))?.value ?? 'initial';
    if (expectedEpoch !== undefined && epoch !== expectedEpoch) return { result: { status: 'rejected', reason: 'stale_epoch' } };
    const relativeReminders = await readReminderRecords<RelativeReminder>(RELATIVE_REMINDER_STORAGE_KEY);
    const dailyReminders = await readReminderRecords<DailyReminder>(DAILY_REMINDER_STORAGE_KEY);
    const receipt = await db.keyval.get(REMINDER_ACTION_STORAGE_PREFIX + actionId);
    if (receipt) {
      return receipt.value?.signature === signature && receipt.value?.reminderId === target.id
        ? { result: { status: 'existing', reminderId: target.id }, relativeReminders, dailyReminders }
        : { result: { status: 'rejected', reason: 'action_id_conflict' } };
    }
    const candidates = target.kind === 'once' ? relativeReminders : dailyReminders;
    const other = target.kind === 'once' ? dailyReminders : relativeReminders;
    const matches = candidates.filter(row => row.id === target.id);
    if (matches.length !== 1 || other.some(row => row.id === target.id)) {
      return { result: { status: 'rejected', reason: matches.length === 0 ? 'target_not_found' : 'target_conflict' } };
    }
    const current = matches[0];
    if (JSON.stringify(reminderBusinessSnapshot(current)) !== JSON.stringify(reminderBusinessSnapshot(target.expected))) {
      return { result: { status: 'rejected', reason: 'target_changed' } };
    }
    const nextRelative = relativeReminders.filter(row => row.id !== target.id);
    const nextDaily = dailyReminders.filter(row => row.id !== target.id);
    await queueReminderNativeCancellation(target.id);
    if (replacement) {
      if ('hour' in replacement) {
        nextDaily.push({ ...replacement, activeSince: Date.now(), version: (current.version ?? 0) + 1, retryAt: undefined,
          lastTriggeredDate: 'hour' in current ? current.lastTriggeredDate : undefined });
      } else {
        nextRelative.push({ ...replacement, version: (current.version ?? 0) + 1, retryAt: undefined });
      }
    }
    await db.keyval.put({ key: RELATIVE_REMINDER_STORAGE_KEY, value: nextRelative });
    await db.keyval.put({ key: DAILY_REMINDER_STORAGE_KEY, value: nextDaily });
    await db.keyval.put({ key: REMINDER_ACTION_STORAGE_PREFIX + actionId, value: { signature, reminderId: target.id } });
    return { result: { status: 'saved', reminderId: target.id }, relativeReminders: nextRelative, dailyReminders: nextDaily };
  });
}

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

  setReminderLateGrace: async (kind, id, version, minutes) => {
    if (minutes !== undefined && ![0, 10, 30, 60].includes(minutes)) return { status: 'rejected', reason: 'invalid_policy' };
    const key = kind === 'daily' ? DAILY_REMINDER_STORAGE_KEY : RELATIVE_REMINDER_STORAGE_KEY;
    try {
      let found = false;
      const next = await updateReminderRecords<RelativeReminder | DailyReminder>(key, records => records.map(r => {
        if (r.id !== id || (r.version ?? 0) !== version) return r;
        found = true;
        return { ...r, lateGraceMinutes: minutes, version: version + 1, retryAt: undefined };
      }));
      if (!found) return { status: 'rejected', reason: 'target_changed' };
      if (kind === 'daily') set({ dailyReminders: next as DailyReminder[] });
      else set({ relativeReminders: next as RelativeReminder[] });
      await cancelNativeReminderAlarms(id);
      return { status: 'saved', reminderId: id };
    } catch { return { status: 'failed', reason: 'persistence_failed' }; }
  },

  persistRelativeReminders: async (reminders) => {
    await replaceReminderRecords(RELATIVE_REMINDER_STORAGE_KEY, reminders);
    set({ relativeReminders: reminders });
  },

  persistDailyReminders: async (reminders) => {
    await replaceReminderRecords(DAILY_REMINDER_STORAGE_KEY, reminders);
    set({ dailyReminders: reminders });
  },

  persistMissedReminders: async (records) => {
    await replaceReminderRecords(KUMIKO_MISSED_REMINDERS_STORAGE_KEY, records);
    set({ missedReminders: records });
  },

  removeMissedReminder: async (recordId) => {
    const next = await updateReminderRecords<MissedReminderRecord>(KUMIKO_MISSED_REMINDERS_STORAGE_KEY, records => records.filter(r => r.id !== recordId));
    set({ missedReminders: next });
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
      if (!Number.isFinite(delaySeconds) || delaySeconds <= 0) {
        console.warn('[RELATIVE REMINDER] Refusing to save: invalid delay', { delaySeconds });
        return { status: 'rejected', reason: 'invalid_delay' };
      }
      const safeDelaySeconds = Math.max(1, Math.round(delaySeconds));
      if (timing?.actionId !== undefined && (typeof timing.actionId !== 'string' || !timing.actionId.trim())) {
        return { status: 'rejected', reason: 'invalid_action_id' };
      }
      if (timing?.referenceAt !== undefined && (!Number.isFinite(timing.referenceAt) || timing.referenceAt <= 0)) {
        return { status: 'rejected', reason: 'invalid_reference_at' };
      }
      if (!rawSafe) {
        console.warn('[RELATIVE REMINDER] event was empty after normalisation; using generic label', { eventRaw: event, fallback: safeEvent });
      }

      const now = Date.now();
      const referenceAt = timing?.referenceAt ?? now;
      const dueAt = timing?.dueAt ?? (referenceAt + safeDelaySeconds * 1000);
      if (!Number.isFinite(dueAt) || dueAt <= 0 || !Number.isFinite(new Date(dueAt).getTime())) {
        return { status: 'rejected', reason: 'invalid_due_at' };
      }
      const reminder: RelativeReminder = {
        id: timing?.actionId ?? `${now}-${Math.random().toString(36).slice(2, 8)}`,
        event: safeEvent,
        dueAt,
        createdAt: now,
        sourceText: sourceText?.trim() || undefined,
        timeZone: validReminderTimeZone(timing?.timeZone) || resolveReminderTimeZone(sourceText || '', get().locationConfig.userTimezone),
      };
      const signature = JSON.stringify({ kind: 'relative', event: safeEvent, delaySeconds: safeDelaySeconds,
        referenceAt: timing?.referenceAt ?? null, dueAt: timing?.dueAt ?? null,
        timeZone: reminder.timeZone, sourceText: reminder.sourceText });
      const saved = await saveReminderRecord(RELATIVE_REMINDER_STORAGE_KEY, reminder, timing?.actionId, signature, timing?.expectedEpoch);
      if (saved.records) set({ relativeReminders: saved.records });
      return saved.result;
    } catch (e) {
      console.error("[RELATIVE REMINDER] Failed to save reminder", e);
      return { status: 'failed', reason: 'persistence_failed' };
    }
  },

  markRelativeReminderRetry: async (reminderId) => {
    const updated = await updateReminderRecords<RelativeReminder>(RELATIVE_REMINDER_STORAGE_KEY, records => records.map(r =>
      r.id === reminderId ? { ...r, retryAt: Date.now() + REMINDER_RETRY_DELAY_MS } : r
    ));
    set({ relativeReminders: updated });
  },

  removeRelativeReminder: async (reminderId) => {
    const next = await updateReminderRecords<RelativeReminder>(RELATIVE_REMINDER_STORAGE_KEY, records => records.filter(r => r.id !== reminderId));
    set({ relativeReminders: next });
    await cancelNativeReminderAlarms(reminderId);
  },

  toggleRelativeReminderPaused: async (reminderId) => {
    const next = await updateReminderRecords<RelativeReminder>(RELATIVE_REMINDER_STORAGE_KEY, records => records.map(r =>
      r.id === reminderId ? { ...r, version: (r.version ?? 0) + 1, paused: !r.paused, retryAt: undefined } : r
    ));
    set({ relativeReminders: next });
    await cancelNativeReminderAlarms(reminderId);
  },

  saveDailyReminder: async (event, hour, minute, sourceText, timeZone, options) => {
    try {
      // v2.14.23: same empty-event fallback as the relative path. Daily
      // reminders are rarer but the LLM sometimes returns
      // `{ event: "", hour: 22, minute: 30 }` and we used to drop them.
      const rawSafe = normalizeReminderEvent(event || '');
      const sourceHasCjk = /[\u4e00-\u9fff]/u.test(sourceText || '');
      const safeEvent = rawSafe || (sourceHasCjk ? '提醒你' : 'remind you');
      if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
        console.warn('[DAILY REMINDER] Refusing to save: invalid hour/minute', { hour, minute });
        return { status: 'rejected', reason: 'invalid_hour_or_minute' };
      }
      if (options?.actionId !== undefined && (typeof options.actionId !== 'string' || !options.actionId.trim())) {
        return { status: 'rejected', reason: 'invalid_action_id' };
      }
      if (!rawSafe) {
        console.warn('[DAILY REMINDER] event was empty after normalisation; using generic label', { eventRaw: event, fallback: safeEvent });
      }

      const reminder: DailyReminder = {
        id: options?.actionId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        event: safeEvent,
        hour,
        minute,
        timeZone: validReminderTimeZone(timeZone) || resolveReminderTimeZone(sourceText || '', get().locationConfig.userTimezone),
        createdAt: Date.now(),
        sourceText: sourceText?.trim() || undefined,
      };
      const signature = JSON.stringify({ kind: 'daily', event: safeEvent, hour, minute,
        timeZone: reminder.timeZone, sourceText: reminder.sourceText });
      const saved = await saveReminderRecord(DAILY_REMINDER_STORAGE_KEY, reminder, options?.actionId, signature, options?.expectedEpoch);
      if (saved.records) set({ dailyReminders: saved.records });
      return saved.result;
    } catch (e) {
      console.error("[DAILY REMINDER] Failed to save reminder", e);
      return { status: 'failed', reason: 'persistence_failed' };
    }
  },

  removeDailyReminder: async (reminderId) => {
    const next = await updateReminderRecords<DailyReminder>(DAILY_REMINDER_STORAGE_KEY, records => records.filter(r => r.id !== reminderId));
    set({ dailyReminders: next });
    await cancelNativeReminderAlarms(reminderId);
  },

  applyReminderMutation: async (actionId, target, replacement, options) => {
    if (typeof actionId !== 'string' || !actionId.trim()) return { status: 'rejected', reason: 'invalid_action_id' };
    if (!target || (target.kind !== 'once' && target.kind !== 'daily') || !isValidMutationReminder(target.expected)
      || target.id !== target.expected.id || (target.kind === 'daily') !== ('hour' in target.expected)) {
      return { status: 'rejected', reason: 'invalid_target' };
    }
    if (replacement !== undefined && (!isValidMutationReminder(replacement) || replacement.id !== target.id)) {
      return { status: 'rejected', reason: 'invalid_replacement' };
    }
    try {
      const committed = await mutateReminderRecord(actionId, target, replacement, options?.expectedEpoch);
      if (committed.relativeReminders && committed.dailyReminders) {
        set({ relativeReminders: committed.relativeReminders, dailyReminders: committed.dailyReminders });
        if (committed.result.status === 'saved') {
          noteCommittedReminderWrite(RELATIVE_REMINDER_STORAGE_KEY, committed.relativeReminders);
          noteCommittedReminderWrite(DAILY_REMINDER_STORAGE_KEY, committed.dailyReminders);
          await cancelNativeReminderAlarms(target.id);
        }
      }
      return committed.result;
    } catch (error) {
      console.error('[REMINDER MUTATION] Failed to commit reminder change', error);
      return { status: 'failed', reason: 'persistence_failed' };
    }
  },

  toggleDailyReminderPaused: async (reminderId) => {
    const next = await updateReminderRecords<DailyReminder>(DAILY_REMINDER_STORAGE_KEY, records => records.map(r =>
      r.id === reminderId ? { ...r, activeSince: r.paused ? Date.now() : r.activeSince, version: (r.version ?? 0) + 1, paused: !r.paused, retryAt: undefined } : r
    ));
    set({ dailyReminders: next });
    await cancelNativeReminderAlarms(reminderId);
  },

  markDailyReminderTriggered: async (reminderId, dateKey) => {
    const next = await updateReminderRecords<DailyReminder>(DAILY_REMINDER_STORAGE_KEY, records => records.map(r =>
      r.id === reminderId ? { ...r, lastTriggeredDate: dateKey, retryAt: undefined } : r
    ));
    set({ dailyReminders: next });
  },

  markDailyReminderRetry: async (reminderId) => {
    const next = await updateReminderRecords<DailyReminder>(DAILY_REMINDER_STORAGE_KEY, records => records.map(r =>
      r.id === reminderId ? { ...r, retryAt: Date.now() + REMINDER_RETRY_DELAY_MS } : r
    ));
    set({ dailyReminders: next });
  },
});
