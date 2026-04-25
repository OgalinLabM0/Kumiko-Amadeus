import type { Message, MissedMessageAlert, MessageAlertKind } from '../../types';
import {
  INITIAL_WORLD_CHARACTER_STATUS,
  type DailyFragmentEntity,
  type EpisodeEntity,
  type KumikoDiaryEntity,
  type PsycheStateEntity,
  type WorldCharacterStatusMap,
} from '../../services/db';
import { normalizeReminderEvent, type RelativeReminder, type DailyReminder } from '../../store/slices/reminderSlice';
import { DEV_LOG_MAX_OBJECT_KEYS } from './appConstants';

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


export const parseRelativeReminderRequest = (text: string): { event: string; delaySeconds: number } | null => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const hasReminderIntent = /(?:提醒|叫|喊)(?:一下)?我|记得.+(?:提醒|叫|喊)|remind me|ping me|tell me|wake me up/i.test(normalized);
  if (!hasReminderIntent) return null;

  let delaySeconds = 0;
  const zhMatch = normalized.match(/(\d+(?:\.\d+)?)\s*(秒钟?|秒|分钟?|分|小时|钟头|个小时)/u);
  const enMatch = normalized.match(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|sec|minutes?|mins?|min|hours?|hrs?|hour|hr)\b/i);
  const timeMatch = zhMatch || enMatch;

  if (!timeMatch) return null;

  const amount = Number(timeMatch[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = timeMatch[2].toLowerCase();
  if (/^秒/.test(unit) || /^sec/.test(unit) || unit === 's' || /^second/.test(unit)) {
    delaySeconds = Math.round(amount);
  } else if (/^分/.test(unit) || /^min/.test(unit) || /^minute/.test(unit)) {
    delaySeconds = Math.round(amount * 60);
  } else if (/^小/.test(unit) || /钟头/.test(unit) || /^h(?:ou)?r/.test(unit)) {
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

  const event = normalizeReminderEvent(rawEvent);
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
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const hasDailyIntent = /(?:每天|每日|每晚|每个?晚上|every day|daily)/i.test(normalized);
  const hasReminderIntent = /(?:提醒|叫|喊)(?:一下)?我|记得|remind me|ping me|tell me/i.test(normalized);
  if (!hasDailyIntent || !hasReminderIntent) return null;

  let hour: number | null = null;
  let minute = 0;
  let timeSegment = '';
  let period = '';

  const zhMatch = normalized.match(/(?:每天|每日|每晚|每个?晚上)[^\d]*(凌晨|早上|上午|中午|下午|晚上|傍晚)?\s*(\d{1,2})\s*(?:点|:|：)\s*(\d{1,2})?/u);
  const enMatch = normalized.match(/(?:every day|daily)(?:\s+at)?\s*(\d{1,2})[:：](\d{1,2})\s*(am|pm)?/i);

  if (zhMatch) {
    period = zhMatch[1] || '';
    hour = Number(zhMatch[2]);
    minute = zhMatch[3] ? Number(zhMatch[3]) : 0;
    timeSegment = zhMatch[0];
  } else if (enMatch) {
    hour = Number(enMatch[1]);
    minute = Number(enMatch[2]);
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

  const event = normalizeReminderEvent(rawEvent);
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
  if (!event || !Number.isFinite(record.dueAt) || record.dueAt <= Date.now()) {
    return null;
  }

  return {
    id: typeof record.id === 'string' ? record.id : `${record.createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    event,
    dueAt: record.dueAt,
    createdAt: record.createdAt,
    sourceText: typeof record.sourceText === 'string' ? record.sourceText : undefined,
    retryAt: typeof record.retryAt === 'number' ? record.retryAt : undefined,
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
    timeZone: typeof record.timeZone === 'string' && record.timeZone.trim() ? record.timeZone : 'Asia/Tokyo',
    createdAt: record.createdAt,
    paused: !!record.paused,
    lastTriggeredDate: typeof record.lastTriggeredDate === 'string' ? record.lastTriggeredDate : undefined,
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

export const sanitizePsycheStateRecord = (record: any): PsycheStateEntity | null => {
  if (
    !record
    || typeof record.stress !== 'number'
    || typeof record.energy !== 'number'
    || typeof record.relaxation !== 'number'
  ) {
    return null;
  }

  return {
    id: typeof record.id === 'string' ? record.id : 'current',
    stress: record.stress,
    energy: record.energy,
    relaxation: record.relaxation,
    lastUpdated: typeof record.lastUpdated === 'number' ? record.lastUpdated : Date.now(),
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
