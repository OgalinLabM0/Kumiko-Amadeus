import type { DailyReminder } from '../../store/slices/reminderSlice';
import { getTimePartsInTimezone } from './backupHelpers';

const HOUR_MS = 3_600_000;

/** Next real occurrence of the reminder's wall-clock minute, in its own zone.
 * Repeated DST minutes may have two instants; choose the first future one.
 * Missing DST minutes have no exact native target; polling's grace window
 * remains unchanged, rather than shifting a missing minute by a whole hour.
 * lastTriggeredDate excludes both occurrences after a successful daily send.
 */
export const getNextDailyReminderAt = (
  reminder: Pick<DailyReminder, 'hour' | 'minute' | 'timeZone' | 'lastTriggeredDate'>,
  now: number,
): number | null => {
  if (!Number.isFinite(now)
    || !Number.isInteger(reminder.hour) || reminder.hour < 0 || reminder.hour > 23
    || !Number.isInteger(reminder.minute) || reminder.minute < 0 || reminder.minute > 59) return null;

  const timeZone = reminder.timeZone || 'Asia/Tokyo';
  try {
    const current = getTimePartsInTimezone(new Date(now), timeZone);
    const localDate = Date.UTC(current.year, current.month - 1, current.day);
    // Calendar arithmetic in UTC advances the local date without borrowing
    // the device timezone or assuming every timezone day is 24 hours long.
    for (let dayOffset = 0; dayOffset < 4; dayOffset += 1) {
      const day = new Date(localDate + dayOffset * 24 * HOUR_MS);
      const dateKey = day.toISOString().slice(0, 10);
      if (reminder.lastTriggeredDate === dateKey) continue;
      const nominal = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), reminder.hour, reminder.minute);
      const offsets = new Set<number>();
      // Sample both sides of any nearby DST change. Verify each candidate
      // below instead of accepting a fixed-point guess inside a skipped hour.
      for (let hours = -36; hours <= 36; hours += 12) {
        const sample = nominal + hours * HOUR_MS;
        const parts = getTimePartsInTimezone(new Date(sample), timeZone);
        // Some Intl runtimes format midnight as 24:00 on the same date.
        offsets.add(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute) - sample);
      }
      const candidates = [...offsets].map(offset => nominal - offset).sort((a, b) => a - b);
      for (const at of candidates) {
        if (at <= now) continue;
        const parts = getTimePartsInTimezone(new Date(at), timeZone);
        if (parts.dateKey === dateKey && parts.hour % 24 === reminder.hour && parts.minute === reminder.minute) return at;
      }
    }
  } catch {
    // Invalid imported timezones must not abort reconciliation of other rows.
  }
  return null;
};
