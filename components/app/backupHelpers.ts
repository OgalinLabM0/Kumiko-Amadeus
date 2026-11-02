import type {
  KumikoBlockRuntime,
  Message,
  MessageAlertKind,
  MissedMessageAlert,
} from '../../types';
import {
  INITIAL_WORLD_CHARACTER_STATUS,
  type DailyFragmentEntity,
  type EpisodeEntity,
  type KumikoAffectionEntity,
  type KumikoDiaryEntity,
  type KumikoMoodEntity,
  type PsycheStateEntity,
  type WorldCharacterStatusMap,
} from '../../services/db';
import { normalizeReminderEvent, type RelativeReminder, type DailyReminder, type MissedReminderRecord } from '../../store/slices/reminderSlice';
import { DEV_LOG_MAX_OBJECT_KEYS } from './appConstants';
import { validReminderTimeZone } from '../../services/reminderTime';

export const recalculateTurnCountFromMessages = (messages: Message[]) => {
  const orderedMessages = [...messages]
    .filter(message => !!message?.text && Number.isFinite(message.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);

  let turns = 0;
  let awaitingModelReply = false;

  orderedMessages.forEach(message => {
    if (message.role === 'user') {
      awaitingModelReply = true;
      return;
    }

    if (message.role === 'model' && awaitingModelReply) {
      turns += 1;
      awaitingModelReply = false;
    }
  });

  return turns;
};

const CHINESE_NUMERAL_VALUES: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const parseSmallChineseNumber = (raw: string): number | null => {
  const text = raw.trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);

  if (text === '十') return 10;
  const tenIndex = text.indexOf('十');
  if (tenIndex >= 0) {
    const tensRaw = text.slice(0, tenIndex);
    const onesRaw = text.slice(tenIndex + 1);
    const tens = tensRaw ? CHINESE_NUMERAL_VALUES[tensRaw] : 1;
    const ones = onesRaw ? CHINESE_NUMERAL_VALUES[onesRaw] : 0;
    if (typeof tens === 'number' && typeof ones === 'number') {
      return tens * 10 + ones;
    }
    return null;
  }

  return CHINESE_NUMERAL_VALUES[text] ?? null;
};

// v2.14.23: full-width-digit normalisation. Some Chinese IMEs (notably
// the Pinyin keyboard on HyperOS) commit "２分钟" with a U+FF12 instead
// of an ASCII '2', and our timing regex is ASCII-only. The same applies
// to "５" "８" etc. Mapping FF10..FF19 → 0..9 once at the top of the
// regex pipeline lets every downstream pattern just see ASCII.
const normalizeFullwidthDigits = (text: string): string =>
  text.replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 0x30));

export const parseRelativeReminderRequest = (text: string): { event: string; delaySeconds: number } | null => {
  const normalized = normalizeFullwidthDigits(text).replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const hasReminderIntent = /(?:提醒|叫|喊)(?:一下)?我|记得.+(?:提醒|叫|喊)|remind me|ping me|tell me|wake me up/i.test(normalized);
  if (!hasReminderIntent) return null;

  let delaySeconds = 0;
  const zhMatch = normalized.match(/(\d+(?:\.\d+)?)\s*(秒钟?|秒|分钟?|分|小时|钟头|个小时)/u);
  const zhTextMatch = normalized.match(/([零〇一二两三四五六七八九十]{1,4})\s*(秒钟?|秒|分钟?|分|小时|钟头|个小时)/u);
  const enMatch = normalized.match(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hour|hr|h)\b/i);
  const timeMatch = zhMatch || zhTextMatch || enMatch;

  if (!timeMatch) return null;
  // "8点30分" is a clock, not a 30-minute duration. Leave an absolute
  // clock to the structured extraction instead of silently arming a timer.
  const wallClock = normalized.match(/[\d零〇一二两三四五六七八九十]+\s*[点:：]\s*[\d零〇一二两三四五六七八九十]+\s*分?/u);
  if (wallClock && timeMatch.index !== undefined && wallClock.index !== undefined
    && timeMatch.index >= wallClock.index && timeMatch.index < wallClock.index + wallClock[0].length) return null;

  const amount = zhTextMatch && timeMatch === zhTextMatch
    ? parseSmallChineseNumber(timeMatch[1])
    : Number(timeMatch[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = timeMatch[2].toLowerCase();
  if (/^秒/.test(unit) || /^sec/.test(unit) || unit === 's' || /^second/.test(unit)) {
    delaySeconds = Math.round(amount);
  } else if (/^分/.test(unit) || /^min/.test(unit) || /^minute/.test(unit) || unit === 'm') {
    delaySeconds = Math.round(amount * 60);
  } else if (/^小/.test(unit) || /钟头/.test(unit) || /^h(?:ou)?r/.test(unit) || unit === 'h') {
    delaySeconds = Math.round(amount * 3600);
  }

  if (!Number.isFinite(delaySeconds) || delaySeconds <= 0) return null;

  const eventPatterns = [
    /(?:提醒|叫|喊)(?:一下)?我(?:去|要|该|得)?(.+)$/u,
    /(?:remind|ping|tell) me to (.+)$/i,
    /wake me up(?: to)? (.+)$/i,
    /remind me about (.+)$/i,
  ];

  let rawEvent = '';
  for (const pattern of eventPatterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      rawEvent = match[1];
      break;
    }
  }

  if (!rawEvent && timeMatch.index !== undefined) {
    const tail = normalized.slice(timeMatch.index + timeMatch[0].length);
    rawEvent = tail
      .replace(/^[\s,，。.!！？:：;；]*(?:后|後|later)?[\s,，。.!！？:：;；]*/u, '')
      .replace(/^(?:记得|记住|提醒|叫|喊)(?:一下)?我?(?:去|要|该|得)?/u, '')
      .trim();
  }

  rawEvent = rawEvent.replace(/\b(?:in|after)\s+\d+(?:\.\d+)?\s*(?:seconds?|secs?|sec|minutes?|mins?|min|hours?|hrs?|hour|hr)\b.*$/i, '').trim();
  rawEvent = rawEvent
    .replace(/^\d+(?:\.\d+)?\s*(?:秒钟?|秒|分钟?|分|小时|钟头|个小时)\s*(?:后|後)?\s*/u, '')
    .replace(/^[零〇一二两三四五六七八九十]{1,4}\s*(?:秒钟?|秒|分钟?|分|小时|钟头|个小时)\s*(?:后|後)?\s*/u, '')
    .replace(/^\d+(?:\.\d+)?\s*(?:seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hour|hr|h)\b\s*(?:later|after)?\s*/i, '')
    .replace(/\b(?:in|after)\s+\d+(?:\.\d+)?\s*(?:seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hour|hr|h)\b.*$/i, '')
    .trim();

  const event = normalizeReminderEvent(rawEvent) || (/[\u4e00-\u9fff]/u.test(normalized) ? '提醒你' : 'remind you');
  if (!event) return null;

  return {
    event,
    delaySeconds: Math.max(1, delaySeconds),
  };
};

export const normalizeDailyHourMinute = (hour: number, minute: number, period?: string): { hour: number; minute: number } | null => {
  let normalizedHour = hour;
  const normalizedMinute = minute;

  if (!Number.isInteger(normalizedHour) || !Number.isInteger(normalizedMinute)) return null;
  if (normalizedMinute < 0 || normalizedMinute > 59) return null;
  if (normalizedHour < 0 || normalizedHour > 23) return null;

  if (period) {
    if ((period.includes('下午') || period.includes('晚上') || period.includes('傍晚')) && normalizedHour < 12) {
      normalizedHour += 12;
    }
    if (period.includes('中午') && normalizedHour < 11) {
      normalizedHour += 12;
    }
    if (period.includes('凌晨') && normalizedHour === 12) {
      normalizedHour = 0;
    }
    if ((period.includes('早上') || period.includes('上午')) && normalizedHour === 12) {
      normalizedHour = 0;
    }
  }

  if (normalizedHour < 0 || normalizedHour > 23) return null;
  return { hour: normalizedHour, minute: normalizedMinute };
};

export const parseDailyReminderRequest = (text: string): { event: string; hour: number; minute: number } | null => {
  const normalized = normalizeFullwidthDigits(text).replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const hasDailyIntent = /(?:每天|每日|每晚|每个?晚上|every day|daily)/i.test(normalized);
  const hasReminderIntent = /(?:提醒|叫|喊)(?:一下)?我|记得|remind me|ping me|tell me/i.test(normalized);
  if (!hasDailyIntent || !hasReminderIntent) return null;

  let hour: number | null = null;
  let minute = 0;
  let timeSegment = '';
  let period = '';

  const zhMatch = normalized.match(/(?:每天|每日|每晚|每个?晚上)[^\d]*?(凌晨|早上|上午|中午|下午|晚上|傍晚)?\s*(\d{1,2})\s*(?:点|:|：)\s*(\d{1,2}|半)?\s*(am|pm)?/iu);
  const enMatch = normalized.match(/(?:every day|daily)(?:\s+at)?\s*(\d{1,2})(?:[:：](\d{1,2}))?\s*(am|pm)?/i);

  if (zhMatch) {
    period = zhMatch[1] || (/^每(?:晚|个?晚上)/u.test(zhMatch[0]) ? '晚上' : '');
    if (zhMatch[4]) period = zhMatch[4].toLowerCase() === 'pm' ? '晚上' : '上午';
    hour = Number(zhMatch[2]);
    minute = zhMatch[3] === '半' ? 30 : zhMatch[3] ? Number(zhMatch[3]) : 0;
    timeSegment = zhMatch[0];
  } else if (enMatch) {
    hour = Number(enMatch[1]);
    minute = Number(enMatch[2] || 0);
    const suffix = (enMatch[3] || '').toLowerCase();
    if (suffix === 'pm' && hour < 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
    timeSegment = enMatch[0];
  } else {
    return null;
  }

  const normalizedTime = normalizeDailyHourMinute(hour ?? -1, minute, period);
  if (!normalizedTime) return null;

  let rawEvent = normalized.replace(timeSegment, '');
  rawEvent = rawEvent
    .replace(/^(?:每天|每日|每晚|每个?晚上|every day|daily)\s*/i, '')
    .replace(/^(?:记得要|记得|提醒|叫|喊)(?:一下)?(?:我)?(?:去|要|该|得)?/u, '')
    .replace(/^(?:remind|ping|tell)(?: me)?(?: to)?\s+/i, '')
    .trim();

  const event = normalizeReminderEvent(rawEvent) || (/[\u4e00-\u9fff]/u.test(normalized) ? '提醒你' : 'remind you');
  if (!event) return null;

  return {
    event,
    hour: normalizedTime.hour,
    minute: normalizedTime.minute,
  };
};

export const getTimePartsInTimezone = (date: Date, timeZone: string) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  });
  const result: Record<string, string> = {};
  formatter.formatToParts(date).forEach(part => {
    result[part.type] = part.value;
  });
  return {
    year: Number(result.year),
    month: Number(result.month),
    day: Number(result.day),
    hour: Number(result.hour),
    minute: Number(result.minute),
    dateKey: `${result.year}-${result.month}-${result.day}`,
  };
};

export const sanitizeRelativeReminderRecord = (record: any): RelativeReminder | null => {
  if (!record || typeof record.event !== 'string' || typeof record.dueAt !== 'number' || typeof record.createdAt !== 'number') {
    return null;
  }

  const event = normalizeReminderEvent(record.event);
  if (!event || !Number.isFinite(record.dueAt) || record.dueAt <= 0) {
    return null;
  }

  return {
    id: typeof record.id === 'string' ? record.id : `${record.createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    event,
    dueAt: record.dueAt,
    lateGraceMinutes: [0, 10, 30, 60].includes(record.lateGraceMinutes) ? record.lateGraceMinutes : undefined,
    version: Number.isSafeInteger(record.version) && record.version >= 0 ? record.version : 0,
    paused: !!record.paused,
    createdAt: record.createdAt,
    timeZone: validReminderTimeZone(record.timeZone),
    sourceText: typeof record.sourceText === 'string' ? record.sourceText : undefined,
    retryAt: typeof record.retryAt === 'number' ? record.retryAt : undefined,
    // v2.14.29 H10: passthrough originalDueAt when the boot rescue
    // re-armed `dueAt`. Validate it's a finite past timestamp; bogus
    // values fall back to undefined (= treat as on-time fire).
    originalDueAt: (typeof record.originalDueAt === 'number' && Number.isFinite(record.originalDueAt) && record.originalDueAt > 0)
      ? record.originalDueAt
      : undefined,
  };
};

// v2.14.29 H10 rework: same shape as MissedReminderRecord; rejects any
// record missing `event`, `originalDueAt`, or `recordedAt`. Backups
// from older builds (which never wrote this key) yield an empty array
// after `.map(sanitize).filter(Boolean)`, which is the correct migration
// behavior — the user simply has no past missed reminders to recall.
export const sanitizeMissedReminderRecord = (record: any): MissedReminderRecord | null => {
  if (!record
      || typeof record.event !== 'string'
      || typeof record.originalDueAt !== 'number'
      || typeof record.recordedAt !== 'number') {
    return null;
  }
  const event = normalizeReminderEvent(record.event);
  if (!event
      || !Number.isFinite(record.originalDueAt)
      || !Number.isFinite(record.recordedAt)) {
    return null;
  }
  return {
    id: typeof record.id === 'string'
      ? record.id
      : `missed-${record.originalDueAt}-${Math.random().toString(36).slice(2, 8)}`,
    event,
    sourceText: typeof record.sourceText === 'string' ? record.sourceText : undefined,
    originalDueAt: record.originalDueAt,
    recordedAt: record.recordedAt,
    ...(Number.isSafeInteger(record.count) && record.count > 0 && Number.isFinite(record.firstDueAt)
      && Number.isFinite(record.lastDueAt) && record.firstDueAt > 0 && record.lastDueAt >= record.firstDueAt
      ? { count: record.count, firstDueAt: record.firstDueAt, lastDueAt: record.lastDueAt,
        timeZone: validReminderTimeZone(record.timeZone) } : {}),
  };
};

export const sanitizeDailyReminderRecord = (record: any): DailyReminder | null => {
  if (!record || typeof record.event !== 'string' || typeof record.hour !== 'number' || typeof record.minute !== 'number' || typeof record.createdAt !== 'number') {
    return null;
  }

  const event = normalizeReminderEvent(record.event);
  if (!event || record.hour < 0 || record.hour > 23 || record.minute < 0 || record.minute > 59) {
    return null;
  }

  return {
    id: typeof record.id === 'string' ? record.id : `${record.createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    event,
    hour: Math.round(record.hour),
    minute: Math.round(record.minute),
    lateGraceMinutes: [0, 10, 30, 60].includes(record.lateGraceMinutes) ? record.lateGraceMinutes : undefined,
    timeZone: typeof record.timeZone === 'string' && record.timeZone.trim() ? record.timeZone : 'Asia/Tokyo',
    createdAt: record.createdAt,
    activeSince: Number.isFinite(record.activeSince) && record.activeSince > 0 ? record.activeSince : undefined,
    paused: !!record.paused,
    lastTriggeredDate: typeof record.lastTriggeredDate === 'string' ? record.lastTriggeredDate : undefined,
    version: Number.isSafeInteger(record.version) && record.version >= 0 ? record.version : 0,
    sourceText: typeof record.sourceText === 'string' ? record.sourceText : undefined,
    retryAt: typeof record.retryAt === 'number' ? record.retryAt : undefined,
  };
};

export const sanitizeWorldCharacterStatusRecord = (value: any): WorldCharacterStatusMap => {
  const fallback = Object.fromEntries(
    Object.entries(INITIAL_WORLD_CHARACTER_STATUS).map(([characterId, status]) => [
      characterId,
      { ...status, aliases: [...status.aliases] },
    ])
  ) as WorldCharacterStatusMap;
  if (!value || typeof value !== 'object') return fallback;

  for (const [characterId, record] of Object.entries(value)) {
    if (!record || typeof record !== 'object') continue;
    const current = fallback[characterId] || {
      aliases: [],
      current_status: '',
      last_major_event: '无',
      current_attitude: '',
    };

    fallback[characterId] = {
      aliases: Array.isArray((record as any).aliases)
        ? (record as any).aliases.filter((alias: unknown): alias is string => typeof alias === 'string' && alias.trim().length > 0)
        : current.aliases,
      current_status: typeof (record as any).current_status === 'string' ? (record as any).current_status : current.current_status,
      last_major_event: typeof (record as any).last_major_event === 'string' ? (record as any).last_major_event : current.last_major_event,
      current_attitude: typeof (record as any).current_attitude === 'string' ? (record as any).current_attitude : current.current_attitude,
      mention_frequency_in_diary: typeof (record as any).mention_frequency_in_diary === 'string'
        ? (record as any).mention_frequency_in_diary
        : current.mention_frequency_in_diary,
    };
  }

  return fallback;
};

export const sanitizeKumikoDiaryRecord = (record: any): KumikoDiaryEntity | null => {
  if (!record || typeof record.date !== 'string' || typeof record.content !== 'string' || typeof record.summary !== 'string') {
    return null;
  }

  return {
    id: typeof record.id === 'string' ? record.id : crypto.randomUUID(),
    date: record.date,
    timestamp: typeof record.timestamp === 'number' ? record.timestamp : Date.now(),
    content: record.content,
    summary: record.summary,
    weather: typeof record.weather === 'string' ? record.weather : undefined,
    holiday: typeof record.holiday === 'string' ? record.holiday : undefined,
  };
};

export const sanitizeDailyFragmentRecord = (record: any): DailyFragmentEntity | null => {
  if (!record || typeof record.date !== 'string' || typeof record.content !== 'string') {
    return null;
  }

  return {
    id: typeof record.id === 'string' ? record.id : crypto.randomUUID(),
    date: record.date,
    timestamp: typeof record.timestamp === 'number' ? record.timestamp : Date.now(),
    content: record.content,
    triggerReason: typeof record.triggerReason === 'string' ? record.triggerReason : 'restore',
  };
};

// v2.14.29 Reactive: clamp + structural validation for the singleton
// `kumikoMood` / `kumikoAffection` rows on backup restore. Both share
// the "current" id; bogus shapes return null so the boot path falls
// back to the service-default state instead of corrupting an existing
// row.
export const sanitizeKumikoMoodRecord = (record: any): KumikoMoodEntity | null => {
  if (!record || typeof record.mood !== 'number' || !Number.isFinite(record.mood)) {
    return null;
  }
  const mood = Math.max(-100, Math.min(100, record.mood));
  return {
    id: typeof record.id === 'string' ? record.id : 'current',
    mood,
    lastUpdated: typeof record.lastUpdated === 'number' ? record.lastUpdated : Date.now(),
    lastDelta: typeof record.lastDelta === 'number' && Number.isFinite(record.lastDelta)
      ? record.lastDelta
      : undefined,
  };
};

export const sanitizeKumikoAffectionRecord = (record: any): KumikoAffectionEntity | null => {
  if (!record || typeof record.score !== 'number' || !Number.isFinite(record.score)) {
    return null;
  }
  const score = Math.max(0, Math.min(100, record.score));
  const weeklyHigh = typeof record.weeklyHigh === 'number' && Number.isFinite(record.weeklyHigh)
    ? Math.max(0, Math.min(100, record.weeklyHigh))
    : score;
  const weeklyLow = typeof record.weeklyLow === 'number' && Number.isFinite(record.weeklyLow)
    ? Math.max(0, Math.min(100, record.weeklyLow))
    : score;
  return {
    id: typeof record.id === 'string' ? record.id : 'current',
    score,
    weeklyHigh,
    weeklyLow,
    lastUpdated: typeof record.lastUpdated === 'number' ? record.lastUpdated : Date.now(),
    lastDelta: typeof record.lastDelta === 'number' && Number.isFinite(record.lastDelta)
      ? record.lastDelta
      : undefined,
  };
};

// v2.14.29 Reactive: keyval-stored block runtime. Same shape as
// busySlotRuntime but lives in `kumiko_block_runtime`. Boot rescue and
// restore paths run the value through this before pushing to the
// store; bogus shapes (or expired-too-long-to-be-meaningful) return
// null so the slice resets to "no active block".
export const sanitizeKumikoBlockRuntime = (record: any): KumikoBlockRuntime | null => {
  if (!record
      || typeof record.activeUntilMs !== 'number'
      || !Number.isFinite(record.activeUntilMs)
      || typeof record.startedAt !== 'number'
      || !Number.isFinite(record.startedAt)) {
    return null;
  }
  const reason = typeof record.reason === 'string' ? record.reason.slice(0, 200) : '';
  const capturedUnreadIds = Array.isArray(record.capturedUnreadIds)
    ? (record.capturedUnreadIds as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  return {
    activeUntilMs: record.activeUntilMs,
    startedAt: record.startedAt,
    reason,
    triggerMessageId: typeof record.triggerMessageId === 'string' ? record.triggerMessageId : undefined,
    capturedUnreadIds,
    expiryAcked: !!record.expiryAcked,
  };
};

export const sanitizePsycheStateRecord = (record: any): PsycheStateEntity | null => {
  if (
    !record
    || typeof record.stress !== 'number'
    || typeof record.energy !== 'number'
    || typeof record.relaxation !== 'number'
  ) {
    return null;
  }

  let driftContext: PsycheStateEntity['driftContext'];
  const rawContext = record.driftContext;
  if (rawContext && typeof rawContext.timezone === 'string') {
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: rawContext.timezone });
      driftContext = { timezone: rawContext.timezone };
      if (typeof rawContext.holidayDate === 'string'
        && /^\d{4}-\d{2}-\d{2}$/.test(rawContext.holidayDate)
        && Number.isFinite(Date.parse(`${rawContext.holidayDate}T00:00:00Z`))
        && new Date(`${rawContext.holidayDate}T00:00:00Z`).toISOString().slice(0, 10) === rawContext.holidayDate
        && typeof rawContext.isHoliday === 'boolean') {
        driftContext.holidayDate = rawContext.holidayDate;
        driftContext.isHoliday = rawContext.isHoliday;
      }
    } catch { /* Invalid persisted timezone must not break future drift. */ }
  }
  const rawDirection = record.lastChatDeltaDirection;
  const lastChatDeltaDirection = rawDirection && ['stress', 'energy', 'relaxation'].every(
    key => typeof rawDirection[key] === 'number' && Number.isFinite(rawDirection[key]),
  ) ? { stress: rawDirection.stress, energy: rawDirection.energy, relaxation: rawDirection.relaxation } : undefined;
  const committedEntries = record.committedResponseEvents;
  const committedResponseEvents = committedEntries && typeof committedEntries === 'object' && !Array.isArray(committedEntries)
    ? Object.fromEntries(Object.entries(committedEntries).flatMap(([eventId, value]) => {
      const event = value as { messageId?: unknown; committedAt?: unknown } | null;
      return eventId.trim() && event && typeof event.messageId === 'string' && event.messageId.trim()
        && typeof event.committedAt === 'number' && Number.isFinite(event.committedAt) && event.committedAt >= 0
        ? [[eventId, { messageId: event.messageId, committedAt: event.committedAt }]] : [];
    })) : undefined;

  return {
    id: typeof record.id === 'string' ? record.id : 'current',
    stress: record.stress,
    energy: record.energy,
    relaxation: record.relaxation,
    lastUpdated: typeof record.lastUpdated === 'number' ? record.lastUpdated : Date.now(),
    lastDriftAt: typeof record.lastDriftAt === 'number' && Number.isFinite(record.lastDriftAt)
      && record.lastDriftAt >= 0 ? record.lastDriftAt : undefined,
    driftContext,
    lastChatDeltaDirection,
    committedResponseEvents,
  };
};

export const sanitizeEpisodeRecord = (record: any): EpisodeEntity | null => {
  if (
    !record
    || typeof record.startMessageId !== 'string'
    || typeof record.endMessageId !== 'string'
    || !Array.isArray(record.messageIds)
    || typeof record.startTimestamp !== 'number'
    || typeof record.endTimestamp !== 'number'
    || typeof record.messageCount !== 'number'
    || typeof record.userMessageCount !== 'number'
    || typeof record.modelMessageCount !== 'number'
    || typeof record.preview !== 'string'
    || typeof record.text !== 'string'
  ) {
    return null;
  }

  const roleScope = record.roleScope === 'user' || record.roleScope === 'model' || record.roleScope === 'mixed'
    ? record.roleScope
    : 'mixed';

  const allowedBoundaryReasons = new Set(['topic_shift', 'wrap_up', 'long_gap', 'window_cap', 'day_split', 'manual']);
  const boundaryReason = typeof record.boundaryReason === 'string' && allowedBoundaryReasons.has(record.boundaryReason)
    ? record.boundaryReason as EpisodeEntity['boundaryReason']
    : undefined;

  return {
    id: typeof record.id === 'string' ? record.id : crypto.randomUUID(),
    startMessageId: record.startMessageId,
    endMessageId: record.endMessageId,
    messageIds: record.messageIds.filter((messageId: unknown): messageId is string => typeof messageId === 'string'),
    startTimestamp: record.startTimestamp,
    endTimestamp: record.endTimestamp,
    messageCount: record.messageCount,
    userMessageCount: record.userMessageCount,
    modelMessageCount: record.modelMessageCount,
    roleScope,
    topicHint: typeof record.topicHint === 'string' ? record.topicHint : undefined,
    preview: record.preview,
    text: record.text,
    boundaryReason,
  };
};

export const sanitizeMessageAlertRecord = (record: any): MissedMessageAlert | null => {
  if (!record || typeof record.messageId !== 'string' || typeof record.preview !== 'string' || typeof record.timestamp !== 'number' || typeof record.kind !== 'string') {
    return null;
  }

  if (!['reply', 'proactive', 'reminder'].includes(record.kind)) {
    return null;
  }

  return {
    id: typeof record.id === 'string' ? record.id : `${record.messageId}-${record.timestamp}`,
    messageId: record.messageId,
    preview: record.preview.trim(),
    timestamp: record.timestamp,
    kind: record.kind as MessageAlertKind,
    isRead: !!record.isRead,
  };
};

const getArrayLengthForBackupLog = (value: unknown) => Array.isArray(value) ? value.length : 0;

export const summarizeBackupPayloadForLog = (backup: any) => {
  const normalizedData =
    backup && typeof backup === 'object' && backup.data && typeof backup.data === 'object'
      ? backup.data
      : backup;
  const topLevelKeys = backup && typeof backup === 'object'
    ? Object.keys(backup as Record<string, unknown>).slice(0, DEV_LOG_MAX_OBJECT_KEYS)
    : [];

  return {
    topLevelKeys,
    messageCount: getArrayLengthForBackupLog(normalizedData?.messages),
    vectorCount: getArrayLengthForBackupLog(backup?.vectors),
    imageCount: getArrayLengthForBackupLog(normalizedData?.images),
    anchorCount: getArrayLengthForBackupLog(normalizedData?.anchors),
    relativeReminderCount: getArrayLengthForBackupLog(normalizedData?.relativeReminders),
    dailyReminderCount: getArrayLengthForBackupLog(normalizedData?.dailyReminders),
    diaryCount: getArrayLengthForBackupLog(normalizedData?.kumikoDiary ?? backup?.kumikoDiary),
    fragmentCount: getArrayLengthForBackupLog(normalizedData?.dailyFragments ?? backup?.dailyFragments),
    episodeCount: getArrayLengthForBackupLog(normalizedData?.episodes ?? backup?.episodes),
    hasWorldCharacterStatus: !!(normalizedData?.worldCharacterStatus ?? backup?.worldCharacterStatus),
    hasPsycheState: !!(normalizedData?.psycheState ?? backup?.psycheState),
  };
};
