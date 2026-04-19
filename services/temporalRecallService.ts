
import { TemporalQueryPrecision, TemporalQuerySource, TemporalQueryDiagnosticsStatus, TemporalQueryConfidence, LocationConfig, Message } from "../types";
import { getCurrentAIConfig, getGenAI } from "./llmCore";
import { callOpenAI, callAnthropic } from "./llmProviderService";
import { resolveTransportProvider } from "./appConfig";

export interface TemporalQueryAnalysis {
  isTemporalQuery: boolean;
  startTimestampJST: number | null;
  endTimestampJST: number | null;
  searchRole: 'user' | 'model' | 'any';
  precision: TemporalQueryPrecision | null;
  source: TemporalQuerySource;
  confidence: TemporalQueryConfidence;
}

export interface TemporalQueryDiagnostics {
  status: TemporalQueryDiagnosticsStatus;
  source: TemporalQuerySource | null;
  precision: TemporalQueryPrecision | null;
  confidence: TemporalQueryConfidence | null;
  errorMessage: string | null;
  outputPreview: string | null;
}

export interface TemporalQueryAnalysisResult {
  analysis: TemporalQueryAnalysis | null;
  diagnostics: TemporalQueryDiagnostics;
}

export type HistoricalQueryRewriteIntent = 'exact' | 'temporal' | 'semantic' | 'topic_search' | 'none';
export type HistoricalSearchStrategy = 'exact_time' | 'temporal_range' | 'topic_search' | 'none';

export interface HistoricalQueryRewrite {
  intent: HistoricalQueryRewriteIntent;
  rewrittenQuery: string;
  searchRole: 'user' | 'model' | 'any';
  precision: TemporalQueryPrecision | null;
  source: 'main_model';
  confidence: TemporalQueryConfidence;
  reason: string | null;
  searchStrategy: HistoricalSearchStrategy;
  searchKeywords: string[];
  topicQuery: string | null;
}

export interface HistoricalQueryRewriteResult {
  rewrite: HistoricalQueryRewrite | null;
  errorMessage: string | null;
  outputPreview: string | null;
}

const MEMORY_HISTORY_TEMPORAL_MARKERS = /(?:昨天|前天|今天|那天|那次|刚才|之前|当时|最开始|一开始|最初|开头|上周|上个月|这些天|最近|近来|这段时间|这几天|这阵子|近几天|过去几天|\d{1,2}\s*月|\d{1,2}\s*[号日]|\d{1,2}\s*点|\d{1,2}\s*分|凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|深夜|yesterday|today|last night|last week|that time|earlier|before|recently|these days|past few days|at \d{1,2}(?::\d{2})?|\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2})/iu;
const MEMORY_HISTORY_RECALL_MARKERS = /(?:记得|还记得|来着|说了什么|聊了什么|提到什么|做什么|什么内容|哪天|什么时候|几点|我说|我发|你说|你发|久美子说|久美子发|我们聊|what did|when did|do you remember|remember when|talked about|said|what was)/iu;
const MEMORY_HISTORY_TOPIC_MARKERS = /(?:关于.{1,10}(?:聊|说|提|讨论|记得|话题)|聊过|说过|讨论过|提到过|谈过|我们.*话题|所有.*聊天|全部.*对话)/iu;

export const isMemoryHistoryQueryLike = (text: string) => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (/(?:最开始|一开始|最初|开头|第一个话题|第一句|第一条)/u.test(normalized) && MEMORY_HISTORY_RECALL_MARKERS.test(normalized)) {
    return true;
  }
  if (/^(?:再试一次|再想想|再确认|可能是|应该是|美国时间(?:的)?|前后(?:\s*\d+\s*分钟?)?|左右|大概|大约|差不多|那时候|那会儿|那段|那次|那话题|那内容|后来呢|然后呢|所以呢)/u.test(normalized)) {
    return true;
  }
  if (MEMORY_HISTORY_TOPIC_MARKERS.test(normalized)) {
    return true;
  }
  return MEMORY_HISTORY_TEMPORAL_MARKERS.test(normalized) && MEMORY_HISTORY_RECALL_MARKERS.test(normalized);
};

const normalizeTemporalQuerySource = (value: unknown, fallback: TemporalQuerySource): TemporalQuerySource => (
  value === 'local_heuristic' || value === 'main_model'
    ? value
    : fallback
);

const inferTemporalQueryPrecision = (
  startTimestampJST: number | null,
  endTimestampJST: number | null
): TemporalQueryPrecision | null => {
  if (!Number.isFinite(startTimestampJST) || !Number.isFinite(endTimestampJST)) {
    return null;
  }

  const spanMs = Math.max(0, (endTimestampJST as number) - (startTimestampJST as number));
  if (spanMs <= 2 * 60 * 1000) return 'exact_minute';
  if (spanMs <= 30 * 60 * 1000) return 'approximate_minutes';
  if (spanMs <= 12 * 60 * 60 * 1000) return 'hour_window';
  return 'day_window';
};

const normalizeTemporalQueryPrecision = (
  value: unknown,
  startTimestampJST: number | null,
  endTimestampJST: number | null
): TemporalQueryPrecision | null => {
  if (
    value === 'exact_minute'
    || value === 'approximate_minutes'
    || value === 'hour_window'
    || value === 'day_window'
  ) {
    return value;
  }
  return inferTemporalQueryPrecision(startTimestampJST, endTimestampJST);
};

const inferTemporalQueryConfidence = (
  source: TemporalQuerySource,
  precision: TemporalQueryPrecision | null
): TemporalQueryConfidence => {
  if (source === 'local_heuristic') {
    return precision === 'day_window' ? 'medium' : 'high';
  }

  if (precision === 'exact_minute' || precision === 'approximate_minutes' || precision === 'hour_window') {
    return 'medium';
  }

  return 'low';
};

const normalizeTemporalQueryConfidence = (
  value: unknown,
  source: TemporalQuerySource,
  precision: TemporalQueryPrecision | null
): TemporalQueryConfidence => (
  value === 'high' || value === 'medium' || value === 'low'
    ? value
    : inferTemporalQueryConfidence(source, precision)
);

const stringifyTemporalAnalysisError = (error: unknown) => {
  if (error instanceof Error) return error.message;
  return String(error);
};

const normalizeHistoricalQueryRewriteIntent = (value: unknown): HistoricalQueryRewriteIntent => (
  value === 'exact' || value === 'temporal' || value === 'semantic' || value === 'topic_search' || value === 'none'
    ? value
    : 'none'
);

const normalizeHistoricalSearchStrategy = (value: unknown): HistoricalSearchStrategy => (
  value === 'exact_time' || value === 'temporal_range' || value === 'topic_search' || value === 'none'
    ? value
    : 'none'
);

const inferSearchStrategyFromIntent = (intent: HistoricalQueryRewriteIntent): HistoricalSearchStrategy => {
  switch (intent) {
    case 'exact': return 'exact_time';
    case 'temporal': return 'temporal_range';
    case 'semantic':
    case 'topic_search': return 'topic_search';
    default: return 'none';
  }
};

const coerceHistoricalQueryRewrite = (candidate: any): HistoricalQueryRewrite | null => {
  if (!candidate || typeof candidate !== 'object') return null;

  const intent = normalizeHistoricalQueryRewriteIntent(candidate.intent);
  const rewrittenQuery = typeof candidate.rewrittenQuery === 'string'
    ? candidate.rewrittenQuery.trim()
    : '';
  const searchRole = candidate.searchRole === 'user' || candidate.searchRole === 'model' || candidate.searchRole === 'any'
    ? candidate.searchRole
    : getTemporalSearchRoleFromQuery(rewrittenQuery);
  const precision = (
    candidate.precision === 'exact_minute'
    || candidate.precision === 'approximate_minutes'
    || candidate.precision === 'hour_window'
    || candidate.precision === 'day_window'
  )
    ? candidate.precision
    : null;
  const confidence = normalizeTemporalQueryConfidence(candidate.confidence, 'main_model', precision);
  const reason = typeof candidate.reason === 'string' && candidate.reason.trim().length > 0
    ? candidate.reason.trim()
    : null;

  const rawStrategy = normalizeHistoricalSearchStrategy(candidate.searchStrategy);
  const searchStrategy: HistoricalSearchStrategy = rawStrategy !== 'none'
    ? rawStrategy
    : inferSearchStrategyFromIntent(intent);
  const searchKeywords: string[] = Array.isArray(candidate.searchKeywords)
    ? candidate.searchKeywords.filter((k: unknown) => typeof k === 'string' && k.trim().length > 0).map((k: string) => k.trim())
    : [];
  const topicQuery: string | null = typeof candidate.topicQuery === 'string' && candidate.topicQuery.trim().length > 0
    ? candidate.topicQuery.trim()
    : null;

  if (intent !== 'none' && !rewrittenQuery) return null;

  return {
    intent,
    rewrittenQuery,
    searchRole,
    precision,
    source: 'main_model',
    confidence,
    reason,
    searchStrategy,
    searchKeywords,
    topicQuery,
  };
};

const parseHistoricalQueryRewrite = (text: string): HistoricalQueryRewrite | null => {
  const normalized = String(text || '').trim();
  if (!normalized) return null;

  const tryParse = (raw: string) => {
    try {
      return coerceHistoricalQueryRewrite(JSON.parse(raw));
    } catch {
      return null;
    }
  };

  const direct = tryParse(normalized);
  if (direct) return direct;

  const objectMatch = normalized.match(/\{[\s\S]*\}/);
  if (!objectMatch) return null;
  return tryParse(objectMatch[0]);
};

const buildTemporalQueryDiagnostics = (
  status: TemporalQueryDiagnosticsStatus,
  analysis: TemporalQueryAnalysis | null,
  errorMessage: string | null = null,
  outputPreview: string | null = null
): TemporalQueryDiagnostics => ({
  status,
  source: analysis?.source ?? null,
  precision: analysis?.precision ?? null,
  confidence: analysis?.confidence ?? null,
  errorMessage,
  outputPreview,
});

const coerceTemporalQueryAnalysis = (
  value: unknown,
  fallbackSource: TemporalQuerySource = 'main_model'
): TemporalQueryAnalysis | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;

  const isTemporalQuery = Boolean(candidate.isTemporalQuery);
  const startTimestampJST =
    typeof candidate.startTimestampJST === 'number' && Number.isFinite(candidate.startTimestampJST)
      ? candidate.startTimestampJST
      : null;
  const endTimestampJST =
    typeof candidate.endTimestampJST === 'number' && Number.isFinite(candidate.endTimestampJST)
      ? candidate.endTimestampJST
      : null;
  const searchRole =
    candidate.searchRole === 'user' || candidate.searchRole === 'model' || candidate.searchRole === 'any'
      ? candidate.searchRole
      : 'any';
  const source = normalizeTemporalQuerySource(candidate.source, fallbackSource);
  const precision = normalizeTemporalQueryPrecision(candidate.precision, startTimestampJST, endTimestampJST);
  const confidence = normalizeTemporalQueryConfidence(candidate.confidence, source, precision);

  if (startTimestampJST !== null && endTimestampJST !== null && startTimestampJST > endTimestampJST) {
    return {
      isTemporalQuery,
      startTimestampJST: endTimestampJST,
      endTimestampJST: startTimestampJST,
      searchRole,
      precision: normalizeTemporalQueryPrecision(candidate.precision, endTimestampJST, startTimestampJST),
      source,
      confidence: normalizeTemporalQueryConfidence(candidate.confidence, source, normalizeTemporalQueryPrecision(candidate.precision, endTimestampJST, startTimestampJST)),
    };
  }

  return {
    isTemporalQuery,
    startTimestampJST,
    endTimestampJST,
    searchRole,
    precision,
    source,
    confidence,
  };
};

const extractJsonObjectFromText = (text: string): string | null => {
  const cleaned = String(text || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  if (!cleaned) return null;

  const firstBrace = cleaned.indexOf('{');
  if (firstBrace === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = firstBrace; index < cleaned.length; index += 1) {
    const char = cleaned[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return cleaned.slice(firstBrace, index + 1);
      }
    }
  }

  return cleaned.slice(firstBrace);
};

const parseTemporalQueryAnalysis = (
  text: string,
  fallbackSource: TemporalQuerySource = 'main_model'
): TemporalQueryAnalysis | null => {
  const extracted = extractJsonObjectFromText(text);
  if (!extracted) return null;

  const attempts = [
    extracted,
    extracted.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']'),
  ];

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      const normalized = coerceTemporalQueryAnalysis(parsed, fallbackSource);
      if (normalized) return normalized;
    } catch {
      // Try the next relaxed parse form.
    }
  }

  return null;
};

type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const getTimeZoneDateParts = (date: Date, timeZone: string): ZonedDateParts => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
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
    second: Number(result.second),
  };
};

const getTimeZoneOffsetMs = (date: Date, timeZone: string) => {
  const zoned = getTimeZoneDateParts(date, timeZone);
  const asUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second);
  return asUtc - date.getTime();
};

const zonedDateTimeToTimestamp = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
) => {
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = targetUtc;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offset = getTimeZoneOffsetMs(new Date(guess), timeZone);
    const next = targetUtc - offset;
    if (Math.abs(next - guess) < 1000) {
      guess = next;
      break;
    }
    guess = next;
  }

  return guess;
};

export const getTemporalSearchRoleFromQuery = (query: string): 'user' | 'model' | 'any' => {
  const normalized = String(query || '').replace(/\s+/g, ' ').trim();
  if (/(?:我|用户)(?:[^。？！,.，\n]{0,32})?(?:说|发|提到|讲)/u.test(normalized)) return 'user';
  if (/(?:你|久美子)(?:[^。？！,.，\n]{0,32})?(?:说|发|提到|讲)/u.test(normalized)) return 'model';
  return 'any';
};

type ParsedClockExpression = {
  period: string | null;
  hour: number;
  minute: number | null;
};

const parseExplicitClockExpression = (text: string): ParsedClockExpression | null => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const pointMatch = normalized.match(/(?:(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|深夜)\s*)?(\d{1,2})\s*(?:点|时)(?:\s*(\d{1,2})\s*分?)?/u);
  if (pointMatch) {
    return {
      period: pointMatch[1] || null,
      hour: Number(pointMatch[2]),
      minute: pointMatch[3] ? Number(pointMatch[3]) : null,
    };
  }

  const colonMatch = normalized.match(/(?:(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|深夜)\s*)?(\d{1,2})\s*[:：]\s*(\d{1,2})/u);
  if (colonMatch) {
    return {
      period: colonMatch[1] || null,
      hour: Number(colonMatch[2]),
      minute: Number(colonMatch[3]),
    };
  }

  return null;
};

const detectChinesePeriodExpression = (text: string): string | null => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const match = normalized.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|深夜)/u);
  return match?.[1] || null;
};

const applyChinesePeriodToHour = (hour: number, period: string | null) => {
  if (!period) return hour;
  if ((period === '下午' || period === '傍晚' || period === '晚上' || period === '夜里' || period === '深夜') && hour < 12) {
    return hour + 12;
  }
  if (period === '中午') {
    if (hour === 0) return 12;
    if (hour >= 1 && hour <= 10) return hour + 12;
    return hour;
  }
  if (period === '凌晨' && hour === 12) return 0;
  return hour;
};

const getDisplayTimeZone = () => {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo';
};

const getUserCharacterTimeZone = (locationConfig?: LocationConfig) => {
  return locationConfig?.userTimezone || getDisplayTimeZone();
};

const resolveTemporalQueryReferenceTimeZone = (query: string, locationConfig?: LocationConfig) => {
  const normalized = String(query || '').replace(/\s+/g, ' ').trim();
  if (/(?:\bJST\b|日本时间|东京时间|Japan Standard Time)/iu.test(normalized)) {
    return 'Asia/Tokyo';
  }
  if (/(?:用户时间|当地时间|美国时间|user time|local time)/iu.test(normalized)) {
    return getUserCharacterTimeZone(locationConfig);
  }
  return getDisplayTimeZone();
};

const buildUserDateRange = (
  year: number,
  month: number,
  day: number,
  startHour: number,
  startMinute: number,
  startSecond: number,
  endHour: number,
  endMinute: number,
  endSecond: number,
  timeZone: string
) => {
  return {
    startTimestampJST: zonedDateTimeToTimestamp(year, month, day, startHour, startMinute, startSecond, timeZone),
    endTimestampJST: zonedDateTimeToTimestamp(year, month, day, endHour, endMinute, endSecond, timeZone),
  };
};

const buildCenterRange = (centerTimestamp: number, deltaMinutes: number) => ({
  startTimestampJST: centerTimestamp - (deltaMinutes * 60 * 1000),
  endTimestampJST: centerTimestamp + (deltaMinutes * 60 * 1000),
});

const buildTemporalQueryAnalysisResult = (
  startTimestampJST: number | null,
  endTimestampJST: number | null,
  searchRole: 'user' | 'model' | 'any',
  precision: TemporalQueryPrecision | null,
  source: TemporalQuerySource
): TemporalQueryAnalysis => ({
  isTemporalQuery: true,
  startTimestampJST,
  endTimestampJST,
  searchRole,
  precision,
  source,
  confidence: normalizeTemporalQueryConfidence(null, source, precision),
});

const CN_MINUTE_MAP: Record<string, number> = {
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
  十: 10,
};

const extractFollowUpMinuteWindow = (text: string): number | null => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const numericMatch = normalized.match(/前后\s*(\d{1,2})\s*分(?:钟)?/u);
  if (numericMatch) {
    return Number(numericMatch[1]);
  }

  const cnMatch = normalized.match(/前后\s*([一二两三四五六七八九十]{1,3})\s*分(?:钟)?/u);
  if (!cnMatch) return null;

  const raw = cnMatch[1];
  if (raw === '十') return 10;
  if (raw.length === 2 && raw.startsWith('十')) {
    return 10 + (CN_MINUTE_MAP[raw[1]] || 0);
  }
  if (raw.length === 2 && raw.endsWith('十')) {
    return (CN_MINUTE_MAP[raw[0]] || 0) * 10;
  }
  if (raw.length === 3 && raw[1] === '十') {
    return ((CN_MINUTE_MAP[raw[0]] || 0) * 10) + (CN_MINUTE_MAP[raw[2]] || 0);
  }
  return CN_MINUTE_MAP[raw] || null;
};

const getPeriodWindow = (period: string | null) => {
  switch (period) {
    case '凌晨':
      return { startHour: 0, startMinute: 0, endHour: 5, endMinute: 59 };
    case '早上':
    case '上午':
      return { startHour: 6, startMinute: 0, endHour: 11, endMinute: 59 };
    case '中午':
      return { startHour: 11, startMinute: 30, endHour: 13, endMinute: 59 };
    case '下午':
    case '傍晚':
      return { startHour: 13, startMinute: 0, endHour: 18, endMinute: 59 };
    case '晚上':
    case '夜里':
    case '深夜':
      return { startHour: 18, startMinute: 0, endHour: 23, endMinute: 59 };
    default:
      return null;
  }
};

const buildHeuristicTemporalQueryAnalysis = (query: string, locationConfig?: LocationConfig): TemporalQueryAnalysis | null => {
  const normalized = String(query || '').replace(/\s+/g, ' ').trim();
  if (!isMemoryHistoryQueryLike(normalized)) return null;

  const userTimeZone = resolveTemporalQueryReferenceTimeZone(normalized, locationConfig);
  const searchRole = getTemporalSearchRoleFromQuery(normalized);
  const now = new Date();
  const userNowParts = getTimeZoneDateParts(now, userTimeZone);
  const approximate = /(?:大约|大概|差不多|左右|around|about|也算|也可以算)/iu.test(normalized);
  const refinementMinutes = extractFollowUpMinuteWindow(normalized);

  const zhDateMatch = normalized.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?/u);
  const isoDateMatch = normalized.match(/(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})/u);
  const dateMatch = zhDateMatch || isoDateMatch;
  const clockExpression = parseExplicitClockExpression(normalized);
  const periodExpression = detectChinesePeriodExpression(normalized);

  if (dateMatch) {
    const year = Number(dateMatch[1] || userNowParts.year);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    const period = clockExpression?.period || periodExpression;
    const rawHour = clockExpression?.hour;
    const rawMinute = clockExpression?.minute;

    if (Number.isFinite(month) && Number.isFinite(day)) {
      if (typeof rawHour === 'number' && Number.isFinite(rawHour)) {
        const hour = applyChinesePeriodToHour(rawHour, period);
        const minute = typeof rawMinute === 'number' && Number.isFinite(rawMinute) ? rawMinute : 0;
        const center = zonedDateTimeToTimestamp(year, month, day, hour, minute, 0, userTimeZone);
        if (typeof rawMinute === 'number' && Number.isFinite(rawMinute)) {
          const minuteWindow = refinementMinutes ?? (approximate ? 5 : null);
          const range = minuteWindow === null
            ? buildUserDateRange(year, month, day, hour, minute, 0, hour, minute, 59, userTimeZone)
            : buildCenterRange(center, minuteWindow);
          return buildTemporalQueryAnalysisResult(
            range.startTimestampJST,
            range.endTimestampJST,
            searchRole,
            minuteWindow === null || minuteWindow <= 1 ? 'exact_minute' : 'approximate_minutes',
            'local_heuristic'
          );
        }

        if (refinementMinutes !== null || approximate) {
          const range = buildCenterRange(center, refinementMinutes ?? 15);
          return buildTemporalQueryAnalysisResult(
            range.startTimestampJST,
            range.endTimestampJST,
            searchRole,
            'approximate_minutes',
            'local_heuristic'
          );
        }

        const range = buildUserDateRange(year, month, day, hour, 0, 0, hour, 59, 59, userTimeZone);
        return buildTemporalQueryAnalysisResult(
          range.startTimestampJST,
          range.endTimestampJST,
          searchRole,
          'hour_window',
          'local_heuristic'
        );
      }

      const periodWindow = getPeriodWindow(period);
      const range = periodWindow
        ? buildUserDateRange(year, month, day, periodWindow.startHour, periodWindow.startMinute, 0, periodWindow.endHour, periodWindow.endMinute, 59, userTimeZone)
        : buildUserDateRange(year, month, day, 0, 0, 0, 23, 59, 59, userTimeZone);
      return buildTemporalQueryAnalysisResult(
        range.startTimestampJST,
        range.endTimestampJST,
        searchRole,
        periodWindow ? 'hour_window' : 'day_window',
        'local_heuristic'
      );
    }
  }

  let dayOffset: number | null = null;
  if (/(?:昨天|yesterday|last night)/iu.test(normalized)) dayOffset = -1;
  else if (/前天/iu.test(normalized)) dayOffset = -2;
  else if (/(?:今天|today|刚才|earlier)/iu.test(normalized)) dayOffset = 0;

  if (dayOffset !== null) {
    const userRef = new Date(now.getTime() + (dayOffset * 24 * 60 * 60 * 1000));
    const userRefParts = getTimeZoneDateParts(userRef, userTimeZone);
    const period = clockExpression?.period || periodExpression;
    const rawHour = clockExpression?.hour;
    const rawMinute = clockExpression?.minute;

    if (typeof rawHour === 'number' && Number.isFinite(rawHour)) {
      const hour = applyChinesePeriodToHour(rawHour, period);
      const minute = typeof rawMinute === 'number' && Number.isFinite(rawMinute) ? rawMinute : 0;
      const center = zonedDateTimeToTimestamp(userRefParts.year, userRefParts.month, userRefParts.day, hour, minute, 0, userTimeZone);
      if (typeof rawMinute === 'number' && Number.isFinite(rawMinute)) {
        const minuteWindow = refinementMinutes ?? (approximate ? 5 : null);
        const range = minuteWindow === null
          ? buildUserDateRange(userRefParts.year, userRefParts.month, userRefParts.day, hour, minute, 0, hour, minute, 59, userTimeZone)
          : buildCenterRange(center, minuteWindow);
        return buildTemporalQueryAnalysisResult(
          range.startTimestampJST,
          range.endTimestampJST,
          searchRole,
          minuteWindow === null || minuteWindow <= 1 ? 'exact_minute' : 'approximate_minutes',
          'local_heuristic'
        );
      }

      if (refinementMinutes !== null || approximate) {
        const range = buildCenterRange(center, refinementMinutes ?? 15);
        return buildTemporalQueryAnalysisResult(
          range.startTimestampJST,
          range.endTimestampJST,
          searchRole,
          'approximate_minutes',
          'local_heuristic'
        );
      }

      const range = buildUserDateRange(userRefParts.year, userRefParts.month, userRefParts.day, hour, 0, 0, hour, 59, 59, userTimeZone);
      return buildTemporalQueryAnalysisResult(
        range.startTimestampJST,
        range.endTimestampJST,
        searchRole,
        'hour_window',
        'local_heuristic'
      );
    }

    const periodWindow = getPeriodWindow(period);
    const range = periodWindow
      ? buildUserDateRange(userRefParts.year, userRefParts.month, userRefParts.day, periodWindow.startHour, periodWindow.startMinute, 0, periodWindow.endHour, periodWindow.endMinute, 59, userTimeZone)
      : buildUserDateRange(userRefParts.year, userRefParts.month, userRefParts.day, 0, 0, 0, 23, 59, 59, userTimeZone);
    return buildTemporalQueryAnalysisResult(
      range.startTimestampJST,
      range.endTimestampJST,
      searchRole,
      periodWindow ? 'hour_window' : 'day_window',
      'local_heuristic'
    );
  }

  return null;
};

export const analyzeTemporalQueryDetailed = async (query: string, locationConfig?: LocationConfig): Promise<TemporalQueryAnalysisResult> => {
  const heuristicResult = buildHeuristicTemporalQueryAnalysis(query, locationConfig);
  if (heuristicResult) {
      console.log("[Temporal Intent] Using local heuristic parser.", heuristicResult);
      return {
        analysis: heuristicResult,
        diagnostics: buildTemporalQueryDiagnostics('heuristic_success', heuristicResult),
      };
  }

  let rawModelOutput = "";
  try {
      const config = getCurrentAIConfig();
      const provider = config.provider || 'gemini';
      const transportProvider = resolveTransportProvider(provider, config.useCustomEndpoint ? config.customEndpoint : undefined);
      
      const now = new Date();
      let jstTime = "??:??";
      try {
          jstTime = now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
      } catch(e) {}
      
      let userTime = "??:??";
      if (locationConfig?.userTimezone) {
          try {
             userTime = now.toLocaleString('en-US', { timeZone: locationConfig.userTimezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
          } catch(e) {}
      }

      const prompt = `
You are an intent parser. Your job is to extract temporal boundaries from a user's conversational query.

[CURRENT TIME REFERENCE]
Current JST (Japan Standard Time): ${jstTime}
Current User Time: ${userTime}
Default rule: interpret the user's query in the user's timezone and convert the computed boundaries into JST (Japan Standard Time) timestamps.
Override rule: if the query explicitly says JST / Japan time / 日本时间 / 东京时间, treat the stated time as already being in JST and DO NOT convert it from the user's timezone again.

[USER QUERY]
"${query}"

[RULES]
1. Determine if the user is asking about a past conversation (e.g., "What did we talk about yesterday?", "What did I say on March 17th?").
2. If YES, set isTemporalQuery = true. If NO, set isTemporalQuery = false.
3. If a specific time block is implied (e.g., "yesterday", "March 17th at 10pm"), calculate the startTimestampJST and endTimestampJST covering that block in milliseconds. 
4. If it's a general past request, you may set timestamps to null.
5. searchRole: Determine who the user is asking about. "What did *I* say" -> 'user'. "What did *you* say" -> 'model'. "What did *we* talk about" -> 'any'.
6. precision: classify the result window as one of:
   - "exact_minute"
   - "approximate_minutes"
   - "hour_window"
   - "day_window"
7. source: always set to "main_model".
8. confidence: set:
   - "medium" for specific minute/hour style windows
   - "low" for vague day-wide windows

You MUST output ONLY valid JSON matching this schema exactly:
{
  "isTemporalQuery": boolean,
  "startTimestampJST": number | null,
  "endTimestampJST": number | null,
  "searchRole": "user" | "model" | "any",
  "precision": "exact_minute" | "approximate_minutes" | "hour_window" | "day_window" | null,
  "source": "main_model",
  "confidence": "high" | "medium" | "low"
}
`;

      let modelName = config.model_main || 'gemini-2.5-flash'; // Enforcing use of the MAIN model as requested by user

      let text = "";
      if (transportProvider === 'openai' || transportProvider === 'deepseek' || transportProvider === 'grok' || transportProvider === 'openrouter') {
          const result = await callOpenAI(config, modelName, "You are an AI Text-to-SQL Intent Parser. Output pure JSON.", [], prompt);
          text = result.text || "";
      } else if (transportProvider === 'anthropic') {
          const result = await callAnthropic(config, modelName, "You are an AI Text-to-SQL Intent Parser. Output pure JSON.", [], prompt);
          text = result.text || "";
      } else {
          const ai = getGenAI();
          const result = await ai.models.generateContent({
            model: modelName, 
            contents: prompt,
            config: { responseMimeType: 'application/json' }
          });
          text = result.text || "";
      }
      rawModelOutput = text;
      const parsed = parseTemporalQueryAnalysis(text, 'main_model');
      if (!parsed) {
        throw new SyntaxError(`Unable to parse temporal intent JSON: ${text.slice(0, 200)}`);
      }
      return {
        analysis: parsed,
        diagnostics: buildTemporalQueryDiagnostics('main_model_success', parsed, null, text.slice(0, 200) || null),
      };
  } catch (e) {
      const fallback = buildHeuristicTemporalQueryAnalysis(query, locationConfig);
      if (fallback) {
          console.warn("[Temporal Intent] Main-model parsing failed; using local heuristic fallback.", e);
          return {
            analysis: fallback,
            diagnostics: buildTemporalQueryDiagnostics(
              'heuristic_fallback_after_model_failure',
              fallback,
              stringifyTemporalAnalysisError(e),
              rawModelOutput.slice(0, 200) || null
            ),
          };
      }
      console.warn("[Temporal Intent] Parsing failed using main model:", e);
      const errorMessage = stringifyTemporalAnalysisError(e);
      return {
        analysis: null,
        diagnostics: buildTemporalQueryDiagnostics(
          e instanceof SyntaxError ? 'main_model_parse_failed' : 'main_model_error',
          null,
          errorMessage,
          rawModelOutput.slice(0, 200) || null
        ),
      };
  }
};

export const rewriteHistoricalRecallQueryDetailed = async (
  query: string,
  locationConfig?: LocationConfig,
  options?: { bypassGate?: boolean; recentMessages?: Message[] }
): Promise<HistoricalQueryRewriteResult> => {
  const normalized = String(query || '').replace(/\s+/g, ' ').trim();
  if (!options?.bypassGate && !isMemoryHistoryQueryLike(normalized)) {
    return {
      rewrite: null,
      errorMessage: null,
      outputPreview: null,
    };
  }

  let rawModelOutput = "";
  try {
    const config = getCurrentAIConfig();
    const provider = config.provider || 'gemini';
    const transportProvider = resolveTransportProvider(provider, config.useCustomEndpoint ? config.customEndpoint : undefined);
    const modelName = config.model_main || 'gemini-2.5-flash';
    const now = new Date();
    const displayTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo';
    const characterTimeZone = locationConfig?.userTimezone || displayTimeZone;
    const modelTimeZone = locationConfig?.modelTimezone || 'Asia/Tokyo';

    let jstTime = "??:??";
    let displayTime = "??:??";
    let characterTime = "??:??";
    try {
      jstTime = now.toLocaleString('en-US', {
        timeZone: modelTimeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
    } catch {}
    try {
      displayTime = now.toLocaleString('en-US', {
        timeZone: displayTimeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
    } catch {}
    try {
      characterTime = now.toLocaleString('en-US', {
        timeZone: characterTimeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
    } catch {}

    let recentContextStr = "None provided.";
    if (options?.recentMessages && options.recentMessages.length > 0) {
      recentContextStr = options.recentMessages.map(m => `${m.role === 'user' ? 'User' : 'Kumiko'}: ${m.text}`).join('\n');
    }

    const prompt = `
You are a query rewriter for a local chat-history retrieval system.
Your job is NOT to answer the user. Your only job is to transform a natural-language memory question into a structured retrieval command that search code can parse reliably.

[CURRENT TIME REFERENCE]
Current Kumiko/JST Time: ${jstTime}
Current Display Time (user's screen clock): ${displayTime}
Display Timezone: ${displayTimeZone}
User Character Timezone: ${characterTimeZone}
Current Character Time: ${characterTime}
Kumiko Timezone: ${modelTimeZone}

[RECENT CONVERSATION CONTEXT]
${recentContextStr}

[INPUT QUERY]
"${normalized}"

[OUTPUT JSON SCHEMA]
{
  "intent": "exact" | "temporal" | "semantic" | "topic_search" | "none",
  "searchStrategy": "exact_time" | "temporal_range" | "topic_search" | "none",
  "rewrittenQuery": string,
  "searchRole": "user" | "model" | "any",
  "precision": "exact_minute" | "approximate_minutes" | "hour_window" | "day_window" | null,
  "confidence": "high" | "medium" | "low",
  "reason": string | null,
  "searchKeywords": string[],
  "topicQuery": string | null
}

[RULES]
1. Output ONLY valid JSON.
2. rewrittenQuery MUST always use a canonical Chinese retrieval format, even if the input question is colloquial.
3. If the user asks for exact wording at a precise time ("我说了什么", "你说了什么"), set intent to "exact" and searchStrategy to "exact_time".
4. If the user asks what happened or what was discussed in a broader time range, set intent to "temporal" and searchStrategy to "temporal_range".
5. If the user asks about a remembered topic/theme rather than a time-pinned quote, set intent to "semantic" and searchStrategy to "topic_search".
6. If the user asks about a specific entity, person, or topic across conversations (e.g. "关于丽奈", "我们聊过的X话题"), set intent to "topic_search" and searchStrategy to "topic_search".
7. Preserve speaker faithfully:
   - "我说了什么" => searchRole "user"
   - "你说了什么" => searchRole "model"
   - "我们聊了什么" => searchRole "any"
8. CRITICAL TIMEZONE RULE: The app shows timestamps in TWO places — chat bubbles use Display Timezone (${displayTimeZone}), while the memory/context editor uses JST (Asia/Tokyo). When the user references a time, they could be reading EITHER. Because the retrieval system searches a wide window (±30 min) around the target, use the MOST LIKELY interpretation: if Display Timezone and JST differ by ≤1 hour, just output the time as JST directly (the wide window covers the gap). If they differ by more, convert from Display Timezone to JST. Do NOT use the User Character Timezone for this conversion.
9. If the query explicitly mentions Japan time / JST / 日本時間, keep it in JST.
10. Do not invent content. Only normalize intent, speaker, time range, timezone conversion, and extract keywords.
11. Preferred rewrittenQuery patterns:
   - exact minute: "2026年3月18日 10:15 JST 我说了什么"
   - exact hour: "2026年3月18日 10点 JST 我们聊了什么"
   - nearby window: "2026年3月18日 10:15 JST 前后5分钟 我们聊了什么"
   - semantic recall: "回忆检索 3月18日 那次关于X的对话内容"
   - topic search: "回忆检索 关于丽奈的所有对话内容"
12. searchKeywords: Extract the core entity names, person names, or topic keywords from the query. Include ALL name variants the user might use (short name, full name, alternate spellings). For example, if the user mentions "丽奈", include ["丽奈", "高坂丽奈"]. For non-topic queries, set to [].
13. topicQuery: For topic_search, write a clear embedding-friendly retrieval query describing what to search for (e.g. "关于高坂丽奈的对话内容"). For non-topic queries, set to null.
14. For follow-up queries referencing a previous topic (e.g. "这些天来" after asking about a topic, "不只是那一天", "之前聊的啥", "那校园祭那天呢"), infer the topic or time anchor from the [RECENT CONVERSATION CONTEXT].
    - Pronoun/Omission Resolution: If the query uses pronouns ("他", "那个") or omits the subject ("之前聊的啥", "刚才说的"), resolve it using the recent context (e.g., rewrite to "关于秀一的对话内容").
    - Relative Time Resolution: If the query uses relative time ("那之前呢", "后来呢") anchored to a recently mentioned event (e.g., "校园祭"), resolve it (e.g., rewrite to "校园祭之前发生的事").
15. If there is not enough information to improve the query, keep rewrittenQuery close to the original meaning but still make it more canonical. Set searchStrategy to "none" only if the query has NOTHING to do with recalling past conversations.
`;

    const callRewrite = async (model: string): Promise<string> => {
      if (transportProvider === 'openai' || transportProvider === 'deepseek' || transportProvider === 'grok' || transportProvider === 'openrouter') {
        const result = await callOpenAI(config, model, "You rewrite history queries and output pure JSON.", [], prompt);
        return result.text || "";
      } else if (transportProvider === 'anthropic') {
        const result = await callAnthropic(config, model, "You rewrite history queries and output pure JSON.", [], prompt);
        return result.text || "";
      } else {
        const ai = getGenAI();
        const result = await ai.models.generateContent({
          model,
          contents: prompt,
          config: { responseMimeType: 'application/json' }
        });
        return result.text || "";
      }
    };

    let text = "";
    try {
      text = await callRewrite(modelName);
    } catch (mainError) {
      console.warn('[HISTORICAL QUERY REWRITE] Main model failed, retrying...', mainError);
      try {
        text = await callRewrite(modelName);
      } catch (retryError) {
        const fallbackModel = config.model_summary;
        if (fallbackModel && fallbackModel !== modelName) {
          console.warn('[HISTORICAL QUERY REWRITE] Retry failed, falling back to summary model:', fallbackModel);
          text = await callRewrite(fallbackModel);
        } else {
          throw retryError;
        }
      }
    }

    rawModelOutput = text;
    const parsed = parseHistoricalQueryRewrite(text);
    if (!parsed) {
      throw new SyntaxError(`Unable to parse historical rewrite JSON: ${text.slice(0, 200)}`);
    }

    console.log('[HISTORICAL QUERY REWRITE]', {
      intent: parsed.intent,
      searchStrategy: parsed.searchStrategy,
      searchRole: parsed.searchRole,
      precision: parsed.precision,
      confidence: parsed.confidence,
      rewrittenQuery: parsed.rewrittenQuery,
      searchKeywords: parsed.searchKeywords,
      topicQuery: parsed.topicQuery,
      reason: parsed.reason,
    });

    return {
      rewrite: parsed,
      errorMessage: null,
      outputPreview: text.slice(0, 200) || null,
    };
  } catch (error) {
    console.warn('[HISTORICAL QUERY REWRITE] All rewrite attempts failed.', error);
    return {
      rewrite: null,
      errorMessage: stringifyTemporalAnalysisError(error),
      outputPreview: rawModelOutput.slice(0, 200) || null,
    };
  }
};
