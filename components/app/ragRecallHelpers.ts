import type {
  Message,
  MemoryQuerySession,
  TemporalQueryPrecision,
  TemporalQuerySource,
  TemporalQueryDiagnosticsStatus,
  TemporalQueryConfidence,
} from '../../types';
import type { EpisodeEntity } from '../../services/db';
import type {
  TemporalQueryAnalysis,
  TemporalQueryDiagnostics,
  HistoricalQueryRewrite,
} from '../../services/geminiService';
import type { LocalRagEntryKind, LocalRagEvidenceStrength } from '../../services/localRagService';
import { formatJstTimeForRag, getJstDateParts } from './messageMappers';
import {
  EXACT_LOOKUP_NEARBY_WINDOW_MS,
  EXACT_LOOKUP_TEMPORAL_SUMMARY_WINDOW_MS,
  EXACT_LOOKUP_TEMPORAL_SUMMARY_MAX_MESSAGES,
  EXACT_LOOKUP_CONTEXT_EXPAND_BEFORE,
  EXACT_LOOKUP_CONTEXT_EXPAND_AFTER,
  HISTORICAL_QUERY_SESSION_MAX_IDLE_MS,
  REBUILD_FRAGMENT_MAX_CHAR_LENGTH,
  REBUILD_FRAGMENT_BLOCK_PATTERNS,
} from './appConstants';

export type ExactHistoryLookupRole = 'user' | 'model' | 'any';
export type ExactHistoryLookupRequest = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  targetRole: ExactHistoryLookupRole;
};
export type MemoryEvidenceAnswerMode = 'quote_first' | 'temporal_summary_with_support' | 'thematic_summary_with_support' | 'summary_only';
export type MemoryEvidenceResponseStrategy =
  | 'quote_direct_if_supported'
  | 'summarize_temporal_then_support'
  | 'summarize_theme_then_support'
  | 'summary_only_cautious'
  | 'acknowledge_no_evidence';

export type MemoryEvidenceStrength = 'strong' | 'medium' | 'weak' | 'none';
export type MemoryEvidenceCertainty = 'high' | 'medium' | 'low';
export type MemoryResponseRouteBoundary =
  | 'exact_evidence_only'
  | 'temporal_summary_or_supported_quote'
  | 'semantic_summary_or_supported_quote';
export type MemoryResponsePreferredLead =
  | 'direct_recall'
  | 'exact_cautious'
  | 'temporal_summary'
  | 'semantic_summary'
  | 'admit_missing_evidence';
export type MemoryResponseAllowance = 'yes' | 'no';
export type MemoryResponseConflictFlag =
  | 'speaker_uncertain'
  | 'time_uncertain'
  | 'weak_evidence'
  | 'quote_restricted'
  | 'mixed_evidence';

export type HistoryLookupResult = {
  promptBlock: string;
  found: boolean;
  strict: boolean;
  mode: 'session_start' | 'exact_timestamp' | 'temporal_window';
  targetSpeaker: 'User' | 'Kumiko' | 'Any';
  rangeJst?: string;
  parserStatus?: TemporalQueryDiagnosticsStatus | null;
  parserSource?: TemporalQuerySource | null;
  parserPrecision?: TemporalQueryPrecision | null;
  parserConfidence?: TemporalQueryConfidence | null;
  matchedCount: number;
  evidenceMode?: 'raw_messages' | 'episodes' | 'none';
  confidenceLevel?: 'high' | 'medium' | 'low';
  rawSupportCount?: number;
  evidenceStrengthSummary?: string;
  quoteSafeKinds?: string;
  evidenceSectionCount?: number;
  primaryEvidenceKind?: string;
  entryMixSummary?: string;
  answerMode?: MemoryEvidenceAnswerMode;
  responseStrategy?: MemoryEvidenceResponseStrategy;
};

export type HistoricalRecallContextResolution = {
  queryText: string;
  source: 'self' | 'session' | 'recent_user';
  usedSession: boolean;
  previousQueryPreview: string | null;
  sessionReuseBlockedReason?: 'unstable_temporal_session' | null;
};

export type HistoricalQueryIntent = 'exact' | 'temporal' | 'semantic' | 'none';

export const detectExplicitHistoryTargetRole = (normalizedText: string): ExactHistoryLookupRole => {
  if (/(?:我|用户)(?:[^。？！,.，\n]{0,32})?(?:说|发|提到|讲)/u.test(normalizedText)) return 'user';
  if (/(?:你|久美子)(?:[^。？！,.，\n]{0,32})?(?:说|发|提到|讲)/u.test(normalizedText)) return 'model';
  return 'any';
};

export const parseExactHistoryLookupRequest = (text: string): ExactHistoryLookupRequest | null => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const asksForQuotedRecall = /(?:我说|你说|久美子说|谁说|当时说了什么|说了什么|说的内容|那句|那条|几点|几分|几号|几月|什么时候|发了什么|聊了什么|讲了什么)/u.test(normalized);
  if (!asksForQuotedRecall) return null;

  const zhMatch = normalized.match(/(?:(\d{4})\s*[\/年.-])?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?(?:\s*的)?\s*(\d{1,2})\s*(?:[:：点时])(?:\s*(\d{1,2})\s*分?)?/u);
  const isoMatch = normalized.match(/(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})\s+(\d{1,2})(?:[:：](\d{1,2}))?/u);
  const match = zhMatch || isoMatch;
  if (!match) return null;

  const now = new Date();
  const year = Number(match[1] || now.getFullYear());
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = match[5] ? Number(match[5]) : -1;
  if (![year, month, day, hour].every(Number.isFinite)) return null;

  const targetRole = detectExplicitHistoryTargetRole(normalized);

  return { year, month, day, hour, minute, targetRole };
};

export const parseSessionStartLookupRequest = (text: string) => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const startPatterns = /(?:一开始|最开始|最初|最早|刚开始|开头|最开头|第一句|起初|第一个|上一(?:次|个)|第一条)/u;
  const recallPatterns = /(?:我说|你说|久美子说|跟你说|告诉你|聊什么|说了什么|提到什么|在做什么|做什么|最开始的聊天|开场|话题|内容|句子)/u;
  if (!startPatterns.test(normalized) || !recallPatterns.test(normalized)) {
    return null;
  }

  const targetRole = detectExplicitHistoryTargetRole(normalized);

  return { targetRole };
};

const toJstQueryTimestampMs = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
) => Date.UTC(year, month - 1, day, hour - 9, minute, 0, 0);

const formatExactHistoryLookupTargetJst = (request: ExactHistoryLookupRequest) => (
  `${request.year}/${String(request.month).padStart(2, '0')}/${String(request.day).padStart(2, '0')} ${String(request.hour).padStart(2, '0')}${request.minute !== -1 ? `:${String(request.minute).padStart(2, '0')}` : ''}`
);

const getExactHistoryTargetTimestampMs = (request: ExactHistoryLookupRequest) => (
  request.minute === -1
    ? null
    : toJstQueryTimestampMs(
        request.year,
        request.month,
        request.day,
        request.hour,
        request.minute
      )
);

const getExactHistoryWindowMatches = (
  messages: Message[],
  request: ExactHistoryLookupRequest,
  options: {
    windowMs: number;
    limit?: number;
  }
) => {
  const targetTimestamp = getExactHistoryTargetTimestampMs(request);
  if (targetTimestamp === null) {
    return {
      matches: [] as Message[],
      targetTimestamp: null,
      nearestDeltaSeconds: null,
    };
  }

  const matches = messages
    .filter(message => Math.abs(message.timestamp - targetTimestamp) <= options.windowMs)
    .filter(message => request.targetRole === 'any' || message.role === request.targetRole)
    .sort((a, b) => {
      const aDelta = Math.abs(a.timestamp - targetTimestamp);
      const bDelta = Math.abs(b.timestamp - targetTimestamp);
      if (aDelta !== bDelta) return aDelta - bDelta;
      return a.timestamp - b.timestamp;
    });

  const limitedMatches = typeof options.limit === 'number'
    ? matches.slice(0, options.limit)
    : matches;
  const chronologicalMatches = [...limitedMatches].sort((a, b) => a.timestamp - b.timestamp);

  return {
    matches: chronologicalMatches,
    targetTimestamp,
    nearestDeltaSeconds: limitedMatches.length > 0
      ? Math.round(Math.abs(limitedMatches[0].timestamp - targetTimestamp) / 1000)
      : null,
  };
};

const findNearbyExactTargetSpeakerMatches = (
  messages: Message[],
  request: ExactHistoryLookupRequest
) => getExactHistoryWindowMatches(messages, request, {
  windowMs: EXACT_LOOKUP_NEARBY_WINDOW_MS,
  limit: 3,
});

const findExactTemporalSummarySupportMatches = (
  messages: Message[],
  request: ExactHistoryLookupRequest
) => getExactHistoryWindowMatches(messages, request, {
  windowMs: EXACT_LOOKUP_TEMPORAL_SUMMARY_WINDOW_MS,
  limit: EXACT_LOOKUP_TEMPORAL_SUMMARY_MAX_MESSAGES,
});

const expandMatchesWithContext = (
  allSortedMessages: Message[],
  matchedMessages: Message[],
  contextBefore = EXACT_LOOKUP_CONTEXT_EXPAND_BEFORE,
  contextAfter = EXACT_LOOKUP_CONTEXT_EXPAND_AFTER
): Message[] => {
  if (matchedMessages.length === 0 || allSortedMessages.length === 0) return matchedMessages;
  const includedIds = new Set<string>();
  const result: Message[] = [];
  const matchIds = new Set(matchedMessages.map(m => m.id));

  for (const match of matchedMessages) {
    const idx = allSortedMessages.findIndex(m => m.id === match.id);
    if (idx === -1) continue;
    const start = Math.max(0, idx - contextBefore);
    const end = Math.min(allSortedMessages.length - 1, idx + contextAfter);
    for (let i = start; i <= end; i++) {
      const msg = allSortedMessages[i];
      if (!includedIds.has(msg.id)) {
        includedIds.add(msg.id);
        result.push(msg);
      }
    }
  }

  return result.sort((a, b) => a.timestamp - b.timestamp);
};

const formatExactHistoryMessageLine = (message: Message, isClosestMatch = false) => {
  const parts = getJstDateParts(message.timestamp);
  const roleLabel = message.role === 'user' ? 'User' : 'Kumiko';
  const marker = isClosestMatch ? ' <<< CLOSEST' : '';
  return `[${parts.year}/${String(parts.month).padStart(2, '0')}/${String(parts.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')} JST] ${roleLabel}: ${message.text}${marker}`;
};

const findWideTemporalContextMatches = (
  messages: Message[],
  request: ExactHistoryLookupRequest
) => {
  const targetTimestamp = getExactHistoryTargetTimestampMs(request);
  if (targetTimestamp === null) {
    return { matches: [] as Message[], targetTimestamp: null, nearestDeltaSeconds: null, closestMatchId: null as string | null };
  }

  const anyRoleRequest = { ...request, targetRole: 'any' as const };
  const windowResult = getExactHistoryWindowMatches(messages, anyRoleRequest, {
    windowMs: EXACT_LOOKUP_TEMPORAL_SUMMARY_WINDOW_MS,
    limit: EXACT_LOOKUP_TEMPORAL_SUMMARY_MAX_MESSAGES,
  });

  let closestMatchId: string | null = null;
  if (windowResult.matches.length > 0) {
    const sorted = [...windowResult.matches].sort((a, b) =>
      Math.abs(a.timestamp - targetTimestamp) - Math.abs(b.timestamp - targetTimestamp)
    );
    const speakerFiltered = request.targetRole === 'any'
      ? sorted
      : sorted.filter(m => m.role === request.targetRole);
    closestMatchId = (speakerFiltered[0] || sorted[0])?.id ?? null;
  }

  const expanded = expandMatchesWithContext(messages, windowResult.matches);
  return {
    matches: expanded,
    targetTimestamp,
    nearestDeltaSeconds: windowResult.nearestDeltaSeconds,
    closestMatchId,
  };
};

export const isLikelySemanticRecallQuery = (text: string) => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (parseExactHistoryLookupRequest(normalized) || parseSessionStartLookupRequest(normalized)) return false;
  if (isLikelyTemporalHistoryQuery(normalized) || isLikelyHistoricalRecallQuery(normalized)) return false;

  const semanticRecallMarkers = /(?:记得|还记得|那次|那回|那件事|当时那个|聊过|提到过|说过|之前说的|你还记得|remember|remembered|talked about|brought up|that time)/iu;
  return semanticRecallMarkers.test(normalized);
};

export const resolveHistoricalQueryIntent = (
  currentText: string,
  contextualText: string,
  session: MemoryQuerySession | null
): HistoricalQueryIntent => {
  const normalizedCurrent = currentText.replace(/\s+/g, ' ').trim();
  const normalizedContext = contextualText.replace(/\s+/g, ' ').trim();

  if (parseExactHistoryLookupRequest(normalizedContext) || parseSessionStartLookupRequest(normalizedContext)) {
    return 'exact';
  }

  const sessionActive = isMemoryQuerySessionActive(session);
  if (sessionActive && (isLikelyHistoricalFollowUp(normalizedCurrent) || isLikelyHistoricalSessionCarry(normalizedCurrent))) {
    if (session.kind === 'topic_search') return 'semantic';
    return session.kind === 'exact_history' ? 'exact' : 'temporal';
  }

  if (isLikelyTemporalHistoryQuery(normalizedContext) || isLikelyHistoricalRecallQuery(normalizedContext)) {
    return 'temporal';
  }

  if (isLikelySemanticRecallQuery(normalizedContext)) {
    return 'semantic';
  }

  return 'none';
};

export const mapHistoricalRewriteIntent = (
  intent: HistoricalQueryRewrite['intent'] | null | undefined
): HistoricalQueryIntent | null => {
  if (intent === 'exact' || intent === 'temporal' || intent === 'semantic') return intent;
  if (intent === 'topic_search') return 'semantic';
  return null;
};

const buildMemoryNoEvidenceDecisionHeader = (
  confidenceLevel: 'high' | 'medium' | 'low' = 'low',
  responseStrategy: MemoryEvidenceResponseStrategy = 'acknowledge_no_evidence'
) => `[MEMORY_EVIDENCE_DECISION]
Response_Style: ${responseStrategy === 'summary_only_cautious' ? 'summary_only' : 'acknowledge_no_evidence'}
Response_Strategy: ${responseStrategy}
Quote_Policy: no_direct_quotes
Confidence_Level: ${confidenceLevel}`;

const getNoEvidenceResponseStrategy = (
  parserStatus?: TemporalQueryDiagnosticsStatus | null,
  parserConfidence?: TemporalQueryConfidence | null
): MemoryEvidenceResponseStrategy => (
  parserStatus === 'main_model_parse_failed'
    || parserStatus === 'main_model_error'
    || parserStatus === 'session_fallback'
    || parserConfidence === 'low'
    ? 'summary_only_cautious'
    : 'acknowledge_no_evidence'
);

export const buildSessionStartHistoryLookupBlock = (messages: Message[], userText: string): HistoryLookupResult | null => {
  const request = parseSessionStartLookupRequest(userText);
  if (!request) return null;

  const visibleMessages = messages
    .filter(message => !!message.text)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (visibleMessages.length === 0) {
    return {
      promptBlock:
`[EXACT_HISTORY_LOOKUP]
Lookup_Mode: SESSION_START
${buildMemoryNoEvidenceDecisionHeader('low')}
Result: NO_SESSION_START_DATA`,
      found: false,
      strict: true,
      mode: 'session_start',
      targetSpeaker: request.targetRole === 'user' ? 'User' : request.targetRole === 'model' ? 'Kumiko' : 'Any',
      matchedCount: 0,
      evidenceMode: 'none',
      confidenceLevel: 'low',
      responseStrategy: getNoEvidenceResponseStrategy(),
    };
  }

  const startTimestamp = visibleMessages[0].timestamp;
  const timeWindowEnd = startTimestamp + (5 * 60 * 1000);
  const contextSlice = visibleMessages.filter((message, index) => {
    if (index < 8) return true;
    return message.timestamp <= timeWindowEnd;
  }).slice(0, 12);

  const matchedMessages = request.targetRole === 'any'
    ? contextSlice
    : contextSlice.filter(message => message.role === request.targetRole);

  if (request.targetRole !== 'any' && matchedMessages.length === 0) {
    return {
      promptBlock:
`[EXACT_HISTORY_LOOKUP]
Lookup_Mode: SESSION_START
Target_Speaker: ${request.targetRole === 'user' ? 'User' : 'Kumiko'}
${buildMemoryNoEvidenceDecisionHeader('low')}
Result: NO_TARGET_SPEAKER_MATCH_AT_SESSION_START`,
      found: false,
      strict: true,
      mode: 'session_start',
      targetSpeaker: request.targetRole === 'user' ? 'User' : 'Kumiko',
      rangeJst: `${formatJstTimeForRag(contextSlice[0].timestamp)} -> ${formatJstTimeForRag(contextSlice[contextSlice.length - 1].timestamp)}`,
      matchedCount: 0,
      evidenceMode: 'none',
      confidenceLevel: 'low',
      responseStrategy: getNoEvidenceResponseStrategy(),
    };
  }

  const lines = matchedMessages.map(message => {
    const parts = getJstDateParts(message.timestamp);
    const roleLabel = message.role === 'user' ? 'User' : 'Kumiko';
    return `[${parts.year}/${String(parts.month).padStart(2, '0')}/${String(parts.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')} JST] ${roleLabel}: ${message.text}`;
  }).join('\n');

  return {
    promptBlock:
`[EXACT_HISTORY_LOOKUP]
Lookup_Mode: SESSION_START
Target_Speaker: ${request.targetRole === 'user' ? 'User' : request.targetRole === 'model' ? 'Kumiko' : 'Any'}
Matched_Log:
${lines}`,
    found: true,
    strict: true,
    mode: 'session_start',
    targetSpeaker: request.targetRole === 'user' ? 'User' : request.targetRole === 'model' ? 'Kumiko' : 'Any',
    rangeJst: `${formatJstTimeForRag(contextSlice[0].timestamp)} -> ${formatJstTimeForRag(contextSlice[contextSlice.length - 1].timestamp)}`,
    matchedCount: matchedMessages.length,
    evidenceMode: 'raw_messages',
    confidenceLevel: 'high',
    evidenceStrengthSummary: 'message:primary',
    quoteSafeKinds: 'message',
    evidenceSectionCount: 1,
    primaryEvidenceKind: 'message',
    entryMixSummary: `message=${matchedMessages.length}`,
    answerMode: 'quote_first',
    responseStrategy: 'quote_direct_if_supported',
  };
};

export const buildExactHistoryLookupBlock = (messages: Message[], userText: string): HistoryLookupResult | null => {
  const request = parseExactHistoryLookupRequest(userText);
  if (!request) {
    return buildSessionStartHistoryLookupBlock(messages, userText);
  }

  const visibleMessages = messages
    .filter(message => !!message.text)
    .sort((a, b) => a.timestamp - b.timestamp);
  const targetSpeaker = request.targetRole === 'user' ? 'User' : request.targetRole === 'model' ? 'Kumiko' : 'Any';
  const targetJst = formatExactHistoryLookupTargetJst(request);

  const minuteMatches = visibleMessages.filter(message => {
    const parts = getJstDateParts(message.timestamp);
    const timeMatches = parts.year === request.year
      && parts.month === request.month
      && parts.day === request.day
      && parts.hour === request.hour;
    if (!timeMatches) return false;
    if (request.minute !== -1 && parts.minute !== request.minute) return false;
    return true;
  });
  const matchedMessages = request.targetRole === 'any'
    ? minuteMatches
    : minuteMatches.filter(message => message.role === request.targetRole);

  if (matchedMessages.length === 0 && request.minute !== -1) {
    const nearbyExactResult = findNearbyExactTargetSpeakerMatches(visibleMessages, request);
    if (nearbyExactResult.matches.length > 0) {
      const expandedNearby = expandMatchesWithContext(visibleMessages, nearbyExactResult.matches);
      const nearbyMatchIds = new Set(nearbyExactResult.matches.map(m => m.id));
      const lines = expandedNearby.map(message =>
        formatExactHistoryMessageLine(message, nearbyMatchIds.has(message.id))
      ).join('\n');

      return {
        promptBlock:
`[EXACT_HISTORY_LOOKUP]
Lookup_Mode: EXACT_TIMESTAMP
Match_Mode: NEARBY_TARGET_SPEAKER_WINDOW
Nearby_Window_Seconds: ${Math.round(EXACT_LOOKUP_NEARBY_WINDOW_MS / 1000)}
Nearest_Delta_Seconds: ${nearbyExactResult.nearestDeltaSeconds ?? 'unknown'}
Target_JST: ${targetJst}
Target_Speaker: ${targetSpeaker}
Context_Messages: ${expandedNearby.length} (${nearbyExactResult.matches.length} matched + surrounding context)
Matched_Log:
${lines}`,
        found: true,
        strict: true,
        mode: 'exact_timestamp',
        targetSpeaker,
        rangeJst: `${targetJst} JST ±${Math.round(EXACT_LOOKUP_NEARBY_WINDOW_MS / 1000)}s`,
        matchedCount: nearbyExactResult.matches.length,
        evidenceMode: 'raw_messages',
        confidenceLevel: 'medium',
        evidenceStrengthSummary: 'message:primary',
        quoteSafeKinds: 'message',
        evidenceSectionCount: 1,
        primaryEvidenceKind: 'message',
        entryMixSummary: `message=${nearbyExactResult.matches.length}`,
        answerMode: 'quote_first',
        responseStrategy: 'quote_direct_if_supported',
      };
    }

    const wideContextResult = findWideTemporalContextMatches(visibleMessages, request);
    if (wideContextResult.matches.length > 0) {
      const lines = wideContextResult.matches.map(message =>
        formatExactHistoryMessageLine(message, message.id === wideContextResult.closestMatchId)
      ).join('\n');

      return {
        promptBlock:
`[EXACT_HISTORY_LOOKUP]
Lookup_Mode: EXACT_TIMESTAMP
Match_Mode: TEMPORAL_NEARBY_SUMMARY
Search_Window_Minutes: ${Math.round(EXACT_LOOKUP_TEMPORAL_SUMMARY_WINDOW_MS / 60000)}
Nearest_Delta_Seconds: ${wideContextResult.nearestDeltaSeconds ?? 'unknown'}
Target_JST: ${targetJst}
Target_Speaker: ${targetSpeaker}
Context_Messages: ${wideContextResult.matches.length} (closest match marked with <<< CLOSEST)
Note: 该时间点附近没有精确到分钟的命中，但在前后${Math.round(EXACT_LOOKUP_TEMPORAL_SUMMARY_WINDOW_MS / 60000)}分钟范围内找到了对话记录。请基于最近的命中（<<< CLOSEST）及其对话上下文来回答，不要伪装成精确到分钟的逐字台词。
Matched_Log:
${lines}`,
        found: true,
        strict: true,
        mode: 'exact_timestamp',
        targetSpeaker,
        rangeJst: `${targetJst} JST ±${Math.round(EXACT_LOOKUP_TEMPORAL_SUMMARY_WINDOW_MS / 60000)}min`,
        matchedCount: wideContextResult.matches.length,
        evidenceMode: 'raw_messages',
        confidenceLevel: 'medium',
        rawSupportCount: wideContextResult.matches.length,
        evidenceStrengthSummary: 'message:primary',
        quoteSafeKinds: 'message',
        evidenceSectionCount: 1,
        primaryEvidenceKind: 'message',
        entryMixSummary: `message=${wideContextResult.matches.length}`,
        answerMode: 'temporal_summary_with_support',
        responseStrategy: 'summarize_temporal_then_support',
      };
    }
  }

  if (minuteMatches.length === 0) {
    return {
      promptBlock:
`[EXACT_HISTORY_LOOKUP]
Target_JST: ${targetJst}
${buildMemoryNoEvidenceDecisionHeader('low')}
Result: NO_EXACT_MATCH`,
      found: false,
      strict: true,
      mode: 'exact_timestamp',
      targetSpeaker,
      rangeJst: `${targetJst} JST`,
      matchedCount: 0,
      evidenceMode: 'none',
      confidenceLevel: 'low',
      responseStrategy: getNoEvidenceResponseStrategy(),
    };
  }

  if (request.targetRole !== 'any' && matchedMessages.length === 0) {
    return {
      promptBlock:
`[EXACT_HISTORY_LOOKUP]
Target_JST: ${targetJst}
Target_Speaker: ${targetSpeaker}
${buildMemoryNoEvidenceDecisionHeader('low')}
Result: NO_TARGET_SPEAKER_MATCH_AT_EXACT_TIME`,
      found: false,
      strict: true,
      mode: 'exact_timestamp',
      targetSpeaker,
      rangeJst: `${targetJst} JST`,
      matchedCount: 0,
      evidenceMode: 'none',
      confidenceLevel: 'low',
      responseStrategy: getNoEvidenceResponseStrategy(),
    };
  }

  const expandedExact = expandMatchesWithContext(visibleMessages, matchedMessages);
  const matchIds = new Set(matchedMessages.map(m => m.id));
  const lines = expandedExact.map(message =>
    formatExactHistoryMessageLine(message, matchIds.has(message.id))
  ).join('\n');

  return {
    promptBlock:
`[EXACT_HISTORY_LOOKUP]
Target_JST: ${targetJst}
Target_Speaker: ${targetSpeaker}
Context_Messages: ${expandedExact.length} (${matchedMessages.length} exact + surrounding context)
Matched_Log:
${lines}`,
    found: true,
    strict: true,
    mode: 'exact_timestamp',
    targetSpeaker,
    rangeJst: `${targetJst} JST`,
    matchedCount: matchedMessages.length,
    evidenceMode: 'raw_messages',
    confidenceLevel: 'high',
    evidenceStrengthSummary: 'message:primary',
    quoteSafeKinds: 'message',
    evidenceSectionCount: 1,
    primaryEvidenceKind: 'message',
    entryMixSummary: `message=${matchedMessages.length}`,
    answerMode: 'quote_first',
    responseStrategy: 'quote_direct_if_supported',
  };
};

export const formatTemporalRangeJst = (startTimestamp?: number | null, endTimestamp?: number | null) => {
  const formatOne = (timestamp: number) => {
    const parts = getJstDateParts(timestamp);
    return `${parts.year}/${String(parts.month).padStart(2, '0')}/${String(parts.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')} JST`;
  };

  if (typeof startTimestamp === 'number' && typeof endTimestamp === 'number') {
    return `${formatOne(startTimestamp)} -> ${formatOne(endTimestamp)}`;
  }
  if (typeof startTimestamp === 'number') {
    return `${formatOne(startTimestamp)} -> ?`;
  }
  if (typeof endTimestamp === 'number') {
    return `? -> ${formatOne(endTimestamp)}`;
  }
  return 'UNSPECIFIED';
};

const isBroadTemporalHistoryQuery = (text: string) => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return /(?:聊了什么|大致|大概|大约|差不多|左右|话题|内容|那段|那次|那天|发生了什么|说了些什么|summary|summarize|roughly|about what|what happened|what did we talk about)/iu.test(normalized);
};

const TEMPORAL_QUERY_KEYWORD_STOPWORDS = new Set([
  '什么',
  '时候',
  '时间',
  '左右',
  '大概',
  '大约',
  '差不多',
  '那次',
  '那天',
  '那段',
  '话题',
  '内容',
  '我们',
  '聊了',
  '说了',
  '发生',
  'what',
  'when',
  'about',
  'roughly',
  'summary',
  'summarize',
  'talk',
  'talked',
  'around',
]);

const extractTemporalQueryKeywords = (text: string) => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return [];

  const matches = normalized.match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/g) || [];
  return Array.from(new Set(matches.filter(keyword => !TEMPORAL_QUERY_KEYWORD_STOPWORDS.has(keyword))));
};

const formatHistoryEvidenceLine = (message: Message) => {
  const parts = getJstDateParts(message.timestamp);
  const roleLabel = message.role === 'user' ? 'User' : 'Kumiko';
  return `[${parts.year}/${String(parts.month).padStart(2, '0')}/${String(parts.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')} JST] ${roleLabel}: ${message.text}`;
};

const scoreTemporalEpisodeForEvidence = (
  episode: EpisodeEntity,
  queryKeywords: string[],
  targetRole: 'user' | 'model' | 'any'
) => {
  const searchableText = `${episode.topicHint || ''}\n${episode.preview}\n${episode.text}`.toLowerCase();
  let score = Math.min(episode.messageCount, 16) * 0.12;

  if (episode.roleScope === 'mixed') {
    score += 0.75;
  }

  if (targetRole !== 'any') {
    if (episode.roleScope === targetRole) {
      score += 1.25;
    } else if (episode.roleScope === 'mixed') {
      score += 0.5;
    } else {
      score -= 0.75;
    }
  }

  if (queryKeywords.length > 0) {
    const matchCount = queryKeywords.reduce((count, keyword) => count + (searchableText.includes(keyword) ? 1 : 0), 0);
    score += matchCount * 1.5;
  }

  return score;
};

const selectTemporalEpisodesForEvidence = (
  episodes: EpisodeEntity[],
  queryText: string,
  targetRole: 'user' | 'model' | 'any',
  maxEpisodes: number = 4
) => {
  if (episodes.length <= maxEpisodes) return episodes;

  const queryKeywords = extractTemporalQueryKeywords(queryText);
  return [...episodes]
    .map(episode => ({
      episode,
      score: scoreTemporalEpisodeForEvidence(episode, queryKeywords, targetRole),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.episode.messageCount !== a.episode.messageCount) return b.episode.messageCount - a.episode.messageCount;
      return a.episode.startTimestamp - b.episode.startTimestamp;
    })
    .slice(0, maxEpisodes)
    .map(entry => entry.episode)
    .sort((a, b) => a.startTimestamp - b.startTimestamp);
};

const buildTemporalEpisodeOverviewLine = (episodes: EpisodeEntity[], totalEpisodeCount: number) => {
  const totalMessages = episodes.reduce((sum, episode) => sum + episode.messageCount, 0);
  const omittedCount = Math.max(0, totalEpisodeCount - episodes.length);
  return `Selected_Episodes: ${episodes.length} | Selected_Messages: ${totalMessages} | Omitted_Episodes: ${omittedCount}`;
};

export const formatSemanticEntryKindSummary = (entryKindSummary: Record<LocalRagEntryKind, number>) => {
  const orderedKinds: LocalRagEntryKind[] = ['semantic_chunk', 'episode', 'message', 'background', 'mixed'];
  return orderedKinds
    .filter(kind => (entryKindSummary[kind] || 0) > 0)
    .map(kind => `${kind}=${entryKindSummary[kind]}`)
    .join(', ');
};

const buildMemoryEvidenceEnvelopeHeader = ({
  intent,
  primaryEvidence,
  entryMix,
  evidenceStrengths,
  quoteSafeKinds,
  answerMode,
}: {
  intent: 'temporal_history' | 'semantic_recall';
  primaryEvidence: string;
  entryMix: string;
  evidenceStrengths: string;
  quoteSafeKinds: string;
  answerMode: 'quote_first' | 'temporal_summary_with_support' | 'thematic_summary_with_support' | 'summary_only';
}) => `[MEMORY_EVIDENCE_ENVELOPE]
Evidence_Intent: ${intent}
Answer_Mode: ${answerMode}
Primary_Evidence: ${primaryEvidence}
Entry_Mix: ${entryMix || 'none'}
Evidence_Strengths: ${evidenceStrengths || 'none'}
Quote_Safe_Kinds: ${quoteSafeKinds || 'none'}`;

type MemoryEvidenceSectionDescriptor = {
  label: string;
  quoteSafe: boolean;
  lines: string[];
};

const buildMemoryEvidenceResponseStyle = (
  answerMode: MemoryEvidenceAnswerMode
) => {
  if (answerMode === 'quote_first') return 'direct_answer_with_quotes_when_safe';
  if (answerMode === 'temporal_summary_with_support') return 'temporal_summary_then_support';
  if (answerMode === 'thematic_summary_with_support') return 'theme_summary_then_support';
  return 'summary_only';
};

export const buildMemoryEvidenceResponseStrategy = (
  answerMode: MemoryEvidenceAnswerMode,
  confidenceLevel: 'high' | 'medium' | 'low',
  quoteSafeKinds: string
): MemoryEvidenceResponseStrategy => {
  if (confidenceLevel === 'low' && answerMode === 'summary_only') {
    return 'summary_only_cautious';
  }
  if (answerMode === 'quote_first') {
    return quoteSafeKinds && quoteSafeKinds !== 'none'
      ? 'quote_direct_if_supported'
      : 'summary_only_cautious';
  }
  if (answerMode === 'temporal_summary_with_support') return 'summarize_temporal_then_support';
  if (answerMode === 'thematic_summary_with_support') return 'summarize_theme_then_support';
  return 'summary_only_cautious';
};

const buildMemoryEvidenceQuotePolicy = (quoteSafeKinds: string) => {
  if (!quoteSafeKinds || quoteSafeKinds === 'none') return 'no_direct_quotes';
  if (quoteSafeKinds === 'message') return 'messages_only';
  return `limited_to_${quoteSafeKinds.replace(/,\s*/g, '_')}`;
};

const buildMemoryEvidenceDecisionHeader = ({
  answerMode,
  quoteSafeKinds,
  confidenceLevel,
}: {
  answerMode: MemoryEvidenceAnswerMode;
  quoteSafeKinds: string;
  confidenceLevel: 'high' | 'medium' | 'low';
}) => `[MEMORY_EVIDENCE_DECISION]
Response_Style: ${buildMemoryEvidenceResponseStyle(answerMode)}
Response_Strategy: ${buildMemoryEvidenceResponseStrategy(answerMode, confidenceLevel, quoteSafeKinds)}
Quote_Policy: ${buildMemoryEvidenceQuotePolicy(quoteSafeKinds)}
Confidence_Level: ${confidenceLevel}`;

const buildMemoryResponseEvidenceStrength = ({
  route,
  responseStrategy,
  confidenceLevel,
  primaryEvidenceKind,
}: {
  route: 'exact_history' | 'temporal_history' | 'fuzzy_rag';
  responseStrategy: MemoryEvidenceResponseStrategy;
  confidenceLevel: 'high' | 'medium' | 'low';
  primaryEvidenceKind: string | null;
}): MemoryEvidenceStrength => {
  if (responseStrategy === 'acknowledge_no_evidence') return 'none';
  if (confidenceLevel === 'low') return 'weak';

  if (
    route === 'exact_history'
    && responseStrategy === 'quote_direct_if_supported'
    && primaryEvidenceKind === 'message'
    && confidenceLevel === 'high'
  ) {
    return 'strong';
  }

  if (responseStrategy === 'summarize_temporal_then_support') {
    return confidenceLevel === 'high' ? 'medium' : 'medium';
  }
  if (responseStrategy === 'summarize_theme_then_support') {
    return confidenceLevel === 'high' ? 'strong' : 'medium';
  }

  if (responseStrategy === 'quote_direct_if_supported') {
    return confidenceLevel === 'high' ? 'strong' : 'medium';
  }

  return 'weak';
};

const buildMemoryResponseSpeakerCertainty = ({
  route,
  primaryEvidenceKind,
  targetSpeaker,
}: {
  route: 'exact_history' | 'temporal_history' | 'fuzzy_rag';
  primaryEvidenceKind: string | null;
  targetSpeaker: 'User' | 'Kumiko' | 'Any' | null;
}): MemoryEvidenceCertainty => {
  if (route === 'exact_history') {
    if (primaryEvidenceKind === 'message' && targetSpeaker && targetSpeaker !== 'Any') return 'high';
    if (primaryEvidenceKind === 'message') return 'medium';
    return 'low';
  }

  if (route === 'temporal_history') {
    if (primaryEvidenceKind === 'message' && targetSpeaker && targetSpeaker !== 'Any') return 'medium';
    return targetSpeaker && targetSpeaker !== 'Any' ? 'medium' : 'low';
  }

  if (route === 'fuzzy_rag') {
    if (primaryEvidenceKind === 'message') return 'medium';
    if (primaryEvidenceKind === 'episode') return 'medium';
    return 'low';
  }

  return 'low';
};

const buildMemoryResponseTimeCertainty = ({
  route,
  parserPrecision,
  confidenceLevel,
}: {
  route: 'exact_history' | 'temporal_history' | 'fuzzy_rag';
  parserPrecision: TemporalQueryPrecision | null;
  confidenceLevel: 'high' | 'medium' | 'low';
}): MemoryEvidenceCertainty => {
  if (route === 'exact_history') return confidenceLevel === 'high' ? 'high' : 'medium';
  if (route === 'fuzzy_rag') return confidenceLevel === 'low' ? 'low' : 'medium';

  if (parserPrecision === 'exact_minute') return 'high';
  if (parserPrecision === 'approximate_minutes' || parserPrecision === 'hour_window') return 'medium';
  return 'low';
};

const buildMemoryResponseConflictFlags = ({
  evidenceStrength,
  speakerCertainty,
  timeCertainty,
  quotePolicy,
  entryMixSummary,
}: {
  evidenceStrength: MemoryEvidenceStrength;
  speakerCertainty: MemoryEvidenceCertainty;
  timeCertainty: MemoryEvidenceCertainty;
  quotePolicy: string;
  entryMixSummary: string | null;
}): MemoryResponseConflictFlag[] => {
  const flags: MemoryResponseConflictFlag[] = [];
  if (speakerCertainty === 'low') flags.push('speaker_uncertain');
  if (timeCertainty === 'low') flags.push('time_uncertain');
  if (evidenceStrength === 'weak' || evidenceStrength === 'none') flags.push('weak_evidence');
  if (quotePolicy === 'no_direct_quotes') flags.push('quote_restricted');
  if (entryMixSummary && /\bmixed\b/i.test(entryMixSummary)) flags.push('mixed_evidence');
  return flags;
};

const buildMemoryResponseRouteBoundary = (
  route: 'exact_history' | 'temporal_history' | 'fuzzy_rag',
  responseStrategy: MemoryEvidenceResponseStrategy | null,
  answerMode: MemoryEvidenceAnswerMode | null
): MemoryResponseRouteBoundary => {
  if (route === 'exact_history') {
    if (responseStrategy === 'summarize_temporal_then_support' || answerMode === 'temporal_summary_with_support') {
      return 'temporal_summary_or_supported_quote';
    }
    return 'exact_evidence_only';
  }
  if (route === 'temporal_history') return 'temporal_summary_or_supported_quote';
  return 'semantic_summary_or_supported_quote';
};

const buildMemoryResponsePreferredLead = ({
  route,
  responseStrategy,
  directAnswerAllowed,
}: {
  route: 'exact_history' | 'temporal_history' | 'fuzzy_rag';
  responseStrategy: MemoryEvidenceResponseStrategy;
  directAnswerAllowed: boolean;
}): MemoryResponsePreferredLead => {
  if (responseStrategy === 'acknowledge_no_evidence') return 'admit_missing_evidence';
  if (responseStrategy === 'summarize_temporal_then_support') return 'temporal_summary';
  if (route === 'exact_history') {
    return directAnswerAllowed ? 'direct_recall' : 'exact_cautious';
  }
  if (route === 'temporal_history') return 'temporal_summary';
  return 'semantic_summary';
};

const buildMemoryResponseSpeakerClaimAllowed = ({
  speakerCertainty,
  conflictFlags,
}: {
  speakerCertainty: MemoryEvidenceCertainty;
  conflictFlags: MemoryResponseConflictFlag[];
}): MemoryResponseAllowance => (
  speakerCertainty !== 'low' && !conflictFlags.includes('speaker_uncertain') ? 'yes' : 'no'
);

const buildMemoryResponseTimePinpointAllowed = ({
  timeCertainty,
  conflictFlags,
}: {
  timeCertainty: MemoryEvidenceCertainty;
  conflictFlags: MemoryResponseConflictFlag[];
}): MemoryResponseAllowance => (
  timeCertainty !== 'low' && !conflictFlags.includes('time_uncertain') ? 'yes' : 'no'
);

export const buildMemoryResponsePlanBlock = ({
  route,
  responseStrategy,
  answerMode,
  confidenceLevel,
  primaryEvidenceKind,
  quoteSafeKinds,
  entryMixSummary,
  targetSpeaker,
  parserPrecision,
}: {
  route: 'exact_history' | 'temporal_history' | 'fuzzy_rag';
  responseStrategy: MemoryEvidenceResponseStrategy | null;
  answerMode: MemoryEvidenceAnswerMode | null;
  confidenceLevel: 'high' | 'medium' | 'low' | null;
  primaryEvidenceKind: string | null;
  quoteSafeKinds: string | null;
  entryMixSummary: string | null;
  targetSpeaker: 'User' | 'Kumiko' | 'Any' | null;
  parserPrecision: TemporalQueryPrecision | null;
}) => {
  if (!responseStrategy) return null;

  const effectiveConfidence = confidenceLevel || 'low';
  const effectiveQuotePolicy = buildMemoryEvidenceQuotePolicy(quoteSafeKinds || 'none');
  const evidenceStrength = buildMemoryResponseEvidenceStrength({
    route,
    responseStrategy,
    confidenceLevel: effectiveConfidence,
    primaryEvidenceKind,
  });
  const speakerCertainty = buildMemoryResponseSpeakerCertainty({
    route,
    primaryEvidenceKind,
    targetSpeaker,
  });
  const timeCertainty = buildMemoryResponseTimeCertainty({
    route,
    parserPrecision,
    confidenceLevel: effectiveConfidence,
  });
  const conflictFlags = buildMemoryResponseConflictFlags({
    evidenceStrength,
    speakerCertainty,
    timeCertainty,
    quotePolicy: effectiveQuotePolicy,
    entryMixSummary,
  });
  const routeBoundary = buildMemoryResponseRouteBoundary(route, responseStrategy, answerMode);
  const CRITICAL_CONFLICT_FLAGS: Set<MemoryResponseConflictFlag> = new Set([
    'speaker_uncertain', 'time_uncertain', 'weak_evidence',
  ]);
  const hasCriticalConflict = conflictFlags.some(f => CRITICAL_CONFLICT_FLAGS.has(f));
  const directAnswerAllowed =
    (evidenceStrength === 'strong' || evidenceStrength === 'medium')
    && !hasCriticalConflict;
  const speakerClaimAllowed = buildMemoryResponseSpeakerClaimAllowed({
    speakerCertainty,
    conflictFlags,
  });
  const timePinpointAllowed = buildMemoryResponseTimePinpointAllowed({
    timeCertainty,
    conflictFlags,
  });
  const preferredLead = buildMemoryResponsePreferredLead({
    route,
    responseStrategy,
    directAnswerAllowed,
  });
  const noSubstitution = route === 'exact_history' || route === 'temporal_history';
  const maxBubbles = responseStrategy === 'acknowledge_no_evidence'
    ? 2
    : responseStrategy === 'quote_direct_if_supported'
      ? 3
      : 3;
  return `[MEMORY_RESPONSE_PLAN]
Route: ${route}
Response_Strategy: ${responseStrategy}
Answer_Mode: ${answerMode || 'summary_only'}
Confidence_Level: ${effectiveConfidence}
Evidence_Strength: ${evidenceStrength}
Speaker_Certainty: ${speakerCertainty}
Time_Certainty: ${timeCertainty}
Direct_Answer_Allowed: ${directAnswerAllowed ? 'yes' : 'no'}
Conflict_Flags: ${conflictFlags.length > 0 ? conflictFlags.join(', ') : 'none'}
Route_Boundary: ${routeBoundary}
Preferred_Lead: ${preferredLead}
No_Substitution: ${noSubstitution ? 'yes' : 'no'}
Speaker_Claim_Allowed: ${speakerClaimAllowed}
Time_Pinpoint_Allowed: ${timePinpointAllowed}
Primary_Evidence: ${primaryEvidenceKind || 'unknown'}
Quote_Policy: ${effectiveQuotePolicy}
Max_Bubbles: ${maxBubbles}
Entry_Mix: ${entryMixSummary || 'none'}`;
};

const renderMemoryEvidenceSections = (sections: MemoryEvidenceSectionDescriptor[]) => {
  const rendered: string[] = [];
  sections.forEach(section => {
    rendered.push(section.label);
    rendered.push(`Quote_Safe: ${section.quoteSafe ? 'YES' : 'NO'}`);
    if (section.lines.length > 0) {
      rendered.push(...section.lines);
    } else {
      rendered.push('NONE');
    }
  });
  return rendered;
};

export const buildMemoryEvidenceContext = ({
  marker,
  intent,
  primaryEvidence,
  entryMix,
  evidenceStrengths,
  quoteSafeKinds,
  answerMode,
  confidenceLevel,
  sections,
}: {
  marker: string;
  intent: 'temporal_history' | 'semantic_recall';
  primaryEvidence: string;
  entryMix: string;
  evidenceStrengths: string;
  quoteSafeKinds: string;
  answerMode: MemoryEvidenceAnswerMode;
  confidenceLevel: 'high' | 'medium' | 'low';
  sections: MemoryEvidenceSectionDescriptor[];
}) => [
  marker,
  buildMemoryEvidenceEnvelopeHeader({
    intent,
    primaryEvidence,
    entryMix,
    evidenceStrengths,
    quoteSafeKinds,
    answerMode,
  }),
  buildMemoryEvidenceDecisionHeader({
    answerMode,
    quoteSafeKinds,
    confidenceLevel,
  }),
  ...renderMemoryEvidenceSections(sections),
];

export const buildSemanticRecallEvidenceDescriptors = (
  groupedBlocks: Array<{ kind: LocalRagEntryKind; strength: LocalRagEvidenceStrength; quoteSafe: boolean; blocks: string[] }>
) => {
  const labelMap: Record<LocalRagEntryKind, Record<LocalRagEvidenceStrength, string>> = {
    semantic_chunk: {
      primary: '[PRIMARY_SEMANTIC_CHUNK_RECALL]',
      secondary: '[SECONDARY_SEMANTIC_CHUNK_RECALL]',
      supporting: '[SUPPORTING_SEMANTIC_CHUNK_RECALL]',
    },
    episode: {
      primary: '[PRIMARY_EPISODE_RECALL]',
      secondary: '[SECONDARY_EPISODE_RECALL]',
      supporting: '[SUPPORTING_EPISODE_RECALL]',
    },
    message: {
      primary: '[PRIMARY_MESSAGE_RECALL]',
      secondary: '[SECONDARY_MESSAGE_RECALL]',
      supporting: '[SUPPORTING_MESSAGE_RECALL]',
    },
    background: {
      primary: '[PRIMARY_BACKGROUND_RECALL]',
      secondary: '[SECONDARY_BACKGROUND_RECALL]',
      supporting: '[SUPPORTING_BACKGROUND_RECALL]',
    },
    mixed: {
      primary: '[PRIMARY_MIXED_RECALL]',
      secondary: '[SECONDARY_MIXED_RECALL]',
      supporting: '[SUPPORTING_MIXED_RECALL]',
    },
  };

  return groupedBlocks
    .filter(group => !!group.blocks && group.blocks.length > 0)
    .map(group => ({
      label: labelMap[group.kind][group.strength],
      quoteSafe: group.quoteSafe,
      lines: group.blocks,
    }));
};

const buildTemporalEpisodeEvidenceDescriptors = (
  episodeLines: string[],
  rawSupportMessages: Message[]
) => {
  const sections: MemoryEvidenceSectionDescriptor[] = [];

  if (episodeLines.length > 0) {
    sections.push({
      label: '[PRIMARY_EPISODE_EVIDENCE]',
      quoteSafe: false,
      lines: episodeLines,
    });
  }

  sections.push({
    label: '[SECONDARY_RAW_MESSAGE_SUPPORT]',
    quoteSafe: rawSupportMessages.length > 0,
    lines: rawSupportMessages.map(formatHistoryEvidenceLine),
  });

  return sections;
};

const buildRawMessageEvidenceDescriptors = (
  messages: Message[],
  label: string = '[PRIMARY_RAW_MESSAGE_EVIDENCE]'
) => {
  return [{
    label,
    quoteSafe: messages.length > 0,
    lines: messages.map(formatHistoryEvidenceLine),
  }];
};

const formatTemporalEvidenceStrengthSummary = (hasEpisodeEvidence: boolean, hasRawSupport: boolean) => {
  const parts: string[] = [];
  if (hasEpisodeEvidence) parts.push('episode:primary');
  if (hasRawSupport) parts.push('message:secondary');
  return parts.join(', ');
};

const formatTemporalQuoteSafeSummary = (hasRawSupport: boolean) => (hasRawSupport ? 'message' : 'none');

const formatTemporalEntryMixSummary = (episodeCount: number, rawSupportCount: number) => {
  const parts: string[] = [];
  if (episodeCount > 0) parts.push(`episode=${episodeCount}`);
  if (rawSupportCount > 0) parts.push(`message=${rawSupportCount}`);
  return parts.join(', ');
};

const formatRawMessageEvidenceStrengthSummary = (hasMessages: boolean) => (hasMessages ? 'message:primary' : 'none');

const formatRawMessageEntryMixSummary = (messageCount: number) => (messageCount > 0 ? `message=${messageCount}` : 'none');

export const formatSemanticEvidenceStrengthSummary = (
  groupedBlocks: Array<{ kind: LocalRagEntryKind; strength: LocalRagEvidenceStrength; quoteSafe: boolean; blocks: string[] }>
) => groupedBlocks
  .filter(group => group.blocks.length > 0)
  .map(group => `${group.kind}:${group.strength}`)
  .join(', ');

export const formatSemanticQuoteSafeSummary = (
  groupedBlocks: Array<{ kind: LocalRagEntryKind; strength: LocalRagEvidenceStrength; quoteSafe: boolean; blocks: string[] }>
) => groupedBlocks
  .filter(group => group.blocks.length > 0 && group.quoteSafe)
  .map(group => group.kind)
  .join(', ');

const buildEpisodeRepresentativeMessages = (episodeMessages: Message[]) => {
  if (episodeMessages.length === 0) return [];

  const selected = new Map<string, Message>();
  const addMessage = (message?: Message) => {
    if (!message || selected.has(message.id)) return;
    selected.set(message.id, message);
  };

  addMessage(episodeMessages[0]);
  addMessage(episodeMessages.find(message => message.role === 'user'));
  addMessage(episodeMessages.find(message => message.role === 'model'));

  const mostInformative = [...episodeMessages]
    .sort((a, b) => b.text.length - a.text.length)
    .find(message => message.text.trim().length >= 12);
  addMessage(mostInformative);
  addMessage(episodeMessages[episodeMessages.length - 1]);

  return Array.from(selected.values()).sort((a, b) => a.timestamp - b.timestamp);
};

const buildTemporalEpisodeSupportSlice = (
  episodes: EpisodeEntity[],
  messages: Message[],
  maxLines: number = 12
) => {
  if (episodes.length === 0 || messages.length === 0) return [];

  const messageMap = new Map(messages.map(message => [message.id, message]));
  const orderedSupportMessages: Message[] = [];
  const seenMessageIds = new Set<string>();

  episodes.forEach(episode => {
    const episodeMessages = episode.messageIds
      .map(messageId => messageMap.get(messageId))
      .filter((message): message is Message => !!message);

    if (episodeMessages.length === 0) return;

    buildEpisodeRepresentativeMessages(episodeMessages).forEach(message => {
      if (seenMessageIds.has(message.id)) return;
      seenMessageIds.add(message.id);
      orderedSupportMessages.push(message);
    });
  });

  return orderedSupportMessages
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, maxLines);
};

const getSuccessfulTemporalParserStatus = (
  temporalIntent: TemporalQueryAnalysis | null
): TemporalQueryDiagnosticsStatus | null => {
  if (!temporalIntent?.isTemporalQuery) return null;
  return temporalIntent.source === 'local_heuristic' ? 'heuristic_success' : 'main_model_success';
};

export const buildTemporalHistoryLookupBlock = (
  messages: Message[],
  temporalIntent: TemporalQueryAnalysis | null,
  episodes: EpisodeEntity[] = [],
  queryText: string = ''
): HistoryLookupResult | null => {
  if (!temporalIntent?.isTemporalQuery) return null;

  const hasTimeWindow = typeof temporalIntent.startTimestampJST === 'number' || typeof temporalIntent.endTimestampJST === 'number';
  if (!hasTimeWindow) return null;

  const searchableMessages = messages
    .filter(message => !!message.text)
    .sort((a, b) => a.timestamp - b.timestamp);

  const timeFiltered = searchableMessages.filter(message => {
    if (typeof temporalIntent.startTimestampJST === 'number' && message.timestamp < temporalIntent.startTimestampJST) {
      return false;
    }
    if (typeof temporalIntent.endTimestampJST === 'number' && message.timestamp > temporalIntent.endTimestampJST) {
      return false;
    }
    return true;
  });

  const roleFiltered = temporalIntent.searchRole === 'any'
    ? timeFiltered
    : timeFiltered.filter(message => message.role === temporalIntent.searchRole);

  const usableEpisodes = temporalIntent.searchRole === 'any'
    ? episodes
      .sort((a, b) => a.startTimestamp - b.startTimestamp)
      .slice(0, 8)
    : [];

  const rangeText = formatTemporalRangeJst(temporalIntent.startTimestampJST, temporalIntent.endTimestampJST);
  const parserSource = temporalIntent.source || null;
  const parserPrecision = temporalIntent.precision || null;
  const parserConfidence = temporalIntent.confidence || null;
  const rangeSpanMs = (typeof temporalIntent.startTimestampJST === 'number' && typeof temporalIntent.endTimestampJST === 'number')
    ? Math.max(0, temporalIntent.endTimestampJST - temporalIntent.startTimestampJST)
    : 0;
  const parserStatus = getSuccessfulTemporalParserStatus(temporalIntent);
  const isExactMinutePrecision = parserPrecision === 'exact_minute';
  const isApproximateMinutePrecision = parserPrecision === 'approximate_minutes';
  const isHourWindowPrecision = parserPrecision === 'hour_window';
  const isDayWindowPrecision = parserPrecision === 'day_window';
  const effectiveSliceLimit = isExactMinutePrecision
    ? 12
    : isApproximateMinutePrecision
      ? 16
      : 24;
  const effectiveSlice = (roleFiltered.length > 0 ? roleFiltered : timeFiltered).slice(0, effectiveSliceLimit);
  const targetSpeaker = temporalIntent.searchRole === 'user'
    ? 'User'
    : temporalIntent.searchRole === 'model'
      ? 'Kumiko'
      : 'Any';
  const preferEpisodes = usableEpisodes.length > 0 && !isExactMinutePrecision && !isApproximateMinutePrecision && (
    isDayWindowPrecision
    || (isHourWindowPrecision && (
      isBroadTemporalHistoryQuery(queryText)
      || timeFiltered.length > 10
      || rangeSpanMs >= 3 * 60 * 60 * 1000
    ))
    || isBroadTemporalHistoryQuery(queryText)
    || timeFiltered.length > 12
    || rangeSpanMs >= 6 * 60 * 60 * 1000
  );

  if (preferEpisodes) {
    const selectedEpisodes = selectTemporalEpisodesForEvidence(usableEpisodes, queryText, temporalIntent.searchRole, 4);
    const rawSupportMessages = buildTemporalEpisodeSupportSlice(selectedEpisodes, searchableMessages);
    const episodeLines = selectedEpisodes.map(episode => {
      const scopeLabel = episode.roleScope === 'user'
        ? 'User'
        : episode.roleScope === 'model'
          ? 'Kumiko'
          : 'Mixed';
      const topicLine = episode.topicHint ? `Topic_Hint: ${episode.topicHint}\n` : '';
      const boundaryLine = episode.boundaryReason ? `Boundary: ${episode.boundaryReason}\n` : '';
      return `[${formatTemporalEpisodeRange(episode.startTimestamp, episode.endTimestamp)}] Episode (${scopeLabel}, ${episode.messageCount} msgs)\n${topicLine}${boundaryLine}${episode.preview}`;
    });
    const temporalEvidenceDescriptors = buildTemporalEpisodeEvidenceDescriptors(episodeLines, rawSupportMessages);
    const episodeOverviewLine = buildTemporalEpisodeOverviewLine(selectedEpisodes, usableEpisodes.length);
    const evidenceStrengths = formatTemporalEvidenceStrengthSummary(selectedEpisodes.length > 0, rawSupportMessages.length > 0);
    const quoteSafeKinds = formatTemporalQuoteSafeSummary(rawSupportMessages.length > 0);
    const entryMixSummary = formatTemporalEntryMixSummary(selectedEpisodes.length, rawSupportMessages.length);
    const temporalEvidenceContext = buildMemoryEvidenceContext({
      marker: '[TEMPORAL_HISTORY_EVIDENCE]',
      intent: 'temporal_history',
      answerMode: 'temporal_summary_with_support',
      confidenceLevel: parserConfidence === 'low' ? 'low' : 'medium',
      primaryEvidence: 'episode',
      entryMix: entryMixSummary,
      evidenceStrengths,
      quoteSafeKinds,
      sections: temporalEvidenceDescriptors,
    });
    const temporalEvidenceHeader = temporalEvidenceContext.slice(0, 3).join('\n');
    const temporalEvidenceBody = temporalEvidenceContext.slice(3).join('\n');

    return {
      promptBlock:
`[EXACT_HISTORY_LOOKUP]
Lookup_Mode: TEMPORAL_WINDOW
Evidence_Mode: EPISODES
Target_Range_JST: ${rangeText}
Target_Speaker: ${targetSpeaker}
Parser_Status: ${parserStatus || 'unknown'}
Parser_Source: ${parserSource || 'unknown'}
Parser_Precision: ${parserPrecision || 'unknown'}
Parser_Confidence: ${parserConfidence || 'unknown'}
Episode_Overview: ${episodeOverviewLine}
${temporalEvidenceHeader}
Matched_Log:
${temporalEvidenceBody}`,
      found: true,
      strict: true,
      mode: 'temporal_window',
      targetSpeaker,
      rangeJst: rangeText,
      parserStatus,
      parserSource,
      parserPrecision,
      parserConfidence,
      matchedCount: selectedEpisodes.length,
      evidenceMode: 'episodes',
      confidenceLevel: parserConfidence === 'low' ? 'low' : 'medium',
      rawSupportCount: rawSupportMessages.length,
    evidenceStrengthSummary: evidenceStrengths,
    quoteSafeKinds,
    evidenceSectionCount: temporalEvidenceDescriptors.length,
    primaryEvidenceKind: 'episode',
    entryMixSummary,
    answerMode: 'temporal_summary_with_support',
    responseStrategy: 'summarize_temporal_then_support',
  };
  }

  if (timeFiltered.length === 0) {
    return {
      promptBlock:
`[EXACT_HISTORY_LOOKUP]
Lookup_Mode: TEMPORAL_WINDOW
Target_Range_JST: ${rangeText}
Target_Speaker: ${targetSpeaker}
Parser_Status: ${parserStatus || 'unknown'}
Parser_Source: ${parserSource || 'unknown'}
Parser_Precision: ${parserPrecision || 'unknown'}
Parser_Confidence: ${parserConfidence || 'unknown'}
${buildMemoryNoEvidenceDecisionHeader('low', getNoEvidenceResponseStrategy(parserStatus, parserConfidence))}
Result: NO_TEMPORAL_MATCH`,
      found: false,
      strict: true,
      mode: 'temporal_window',
      targetSpeaker,
      rangeJst: rangeText,
      parserStatus,
      parserSource,
      parserPrecision,
      parserConfidence,
      matchedCount: 0,
      evidenceMode: 'none',
      confidenceLevel: 'low',
      rawSupportCount: 0,
      responseStrategy: getNoEvidenceResponseStrategy(parserStatus, parserConfidence),
    };
  }

  if (roleFiltered.length === 0 && temporalIntent.searchRole !== 'any') {
    return {
      promptBlock:
`[EXACT_HISTORY_LOOKUP]
Lookup_Mode: TEMPORAL_WINDOW
Target_Range_JST: ${rangeText}
Target_Speaker: ${targetSpeaker}
Parser_Status: ${parserStatus || 'unknown'}
Parser_Source: ${parserSource || 'unknown'}
Parser_Precision: ${parserPrecision || 'unknown'}
Parser_Confidence: ${parserConfidence || 'unknown'}
${buildMemoryNoEvidenceDecisionHeader('low', getNoEvidenceResponseStrategy(parserStatus, parserConfidence))}
Result: NO_ROLE_MATCH_IN_WINDOW`,
      found: false,
      strict: true,
      mode: 'temporal_window',
      targetSpeaker,
      rangeJst: rangeText,
      parserStatus,
      parserSource,
      parserPrecision,
      parserConfidence,
      matchedCount: 0,
      evidenceMode: 'none',
      confidenceLevel: 'low',
      rawSupportCount: 0,
      responseStrategy: getNoEvidenceResponseStrategy(parserStatus, parserConfidence),
    };
  }

  const rawMessageDescriptors = buildRawMessageEvidenceDescriptors(effectiveSlice);
  const rawMessageEvidenceStrengths = formatRawMessageEvidenceStrengthSummary(effectiveSlice.length > 0);
  const rawMessageQuoteSafeKinds = effectiveSlice.length > 0 ? 'message' : 'none';
  const rawMessageEntryMix = formatRawMessageEntryMixSummary(effectiveSlice.length);
  const rawMessageEvidenceContext = buildMemoryEvidenceContext({
    marker: '[TEMPORAL_HISTORY_EVIDENCE]',
    intent: 'temporal_history',
    answerMode: 'quote_first',
    confidenceLevel: parserConfidence === 'high' ? 'high' : 'medium',
    primaryEvidence: 'message',
    entryMix: rawMessageEntryMix,
    evidenceStrengths: rawMessageEvidenceStrengths,
    quoteSafeKinds: rawMessageQuoteSafeKinds,
    sections: rawMessageDescriptors,
  });
  const rawMessageEvidenceHeader = rawMessageEvidenceContext.slice(0, 3).join('\n');
  const rawMessageEvidenceBody = rawMessageEvidenceContext.slice(3).join('\n');

  return {
    promptBlock:
`[EXACT_HISTORY_LOOKUP]
Lookup_Mode: TEMPORAL_WINDOW
Evidence_Mode: RAW_MESSAGES
Target_Range_JST: ${rangeText}
Target_Speaker: ${targetSpeaker}
Parser_Status: ${parserStatus || 'unknown'}
Parser_Source: ${parserSource || 'unknown'}
Parser_Precision: ${parserPrecision || 'unknown'}
Parser_Confidence: ${parserConfidence || 'unknown'}
${rawMessageEvidenceHeader}
Matched_Log:
${rawMessageEvidenceBody}`,
    found: true,
    strict: true,
    mode: 'temporal_window',
    targetSpeaker,
    rangeJst: rangeText,
    parserStatus,
    parserSource,
    parserPrecision,
    parserConfidence,
    matchedCount: effectiveSlice.length,
    evidenceMode: 'raw_messages',
    confidenceLevel: parserConfidence === 'high' ? 'high' : 'medium',
    rawSupportCount: effectiveSlice.length,
    evidenceStrengthSummary: rawMessageEvidenceStrengths,
    quoteSafeKinds: rawMessageQuoteSafeKinds,
    evidenceSectionCount: rawMessageDescriptors.length,
    primaryEvidenceKind: 'message',
    entryMixSummary: rawMessageEntryMix,
    answerMode: 'quote_first',
    responseStrategy: 'quote_direct_if_supported',
  };
};

export const buildTemporalNoEvidenceLookupBlock = (
  queryText: string,
  temporalIntent: TemporalQueryAnalysis | null,
  session: MemoryQuerySession | null,
  diagnostics?: TemporalQueryDiagnostics | null
): HistoryLookupResult => {
  const startTimestamp = temporalIntent?.startTimestampJST ?? session?.startTimestampJST ?? null;
  const endTimestamp = temporalIntent?.endTimestampJST ?? session?.endTimestampJST ?? null;
  const rangeText = formatTemporalRangeJst(startTimestamp, endTimestamp);
  const parserSource = temporalIntent?.source ?? session?.parserSource ?? null;
  const parserPrecision = temporalIntent?.precision ?? session?.parserPrecision ?? null;
  const parserConfidence = temporalIntent?.confidence ?? session?.parserConfidence ?? diagnostics?.confidence ?? null;
  const parserStatus = diagnostics?.status ?? 'no_match';
  const noEvidenceReason = parserStatus === 'main_model_parse_failed'
    || parserStatus === 'main_model_error'
    || parserStatus === 'session_fallback'
    ? 'parser_uncertain'
    : 'no_temporal_evidence';
  const targetSpeaker = temporalIntent?.searchRole === 'user'
    ? 'User'
    : temporalIntent?.searchRole === 'model'
      ? 'Kumiko'
      : session?.targetSpeaker || 'Any';

  return {
      promptBlock:
`[EXACT_HISTORY_LOOKUP]
Lookup_Mode: TEMPORAL_WINDOW
Target_Range_JST: ${rangeText}
Target_Speaker: ${targetSpeaker}
Parser_Status: ${parserStatus}
Parser_Source: ${parserSource || 'unknown'}
Parser_Precision: ${parserPrecision || 'unknown'}
Parser_Confidence: ${parserConfidence || 'unknown'}
Source_Query: ${queryText}
${buildMemoryNoEvidenceDecisionHeader('low', getNoEvidenceResponseStrategy(parserStatus, parserConfidence))}
Answer_Boundary: ${noEvidenceReason === 'parser_uncertain' ? 'DO_NOT_CLAIM_THE_RESOLVED_WINDOW_IS_EMPTY; ONLY SAY THE WINDOW COULD NOT BE RELIABLY PINNED DOWN.' : 'NO_MATCH_FOUND_IN_THE_RESOLVED_WINDOW.'}
Result: ${noEvidenceReason === 'parser_uncertain' ? 'TEMPORAL_PARSER_UNCERTAIN' : 'NO_TEMPORAL_EVIDENCE'}`,
    found: false,
    strict: true,
    mode: 'temporal_window',
    targetSpeaker,
    rangeJst: rangeText,
    parserStatus,
    parserSource,
    parserPrecision,
    parserConfidence,
    matchedCount: 0,
    evidenceMode: 'none',
    confidenceLevel: 'low',
    rawSupportCount: 0,
    responseStrategy: getNoEvidenceResponseStrategy(parserStatus, parserConfidence),
  };
};

export const isLikelyTemporalHistoryQuery = (text: string) => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  const temporalMarkers = /(?:昨天|前天|今天|那天|那次|刚才|之前|当时|最开始|一开始|最初|开头|上周|上个月|\d{1,2}\s*月|\d{1,2}\s*[号日]|\d{1,2}\s*点|\d{1,2}\s*分|凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|深夜|yesterday|today|last night|last week|that time|earlier|before|at \d{1,2}(?::\d{2})?|\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2})/iu;
  const recallMarkers = /(?:记得|还记得|来着|说了什么|聊了什么|提到什么|做什么|什么内容|哪天|什么时候|几点|我说|你说|久美子说|what did|when did|do you remember|remember when|talked about|said)/iu;
  return temporalMarkers.test(normalized) && recallMarkers.test(normalized);
};

export const isLikelyHistoricalRecallQuery = (text: string) => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  const recallMarkers = /(?:记得|还记得|来着|说了什么|聊了什么|提到什么|做什么|什么内容|哪天|什么时候|几点|我说|我发|你说|你发|久美子说|久美子发|我们聊|那次|那天|之前|当时|最开始|一开始|最初|开头|第一个话题|第一句|第一条|what did|when did|do you remember|remember when|talked about|said)/iu;
  const timeMarkers = /(?:昨天|前天|今天|刚才|之前|当时|上次|上周|上个月|\d{1,2}\s*月|\d{1,2}\s*[号日]|\d{1,2}\s*点|\d{1,2}\s*分|凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|深夜|大约|大概|差不多|左右|yesterday|today|last night|last week|that time|earlier|before|around|about|at \d{1,2}(?::\d{2})?|\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2})/iu;

  if (/(?:最开始|一开始|最初|开头|第一个话题|第一句|第一条)/u.test(normalized) && recallMarkers.test(normalized)) {
    return true;
  }

  return recallMarkers.test(normalized) && timeMarkers.test(normalized);
};

export const isLikelyHistoricalFollowUp = (text: string) => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (isLikelyHistoricalRecallQuery(normalized) || isLikelyTemporalHistoryQuery(normalized)) {
    return false;
  }

  const followUpPrefixes = /^(?:再试一次|再来一次|再想想|再确认一下|那大概|那大致|那大约|那可能|那应该|那如果|那、|那，|那 |可能是美国时间|应该是美国时间|美国时间|前后(?:\s*\d+\s*分钟?)?|我是说|可能是|应该是|大概|大约|差不多|左右|前后五分钟|前后5分钟|那大致的话题|那大概的话题|那话题呢|那内容呢|那后来呢)/u;
  const refinementSignals = /(?:美国时间|前后\s*\d+\s*分钟?|左右|大概|大约|差不多|\d{1,2}\s*月|\d{1,2}\s*[号日]|\d{1,2}\s*点|\d{1,2}\s*分|凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|深夜|那个时间|那个时候|那会儿|那时候|那段|那次|那话题|那内容)/u;
  const shortContinuation = /^(?:再试一次嘛?|再想想嘛?|再确认一下嘛?|可能是.+|应该是.+|那大致的话题呢?|那大概的话题呢?|那内容呢?|那后来呢?|前后(?:\s*\d+\s*分钟?)?|美国时间(?:的)?|我是说.+)$/u;
  return followUpPrefixes.test(normalized)
    || shortContinuation.test(normalized)
    || (normalized.length <= 40 && refinementSignals.test(normalized));
};

export const isLikelyHistoricalSessionCarry = (text: string) => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (isLikelyHistoricalRecallQuery(normalized) || isLikelyTemporalHistoryQuery(normalized)) {
    return false;
  }

  const carryPatterns = /(?:再试一次|再想想|再确认|可能是|应该是|美国时间|前后(?:\s*\d+\s*分钟?)?|左右|大概|大约|差不多|那个时间|那时候|那会儿|那段|那次|那话题|那内容|后来呢|然后呢|所以呢|呢\??|吗\??|嘛\??)$/u;
  if (carryPatterns.test(normalized)) return true;

  return normalized.length <= 18 && /[?？吗嘛呢呀啊]$/u.test(normalized);
};

export const isMemoryQuerySessionActive = (session: MemoryQuerySession | null) => {
  return !!session && (Date.now() - session.lastUsedAt) <= HISTORICAL_QUERY_SESSION_MAX_IDLE_MS;
};

const TOPIC_FALLBACK_STOP_WORDS = new Set([
  '关于', '什么', '怎么', '我们', '你们', '他们', '她们', '那个', '这个',
  '聊过', '说过', '讨论', '记得', '话题', '内容', '对话', '还有', '然后',
  '之前', '以前', '最近', '这些', '那些', '觉得', '知道', '想起', '回忆',
  '时候', '就是', '可以', '没有', '不是', '为什么', '怎么样', '是不是',
]);

export const extractTopicFallbackKeywords = (text: string): string[] | undefined => {
  const cjkSegments = text.match(/[\u4e00-\u9fa5]{2,6}/g);
  if (!cjkSegments || cjkSegments.length === 0) return undefined;
  const keywords = cjkSegments.filter(w => !TOPIC_FALLBACK_STOP_WORDS.has(w));
  return keywords.length > 0 ? keywords : undefined;
};

const isStableTemporalParserStatus = (status?: TemporalQueryDiagnosticsStatus | null) => (
  status === 'heuristic_success'
  || status === 'main_model_success'
  || status === 'heuristic_fallback_after_model_failure'
  || status === 'session_fallback'
);

export const isReusableHistoricalSession = (session: MemoryQuerySession | null) => {
  if (!isMemoryQuerySessionActive(session)) return false;
  if (!session) return false;
  if (session.kind !== 'temporal_history') return true;
  return isStableTemporalParserStatus(session.parserStatus)
    && session.parserConfidence !== 'low'
    && typeof session.startTimestampJST === 'number'
    && typeof session.endTimestampJST === 'number';
};

export const normalizeMemoryQuerySession = (raw: unknown): MemoryQuerySession | null => {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = raw as Partial<MemoryQuerySession>;

  const kind = parsed.kind === 'exact_history' || parsed.kind === 'temporal_history' || parsed.kind === 'topic_search'
    ? parsed.kind
    : null;
  const lookupMode = parsed.lookupMode === 'session_start'
    || parsed.lookupMode === 'exact_timestamp'
    || parsed.lookupMode === 'temporal_window'
    ? parsed.lookupMode
    : null;
  const targetSpeaker = parsed.targetSpeaker === 'User'
    || parsed.targetSpeaker === 'Kumiko'
    || parsed.targetSpeaker === 'Any'
    || parsed.targetSpeaker === null
    ? parsed.targetSpeaker
    : null;
  const searchRole = parsed.searchRole === 'user'
    || parsed.searchRole === 'model'
    || parsed.searchRole === 'any'
    || parsed.searchRole === null
    || parsed.searchRole === undefined
    ? (parsed.searchRole ?? null)
    : null;
  const parserSource = parsed.parserSource === 'local_heuristic'
    || parsed.parserSource === 'main_model'
    || parsed.parserSource === null
    || parsed.parserSource === undefined
    ? (parsed.parserSource ?? null)
    : null;
  const parserPrecision = parsed.parserPrecision === 'exact_minute'
    || parsed.parserPrecision === 'approximate_minutes'
    || parsed.parserPrecision === 'hour_window'
    || parsed.parserPrecision === 'day_window'
    || parsed.parserPrecision === null
    || parsed.parserPrecision === undefined
    ? (parsed.parserPrecision ?? null)
    : null;
  const parserConfidence = parsed.parserConfidence === 'high'
    || parsed.parserConfidence === 'medium'
    || parsed.parserConfidence === 'low'
    || parsed.parserConfidence === null
    || parsed.parserConfidence === undefined
    ? (parsed.parserConfidence ?? null)
    : null;
  const parserStatus = parsed.parserStatus === 'heuristic_success'
    || parsed.parserStatus === 'main_model_success'
    || parsed.parserStatus === 'heuristic_fallback_after_model_failure'
    || parsed.parserStatus === 'main_model_parse_failed'
    || parsed.parserStatus === 'main_model_error'
    || parsed.parserStatus === 'session_fallback'
    || parsed.parserStatus === 'no_match'
    || parsed.parserStatus === null
    || parsed.parserStatus === undefined
    ? (parsed.parserStatus ?? null)
    : null;
  const lastEvidenceSource = parsed.lastEvidenceSource === 'raw_messages'
    || parsed.lastEvidenceSource === 'episodes'
    || parsed.lastEvidenceSource === 'none'
    || parsed.lastEvidenceSource === undefined
    ? parsed.lastEvidenceSource
    : undefined;
  const confidenceLevel = parsed.confidenceLevel === 'high'
    || parsed.confidenceLevel === 'medium'
    || parsed.confidenceLevel === 'low'
    || parsed.confidenceLevel === undefined
    ? parsed.confidenceLevel
    : undefined;
  const startTimestampJST = typeof parsed.startTimestampJST === 'number' && Number.isFinite(parsed.startTimestampJST)
    ? parsed.startTimestampJST
    : null;
  const endTimestampJST = typeof parsed.endTimestampJST === 'number' && Number.isFinite(parsed.endTimestampJST)
    ? parsed.endTimestampJST
    : null;

  if (
    !kind
    || !lookupMode
    || typeof parsed.sourceQuery !== 'string'
    || !parsed.sourceQuery.trim()
    || typeof parsed.resultCount !== 'number'
    || !Number.isFinite(parsed.resultCount)
    || typeof parsed.createdAt !== 'number'
    || !Number.isFinite(parsed.createdAt)
    || typeof parsed.lastUsedAt !== 'number'
    || !Number.isFinite(parsed.lastUsedAt)
  ) {
    return null;
  }

  const normalized: MemoryQuerySession = {
    kind,
    sourceQuery: parsed.sourceQuery.trim(),
    lookupMode,
    targetSpeaker,
    searchRole,
    startTimestampJST,
    endTimestampJST,
    parserSource,
    parserPrecision,
    parserConfidence,
    parserStatus,
    resultCount: Math.max(0, Math.floor(parsed.resultCount)),
    lastEvidenceSource,
    confidenceLevel,
    createdAt: parsed.createdAt,
    lastUsedAt: parsed.lastUsedAt,
  };

  return isMemoryQuerySessionActive(normalized) ? normalized : null;
};

export const buildHistoricalRecallQueryContext = (
  messages: Message[],
  currentText: string,
  session: MemoryQuerySession | null
): HistoricalRecallContextResolution => {
  const normalizedCurrent = currentText.replace(/\s+/g, ' ').trim();
  if (!normalizedCurrent) {
    return {
      queryText: normalizedCurrent,
      source: 'self',
      usedSession: false,
      previousQueryPreview: null,
      sessionReuseBlockedReason: null,
    };
  }

  if (isLikelyHistoricalRecallQuery(normalizedCurrent) || isLikelyTemporalHistoryQuery(normalizedCurrent)) {
    return {
      queryText: normalizedCurrent,
      source: 'self',
      usedSession: false,
      previousQueryPreview: null,
      sessionReuseBlockedReason: null,
    };
  }

  const isFollowUp = isLikelyHistoricalFollowUp(normalizedCurrent);
  const sessionActive = isMemoryQuerySessionActive(session);
  const sessionReusable = isReusableHistoricalSession(session);
  const sessionReuseBlockedReason = sessionActive && !sessionReusable && session?.kind === 'temporal_history'
    ? 'unstable_temporal_session'
    : null;
  if (!isFollowUp) {
    if (sessionReusable && isLikelyHistoricalSessionCarry(normalizedCurrent)) {
      return {
        queryText: `${session.sourceQuery}\n${normalizedCurrent}`,
        source: 'session',
        usedSession: true,
        previousQueryPreview: session.sourceQuery.slice(0, 160),
        sessionReuseBlockedReason: null,
      };
    }
    return {
      queryText: normalizedCurrent,
      source: 'self',
      usedSession: false,
      previousQueryPreview: null,
      sessionReuseBlockedReason,
    };
  }

  if (sessionReusable) {
    return {
      queryText: `${session.sourceQuery}\n${normalizedCurrent}`,
      source: 'session',
      usedSession: true,
      previousQueryPreview: session.sourceQuery.slice(0, 160),
      sessionReuseBlockedReason: null,
    };
  }

  if (sessionReuseBlockedReason) {
    return {
      queryText: normalizedCurrent,
      source: 'self',
      usedSession: false,
      previousQueryPreview: null,
      sessionReuseBlockedReason,
    };
  }

  const recentUserMessages = messages
    .filter(message => message.role === 'user' && !!message.text)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 6);

  const previousHistoryQuery = recentUserMessages.find(message => {
    const normalized = message.text.replace(/\s+/g, ' ').trim();
    return normalized !== normalizedCurrent && (isLikelyHistoricalRecallQuery(normalized) || isLikelyTemporalHistoryQuery(normalized));
  });

  if (!previousHistoryQuery) {
    return {
      queryText: normalizedCurrent,
      source: 'self',
      usedSession: false,
      previousQueryPreview: null,
      sessionReuseBlockedReason: null,
    };
  }

  return {
    queryText: `${previousHistoryQuery.text}\n${normalizedCurrent}`,
    source: 'recent_user',
    usedSession: false,
    previousQueryPreview: previousHistoryQuery.text.slice(0, 160),
    sessionReuseBlockedReason: null,
  };
};

export const buildSingleRebuildEntry = (message: Message) => {
  const prefix = message.role === 'user' ? 'User: ' : 'Kumiko: ';
  return `【Time: ${formatJstTimeForRag(message.timestamp)}】\n${prefix}${message.text}`;
};

export const buildFragmentRebuildEntry = (messages: Message[]) => {
  const startTime = formatJstTimeForRag(messages[0].timestamp);
  const endTime = formatJstTimeForRag(messages[messages.length - 1].timestamp);
  const header = startTime === endTime
    ? `【Time: ${startTime}】`
    : `【Time: ${startTime} -> ${endTime}】`;

  const body = messages.map(message => {
    const prefix = message.role === 'user' ? 'User: ' : 'Kumiko: ';
    return `${prefix}${message.text}`;
  }).join('\n');

  return `${header}\n${body}`;
};

export const getMessageCharCount = (message: Message) => Array.from(message.text?.trim?.() || '').length;

export const isRebuildFragmentFriendlyMessage = (message: Message) => {
  const text = message.text?.trim?.() || '';
  if (!text) return false;
  if (getMessageCharCount(message) > REBUILD_FRAGMENT_MAX_CHAR_LENGTH) return false;
  return !REBUILD_FRAGMENT_BLOCK_PATTERNS.some(pattern => pattern.test(text));
};

export const mapRagDecisionTierToStorageTier = (tier: 'core' | 'episodic' | 'background' | 'discard') => {
  if (tier === 'background') return 'background' as const;
  if (tier === 'episodic') return 'episodic' as const;
  return 'core' as const;
};

export const dotSimilarity = (left: Float32Array, right: Float32Array): number => {
  const size = Math.min(left.length, right.length);
  let dot = 0;
  for (let index = 0; index < size; index += 1) {
    dot += left[index] * right[index];
  }
  return dot;
};

export const hasRichSemanticText = (text: string): boolean => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  const cjkCount = (normalized.match(/[\u4e00-\u9fff]/gu) || []).length;
  const latinWordCount = normalized.split(/\s+/).filter(token => /[A-Za-z]/.test(token)).length;

  return cjkCount >= 6 || latinWordCount >= 3 || normalized.length >= 10;
};

const formatTemporalEpisodeRange = (startTimestamp: number, endTimestamp: number) => {
  const start = formatJstTimeForRag(startTimestamp);
  const end = formatJstTimeForRag(endTimestamp);
  return start === end ? start : `${start} -> ${end}`;
};
