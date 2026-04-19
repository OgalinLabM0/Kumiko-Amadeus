import { Language, Message, SummaryArchiveState, SummaryBoundaryReason, SummarySegmentMetadata } from '../../types';

export const SUMMARY_SOFT_THRESHOLD = 15;
export const SUMMARY_HARD_THRESHOLD = 24;

const SUMMARY_FALLBACK_MESSAGE_LIMIT = 48;
const LONG_GAP_MINUTES = 90;
const SUMMARY_SEMANTIC_PREVIOUS_USER_WINDOW = 4;
const SUMMARY_SEMANTIC_RECENT_USER_WINDOW = 2;
const SUMMARY_SEMANTIC_MIN_USER_MESSAGES = 6;
const SUMMARY_CONTINUATION_TAIL_MESSAGE_COUNT = 6;
const SUMMARY_CONTINUATION_CURRENT_USER_WINDOW = 2;
const SUMMARY_RECENT_SEGMENT_LIMIT = 6;
const SUMMARY_BUFFER_SEGMENT_LIMIT = 3;

const WRAP_UP_PATTERNS = [
  /(?:先这样|先到这|今天先这样|回头再说|晚点聊|下次再聊|先不说了|先去忙|我先撤|先撤啦|拜拜|晚安|睡了|我要睡了)/u,
  /\b(?:talk later|later then|good night|goodnight|gotta sleep|going to sleep|catch you later|let's stop here)\b/i,
];

const TOPIC_SHIFT_PATTERNS = [
  /^(?:对了|另外|顺便|说起来|再问个|换个话题|还有个事|对啦)/u,
  /^(?:by the way|anyway|on another note|one more thing|speaking of which|also)\b/i,
];

export type SummaryBoundaryPlacement = 'before-current-turn' | 'after-current-turn';

export interface SummaryBoundaryDecision {
  shouldSummarize: boolean;
  placement: SummaryBoundaryPlacement;
  reason: SummaryBoundaryReason | null;
  isComplete: boolean;
  turnsInSegment: number;
}

export interface SummarySemanticSignal {
  shouldTrigger: boolean;
  recentSimilarity: number;
  currentSimilarity: number | null;
  weightedSimilarity: number;
  driftScore: number;
}

export interface SummarySemanticWindowPayload {
  previousWindowText: string;
  recentWindowText: string;
  currentUserText: string;
  previousUserCount: number;
  recentUserCount: number;
}

export interface SummaryContinuationPayload {
  carryoverText: string;
  currentText: string;
  carryoverUserCount: number;
  currentUserCount: number;
}

const clampTurn = (value: unknown, fallback: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
};

const normalizeSummarySegmentMetadata = (raw: unknown): SummarySegmentMetadata | null => {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = raw as Partial<SummarySegmentMetadata>;

  if (
    typeof parsed.segmentId !== 'string' ||
    !parsed.segmentId.trim() ||
    typeof parsed.segmentStartTime !== 'number' ||
    !Number.isFinite(parsed.segmentStartTime) ||
    typeof parsed.segmentEndTime !== 'number' ||
    !Number.isFinite(parsed.segmentEndTime) ||
    typeof parsed.summaryCompletedTime !== 'number' ||
    !Number.isFinite(parsed.summaryCompletedTime) ||
    typeof parsed.isComplete !== 'boolean' ||
    typeof parsed.topicLabel !== 'string' ||
    typeof parsed.summaryText !== 'string'
  ) {
    return null;
  }

  return {
    segmentId: parsed.segmentId.trim(),
    segmentStartTime: parsed.segmentStartTime,
    segmentEndTime: parsed.segmentEndTime,
    summaryCompletedTime: parsed.summaryCompletedTime,
    isComplete: parsed.isComplete,
    topicLabel: parsed.topicLabel.trim(),
    summaryText: parsed.summaryText,
  };
};

const normalizeRecentSummarySegments = (raw: unknown): SummarySegmentMetadata[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeSummarySegmentMetadata)
    .filter((segment): segment is SummarySegmentMetadata => !!segment)
    .slice(-SUMMARY_RECENT_SEGMENT_LIMIT);
};

export const buildSummarySegmentId = (
  segmentStartTime: number,
  segmentStartMessageId?: string | null,
  summaryCompletedTime?: number
) => {
  const startPart = Number.isFinite(segmentStartTime) ? Math.floor(segmentStartTime) : Date.now();
  const endPart = Number.isFinite(summaryCompletedTime ?? NaN) ? Math.floor(summaryCompletedTime as number) : Date.now();
  const anchor = segmentStartMessageId && segmentStartMessageId.trim()
    ? segmentStartMessageId.trim()
    : `turn-${startPart}`;
  return `summary-${anchor}-${endPart}`;
};

export const appendRecentSummarySegment = (
  archiveState: SummaryArchiveState,
  segment: SummarySegmentMetadata
): SummarySegmentMetadata[] => {
  const currentSegments = Array.isArray(archiveState.recentSummarySegments)
    ? archiveState.recentSummarySegments
    : [];

  const withoutDuplicate = currentSegments.filter(existing => existing.segmentId !== segment.segmentId);
  return [...withoutDuplicate, segment].slice(-SUMMARY_RECENT_SEGMENT_LIMIT);
};

export const buildRecentSummaryBuffer = (
  segments: SummarySegmentMetadata[],
  fallbackSummary: string
) => {
  const normalizedSegments = Array.isArray(segments)
    ? segments.filter(segment => typeof segment.summaryText === 'string' && segment.summaryText.trim())
    : [];

  if (normalizedSegments.length === 0) {
    return fallbackSummary;
  }

  return normalizedSegments
    .slice(-SUMMARY_BUFFER_SEGMENT_LIMIT)
    .map(segment => segment.summaryText.trim())
    .join('\n\n');
};

export const resolveCoreMemoryFromSummaryArchive = (
  archiveState: SummaryArchiveState | null | undefined,
  fallbackSummary: string
) => {
  const recentSegments = Array.isArray(archiveState?.recentSummarySegments)
    ? archiveState.recentSummarySegments
    : [];

  return buildRecentSummaryBuffer(recentSegments, fallbackSummary);
};

export const createInitialSummaryArchiveState = (turnCount: number): SummaryArchiveState => ({
  segmentStartTurn: Math.max(0, Math.floor(turnCount || 0)),
  segmentStartMessageId: null,
  activeSegmentId: `summary-active-${Math.max(0, Math.floor(turnCount || 0))}`,
  carryoverStartMessageId: null,
  carryoverEndMessageId: null,
  pendingSinceTurn: null,
  lastBoundaryReason: null,
  lastBoundaryAt: null,
  recentSummarySegments: [],
});

export const normalizeSummaryArchiveState = (raw: unknown, turnCount: number): SummaryArchiveState => {
  const fallback = createInitialSummaryArchiveState(turnCount);
  if (!raw || typeof raw !== 'object') return fallback;

  const parsed = raw as Partial<SummaryArchiveState>;
  const segmentStartTurn = Math.min(clampTurn(parsed.segmentStartTurn, fallback.segmentStartTurn), Math.max(0, turnCount));
  const pendingSinceTurnRaw = parsed.pendingSinceTurn;
  const pendingSinceTurn = pendingSinceTurnRaw === null || pendingSinceTurnRaw === undefined
    ? null
    : Math.max(segmentStartTurn, Math.min(clampTurn(pendingSinceTurnRaw, segmentStartTurn), Math.max(0, turnCount)));

  const lastBoundaryReason = typeof parsed.lastBoundaryReason === 'string' && [
    'topic_shift',
    'semantic_shift',
    'long_gap',
    'reminder_created',
    'sleep_transition',
    'wrap_up',
    'hard_limit',
    'manual',
  ].includes(parsed.lastBoundaryReason)
    ? parsed.lastBoundaryReason
    : null;

  return {
    segmentStartTurn,
    segmentStartMessageId: typeof parsed.segmentStartMessageId === 'string' && parsed.segmentStartMessageId.trim()
      ? parsed.segmentStartMessageId
      : null,
    activeSegmentId: typeof parsed.activeSegmentId === 'string' && parsed.activeSegmentId.trim()
      ? parsed.activeSegmentId
      : fallback.activeSegmentId,
    carryoverStartMessageId: typeof parsed.carryoverStartMessageId === 'string' && parsed.carryoverStartMessageId.trim()
      ? parsed.carryoverStartMessageId
      : null,
    carryoverEndMessageId: typeof parsed.carryoverEndMessageId === 'string' && parsed.carryoverEndMessageId.trim()
      ? parsed.carryoverEndMessageId
      : null,
    pendingSinceTurn,
    lastBoundaryReason,
    lastBoundaryAt: typeof parsed.lastBoundaryAt === 'number' && Number.isFinite(parsed.lastBoundaryAt)
      ? parsed.lastBoundaryAt
      : null,
    recentSummarySegments: normalizeRecentSummarySegments(parsed.recentSummarySegments),
  };
};

export const getTurnsInActiveSummarySegment = (
  currentTurnCount: number,
  archiveState: SummaryArchiveState
) => Math.max(0, currentTurnCount - archiveState.segmentStartTurn);

export const getArchivedSummaryProgressText = (
  archiveState: SummaryArchiveState,
  currentTurnCount: number,
  language: Language
) => {
  const turnsInSegment = getTurnsInActiveSummarySegment(currentTurnCount, archiveState);
  if (turnsInSegment < SUMMARY_SOFT_THRESHOLD) {
    return language === 'zh'
      ? `积累中 ${turnsInSegment}/${SUMMARY_SOFT_THRESHOLD}`
      : `BUILDING ${turnsInSegment}/${SUMMARY_SOFT_THRESHOLD}`;
  }
  if (turnsInSegment >= SUMMARY_HARD_THRESHOLD - 2) {
    return language === 'zh'
      ? `临界 ${turnsInSegment}/${SUMMARY_HARD_THRESHOLD}`
      : `URGENT ${turnsInSegment}/${SUMMARY_HARD_THRESHOLD}`;
  }
  return language === 'zh'
    ? `待切段 ${turnsInSegment}/${SUMMARY_HARD_THRESHOLD}`
    : `READY ${turnsInSegment}/${SUMMARY_HARD_THRESHOLD}`;
};

const normalizeBoundaryText = (text: string) => text.replace(/\s+/g, ' ').trim();
const stripQuotedReplyPrefix = (text: string) => text.replace(/^>\s[^\n]*(?:\r?\n)+/u, '');
const normalizeSemanticText = (text: string) => normalizeBoundaryText(stripQuotedReplyPrefix(text));

const matchesAnyPattern = (text: string, patterns: RegExp[]) => patterns.some(pattern => pattern.test(text));
const getMessageSliceByIds = (messages: Message[], startMessageId: string, endMessageId: string) => {
  const startIndex = messages.findIndex(message => message.id === startMessageId);
  const endIndex = messages.findIndex(message => message.id === endMessageId);

  if (startIndex < 0 || endIndex < startIndex) {
    return [];
  }

  return messages.slice(startIndex, endIndex + 1);
};

export const getSummarySemanticWindowPayload = (
  messages: Message[],
  archiveState: SummaryArchiveState,
  endBeforeMessageId?: string | null
): SummarySemanticWindowPayload | null => {
  const segmentMessages = getSummarySegmentMessages(messages, archiveState, endBeforeMessageId);
  const userTexts = segmentMessages
    .filter(message => message.role === 'user' && !message.isHidden)
    .map(message => normalizeSemanticText(message.text))
    .filter(Boolean);

  if (userTexts.length < SUMMARY_SEMANTIC_MIN_USER_MESSAGES) {
    return null;
  }

  const recentUserTexts = userTexts.slice(-SUMMARY_SEMANTIC_RECENT_USER_WINDOW);
  const previousUserTexts = userTexts.slice(
    -(SUMMARY_SEMANTIC_RECENT_USER_WINDOW + SUMMARY_SEMANTIC_PREVIOUS_USER_WINDOW),
    -SUMMARY_SEMANTIC_RECENT_USER_WINDOW
  );

  if (recentUserTexts.length < SUMMARY_SEMANTIC_RECENT_USER_WINDOW || previousUserTexts.length < 3) {
    return null;
  }

  return {
    previousWindowText: previousUserTexts.join('\n'),
    recentWindowText: recentUserTexts.join('\n'),
    currentUserText: recentUserTexts[recentUserTexts.length - 1],
    previousUserCount: previousUserTexts.length,
    recentUserCount: recentUserTexts.length,
  };
};

export const evaluateSummaryBoundary = ({
  currentTurnCount,
  archiveState,
  userText,
  gapMinutes,
  createdReminder,
  activatedSleepMode,
  semanticSignal,
}: {
  currentTurnCount: number;
  archiveState: SummaryArchiveState;
  userText: string;
  gapMinutes: number;
  createdReminder: boolean;
  activatedSleepMode: boolean;
  semanticSignal?: SummarySemanticSignal | null;
}): SummaryBoundaryDecision => {
  const turnsInSegment = getTurnsInActiveSummarySegment(currentTurnCount, archiveState);
  if (turnsInSegment < SUMMARY_SOFT_THRESHOLD) {
    return {
      shouldSummarize: false,
      placement: 'after-current-turn',
      reason: null,
      isComplete: true,
      turnsInSegment,
    };
  }

  const normalizedUserText = normalizeBoundaryText(userText);

  if (turnsInSegment >= SUMMARY_HARD_THRESHOLD) {
    return {
      shouldSummarize: true,
      placement: 'after-current-turn',
      reason: 'hard_limit',
      isComplete: false,
      turnsInSegment,
    };
  }

  if (Number.isFinite(gapMinutes) && gapMinutes >= LONG_GAP_MINUTES) {
    return {
      shouldSummarize: true,
      placement: 'before-current-turn',
      reason: 'long_gap',
      isComplete: true,
      turnsInSegment: Math.max(0, turnsInSegment - 1),
    };
  }

  if (matchesAnyPattern(normalizedUserText, TOPIC_SHIFT_PATTERNS)) {
    return {
      shouldSummarize: true,
      placement: 'before-current-turn',
      reason: 'topic_shift',
      isComplete: true,
      turnsInSegment: Math.max(0, turnsInSegment - 1),
    };
  }

  if (createdReminder) {
    return {
      shouldSummarize: true,
      placement: 'after-current-turn',
      reason: 'reminder_created',
      isComplete: true,
      turnsInSegment,
    };
  }

  if (activatedSleepMode) {
    return {
      shouldSummarize: true,
      placement: 'after-current-turn',
      reason: 'sleep_transition',
      isComplete: true,
      turnsInSegment,
    };
  }

  if (matchesAnyPattern(normalizedUserText, WRAP_UP_PATTERNS)) {
    return {
      shouldSummarize: true,
      placement: 'after-current-turn',
      reason: 'wrap_up',
      isComplete: true,
      turnsInSegment,
    };
  }

  if (semanticSignal?.shouldTrigger) {
    return {
      shouldSummarize: true,
      placement: 'before-current-turn',
      reason: 'semantic_shift',
      isComplete: true,
      turnsInSegment: Math.max(0, turnsInSegment - 1),
    };
  }

  return {
    shouldSummarize: false,
    placement: 'after-current-turn',
    reason: null,
    isComplete: true,
    turnsInSegment,
  };
};

export const getSummarySegmentMessages = (
  messages: Message[],
  archiveState: SummaryArchiveState,
  endBeforeMessageId?: string | null
) => {
  const startIndex = archiveState.segmentStartMessageId
    ? messages.findIndex(message => message.id === archiveState.segmentStartMessageId)
    : -1;

  const fallbackStart = Math.max(0, messages.length - SUMMARY_FALLBACK_MESSAGE_LIMIT);
  const sliceStart = startIndex >= 0 ? startIndex : fallbackStart;
  let segmentMessages = messages.slice(sliceStart);

  if (endBeforeMessageId) {
    const endIndex = segmentMessages.findIndex(message => message.id === endBeforeMessageId);
    if (endIndex >= 0) {
      segmentMessages = segmentMessages.slice(0, endIndex);
    }
  }

  return segmentMessages;
};

export const getSummaryContinuationCarryoverState = (segmentMessages: Message[]) => {
  if (segmentMessages.length < 2) {
    return {
      carryoverStartMessageId: null,
      carryoverEndMessageId: null,
    };
  }

  const carryoverStartIndex = Math.max(0, segmentMessages.length - SUMMARY_CONTINUATION_TAIL_MESSAGE_COUNT);
  return {
    carryoverStartMessageId: segmentMessages[carryoverStartIndex]?.id ?? null,
    carryoverEndMessageId: segmentMessages[segmentMessages.length - 1]?.id ?? null,
  };
};

export const getSummaryContinuationPayload = (
  messages: Message[],
  archiveState: SummaryArchiveState
): SummaryContinuationPayload | null => {
  if (!archiveState.carryoverStartMessageId || !archiveState.carryoverEndMessageId) {
    return null;
  }

  const carryoverMessages = getMessageSliceByIds(
    messages,
    archiveState.carryoverStartMessageId,
    archiveState.carryoverEndMessageId
  );
  if (carryoverMessages.length === 0) {
    return null;
  }

  const carryoverEndIndex = messages.findIndex(message => message.id === archiveState.carryoverEndMessageId);
  if (carryoverEndIndex < 0) {
    return null;
  }

  const currentMessages = messages.slice(carryoverEndIndex + 1);
  const carryoverUserTexts = carryoverMessages
    .filter(message => message.role === 'user' && !message.isHidden)
    .map(message => normalizeSemanticText(message.text))
    .filter(Boolean);
  const currentUserTexts = currentMessages
    .filter(message => message.role === 'user' && !message.isHidden)
    .map(message => normalizeSemanticText(message.text))
    .filter(Boolean);

  if (carryoverUserTexts.length === 0 || currentUserTexts.length === 0) {
    return null;
  }

  const currentSample = currentUserTexts.slice(0, SUMMARY_CONTINUATION_CURRENT_USER_WINDOW);

  return {
    carryoverText: carryoverUserTexts.join('\n'),
    currentText: currentSample.join('\n'),
    carryoverUserCount: carryoverUserTexts.length,
    currentUserCount: currentSample.length,
  };
};
