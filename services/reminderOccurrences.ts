import { db } from './db';
import type { MessageEntity } from './db';
import { DAILY_REMINDER_STORAGE_KEY, KUMIKO_MISSED_REMINDERS_STORAGE_KEY, RELATIVE_REMINDER_STORAGE_KEY, type DailyReminder, type RelativeReminder } from '../store/slices/reminderSlice';

export const REMINDER_OCCURRENCES_STORAGE_KEY = 'kumiko_reminder_occurrences_v1';
type Reminder = RelativeReminder | DailyReminder;
type Occurrence = { id: string; token: string; epoch: string; status: 'generating' | 'sending' | 'delivered' | 'missed' | 'unknown'; claimedAt: number; applicationDelivery?: 'committed' | 'unknown'; osDelivery?: 'unknown' };
const keyFor = (r: Reminder) => 'hour' in r ? DAILY_REMINDER_STORAGE_KEY : RELATIVE_REMINDER_STORAGE_KEY;
const fingerprint = (r: Reminder) => JSON.stringify('hour' in r
  ? [r.id, r.version ?? 0, r.event, r.sourceText, r.createdAt, r.timeZone, r.hour, r.minute, !!r.paused, r.lateGraceMinutes]
  : [r.id, r.version ?? 0, r.event, r.sourceText, r.createdAt, r.timeZone, r.dueAt, r.originalDueAt, !!r.paused, r.lateGraceMinutes]);
export const reminderGraceMs = (r: Reminder) => r.lateGraceMinutes !== undefined ? (r.lateGraceMinutes === 0 ? 60_000 : r.lateGraceMinutes * 60_000)
  : /叫醒|唤醒|喊醒|wake\s*(?:me|up)|wakeup/i.test(`${r.event} ${r.sourceText || ''}`) ? 10 * 60_000 : 30 * 60_000;
export const occurrenceId = (r: Reminder, dueAt: number) => JSON.stringify([r.id, r.version ?? 0, dueAt]);
const records = async <T>(key: string): Promise<T[]> => {
  const row = await db.keyval.get(key);
  if (row && !Array.isArray(row.value)) throw new Error(`Invalid reminder state: ${key}`);
  return row?.value ?? [];
};
const currentMatches = async (r: Reminder) => (await records<Reminder>(keyFor(r))).some(x => fingerprint(x) === fingerprint(r));
const epoch = async () => (await db.keyval.get('kumiko_turn_epoch_v1'))?.value ?? 'initial';

/** Commit the older missed range and its calendar watermark together. No old
 * occurrence is sent, even if processing the most recent one later fails. */
export async function recordPriorDailyMisses(r: DailyReminder, range: { priorCount: number; priorFirst?: number; priorLast?: number; priorDate?: string }, language = 'zh'): Promise<boolean> {
  if (!range.priorCount || range.priorFirst === undefined || range.priorLast === undefined || !range.priorDate) return false;
  return db.transaction('rw', db.keyval, async () => {
    const reminders = await records<DailyReminder>(DAILY_REMINDER_STORAGE_KEY);
    const current = reminders.find(x => fingerprint(x) === fingerprint(r));
    if (!current || current.paused || current.lastTriggeredDate !== r.lastTriggeredDate || current.activeSince !== r.activeSince) return false;
    const id = JSON.stringify([r.id, r.version ?? 0, 'missed-range', range.priorFirst, range.priorLast]);
    const missed = await records<any>(KUMIKO_MISSED_REMINDERS_STORAGE_KEY);
    if (!missed.some(x => x.id === id)) missed.unshift({ id, event: r.event, sourceText: r.sourceText,
      originalDueAt: range.priorFirst, firstDueAt: range.priorFirst, lastDueAt: range.priorLast,
      count: range.priorCount, timeZone: r.timeZone, recordedAt: Date.now() });
    const alerts = await records<any>('kumiko_message_alerts');
    const alertId = `missed-reminder-${id}`;
    if (!alerts.some(x => x.id === alertId)) alerts.unshift({ id: alertId, messageId: alertId,
      preview: language === 'en' ? `Missed ${range.priorCount} reminders: ${r.event}` : `错过 ${range.priorCount} 次提醒：${r.event}`,
      timestamp: Date.now(), kind: 'reminder', isRead: false });
    await db.keyval.put({ key: KUMIKO_MISSED_REMINDERS_STORAGE_KEY, value: missed });
    await db.keyval.put({ key: 'kumiko_message_alerts', value: alerts.slice(0, 50) });
    await db.keyval.put({ key: DAILY_REMINDER_STORAGE_KEY, value: reminders.map(x => x === current ? { ...x, lastTriggeredDate: range.priorDate } : x) });
    return true;
  });
}

/** Only generation can be reclaimed after a crash; an attempted side effect stays unknown. */
export async function claimReminderOccurrence(r: Reminder, dueAt: number, now = Date.now()): Promise<string | null> {
  return db.transaction('rw', db.keyval, async () => {
    if (!await currentMatches(r)) return null;
    const list = await records<Occurrence>(REMINDER_OCCURRENCES_STORAGE_KEY);
    const id = occurrenceId(r, dueAt);
    const old = list.find(x => x.id === id);
    if (old && (old.status !== 'generating' || now - old.claimedAt < 5 * 60_000)) return null;
    const token = `${now}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    const next: Occurrence = { id, token, epoch: await epoch(), status: 'generating', claimedAt: now };
    await db.keyval.put({ key: REMINDER_OCCURRENCES_STORAGE_KEY, value: [...list.filter(x => x.id !== id), next] });
    return token;
  });
}

export async function markReminderSending(r: Reminder, dueAt: number, token: string): Promise<boolean> {
  return db.transaction('rw', db.keyval, async () => {
    const list = await records<Occurrence>(REMINDER_OCCURRENCES_STORAGE_KEY);
    const row = list.find(x => x.id === occurrenceId(r, dueAt));
    if (!row || row.token !== token || row.status !== 'generating' || row.epoch !== await epoch() || !await currentMatches(r)) return false;
    row.status = 'sending';
    await db.keyval.put({ key: REMINDER_OCCURRENCES_STORAGE_KEY, value: list });
    return true;
  });
}

export async function isReminderOccurrenceCurrent(r: Reminder, dueAt: number, token: string): Promise<boolean> {
  return db.transaction('r', db.keyval, async () => {
    const row = (await records<Occurrence>(REMINDER_OCCURRENCES_STORAGE_KEY)).find(x => x.id === occurrenceId(r, dueAt));
    return !!row && row.token === token && row.status === 'sending' && row.epoch === await epoch() && await currentMatches(r);
  });
}

export async function commitReminderMessage(r: Reminder, dueAt: number, token: string, message: MessageEntity): Promise<boolean> {
  return db.transaction('rw', db.keyval, db.messages, async () => {
    const list = await records<Occurrence>(REMINDER_OCCURRENCES_STORAGE_KEY);
    const row = list.find(x => x.id === occurrenceId(r, dueAt));
    if (!row || row.token !== token || row.status !== 'sending' || row.epoch !== await epoch() || !await currentMatches(r)) return false;
    if (row.applicationDelivery === 'committed') return false;
    await db.messages.put(message);
    row.applicationDelivery = 'committed';
    await db.keyval.put({ key: REMINDER_OCCURRENCES_STORAGE_KEY, value: list });
    return true;
  });
}

export async function abandonReminderOccurrence(r: Reminder, dueAt: number, token: string): Promise<void> {
  await db.transaction('rw', db.keyval, async () => {
    const list = await records<Occurrence>(REMINDER_OCCURRENCES_STORAGE_KEY);
    const row = list.find(x => x.id === occurrenceId(r, dueAt));
    if (!row || row.token !== token) return;
    if (row.status === 'generating') {
      // Keep a short, reclaimable delay rather than re-running the model each tick.
      row.claimedAt = Date.now() - 5 * 60_000 + 30_000;
      await db.keyval.put({ key: REMINDER_OCCURRENCES_STORAGE_KEY, value: list });
    } else if (row.status === 'sending') {
      row.status = 'unknown';
      if (row.applicationDelivery !== 'committed') row.applicationDelivery = 'unknown';
      row.osDelivery = 'unknown';
      await db.keyval.put({ key: REMINDER_OCCURRENCES_STORAGE_KEY, value: list });
    }
  });
}

export async function finishReminderOccurrence(r: Reminder, dueAt: number, token: string, status: 'delivered' | 'unknown' | 'missed', dateKey?: string, language = 'zh'): Promise<boolean> {
  return db.transaction('rw', db.keyval, async () => {
    const list = await records<Occurrence>(REMINDER_OCCURRENCES_STORAGE_KEY);
    const row = list.find(x => x.id === occurrenceId(r, dueAt));
    if (!row || row.token !== token || row.epoch !== await epoch() || !await currentMatches(r)) return false;
    if (status === 'delivered' && row.status !== 'sending') return false;
    if (status === 'missed' && row.status !== 'generating') return false;
    row.status = status;
    if (status === 'delivered') { row.osDelivery = 'unknown'; }
    if (status === 'unknown') { row.applicationDelivery = 'unknown'; row.osDelivery = 'unknown'; }
    await db.keyval.put({ key: REMINDER_OCCURRENCES_STORAGE_KEY, value: list });
    if (status === 'unknown') return true;
    const key = keyFor(r);
    const reminders = await records<Reminder>(key);
    const next = 'hour' in r
      ? reminders.map(x => fingerprint(x) === fingerprint(r) ? { ...x, lastTriggeredDate: dateKey, retryAt: undefined } : x)
      : reminders.filter(x => fingerprint(x) !== fingerprint(r));
    await db.keyval.put({ key, value: next });
    if (status === 'missed') {
      const missed = await records<any>(KUMIKO_MISSED_REMINDERS_STORAGE_KEY);
      const id = occurrenceId(r, dueAt);
      if (!missed.some(x => x.id === id)) await db.keyval.put({ key: KUMIKO_MISSED_REMINDERS_STORAGE_KEY, value: [{ id, event: r.event, sourceText: r.sourceText, originalDueAt: dueAt, recordedAt: Date.now() }, ...missed] });
      const alerts = await records<any>('kumiko_message_alerts');
      const alertId = `missed-reminder-${id}`;
      if (!alerts.some(x => x.id === alertId)) {
        const preview = language === 'en' ? `Missed reminder: ${r.event}` : `错过的提醒：${r.event}`;
        await db.keyval.put({ key: 'kumiko_message_alerts', value: [{ id: alertId, messageId: alertId, preview, timestamp: Date.now(), kind: 'reminder', isRead: false }, ...alerts].slice(0, 50) });
      }
    }
    return true;
  });
}
