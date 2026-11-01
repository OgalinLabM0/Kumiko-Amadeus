// Scheduling metadata is private to the program, not character knowledge.
export const KUMIKO_TIME_ZONE = 'Asia/Tokyo';

export const validReminderTimeZone = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value.trim() }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

/** An explicit zone in the request wins; otherwise bind to the settings at
 * request time. Never consult the device timezone again after saving. */
export const getExplicitReminderTimeZone = (source: string, explicitZone?: string): string | undefined => {
  const iana = source.match(/\b(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?\b/)?.[0];
  if (iana && validReminderTimeZone(iana)) return validReminderTimeZone(iana)!;
  if (/(?:日本|东京|東京|久美子)(?:的)?(?:时间|時間)|(?:你|妳)(?:那边|那邊|那里)(?:的)?(?:时间|時間)|\b(?:JST|Japan(?:ese)? time|Tokyo time|your time)\b/iu.test(source)) return KUMIKO_TIME_ZONE;
  if (/(?:北京|中国|中國|上海)(?:的)?(?:时间|時間)|\b(?:Beijing|China|Shanghai) time\b/iu.test(source)) return 'Asia/Shanghai';
  if (/(?:我(?:这|這|那)(?:里|裡|边|邊)|当地|當地|本地)(?:的)?(?:时间|時間)|\b(?:my|local) time\b/iu.test(source)) return undefined;
  // A model's unsolicited time_zone must not silently turn an unqualified
  // "8 PM" into JST. Named clock bases need evidence in the request itself.
  const namesClockBasis = /[\p{L}]{2,24}(?:时间|時間)|\b(?:time\s+(?:in|at)\s+|[A-Za-z]+\s+time\b|(?:UTC|GMT)[+-])/iu.test(source);
  return namesClockBasis ? validReminderTimeZone(explicitZone) : undefined;
};

export const resolveReminderTimeZone = (source: string, configuredZone?: string, explicitZone?: string): string =>
  getExplicitReminderTimeZone(source, explicitZone) || validReminderTimeZone(configuredZone) || KUMIKO_TIME_ZONE;

const clockParts = (at: number, timeZone: string) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map(p => [p.type, p.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour % 24, minute: +parts.minute };
};

/** Convert a requested wall clock into an instant, including DST boundaries.
 * No day offset means the next occurrence; an explicit day must actually
 * contain that minute. Never silently shift a nonexistent or past clock. */
export const getClockReminderAt = (
  hour: number, minute: number, timeZone: string, now: number, daysOffset?: number,
): number | null => {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59
    || !Number.isFinite(now) || !validReminderTimeZone(timeZone)
    || (daysOffset !== undefined && (!Number.isInteger(daysOffset) || daysOffset < 0 || daysOffset > 3660))) return null;
  const current = clockParts(now, timeZone);
  const date = Date.UTC(current.year, current.month - 1, current.day);
  const offsets = daysOffset === undefined ? [0, 1, 2, 3] : [daysOffset];
  for (const dayOffset of offsets) {
    const nominal = date + dayOffset * 86400000 + hour * 3600000 + minute * 60000;
    const target = new Date(nominal);
    const zoneOffsets = new Set<number>();
    for (let h = -36; h <= 36; h += 12) {
      const sample = nominal + h * 3600000;
      const p = clockParts(sample, timeZone);
      zoneOffsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - sample);
    }
    for (const at of [...zoneOffsets].map(offset => nominal - offset).sort((a, b) => a - b)) {
      if (at <= now) continue;
      const p = clockParts(at, timeZone);
      if (p.year === target.getUTCFullYear() && p.month === target.getUTCMonth() + 1 && p.day === target.getUTCDate()
        && p.hour === hour && p.minute === minute) return at;
    }
  }
  return null;
};

export const formatReminderJst = (at: number, language: 'zh' | 'en'): string =>
  new Date(at).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB', {
    timeZone: KUMIKO_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }) + ' JST';
