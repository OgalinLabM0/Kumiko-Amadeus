import { db } from './db';
import { isCapacitorNative, getCapacitorPlatform } from './environment';
import { reminderNotificationId, cancelReminderNotification } from './capacitorNotifications';
import { cancelAndroidAlarm } from './androidAlarmService';
import { getDataRestoreVersion, isDataRestoreBlocked } from './dataRestoreGate';

export const REMINDER_NATIVE_CANCEL_KEY = 'kumiko_reminder_native_cancel_v1';
type Job = { id: string; token: string; notificationIds: number[] };

// Called inside the same keyval transaction that invalidates the reminder.
export async function queueReminderNativeCancellation(id: string): Promise<void> {
  if (!isCapacitorNative() || getCapacitorPlatform() !== 'android') return;
  const jobs: Job[] = (await db.keyval.get(REMINDER_NATIVE_CANCEL_KEY))?.value ?? [];
  const occurrences: Array<{ id: string }> = (await db.keyval.get('kumiko_reminder_occurrences_v1'))?.value ?? [];
  const notificationIds: number[] = [];
  for (const occurrence of occurrences) {
    try {
      const [reminderId, version, dueAt] = JSON.parse(occurrence.id);
      if (reminderId === id) notificationIds.push(reminderNotificationId(`reminder:${id}:${version}:${dueAt}`));
    } catch { /* Ignore malformed historic records. */ }
  }
  jobs.push({ id, token: `${Date.now()}-${Math.random()}`, notificationIds: [...new Set(notificationIds)] });
  await db.keyval.put({ key: REMINDER_NATIVE_CANCEL_KEY, value: jobs });
}

/** Call inside the restore transaction before replacing reminders or execution state. */
export async function captureReminderNativeCancellationsForRestore(): Promise<Job[]> {
  if (isCapacitorNative() && getCapacitorPlatform() === 'android') {
    const ids = new Set<string>();
    for (const key of ['kumiko_relative_reminders', 'kumiko_daily_reminders']) {
      const rows = (await db.keyval.get(key))?.value ?? [];
      if (!Array.isArray(rows)) throw new Error(`Invalid reminder state: ${key}`);
      for (const row of rows) if (typeof row?.id === 'string' && row.id) ids.add(row.id);
    }
    for (const id of ids) await queueReminderNativeCancellation(id);
  }
  const jobs = (await db.keyval.get(REMINDER_NATIVE_CANCEL_KEY))?.value ?? [];
  if (!Array.isArray(jobs)) throw new Error('Invalid native reminder cancellation queue');
  return jobs;
}

/** Merge live jobs after execution-state replacement, in the same transaction. */
export async function mergeReminderNativeCancellationsAfterRestore(liveJobs: Job[]): Promise<void> {
  const restored = (await db.keyval.get(REMINDER_NATIVE_CANCEL_KEY))?.value ?? [];
  if (!Array.isArray(restored)) throw new Error('Invalid restored native reminder cancellation queue');
  const byToken = new Map<string, Job>();
  for (const job of [...restored, ...liveJobs]) byToken.set(job.token, job);
  if (byToken.size) await db.keyval.put({ key: REMINDER_NATIVE_CANCEL_KEY, value: [...byToken.values()] });
}

// Serialize all native alarm reconciliation and queue drains in this WebView.
// A queued cancellation must never overtake a newer schedule with the same ID.
let nativeAlarmTail: Promise<void> = Promise.resolve();
export function withReminderNativeAlarmLock<T>(work: () => Promise<T>): Promise<T> {
  const result = nativeAlarmTail.then(work);
  nativeAlarmTail = result.then(() => {}, () => {});
  return result;
}

export async function drainReminderNativeCancellationsLocked(): Promise<void> {
  if (!isCapacitorNative() || getCapacitorPlatform() !== 'android' || isDataRestoreBlocked()) return;
  const version = getDataRestoreVersion();
    const jobs: Job[] = (await db.keyval.get(REMINDER_NATIVE_CANCEL_KEY))?.value ?? [];
    for (const job of jobs) {
      if (isDataRestoreBlocked() || getDataRestoreVersion() !== version) return;
      const results = await Promise.all([
        ...[job.id, `${job.id}__prewarm`, `daily-${job.id}`].map(cancelAndroidAlarm),
        ...job.notificationIds.map(cancelReminderNotification),
      ]);
      if (isDataRestoreBlocked() || getDataRestoreVersion() !== version) return;
      if (!results.every(Boolean)) continue;
      await db.transaction('rw', db.keyval, async () => {
        const current: Job[] = (await db.keyval.get(REMINDER_NATIVE_CANCEL_KEY))?.value ?? [];
        await db.keyval.put({ key: REMINDER_NATIVE_CANCEL_KEY, value: current.filter(x => x.token !== job.token) });
      });
    }
}

export function drainReminderNativeCancellations(): Promise<void> {
  return withReminderNativeAlarmLock(drainReminderNativeCancellationsLocked);
}
