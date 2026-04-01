
import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { SystemToast } from './SystemToast';
import { AppFlowScreens } from './app/AppFlowScreens';
import { AppMainView } from './app/AppMainView';
import { DiaryBackfillDialog as DiaryBackfillDialogLazy } from './DiaryBackfillDialog';
import { buildAppMainViewProps } from './app/buildAppMainViewProps';
import { getAppShellStyles } from './app/appShellStyles';
import { buildBackupData, validateBackupData } from './app/backupData';
import {
  createInitialSummaryArchiveState,
  appendRecentSummarySegment,
  buildSummarySegmentId,
  buildRecentSummaryBuffer,
  resolveCoreMemoryFromSummaryArchive,
  evaluateSummaryBoundary,
  getArchivedSummaryProgressText,
  getSummaryContinuationCarryoverState,
  getSummaryContinuationPayload,
  getSummarySegmentMessages,
  getSummarySemanticWindowPayload,
  getTurnsInActiveSummarySegment,
  normalizeSummaryArchiveState,
  SUMMARY_SOFT_THRESHOLD,
  SummarySemanticSignal,
} from './app/summaryCycle';
import { ExtendedSyncStatus } from './SyncStatus'; 
import { useAutoSave } from '../hooks/useAutoSave'; 
import { LoadingDataScreen } from './app/AppStatusOverlays';
import { Message, AppState, AppUpdateState, EmotionType, WorldBookEntry, Language, LocationConfig, BackupConfig, AnchorEntry, AIConfig, ChatResponse, SummaryArchiveState, SummaryBoundaryReason, MemoryQuerySession, TemporalQueryPrecision, TemporalQuerySource, TemporalQueryDiagnosticsStatus, TemporalQueryConfidence, SummarySegmentMetadata, TtsConfig, VoiceMode } from '../types';
import { sendMessageToGemini, startChat, summarizeConversation, searchRagMemory, saveRagMemory, uploadImageToBackend, getCurrentAIConfig, analyzeTemporalQueryDetailed, getTemporalSearchRoleFromQuery, rewriteHistoricalRecallQueryDetailed, callLLMRaw, type HistoricalQueryRewrite, type HistoricalSearchStrategy, type TemporalQueryAnalysis, type TemporalQueryDiagnostics } from '../services/geminiService';
import { DEFAULT_WORLD_BOOK, UI_TRANSLATIONS, DEFAULT_LOCATION_CONFIG, LOCALIZED_WORLD_BOOK, KUMIKO_LOCAL_RAG_ZH, EMOTION_TO_FISH_AUDIO_TAGS, EMOTION_TTS_TEMPERATURE, DEFAULT_TTS_CONFIG } from '../constants';
import { synthesizeSpeech, TtsError } from '../services/fishAudioService';
import { saveVoiceFile, isVoiceServiceAvailable, isBuiltInRingtoneId, isCustomRingtoneId } from '../services/voiceFileService';
import { VoiceCallOverlay } from './VoiceCallOverlay';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { imageService, compressAndSaveImage, getImageBase64 } from '../services/imageService';
import { generateEmbedding, getAllVectors, loadRawHistoryMessagesFromMain, saveLocalRagMemory, restoreVectors, searchLocalRagMemory, searchLocalRagMemoryDetailed, startLocalRagRebuild, subscribeLocalRagRebuild, syncRawHistoryMessagesToMain, type LocalRagEntryKind, type LocalRagEvidenceStrength, type LocalRagRebuildEvent } from '../services/localRagService';
import { evaluateRagMemoryCandidate, hasRecentRagDuplicate } from '../services/ragMemoryFilter';
import {
  db,
  INITIAL_WORLD_CHARACTER_STATUS,
  type DailyFragmentEntity,
  type EpisodeEntity,
  type KumikoDiaryEntity,
  type MessageEntity,
  type PsycheStateEntity,
  type WorldCharacterStatusMap
} from '../services/db';
import { CLOUD_SYNC_AVAILABLE, DEFAULT_BACKUP_CONFIG, normalizeBackupConfig } from '../services/appConfig';
import { loadTemporalEpisodesForRange, syncTemporalEpisodes } from '../services/temporalEpisodeService';
import {
  parseDesktopBackupImportFile,
  getDesktopBackupFileInfo,
  isDesktopElectron,
  pickDesktopBackupOpenFile,
  pickDesktopBackupSaveFile,
  setDesktopBackgroundThrottling,
  refocusDesktopWebContents,
  writeDesktopBackupFile
} from '../services/desktopBackupService';

const LOCAL_BACKUP_PATH_STORAGE_KEY = 'kumiko_local_backup_path';
const RELATIVE_REMINDER_STORAGE_KEY = 'kumiko_relative_reminders';
const DAILY_REMINDER_STORAGE_KEY = 'kumiko_daily_reminders';
const MESSAGE_ALERTS_STORAGE_KEY = 'kumiko_message_alerts';
const SUMMARY_ARCHIVE_STATE_STORAGE_KEY = 'kumiko_summary_archive_state';
const RAG_HISTORY_DIRTY_STORAGE_KEY = 'kumiko_rag_history_dirty';
const MEMORY_QUERY_SESSION_STORAGE_KEY = 'kumiko_memory_query_session';
const AUTO_DIARY_BACKFILL_STORAGE_KEY = 'kumiko_auto_diary_backfill';
const REMINDER_RETRY_DELAY_MS = 30000;
const SUMMARY_SEMANTIC_CACHE_LIMIT = 48;

type RelativeReminder = {
  id: string;
  event: string;
  dueAt: number;
  createdAt: number;
  sourceText?: string;
  retryAt?: number;
};

type DailyReminder = {
  id: string;
  event: string;
  hour: number;
  minute: number;
  timeZone: string;
  createdAt: number;
  paused?: boolean;
  lastTriggeredDate?: string;
  sourceText?: string;
  retryAt?: number;
};

type MessageAlertKind = 'reply' | 'proactive' | 'reminder';

type MissedMessageAlert = {
  id: string;
  messageId: string;
  preview: string;
  timestamp: number;
  kind: MessageAlertKind;
  isRead?: boolean;
};

type DevLogLevel = 'log' | 'warn' | 'error';

type DevLogEntry = {
  level: DevLogLevel;
  message: string;
  timestamp: string;
};

const DEFAULT_APP_UPDATE_STATE: AppUpdateState = {
  status: 'idle',
  currentVersion: '0.0.0',
  availableVersion: null,
  releaseDate: null,
  progressPercent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  error: null,
  isPackaged: false
};

const REBUILD_FRAGMENT_GAP_MS = 3 * 60 * 1000;
const REBUILD_FRAGMENT_WINDOW_MS = 8 * 60 * 1000;
const REBUILD_FRAGMENT_MAX_MESSAGES = 4;
const REBUILD_FRAGMENT_MAX_CHAR_LENGTH = 32;
const REBUILD_FRAGMENT_MAX_TOTAL_CHARS = 120;
const HISTORICAL_QUERY_SESSION_MAX_IDLE_MS = 30 * 60 * 1000;
const EXACT_LOOKUP_NEARBY_WINDOW_MS = 90 * 1000;
const EXACT_LOOKUP_TEMPORAL_SUMMARY_WINDOW_MS = 30 * 60 * 1000;
const EXACT_LOOKUP_TEMPORAL_SUMMARY_MAX_MESSAGES = 15;
const EXACT_LOOKUP_CONTEXT_EXPAND_BEFORE = 3;
const EXACT_LOOKUP_CONTEXT_EXPAND_AFTER = 3;
const DEV_LOG_LIMIT = 200;
const DEV_LOG_FLUSH_INTERVAL_MS = 80;
const DEV_LOG_MAX_MESSAGE_LENGTH = 2400;
const DEV_LOG_MAX_ARRAY_PREVIEW = 4;
const DEV_LOG_MAX_OBJECT_KEYS = 8;
const DEV_LOG_MAX_DEPTH = 2;
const REBUILD_FRAGMENT_BLOCK_PATTERNS = [
  /(?:报错|错误|修复|实现|逻辑|方案|原因|配置|接口|模型|向量|检索|RAG|SQLite|HNSW|embedding|endpoint|function|class|error|bug|stack|trace|prompt|code|api|model)/iu,
  /[`{}[\]();=<>]|::|=>/u,
];

const formatJstTimeForRag = (timestamp: number) => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(timestamp));
  const parsed: Record<string, string> = {};
  parts.forEach(part => {
    parsed[part.type] = part.value;
  });
  return `${parsed.year}/${parsed.month}/${parsed.day} ${parsed.hour}:${parsed.minute} (JST)`;
};

const mapMessageToEntity = (message: Message): MessageEntity => ({
  id: message.id,
  role: message.role,
  text: message.text,
  timestamp: message.timestamp,
  imageId: message.imageId,
  imageCaption: message.imageCaption,
  isHidden: message.isHidden,
  isPinned: message.isPinned,
  isRead: message.isRead,
  quote: message.quote ? {
    id: message.quote.id,
    text: message.quote.text,
    role: message.quote.role,
  } : undefined,
  emotion: message.storedEmotion,
  image: message.image,
  groundingSources: message.groundingSources,
  isVoiceMessage: message.isVoiceMessage,
  voiceFileId: message.voiceFileId,
  voiceDuration: message.voiceDuration,
  japaneseText: message.japaneseText,
});

const mapEntityToMessage = (entity: MessageEntity): Message => ({
  id: entity.id,
  role: entity.role,
  text: entity.text,
  timestamp: entity.timestamp,
  image: entity.image,
  imageId: entity.imageId,
  imageCaption: entity.imageCaption,
  groundingSources: entity.groundingSources,
  isRead: entity.isRead,
  isHidden: entity.isHidden,
  isPinned: entity.isPinned,
  quote: entity.quote,
  storedEmotion: entity.emotion as EmotionType | undefined,
  isVoiceMessage: entity.isVoiceMessage,
  voiceFileId: entity.voiceFileId,
  voiceDuration: entity.voiceDuration,
  japaneseText: entity.japaneseText,
});

type BackupMessageNormalizationStats = {
  inputCount: number;
  keptCount: number;
  droppedCount: number;
  droppedInvalidIdCount: number;
  droppedInvalidRoleCount: number;
  droppedInvalidTimestampCount: number;
  coercedTimestampCount: number;
};

const normalizeImportedBackupMessages = (
  messages: any[]
): { messages: Message[]; stats: BackupMessageNormalizationStats } => {
  const stats: BackupMessageNormalizationStats = {
    inputCount: Array.isArray(messages) ? messages.length : 0,
    keptCount: 0,
    droppedCount: 0,
    droppedInvalidIdCount: 0,
    droppedInvalidRoleCount: 0,
    droppedInvalidTimestampCount: 0,
    coercedTimestampCount: 0,
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], stats };
  }

  const normalizedMessages: Message[] = [];
  messages.forEach((candidate) => {
    const id = typeof candidate?.id === 'string' ? candidate.id.trim() : '';
    if (!id) {
      stats.droppedInvalidIdCount += 1;
      stats.droppedCount += 1;
      return;
    }

    const role = candidate?.role === 'user'
      ? 'user'
      : candidate?.role === 'model'
        ? 'model'
        : null;
    if (!role) {
      stats.droppedInvalidRoleCount += 1;
      stats.droppedCount += 1;
      return;
    }

    const normalizedTimestamp = Number(candidate?.timestamp);
    if (!Number.isFinite(normalizedTimestamp)) {
      stats.droppedInvalidTimestampCount += 1;
      stats.droppedCount += 1;
      return;
    }
    if (typeof candidate?.timestamp !== 'number') {
      stats.coercedTimestampCount += 1;
    }

    const quote = candidate?.quote && typeof candidate.quote === 'object'
      ? candidate.quote
      : null;
    const quoteRole = quote?.role === 'user' || quote?.role === 'model'
      ? quote.role
      : undefined;

    normalizedMessages.push({
      id,
      role,
      text: typeof candidate?.text === 'string' ? candidate.text : '',
      timestamp: normalizedTimestamp,
      image: typeof candidate?.image === 'string' ? candidate.image : undefined,
      imageId: typeof candidate?.imageId === 'string' ? candidate.imageId : undefined,
      imageCaption: typeof candidate?.imageCaption === 'string' ? candidate.imageCaption : undefined,
      groundingSources: Array.isArray(candidate?.groundingSources)
        ? candidate.groundingSources
        : undefined,
      isRead: typeof candidate?.isRead === 'boolean' ? candidate.isRead : undefined,
      isHidden: typeof candidate?.isHidden === 'boolean' ? candidate.isHidden : undefined,
      isPinned: typeof candidate?.isPinned === 'boolean' ? candidate.isPinned : undefined,
      quote: quote && typeof quote?.text === 'string' && quoteRole
        ? {
            id: typeof quote?.id === 'string' ? quote.id : undefined,
            text: quote.text,
            role: quoteRole,
          }
        : undefined,
      storedEmotion: typeof candidate?.storedEmotion === 'string'
        ? candidate.storedEmotion as EmotionType
        : undefined,
      isVoiceMessage: typeof candidate?.isVoiceMessage === 'boolean' ? candidate.isVoiceMessage : undefined,
      voiceFileId: typeof candidate?.voiceFileId === 'string' ? candidate.voiceFileId : undefined,
      voiceDuration: typeof candidate?.voiceDuration === 'number' ? candidate.voiceDuration : undefined,
      japaneseText: typeof candidate?.japaneseText === 'string' ? candidate.japaneseText : undefined,
    });
    stats.keptCount += 1;
  });

  return {
    messages: normalizedMessages,
    stats,
  };
};

const loadRawHistoryMessages = async (): Promise<Message[]> => {
  const mainProcessMessages = await loadRawHistoryMessagesFromMain();
  const rawMessages = await db.messages.orderBy('timestamp').toArray();
  const mergedById = new Map<string, Message>();
  let droppedMainCount = 0;
  let droppedDexieCount = 0;

  if (Array.isArray(mainProcessMessages)) {
    mainProcessMessages.forEach(message => {
      if (!message?.id || !message.text || !Number.isFinite(message.timestamp)) {
        droppedMainCount += 1;
        return;
      }
      mergedById.set(message.id, message);
    });
  }

  if (rawMessages.length > 0) {
    rawMessages.map(mapEntityToMessage).forEach(message => {
      if (!message?.id || !message.text || !Number.isFinite(message.timestamp)) {
        droppedDexieCount += 1;
        return;
      }
      mergedById.set(message.id, message);
    });
  }

  if (droppedMainCount > 0 || droppedDexieCount > 0) {
    console.warn('[RAW HISTORY] Dropped invalid raw history messages while loading evidence.', {
      droppedMainCount,
      droppedDexieCount,
      mergedCount: mergedById.size,
    });
  }

  if (mergedById.size > 0) {
    return Array.from(mergedById.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  const legacyMessages = await db.getVal<Message[]>('kumiko_chat_history', []);
  return Array.isArray(legacyMessages) ? legacyMessages : [];
};

const normalizeHistoryEvidenceMessages = (messages: Message[]) => {
  const mergedById = new Map<string, Message>();
  messages.forEach(message => {
    if (!message?.id || !message.text || !Number.isFinite(message.timestamp)) return;
    mergedById.set(message.id, message);
  });
  return Array.from(mergedById.values()).sort((a, b) => a.timestamp - b.timestamp);
};

const buildHistoryEvidenceMessages = async (liveMessages: Message[]) => {
  const rawMessages = await loadRawHistoryMessages();
  // Merge persisted raw history with live state so strict recall never drops
  // recently added messages just because IndexedDB sync lagged behind by one tick.
  return normalizeHistoryEvidenceMessages([...rawMessages, ...liveMessages]);
};

const formatTemporalEpisodeRange = (startTimestamp: number, endTimestamp: number) => {
  const start = formatJstTimeForRag(startTimestamp);
  const end = formatJstTimeForRag(endTimestamp);
  return start === end ? start : `${start} -> ${end}`;
};

const syncRawHistoryMessages = async (messages: Message[], options: { forceFull?: boolean } = {}) => {
  const entities = messages.map(mapMessageToEntity);

  await db.setVal('kumiko_chat_history', messages);

  if (options.forceFull) {
    await db.messages.clear();
  }

  if (entities.length === 0) {
    if (!options.forceFull) {
      await db.messages.clear();
    }
    try {
      await syncRawHistoryMessagesToMain([], { replaceAll: true });
    } catch (e) {
      console.warn('[RAW HISTORY] Failed to clear main-process SQLite raw history.', e);
    }
    return;
  }

  await db.messages.bulkPut(entities);

  try {
    await syncRawHistoryMessagesToMain(messages, { replaceAll: !!options.forceFull });
  } catch (e) {
    console.warn('[RAW HISTORY] Failed to sync messages to main-process SQLite.', e);
  }
};

const getJstDateParts = (timestamp: number) => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(timestamp));
  const parsed: Record<string, string> = {};
  parts.forEach(part => {
    parsed[part.type] = part.value;
  });
  return {
    year: Number(parsed.year),
    month: Number(parsed.month),
    day: Number(parsed.day),
    hour: Number(parsed.hour),
    minute: Number(parsed.minute),
    second: Number(parsed.second),
  };
};

type ExactHistoryLookupRole = 'user' | 'model' | 'any';
type ExactHistoryLookupRequest = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  targetRole: ExactHistoryLookupRole;
};
type MemoryEvidenceAnswerMode = 'quote_first' | 'temporal_summary_with_support' | 'thematic_summary_with_support' | 'summary_only';
type MemoryEvidenceResponseStrategy =
  | 'quote_direct_if_supported'
  | 'summarize_temporal_then_support'
  | 'summarize_theme_then_support'
  | 'summary_only_cautious'
  | 'acknowledge_no_evidence';

type MemoryEvidenceStrength = 'strong' | 'medium' | 'weak' | 'none';
type MemoryEvidenceCertainty = 'high' | 'medium' | 'low';
type MemoryResponseRouteBoundary =
  | 'exact_evidence_only'
  | 'temporal_summary_or_supported_quote'
  | 'semantic_summary_or_supported_quote';
type MemoryResponsePreferredLead =
  | 'direct_recall'
  | 'exact_cautious'
  | 'temporal_summary'
  | 'semantic_summary'
  | 'admit_missing_evidence';
type MemoryResponseAllowance = 'yes' | 'no';
type MemoryResponseConflictFlag =
  | 'speaker_uncertain'
  | 'time_uncertain'
  | 'weak_evidence'
  | 'quote_restricted'
  | 'mixed_evidence';

type HistoryLookupResult = {
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

type HistoricalRecallContextResolution = {
  queryText: string;
  source: 'self' | 'session' | 'recent_user';
  usedSession: boolean;
  previousQueryPreview: string | null;
  sessionReuseBlockedReason?: 'unstable_temporal_session' | null;
};

type HistoricalQueryIntent = 'exact' | 'temporal' | 'semantic' | 'none';

const detectExplicitHistoryTargetRole = (normalizedText: string): ExactHistoryLookupRole => {
  if (/(?:我|用户)(?:[^。？！,.，\n]{0,32})?(?:说|发|提到|讲)/u.test(normalizedText)) return 'user';
  if (/(?:你|久美子)(?:[^。？！,.，\n]{0,32})?(?:说|发|提到|讲)/u.test(normalizedText)) return 'model';
  return 'any';
};

const parseExactHistoryLookupRequest = (text: string): ExactHistoryLookupRequest | null => {
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

const parseSessionStartLookupRequest = (text: string) => {
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

const isLikelySemanticRecallQuery = (text: string) => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (parseExactHistoryLookupRequest(normalized) || parseSessionStartLookupRequest(normalized)) return false;
  if (isLikelyTemporalHistoryQuery(normalized) || isLikelyHistoricalRecallQuery(normalized)) return false;

  const semanticRecallMarkers = /(?:记得|还记得|那次|那回|那件事|当时那个|聊过|提到过|说过|之前说的|你还记得|remember|remembered|talked about|brought up|that time)/iu;
  return semanticRecallMarkers.test(normalized);
};

const resolveHistoricalQueryIntent = (
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

const mapHistoricalRewriteIntent = (
  intent: HistoricalQueryRewrite['intent'] | null | undefined
): HistoricalQueryIntent | null => {
  if (intent === 'exact' || intent === 'temporal' || intent === 'semantic') return intent;
  if (intent === 'topic_search') return 'semantic';
  return null;
};

const buildSessionStartHistoryLookupBlock = (messages: Message[], userText: string): HistoryLookupResult | null => {
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

const buildExactHistoryLookupBlock = (messages: Message[], userText: string): HistoryLookupResult | null => {
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

const formatTemporalRangeJst = (startTimestamp?: number | null, endTimestamp?: number | null) => {
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

const formatSemanticEntryKindSummary = (entryKindSummary: Record<LocalRagEntryKind, number>) => {
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

const buildMemoryEvidenceResponseStrategy = (
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

const buildMemoryResponsePlanBlock = ({
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

const buildMemoryEvidenceContext = ({
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

const buildSemanticRecallEvidenceDescriptors = (
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

const formatSemanticEvidenceStrengthSummary = (
  groupedBlocks: Array<{ kind: LocalRagEntryKind; strength: LocalRagEvidenceStrength; quoteSafe: boolean; blocks: string[] }>
) => groupedBlocks
  .filter(group => group.blocks.length > 0)
  .map(group => `${group.kind}:${group.strength}`)
  .join(', ');

const formatSemanticQuoteSafeSummary = (
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

const buildTemporalHistoryLookupBlock = (
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

const buildTemporalNoEvidenceLookupBlock = (
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

const isLikelyTemporalHistoryQuery = (text: string) => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  const temporalMarkers = /(?:昨天|前天|今天|那天|那次|刚才|之前|当时|最开始|一开始|最初|开头|上周|上个月|\d{1,2}\s*月|\d{1,2}\s*[号日]|\d{1,2}\s*点|\d{1,2}\s*分|凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|深夜|yesterday|today|last night|last week|that time|earlier|before|at \d{1,2}(?::\d{2})?|\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2})/iu;
  const recallMarkers = /(?:记得|还记得|来着|说了什么|聊了什么|提到什么|做什么|什么内容|哪天|什么时候|几点|我说|你说|久美子说|我们聊|what did|when did|do you remember|remember when|talked about|said)/iu;
  return temporalMarkers.test(normalized) && recallMarkers.test(normalized);
};

const isLikelyHistoricalRecallQuery = (text: string) => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  const recallMarkers = /(?:记得|还记得|来着|说了什么|聊了什么|提到什么|做什么|什么内容|哪天|什么时候|几点|我说|我发|你说|你发|久美子说|久美子发|我们聊|那次|那天|之前|当时|最开始|一开始|最初|开头|第一个话题|第一句|第一条|what did|when did|do you remember|remember when|talked about|said)/iu;
  const timeMarkers = /(?:昨天|前天|今天|刚才|之前|当时|上次|上周|上个月|\d{1,2}\s*月|\d{1,2}\s*[号日]|\d{1,2}\s*点|\d{1,2}\s*分|凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|深夜|大约|大概|差不多|左右|yesterday|today|last night|last week|that time|earlier|before|around|about|at \d{1,2}(?::\d{2})?|\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2})/iu;

  if (/(?:最开始|一开始|最初|开头|第一个话题|第一句|第一条)/u.test(normalized) && recallMarkers.test(normalized)) {
    return true;
  }

  return recallMarkers.test(normalized) && timeMarkers.test(normalized);
};

const isLikelyHistoricalFollowUp = (text: string) => {
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

const isLikelyHistoricalSessionCarry = (text: string) => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (isLikelyHistoricalRecallQuery(normalized) || isLikelyTemporalHistoryQuery(normalized)) {
    return false;
  }

  const carryPatterns = /(?:再试一次|再想想|再确认|可能是|应该是|美国时间|前后(?:\s*\d+\s*分钟?)?|左右|大概|大约|差不多|那个时间|那时候|那会儿|那段|那次|那话题|那内容|后来呢|然后呢|所以呢|呢\??|吗\??|嘛\??)$/u;
  if (carryPatterns.test(normalized)) return true;

  return normalized.length <= 18 && /[?？吗嘛呢呀啊]$/u.test(normalized);
};

const isMemoryQuerySessionActive = (session: MemoryQuerySession | null) => {
  return !!session && (Date.now() - session.lastUsedAt) <= HISTORICAL_QUERY_SESSION_MAX_IDLE_MS;
};

const TOPIC_FALLBACK_STOP_WORDS = new Set([
  '关于', '什么', '怎么', '我们', '你们', '他们', '她们', '那个', '这个',
  '聊过', '说过', '讨论', '记得', '话题', '内容', '对话', '还有', '然后',
  '之前', '以前', '最近', '这些', '那些', '觉得', '知道', '想起', '回忆',
  '时候', '就是', '可以', '没有', '不是', '为什么', '怎么样', '是不是',
]);

const extractTopicFallbackKeywords = (text: string): string[] | undefined => {
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

const isReusableHistoricalSession = (session: MemoryQuerySession | null) => {
  if (!isMemoryQuerySessionActive(session)) return false;
  if (!session) return false;
  if (session.kind !== 'temporal_history') return true;
  return isStableTemporalParserStatus(session.parserStatus)
    && session.parserConfidence !== 'low'
    && typeof session.startTimestampJST === 'number'
    && typeof session.endTimestampJST === 'number';
};

const normalizeMemoryQuerySession = (raw: unknown): MemoryQuerySession | null => {
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

const buildHistoricalRecallQueryContext = (
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

const buildSingleRebuildEntry = (message: Message) => {
  const prefix = message.role === 'user' ? 'User: ' : 'Kumiko: ';
  return `【Time: ${formatJstTimeForRag(message.timestamp)}】\n${prefix}${message.text}`;
};

const buildFragmentRebuildEntry = (messages: Message[]) => {
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

const getMessageCharCount = (message: Message) => Array.from(message.text?.trim?.() || '').length;

const isRebuildFragmentFriendlyMessage = (message: Message) => {
  const text = message.text?.trim?.() || '';
  if (!text) return false;
  if (getMessageCharCount(message) > REBUILD_FRAGMENT_MAX_CHAR_LENGTH) return false;
  return !REBUILD_FRAGMENT_BLOCK_PATTERNS.some(pattern => pattern.test(text));
};

const mapRagDecisionTierToStorageTier = (tier: 'core' | 'episodic' | 'background' | 'discard') => {
  if (tier === 'background') return 'background' as const;
  if (tier === 'episodic') return 'episodic' as const;
  return 'core' as const;
};

const recalculateTurnCountFromMessages = (messages: Message[]) => {
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

const normalizeReminderEvent = (rawEvent: string): string => {
  return rawEvent
    .replace(/(?:我怕忘(?:了)?|怕忘(?:了)?|怕我忘(?:了)?|免得忘(?:了)?|别忘(?:了)?|我怕自己忘(?:了)?).*$/u, '')
    .replace(/[~～]+/g, ' ')
    .replace(/^[\s,，。.!！？:：;；]+|[\s,，。.!！？:：;；]+$/gu, '')
    .replace(/(?:呗|吧|呀|啊|哦|噢|喔|啦|嘛|呢|哈)+$/u, '')
    .trim();
};

const parseRelativeReminderRequest = (text: string): { event: string; delaySeconds: number } | null => {
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

const normalizeDailyHourMinute = (hour: number, minute: number, period?: string): { hour: number; minute: number } | null => {
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

const parseDailyReminderRequest = (text: string): { event: string; hour: number; minute: number } | null => {
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

const getTimePartsInTimezone = (date: Date, timeZone: string) => {
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

const sanitizeRelativeReminderRecord = (record: any): RelativeReminder | null => {
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

const sanitizeDailyReminderRecord = (record: any): DailyReminder | null => {
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

const sanitizeWorldCharacterStatusRecord = (value: any): WorldCharacterStatusMap => {
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

const sanitizeKumikoDiaryRecord = (record: any): KumikoDiaryEntity | null => {
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

const sanitizeDailyFragmentRecord = (record: any): DailyFragmentEntity | null => {
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

const sanitizePsycheStateRecord = (record: any): PsycheStateEntity | null => {
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

const sanitizeEpisodeRecord = (record: any): EpisodeEntity | null => {
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

const sanitizeMessageAlertRecord = (record: any): MissedMessageAlert | null => {
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

const dotSimilarity = (left: Float32Array, right: Float32Array): number => {
  const size = Math.min(left.length, right.length);
  let dot = 0;
  for (let index = 0; index < size; index += 1) {
    dot += left[index] * right[index];
  }
  return dot;
};

const hasRichSemanticText = (text: string): boolean => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  const cjkCount = (normalized.match(/[\u4e00-\u9fff]/gu) || []).length;
  const latinWordCount = normalized.split(/\s+/).filter(token => /[A-Za-z]/.test(token)).length;

  return cjkCount >= 6 || latinWordCount >= 3 || normalized.length >= 10;
};

const truncateLogText = (value: string, maxLength: number = DEV_LOG_MAX_MESSAGE_LENGTH) => {
  if (value.length <= maxLength) return value;
  const omittedCount = value.length - maxLength;
  return `${value.slice(0, maxLength)}... [${omittedCount} chars truncated]`;
};

// Environment cache to avoid spamming the main process
let cachedEnvironmentStr: string | null = null;
let lastEnvironmentFetchTime = 0;

const getAmbientEnvironmentContext = async (): Promise<string> => {
  if (!isDesktopElectron() || !window.electronAPI) return '';
  
  const now = Date.now();
  if (cachedEnvironmentStr && (now - lastEnvironmentFetchTime < 30 * 60 * 1000)) {
    return cachedEnvironmentStr;
  }

  let envStr = `\n[SYSTEM_ENVIRONMENT_DATA]`;
  let hasData = false;

  try {
    const res = await window.electronAPI.invoke('app:get-weather');
    if (res && res.success) {
      const uji = res.uji;
      const user = res.user;
      
      const mapWeatherCode = (code: number): string => {
        if (code === 0) return '晴';
        if (code === 1 || code === 2 || code === 3) return '多云';
        if (code >= 45 && code <= 48) return '雾';
        if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return '雨';
        if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return '雪';
        if (code >= 95) return '雷雨';
        return '未知';
      };

      if (uji) {
        const cond = typeof uji.weathercode === 'number' ? mapWeatherCode(uji.weathercode) : '';
        envStr += `\n- 久美子所在地 (日本宇治市) 当前天气: ${cond ? cond + ', ' : ''}温度 ${uji.temperature}°C, 风速 ${uji.windspeed}km/h`;
        hasData = true;
      }
      if (user) {
        const cond = typeof user.weathercode === 'number' ? mapWeatherCode(user.weathercode) : '';
        envStr += `\n- 用户所在地当前天气: ${cond ? cond + ', ' : ''}温度 ${user.temperature}°C, 风速 ${user.windspeed}km/h`;
        hasData = true;
      }
    }
  } catch (e) {
    console.warn('[Environment] Failed to fetch ambient weather context:', e);
  }

  try {
    const holidayRes = await window.electronAPI.invoke('app:get-japan-holidays');
    const jstDate = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Tokyo"}));
    const year = jstDate.getFullYear();
    const month = String(jstDate.getMonth() + 1).padStart(2, '0');
    const day = String(jstDate.getDate()).padStart(2, '0');
    const dateString = `${year}-${month}-${day}`;

    if (holidayRes && holidayRes.success && holidayRes.holidays) {
      if (holidayRes.holidays[dateString]) {
        envStr += `\n- 今日特殊历法：日本法定节假日 - ${holidayRes.holidays[dateString]}`;
        hasData = true;
      }
    }

    const { getSchoolTermContext } = await import('../services/kumikoStateMachine');
    const schoolTerm = getSchoolTermContext(dateString);
    if (schoolTerm) {
      envStr += `\n- 当前学校阶段：${schoolTerm}`;
      hasData = true;
    }
  } catch (e) {
    console.warn('[Environment] Failed to fetch holiday/term context:', e);
  }

  if (hasData) {
    cachedEnvironmentStr = envStr;
    lastEnvironmentFetchTime = now;
    return envStr;
  }
  
  return '';
};

const summarizeValueForLog = (
  value: unknown,
  depth: number = 0,
  seen: WeakSet<object> = new WeakSet<object>()
): unknown => {
  if (typeof value === 'string') return truncateLogText(value);
  if (value instanceof Error) return truncateLogText(value.stack || value.message || String(value));
  if (value instanceof Date) return value.toISOString();
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return truncateLogText(String(value));

  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    if (depth >= DEV_LOG_MAX_DEPTH) return `[Array(${value.length})]`;
    const preview = value
      .slice(0, DEV_LOG_MAX_ARRAY_PREVIEW)
      .map(item => summarizeValueForLog(item, depth + 1, seen));
    const omittedCount = value.length - preview.length;
    return {
      type: 'Array',
      length: value.length,
      preview,
      ...(omittedCount > 0 ? { omitted: omittedCount } : {}),
    };
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (depth >= DEV_LOG_MAX_DEPTH) return `[Object keys=${entries.length}]`;

  const summary: Record<string, unknown> = {};
  entries.slice(0, DEV_LOG_MAX_OBJECT_KEYS).forEach(([key, nested]) => {
    summary[key] = summarizeValueForLog(nested, depth + 1, seen);
  });
  const omittedCount = entries.length - Math.min(entries.length, DEV_LOG_MAX_OBJECT_KEYS);
  if (omittedCount > 0) {
    summary.__omittedKeys = omittedCount;
  }
  return summary;
};

const formatCapturedLogMessage = (...args: any[]): string => args.map(arg => {
  if (typeof arg === 'string') return truncateLogText(arg);
  if (arg instanceof Error) return truncateLogText(arg.stack || arg.message || String(arg));
  if (typeof arg === 'object' && arg !== null) {
    try {
      return truncateLogText(JSON.stringify(summarizeValueForLog(arg)));
    } catch {
      return truncateLogText(String(arg));
    }
  }
  return truncateLogText(String(arg));
}).join(' ');

const getArrayLengthForBackupLog = (value: unknown) => Array.isArray(value) ? value.length : 0;

const summarizeBackupPayloadForLog = (backup: any) => {
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

const waitImmediateTaskTurn = () => new Promise<void>((resolve) => {
  if (typeof MessageChannel === 'function') {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
    return;
  }

  setTimeout(resolve, 0);
});

const yieldToMainThread = async (frames: number = 1) => {
  const waitSingleFrame = () => {
    const canWaitForVisibleFrame =
      typeof requestAnimationFrame === 'function'
      && typeof document !== 'undefined'
      && !document.hidden;

    if (canWaitForVisibleFrame) {
      return new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    }

    return waitImmediateTaskTurn();
  };

  for (let index = 0; index < Math.max(1, frames); index += 1) {
    await waitSingleFrame();
  }
};

export const App = () => {
  const isBulkRestoreInProgressRef = useRef(false);
  const rawHistorySyncedIdsRef = useRef<Set<string>>(new Set());
  const forceRawHistoryResyncRef = useRef(false);
  const skipNextRawHistorySyncRef = useRef(false);
  const memoryQuerySessionRef = useRef<MemoryQuerySession | null>(null);
  const updateMemoryQuerySession = useCallback((nextSession: MemoryQuerySession | null) => {
    const normalizedSession = normalizeMemoryQuerySession(nextSession);
    memoryQuerySessionRef.current = normalizedSession;
    void db.setVal(MEMORY_QUERY_SESSION_STORAGE_KEY, normalizedSession);
  }, []);

  // --- iOS PWA BODY LOCK CLEANUP ---
  useEffect(() => {
      // Body is now permanently fixed in index.html, no need to clear locks
      
      // Fix for iOS Safari PWA keyboard pushing app up and not restoring
      const handleFocusOut = () => {
        setTimeout(() => {
          if (!document.activeElement || (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA')) {
            window.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
          }
        }, 100);
      };

      window.addEventListener('focusout', handleFocusOut);
      
      return () => {
        window.removeEventListener('focusout', handleFocusOut);
      };
  }, []);

  // --- PERSISTENCE LOGIC START ---
  const [isDataLoaded, setIsDataLoaded] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    if (skipNextRawHistorySyncRef.current) {
      skipNextRawHistorySyncRef.current = false;
      return;
    }

    const currentIds = new Set(messages.map(message => message.id));
    const previousIds = rawHistorySyncedIdsRef.current;
    const hasRemovedIds = previousIds.size > 0 && Array.from(previousIds).some(id => !currentIds.has(id));
    const shouldForceFull = forceRawHistoryResyncRef.current || hasRemovedIds;

    syncRawHistoryMessages(messages, { forceFull: shouldForceFull })
      .then(async () => {
        await syncTemporalEpisodes(messages);
        rawHistorySyncedIdsRef.current = currentIds;
        forceRawHistoryResyncRef.current = false;
      })
      .catch(e => console.warn("DB Save Failed:", e));
  }, [messages, isDataLoaded]);
  // --- PERSISTENCE LOGIC END ---

  // UPDATED: Added 'CONFIG' to flow state
  const [flowState, setFlowState] = useState<'INTRO' | 'AUTH' | 'CONFIG' | 'APP'>('INTRO');
  const [inputValue, setInputValue] = useState('');
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [appState, setAppState] = useState<AppState>(AppState.CONNECTING);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  
  const [replyingToMsg, setReplyingToMsg] = useState<Message | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [systemNotice, setSystemNotice] = useState<string | null>(null);

  // --- NEW: iOS DETECTION FOR PERFORMANCE OPTIMIZATION ---
  const isIOS = useMemo(() => {
      // Standard check for iOS devices
      return /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
  }, []);
  
  useLayoutEffect(() => {
    const applyViewportFix = () => {
      const vv = window.visualViewport;
      const isStandalone =
        (window.navigator as any).standalone === true ||
        window.matchMedia('(display-mode: standalone)').matches;

      let h = window.innerHeight || 0;

      if (vv) {
        h = Math.max(h, Math.round(vv.height + vv.offsetTop));
      }

      if (isStandalone) {
        h = Math.max(h, document.documentElement.clientHeight || 0);
      }

      const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
      const topOffset = (isStandalone && isIOSDevice) ? 'env(safe-area-inset-top)' : '0';

      let hpx = (isStandalone && isIOSDevice) ? `calc(${h}px - env(safe-area-inset-top))` : `${h}px`;
      if (isStandalone && typeof CSS !== 'undefined' && CSS.supports('height: 100dvh')) {
        hpx = isIOSDevice ? 'calc(100dvh - env(safe-area-inset-top))' : '100dvh';
      }
      
      const bg = flowState === 'APP'
        ? (isDarkMode ? '#121212' : '#ffffff')
        : '#f9f7f2';

      document.documentElement.style.setProperty('--app-height', hpx);

      Object.assign(document.documentElement.style, {
        height: hpx,
        minHeight: hpx,
        overflow: 'hidden',
        backgroundColor: bg,
      });

      Object.assign(document.body.style, {
        position: 'fixed',
        top: topOffset,
        left: '0',
        right: '0',
        bottom: '0',
        width: '100%',
        height: hpx,
        minHeight: hpx,
        margin: '0',
        padding: '0',
        overflow: 'hidden',
        backgroundColor: bg,
        transform: 'translateZ(0)', // Makes body the containing block for fixed children
      });

      const root = document.getElementById('root');
      if (root) {
        Object.assign(root.style, {
          position: 'absolute',
          top: '0',
          left: '0',
          right: '0',
          bottom: '0',
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          backgroundColor: bg,
        });
      }

      if (appShellRef.current) {
        Object.assign(appShellRef.current.style, {
          position: 'absolute',
          top: '0',
          left: '0',
          right: '0',
          bottom: '0',
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          backgroundColor: bg,
        });
      }
    };

    const onResize = () => requestAnimationFrame(applyViewportFix);
    const onVisible = () => {
      if (!document.hidden) {
        setTimeout(applyViewportFix, 50);
        setTimeout(applyViewportFix, 250);
        setTimeout(applyViewportFix, 600);
      }
    };

    applyViewportFix();

    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('orientationchange', onResize, { passive: true });
    window.addEventListener('pageshow', onResize, { passive: true });

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onResize, { passive: true });
      window.visualViewport.addEventListener('scroll', onResize, { passive: true });
    }

    document.addEventListener('visibilitychange', onVisible);

    setTimeout(applyViewportFix, 0);
    setTimeout(applyViewportFix, 100);
    setTimeout(applyViewportFix, 400);

    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      window.removeEventListener('pageshow', onResize);

      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', onResize);
        window.visualViewport.removeEventListener('scroll', onResize);
      }

      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [isDarkMode, flowState]);

  // --- iOS WAKE LOCK OPTIMIZATION ---
  useEffect(() => {
    let wakeLock: any = null;

    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator && flowState === 'APP') {
          // @ts-ignore
          wakeLock = await navigator.wakeLock.request('screen');
          console.log("[iOS Optimization] Screen Wake Lock acquired.");
        }
      } catch (err) {
        console.warn("[iOS Optimization] Wake Lock failed:", err);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Re-acquire lock when coming back to app
        requestWakeLock();
      }
    };

    // Request initially if in APP mode
    if (flowState === 'APP') {
      requestWakeLock();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (wakeLock) wakeLock.release();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [flowState]);

  const [language, setLanguage] = useState<Language>('zh');

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_language', language);
  }, [language, isDataLoaded]);

  const t = UI_TRANSLATIONS[language];

  const [locationConfig, setLocationConfig] = useState<LocationConfig>(DEFAULT_LOCATION_CONFIG);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_location_config', locationConfig);
  }, [locationConfig, isDataLoaded]);

  const [coreMemory, setCoreMemory] = useState<string>('');
  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_core_memory', coreMemory);
  }, [coreMemory, isDataLoaded]);
  
  const [kumikoNotebook, setKumikoNotebook] = useState<string>('');
  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_notebook', kumikoNotebook);
  }, [kumikoNotebook, isDataLoaded]);

  const [contextLimit, setContextLimit] = useState<number>(100);
  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_context_limit', contextLimit);
  }, [contextLimit, isDataLoaded]);
  
  const [worldBook, setWorldBook] = useState<WorldBookEntry[]>(LOCALIZED_WORLD_BOOK['zh']);
  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_world_book', worldBook);
  }, [worldBook, isDataLoaded]);

  // This effect ensures the official lore content is always up-to-date with the code
  useEffect(() => {
      const officialLore = LOCALIZED_WORLD_BOOK[language] || DEFAULT_WORLD_BOOK;
      const officialLoreMap = new Map(officialLore.map(e => [e.id, e]));
      
      setWorldBook(prevBook => {
          let hasChanged = false;
          // Get only custom entries from the current state
          const customEntries = prevBook.filter(e => !officialLoreMap.has(e.id));
          
          // Rebuild official entries from code, preserving user settings from prev state
          const newOfficialEntries = officialLore.map(officialEntry => {
              const userSettings = prevBook.find(e => e.id === officialEntry.id);
              if (userSettings) {
                  // If content differs, it means code was updated. Mark change.
                  if (userSettings.content !== officialEntry.content || userSettings.title !== officialEntry.title) {
                      hasChanged = true;
                  }
                  // Preserve user settings, but take content from code
                  return {
                      ...officialEntry, // Fresh content from code
                      isActive: userSettings.isActive, // User setting
                      isHighPriority: userSettings.isHighPriority // User setting
                  };
              }
              return officialEntry; // This is a new entry from code
          });

          // FIX: Explicitly check if we are initializing from an empty state or missing entries
          const prevOfficialCount = prevBook.filter(e => officialLoreMap.has(e.id)).length;
          
          // If counts mismatch (e.g. 0 vs 15), we MUST update
          if (prevOfficialCount !== newOfficialEntries.length) {
              hasChanged = true;
          }

          // If no changes, return the original state to avoid re-render
          if (!hasChanged && customEntries.length === (prevBook.length - prevOfficialCount)) {
              return prevBook;
          }
          
          return [...newOfficialEntries, ...customEntries];
      });
  }, [language]);


  const [turnCount, setTurnCount] = useState(0);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_turn_count', turnCount);
  }, [turnCount, isDataLoaded]);

  const [summaryArchiveState, setSummaryArchiveState] = useState<SummaryArchiveState>(() => createInitialSummaryArchiveState(0));

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal(SUMMARY_ARCHIVE_STATE_STORAGE_KEY, summaryArchiveState);
  }, [summaryArchiveState, isDataLoaded]);

  const [isMemoryPanelOpen, setIsMemoryPanelOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isMessageCenterOpen, setIsMessageCenterOpen] = useState(false);
  const [isTaskPanelOpen, setIsTaskPanelOpen] = useState(false);
  const [isDiaryOpen, setIsDiaryOpen] = useState(false);
  const [backfillGapInfo, setBackfillGapInfo] = useState<import('../services/lifeStreamService').DiaryGapInfo | null>(null);
  const [backfillProgress, setBackfillProgress] = useState<{ current: number; total: number; currentDate: string } | undefined>();
  const [backfillComplete, setBackfillComplete] = useState(false);
  const [backfillGeneratedCount, setBackfillGeneratedCount] = useState(0);
  const pendingSendRef = useRef<(() => void) | null>(null);
  const autoDiaryBackfillRunningRef = useRef(false);

  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showClearFlow, setShowClearFlow] = useState(false);
  const [showDoubleClearFlow, setShowDoubleClearFlow] = useState(false);
  const ragDirtyNoticeShownRef = useRef(false);

  const [isTalking, setIsTalking] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [timeLeft, setTimeLeft] = useState(0);
  
  const [viewingImage, setViewingImage] = useState<string | null>(null);
  
  const [anchors, setAnchors] = useState<AnchorEntry[]>([]);
  const [relativeReminders, setRelativeRemindersState] = useState<RelativeReminder[]>([]);
  const [dailyReminders, setDailyRemindersState] = useState<DailyReminder[]>([]);
  const [messageAlerts, setMessageAlerts] = useState<MissedMessageAlert[]>([]);
  const [worldCharacterStatus, setWorldCharacterStatus] = useState<WorldCharacterStatusMap>(INITIAL_WORLD_CHARACTER_STATUS);
  const [autoSavedKumikoDiary, setAutoSavedKumikoDiary] = useState<KumikoDiaryEntity[]>([]);
  const [autoSavedDailyFragments, setAutoSavedDailyFragments] = useState<DailyFragmentEntity[]>([]);
  const [autoSavedPsycheState, setAutoSavedPsycheState] = useState<PsycheStateEntity | null>(null);

  const liveWorldCharacterStatus = useLiveQuery(
    async () => sanitizeWorldCharacterStatusRecord(await db.getVal('world_character_status', INITIAL_WORLD_CHARACTER_STATUS)),
    []
  );
  const liveKumikoDiary = useLiveQuery(
    async () => (await db.kumikoDiary.orderBy('date').toArray()).map(sanitizeKumikoDiaryRecord).filter(Boolean) as KumikoDiaryEntity[],
    []
  );
  const liveDailyFragments = useLiveQuery(
    async () => (await db.dailyFragments.orderBy('timestamp').toArray()).map(sanitizeDailyFragmentRecord).filter(Boolean) as DailyFragmentEntity[],
    []
  );
  const livePsycheState = useLiveQuery(
    async () => sanitizePsycheStateRecord(await db.psycheState.get('current')),
    []
  );

  useEffect(() => {
      if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
      db.setVal('kumiko_anchors', anchors);
  }, [anchors, isDataLoaded]);

  useEffect(() => {
      if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
      db.setVal(RELATIVE_REMINDER_STORAGE_KEY, relativeReminders);
  }, [relativeReminders, isDataLoaded]);

  useEffect(() => {
      if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
      db.setVal(DAILY_REMINDER_STORAGE_KEY, dailyReminders);
  }, [dailyReminders, isDataLoaded]);

  useEffect(() => {
      if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
      db.setVal(MESSAGE_ALERTS_STORAGE_KEY, messageAlerts.slice(0, 50));
  }, [messageAlerts, isDataLoaded]);

  useEffect(() => {
    if (liveWorldCharacterStatus) {
      setWorldCharacterStatus(liveWorldCharacterStatus);
    }
  }, [liveWorldCharacterStatus]);

  useEffect(() => {
    if (liveKumikoDiary) {
      setAutoSavedKumikoDiary(liveKumikoDiary);
    }
  }, [liveKumikoDiary]);

  useEffect(() => {
    if (liveDailyFragments) {
      setAutoSavedDailyFragments(liveDailyFragments);
    }
  }, [liveDailyFragments]);

  useEffect(() => {
    if (livePsycheState !== undefined) {
      setAutoSavedPsycheState(livePsycheState);
    }
  }, [livePsycheState]);
  
  const [ragStatus, setRagStatus] = useState<'IDLE' | 'RECALLING' | 'INDEXING' | 'ERROR' | 'OFF'>('OFF');
  const [ragProgressLabel, setRagProgressLabel] = useState<string | null>(null);
  const [isRagHistoryDirty, setIsRagHistoryDirty] = useState(false);

  // New state for Developer Logs
  const [devLogs, setDevLogs] = useState<DevLogEntry[]>([]);
  const pendingDevLogsRef = useRef<DevLogEntry[]>([]);
  const devLogFlushTimerRef = useRef<number | null>(null);
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState>(DEFAULT_APP_UPDATE_STATE);
  const [showAppUpdateModal, setShowAppUpdateModal] = useState(false);
  const lastAppUpdateStatusRef = useRef<AppUpdateState['status']>(DEFAULT_APP_UPDATE_STATE.status);

  useEffect(() => {
      if (ragStatus !== 'RECALLING' && ragStatus !== 'INDEXING') {
        setRagProgressLabel(null);
      }
  }, [ragStatus]);

  useEffect(() => {
      // --- NEW: AUTO-RESET API KEY LOGIC ---
      try {
        const configStr = localStorage.getItem('kumiko_ai_config');
        if (configStr) {
          const config: AIConfig = JSON.parse(configStr);
          // Check if we are on backup key and a switch timestamp exists
          if (config.activeKey === 'backup' && config.keySwitchTimestamp) {
            const twentyFourHours = 24 * 60 * 60 * 1000;
            const timeSinceSwitch = Date.now() - config.keySwitchTimestamp;

            if (timeSinceSwitch > twentyFourHours) {
              console.log("[KEY_SWITCH] More than 24 hours passed. Reverting to primary API key.");
              const newConfig: AIConfig = { ...config, activeKey: 'primary' };
              delete newConfig.keySwitchTimestamp; // Clean up timestamp
              localStorage.setItem('kumiko_ai_config', JSON.stringify(newConfig));
            }
          }
        }
      } catch (error) {
        console.error("Failed to check for AI key reset:", error);
      }

      const flushBufferedLogs = () => {
        if (devLogFlushTimerRef.current !== null) {
          window.clearTimeout(devLogFlushTimerRef.current);
          devLogFlushTimerRef.current = null;
        }

        if (pendingDevLogsRef.current.length === 0) return;

        const nextLogs = pendingDevLogsRef.current;
        pendingDevLogsRef.current = [];
        setDevLogs(prev => {
          const mergedLogs = [...prev, ...nextLogs];
          return mergedLogs.length > DEV_LOG_LIMIT
            ? mergedLogs.slice(mergedLogs.length - DEV_LOG_LIMIT)
            : mergedLogs;
        });
      };

      const scheduleBufferedLogFlush = () => {
        if (devLogFlushTimerRef.current !== null) return;
        devLogFlushTimerRef.current = window.setTimeout(() => {
          flushBufferedLogs();
        }, DEV_LOG_FLUSH_INTERVAL_MS);
      };

      const originalLog = console.log;
      const originalWarn = console.warn;
      const originalError = console.error;

      const addToLogs = (level: DevLogLevel, ...args: any[]) => {
        pendingDevLogsRef.current.push({
          level,
          message: formatCapturedLogMessage(...args),
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        });

        if (pendingDevLogsRef.current.length >= 12) {
          flushBufferedLogs();
          return;
        }

        scheduleBufferedLogFlush();
      };
      
      console.log = (...args) => {
          originalLog.apply(console, args);
          addToLogs('log', ...args);
      };
      console.warn = (...args) => {
          originalWarn.apply(console, args);
          addToLogs('warn', ...args);
      };
      console.error = (...args) => {
          originalError.apply(console, args);
          addToLogs('error', ...args);
      };

      // Cleanup on component unmount
      return () => {
          if (devLogFlushTimerRef.current !== null) {
            window.clearTimeout(devLogFlushTimerRef.current);
            devLogFlushTimerRef.current = null;
          }
          pendingDevLogsRef.current = [];
          console.log = originalLog;
          console.warn = originalWarn;
          console.error = originalError;
      };

  }, []);

  const [currentEmotion, setCurrentEmotion] = useState<EmotionType>('neutral');

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_current_emotion', currentEmotion);
  }, [currentEmotion, isDataLoaded]);

  const [backupConfig, setBackupConfig] = useState<BackupConfig>(DEFAULT_BACKUP_CONFIG);
  const [autoZipEnabled, setAutoZipEnabled] = useState<boolean>(false);

  useEffect(() => {
    if (isDesktopElectron()) {
      window.electronAPI.invoke('app:get-auto-zip-backup').then((result: any) => {
        setAutoZipEnabled(result?.enabled === true);
      });
    }
  }, []);

  const runDiaryBackfill = useCallback(async (dates: string[], afterContext?: string) => {
    const { batchGenerateDiaries } = await import('../services/lifeStreamService');
    setBackfillComplete(false);
    setBackfillGeneratedCount(0);
    const count = await batchGenerateDiaries(
      dates,
      (current, total, currentDate) => setBackfillProgress({ current, total, currentDate }),
      afterContext
    );
    setBackfillProgress(undefined);
    setBackfillComplete(true);
    setBackfillGeneratedCount(count);
  }, []);

  const isAutoDiaryBackfillEnabled = useCallback(() => {
    try {
      return window.localStorage.getItem(AUTO_DIARY_BACKFILL_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  }, []);

  const runAutoDiaryBackfill = useCallback(async (
    precomputedGapInfo?: import('../services/lifeStreamService').DiaryGapInfo | null
  ) => {
    if (!isAutoDiaryBackfillEnabled() || autoDiaryBackfillRunningRef.current) return false;

    autoDiaryBackfillRunningRef.current = true;
    try {
      const { batchGenerateDiaries, detectDiaryGaps } = await import('../services/lifeStreamService');
      const gapInfo = precomputedGapInfo && precomputedGapInfo.totalMissing > 0
        ? precomputedGapInfo
        : await detectDiaryGaps();

      if (gapInfo.totalMissing <= 0 || gapInfo.missingDates.length === 0) return false;

      await batchGenerateDiaries(gapInfo.missingDates, () => {}, gapInfo.contextAfter);
      return true;
    } catch (error) {
      console.warn('[Diary] Auto background backfill failed:', error);
      return false;
    } finally {
      autoDiaryBackfillRunningRef.current = false;
    }
  }, [isAutoDiaryBackfillEnabled]);

  const handleBackfillAll = useCallback(async () => {
    if (!backfillGapInfo || backfillGapInfo.missingDates.length === 0) return;
    await runDiaryBackfill(backfillGapInfo.missingDates, backfillGapInfo.contextAfter);
  }, [backfillGapInfo, runDiaryBackfill]);

  const handleBackfillOne = useCallback(async () => {
    if (!backfillGapInfo || backfillGapInfo.missingDates.length === 0) return;
    const sorted = [...backfillGapInfo.missingDates].sort();
    const lastOne = sorted[sorted.length - 1];
    await runDiaryBackfill([lastOne], backfillGapInfo.contextAfter);
  }, [backfillGapInfo, runDiaryBackfill]);

  const handleBackfillDismiss = useCallback(() => {
    setBackfillGapInfo(null);
    setBackfillProgress(undefined);
    setBackfillComplete(false);
    setBackfillGeneratedCount(0);
    if (pendingSendRef.current) {
      const resume = pendingSendRef.current;
      pendingSendRef.current = null;
      resume();
    }
  }, []);

  useEffect(() => {
    if (flowState !== 'APP' || !isDataLoaded) return;
    void runAutoDiaryBackfill();
  }, [flowState, isDataLoaded, runAutoDiaryBackfill]);

  const handleToggleAutoZip = () => {
    const newValue = !autoZipEnabled;
    setAutoZipEnabled(newValue);
    if (isDesktopElectron()) {
      window.electronAPI.invoke('app:set-auto-zip-backup', { enabled: newValue });
    }
  };

  const handleBackupConfigChange = useCallback((nextConfig: BackupConfig) => {
    setBackupConfig(normalizeBackupConfig(nextConfig));
  }, []);

  const sanitizeTtsConfig = useCallback((value: unknown): TtsConfig => {
    const merged = {
      ...DEFAULT_TTS_CONFIG,
      ...(value && typeof value === 'object' ? value as Partial<TtsConfig> : {})
    };

    if (!isBuiltInRingtoneId(merged.ringtoneFileId) && !isCustomRingtoneId(merged.ringtoneFileId)) {
      merged.ringtoneFileId = DEFAULT_TTS_CONFIG.ringtoneFileId;
    }

    return merged as TtsConfig;
  }, []);

  const [ttsConfig, setTtsConfig] = useState<TtsConfig>(() => {
    try {
      const raw = localStorage.getItem('kumiko_tts_config');
      if (raw) return sanitizeTtsConfig(JSON.parse(raw));
    } catch { /* ignore */ }
    return { ...DEFAULT_TTS_CONFIG };
  });
  const ttsConfigRef = useRef(ttsConfig);
  useEffect(() => { ttsConfigRef.current = ttsConfig; }, [ttsConfig]);
  const handleTtsConfigChange = useCallback((next: TtsConfig) => {
    const sanitized = sanitizeTtsConfig(next);
    setTtsConfig(sanitized);
    localStorage.setItem('kumiko_tts_config', JSON.stringify(sanitized));
  }, [sanitizeTtsConfig]);

  useEffect(() => {
      if (backupConfig.ragEnabled) {
          setRagStatus(prev => prev === 'OFF' ? 'IDLE' : prev);
      } else {
          setRagStatus('OFF');
      }
  }, [backupConfig.ragEnabled]); 

  const [isCloudSynced, setIsCloudSynced] = useState(false);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_backup_config', backupConfig);
  }, [backupConfig, isDataLoaded]);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal(RAG_HISTORY_DIRTY_STORAGE_KEY, isRagHistoryDirty);
  }, [isRagHistoryDirty, isDataLoaded]);

  const [autoBackupInterval, setAutoBackupInterval] = useState(2);
  const [connectedFileName, setConnectedFileName] = useState<string | null>(null);
  const [lastBackupTime, setLastBackupTime] = useState<number | null>(null);
  
  const [syncErrorMessage, setSyncErrorMessage] = useState<string | null>(null);
  const [showSyncErrorModal, setShowSyncErrorModal] = useState(false);
  const [showCloudRestorePrompt, setShowCloudRestorePrompt] = useState(false);
  
  // NEW: Live Status Text State
  const [statusText, setStatusText] = useState(t.signalConnected);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef(messages);
  const appShellRef = useRef<HTMLDivElement>(null);
  const summarySemanticEmbeddingCacheRef = useRef<Map<string, Float32Array>>(new Map());
  const recentRagDedupeKeysRef = useRef<string[]>([]);
  
  const fileHandleRef = useRef<any>(null); 
  
  const pendingTextRef = useRef<string>("");
  const pendingImageRef = useRef<string | null>(null);
  const pendingImageMessageIdRef = useRef<string | null>(null);
  
  const pendingMessageIdsRef = useRef<Set<string>>(new Set());
  const generationIdRef = useRef<number>(0);
  
  // NEW: Ref to track sleep decision for the session
  const hasGoneToSleepRef = useRef<boolean>(false);

  // NEW: Ref to prevent double auto-pull on entry
  const hasPerformedInitialPull = useRef<boolean>(false);

  // --- NEW: SESSION LOCK (ANTI-RACE CONDITION) ---
  const welcomeTriggeredRef = useRef<boolean>(false);
  const reminderDispatchingRef = useRef<boolean>(false);

  // FIX: Restore truncated ragBufferRef logic with try-catch
  const ragBufferRef = useRef<string[]>([]);

  const unreadAlertCount = useMemo(() => messageAlerts.filter(alert => !alert.isRead).length, [messageAlerts]);
  const summaryProgressText = useMemo(
    () => getArchivedSummaryProgressText(summaryArchiveState, turnCount, language),
    [summaryArchiveState, turnCount, language]
  );

  const deriveSummaryTopicLabel = useCallback((
    chunks: string[],
    segmentMessages: Message[],
    summaryText: string
  ) => {
    const candidates = [
      ...(Array.isArray(chunks) ? chunks : []),
      ...segmentMessages
        .filter(message => message.role === 'user' && !message.isHidden)
        .map(message => message.text),
      summaryText,
    ];

    for (const rawCandidate of candidates) {
      if (typeof rawCandidate !== 'string') continue;
      const normalized = rawCandidate
        .replace(/\[[^\]]+\]/g, ' ')
        .replace(/^【[^】]+】/u, '')
        .replace(/^[\s\-:：]+/u, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!normalized) continue;

      return normalized.length > 28 ? `${normalized.slice(0, 28).trim()}…` : normalized;
    }

    return language === 'zh' ? '近期片段' : 'Recent Segment';
  }, [language]);

  const getCachedSummaryEmbedding = useCallback(async (text: string) => {
    const normalized = text.trim();
    if (!normalized) return null;

    const cache = summarySemanticEmbeddingCacheRef.current;
    const cached = cache.get(normalized);
    if (cached) {
      return cached;
    }

    const vector = await generateEmbedding(normalized, getCurrentAIConfig(), 0);
    cache.set(normalized, vector);

    if (cache.size > SUMMARY_SEMANTIC_CACHE_LIMIT) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey) {
        cache.delete(oldestKey);
      }
    }

    return vector;
  }, []);

  const calculateSummarySemanticSignal = useCallback(async (
    archiveState: SummaryArchiveState
  ): Promise<SummarySemanticSignal | null> => {
    const semanticWindows = getSummarySemanticWindowPayload(messagesRef.current, archiveState);
    if (!semanticWindows) {
      return null;
    }

    try {
      const previousVector = await getCachedSummaryEmbedding(semanticWindows.previousWindowText);
      const recentVector = await getCachedSummaryEmbedding(semanticWindows.recentWindowText);

      if (!previousVector || !recentVector) {
        return null;
      }

      const recentSimilarity = dotSimilarity(previousVector, recentVector);
      let currentSimilarity: number | null = null;

      if (hasRichSemanticText(semanticWindows.currentUserText)) {
        const currentVector = await getCachedSummaryEmbedding(semanticWindows.currentUserText);
        if (currentVector) {
          currentSimilarity = dotSimilarity(previousVector, currentVector);
        }
      }

      const weightedSimilarity = currentSimilarity === null
        ? recentSimilarity
        : (currentSimilarity * 0.6) + (recentSimilarity * 0.4);
      const driftScore = Math.max(0, 1 - weightedSimilarity);

      const shouldTrigger = currentSimilarity === null
        ? recentSimilarity <= 0.68
        : recentSimilarity <= 0.84 && currentSimilarity <= 0.74 && weightedSimilarity <= 0.78 && driftScore >= 0.22;

      console.log(
        `[AUTO-SUMMARY] Semantic drift check: recent=${recentSimilarity.toFixed(3)}, current=${currentSimilarity === null ? 'n/a' : currentSimilarity.toFixed(3)}, weighted=${weightedSimilarity.toFixed(3)}, trigger=${shouldTrigger}`
      );

      return {
        shouldTrigger,
        recentSimilarity,
        currentSimilarity,
        weightedSimilarity,
        driftScore,
      };
    } catch (error) {
      console.warn('[AUTO-SUMMARY] Semantic drift check unavailable, falling back to rule-only boundary detection.', error);
      return null;
    }
  }, [getCachedSummaryEmbedding]);

  const calculateSummaryContinuationSignal = useCallback(async (
    archiveState: SummaryArchiveState
  ) => {
    const continuationPayload = getSummaryContinuationPayload(messagesRef.current, archiveState);
    if (!continuationPayload || !hasRichSemanticText(continuationPayload.currentText)) {
      return null;
    }

    try {
      const carryoverVector = await getCachedSummaryEmbedding(continuationPayload.carryoverText);
      const currentVector = await getCachedSummaryEmbedding(continuationPayload.currentText);
      if (!carryoverVector || !currentVector) {
        return null;
      }

      const similarity = dotSimilarity(carryoverVector, currentVector);
      const shouldContinue = continuationPayload.currentUserCount >= 2
        ? similarity >= 0.76
        : similarity >= 0.82;

      console.log(
        `[AUTO-SUMMARY] Continuation check: similarity=${similarity.toFixed(3)}, currentUsers=${continuationPayload.currentUserCount}, trigger=${shouldContinue}`
      );

      return {
        shouldContinue,
        similarity,
      };
    } catch (error) {
      console.warn('[AUTO-SUMMARY] Continuation check unavailable, skipping carryover stitching.', error);
      return null;
    }
  }, [getCachedSummaryEmbedding]);

  const rememberRecentRagDedupeKey = useCallback((dedupeKey: string | null) => {
    if (!dedupeKey) return;

    const nextKeys = [dedupeKey, ...recentRagDedupeKeysRef.current.filter(key => key !== dedupeKey)];
    recentRagDedupeKeysRef.current = nextKeys.slice(0, 48);
  }, []);

  const markAllAlertsRead = useCallback(() => {
    setMessageAlerts(prev => {
      let changed = false;
      const next = prev.map(alert => {
        if (alert.isRead) return alert;
        changed = true;
        return { ...alert, isRead: true };
      });
      return changed ? next : prev;
    });
  }, []);

  const registerBackgroundAlert = useCallback((messageId: string, preview: string, kind: MessageAlertKind) => {
    const trimmedPreview = preview.trim();
    if (!trimmedPreview || (!document.hidden && document.hasFocus())) {
      return;
    }

    setMessageAlerts(prev => {
      const nextAlert: MissedMessageAlert = {
        id: `${kind}-${messageId}`,
        messageId,
        preview: trimmedPreview,
        timestamp: Date.now(),
        kind,
        isRead: false
      };
      return [nextAlert, ...prev.filter(alert => alert.id !== nextAlert.id)].slice(0, 50);
    });
  }, []);

  const showBackgroundMessageNotification = useCallback((body: string, kind: MessageAlertKind = 'reply', messageId?: string) => {
    const trimmedBody = body.trim();
    if (!trimmedBody || (!document.hidden && document.hasFocus())) {
      return;
    }

    if (messageId) {
      registerBackgroundAlert(messageId, trimmedBody, kind);
    }

    const title = language === 'zh'
      ? (kind === 'reminder'
          ? '黄前 久美子 · 提醒你一下'
          : '黄前 久美子 发来新消息')
      : (kind === 'reminder'
          ? 'Kumiko · Reminder'
          : 'New message from Kumiko');

    try {
      if (window.electronAPI) {
        window.electronAPI.send('app:send-notification', { title, body: trimmedBody });
      } else {
        const notif = new Notification(title, {
          body: trimmedBody,
          icon: './favicon-KA.ico',
          badge: './favicon-KA.ico',
          tag: kind === 'reminder' ? 'kumiko-reminder' : 'kumiko-message',
          requireInteraction: true,
          silent: false
        });
        notif.onclick = () => window.focus();
      }
    } catch (e) {
      console.warn("Background message notification failed:", e);
    }
  }, [language, registerBackgroundAlert]);

  useEffect(() => {
    const loadData = async () => {
      try {
        const loadedMessages = await loadRawHistoryMessages();
        const loadedTurnCount = recalculateTurnCountFromMessages(loadedMessages);
        const loadedSummaryArchiveState = normalizeSummaryArchiveState(
          await db.getVal(SUMMARY_ARCHIVE_STATE_STORAGE_KEY, null),
          loadedTurnCount
        );
        const loadedCoreMemory = resolveCoreMemoryFromSummaryArchive(
          loadedSummaryArchiveState,
          await db.getVal('kumiko_core_memory', '')
        );
        const loadedMemoryQuerySession = normalizeMemoryQuerySession(
          await db.getVal(MEMORY_QUERY_SESSION_STORAGE_KEY, null)
        );

        setMessages(loadedMessages);
        rawHistorySyncedIdsRef.current = new Set(loadedMessages.map(message => message.id));
        forceRawHistoryResyncRef.current = false;
        updateMemoryQuerySession(loadedMemoryQuerySession);
        setLanguage(await db.getVal('kumiko_language', 'zh'));
        setLocationConfig(await db.getVal('kumiko_location_config', DEFAULT_LOCATION_CONFIG));
        setCoreMemory(loadedCoreMemory);
        setKumikoNotebook(await db.getVal('kumiko_notebook', ''));
        setContextLimit(await db.getVal('kumiko_context_limit', 100));
        
        const savedWorldBook = await db.getVal('kumiko_world_book', null);
        if (savedWorldBook) {
            setWorldBook(savedWorldBook);
        } else {
            setWorldBook(LOCALIZED_WORLD_BOOK['zh']);
        }

        setTurnCount(loadedTurnCount);
        setSummaryArchiveState(loadedSummaryArchiveState);
        setAnchors(await db.getVal('kumiko_anchors', []));
        setCurrentEmotion(await db.getVal('kumiko_current_emotion', 'neutral'));
        setRelativeRemindersState((await db.getVal(RELATIVE_REMINDER_STORAGE_KEY, [])).map(sanitizeRelativeReminderRecord).filter(Boolean) as RelativeReminder[]);
        setDailyRemindersState((await db.getVal(DAILY_REMINDER_STORAGE_KEY, [])).map(sanitizeDailyReminderRecord).filter(Boolean) as DailyReminder[]);
        setMessageAlerts((await db.getVal(MESSAGE_ALERTS_STORAGE_KEY, [])).map(sanitizeMessageAlertRecord).filter(Boolean).slice(0, 50) as MissedMessageAlert[]);
        setWorldCharacterStatus(sanitizeWorldCharacterStatusRecord(await db.getVal('world_character_status', INITIAL_WORLD_CHARACTER_STATUS)));
        setAutoSavedKumikoDiary((await db.kumikoDiary.orderBy('date').toArray()).map(sanitizeKumikoDiaryRecord).filter(Boolean) as KumikoDiaryEntity[]);
        setAutoSavedDailyFragments((await db.dailyFragments.orderBy('timestamp').toArray()).map(sanitizeDailyFragmentRecord).filter(Boolean) as DailyFragmentEntity[]);
        setAutoSavedPsycheState(sanitizePsycheStateRecord(await db.psycheState.get('current')));
        
        const backupCfg = normalizeBackupConfig(await db.getVal('kumiko_backup_config', DEFAULT_BACKUP_CONFIG));
        setBackupConfig(backupCfg);
        setIsRagHistoryDirty(await db.getVal(RAG_HISTORY_DIRTY_STORAGE_KEY, false));

        ragBufferRef.current = await db.getVal('kumiko_rag_buffer', []);

        setIsDataLoaded(true);
      } catch (e) {
        console.error("Failed to load data from IndexedDB", e);
        setIsDataLoaded(true);
      }
    };
    loadData();
  }, [updateMemoryQuerySession]);

  useEffect(() => {
    if (flowState !== 'APP') return;

    const markVisibleAlertsRead = () => {
      if (!document.hidden && document.hasFocus()) {
        markAllAlertsRead();
      }
    };

    markVisibleAlertsRead();
    window.addEventListener('focus', markVisibleAlertsRead);
    document.addEventListener('visibilitychange', markVisibleAlertsRead);

    return () => {
      window.removeEventListener('focus', markVisibleAlertsRead);
      document.removeEventListener('visibilitychange', markVisibleAlertsRead);
    };
  }, [flowState, markAllAlertsRead]);

  useEffect(() => {
    const baseTitle = 'Kumiko·Amadeus';
    document.title = unreadAlertCount > 0 ? `(${unreadAlertCount}) ${baseTitle}` : baseTitle;

    if (isDesktopElectron()) {
      try {
        const ipc = (window as any).electronAPI;
        ipc?.send('app:update-unread-state', { count: unreadAlertCount });
      } catch (error) {
        console.warn('[UNREAD] Failed to sync unread state to Electron shell:', error);
      }
    }
  }, [unreadAlertCount]);

  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const backupData = useMemo(() => buildBackupData({
    messages,
    coreMemory,
    worldBook,
    contextLimit,
    turnCount,
    summaryArchiveState,
    currentEmotion,
    locationConfig,
    language,
    anchors,
    kumikoNotebook,
    relativeReminders,
    dailyReminders,
    worldCharacterStatus,
    kumikoDiary: autoSavedKumikoDiary,
    dailyFragments: autoSavedDailyFragments,
    psycheState: autoSavedPsycheState,
    defaultWorldBook: DEFAULT_WORLD_BOOK,
    localizedWorldBook: LOCALIZED_WORLD_BOOK,
  }), [
    messages,
    coreMemory,
    worldBook,
    contextLimit,
    turnCount,
    summaryArchiveState,
    currentEmotion,
    locationConfig,
    language,
    anchors,
    kumikoNotebook,
    relativeReminders,
    dailyReminders,
    worldCharacterStatus,
    autoSavedKumikoDiary,
    autoSavedDailyFragments,
    autoSavedPsycheState,
  ]);

  const validateSaveData = useCallback((data: typeof backupData): boolean => (
    validateBackupData(data, language, LOCALIZED_WORLD_BOOK, DEFAULT_WORLD_BOOK)
  ), [language]);

  const clearLocalFileConnection = useCallback(() => {
    setConnectedFileName(null);
    fileHandleRef.current = null;

    try {
      localStorage.removeItem(LOCAL_BACKUP_PATH_STORAGE_KEY);
    } catch {
      // Ignore storage cleanup failures.
    }
  }, []);

  useEffect(() => {
    if (!isDataLoaded || !isDesktopElectron()) return;

    let isCancelled = false;

    const restoreDesktopBackupConnection = async () => {
      try {
        const savedPath = localStorage.getItem(LOCAL_BACKUP_PATH_STORAGE_KEY);
        if (!savedPath) return;

        const result = await getDesktopBackupFileInfo(savedPath);
        if (isCancelled) return;

        if (result.success && result.exists && result.filePath) {
          fileHandleRef.current = result.filePath;
          setConnectedFileName(result.fileName || result.filePath.split(/[\\/]/).pop() || result.filePath);
          return;
        }

        clearLocalFileConnection();
      } catch (error) {
        console.warn('[LOCAL BACKUP] Failed to restore desktop backup connection:', error);
        if (!isCancelled) {
          clearLocalFileConnection();
        }
      }
    };

    restoreDesktopBackupConnection();

    return () => {
      isCancelled = true;
    };
  }, [clearLocalFileConnection, isDataLoaded]);

  const { syncStatus, manualRetry, updateBaseline, triggerManualSave, flushIfDirty } = useAutoSave({
    data: backupData,
    config: backupConfig,
    fileHandle: fileHandleRef.current,
    isBlocked: isTalking || isThinking,
    onSaveError: (msg) => {
        console.error("AutoSave Error:", msg);
        setSyncErrorMessage(msg);
    },
    validate: validateSaveData // Pass validation function
  });

  useEffect(() => {
    if (syncStatus === 'SAVED') {
      setLastBackupTime(Date.now());
    }
  }, [syncStatus]);
  
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (!highlightedMessageId) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]); 

  useEffect(() => {
    if (flowState === 'APP') {
        setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
        }, 100);
        setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }, 500);
    }
  }, [flowState]);

  // --- LIVE STATUS UPDATE LOGIC ---
  useEffect(() => {
      const updateStatus = () => {
          if (flowState !== 'APP') return;
          try {
              // SAFETY CHECK: Ensure locationConfig and timezone exist
              if (!locationConfig || !locationConfig.modelTimezone) {
                  throw new Error("Invalid Location Config");
              }

              const now = new Date();
              // WRAP IN TRY-CATCH: toLocaleTimeString can crash if timezone is invalid
              let hourStr = "12";
              try {
                  hourStr = now.toLocaleTimeString('en-GB', { 
                      timeZone: locationConfig.modelTimezone, 
                      hour: 'numeric', 
                      hour12: false, 
                      hourCycle: 'h23' 
                  });
              } catch (tzError) {
                  console.warn("Timezone calculation failed, fallback to UTC", tzError);
                  hourStr = now.toLocaleTimeString('en-GB', { 
                      timeZone: 'UTC', 
                      hour: 'numeric', 
                      hour12: false, 
                      hourCycle: 'h23' 
                  });
              }

              const hour = parseInt(hourStr, 10);
              // Safe Day check
              let day = 0;
              try {
                  day = new Date(now.toLocaleString('en-US', { timeZone: locationConfig.modelTimezone })).getDay();
              } catch {
                  day = now.getDay();
              }
              
              const isWeekend = day === 0 || day === 6;
              const isZh = language === 'zh';

              if (hour >= 2 && hour < 6) {
                  setStatusText(isZh ? "状态：睡眠模式 (勿扰)" : "STATUS: SLEEP MODE (DND)");
              } else if (!isWeekend && hour >= 8 && hour < 16) {
                  setStatusText(isZh ? "状态：北宇治高中执勤中" : "STATUS: AT KITAUJI HIGH (WORK)");
              } else if (!isWeekend && hour >= 16 && hour < 18) {
                  setStatusText(isZh ? "状态：社团活动指导中" : "STATUS: BAND CLUB COACHING");
              } else {
                  setStatusText(isZh ? "状态：在线" : "STATUS: ONLINE");
              }
          } catch(e) {
              console.error("Status Update Failed", e);
              setStatusText(t.signalConnected);
          }
      };
      
      updateStatus(); // Initial call
      const timer = setInterval(updateStatus, 60000); // Update every minute
      return () => clearInterval(timer);
  }, [flowState, locationConfig, language, t.signalConnected]);

  // --- REFINED DATA NORMALIZATION (Business Logic for Restore) ---
  // Implements "Smart Merge" logic:
  // 1. Always fetches fresh official lore from code (Baseline).
  // 2. Merges user settings (Active/Priority) from backup if available.
  // 3. If backup is empty or missing an item, keeps the default official item intact.
  // 4. Preserves custom user entries.
  const normalizeBackupData = useCallback((source: any) => {
    // UPDATED: Handle extra wrapper layers from backend responses
    const root = source.data || source;
    // UPDATED: Try multiple paths to find the message array
    const targetMessages = root.messages || source.messages || (source.data && source.data.messages) || [];
    const normalizedBackupMessages = normalizeImportedBackupMessages(
      Array.isArray(targetMessages) ? targetMessages : []
    );
    if (
      normalizedBackupMessages.stats.coercedTimestampCount > 0
      || normalizedBackupMessages.stats.droppedCount > 0
    ) {
      console.warn('[RESTORE] Backup message normalization adjusted imported history.', normalizedBackupMessages.stats);
    }

    // --- REHYDRATION LOGIC (CRITICAL FIX) ---
    // Fallback to current app language if backup language is missing or invalid
    const currentLang = root.language || language;
    
    // 1. Get Baseline (Code of Truth)
    const baselineLore = LOCALIZED_WORLD_BOOK[currentLang] || DEFAULT_WORLD_BOOK;
    let finalWorldBook: WorldBookEntry[] = baselineLore;

    // 2. Safely extract backup entries, defaulting to empty array if missing
    const backupEntries = (root.worldBook && Array.isArray(root.worldBook)) 
        ? root.worldBook 
        : [];
    
    // Create a map for O(1) lookup of settings
    // Key: ID, Value: The backup entry (Partial)
    const backupMap = new Map(backupEntries.map((e: any) => [e.id, e]));

    const officialIds = new Set(baselineLore.map(e => e.id));

    // 3. Smart Merge: Official Items
    const mergedOfficial = baselineLore.map(officialEntry => {
        const saved = backupMap.get(officialEntry.id);
        if (saved) {
            // Found in backup? Apply saved settings (Active/Priority)
            // But KEEP content/title from code (officialEntry) to ensure latest lore
            return {
                ...officialEntry,
                isActive: (saved as any).isActive ?? officialEntry.isActive, // Use saved or default
                isHighPriority: (saved as any).isHighPriority ?? officialEntry.isHighPriority
            };
        }
        // Not found in backup? (e.g. Empty cloud or New official item added in code)
        // CRITICAL: Return the official default. DO NOT DELETE.
        return officialEntry; 
    });

    // 4. Smart Merge: Custom Items
    // Filter for entries that exist in backup but NOT in official list
    const customEntries = backupEntries.filter((e: any) => e.id && !officialIds.has(e.id) && e.content); // Ensure content exists

    // Convert partials to full entries for custom items
    const sanitizedCustom = customEntries.map((e: any) => ({
         id: e.id,
         title: e.title || "Custom Entry",
         content: e.content,
         isActive: e.isActive ?? true,
         isHighPriority: !!e.isHighPriority
    }));

    // 5. Combine
    finalWorldBook = [...mergedOfficial, ...sanitizedCustom];

    const normalizedTurnCount = typeof root.turnCount === 'number' ? root.turnCount : 0;
    const normalizedSummaryArchiveState = normalizeSummaryArchiveState(root.summaryArchiveState, normalizedTurnCount);
    const normalizedCoreMemory = resolveCoreMemoryFromSummaryArchive(
      normalizedSummaryArchiveState,
      root.coreMemory || ""
    );
    const hasWorldCharacterStatus = root.worldCharacterStatus !== undefined || source.worldCharacterStatus !== undefined;
    const hasKumikoDiary = root.kumikoDiary !== undefined || source.kumikoDiary !== undefined;
    const hasDailyFragments = root.dailyFragments !== undefined || source.dailyFragments !== undefined;
    const hasPsycheState = root.psycheState !== undefined || source.psycheState !== undefined;
    const hasEpisodes = root.episodes !== undefined || source.episodes !== undefined;

    return {
        messages: normalizedBackupMessages.messages,
        coreMemory: normalizedCoreMemory,
        worldBook: finalWorldBook,
        contextLimit: root.contextLimit || 100,
        turnCount: normalizedTurnCount,
        summaryArchiveState: normalizedSummaryArchiveState,
        currentEmotion: root.currentEmotion || 'neutral',
        locationConfig: root.locationConfig || DEFAULT_LOCATION_CONFIG,
        language: currentLang, // Use the detected language
        anchors: root.anchors || [],
        kumikoNotebook: root.kumikoNotebook || "",
        relativeReminders: Array.isArray(root.relativeReminders)
            ? root.relativeReminders.map(sanitizeRelativeReminderRecord).filter(Boolean)
            : [],
        dailyReminders: Array.isArray(root.dailyReminders)
            ? root.dailyReminders.map(sanitizeDailyReminderRecord).filter(Boolean)
            : [],
        worldCharacterStatus: hasWorldCharacterStatus
            ? sanitizeWorldCharacterStatusRecord(root.worldCharacterStatus ?? source.worldCharacterStatus)
            : undefined,
        kumikoDiary: hasKumikoDiary
            ? (Array.isArray(root.kumikoDiary) ? root.kumikoDiary : source.kumikoDiary)
                .map(sanitizeKumikoDiaryRecord)
                .filter(Boolean)
            : undefined,
        dailyFragments: hasDailyFragments
            ? (Array.isArray(root.dailyFragments) ? root.dailyFragments : source.dailyFragments)
                .map(sanitizeDailyFragmentRecord)
                .filter(Boolean)
            : undefined,
        psycheState: hasPsycheState
            ? sanitizePsycheStateRecord(root.psycheState ?? source.psycheState)
            : undefined,
        episodes: hasEpisodes
            ? (Array.isArray(root.episodes) ? root.episodes : source.episodes)
                .map(sanitizeEpisodeRecord)
                .filter(Boolean)
            : undefined,
    };
  }, [language]);

  const saveScheduleEvent = useCallback(async (event: string, daysOffset: number) => {
      try {
          const targetDate = new Date();
          targetDate.setDate(targetDate.getDate() + daysOffset);
          const dateKey = targetDate.toISOString().slice(0, 10);
          const existingEvents = await db.getVal('kumiko_schedule_events', []);
          existingEvents.push({ event, date: dateKey });
          await db.setVal('kumiko_schedule_events', existingEvents);
          console.log(`[SCHEDULE] Saved event: ${event} for ${dateKey}`);
      } catch (e) {
          console.error("[SCHEDULE] Failed to save event", e);
      }
  }, []);

  const checkActiveReminders = useCallback(async (): Promise<string[]> => {
      try {
          const today = new Date().toISOString().slice(0, 10);
          const existingEvents = await db.getVal('kumiko_schedule_events', []);
          const active = existingEvents.filter((e: any) => e.date === today);
          if (active.length > 0) {
              console.log(`[SCHEDULE] Active reminders for today (${today}):`, active);
              return active.map((e: any) => e.event);
          }
          return [];
      } catch (e) {
          console.error("[SCHEDULE] Failed to check events", e);
          return [];
      }
  }, []);

  const getRelativeReminders = useCallback(async (): Promise<RelativeReminder[]> => {
      try {
          return relativeReminders;
      } catch (e) {
          console.error("[RELATIVE REMINDER] Failed to load reminders", e);
          return [];
      }
  }, [relativeReminders]);

  const setRelativeReminders = useCallback(async (reminders: RelativeReminder[]) => {
      setRelativeRemindersState(reminders);
      await db.setVal(RELATIVE_REMINDER_STORAGE_KEY, reminders);
  }, []);

  const saveRelativeReminder = useCallback(async (event: string, delaySeconds: number, sourceText?: string) => {
      try {
          const safeEvent = normalizeReminderEvent(event);
          const safeDelaySeconds = Math.max(1, Math.round(delaySeconds));
          if (!safeEvent) return;

          const existingReminders = await getRelativeReminders();
          const reminder: RelativeReminder = {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              event: safeEvent,
              dueAt: Date.now() + (safeDelaySeconds * 1000),
              createdAt: Date.now(),
              sourceText: sourceText?.trim() || undefined,
          };
          await setRelativeReminders([...existingReminders, reminder]);
          console.log(`[RELATIVE REMINDER] Saved: ${safeEvent} in ${safeDelaySeconds}s`);
      } catch (e) {
          console.error("[RELATIVE REMINDER] Failed to save reminder", e);
      }
  }, [getRelativeReminders, setRelativeReminders]);

  const markRelativeReminderRetry = useCallback(async (reminderId: string) => {
      const reminders = await getRelativeReminders();
      const updated = reminders.map(reminder => (
          reminder.id === reminderId
              ? { ...reminder, retryAt: Date.now() + REMINDER_RETRY_DELAY_MS }
              : reminder
      ));
      await setRelativeReminders(updated);
  }, [getRelativeReminders, setRelativeReminders]);

  const removeRelativeReminder = useCallback(async (reminderId: string) => {
      const reminders = await getRelativeReminders();
      const nextReminders = reminders.filter(reminder => reminder.id !== reminderId);
      await setRelativeReminders(nextReminders);
  }, [getRelativeReminders, setRelativeReminders]);

  const getDailyReminders = useCallback(async (): Promise<DailyReminder[]> => {
      try {
          return dailyReminders;
      } catch (e) {
          console.error("[DAILY REMINDER] Failed to load reminders", e);
          return [];
      }
  }, [dailyReminders]);

  const setDailyReminders = useCallback(async (reminders: DailyReminder[]) => {
      setDailyRemindersState(reminders);
      await db.setVal(DAILY_REMINDER_STORAGE_KEY, reminders);
  }, []);

  const saveDailyReminder = useCallback(async (event: string, hour: number, minute: number, sourceText?: string) => {
      try {
          const safeEvent = normalizeReminderEvent(event);
          if (!safeEvent) return;

          const existingReminders = await getDailyReminders();
          const reminder: DailyReminder = {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              event: safeEvent,
              hour,
              minute,
              timeZone: locationConfig.modelTimezone || 'Asia/Tokyo',
              createdAt: Date.now(),
              sourceText: sourceText?.trim() || undefined,
          };
          const nextReminders = [...existingReminders, reminder];
          await setDailyReminders(nextReminders);
          console.log(`[DAILY REMINDER] Saved: ${safeEvent} at ${hour}:${minute.toString().padStart(2, '0')} (${reminder.timeZone})`);
      } catch (e) {
          console.error("[DAILY REMINDER] Failed to save reminder", e);
      }
  }, [getDailyReminders, setDailyReminders, locationConfig.modelTimezone]);

  const removeDailyReminder = useCallback(async (reminderId: string) => {
      const reminders = await getDailyReminders();
      const nextReminders = reminders.filter(reminder => reminder.id !== reminderId);
      await setDailyReminders(nextReminders);
  }, [getDailyReminders, setDailyReminders]);

  const toggleDailyReminderPaused = useCallback(async (reminderId: string) => {
      const reminders = await getDailyReminders();
      const nextReminders = reminders.map(reminder => (
          reminder.id === reminderId
              ? { ...reminder, paused: !reminder.paused, retryAt: undefined }
              : reminder
      ));
      await setDailyReminders(nextReminders);
  }, [getDailyReminders, setDailyReminders]);

  const markDailyReminderTriggered = useCallback(async (reminderId: string, dateKey: string) => {
      const reminders = await getDailyReminders();
      const nextReminders = reminders.map(reminder => (
          reminder.id === reminderId
              ? { ...reminder, lastTriggeredDate: dateKey, retryAt: undefined }
              : reminder
      ));
      await setDailyReminders(nextReminders);
  }, [getDailyReminders, setDailyReminders]);

  const markDailyReminderRetry = useCallback(async (reminderId: string) => {
      const reminders = await getDailyReminders();
      const nextReminders = reminders.map(reminder => (
          reminder.id === reminderId
              ? { ...reminder, retryAt: Date.now() + REMINDER_RETRY_DELAY_MS }
              : reminder
      ));
      await setDailyReminders(nextReminders);
  }, [getDailyReminders, setDailyReminders]);

  const addMessage = (role: 'user' | 'model', text: string, image?: string, sources?: {title:string, uri:string}[], customId?: string, customTimestamp?: number, quoteContext?: { id: string, text: string, role: 'user' | 'model' }, storedEmotion?: EmotionType, imageId?: string, voiceExtras?: Partial<Pick<Message, 'isVoiceMessage' | 'voiceFileId' | 'voiceDuration' | 'japaneseText'>>) => {
    const newMessage: Message = {
      id: customId || (Date.now().toString() + Math.random().toString()),
      role,
      text,
      timestamp: customTimestamp || Date.now(),
      image, 
      imageId,
      groundingSources: sources,
      isRead: role === 'model' ? undefined : false, 
      quote: quoteContext,
      storedEmotion,
      ...voiceExtras,
    };
    setMessages((prev) => [...prev, newMessage]);
    return newMessage.id;
  };

  const translateToJapaneseWithEmotion = async (chineseText: string, emotion: EmotionType): Promise<string | null> => {
    try {
      const config = getCurrentAIConfig();
      const emotionTags = EMOTION_TO_FISH_AUDIO_TAGS[emotion] ?? [];
      const tagList = emotionTags.length > 0 ? emotionTags.join(', ') : 'none';

      const systemPrompt = [
        'You are a Chinese-to-Japanese translator. You are NOT a character. Do NOT respond in-character.',
        'Do NOT add greetings, commentary, explanations, or anything beyond the translation.',
        'Output EXACTLY one block of natural spoken Japanese. Nothing else.',
        '',
        'ZERO SEMANTIC DRIFT (HIGHEST PRIORITY):',
        'Your output MUST convey the EXACT same meaning as the input. Do NOT add, remove, embellish, or paraphrase.',
        'SENTENCE COUNT RULE: Output MUST have the same number of sentences/clauses as the input. One Chinese sentence = one Japanese sentence. Do NOT split or merge.',
        'If the input is short (e.g. a greeting), the output MUST be equally short. Do NOT expand a 3-word input into a full sentence.',
        '',
        'CRITICAL — unpronounceable text handling:',
        'The input is meant to be spoken aloud by TTS. Convert ALL text-only expressions into natural spoken Japanese or emotion tags:',
        '- zzz / ZZZ -> [sleepy]すぅ… or ふぁ～…眠い…',
        '- www / 哈哈哈 / 233 -> [laughing]',
        '- ... / …… / 。。。 -> [pause] or convert to natural filler like えっと… / うーん…',
        '- hhhh / 呵呵 -> [chuckling]ふふ',
        '- If the ENTIRE input is just dots/symbols with no real words, produce a short natural utterance matching the emotion (e.g. sleepy -> [sleepy]ん…なに…)',
        'CRITICAL: You MUST output actual Japanese words (Kanji/Kana). Do NOT output only emotion tags or punctuation. If the input is ONLY symbols/emoticons with no real words, produce the shortest possible natural Japanese phrase matching the emotion.',
        'NEVER output raw zzz, www, or bare ellipsis sequences in the Japanese text.',
        '',
        'Target voice style: Oumae Kumiko (黄前久美子) from Hibike! Euphonium.',
        'CRITICAL SPEECH RULES:',
        '1. MUST use CASUAL Japanese (タメ口 - Tameguchi). NEVER use polite language (敬語 - Keigo, です/ます).',
        '2. NEVER use Ojousama speech (e.g., ですわ, かしら, おほほ). She is a normal, slightly cynical girl.',
        '3. First person: 私 (watashi). Second person: あんた (anta) or 君 (kimi).',
        '4. Endings: ONLY USE ～だよね, ～でしょ, ～じゃん, ～かな, ～だよ, ～よ, ～ね, ～けど, ～し, ～の. BANNED ENDINGS: NEVER use ～ねい, ～のよ, ～わよ, ～ますわ, ～ですの — these are NOT Kumiko.',
        '5. Fillers: んー, ま, もー, なんか, ええっと. Often starts with a sigh or slight complaint.',
        '6. Direct and honest (直球), sometimes with childlike stubbornness. She is NOT a soft/gentle speaker. Her default tone is matter-of-fact with a hint of complaint. Do NOT make the translation sound softer or more polite than the original Chinese.',
        '7. VERB/ACTION ACCURACY (CRITICAL): Every verb and action MUST precisely match the original Chinese meaning. Do NOT substitute similar-sounding but different verbs:',
        '   - 提醒 = リマインドする/思い出させる (NOT 教える/伝える)',
        '   - 叫你起床 = 起こす (NOT 声をかける)',
        '   - 等一下 = ちょっと待って (NOT 少々お待ち)',
        '   - 陪你 = そばにいる/付き合う (NOT 応援する)',
        '   If the original says "remind", translate as "remind". If it says "wake up", translate as "wake up". ZERO semantic drift allowed.',
        '8. GENERAL ACCURACY: Maintain the EXACT meaning and nuance of the original Chinese text. Do not alter the semantics (e.g., "才睡" = "just went to sleep", NOT "还醒着" "still awake").',
        '9. PRONUNCIATION: Write character names using Hiragana/Katakana ONLY to prevent TTS mispronunciation. Example: 黄前久美子 -> おうまえ くみこ, 秀一 -> しゅういち, 丽奈 -> れいな, 明日香 -> あすか.',
        '10. GREETINGS LOCK (CRITICAL): If the input is a standard greeting like "早上好", "中午好", or "晚上好", you MUST use standard casual greetings (おはよう, こんにちは, こんばんは, ヤッホー). NEVER translate them literally as time states like "朝だよ" or "お昼だよ".',
        '',
        'Fish Audio S2-Pro emotion tags (MANDATORY — the TTS engine REQUIRES these to produce expressive speech):',
        `Current emotion: [${emotion}]. REQUIRED tags: ${tagList}`,
        'The S2-Pro model supports ANY natural language description in brackets (e.g., [happy], [sad], [whispering], [laughing nervously], [sighs heavily], [speaks excitedly]). You are NOT limited to a fixed list.',
        'ABSOLUTE TAG RULES — VIOLATION MEANS FAILURE:',
        `1. Your output MUST begin with one of these tags: ${tagList}. If you omit the opening tag, the voice will sound robotic and emotionless.`,
        '2. For sentences longer than 15 characters, insert at least one additional mid-sentence tag (e.g., [pause], [softly], [excited]) to keep the voice alive.',
        '3. Use [pause] or [short pause] for commas, ellipses, or natural breathing points.',
        '4. NEVER output a translation with ZERO tags. Even calm speech needs [speaks naturally] or [flat tone] at the start.',
        '',
        'EXAMPLES — follow this style exactly. These reflect Kumiko\'s REAL speech patterns:',
        'Input: "下午好呀" | Emotion: smiling',
        'Output: [happy]こんにちは',
        '',
        'Input: "那我5分钟之后提醒你" | Emotion: neutral',
        'Output: [speaks naturally]じゃあ五分後にリマインドする',
        '',
        'Input: "你今天练习怎么样" | Emotion: smiling',
        'Output: [happy]今日の練習、どうだった？',
        '',
        'Input: "我好不甘心啊..." | Emotion: sad',
        'Output: [sad]悔しい……',
        '',
        'Input: "别说了啦！好烦！" | Emotion: shy',
        'Output: [shy]もー、やめてよ！[muttering]うざい！',
        '',
        'Input: "大人真狡猾" | Emotion: resigned',
        'Output: [sighs]大人ってズルいよね',
      ].join('\n');

      const jaText = await callLLMRaw(systemPrompt, chineseText, config.model_translator || ttsConfigRef.current.model_translator || config.model_main);
      if (!jaText || jaText.length < 2) return null;
      return jaText;
    } catch (err) {
      console.error('[TTS] Translation failed:', err);
      return null;
    }
  };

  const runVoicePipeline = async (
    messageId: string,
    chineseText: string,
    emotion: EmotionType,
  ): Promise<{ success: boolean; voiceFileId?: string; voiceDuration?: number; japaneseText?: string }> => {
    const cfg = ttsConfigRef.current;
    if (!cfg.fishAudioApiKey || !isVoiceServiceAvailable()) {
      console.warn('[TTS] No API key or voice service unavailable');
      return { success: false };
    }
    try {
      let jaText = await translateToJapaneseWithEmotion(chineseText, emotion);
      if (!jaText) {
        console.error('[TTS] Translation returned empty result — degrading to text');
        return { success: false };
      }
      jaText = jaText
        .replace(/[zZ]{2,}/g, '')
        .replace(/[wW]{3,}/g, '')
        .trim();
      if (!jaText || jaText.length < 2) {
        console.error('[TTS] Post-processed translation is empty — degrading to text');
        return { success: false };
      }
      const emotionTemp = EMOTION_TTS_TEMPERATURE[emotion] ?? 0.6;
      const cfgWithEmotion = { ...cfg, temperature: emotionTemp };
      const result = await synthesizeSpeech(jaText, cfgWithEmotion);
      const saved = await saveVoiceFile(messageId, result.audio);
      if (!saved) {
        console.error('[TTS] Failed to save voice file');
        return { success: false };
      }
      return { success: true, voiceFileId: messageId, voiceDuration: result.durationEstimate, japaneseText: jaText };
    } catch (err) {
      const label = err instanceof TtsError ? `${err.kind} (${err.status})` : String(err);
      console.error(`[TTS] Fish Audio synthesis failed: ${label}`);
      return { success: false };
    }
  };

  const [voiceCallOverlayData, setVoiceCallOverlayData] = useState<{
    reminderEvent: string;
    reminderText: string;
    emotion: EmotionType;
    onAccept: () => void;
    onReject: () => void;
    onClose?: () => void;
    isConnecting?: boolean;
    isPlayingVoice?: boolean;
    isEnded?: boolean;
  } | null>(null);

  const [isAutoZipping, setIsAutoZipping] = useState(false);

  useEffect(() => {
    if (!isDesktopElectron() || !window.electronAPI?.on) return;
    const handler = (_event: any, payload: any) => {
      if (payload?.status === 'start') setIsAutoZipping(true);
    };
    window.electronAPI.on('app:auto-zip-progress', handler);
    return () => { window.electronAPI?.removeListener?.('app:auto-zip-progress', handler); };
  }, []);

  useEffect(() => {
    if (!isDesktopElectron() || !window.electronAPI) {
      setAppUpdateState(prev => ({ ...prev, status: 'unsupported', isPackaged: false }));
      return;
    }

    let cancelled = false;

    const handleUpdateStatus = (_event: any, payload: AppUpdateState) => {
      if (!payload) return;
      setAppUpdateState(prev => ({ ...prev, ...payload }));
    };

    window.electronAPI.on('app:update-status', handleUpdateStatus);
    window.electronAPI.invoke('app:update:get-state')
      .then((result: any) => {
        if (cancelled || !result?.success || !result.state) return;
        setAppUpdateState(prev => ({ ...prev, ...result.state }));
      })
      .catch((error) => {
        console.error('[UPDATER] Failed to read initial updater state:', error);
      });

    return () => {
      cancelled = true;
      window.electronAPI?.removeListener?.('app:update-status', handleUpdateStatus);
    };
  }, []);

  useEffect(() => {
    const previousStatus = lastAppUpdateStatusRef.current;

    if (appUpdateState.status === 'available' && previousStatus !== 'available' && appUpdateState.availableVersion) {
      const nextText = UI_TRANSLATIONS[language].updateToastAvailable.replace('{0}', `v${appUpdateState.availableVersion}`);
      setSystemNotice(nextText);
    }

    if (appUpdateState.status === 'downloaded' && previousStatus !== 'downloaded') {
      setSystemNotice(UI_TRANSLATIONS[language].updateToastReady);
      setShowAppUpdateModal(true);
    }

    lastAppUpdateStatusRef.current = appUpdateState.status;
  }, [appUpdateState.status, appUpdateState.availableVersion, language]);

  const handleCheckForAppUpdates = useCallback(async () => {
    if (!isDesktopElectron() || !window.electronAPI) return;
    try {
      const result = await window.electronAPI.invoke('app:update:check');
      if (result?.success === false && result?.error) {
        setAppUpdateState(prev => ({ ...prev, status: 'error', error: result.error }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[UPDATER] Failed to start update check:', error);
      setAppUpdateState(prev => ({ ...prev, status: 'error', error: message }));
    }
  }, []);

  const handleDownloadAppUpdate = useCallback(async () => {
    if (!isDesktopElectron() || !window.electronAPI) return;
    try {
      const result = await window.electronAPI.invoke('app:update:download');
      if (result?.success === false && result?.error) {
        setAppUpdateState(prev => ({ ...prev, status: 'error', error: result.error }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[UPDATER] Failed to start update download:', error);
      setAppUpdateState(prev => ({ ...prev, status: 'error', error: message }));
    }
  }, []);

  const handleInstallAppUpdate = useCallback(async () => {
    if (!isDesktopElectron() || !window.electronAPI) return;
    setShowAppUpdateModal(false);
    try {
      const result = await window.electronAPI.invoke('app:update:quit-and-install');
      if (result?.success === false && result?.error) {
        setAppUpdateState(prev => ({ ...prev, status: 'error', error: result.error }));
        setShowAppUpdateModal(true);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[UPDATER] Failed to install downloaded update:', error);
      setAppUpdateState(prev => ({ ...prev, status: 'error', error: message }));
      setShowAppUpdateModal(true);
    }
  }, []);

  const performFileSave = async (handle: any, data: any) => {
    try {
      const backupContent = { timestamp: Date.now(), version: "1.3", data };
      const serializedContent = JSON.stringify(backupContent, null, 2);

      if (isDesktopElectron() && typeof handle === 'string') {
        const result = await writeDesktopBackupFile(handle, serializedContent);
        if (!result.success) {
          throw new Error(result.error || 'Failed to write desktop backup file.');
        }
      } else {
        const writable = await handle.createWritable();
        await writable.write(serializedContent);
        await writable.close();
      }

      return true;
    } catch (e) {
      console.warn("Manual save write failed:", e);
      clearLocalFileConnection();
      return false;
    }
  };

  const performCloudSync = async (url: string, data: any, apiKey?: string, userId?: string) => {
    try {
      const backupContent = { timestamp: Date.now(), version: "1.3", userId: userId || 'default_user', data };
      const headers: any = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(backupContent) });
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const contentType = res.headers.get('content-type');
      if (contentType && contentType.includes('text/html')) throw new Error("HTML Response received (Wrong URL?)");
      return true;
    } catch (e) {
      console.error(`[CLOUD SYNC] Failed to sync to ${url}`, e);
      return false;
    }
  };

  const persistNormalizedBackupData = useCallback(async (normalizedData: any) => {
    const normalizedMessages = Array.isArray(normalizedData.messages) ? normalizedData.messages : [];
    const recalculatedTurnCount = recalculateTurnCountFromMessages(normalizedMessages);
    const normalizedSummaryState = normalizeSummaryArchiveState(
      normalizedData.summaryArchiveState,
      recalculatedTurnCount
    );
    const normalizedCoreMemory = resolveCoreMemoryFromSummaryArchive(
      normalizedSummaryState,
      normalizedData.coreMemory
    );

    await syncRawHistoryMessages(normalizedMessages, { forceFull: true });
    if (Array.isArray(normalizedData.episodes)) {
      await db.episodes.clear();
      if (normalizedData.episodes.length > 0) {
        await db.episodes.bulkPut(normalizedData.episodes);
      }
    } else {
      await syncTemporalEpisodes(normalizedMessages);
    }
    rawHistorySyncedIdsRef.current = new Set(normalizedMessages.map((message: Message) => message.id));
    forceRawHistoryResyncRef.current = false;
    await yieldToMainThread();

    if (normalizedData.kumikoDiary !== undefined) {
      await db.kumikoDiary.clear();
      if (normalizedData.kumikoDiary.length > 0) {
        await db.kumikoDiary.bulkPut(normalizedData.kumikoDiary);
      }
    }

    if (normalizedData.dailyFragments !== undefined) {
      await db.dailyFragments.clear();
      if (normalizedData.dailyFragments.length > 0) {
        await db.dailyFragments.bulkPut(normalizedData.dailyFragments);
      }
    }

    if (normalizedData.psycheState !== undefined) {
      await db.psycheState.clear();
      if (normalizedData.psycheState) {
        await db.psycheState.put(normalizedData.psycheState);
      }
    }

    const writes: Promise<unknown>[] = [
      db.setVal('kumiko_core_memory', normalizedCoreMemory),
      db.setVal('kumiko_world_book', normalizedData.worldBook),
      db.setVal('kumiko_context_limit', normalizedData.contextLimit),
      db.setVal('kumiko_turn_count', recalculatedTurnCount),
      db.setVal(SUMMARY_ARCHIVE_STATE_STORAGE_KEY, normalizedSummaryState),
      db.setVal('kumiko_current_emotion', normalizedData.currentEmotion),
      db.setVal('kumiko_location_config', normalizedData.locationConfig),
      db.setVal('kumiko_language', normalizedData.language),
      db.setVal('kumiko_anchors', normalizedData.anchors),
      db.setVal('kumiko_notebook', normalizedData.kumikoNotebook),
      db.setVal(RELATIVE_REMINDER_STORAGE_KEY, normalizedData.relativeReminders || []),
      db.setVal(DAILY_REMINDER_STORAGE_KEY, normalizedData.dailyReminders || []),
    ];

    if (normalizedData.worldCharacterStatus !== undefined) {
      writes.push(db.setVal('world_character_status', normalizedData.worldCharacterStatus));
    }

    await Promise.all(writes);
  }, []);

  const restoreBackupData = useCallback(async (backup: any) => {
    if (!backup) return null;
    
    console.log("[RESTORE] Normalizing backup data summary:", summarizeBackupPayloadForLog(backup));
    const normalizedData = normalizeBackupData(backup);
    console.log("[RESTORE] Normalized Data Messages count:", normalizedData.messages.length);
    const restoredTurnCount = recalculateTurnCountFromMessages(Array.isArray(normalizedData.messages) ? normalizedData.messages : []);
    const restoredSummaryArchiveState = normalizeSummaryArchiveState(
      normalizedData.summaryArchiveState,
      restoredTurnCount
    );
    const resolvedData = {
      ...normalizedData,
      worldCharacterStatus: normalizedData.worldCharacterStatus ?? worldCharacterStatus,
      kumikoDiary: normalizedData.kumikoDiary ?? autoSavedKumikoDiary,
      dailyFragments: normalizedData.dailyFragments ?? autoSavedDailyFragments,
      psycheState: normalizedData.psycheState === undefined ? autoSavedPsycheState : normalizedData.psycheState,
    };

    isBulkRestoreInProgressRef.current = true;

    try {
      await yieldToMainThread();

      React.startTransition(() => {
        if (Array.isArray(normalizedData.messages)) {
          forceRawHistoryResyncRef.current = true;
          rawHistorySyncedIdsRef.current = new Set();
          updateMemoryQuerySession(null);
          setMessages(normalizedData.messages);
        }
        setCoreMemory(normalizedData.coreMemory);
        setWorldBook(normalizedData.worldBook);
        setContextLimit(normalizedData.contextLimit);
        setTurnCount(restoredTurnCount);
        setSummaryArchiveState(restoredSummaryArchiveState);
        setCurrentEmotion(normalizedData.currentEmotion);
        setLocationConfig(normalizedData.locationConfig);
        setLanguage(normalizedData.language);
        setAnchors(normalizedData.anchors);
        setKumikoNotebook(normalizedData.kumikoNotebook);
        setRelativeRemindersState(normalizedData.relativeReminders || []);
        setDailyRemindersState(normalizedData.dailyReminders || []);
        if (normalizedData.worldCharacterStatus !== undefined) {
          setWorldCharacterStatus(normalizedData.worldCharacterStatus);
        }
        if (normalizedData.kumikoDiary !== undefined) {
          setAutoSavedKumikoDiary(normalizedData.kumikoDiary);
        }
        if (normalizedData.dailyFragments !== undefined) {
          setAutoSavedDailyFragments(normalizedData.dailyFragments);
        }
        if (normalizedData.psycheState !== undefined) {
          setAutoSavedPsycheState(normalizedData.psycheState);
        }
      });

      await yieldToMainThread(2);
      await persistNormalizedBackupData(normalizedData);
      return resolvedData;
    } finally {
      isBulkRestoreInProgressRef.current = false;
    }
  }, [
    normalizeBackupData,
    persistNormalizedBackupData,
    worldCharacterStatus,
    autoSavedKumikoDiary,
    autoSavedDailyFragments,
    autoSavedPsycheState,
  ]);

  const restoreParsedBackupPayload = useCallback(async (
    backupJson: any,
    importedImages: Array<{ id: string; dataUrl: string }> = []
  ) => {
    if (!backupJson) return null;

    if (importedImages.length > 0) {
      for (let imageIndex = 0; imageIndex < importedImages.length; imageIndex += 1) {
        const image = importedImages[imageIndex];
        await imageService.saveImageWithId(image.id, image.dataUrl);

        if ((imageIndex + 1) % 8 === 0) {
          await yieldToMainThread();
        }
      }
    }

    return restoreBackupData(backupJson);
  }, [restoreBackupData]);


  const handleCreateNewLocalFile = useCallback(async () => {
    try {
      const defaultFileName = `kumiko_backup_${new Date().toISOString().slice(0,10)}.json`;

      if (isDesktopElectron()) {
        const result = await pickDesktopBackupSaveFile(defaultFileName);
        if (result.canceled) return false;
        if (!result.success || !result.filePath) {
          alert("Failed to access local file: " + (result.error || ""));
          return false;
        }

        fileHandleRef.current = result.filePath;
        setConnectedFileName(result.fileName || result.filePath.split(/[\\/]/).pop() || result.filePath);
        localStorage.setItem(LOCAL_BACKUP_PATH_STORAGE_KEY, result.filePath);
      } else {
        // @ts-ignore
        if (typeof window.showSaveFilePicker !== 'function') { alert("Your browser does not support the File System Access API."); return false; }
        // @ts-ignore
        const handle = await window.showSaveFilePicker({ suggestedName: defaultFileName, types: [{ description: 'JSON Backup File', accept: { 'application/json': ['.json'] }, }], });
        fileHandleRef.current = handle;
        setConnectedFileName(handle.name);
        localStorage.removeItem(LOCAL_BACKUP_PATH_STORAGE_KEY);
      }

      setBackupConfig(prev => normalizeBackupConfig({ ...prev, localEnabled: true }));
      const didSave = await performFileSave(fileHandleRef.current, backupData);
      if (!didSave) return false;

      const savedAt = Date.now();
      setLastBackupTime(savedAt);
      updateBaseline(savedAt);
      return true;
    } catch (err: any) {
      if (err.name === 'AbortError') return false;
      alert("Failed to access file system: " + (err.message || ""));
      return false;
    }
  }, [backupData, updateBaseline]); 

  const handleDisconnectLocalFile = useCallback(() => {
    fileHandleRef.current = null;
    setConnectedFileName(null);
    localStorage.removeItem(LOCAL_BACKUP_PATH_STORAGE_KEY);
    setBackupConfig(prev => normalizeBackupConfig({ ...prev, localEnabled: false }));
  }, []);

  const handleOpenLocalFile = useCallback(async () => {
    try {
      let text = '';
      let parsedJson: any = null;

      if (isDesktopElectron()) {
        const result = await pickDesktopBackupOpenFile();
        if (result.canceled) return false;
        if (!result.success || !result.filePath) {
          alert("Failed to access local file: " + (result.error || ""));
          return false;
        }

        fileHandleRef.current = result.filePath;
        setConnectedFileName(result.fileName || result.filePath.split(/[\\/]/).pop() || result.filePath);
        localStorage.setItem(LOCAL_BACKUP_PATH_STORAGE_KEY, result.filePath);
        const parsedResult = await parseDesktopBackupImportFile(result.filePath);
        if (!parsedResult.success || !parsedResult.json) {
          throw new Error(parsedResult.error || 'Failed to parse desktop backup file.');
        }
        parsedJson = parsedResult.json;
      } else {
        // @ts-ignore
        if (typeof window.showOpenFilePicker !== 'function') { alert("Your browser does not support the File System Access API."); return false; }
        // @ts-ignore
        const [handle] = await window.showOpenFilePicker({ types: [{ description: 'JSON Backup File', accept: { 'application/json': ['.json'] }, }], multiple: false });
        fileHandleRef.current = handle;
        setConnectedFileName(handle.name);
        localStorage.removeItem(LOCAL_BACKUP_PATH_STORAGE_KEY);

        try {
          const file = await handle.getFile();
          text = await file.text();
        } catch (readErr) {
          console.log("Error reading file:", readErr);
          alert("Failed to read the selected file.");
          return false;
        }
      }

      setBackupConfig(prev => normalizeBackupConfig({ ...prev, localEnabled: true }));

      if (parsedJson || text) {
        await yieldToMainThread();
        const json = parsedJson ?? JSON.parse(text);

        // --- PRE-CHECK FOR MISSING VOICE FILES ---
        const dataToRestore = json.data || json;
        const msgs = dataToRestore?.messages || [];
        const voiceCount = msgs.filter((m: any) => m.isVoiceMessage).length;
        
        if (voiceCount > 0 && isVoiceServiceAvailable()) {
            const { listVoiceFiles } = await import('../services/voiceFileService');
            const voiceFiles = await listVoiceFiles();
            if (voiceFiles.length === 0) {
                const confirmMsg = language === 'zh' 
                    ? `检测到您的备份包含 ${voiceCount} 条语音记录，但当前数据目录中没有音频文件。导入后语音将无法播放。\n\n建议您导入完整的 ZIP 备份，或稍后手动将音频文件放入数据目录。\n\n是否继续仅导入文本？`
                    : `Your backup contains ${voiceCount} voice messages, but no audio files were found in the current data directory. Voices will not play after import.\n\nIt is recommended to import a full ZIP backup, or manually place the audio files in the data directory later.\n\nContinue importing text only?`;
                
                const proceed = window.confirm(confirmMsg);
                if (!proceed) {
                    return false;
                }
            }
        }

        const restoredData = json ? await restoreBackupData(json) : null;
        if (restoredData) {
          const restoredAt = json.timestamp || Date.now();
          setLastBackupTime(restoredAt);
          updateBaseline(restoredAt, restoredData);
          return true;
        }
      }

      return true;
    } catch (err: any) {
      if (err.name === 'AbortError') return false;
      alert("Failed to access file system: " + (err.message || ""));
      return false;
    }
  }, [restoreBackupData, updateBaseline]);

  const handleManualLocalReload = useCallback(async () => {
      const handle = fileHandleRef.current;
      if (!handle) return;
      if (!window.confirm("Reload data from local file? Current unsaved changes will be lost.")) return;
      try {
          let text = '';
          let parsedJson: any = null;

          if (isDesktopElectron() && typeof handle === 'string') {
              const parsedResult = await parseDesktopBackupImportFile(handle);
              if (!parsedResult.success || !parsedResult.json) {
                  throw new Error(parsedResult.error || 'Failed to parse desktop backup file.');
              }
              parsedJson = parsedResult.json;
          } else {
              const file = await handle.getFile();
              text = await file.text();
          }

          if (parsedJson || text) {
              await yieldToMainThread();
              const json = parsedJson ?? JSON.parse(text);
              const restoredData = await restoreBackupData(json);
              if (restoredData) {
                  updateBaseline(json.timestamp || Date.now(), restoredData);
                  alert("Data reloaded successfully.");
              }
          }
      } catch (e) {
          console.error(e);
          alert("Failed to reload data.");
      }
  }, [restoreBackupData, updateBaseline]);

  // ... (Other effects and toggleFullscreen) ...
  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => console.error(`Error: ${err.message}`));
    } else if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  };

  useEffect(() => {
    if (flowState !== 'APP') return;
    const themeColor = isDarkMode ? '#121212' : '#f0f0f0';
    document.body.style.backgroundColor = themeColor;
    document.documentElement.style.backgroundColor = themeColor;
    let metaThemeColor = document.querySelector("meta[name='theme-color']");
    if (!metaThemeColor) {
      metaThemeColor = document.createElement('meta');
      metaThemeColor.setAttribute('name', 'theme-color');
      document.head.appendChild(metaThemeColor);
    }
    metaThemeColor.setAttribute('content', themeColor);
  }, [isDarkMode, flowState]);

  useEffect(() => {
    const init = async () => {
      try {
        await startChat();
        setAppState(AppState.CONNECTED);
      } catch (error) {
        console.error("Failed to connect:", error);
        setAppState(AppState.ERROR);
      }
    };
    if (flowState === 'APP') {
        init();
    }
  }, [flowState]); 

  useEffect(() => {
    if (flowState === 'APP' && messages.length === 0) {
        setTimeout(async () => {
            setIsTalking(true);
            addMessage('model', '嗯？怎么了？', undefined, undefined, 'greeting-1');
            await new Promise(r => setTimeout(r, 1000));
            addMessage('model', '突然联系我干啥', undefined, undefined, 'greeting-2');
            setTimeout(() => setIsTalking(false), 1000);
        }, 1500);
    }
  }, [flowState]);

  // --- NATIVE PROACTIVE INITIATION PROTOCOL (Adult Teacher Phase) ---
  const triggerNativeProactiveMessage = useCallback(async (gapHours: number, eventDescription: string) => {
      // 1. STRICT CLOUD PRIORITY RULE
      if (backupConfig.cloudEnabled && backupConfig.endpointUrl) {
          console.log("[Native Proactive] Blocked Auto-Trigger: Cloud Sync is active. Waiting for Cloud Restore.");
          return;
      }

      // 2. SESSION LOCK
      if (welcomeTriggeredRef.current || isTalking || isThinking) {
          console.log("[Native Proactive] Blocked: Already triggered or currently active.");
          return;
      }
      
      welcomeTriggeredRef.current = true;
      hasGoneToSleepRef.current = false;

      const timeOptions: Intl.DateTimeFormatOptions = { 
          timeZone: locationConfig.modelTimezone, 
          hour: '2-digit', minute: '2-digit', hour12: false 
      };
      const jstTimeStr = new Date().toLocaleString('en-US', timeOptions);
      
      const systemPrompt = language === 'zh' ? `[SYSTEM_ACTIVATION_PROTOCOL: 纯净生活挂机模拟]
      你现在要在手机 Line 上主动向用户发一条消息。
      【强制纪律】
      1. 您正在过您自己的生活，此时是日本时间 ${jstTimeStr}。
      2. 您正在经历的状态/事件是：${eventDescription}。
      3. 您【绝对不知道】用户现在在现实里在做什么，也【绝对不能猜测】用户睡没睡。
      4. 严禁使用“你还不睡吗”、“你在屏幕前干嘛”之类带有监控感的越界语句！绝对禁止！
      5. 就像在工作间隙、通勤路上或深夜改作业时突然想到对方，随口抱怨一句日常、分享当下状态、或聊聊秀一。保持极简短，1-2句话，不要显得太黏人。` 
      : `[SYSTEM_ACTIVATION_PROTOCOL: Pure Life Simulation]
      You are initiating a message to the user on LINE.
      [STRICT DISCIPLINE]
      1. You are living your own life. It is currently Japan Time ${jstTimeStr}.
      2. Your current status/event: ${eventDescription}.
      3. You absolutely DO NOT KNOW what the user is doing physically, and CANNOT guess if they are awake or asleep.
      4. NEVER use surveillance-like sentences such as "Are you still awake?" or "What are you doing at the screen?".
      5. Keep it natural like you just thought of them during a work break, commute, or late-night grading. Share a quick complaint, current status, or mention Shuichi. Keep it very short (1-2 sentences) and not clingy.`;
      
      setIsThinking(true);
      
      try {
          const recentMessages = messages.slice(-contextLimit);
          
          const response = await sendMessageToGemini(
              systemPrompt,
              coreMemory,
              [...worldBook, ...KUMIKO_LOCAL_RAG_ZH],
              recentMessages,
              locationConfig,
              undefined, undefined, 0, undefined, [], undefined, [], anchors, kumikoNotebook,
              undefined,
              language
          );
          
          setIsThinking(false);
          setIsTalking(true);
          
          const msgText = response.textParts[0];
          const proactiveMessageId = addMessage('model', msgText, undefined, undefined, undefined, undefined, undefined, response.emotion);
          showBackgroundMessageNotification(msgText, 'proactive', proactiveMessageId);
          
          if (response.textParts.length > 1) {
              for (let i=1; i<response.textParts.length; i++) {
                  await new Promise(r => setTimeout(r, 1000));
                  addMessage('model', response.textParts[i], undefined, undefined, undefined, undefined, undefined, response.emotion);
              }
          }
          
          setTimeout(() => setIsTalking(false), 2000);
           
           // RESET SESSION LOCK after a cooldown so future proactive messages can trigger
           // 3-minute cooldown prevents rapid re-triggers within the same heartbeat cycle
           setTimeout(() => {
               welcomeTriggeredRef.current = false;
               console.log("[Native Proactive] Session lock released. Ready for next proactive trigger.");
           }, 180000); // 3 minutes
           
       } catch (e) {
           console.error("Native Proactive trigger failed", e);
           setIsThinking(false);
           // RESET on failure too so the system can retry
           welcomeTriggeredRef.current = false;
       }
  }, [messages, coreMemory, worldBook, contextLimit, locationConfig, anchors, kumikoNotebook, isTalking, isThinking, language, backupConfig, addMessage, showBackgroundMessageNotification]);

  const triggerTimedReminderMessage = useCallback(async (reminder: Pick<RelativeReminder, 'event' | 'sourceText'> | Pick<DailyReminder, 'event' | 'sourceText'>): Promise<boolean> => {
      const userTimeStr = new Date().toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
        timeZone: locationConfig.timezone,
        weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
      
      const systemPrompt = language === 'zh' ? `[SYSTEM_ACTIVATION_PROTOCOL: 约好时间的提醒]
      之前用户拜托过你到时间提醒这件事，现在已经到点了。
      要提醒的事：${reminder.event}
      ${reminder.sourceText ? `用户当时大意是：${reminder.sourceText}` : ''}
      【重要时区注意】：用户当前所在时区的本地时间是 ${userTimeStr}。请严格根据【用户的时间】来判断用户的作息状态。如果用户那边是晚上，绝对不要说“早上好”或让用户“别赖床”。
      规则：
      1. 像黄前久美子本人突然想起来后给对方发一条 Line 一样自然。
      2. 直接用祈使句催促，例如"快去洗衣服！""该吃饭了！""别忘了喝水！"，而不是"喊用户去xxx"这种描述式。
      3. 保持简短，1-2句话就够，可以轻轻催一下或顺手吐槽一句。
      4. 不要提系统、定时器、倒计时、自动触发、后台、模块。`
      : `[SYSTEM_ACTIVATION_PROTOCOL: PROMISED REMINDER]
      The user asked you earlier to remind them when the time came, and now it is due.
      Reminder topic: ${reminder.event}
      ${reminder.sourceText ? `Original request context: ${reminder.sourceText}` : ''}
      [CRITICAL TIMEZONE NOTE]: The user's current local time is ${userTimeStr}. Strictly base your greeting and context on the USER'S time. Do not say "good morning" or "wake up" if it's evening for the user.
      Rules:
      1. Sound like Kumiko herself suddenly remembering and sending a LINE message.
      2. Use direct imperative phrases like "Go do laundry!" "Time to eat!" rather than descriptive phrases like "remind user to do X".
      3. Keep it short, just 1-2 natural lines, with maybe a light nudge or tiny complaint.
      4. Do not mention systems, timers, countdowns, automation, background tasks, or modules.`;

      setIsThinking(true);

      try {
          const recentMessages = messagesRef.current.slice(-contextLimit);
          const response = await sendMessageToGemini(
              systemPrompt,
              coreMemory,
              [...worldBook, ...KUMIKO_LOCAL_RAG_ZH],
              recentMessages,
              locationConfig,
              undefined, undefined, 0, undefined, [], undefined, [], anchors, kumikoNotebook,
              undefined,
              language
          );

          setCurrentEmotion(response.emotion);
          if (response.systemNotice) {
              setSystemNotice(response.systemNotice);
          }

          const firstText = response.textParts[0] || (language === 'zh' ? `喂$该去${reminder.event}了吧` : `Hey. Time to ${reminder.event}.`);
          const combinedReminderText = response.textParts.join(' ');
          const currentTtsCfg = ttsConfigRef.current;

          if (currentTtsCfg.voiceMode !== 'text' && currentTtsCfg.fishAudioApiKey && isVoiceServiceAvailable()) {
              setIsThinking(false);

              const isInForeground = !document.hidden && document.hasFocus();

              if (isInForeground) {
                  // Foreground: deliver as a voice message in chat (no call overlay)
                  setIsTalking(true);
                  const voiceResult = await runVoicePipeline('reminder-' + Date.now(), combinedReminderText, response.emotion);
                  if (voiceResult.success) {
                      addMessage('model', combinedReminderText, undefined, undefined, undefined, undefined, undefined, response.emotion, undefined, {
                          isVoiceMessage: true, voiceFileId: voiceResult.voiceFileId, voiceDuration: voiceResult.voiceDuration, japaneseText: voiceResult.japaneseText,
                      });
                  } else {
                      addMessage('model', combinedReminderText, undefined, undefined, undefined, undefined, undefined, response.emotion);
                  }
                  setTimeout(() => setIsTalking(false), 2000);
                  return true;
              }

              // Background: use call overlay + ringtone + notification
              let voiceResultPromise = runVoicePipeline('reminder-' + Date.now(), combinedReminderText, response.emotion);
              
              const notifBody = combinedReminderText ? combinedReminderText.slice(0, 50) : reminder.event;
              if (isDesktopElectron()) {
                  window.electronAPI?.send('app:send-call-notification', {
                      title: language === 'zh' ? '黄前久美子 来电...' : 'Incoming Call: Kumiko Oumae',
                      body: notifBody,
                  });
              } else if ('Notification' in window && Notification.permission === 'granted') {
                  new Notification(language === 'zh' ? '黄前久美子 来电...' : 'Incoming Call: Kumiko Oumae', {
                      body: notifBody,
                  });
              }

              return new Promise<boolean>((resolve) => {
                  setVoiceCallOverlayData({
                      reminderEvent: reminder.event,
                      reminderText: combinedReminderText,
                      emotion: response.emotion,
                      onAccept: async () => {
                          setIsTalking(true);
                          setVoiceCallOverlayData(prev => prev ? { ...prev, isConnecting: true } : null);
                          if (isDesktopElectron()) window.electronAPI?.send('app:close-call-notification');
                          
                          const voiceResult = await voiceResultPromise;
                          
                          if (voiceResult.success) {
                              const voiceMsgId = addMessage('model', combinedReminderText, undefined, undefined, undefined, undefined, undefined, response.emotion, undefined, {
                                  isVoiceMessage: true, voiceFileId: voiceResult.voiceFileId, voiceDuration: voiceResult.voiceDuration, japaneseText: voiceResult.japaneseText,
                              });
                              showBackgroundMessageNotification(combinedReminderText, 'reminder', voiceMsgId);
                              const buf = await (await import('../services/voiceFileService')).loadVoiceFile(voiceResult.voiceFileId!);
                              if (buf) {
                                  setVoiceCallOverlayData(prev => prev ? { ...prev, isConnecting: false, isPlayingVoice: true } : null);
                                  
                                  const blob = new Blob([buf], { type: 'audio/mpeg' });
                                  const url = URL.createObjectURL(blob);
                                  const audio = new Audio(url);
                                  audio.onended = () => {
                                      URL.revokeObjectURL(url);
                                      setVoiceCallOverlayData(prev => prev ? { ...prev, isPlayingVoice: false, isEnded: true } : null);
                                      setIsTalking(false);
                                  };
                                  audio.play().catch(() => {
                                      setVoiceCallOverlayData(null);
                                      setIsTalking(false);
                                      resolve(true);
                                  });
                              } else {
                                  setVoiceCallOverlayData(null);
                                  setIsTalking(false);
                                  resolve(true);
                              }
                          } else {
                              addMessage('model', combinedReminderText, undefined, undefined, undefined, undefined, undefined, response.emotion);
                              setVoiceCallOverlayData(null);
                              setIsTalking(false);
                              resolve(true);
                          }
                      },
                      onReject: () => {
                          if (isDesktopElectron()) window.electronAPI?.send('app:close-call-notification');
                          setVoiceCallOverlayData(null);
                          resolve(true);
                      },
                      onClose: () => {
                          setVoiceCallOverlayData(null);
                          resolve(true);
                      },
                  });
              });
          }

          setIsThinking(false);
          setIsTalking(true);

          const reminderMessageId = addMessage('model', firstText, undefined, undefined, undefined, undefined, undefined, response.emotion);
          showBackgroundMessageNotification(firstText, 'reminder', reminderMessageId);

          if (response.textParts.length > 1) {
              for (let i = 1; i < response.textParts.length; i++) {
                  await new Promise(r => setTimeout(r, 1000));
                  addMessage('model', response.textParts[i], undefined, undefined, undefined, undefined, undefined, response.emotion);
              }
          }

          setTimeout(() => setIsTalking(false), 2000);
          console.log(`[TIMED REMINDER] Delivered: ${reminder.event}`);
          return true;
      } catch (e) {
          console.error("[TIMED REMINDER] Delivery failed", e);
          setIsThinking(false);
          setIsTalking(false);
          return false;
      }
  }, [language, contextLimit, coreMemory, worldBook, locationConfig, anchors, kumikoNotebook, addMessage, showBackgroundMessageNotification]);

  // --- 24/7 BACKGROUND HEARTBEAT POLLING (10 Minute checks) ---
  useEffect(() => {
      // PLAN B: BLOCKER for Cloud
      if (backupConfig.cloudEnabled && backupConfig.endpointUrl && !hasPerformedInitialPull.current) {
          return;
      }
      if (flowState !== 'APP') return;

      const checkProactiveLifeEvent = async () => {
          if (isTalking || isThinking) return;

          // --- DAILY DIARY SETTLEMENT ---
          const now = Date.now();
          const jstDate = new Date(new Date(now).toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
          const hourJST = jstDate.getHours();
          const dateStr = `${jstDate.getFullYear()}-${String(jstDate.getMonth() + 1).padStart(2, '0')}-${String(jstDate.getDate()).padStart(2, '0')}`;
          const ambientEnvironmentContext = await getAmbientEnvironmentContext();
          const isHoliday = ambientEnvironmentContext.includes('今日特殊历法：日本法定节假日');
          
          if (hourJST >= 23 || hourJST < 3) {
            const { db } = await import('../services/db');
            const existingDiary = await db.kumikoDiary.where('date').equals(dateStr).first();
            if (!existingDiary) {
              console.log(`[LifeStream] Triggering daily diary settlement for ${dateStr}`);
              const { generateDailyDiary } = await import('../services/lifeStreamService');
              const todayMessages = messages.filter(m => {
                const mDate = new Date(new Date(m.timestamp).toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
                return mDate.getFullYear() === jstDate.getFullYear() && 
                       mDate.getMonth() === jstDate.getMonth() && 
                       mDate.getDate() === jstDate.getDate();
              });
              const diary = await generateDailyDiary(
                dateStr,
                todayMessages.map(message => ({
                  role: message.role,
                  text: message.text,
                  timestamp: message.timestamp,
                })),
                undefined,
                ambientEnvironmentContext,
                isHoliday,
                false
              );
              if (diary) {
                // Clear today's fragments after settlement
                await db.dailyFragments.where('date').equals(dateStr).delete();
                
                // Embed diary into RAG
                const { embedDiaryToRAG } = await import('../services/lifeStreamService');
                await embedDiaryToRAG(diary);
              }
            }
          }
          // ------------------------------

          if (localStorage.getItem('enable_proactive_messaging') === 'false') {
              console.log("[Heartbeat] Proactive messaging disabled by user.");
              return;
          }

          const lastMsg = messages[messages.length - 1];
          if (!lastMsg) return;

          const currentTime = Date.now();
          const gapHours = (currentTime - lastMsg.timestamp) / (1000 * 60 * 60);
          
          // COOL DOWN: Require at least 3 hours of silence before proactively messaging
          if (gapHours < 3) return;

          // --- STATE MACHINE DRIVEN PROACTIVE ---
          const { getCurrentKumikoState } = await import('../services/kumikoStateMachine');
          const stateCtx = getCurrentKumikoState(locationConfig.modelTimezone, isHoliday);
          
          let triggerChance = stateCtx.proactiveProbability;
          let eventDescription = stateCtx.stateDescription;

          const recent7DayMessageCount = messages.filter(msg => currentTime - msg.timestamp <= 7 * 24 * 60 * 60 * 1000).length;
          const relationshipWarmthFactor = recent7DayMessageCount >= 120 ? 1.22 : recent7DayMessageCount >= 50 ? 1.12 : recent7DayMessageCount <= 12 ? 0.88 : 1;
          
          triggerChance = Math.min(0.35, triggerChance * relationshipWarmthFactor);

          if (Math.random() <= triggerChance) {
              console.log(`[Heartbeat] Triggering Proactive. State: ${stateCtx.currentState}, Chance: ${triggerChance}`);
              triggerNativeProactiveMessage(gapHours, eventDescription);
          } else {
              console.log(`[Heartbeat] Skipped by RNG. State: ${stateCtx.currentState}, Chance: ${triggerChance}`);
          }
      };

      // Poll every 10 minutes
      const intervalId = setInterval(checkProactiveLifeEvent, 600000);
      
      // Also check shortly after initial load
      const timeoutId = setTimeout(checkProactiveLifeEvent, 15000);

      return () => {
          clearInterval(intervalId);
          clearTimeout(timeoutId);
      };
  }, [messages, flowState, backupConfig.cloudEnabled, backupConfig.endpointUrl, locationConfig, isTalking, isThinking, triggerNativeProactiveMessage]);

  useEffect(() => {
      if (flowState !== 'APP') return;

      const checkScheduledReminders = async () => {
          if (reminderDispatchingRef.current || isTalking || isThinking) return;

          reminderDispatchingRef.current = true;
          try {
              const now = Date.now();
              const relativeReminder = (await getRelativeReminders())
                  .filter(reminder => reminder.dueAt <= now && (!reminder.retryAt || reminder.retryAt <= now))
                  .sort((a, b) => a.dueAt - b.dueAt)[0];

              if (relativeReminder) {
                  const delivered = await triggerTimedReminderMessage(relativeReminder);
                  if (delivered) {
                      await removeRelativeReminder(relativeReminder.id);
                  } else {
                      await markRelativeReminderRetry(relativeReminder.id);
                  }
                  return;
              }

              const dueDailyReminder = (await getDailyReminders())
                  .filter(reminder =>
                      !reminder.paused &&
                      (() => {
                          const timeParts = getTimePartsInTimezone(new Date(now), reminder.timeZone || 'Asia/Tokyo');
                          return (
                              reminder.hour === timeParts.hour &&
                              reminder.minute === timeParts.minute &&
                              reminder.lastTriggeredDate !== timeParts.dateKey &&
                              (!reminder.retryAt || reminder.retryAt <= now)
                          );
                      })()
                  )
                  .sort((a, b) => a.createdAt - b.createdAt)[0];

              if (!dueDailyReminder) return;

              const delivered = await triggerTimedReminderMessage(dueDailyReminder);
              if (delivered) {
                  const timeParts = getTimePartsInTimezone(new Date(now), dueDailyReminder.timeZone || 'Asia/Tokyo');
                  await markDailyReminderTriggered(dueDailyReminder.id, timeParts.dateKey);
              } else {
                  await markDailyReminderRetry(dueDailyReminder.id);
              }
          } finally {
              reminderDispatchingRef.current = false;
          }
      };

      const intervalId = setInterval(() => {
          void checkScheduledReminders();
      }, 1000);
      const timeoutId = setTimeout(() => {
          void checkScheduledReminders();
      }, 1500);

      return () => {
          clearInterval(intervalId);
          clearTimeout(timeoutId);
      };
  }, [flowState, isTalking, isThinking, getRelativeReminders, getDailyReminders, triggerTimedReminderMessage, removeRelativeReminder, markRelativeReminderRetry, markDailyReminderTriggered, markDailyReminderRetry]);

  // WRAPPED IN USECALLBACK
  const handleSaveMemory = useCallback((newCoreMemory: string, newWorldBook: WorldBookEntry[], newContextLimit: number) => {
    setCoreMemory(newCoreMemory);
    setWorldBook(newWorldBook);
    setContextLimit(newContextLimit);
  }, []);

  const handleCloudRestore = useCallback(async (silent: boolean = false, checkWelcome: boolean = false): Promise<boolean | any> => {
      if (!CLOUD_SYNC_AVAILABLE) return false;
      if (!backupConfig.endpointUrl) return false;
      // UPDATED: Only confirm if not silent
      const shouldConfirm = !silent && flowState === 'APP' && syncStatus !== 'CONFLICT';
      if (shouldConfirm && !window.confirm(t.cloudRestoreConfirm)) return false;
      
      try {
        const cleanBaseUrl = backupConfig.endpointUrl.replace(/\/+$/, "");
        const syncUrl = cleanBaseUrl.endsWith("/api/sync") ? cleanBaseUrl : `${cleanBaseUrl}/api/sync`;

        const urlObj = new URL(syncUrl);
        urlObj.searchParams.append('userId', backupConfig.userId || 'default_user');
        urlObj.searchParams.append('_t', Date.now().toString()); 
        
        const headers: any = { 'Content-Type': 'application/json' };
        if (backupConfig.apiKey) headers['Authorization'] = `Bearer ${backupConfig.apiKey}`;
        
        const res = await fetch(urlObj.toString(), { method: 'GET', headers, cache: 'no-store' });
        
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") === -1) {
            const text = await res.text();
            if (text.trim().startsWith("<")) throw new Error("Received HTML. Please check URL (Backend vs Frontend).");
            throw new Error(`Invalid Content-Type (${contentType}).`);
        }

        if (!res.ok) throw new Error(`Status: ${res.status}`);

        let data;
        try {
            data = await res.json();
        } catch (jsonErr) {
            throw new Error("Failed to parse JSON response.");
        }
        
        if (data.test === true && !data.data && !data.messages) throw new Error(t.testDataWarning || "Test Data Detected. Please Push.");
        
        // Use data.data if it exists (wrapper), otherwise use data directly
        const dataToNormalize = data.data || data;

        // --- PRE-CHECK FOR MISSING VOICE FILES ---
        const msgs = dataToNormalize?.messages || [];
        const voiceCount = msgs.filter((m: any) => m.isVoiceMessage).length;
        
        if (!silent && voiceCount > 0 && isVoiceServiceAvailable()) {
            const { listVoiceFiles } = await import('../services/voiceFileService');
            const voiceFiles = await listVoiceFiles();
            if (voiceFiles.length === 0) {
                const confirmMsg = language === 'zh' 
                    ? `云端备份包含 ${voiceCount} 条语音记录，但当前数据目录中没有音频文件。同步后语音将无法播放。\n\n建议您先手动将音频文件放入数据目录，或继续同步仅恢复文本。\n\n是否继续同步？`
                    : `Cloud backup contains ${voiceCount} voice messages, but no audio files were found locally. Voices will not play after sync.\n\nIt is recommended to manually place audio files in the data directory first, or continue to sync text only.\n\nContinue syncing?`;
                
                const proceed = window.confirm(confirmMsg);
                if (!proceed) {
                    return false;
                }
            }
        }
        
        const restoredData = await restoreBackupData(dataToNormalize);

        if (restoredData) {
            // UPDATED: Only alert if not silent
            if (!silent && flowState === 'APP' && syncStatus !== 'CONFLICT') alert(t.restoreSuccess);
            
            // Mark sync as performed successfully
            hasPerformedInitialPull.current = true;
            
            updateBaseline(data.timestamp || Date.now(), restoredData);
            setIsCloudSynced(true);
            setIsSettingsOpen(false);

            return restoredData;
        } else {
            console.error("Restore validation failed for data summary:", summarizeBackupPayloadForLog(data));
            throw new Error("Invalid Data Format: 'messages' array not found in JSON.");
        }
      } catch (e: any) {
          console.error(e);
          if (flowState === 'APP') alert(`${t.restoreFail} (${e.message})`);
          return false;
      }
  }, [backupConfig, restoreBackupData, t, flowState, syncStatus, updateBaseline, normalizeBackupData]);

  // TRIGGER LOGIC MOVED TO USEEFFECT TO USE APP-LEVEL STATE
  useEffect(() => {
      if (CLOUD_SYNC_AVAILABLE && flowState === 'APP' && backupConfig.cloudEnabled && backupConfig.endpointUrl && !hasPerformedInitialPull.current) {
          setShowCloudRestorePrompt(true);
      }
  }, [flowState, backupConfig]);

  const handleCloudPush = useCallback(async () => {
      if (!CLOUD_SYNC_AVAILABLE) return;
      if (!backupConfig.endpointUrl) return;
      if (!window.confirm(t.cloudPushConfirm)) return;
      
      const cleanBaseUrl = backupConfig.endpointUrl.replace(/\/+$/, "");
      const syncUrl = cleanBaseUrl.endsWith("/api/sync") ? cleanBaseUrl : `${cleanBaseUrl}/api/sync`;
      
      console.log(`[SYNC] Pushing to: ${syncUrl}`);

      const success = await performCloudSync(syncUrl, backupData, backupConfig.apiKey, backupConfig.userId);
      
      if (success) {
          setLastBackupTime(Date.now());
          updateBaseline(Date.now()); 
          setIsCloudSynced(true);
          alert(t.pushSuccess);
      } else {
          alert(t.pushFail);
      }
  }, [backupConfig, t, backupData, updateBaseline]);

  // FIX: Add missing callback handlers for various UI actions.
  const handleDeleteAnchor = useCallback((id: string) => {
    setAnchors(prev => prev.filter(anchor => anchor.id !== id));
  }, []);

  const handleRebuildRag = useCallback(async () => {
    let backgroundThrottlingDisabled = false;
    let unsubscribeRebuild: (() => void) | null = null;
    try {
        const rebuildStartedAt = Date.now();
        const formatRebuildElapsed = () => `${Date.now() - rebuildStartedAt}ms`;
        let activeJobId: string | null = null;
        const stageDefinitions = {
            loading_source_history: {
                status: 'RECALLING' as const,
                label: language === 'zh' ? '1/6 加载原始历史' : '1/6 Loading source history',
            },
            grouping_fragments: {
                status: 'RECALLING' as const,
                label: language === 'zh' ? '2/6 分组消息片段' : '2/6 Grouping fragments',
            },
            generating_embeddings: {
                status: 'RECALLING' as const,
                label: language === 'zh' ? '3/6 生成向量' : '3/6 Generating embeddings',
            },
            writing_sqlite_rows: {
                status: 'INDEXING' as const,
                label: language === 'zh' ? '4/6 写入 SQLite' : '4/6 Writing SQLite rows',
            },
            building_indexes: {
                status: 'INDEXING' as const,
                label: language === 'zh' ? '5/6 构建索引' : '5/6 Building indexes',
            },
            finalizing_statistics: {
                status: 'INDEXING' as const,
                label: language === 'zh' ? '6/6 汇总统计' : '6/6 Finalizing statistics',
            },
        };

        const setRebuildStage = (
            stage: keyof typeof stageDefinitions,
            progress?: { processed?: number | null; total?: number | null; extra?: string | null }
        ) => {
            const definition = stageDefinitions[stage];
            const processed = typeof progress?.processed === 'number' ? progress.processed : undefined;
            const total = typeof progress?.total === 'number' ? progress.total : undefined;
            const progressText = (
                typeof processed === 'number' && typeof total === 'number' && total > 0
                    ? ` (${Math.min(processed, total)}/${total})`
                    : ''
            );
            const extraText = progress?.extra ? ` - ${progress.extra}` : '';
            const detail = `${definition.label}${progressText}${extraText}`;
            setRagStatus(definition.status);
            setRagProgressLabel(detail);
            console.log(`[RAG REBUILD] stage=${stage} processed=${processed ?? '-'} total=${total ?? '-'} elapsed=${formatRebuildElapsed()}${progress?.extra ? ` extra=${progress.extra}` : ''}`);
        };

        const applyRebuildEvent = (event: LocalRagRebuildEvent) => {
            if (!activeJobId && event.jobId) {
                activeJobId = event.jobId;
            }
            if (activeJobId && event.jobId && event.jobId !== activeJobId) {
                return;
            }

            const stage = event.stage as keyof typeof stageDefinitions;
            if (stage && stageDefinitions[stage]) {
                setRebuildStage(stage, {
                    processed: event.processed,
                    total: event.total,
                    extra: event.extra,
                });
            }
        };

        if (isDesktopElectron()) {
            const throttlingResult = await setDesktopBackgroundThrottling(false);
            if (throttlingResult.success) {
                backgroundThrottlingDisabled = true;
            } else {
                console.warn('[RAG REBUILD] Failed to disable background throttling.', throttlingResult.error);
            }
        }

        let needsFix = false;
        let lastValidTime = Date.now();
        for (const message of messages) {
            const parsedTime = new Date(message.timestamp);
            if (!isNaN(parsedTime.getTime())) {
                lastValidTime = parsedTime.getTime();
                break;
            }
        }

        const fixedMessages = messages.map(message => {
            const parsedTime = new Date(message.timestamp);
            if (isNaN(parsedTime.getTime())) {
                needsFix = true;
                const repairedTimestamp = lastValidTime + 1;
                lastValidTime = repairedTimestamp;
                return { ...message, timestamp: repairedTimestamp };
            }

            lastValidTime = parsedTime.getTime();
            if (typeof message.timestamp !== 'number') {
                needsFix = true;
                return { ...message, timestamp: parsedTime.getTime() };
            }

            return message;
        });

        if (needsFix) {
            setMessages(fixedMessages);
            console.log('[RAG REBUILD] Fixed invalid timestamps in chat history before sync.');
        }

        setRebuildStage('loading_source_history', {
            processed: fixedMessages.length,
            total: fixedMessages.length,
            extra: language === 'zh' ? '同步原始消息到桌面 SQLite' : 'Syncing raw messages to desktop SQLite',
        });
        await syncRawHistoryMessages(fixedMessages, { forceFull: true });

        const completion = new Promise<LocalRagRebuildEvent>((resolve, reject) => {
            unsubscribeRebuild = subscribeLocalRagRebuild((event) => {
                applyRebuildEvent(event);
                if (event.type === 'done') {
                    resolve(event);
                    return;
                }
                if (event.type === 'error') {
                    reject(event);
                }
            });
        });

        const startResult = await startLocalRagRebuild();
        if (startResult.snapshot?.jobId) {
            activeJobId = startResult.snapshot.jobId;
            applyRebuildEvent({
                type: startResult.started ? 'started' : 'progress',
                ...startResult.snapshot,
            });
        }
        console.log(`[RAG REBUILD] job=${activeJobId ?? 'unknown'} started=${startResult.started} alreadyRunning=${startResult.alreadyRunning} elapsed=${formatRebuildElapsed()}`);

        const completedEvent = await completion;
        const finalStats = completedEvent.finalStats;
        console.log('[RAG FILTER] Rebuild summary:', {
            accepted: completedEvent.candidateCount,
            filtered: completedEvent.filteredCount,
            deduped: completedEvent.duplicateCount,
            inserted: completedEvent.storedCount,
            merged: completedEvent.mergedCount,
            skippedExisting: completedEvent.skippedExistingCount,
            cleared: completedEvent.clearedCount,
            final: finalStats?.vectorCount ?? 0,
            core: finalStats?.coreCount ?? 0,
            episodic: finalStats?.episodicCount ?? 0,
            background: finalStats?.backgroundCount ?? 0,
            grouped: completedEvent.groupedCount,
        });
        console.log(`[RAG REBUILD] completed elapsed=${formatRebuildElapsed()}`);
        
        ragDirtyNoticeShownRef.current = false;
        setIsRagHistoryDirty(false);
        setRagStatus('IDLE');
        setRagProgressLabel(null);
        setSystemNotice(language === 'zh' ? '记忆库重建完成！' : 'Memory bank rebuilt successfully!');
    } catch (e) {
        const rebuildMessage = typeof (e as any)?.error === 'string'
            ? (e as any).error
            : e instanceof Error
                ? e.message
                : String(e);
        console.error('Failed to rebuild RAG memory', rebuildMessage, e);
        setRagStatus('ERROR');
        setRagProgressLabel(null);
        setSystemNotice(language === 'zh' ? '重建记忆库失败。' : 'Failed to rebuild memory bank.');
    } finally {
        unsubscribeRebuild?.();
        if (isDesktopElectron() && backgroundThrottlingDisabled) {
            const throttlingResult = await setDesktopBackgroundThrottling(true);
            if (!throttlingResult.success) {
                console.warn('[RAG REBUILD] Failed to restore background throttling.', throttlingResult.error);
            }
        }
        if (isDesktopElectron()) {
            refocusDesktopWebContents();
        }
    }
  }, [messages, language]);

  const handleExportBackup = useCallback(async () => {
    try {
        const [vectors, kumikoDiaryExport, dailyFragmentsExport, psycheStateExport, episodesExport] = await Promise.all([
            getAllVectors(),
            db.kumikoDiary.orderBy('date').toArray(),
            db.dailyFragments.orderBy('timestamp').toArray(),
            db.psycheState.get('current'),
            db.episodes.orderBy('startTimestamp').toArray(),
        ]);
        const lightweightBackupData = {
            ...backupData,
            kumikoDiary: undefined,
            dailyFragments: undefined,
            psycheState: undefined,
        };
        
        const fullBackup = {
            timestamp: Date.now(),
            version: "1.3",
            data: lightweightBackupData,
            vectors,
            kumikoDiary: kumikoDiaryExport,
            dailyFragments: dailyFragmentsExport,
            psycheState: psycheStateExport,
            episodes: episodesExport,
        };
        const jsonString = JSON.stringify(fullBackup, null, 2);
        
        const zip = new JSZip();
        zip.file("data.json", jsonString);
        
        const imagesFolder = zip.folder("images");
        if (imagesFolder) {
            const allImages = await imageService.getAllImages();
            for (const img of allImages) {
                const match = img.data.match(/^data:(.*);base64,(.*)$/);
                if (match) {
                    const base64Data = match[2];
                    const ext = match[1].includes('png') ? 'png' : 'jpg';
                    imagesFolder.file(`${img.id}.${ext}`, base64Data, { base64: true });
                }
            }
        }

        if (isVoiceServiceAvailable()) {
            try {
                const { listVoiceFiles, loadVoiceFile: loadVF } = await import('../services/voiceFileService');
                const voiceFiles = await listVoiceFiles();
                if (voiceFiles.length > 0) {
                    const voiceFolder = zip.folder("voice");
                    if (voiceFolder) {
                        for (const vf of voiceFiles) {
                            const buf = await loadVF(vf.id);
                            if (buf) voiceFolder.file(`${vf.id}.mp3`, buf);
                        }
                    }
                }
                const { loadRingtoneFileWithName } = await import('../services/voiceFileService');
                const rtResult = await loadRingtoneFileWithName();
                if (rtResult) {
                    const ringtoneFolder = zip.folder("ringtone");
                    if (ringtoneFolder) {
                        ringtoneFolder.file(rtResult.fileName, rtResult.buffer);
                        if (rtResult.displayName && rtResult.displayName !== rtResult.fileName) {
                            ringtoneFolder.file('custom.meta.json', JSON.stringify({ originalName: rtResult.displayName }, null, 2));
                        }
                    }
                }
            } catch (e) {
                console.warn('[EXPORT] Failed to include voice files:', e);
            }
        }
        
        const content = await zip.generateAsync({ type: "blob" });
        saveAs(content, `kumiko_backup_${new Date().toISOString().slice(0, 10)}.zip`);
        
        alert(language === 'zh' ? '备份导出成功！' : 'Backup exported successfully!');
    } catch (e) {
        console.error("Failed to export backup", e);
        alert(language === 'zh' ? '备份导出失败。' : 'Failed to export backup.');
    }
  }, [backupData, language]);

  const handleImportBackup = useCallback(async (file: File): Promise<boolean> => {
    if (!file) return false;
    try {
        let jsonStr = "";
        let parsedJson: any = null;
        let importedImages: Array<{ id: string; dataUrl: string }> = [];
        const desktopFilePath = isDesktopElectron() ? (file as File & { path?: string }).path : undefined;

        if (desktopFilePath) {
            const parsedResult = await parseDesktopBackupImportFile(desktopFilePath);
            if (!parsedResult.success || !parsedResult.json) {
                throw new Error(parsedResult.error || 'Failed to parse desktop backup import file.');
            }
            parsedJson = parsedResult.json;
            importedImages = parsedResult.images || [];
        } else if (file.name.endsWith('.zip')) {
            const zip = await JSZip.loadAsync(file);
            const dataFile = zip.file("data.json");
            if (!dataFile) {
                throw new Error("data.json not found in ZIP");
            }
            jsonStr = await dataFile.async("string");
            
            // Import images
            const imagesFolder = zip.folder("images");
            if (imagesFolder) {
                const imageFiles = Object.keys(imagesFolder.files).filter(name => !imagesFolder.files[name].dir);
                for (let imageIndex = 0; imageIndex < imageFiles.length; imageIndex += 1) {
                    const imgName = imageFiles[imageIndex];
                    const imgFile = imagesFolder.files[imgName];
                    const base64Data = await imgFile.async("base64");
                    const ext = imgName.split('.').pop()?.toLowerCase();
                    const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
                    const dataUrl = `data:${mimeType};base64,${base64Data}`;
                    
                    // Extract ID from filename (e.g., "images/12345.jpg" -> "12345")
                    const id = imgName.split('/').pop()?.split('.')[0];
                    if (id) {
                        await imageService.saveImageWithId(id, dataUrl);
                    }

                    if ((imageIndex + 1) % 8 === 0) {
                        await yieldToMainThread();
                    }
                }
            }

            if (isVoiceServiceAvailable()) {
                try {
                    const { saveVoiceFile: saveVF, saveRingtoneFile: saveRT } = await import('../services/voiceFileService');
                    const voiceFolder = zip.folder("voice");
                    if (voiceFolder) {
                        const voiceFileKeys = Object.keys(voiceFolder.files).filter(n => !voiceFolder.files[n].dir && n.endsWith('.mp3'));
                        for (const vfName of voiceFileKeys) {
                            const buf = await voiceFolder.files[vfName].async("arraybuffer");
                            const id = vfName.split('/').pop()?.replace(/\.mp3$/, '');
                            if (id) await saveVF(id, buf);
                        }
                    }
                    const ringtoneFolder = zip.folder("ringtone");
                    if (ringtoneFolder) {
                        const rtAudioKey = Object.keys(ringtoneFolder.files).find(n => {
                            if (ringtoneFolder.files[n].dir) return false;
                            return /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(n);
                        });
                        if (rtAudioKey) {
                            const buf = await ringtoneFolder.files[rtAudioKey].async("arraybuffer");
                            const ext = rtAudioKey.split('.').pop() || 'mp3';
                            let originalName: string | undefined;
                            const metaFile = ringtoneFolder.file('custom.meta.json');
                            if (metaFile) {
                                try {
                                    const parsedMeta = JSON.parse(await metaFile.async('string'));
                                    if (typeof parsedMeta?.originalName === 'string' && parsedMeta.originalName.trim()) {
                                        originalName = parsedMeta.originalName.trim();
                                    }
                                } catch {
                                    // Ignore malformed ringtone metadata in imported backups.
                                }
                            }
                            await saveRT(buf, ext, originalName || rtAudioKey.split('/').pop());
                        }
                    }
                } catch (e) {
                    console.warn('[IMPORT] Failed to restore voice files:', e);
                }
            }
        } else {
            jsonStr = await file.text();
        }

        await yieldToMainThread();
        const json = parsedJson ?? JSON.parse(jsonStr);

        // --- PRE-CHECK FOR MISSING VOICE FILES ---
        if (!file.name.endsWith('.zip') && !desktopFilePath?.endsWith('.zip')) {
            const dataToRestore = json.data || json;
            const msgs = dataToRestore.messages || [];
            const voiceCount = msgs.filter((m: any) => m.isVoiceMessage).length;
            
            if (voiceCount > 0 && isVoiceServiceAvailable()) {
                const { listVoiceFiles } = await import('../services/voiceFileService');
                const voiceFiles = await listVoiceFiles();
                if (voiceFiles.length === 0) {
                    const confirmMsg = language === 'zh' 
                        ? `检测到您的备份包含 ${voiceCount} 条语音记录，但当前数据目录中没有音频文件。导入后语音将无法播放。\n\n建议您导入完整的 ZIP 备份，或稍后手动将音频文件放入数据目录。\n\n是否继续仅导入文本？`
                        : `Your backup contains ${voiceCount} voice messages, but no audio files were found in the current data directory. Voices will not play after import.\n\nIt is recommended to import a full ZIP backup, or manually place the audio files in the data directory later.\n\nContinue importing text only?`;
                    
                    const proceed = window.confirm(confirmMsg);
                    if (!proceed) {
                        return false;
                    }
                }
            }
        }

        const restoredData = await restoreParsedBackupPayload(json, importedImages);
        if (restoredData) {
            if (json.vectors) {
                await yieldToMainThread();
                await restoreVectors(json.vectors);
                ragDirtyNoticeShownRef.current = false;
                setIsRagHistoryDirty(false);
            } else if (backupConfig.ragEnabled && Array.isArray(restoredData.messages) && restoredData.messages.length > 0) {
                setIsRagHistoryDirty(true);
                console.warn('[LOCAL RAG] Imported backup restored messages without vector snapshots. Rebuild recommended.');
            }
            // After successful import, also update the baseline for auto-save
            updateBaseline(json.timestamp || Date.now(), restoredData);
            if (flowState === 'APP') { // Only alert if in main app
                alert("Backup restored successfully!");
            }
            return true;
        } else {
            if (flowState === 'APP') { // Only alert if in main app
                alert("Failed to restore backup: Invalid file format.");
            }
            return false;
        }
    } catch (e) {
        console.error("Failed to import backup", e);
        if (flowState === 'APP') { // Only alert if in main app
            alert("Failed to import backup: Not a valid JSON or ZIP file.");
        }
        return false;
    }
  }, [restoreParsedBackupPayload, updateBaseline, flowState, backupConfig.ragEnabled]);

  const handleCloudConnect = useCallback(async (url: string, id: string, key?: string): Promise<boolean> => {
    if (!CLOUD_SYNC_AVAILABLE) return false;
    try {
        const cleanBaseUrl = url.replace(/\/+$/, "");
        const syncUrl = cleanBaseUrl.endsWith("/api/sync") ? cleanBaseUrl : `${cleanBaseUrl}/api/sync`;
        
        const urlObj = new URL(syncUrl);
        urlObj.searchParams.append('userId', id);
        
        const headers: any = { 'Content-Type': 'application/json' };
        if (key) headers['Authorization'] = `Bearer ${key}`;
        
        // A GET request is better for auth screen verification
        const res = await fetch(urlObj.toString(), { method: 'GET', headers, cache: 'no-store' });

        // Check if response is JSON, not HTML (e.g. from a frontend router)
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") === -1) {
            const text = await res.text();
            if (text.trim().startsWith("<")) { // Basic HTML check
                console.error("Cloud connect: received HTML response, likely wrong URL.");
                return false;
            }
        }
        
        return res.ok;

    } catch (e) {
        console.error("Cloud connection test failed", e);
        return false;
    }
  }, []);

  // ... (Rest of event handlers like selection, etc) ...
  const applyMessagesWithDerivedState = useCallback((nextMessages: Message[]) => {
    setMessages(nextMessages);
    const recalculatedTurnCount = recalculateTurnCountFromMessages(nextMessages);
    setTurnCount(recalculatedTurnCount);
    setSummaryArchiveState(prev => normalizeSummaryArchiveState(prev, recalculatedTurnCount));
  }, []);
  const applyVisualHistoryMutation = useCallback((nextMessages: Message[]) => {
    skipNextRawHistorySyncRef.current = true;
    setMessages(nextMessages);
  }, []);
  const markRagHistoryDirty = useCallback((reason: string) => {
    if (!backupConfig.ragEnabled) return;
    const shouldNotify = !isRagHistoryDirty && !ragDirtyNoticeShownRef.current;
    setIsRagHistoryDirty(true);
    if (shouldNotify) {
      ragDirtyNoticeShownRef.current = true;
      alert(language === 'zh'
        ? '你刚刚修改了真实历史内容，本地 RAG 记忆索引建议重建。'
        : 'You just changed real message history. Rebuilding the local RAG index is recommended.');
    }
    console.warn(`[LOCAL RAG] Manual history edit marked the current message-linked recall index as stale. Rebuild recommended. reason=${reason}`);
  }, [backupConfig.ragEnabled, isRagHistoryDirty, language]);
  const applyManualHistoryMutation = useCallback((nextMessages: Message[], reason: string) => {
    applyMessagesWithDerivedState(nextMessages);
    updateMemoryQuerySession(null);
    markRagHistoryDirty(reason);
  }, [applyMessagesWithDerivedState, markRagHistoryDirty, updateMemoryQuerySession]);
  const toggleSelectionMode = () => { setIsSelectionMode(!isSelectionMode); setSelectedIds(new Set()); };
  const handleSelectMessage = (id: string) => { setSelectedIds(prev => { const newSet = new Set(prev); if (newSet.has(id)) { newSet.delete(id); } else { newSet.add(id); } return newSet; }); };
  const initiateDeleteSelected = () => { if (selectedIds.size === 0) return; setShowDeleteConfirm(true); };
  const confirmDeleteSelected = () => {
    const nextMessages = messagesRef.current.filter(msg => !selectedIds.has(msg.id));
    applyManualHistoryMutation(nextMessages, 'batch_hard_delete');
    setShowDeleteConfirm(false);
    setIsSelectionMode(false);
    setSelectedIds(new Set());
  };
  const initiateClearAll = () => { setShowClearFlow(true); };
  const handleClearAll = () => { 
      const nextMessages = messagesRef.current.map(msg => ({ ...msg, isHidden: true }));
      applyVisualHistoryMutation(nextMessages);
      setShowClearFlow(false); 
      setIsSelectionMode(false); 
      pendingTextRef.current = ""; 
      pendingImageRef.current = null; 
      pendingMessageIdsRef.current.clear(); 
      pendingImageMessageIdRef.current = null; 
  };
  const handleInsertMessage = useCallback((afterId: string | null, role: 'user' | 'model') => {
    const newMessages = [...messagesRef.current].sort((a, b) => a.timestamp - b.timestamp);
    let newTimestamp = Date.now();
    if (afterId) {
      const index = newMessages.findIndex(m => m.id === afterId);
      if (index !== -1) {
        const currentMsg = newMessages[index];
        newTimestamp = currentMsg.timestamp + 1;
      }
    } else if (newMessages.length > 0) {
      newTimestamp = newMessages[newMessages.length - 1].timestamp + 1;
    }

    const newMessage: Message = {
      id: Date.now().toString() + Math.random().toString(),
      role,
      text: "...",
      timestamp: newTimestamp,
      isRead: true
    };

    const nextMessages = [...messagesRef.current, newMessage];
    applyManualHistoryMutation(nextMessages, 'insert_message');
  }, [applyManualHistoryMutation]);
  const handleReorderMessages = useCallback((dragIndex: number, hoverIndex: number) => {
    const newMessages = [...messagesRef.current].sort((a, b) => a.timestamp - b.timestamp);
    const draggedMessage = newMessages[dragIndex];
    newMessages.splice(dragIndex, 1);
    newMessages.splice(hoverIndex, 0, draggedMessage);
    const startIdx = Math.min(dragIndex, hoverIndex);
    let baseTime = startIdx > 0 ? newMessages[startIdx - 1].timestamp : newMessages[0].timestamp - 1000;
    for (let i = startIdx; i < newMessages.length; i++) {
      if (newMessages[i].timestamp <= baseTime) {
        newMessages[i] = { ...newMessages[i], timestamp: baseTime + 1 };
      }
      baseTime = newMessages[i].timestamp;
    }
    applyManualHistoryMutation(newMessages, 'reorder_messages');
  }, [applyManualHistoryMutation]);
  
  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        const imageId = await compressAndSaveImage(file);
        const base64 = await getImageBase64(imageId);
        if (base64) {
          setSelectedImage(base64);
          setSelectedImageId(imageId);
        }
      } catch (err) {
        console.error("Failed to process image locally", err);
        alert("图片处理失败 / Image processing failed");
      }
    }
  };

  const handleUpdateMessage = useCallback((id: string, newText: string) => {
    const nextMessages = messagesRef.current.map(msg => {
      if (msg.id === id) return { ...msg, text: newText };
      if (msg.quote && msg.quote.id === id) return { ...msg, quote: { ...msg.quote, text: newText } };
      return msg;
    });
    applyManualHistoryMutation(nextMessages, 'update_message');
  }, [applyManualHistoryMutation]);
  const handleDeleteMessage = useCallback((id: string) => {
    const nextMessages = messagesRef.current.filter(msg => msg.id !== id);
    applyManualHistoryMutation(nextMessages, 'hard_delete_message');
  }, [applyManualHistoryMutation]);
  const handleToggleHidden = useCallback((id: string) => {
    const nextMessages = messagesRef.current.map(msg => msg.id === id ? { ...msg, isHidden: !msg.isHidden } : msg);
    applyVisualHistoryMutation(nextMessages);
  }, [applyVisualHistoryMutation]);
  const handleTogglePin = useCallback((id: string) => { setMessages(prev => prev.map(msg => msg.id === id ? { ...msg, isPinned: !msg.isPinned } : msg)); }, []);
  const handleJumpToMessage = useCallback((id: string) => { setIsMemoryPanelOpen(false); setIsProfileOpen(false); setIsSettingsOpen(false); setIsTaskPanelOpen(false); setIsMessageCenterOpen(false); setHighlightedMessageId(id); setTimeout(() => { const element = document.getElementById(`message-${id}`); if (element) { element.scrollIntoView({ behavior: 'smooth', block: 'center' }); } setTimeout(() => { setHighlightedMessageId(null); }, 2000); }, 300); }, []);

  const triggerAutoSummary = useCallback(async ({
    currentCount,
    currentMemory,
    archiveState,
    reason,
    isComplete,
    isContinuation = false,
    turnsInSegment,
    endBeforeMessageId = null,
    nextSegmentStartTurn,
    nextSegmentStartMessageId,
  }: {
    currentCount: number;
    currentMemory: string;
    archiveState: SummaryArchiveState;
    reason: SummaryBoundaryReason;
    isComplete: boolean;
    isContinuation?: boolean;
    turnsInSegment: number;
    endBeforeMessageId?: string | null;
    nextSegmentStartTurn: number;
    nextSegmentStartMessageId: string | null;
  }) => {
    console.log(`[AUTO-SUMMARY] Triggering archive pass at Turn ${currentCount} (${reason})...`);
    try {
        const segmentMessages = getSummarySegmentMessages(messagesRef.current, archiveState, endBeforeMessageId);
        if (segmentMessages.length === 0) {
            console.warn("[AUTO-SUMMARY] Segment is empty. Skip archive.");
            return;
        }

        const start = segmentMessages[0].timestamp;
        const summaryCompletedAt = Date.now();
        const segmentEndTime = segmentMessages[segmentMessages.length - 1].timestamp;
        const end = Math.max(segmentEndTime, summaryCompletedAt);
        
        const startDate = new Date(start);
        const endDate = new Date(end);
        
        const getJSTParts = (d: Date) => {
            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: 'Asia/Tokyo',
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', hour12: false
            });
            const parts = formatter.formatToParts(d);
            const p: any = {};
            parts.forEach(part => p[part.type] = part.value);
            return p;
        };

        const s = getJSTParts(startDate);
        const e = getJSTParts(endDate);
        
        let timeRangeStr = '';
        if (s.year === e.year && s.month === e.month && s.day === e.day) {
            timeRangeStr = `${s.year}/${s.month}/${s.day} ${s.hour}:${s.minute} - ${e.hour}:${e.minute} (JST)`;
        } else {
            timeRangeStr = `${s.year}/${s.month}/${s.day} ${s.hour}:${s.minute} - ${e.year}/${e.month}/${e.day} ${e.hour}:${e.minute} (JST)`;
        }

        const { diary: newSummary, notebook: newNotebook, chunks } = await summarizeConversation(
            segmentMessages,
            currentMemory,
            timeRangeStr,
            kumikoNotebook,
            locationConfig,
            language,
            {
                reason,
                isComplete,
                isContinuation,
                turnsInSegment,
            }
        );
        
        console.log("[AUTO-SUMMARY] Generated New Core Memory:", newSummary);
        console.log("[AUTO-SUMMARY] Updated Notebook:", newNotebook);
        console.log("[AUTO-SUMMARY] Extracted Memory Chunks:", chunks);

        const summarySegmentMetadata: SummarySegmentMetadata = {
            segmentId: buildSummarySegmentId(
                start,
                archiveState.segmentStartMessageId || segmentMessages[0]?.id || null,
                summaryCompletedAt
            ),
            segmentStartTime: start,
            segmentEndTime,
            summaryCompletedTime: summaryCompletedAt,
            isComplete,
            topicLabel: deriveSummaryTopicLabel(chunks, segmentMessages, newSummary),
            summaryText: newSummary,
        };
        const updatedRecentSummarySegments = appendRecentSummarySegment(archiveState, summarySegmentMetadata);
        const nextSummaryBuffer = buildRecentSummaryBuffer(updatedRecentSummarySegments, newSummary);

        if (nextSummaryBuffer !== currentMemory) {
            setCoreMemory(nextSummaryBuffer);
        }
        
        if (backupConfig.ragEnabled && chunks && chunks.length > 0) {
            setRagStatus('INDEXING');
            console.log(`[RAG] Archiving ${chunks.length} memory chunks to Local DB...`);
            
            try {
                for (const chunk of chunks) {
                    if (typeof chunk === 'string' && chunk.trim().length > 0) {
                        const ragPayload = `【MEMORY CHUNK (${timeRangeStr})】\n${chunk}`;
                        const memoryDecision = evaluateRagMemoryCandidate(ragPayload, 'memory_chunk');
                        await saveLocalRagMemory(ragPayload, getCurrentAIConfig(), undefined, {
                            tier: mapRagDecisionTierToStorageTier(memoryDecision.tier),
                            source: 'memory_chunk',
                            score: memoryDecision.score,
                            canonicalKey: memoryDecision.canonicalKey,
                            role: 'system',
                        });
                    }
                }
                console.log("[RAG] Memory Chunks Archived Successfully.");
                setRagStatus('IDLE');
            } catch (e) {
                console.warn("[RAG] Failed to archive memory chunks.", e);
                setRagStatus('ERROR');
            }
        }
        
        if (newNotebook !== kumikoNotebook) {
            setKumikoNotebook(newNotebook);
        }

        const continuationCarryover = reason === 'hard_limit'
          ? getSummaryContinuationCarryoverState(segmentMessages)
          : {
              carryoverStartMessageId: null,
              carryoverEndMessageId: null,
            };

        setSummaryArchiveState(
          normalizeSummaryArchiveState({
            segmentStartTurn: nextSegmentStartTurn,
            segmentStartMessageId: nextSegmentStartMessageId,
            activeSegmentId: buildSummarySegmentId(
              segmentMessages[Math.max(0, segmentMessages.length - 1)]?.timestamp ?? Date.now(),
              nextSegmentStartMessageId,
              Date.now()
            ),
            carryoverStartMessageId: continuationCarryover.carryoverStartMessageId,
            carryoverEndMessageId: continuationCarryover.carryoverEndMessageId,
            pendingSinceTurn: null,
            lastBoundaryReason: reason,
            lastBoundaryAt: Date.now(),
            recentSummarySegments: updatedRecentSummarySegments,
          }, nextSegmentStartTurn)
        );
    } catch (e) {
        console.error("[AUTO-SUMMARY] Process Failed:", e);
        if (backupConfig.ragEnabled) setRagStatus('ERROR');
    }
  }, [backupConfig, kumikoNotebook, locationConfig, language, deriveSummaryTopicLabel]);

  const executeSend = useCallback(async () => {
    let combinedText = pendingTextRef.current;
    const finalImage = pendingImageRef.current;
    const pendingImgId = pendingImageMessageIdRef.current; 
    const currentPendingIds = new Set(pendingMessageIdsRef.current);
    const currentTurnStartMessageId = messagesRef.current
      .filter(msg => currentPendingIds.has(msg.id))
      .sort((a, b) => a.timestamp - b.timestamp)[0]?.id ?? null;
    const userTextForRag = combinedText;
    
    pendingTextRef.current = "";
    pendingImageRef.current = null;
    pendingMessageIdsRef.current.clear();
    pendingImageMessageIdRef.current = null; 

    if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    setTimeLeft(0);
    setIsListening(false);
    
    setMessages(prev => prev.map(msg => 
       msg.role === 'user' && !msg.isRead ? { ...msg, isRead: true } : msg
    ));

    const currentGenId = generationIdRef.current;

    let isImageMessage = !!finalImage;
    let savedImageUrl: string | null = null;
    
    // We no longer upload to R2. The image is already saved in IndexedDB and we have the base64 in finalImage.
    
    try {
      let apiImage = undefined;
      let mimeType = 'image/jpeg';
      if (finalImage) {
        const match = finalImage.match(/^data:(.*);base64,(.*)$/);
        if (match) {
          mimeType = match[1];
          apiImage = match[2]; 
        }
      }

      const allMessages = messagesRef.current.filter(msg => !currentPendingIds.has(msg.id));
      const recentMessages = allMessages.slice(-contextLimit);
      const pinnedMessages = allMessages.filter(msg => msg.isPinned);
      const gapSincePreviousTurnMinutes = allMessages.length > 0
        ? Math.max(0, (Date.now() - allMessages[allMessages.length - 1].timestamp) / 60000)
        : Number.POSITIVE_INFINITY;
      
      const historyMap = new Map();
      [...pinnedMessages, ...recentMessages].forEach(m => historyMap.set(m.id, m));
      const historySlice = Array.from(historyMap.values()).sort((a, b) => a.timestamp - b.timestamp);
      
      const ambientEnvironmentContext = await getAmbientEnvironmentContext();
      const isCurrentHoliday = ambientEnvironmentContext.includes('今日特殊历法：日本法定节假日');

      // --- RETROACTIVE LIFE STREAM GENERATION ---
      if (allMessages.length > 0 && gapSincePreviousTurnMinutes > 3 * 60) {
        setIsThinking(true);
        const { handleRetroactiveGeneration, detectDiaryGaps } = await import('../services/lifeStreamService');
        await handleRetroactiveGeneration(
          allMessages[allMessages.length - 1].timestamp,
          ambientEnvironmentContext,
          isCurrentHoliday,
          locationConfig.modelTimezone
        );
        setIsThinking(false);

        const gapInfo = await detectDiaryGaps();
        if (gapInfo.totalMissing > 0) {
          if (isAutoDiaryBackfillEnabled()) {
            void runAutoDiaryBackfill(gapInfo);
          } else {
            setBackfillGapInfo(gapInfo);
            await new Promise<void>(resolve => { pendingSendRef.current = resolve; });
          }
        }
      }
      // ------------------------------------------

      // --- DYNAMIC DELAY (BUSY STATE) INTERCEPTOR ---
      const nowJST = new Date(new Date().toLocaleString('en-US', { timeZone: locationConfig.modelTimezone }));
      const hourJST = nowJST.getHours();
      const dayJST = nowJST.getDay();
      const isWorkday = dayJST >= 1 && dayJST <= 5;
      const isWorkingHours = hourJST >= 8 && hourJST <= 16;
      
      if (isWorkday && !isCurrentHoliday && isWorkingHours && Math.random() < 0.15) {
        // 15% chance to be busy during work hours
        setIsThinking(true);
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
        setIsThinking(false);
        
        const busyReplies = [
          "啊，现在在开会，等下说！",
          "等下，学生找我",
          "抱歉，现在有点忙，晚点回你",
          "在上课，稍等！"
        ];
        const reply = busyReplies[Math.floor(Math.random() * busyReplies.length)];
        
        const msgId = addMessage('model', reply, undefined, undefined, undefined, undefined, undefined, 'serious');
        showBackgroundMessageNotification(reply, 'reply', msgId);
        
        // Schedule a follow-up in 15-30 minutes
        setTimeout(() => {
          triggerNativeProactiveMessage(0, "忙完了，继续刚才的话题");
        }, 15 * 60000 + Math.random() * 15 * 60000);
        
        return;
      }
      // ----------------------------------------------

      const currentLooksHistoryLike = isLikelyHistoricalRecallQuery(userTextForRag)
        || isLikelyTemporalHistoryQuery(userTextForRag)
        || isLikelyHistoricalFollowUp(userTextForRag)
        || isLikelyHistoricalSessionCarry(userTextForRag)
        || isLikelySemanticRecallQuery(userTextForRag);
      if (!currentLooksHistoryLike
        && !(memoryQuerySessionRef.current?.kind === 'topic_search'
             && isMemoryQuerySessionActive(memoryQuerySessionRef.current))) {
        updateMemoryQuerySession(null);
      }

      const historyQueryContextResolution = buildHistoricalRecallQueryContext(allMessages, userTextForRag, memoryQuerySessionRef.current);
      const rawHistoryQueryContext = historyQueryContextResolution.queryText;
      let historyQueryContext = rawHistoryQueryContext;
      let historyQueryRewrite: HistoricalQueryRewrite | null = null;
      let historyQueryRewriteError: string | null = null;
      const shouldRewriteHistoricalQuery = currentLooksHistoryLike
        || historyQueryContextResolution.source !== 'self'
        || isMemoryQuerySessionActive(memoryQuerySessionRef.current);
      if (shouldRewriteHistoricalQuery) {
        const rewriteResult = await rewriteHistoricalRecallQueryDetailed(rawHistoryQueryContext, locationConfig, {
          bypassGate: memoryQuerySessionRef.current?.kind === 'topic_search',
          recentMessages: allMessages.slice(-6),
        });
        historyQueryRewrite = rewriteResult.rewrite;
        historyQueryRewriteError = rewriteResult.errorMessage;
        if (historyQueryRewrite?.rewrittenQuery) {
          historyQueryContext = historyQueryRewrite.rewrittenQuery;
        }
      }
      const historicalQueryIntent = mapHistoricalRewriteIntent(historyQueryRewrite?.intent)
        ?? resolveHistoricalQueryIntent(userTextForRag, historyQueryContext, memoryQuerySessionRef.current);
      const shouldLoadHistoryEvidence = historicalQueryIntent === 'exact'
        || historicalQueryIntent === 'temporal'
        || (isMemoryQuerySessionActive(memoryQuerySessionRef.current) && historyQueryContextResolution.source !== 'self');
      const historyEvidenceMessages = shouldLoadHistoryEvidence
        ? await buildHistoryEvidenceMessages(allMessages)
        : allMessages;
      const historyEvidenceSource = shouldLoadHistoryEvidence
        ? (historyEvidenceMessages.length > 0 ? 'db_messages_only' : 'live_state_only')
        : 'live_state_only';
      const exactHistoryLookup = buildExactHistoryLookupBlock(historyEvidenceMessages, historyQueryContext);
      let historyLookup = exactHistoryLookup;
      let memoryRoute: 'recent_only' | 'exact_history' | 'temporal_history' | 'fuzzy_rag' = exactHistoryLookup?.strict
        ? 'exact_history'
        : 'recent_only';
      let semanticRoleConstraint: 'user' | 'model' | 'any' | null = null;
      let semanticEntryKindSummary: Record<LocalRagEntryKind, number> | null = null;
      let semanticDominantEntryKind: LocalRagEntryKind | null = null;
      let semanticEvidenceSectionCount = 0;
      let semanticEvidenceStrengthSummary: string | null = null;
      let semanticQuoteSafeSummary: string | null = null;
      let semanticEnvelopeEntryMix: string | null = null;
      let semanticAnswerMode: MemoryEvidenceAnswerMode | null = null;
      let semanticResponseStrategy: MemoryEvidenceResponseStrategy | null = null;
      let semanticConfidenceLevel: 'high' | 'medium' | 'low' | null = null;
      let temporalEpisodeCount = 0;
      
      let ragContext: string[] = [];
      let temporalIntent: TemporalQueryAnalysis | null = null;
      let temporalDiagnostics: TemporalQueryDiagnostics | null = null;
      if (backupConfig.ragEnabled && !historyLookup?.strict) {
          setRagStatus('RECALLING');
          try {
              const shouldAnalyzeTemporal = historicalQueryIntent === 'temporal';
              console.log('[TEMPORAL ROUTE CHECK]', {
                likelyTemporal: isLikelyTemporalHistoryQuery(userTextForRag),
                likelyHistoricalRecall: isLikelyHistoricalRecallQuery(historyQueryContext),
                historicalQueryIntent,
                augmentedQueryUsed: historyQueryContextResolution.source !== 'self',
                augmentationSource: historyQueryContextResolution.source,
                sessionReuseBlockedReason: historyQueryContextResolution.sessionReuseBlockedReason ?? null,
                augmentedQueryPreview: historyQueryContextResolution.source !== 'self' ? historyQueryContext.slice(0, 160) : null,
                rewrittenQueryApplied: !!historyQueryRewrite?.rewrittenQuery && historyQueryRewrite.rewrittenQuery !== rawHistoryQueryContext,
                rewrittenQueryPreview: historyQueryRewrite?.rewrittenQuery ? historyQueryRewrite.rewrittenQuery.slice(0, 160) : null,
                rewrittenIntent: historyQueryRewrite?.intent ?? null,
                rewrittenSearchStrategy: historyQueryRewrite?.searchStrategy ?? null,
                rewrittenSearchKeywords: historyQueryRewrite?.searchKeywords ?? null,
                rewrittenTopicQuery: historyQueryRewrite?.topicQuery ?? null,
                rewrittenConfidence: historyQueryRewrite?.confidence ?? null,
                rewrittenSearchRole: historyQueryRewrite?.searchRole ?? null,
                rewriteError: historyQueryRewriteError,
                previousQueryPreview: historyQueryContextResolution.previousQueryPreview,
                activeQuerySession: memoryQuerySessionRef.current ? {
                  kind: memoryQuerySessionRef.current.kind,
                  lookupMode: memoryQuerySessionRef.current.lookupMode,
                  targetSpeaker: memoryQuerySessionRef.current.targetSpeaker,
                  reusable: isReusableHistoricalSession(memoryQuerySessionRef.current),
                  parserStatus: memoryQuerySessionRef.current.parserStatus ?? null,
                  parserSource: memoryQuerySessionRef.current.parserSource ?? null,
                  parserPrecision: memoryQuerySessionRef.current.parserPrecision ?? null,
                  parserConfidence: memoryQuerySessionRef.current.parserConfidence ?? null,
                  lastEvidenceSource: memoryQuerySessionRef.current.lastEvidenceSource ?? 'none',
                  confidenceLevel: memoryQuerySessionRef.current.confidenceLevel ?? 'low',
                } : null,
              });
              const temporalAnalysisResult = shouldAnalyzeTemporal
                ? await analyzeTemporalQueryDetailed(historyQueryContext, locationConfig)
                : null;
              temporalIntent = temporalAnalysisResult?.analysis ?? null;
              temporalDiagnostics = temporalAnalysisResult?.diagnostics ?? null;
              if (!temporalIntent && shouldAnalyzeTemporal && isReusableHistoricalSession(memoryQuerySessionRef.current) && memoryQuerySessionRef.current?.kind === 'temporal_history') {
                  temporalIntent = {
                    isTemporalQuery: true,
                    startTimestampJST: memoryQuerySessionRef.current.startTimestampJST ?? null,
                    endTimestampJST: memoryQuerySessionRef.current.endTimestampJST ?? null,
                    searchRole: memoryQuerySessionRef.current.searchRole ?? 'any',
                    precision: memoryQuerySessionRef.current.parserPrecision ?? null,
                    source: memoryQuerySessionRef.current.parserSource ?? 'local_heuristic',
                    confidence: memoryQuerySessionRef.current.parserConfidence ?? 'low',
                  };
                  temporalDiagnostics = {
                    status: 'session_fallback',
                    source: temporalIntent.source,
                    precision: temporalIntent.precision,
                    confidence: temporalIntent.confidence,
                    errorMessage: temporalAnalysisResult?.diagnostics.errorMessage ?? null,
                    outputPreview: temporalAnalysisResult?.diagnostics.outputPreview ?? null,
                  };
              }
              const temporalEpisodes = shouldAnalyzeTemporal && temporalIntent?.isTemporalQuery
                ? await loadTemporalEpisodesForRange(temporalIntent.startTimestampJST, temporalIntent.endTimestampJST, { limit: 8 })
                : [];
              temporalEpisodeCount = temporalEpisodes.length;
              const temporalHistoryLookup = shouldAnalyzeTemporal
                ? (buildTemporalHistoryLookupBlock(historyEvidenceMessages, temporalIntent, temporalEpisodes, historyQueryContext) || buildTemporalNoEvidenceLookupBlock(historyQueryContext, temporalIntent, memoryQuerySessionRef.current, temporalDiagnostics))
                : null;
              const llmSearchStrategy: HistoricalSearchStrategy | null = historyQueryRewrite?.searchStrategy ?? null;
              const shouldRunSemanticRag = historicalQueryIntent === 'semantic'
                || llmSearchStrategy === 'topic_search'
                || (llmSearchStrategy === 'temporal_range' && !temporalHistoryLookup?.strict);
              if (temporalHistoryLookup?.strict) {
                  historyLookup = temporalHistoryLookup;
                  memoryRoute = 'temporal_history';
                  setRagStatus('IDLE');
              } else if (shouldRunSemanticRag) {
                  const semanticSearchQuery = historyQueryRewrite?.topicQuery || historyQueryContext;
                  semanticRoleConstraint = historyQueryRewrite?.searchRole ?? getTemporalSearchRoleFromQuery(historyQueryContext);
                  const effectiveKeywords = historyQueryRewrite?.searchKeywords
                    || (memoryQuerySessionRef.current?.kind === 'topic_search'
                        ? extractTopicFallbackKeywords(userTextForRag)
                        : undefined);
                  const semanticRecall = await searchLocalRagMemoryDetailed(
                    semanticSearchQuery,
                    getCurrentAIConfig(),
                    3,
                    semanticRoleConstraint !== 'any' ? { role: semanticRoleConstraint } : undefined,
                    'semantic_recall',
                    effectiveKeywords
                  );
                  semanticEntryKindSummary = semanticRecall.entryKindSummary;
                  semanticDominantEntryKind = semanticRecall.dominantEntryKind;
                  const semanticEvidenceSummary = formatSemanticEntryKindSummary(semanticRecall.entryKindSummary);
                  const semanticEvidenceDescriptors = buildSemanticRecallEvidenceDescriptors(semanticRecall.groupedBlocks);
                  semanticEvidenceSectionCount = semanticEvidenceDescriptors.length;
                  semanticEvidenceStrengthSummary = formatSemanticEvidenceStrengthSummary(semanticRecall.groupedBlocks);
                  semanticQuoteSafeSummary = formatSemanticQuoteSafeSummary(semanticRecall.groupedBlocks);
                  semanticEnvelopeEntryMix = semanticEvidenceSummary || 'none';
                  semanticConfidenceLevel = semanticEvidenceDescriptors.length > 0
                    ? (semanticRecall.dominantEntryKind === 'message' ? 'high' : 'medium')
                    : 'low';
                  const semanticEvidenceContext = buildMemoryEvidenceContext({
                    marker: '[SEMANTIC_RECALL_EVIDENCE]',
                    intent: 'semantic_recall',
                    answerMode: 'thematic_summary_with_support',
                    confidenceLevel: semanticConfidenceLevel,
                    primaryEvidence: semanticRecall.dominantEntryKind || 'unknown',
                    entryMix: semanticEnvelopeEntryMix,
                    evidenceStrengths: semanticEvidenceStrengthSummary || 'none',
                    quoteSafeKinds: semanticQuoteSafeSummary || 'none',
                    sections: semanticEvidenceDescriptors,
                  });
                  semanticAnswerMode = 'thematic_summary_with_support';
                  semanticResponseStrategy = buildMemoryEvidenceResponseStrategy(
                    'thematic_summary_with_support',
                    semanticConfidenceLevel,
                    semanticQuoteSafeSummary || 'none'
                  );
                  ragContext = semanticEvidenceDescriptors.length > 0
                    ? semanticEvidenceContext
                    : [];
                  memoryRoute = ragContext.length > 0 ? 'fuzzy_rag' : 'recent_only';
                  setRagStatus('IDLE');
              } else {
                  memoryRoute = 'recent_only';
                  setRagStatus('IDLE');
              }
          } catch (e) {
              console.warn("RAG Recall failed", e);
              setRagStatus('ERROR');
          }
      } else if (historyLookup?.strict) {
          setRagStatus(backupConfig.ragEnabled ? 'IDLE' : 'OFF');
      }

      if (historyLookup?.strict) {
        const now = Date.now();
        const previousSession = memoryQuerySessionRef.current;
        const nextSession: MemoryQuerySession = {
          kind: memoryRoute === 'temporal_history' ? 'temporal_history' : 'exact_history',
          sourceQuery: historyQueryContext,
          lookupMode: historyLookup.mode,
          targetSpeaker: historyLookup.targetSpeaker ?? null,
          searchRole: temporalIntent?.searchRole ?? previousSession?.searchRole ?? null,
          startTimestampJST: temporalIntent?.startTimestampJST ?? previousSession?.startTimestampJST ?? null,
          endTimestampJST: temporalIntent?.endTimestampJST ?? previousSession?.endTimestampJST ?? null,
          parserStatus: memoryRoute === 'temporal_history'
            ? (temporalDiagnostics?.status ?? historyLookup?.parserStatus ?? previousSession?.parserStatus ?? null)
            : null,
          parserSource: memoryRoute === 'temporal_history'
            ? (temporalIntent?.source ?? previousSession?.parserSource ?? null)
            : null,
          parserPrecision: memoryRoute === 'temporal_history'
            ? (temporalIntent?.precision ?? previousSession?.parserPrecision ?? null)
            : null,
          parserConfidence: memoryRoute === 'temporal_history'
            ? (temporalIntent?.confidence ?? previousSession?.parserConfidence ?? null)
            : null,
          resultCount: historyLookup.matchedCount,
          lastEvidenceSource: historyLookup.evidenceMode ?? 'none',
          confidenceLevel: historyLookup.confidenceLevel ?? 'low',
          createdAt: previousSession?.createdAt ?? now,
          lastUsedAt: now,
        };
        const canPersistTemporalSession = nextSession.kind !== 'temporal_history'
          || isReusableHistoricalSession(nextSession);
        updateMemoryQuerySession(canPersistTemporalSession ? nextSession : null);
      } else if (memoryRoute === 'fuzzy_rag' && historyQueryRewrite?.searchStrategy === 'topic_search') {
        const now = Date.now();
        updateMemoryQuerySession({
          kind: 'topic_search',
          sourceQuery: historyQueryRewrite?.topicQuery || historyQueryContext,
          lookupMode: 'temporal_window',
          targetSpeaker: null,
          searchRole: historyQueryRewrite?.searchRole ?? 'any',
          resultCount: ragContext.length,
          lastEvidenceSource: 'episodes',
          confidenceLevel: semanticConfidenceLevel ?? 'low',
          createdAt: memoryQuerySessionRef.current?.createdAt ?? now,
          lastUsedAt: now,
        });
      } else if (!currentLooksHistoryLike && historyQueryContextResolution.source === 'self') {
        updateMemoryQuerySession(null);
      } else if (memoryQuerySessionRef.current) {
        updateMemoryQuerySession({
          ...memoryQuerySessionRef.current,
          sourceQuery: historyQueryContextResolution.source === 'self'
            ? memoryQuerySessionRef.current.sourceQuery
            : historyQueryContext,
          parserStatus: temporalDiagnostics?.status ?? historyLookup?.parserStatus ?? memoryQuerySessionRef.current.parserStatus ?? null,
          parserSource: temporalIntent?.source ?? memoryQuerySessionRef.current.parserSource ?? null,
          parserPrecision: temporalIntent?.precision ?? memoryQuerySessionRef.current.parserPrecision ?? null,
          parserConfidence: temporalIntent?.confidence ?? historyLookup?.parserConfidence ?? memoryQuerySessionRef.current.parserConfidence ?? null,
          lastEvidenceSource: historyLookup?.evidenceMode ?? memoryQuerySessionRef.current.lastEvidenceSource ?? 'none',
          confidenceLevel: historyLookup?.confidenceLevel ?? memoryQuerySessionRef.current.confidenceLevel ?? 'low',
          lastUsedAt: Date.now(),
        });
      }

      const strictEvidenceTurn = !!historyLookup?.strict;
      const memoryResponsePlanBlock = strictEvidenceTurn
        ? buildMemoryResponsePlanBlock({
            route: memoryRoute === 'temporal_history' ? 'temporal_history' : 'exact_history',
            responseStrategy: historyLookup?.responseStrategy ?? null,
            answerMode: historyLookup?.answerMode ?? null,
            confidenceLevel: historyLookup?.confidenceLevel ?? null,
            primaryEvidenceKind: historyLookup?.primaryEvidenceKind ?? null,
            quoteSafeKinds: historyLookup?.quoteSafeKinds ?? null,
            entryMixSummary: historyLookup?.entryMixSummary ?? null,
            targetSpeaker: historyLookup?.targetSpeaker ?? null,
            parserPrecision: historyLookup?.parserPrecision ?? null,
          })
        : (memoryRoute === 'fuzzy_rag'
          ? buildMemoryResponsePlanBlock({
              route: 'fuzzy_rag',
              responseStrategy: semanticResponseStrategy,
              answerMode: semanticAnswerMode,
              confidenceLevel: semanticConfidenceLevel,
              primaryEvidenceKind: semanticDominantEntryKind,
              quoteSafeKinds: semanticQuoteSafeSummary,
              entryMixSummary: semanticEnvelopeEntryMix,
              targetSpeaker: semanticRoleConstraint === 'user'
                ? 'User'
                : semanticRoleConstraint === 'model'
                  ? 'Kumiko'
                  : 'Any',
              parserPrecision: null,
            })
          : null);

      console.log(`[MEMORY ROUTE] ${memoryRoute}`, {
        strictLookup: historyLookup?.strict ?? false,
        lookupFound: historyLookup?.found ?? false,
        lookupMode: historyLookup?.mode ?? null,
        lookupSpeaker: historyLookup?.targetSpeaker ?? null,
        lookupRangeJst: historyLookup?.rangeJst ?? null,
        lookupMatches: historyLookup?.matchedCount ?? 0,
        temporalParserUsed: temporalIntent?.isTemporalQuery ?? false,
        temporalParserStatus: temporalDiagnostics?.status ?? null,
        temporalParserRole: temporalIntent?.searchRole ?? null,
        temporalParserSource: temporalIntent?.source ?? null,
        temporalParserPrecision: temporalIntent?.precision ?? null,
        temporalParserConfidence: temporalIntent?.confidence ?? temporalDiagnostics?.confidence ?? null,
        temporalParserError: temporalDiagnostics?.errorMessage ?? null,
        temporalParserOutputPreview: temporalDiagnostics?.outputPreview ?? null,
        temporalParserRangeJst: temporalIntent?.isTemporalQuery
          ? formatTemporalRangeJst(temporalIntent.startTimestampJST, temporalIntent.endTimestampJST)
          : null,
        historicalQueryIntent,
        historyEvidenceSource,
        historyEvidenceCount: historyEvidenceMessages.length,
        historyEvidenceMode: historyLookup?.evidenceMode ?? 'none',
        historyConfidenceLevel: historyLookup?.confidenceLevel ?? 'low',
        historyRawSupportCount: historyLookup?.rawSupportCount ?? 0,
        historyEvidenceStrengthSummary: historyLookup?.evidenceStrengthSummary ?? null,
        historyQuoteSafeKinds: historyLookup?.quoteSafeKinds ?? null,
        historyEvidenceSectionCount: historyLookup?.evidenceSectionCount ?? 0,
        historyPrimaryEvidenceKind: historyLookup?.primaryEvidenceKind ?? null,
        historyEntryMixSummary: historyLookup?.entryMixSummary ?? null,
        historyAnswerMode: historyLookup?.answerMode ?? null,
        historyResponseStrategy: historyLookup?.responseStrategy ?? null,
        historyParserStatus: historyLookup?.parserStatus ?? null,
        historyParserSource: historyLookup?.parserSource ?? null,
        historyParserPrecision: historyLookup?.parserPrecision ?? null,
        historyParserConfidence: historyLookup?.parserConfidence ?? null,
        rewrittenQueryApplied: !!historyQueryRewrite?.rewrittenQuery && historyQueryRewrite.rewrittenQuery !== rawHistoryQueryContext,
        rewrittenQueryPreview: historyQueryRewrite?.rewrittenQuery ? historyQueryRewrite.rewrittenQuery.slice(0, 160) : null,
        rewrittenIntent: historyQueryRewrite?.intent ?? null,
        rewrittenConfidence: historyQueryRewrite?.confidence ?? null,
        rewrittenSearchRole: historyQueryRewrite?.searchRole ?? null,
        rewriteError: historyQueryRewriteError,
        temporalEpisodeCount,
        semanticRoleConstraint,
        semanticDominantEntryKind,
        semanticEntryKindSummary,
        semanticEvidenceSectionCount,
        semanticEvidenceStrengthSummary,
        semanticQuoteSafeSummary,
        semanticEnvelopeEntryMix,
        semanticAnswerMode,
        semanticResponseStrategy,
        semanticConfidenceLevel,
        memoryResponsePlanBuilt: !!memoryResponsePlanBlock,
        querySessionUsed: historyQueryContextResolution.usedSession,
        querySessionSource: historyQueryContextResolution.source,
        querySessionReuseBlockedReason: historyQueryContextResolution.sessionReuseBlockedReason ?? null,
        querySessionReusable: isReusableHistoricalSession(memoryQuerySessionRef.current),
        activeQuerySession: memoryQuerySessionRef.current ? {
          kind: memoryQuerySessionRef.current.kind,
          lookupMode: memoryQuerySessionRef.current.lookupMode,
          targetSpeaker: memoryQuerySessionRef.current.targetSpeaker,
          reusable: isReusableHistoricalSession(memoryQuerySessionRef.current),
          parserStatus: memoryQuerySessionRef.current.parserStatus ?? null,
          parserSource: memoryQuerySessionRef.current.parserSource ?? null,
          parserPrecision: memoryQuerySessionRef.current.parserPrecision ?? null,
          parserConfidence: memoryQuerySessionRef.current.parserConfidence ?? null,
          lastEvidenceSource: memoryQuerySessionRef.current.lastEvidenceSource ?? 'none',
          confidenceLevel: memoryQuerySessionRef.current.confidenceLevel ?? 'low',
        } : null,
        ragBlocks: ragContext.length,
      });

      const activeReminders = await checkActiveReminders();
      const modelHistorySlice = strictEvidenceTurn ? historySlice.slice(-4) : historySlice;
      const modelCoreMemory = strictEvidenceTurn ? "" : coreMemory;
      const modelWorldBook = strictEvidenceTurn ? [] : [...worldBook, ...KUMIKO_LOCAL_RAG_ZH];
      const modelRagContext = strictEvidenceTurn
        ? []
        : (memoryResponsePlanBlock ? [memoryResponsePlanBlock, ...ragContext] : ragContext);
      
      // Inject ambient environment context into the first available slot if not strict turn
      if (!strictEvidenceTurn && ambientEnvironmentContext) {
        modelRagContext.push(ambientEnvironmentContext);
      }

      const modelActiveReminders = strictEvidenceTurn ? [] : activeReminders;
      const modelAnchors = strictEvidenceTurn ? [] : anchors;
      const modelNotebook = strictEvidenceTurn ? "" : kumikoNotebook;
      const modelExactHistoryLookup = historyLookup?.promptBlock
        ? (strictEvidenceTurn && memoryResponsePlanBlock
          ? `${memoryResponsePlanBlock}\n${historyLookup.promptBlock}`
          : historyLookup.promptBlock)
        : undefined;

      // --- STATE MACHINE INJECTION ---
      const isCurrentHolidayState = ambientEnvironmentContext.includes('今日特殊历法：日本法定节假日');
      const { getCurrentKumikoState } = await import('../services/kumikoStateMachine');
      const currentStateCtx = getCurrentKumikoState(locationConfig.modelTimezone, isCurrentHolidayState);
      
      const statePrompt = `\n[当前生活状态]
你现在正处于：${currentStateCtx.stateDescription}。
请在回复中自然地体现出这个状态（例如：如果在通勤，回复应该简短；如果在上课，回复可能带有被打断的匆忙感）。不要生硬地报告你的状态，而是通过语气和长度自然流露。`;

      if (!strictEvidenceTurn) {
        modelRagContext.push(statePrompt);
      }
      // -------------------------------

      // --- LIFE STREAM & PSYCHE STATE INJECTION ---
      if (!strictEvidenceTurn) {
        const { getPsycheState, getPsycheModePrompt } = await import('../services/psycheStateService');
        const psycheState = await getPsycheState();
        const psychePrompt = getPsycheModePrompt(psycheState);
        modelRagContext.push(`\n${psychePrompt}`);

        const { getDailyFragments, getRecentDiaries } = await import('../services/lifeStreamService');
        const now = Date.now();
        const jstDate = new Date(new Date(now).toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
        const dateStr = `${jstDate.getFullYear()}-${String(jstDate.getMonth() + 1).padStart(2, '0')}-${String(jstDate.getDate()).padStart(2, '0')}`;
        
        const recentDiaries = await getRecentDiaries(2);
        const todayFragments = await getDailyFragments(dateStr);
        
        let lifeStreamPrompt = `\n[近期生活轨迹]\n`;
        if (recentDiaries.length > 0) {
          lifeStreamPrompt += `前几日日记摘要：\n${recentDiaries.map(d => `- [${d.date}]: ${d.summary}`).join('\n')}\n`;
        }
        if (todayFragments.length > 0) {
          lifeStreamPrompt += `今日离线期间经历的事件切片：\n${todayFragments.map(f => `- [${new Date(f.timestamp).toLocaleTimeString('en-US', {timeZone: 'Asia/Tokyo'})}]: ${f.content}`).join('\n')}\n`;
        }
        
        if (recentDiaries.length > 0 || todayFragments.length > 0) {
          lifeStreamPrompt += `请在回复中自然地表现出这些记忆的延续感（情绪余波、事件后续等）。`;
          modelRagContext.push(lifeStreamPrompt);
        }
      }
      // --------------------------------------------

      const currentVoicePolicy = currentStateCtx.voicePolicy;
      let hybridVoicePrompt = '';
      
      if (ttsConfigRef.current.voiceMode === 'hybrid') {
        if (currentVoicePolicy === 'forbid') {
          hybridVoicePrompt = language === 'zh' 
            ? `[语音模式：受限]
你当前的状态（${currentStateCtx.stateDescription}）不方便发送语音。请**强制使用文字**回复。在回复末尾加上 [Voice_Mode: false]。`
            : `[Voice Mode: Restricted]
Your current state (${currentStateCtx.stateDescription}) does not allow voice messages. You MUST reply with text. Append [Voice_Mode: false] to your reply.`;
        } else if (currentVoicePolicy === 'discourage') {
          hybridVoicePrompt = language === 'zh'
            ? `[语音模式：混合（建议文字）]
你当前的状态（${currentStateCtx.stateDescription}）通常不太方便发语音，所以系统建议本条优先使用文字回复。
但这只是建议，不是强制。如果以久美子的真实反应来看，你此刻强烈想用声音表达，例如情绪明显、很想安抚对方、忍不住补一句、或者短短一句用语音更自然，你仍然可以选择发语音。
如果你决定发语音，请尽量自然、简短、像在当前环境下顺手发出的一句；如果觉得会太突兀或不方便，就继续用文字。
在回复末尾加上 [Voice_Mode: true] 表示语音，或 [Voice_Mode: false] 表示文字。`
            : `[Voice Mode: Hybrid (Text Recommended)]
Your current state (${currentStateCtx.stateDescription}) usually makes voice a bit inconvenient, so text is recommended for this reply.
However, this is only a recommendation, not a hard rule. If, as Kumiko, you genuinely feel a strong urge to use your voice for a short emotional reaction, reassurance, or a line that would sound more natural aloud, you may still choose voice.
If you choose voice, keep it natural and brief, like something you'd send in the current setting without making it feel forced. Otherwise, stay with text.
Append [Voice_Mode: true] for voice, or [Voice_Mode: false] for text at the end of your reply.`;
        } else {
          hybridVoicePrompt = language === 'zh'
            ? `[语音模式：混合]
你可以选择本条回复是否用语音。在回复末尾加上 [Voice_Mode: true] 表示语音，或 [Voice_Mode: false] 表示文字。
判断依据：短消息/即时反应/情绪强烈/紧急事务 → 语音；长篇解释/包含链接列表/需要阅读的内容 → 文字。
模拟真人行为：请像久美子自己决定一样自然选择，不必机械地固定全文字或全语音。现在环境允许发语音，如果关系亲近或者想表达情绪，可以更积极地使用语音。`
            : `[Voice Mode: Hybrid]
You can choose whether to use voice for this reply. Append [Voice_Mode: true] for voice, or [Voice_Mode: false] for text at the end of your reply.
Criteria: Short messages/instant reactions/strong emotions → voice; Long explanations/lists/reading material → text.
Simulate human behavior: decide as Kumiko would, not by a rigid template. Voice is allowed in the current setting, so feel free to use it more when closeness or emotion calls for it.`;
        }
      }

      const response: ChatResponse = await sendMessageToGemini(
        combinedText, 
        modelCoreMemory, 
        modelWorldBook, 
        modelHistorySlice, 
        locationConfig, 
        isImageMessage ? apiImage : undefined, 
        mimeType,
        0,
        undefined,
        modelRagContext,
        modelExactHistoryLookup,
        modelActiveReminders, 
        modelAnchors, 
        modelNotebook,
        undefined,
        language,
        hybridVoicePrompt || undefined,
      );
      
      if (generationIdRef.current !== currentGenId) {
        return; 
      }

      setCurrentEmotion(response.emotion);

      // --- SYSTEM NOTICE UI TRIGGER ---
      if (response.systemNotice) {
          setSystemNotice(response.systemNotice);
      }

      if (response.imageCaption && isImageMessage) {
          setMessages(prev => prev.map(m => {
              if (m.id === pendingImgId) {
                  return { ...m, imageCaption: response.imageCaption };
              }
              return m;
          }));
      }

      const parsedRelativeReminder = parseRelativeReminderRequest(userTextForRag);
      const parsedDailyReminder = parseDailyReminderRequest(userTextForRag);
      let createdReminderThisTurn = false;
      if (response.scheduleTrigger?.event) {
          const { event, days_offset, delay_seconds, recurrence, hour, minute } = response.scheduleTrigger;
          if (recurrence === 'daily' && typeof hour === 'number' && typeof minute === 'number') {
              await saveDailyReminder(event, hour, minute, userTextForRag);
              createdReminderThisTurn = true;
          } else if (typeof delay_seconds === 'number' && delay_seconds > 0) {
              await saveRelativeReminder(event, delay_seconds, userTextForRag);
              createdReminderThisTurn = true;
          } else if (typeof days_offset === 'number') {
              saveScheduleEvent(event, days_offset);
          }
      } else if (parsedDailyReminder) {
          await saveDailyReminder(parsedDailyReminder.event, parsedDailyReminder.hour, parsedDailyReminder.minute, userTextForRag);
          createdReminderThisTurn = true;
          console.log(`[DAILY REMINDER] Fallback parser scheduled reminder for "${parsedDailyReminder.event}"`);
      } else if (parsedRelativeReminder) {
          await saveRelativeReminder(parsedRelativeReminder.event, parsedRelativeReminder.delaySeconds, userTextForRag);
          createdReminderThisTurn = true;
          console.log(`[RELATIVE REMINDER] Fallback parser scheduled reminder for "${parsedRelativeReminder.event}"`);
      }

      if (response.anchorAction) {
          const action = response.anchorAction;
          if (action.type === 'add') {
              console.log("[ANCHOR] Adding new anchor:", action.content);
              const newAnchor: AnchorEntry = {
                  id: Date.now().toString(),
                  content: action.content,
                  timestamp: Date.now(),
                  emotion: response.emotion
              };
              setAnchors(prev => [newAnchor, ...prev]); 
          } else if (action.type === 'delete') {
              console.log("[ANCHOR] Deleting anchor matching:", action.content);
              setAnchors(prev => prev.filter(a => !a.content.includes(action.content)));
          }
      }

      const currentTtsCfg = ttsConfigRef.current;
      const isVoiceTurn = currentTtsCfg.voiceMode === 'full'
        || (currentTtsCfg.voiceMode === 'hybrid' && response.voiceMode === true);

      if (isVoiceTurn && currentTtsCfg.fishAudioApiKey && isVoiceServiceAvailable()) {
        const combinedText = response.textParts.join(' ');
        setIsThinking(true);

        // 动态延迟逻辑 (Dynamic Delay for Background)
        const isDocumentHidden = document.hidden || !document.hasFocus();
        if (isDocumentHidden && Math.random() < 0.4) {
          // 后台时，模拟真实的异步延迟 (为了不让用户等太久，这里缩短为 15-45 秒)
          const asyncDelay = 15000 + Math.random() * 30000;
          await new Promise(r => setTimeout(r, asyncDelay));
        }

        const quoteData = response.quote ? {
          id: 'model-reply-' + Date.now(),
          text: response.quote.text,
          role: 'user' as const,
        } : undefined;

        const voiceResult = await runVoicePipeline('pending-' + Date.now(), combinedText, response.emotion);
        if (generationIdRef.current !== currentGenId) { setIsThinking(false); return; }
        setIsThinking(false);

        if (voiceResult.success) {
          const voiceMsgId = addMessage(
            'model', combinedText, undefined, undefined, undefined, undefined,
            quoteData, response.emotion, undefined,
            { isVoiceMessage: true, voiceFileId: voiceResult.voiceFileId, voiceDuration: voiceResult.voiceDuration, japaneseText: voiceResult.japaneseText },
          );
          showBackgroundMessageNotification(combinedText, 'reply', voiceMsgId);
        } else {
          const textMsgId = addMessage(
            'model', combinedText, undefined, undefined, undefined, undefined,
            quoteData, response.emotion, undefined,
          );
          showBackgroundMessageNotification(combinedText, 'reply', textMsgId);
        }
      } else {
        for (let i = 0; i < response.textParts.length; i++) {
          if (generationIdRef.current !== currentGenId) break;

          const textContent = response.textParts[i];
          let delay = 0;

          if (i === 0) {
              setIsThinking(true);

              // 动态延迟逻辑 (Dynamic Delay for Background)
              const isDocumentHidden = document.hidden || !document.hasFocus();
              if (isDocumentHidden && Math.random() < 0.4) {
                const asyncDelay = 15000 + Math.random() * 30000;
                await new Promise(r => setTimeout(r, asyncDelay));
              }

              if (Math.random() < 0.05) {
                  console.log("%c[BEHAVIOR] Hesitation Triggered (She is rewriting...)", "color: pink; font-weight: bold;");
                  await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
                  setIsThinking(false);
                  
                  // Insert recall notice
                  const recallNotice = language === 'zh' ? '【黄前久美子撤回了一条消息】' : '[Kumiko recalled a message]';
                  addMessage('model', recallNotice, undefined, undefined, 'recall-' + Date.now());
                  
                  await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
                  if (generationIdRef.current !== currentGenId) break;
                  setIsThinking(true);
              }

              delay = 1500 + (textContent.length * 60);
              delay = Math.max(3000, Math.min(12000, delay));
          } else {
              delay = 1500 + (textContent.length * 40) + (Math.random() * 1000);
              delay = Math.min(8000, delay);
          }

          await new Promise(r => setTimeout(r, delay));

          if (generationIdRef.current !== currentGenId) break;

          if (i === 0 && ['angry', 'confused', 'surprised', 'shy'].includes(response.emotion) && Math.random() < 0.25) {
              const originalText = textContent;
              const cutOffPoint = Math.floor(originalText.length * 0.6);
              if (cutOffPoint > 2) {
                  const typoText = originalText.substring(0, cutOffPoint);

                  setIsThinking(false);
                  setIsTalking(true);
                  const typoId = addMessage('model', typoText, undefined, undefined, 'typo-' + Date.now());

                  await new Promise(r => setTimeout(r, 600));

                  setMessages(prev => prev.filter(m => m.id !== typoId));
                  setIsTalking(false);
                  setIsThinking(true);

                  await new Promise(r => setTimeout(r, 400));
              }
          }

          if (i === 0) {
              setIsThinking(false);
              setIsTalking(true);
          }

          const quoteData = (i === 0 && response.quote) ? {
              id: 'model-reply-' + Date.now(),
              text: response.quote.text,
              role: 'user' as const
          } : undefined;

          const modelMessageId = addMessage(
              'model',
              response.textParts[i],
              undefined,
              undefined,
              undefined,
              undefined,
              quoteData,
              response.emotion
          );

          if (i === 0) {
              showBackgroundMessageNotification(response.textParts[i], 'reply', modelMessageId);
          }
        }
      }
      
      if (generationIdRef.current === currentGenId) {
         setTimeout(() => setIsTalking(false), 2000);
      }

      if (response.activateSleepMode) {
          console.log("[SLEEP MODE] Activating after topic-ending reply.");
          hasGoneToSleepRef.current = true;
      }
      
      if (generationIdRef.current === currentGenId && backupConfig.ragEnabled) {
          const fullModelResponse = response.textParts.join(' ');
          
          const d = new Date();
          const formatter = new Intl.DateTimeFormat('en-US', {
              timeZone: 'Asia/Tokyo',
              year: 'numeric', month: '2-digit', day: '2-digit',
              hour: '2-digit', minute: '2-digit', hour12: false
          });
          const parts = formatter.formatToParts(d);
          const p: any = {};
          parts.forEach(part => p[part.type] = part.value);
          const timeStr = `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute} (JST)`;

          const imageDesc = response.imageCaption ? `(Image Description: ${response.imageCaption})` : "";
          
          const ragEntry = `【Time: ${timeStr}】\nUser: ${userTextForRag} ${imageDesc}\nKumiko: ${fullModelResponse}`;
          const memoryDecision = evaluateRagMemoryCandidate(ragEntry, 'turn_pair');

          if (!memoryDecision.shouldStore) {
              console.log(`[RAG FILTER] Skipped turn pair archive (${memoryDecision.reason})`, memoryDecision.flags);
          } else if (hasRecentRagDuplicate(memoryDecision.dedupeKey, recentRagDedupeKeysRef.current)) {
              console.log('[RAG FILTER] Skipped duplicate turn pair archive.');
          } else {
              rememberRecentRagDedupeKey(memoryDecision.dedupeKey);

              setRagStatus('INDEXING');
              saveLocalRagMemory(ragEntry, getCurrentAIConfig(), undefined, {
                  tier: mapRagDecisionTierToStorageTier(memoryDecision.tier),
                  source: 'turn_pair',
                  score: memoryDecision.score,
                  canonicalKey: memoryDecision.canonicalKey,
                  role: 'mixed',
              }).then(() => {
                  setRagStatus('IDLE');
              }).catch(e => {
                  console.warn("[RAG] Local Save Error", e);
                  setRagStatus('ERROR');
              });
          }
      }

      const newCount = turnCount + 1;
      const workingSummaryState: SummaryArchiveState = {
        ...summaryArchiveState,
        activeSegmentId: summaryArchiveState.activeSegmentId || buildSummarySegmentId(
          Date.now(),
          currentTurnStartMessageId,
          Date.now()
        ),
        segmentStartMessageId: summaryArchiveState.segmentStartMessageId || currentTurnStartMessageId,
        pendingSinceTurn: summaryArchiveState.pendingSinceTurn ?? (
          getTurnsInActiveSummarySegment(newCount, summaryArchiveState) >= SUMMARY_SOFT_THRESHOLD
            ? newCount
            : null
        ),
      };
      let boundaryDecision = evaluateSummaryBoundary({
        currentTurnCount: newCount,
        archiveState: workingSummaryState,
        userText: userTextForRag,
        gapMinutes: gapSincePreviousTurnMinutes,
        createdReminder: createdReminderThisTurn,
        activatedSleepMode: !!response.activateSleepMode,
      });
      setTurnCount(newCount);
      setSummaryArchiveState(workingSummaryState);

      if (!boundaryDecision.shouldSummarize && boundaryDecision.turnsInSegment >= SUMMARY_SOFT_THRESHOLD) {
          const semanticSignal = await calculateSummarySemanticSignal(workingSummaryState);
          boundaryDecision = evaluateSummaryBoundary({
            currentTurnCount: newCount,
            archiveState: workingSummaryState,
            userText: userTextForRag,
            gapMinutes: gapSincePreviousTurnMinutes,
            createdReminder: createdReminderThisTurn,
            activatedSleepMode: !!response.activateSleepMode,
            semanticSignal,
          });
      }
      
      if (boundaryDecision.shouldSummarize && boundaryDecision.reason) {
          const continuationSignal = await calculateSummaryContinuationSignal(workingSummaryState);
          const effectiveArchiveState = continuationSignal?.shouldContinue && workingSummaryState.carryoverStartMessageId
            ? {
                ...workingSummaryState,
                segmentStartMessageId: workingSummaryState.carryoverStartMessageId,
              }
            : workingSummaryState;
          const endBeforeMessageId = boundaryDecision.placement === 'before-current-turn'
            ? currentTurnStartMessageId
            : null;
          const nextSegmentStartTurn = boundaryDecision.placement === 'before-current-turn'
            ? Math.max(0, newCount - 1)
            : newCount;
          const nextSegmentStartMessageId = boundaryDecision.placement === 'before-current-turn'
            ? currentTurnStartMessageId
            : null;

          setTimeout(() => {
              void triggerAutoSummary({
                  currentCount: newCount,
                  currentMemory: coreMemory,
                  archiveState: effectiveArchiveState,
                  reason: boundaryDecision.reason!,
                  isComplete: boundaryDecision.isComplete,
                  isContinuation: !!continuationSignal?.shouldContinue,
                  turnsInSegment: boundaryDecision.turnsInSegment,
                  endBeforeMessageId,
                  nextSegmentStartTurn,
                  nextSegmentStartMessageId,
              });
          }, 1000);
      }

    } catch (e: any) {
      console.error("ExecuteSend Error:", e);
      if (e.message === 'RATE_LIMIT_EXCEEDED') {
          const config = getCurrentAIConfig();
          if (config.activeKey === 'primary' && config.apiKey_backup) {
              console.warn("[KEY_SWITCH] Primary key rate limited. Switching to backup key.");
              alert("主 API Key 已达到当日请求上限，将自动切换至备用 Key 并重试...");
              const newConfig: AIConfig = { 
                  ...config, 
                  activeKey: 'backup',
                  keySwitchTimestamp: Date.now() // Record the switch time
              };
              localStorage.setItem('kumiko_ai_config', JSON.stringify(newConfig));
              // Resend immediately with the new key
              executeSend(); 
              return; 
          } else {
               alert("API Key(s) have reached the daily request limit.");
          }
      }

      if (backupConfig.ragEnabled) setRagStatus('ERROR');
      if (generationIdRef.current === currentGenId) {
         setIsThinking(false);
         setIsTalking(false);
         addMessage('model', '...');
         setTimeout(() => addMessage('model', '刚才走神了... 能再说一遍吗？'), 800);
      }
    }
  }, [coreMemory, worldBook, contextLimit, triggerAutoSummary, locationConfig, backupConfig, checkActiveReminders, saveScheduleEvent, saveRelativeReminder, saveDailyReminder, anchors, kumikoNotebook, turnCount, language, showBackgroundMessageNotification, summaryArchiveState, calculateSummarySemanticSignal, calculateSummaryContinuationSignal, rememberRecentRagDedupeKey, isAutoDiaryBackfillEnabled, runAutoDiaryBackfill]);

  // ... rest of App.tsx (recall logic, reply logic, UI rendering) is preserved ...
  // [No changes needed in return logic as language prop is already passed down]
  
  // FIX: Clear pendingImageMessageIdRef on Recall if the recalled message was the one with the image
  const handleRecall = useCallback((id: string) => { 
      const msgToRecall = messagesRef.current.find(m => m.id === id); 
      if (!msgToRecall) return; 
      
      setMessages(prev => prev.filter(m => m.id !== id)); 
      
      if (pendingMessageIdsRef.current.has(id)) pendingMessageIdsRef.current.delete(id); 
      
      // CRITICAL FIX: If we recall the image message, clear the tracking ref
      if (id === pendingImageMessageIdRef.current) {
          pendingImageRef.current = null;
          pendingImageMessageIdRef.current = null;
      }

      setInputValue(prev => prev ? prev + '\n' + msgToRecall.text : msgToRecall.text); 
      const remainingPendingMessages = messagesRef.current.filter(m => pendingMessageIdsRef.current.has(m.id) && m.id !== id); 
      pendingTextRef.current = remainingPendingMessages.map(m => m.text).join('\n'); 
      if (remainingPendingMessages.length === 0) { 
          if (sendTimerRef.current) clearTimeout(sendTimerRef.current); 
          if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current); 
          setTimeLeft(0); 
          setIsListening(false); 
      } 
  }, []); 
  
  const handleReply = useCallback((msg: Message) => { setReplyingToMsg(msg); inputRef.current?.focus(); }, []);
  const handleCancelReply = useCallback(() => { setReplyingToMsg(null); }, []);
  
  const handleSend = useCallback(() => {
    if ((!inputValue.trim() && !selectedImage) || isThinking) return;

    // --- SLEEP LOGIC V3 (PRIORITIZED) ---
    
    // 1. Get current time context for Kumiko
    let modelHour = 12;
    try {
        const hourStr = new Date().toLocaleTimeString('en-GB', { 
            timeZone: locationConfig.modelTimezone, 
            hour: 'numeric', 
            hour12: false, 
            hourCycle: 'h23' 
        });
        modelHour = parseInt(hourStr, 10);
    } catch(e) { console.warn("Time check for sleep logic failed", e); }

    // 2. Daily Reset: Wake her up after 6 AM. This clears the sleep lock.
    if (modelHour >= 6) {
        hasGoneToSleepRef.current = false;
    }

    // 3. Define sleep conditions
    const isSleepWindow = modelHour >= 2 && modelHour < 6;
    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    const gapMinutes = lastMsg ? (Date.now() - lastMsg.timestamp) / 60000 : Infinity;

    // 4. PRIORITY 2: Check for "Natural Sleep" due to long inactivity.
    // This transitions her from Awake -> Asleep state *before* the auto-reply check.
    if (!hasGoneToSleepRef.current && isSleepWindow && gapMinutes > 30) {
        console.log("[SLEEP PROTOCOL] Auto-sleep triggered due to long inactivity during sleep window.");
        hasGoneToSleepRef.current = true;
    }
    
    // 5. PRIORITY 1: Check if she is ALREADY asleep. This is the highest priority intercept.
    // If the state is true (either from a previous AI response or the check above) AND it's still the sleep window...
    if (hasGoneToSleepRef.current && isSleepWindow) {
        console.log("[SLEEP PROTOCOL] User message received while asleep. Intercepting.");
        const userText = inputValue;
        addMessage('user', userText, selectedImage || undefined, undefined, undefined, undefined, undefined, undefined, selectedImageId || undefined);

        setTimeout(() => {
            addMessage('model', t.autoReplyText, undefined, undefined, undefined, undefined, undefined, 'sleepy');
        }, 800);

        // Store the user's message so she can "react" to it upon waking up.
        db.setVal('kumiko_pending_wakeup_context', userText);

        // Clear inputs and STOP execution here.
        setInputValue('');
        setSelectedImage(null);
        setSelectedImageId(null);
        setReplyingToMsg(null);
        return; // HALT
    }

    // --- END SLEEP LOGIC ---

    // 6. PRIORITY 3: If not intercepted, proceed with normal send. The AI will handle short-gap sleepy goodbyes.
    if (isTalking) setIsTalking(false); 
    generationIdRef.current += 1; 
    
    const userText = inputValue; 
    const userImage = selectedImage; 
    const userImageId = selectedImageId;
    const newMsgId = Date.now().toString() + Math.random().toString(); 
    
    let quoteContext = undefined; 
    if (replyingToMsg) { 
        quoteContext = { id: replyingToMsg.id, text: replyingToMsg.text, role: replyingToMsg.role }; 
    } 
    
    setInputValue(''); 
    setSelectedImage(null); 
    setSelectedImageId(null);
    setReplyingToMsg(null); 
    
    addMessage('user', userText, userImage || undefined, undefined, newMsgId, undefined, quoteContext, undefined, userImageId || undefined); 
    pendingMessageIdsRef.current.add(newMsgId); 
    
    let textToSend = userText; 
    if (quoteContext) { 
        const who = quoteContext.role === 'model' ? 'Kumiko' : 'User'; 
        textToSend = `> [Replying to ${who}]: "${quoteContext.text}"\n\n${userText}`; 
    } 
    
    pendingTextRef.current = pendingTextRef.current ? `${pendingTextRef.current}\n${textToSend}` : textToSend; 
    
    // CRITICAL FIX: Track which ID has the image
    if (userImage) {
        pendingImageRef.current = userImage;
        pendingImageMessageIdRef.current = newMsgId;
    }
    
    if (sendTimerRef.current) clearTimeout(sendTimerRef.current); 
    if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current); 
    setIsListening(true); 
    setTimeLeft(9); 
    countdownIntervalRef.current = setInterval(() => { setTimeLeft((prev) => Math.max(0, prev - 1)); }, 1000); 
    sendTimerRef.current = setTimeout(() => { executeSend(); }, 9000); 
    setTimeout(() => { inputRef.current?.focus(); }, 10); 
}, [inputValue, selectedImage, isThinking, isTalking, executeSend, replyingToMsg, locationConfig, language, messages, t.autoReplyText]);
  
  const [regeneratingVoiceIds, setRegeneratingVoiceIds] = useState<Set<string>>(new Set());

  const handleRegenerateVoice = useCallback(async (msg: Message) => {
    if (!msg.isVoiceMessage || !msg.id) return;
    
    setRegeneratingVoiceIds(prev => {
      const next = new Set(prev);
      next.add(msg.id);
      return next;
    });

    try {
      const textToSpeak = msg.japaneseText || msg.text;
      const emotion = msg.storedEmotion || 'neutral';
      
      const ttsConfigToUse = { ...ttsConfigRef.current };
      if (!ttsConfigToUse.fishAudioApiKey) {
        throw new Error('No API key');
      }

      const result = await synthesizeSpeech(textToSpeak, ttsConfigToUse);

      if (result.audio) {
        const fileId = msg.voiceFileId || msg.id;
        const saveSuccess = await saveVoiceFile(fileId, result.audio);
        if (saveSuccess) {
          handleUpdateMessage(msg.id, {
            voiceFileId: fileId,
            voiceDuration: result.durationEstimate
          });
        }
      }
    } catch (e) {
      console.error('[TTS] Failed to regenerate voice:', e);
    } finally {
      setRegeneratingVoiceIds(prev => {
        const next = new Set(prev);
        next.delete(msg.id);
        return next;
      });
    }
  }, [handleUpdateMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Enter') handleSend(); };
  const toggleTheme = () => setIsDarkMode(!isDarkMode);

  const {
    containerBg,
    overlayClass,
    sidebarBg,
    headerBg,
    textColor,
    mutedTextColor,
    inputAreaBg,
    inputBoxBg,
    chatContainerShadow,
    headerShadow,
    inputShadow,
    avatarPanelBg,
    avatarGradient,
    statusTextColor
  } = getAppShellStyles(isDarkMode);

  const displayRagStatus: 'IDLE' | 'RECALLING' | 'INDEXING' | 'ERROR' | 'OFF' | 'STALE' = !backupConfig.ragEnabled
    ? 'OFF'
    : (ragStatus === 'RECALLING' || ragStatus === 'INDEXING' || ragStatus === 'ERROR')
      ? ragStatus
      : isRagHistoryDirty
        ? 'STALE'
        : 'IDLE';

  const appMainViewProps = buildAppMainViewProps({
    isMemoryPanelOpen,
    setIsMemoryPanelOpen,
    isProfileOpen,
    setIsProfileOpen,
    isSettingsOpen,
    setIsSettingsOpen,
    isMessageCenterOpen,
    setIsMessageCenterOpen,
    isTaskPanelOpen,
    setIsTaskPanelOpen,
    isDiaryOpen,
    setIsDiaryOpen,
    flushIfDirty,
    coreMemory,
    contextLimit,
    messages,
    worldBook,
    handleSaveMemory,
    isDarkMode,
    turnCount,
    summaryProgressText,
    language,
    handleUpdateMessage,
    handleDeleteMessage,
    handleInsertMessage,
    handleReorderMessages,
    handleToggleHidden,
    handleTogglePin,
    handleJumpToMessage,
    anchors,
    handleDeleteAnchor,
    setViewingImage,
    kumikoNotebook,
    currentEmotion,
    unreadMessageCount: unreadAlertCount,
    messageAlerts,
    relativeReminders,
    dailyReminders,
    handleOpenMessageFromAlert: (messageId: string) => {
      setIsMessageCenterOpen(false);
      handleJumpToMessage(messageId);
      markAllAlertsRead();
    },
    handleDismissMessageAlert: (id: string) => {
      setMessageAlerts(prev => prev.filter(alert => alert.id !== id));
    },
    handleClearMessageAlerts: () => {
      setMessageAlerts([]);
    },
    handleDeleteRelativeReminder: removeRelativeReminder,
    handleDeleteDailyReminder: removeDailyReminder,
    handleToggleDailyReminderPaused: toggleDailyReminderPaused,
    handleExportBackup,
    handleImportBackup,
    handleRebuildRag,
    setLanguage,
    locationConfig,
    setLocationConfig,
    autoBackupInterval,
    setAutoBackupInterval,
    connectedFileName,
    lastBackupTime,
    handleCreateNewLocalFile,
    handleOpenLocalFile,
    triggerManualSave,
    handleManualLocalReload,
    backupConfig,
    cloudSyncAvailable: CLOUD_SYNC_AVAILABLE,
    autoZipEnabled,
    handleToggleAutoZip,
    handleBackupConfigChange,
    handleRegenerateVoice,
    regeneratingVoiceIds,
    handleDisconnectLocalFile,
    handleCloudRestore,
    handleCloudPush,
    isCloudSynced,
    devLogs,
    setDevLogs,
    ttsConfig,
    handleTtsConfigChange,
    appUpdateState,
    handleCheckForAppUpdates,
    handleDownloadAppUpdate,
    handleInstallAppUpdate,
    showAppUpdateModal,
    setShowAppUpdateModal,
    showDeleteConfirm,
    setShowDeleteConfirm,
    t,
    confirmDeleteSelected,
    showClearFlow,
    setShowClearFlow,
    setShowDoubleClearFlow,
    showDoubleClearFlow,
    handleClearAll,
    syncStatus,
    showSyncErrorModal,
    setShowSyncErrorModal,
    syncErrorMessage,
    showCloudRestorePrompt,
    setShowCloudRestorePrompt,
    isIOS,
    hasPerformedInitialPull,
    viewingImage,
    isTalking,
    statusText,
    avatarPanelBg,
    overlayClass,
    avatarGradient,
    statusTextColor,
    isFullscreen,
    isSelectionMode,
    ragStatus: displayRagStatus,
    ragProgressLabel,
    headerBg,
    headerShadow,
    textColor,
    mutedTextColor,
    fileHandleRef,
    toggleFullscreen,
    toggleSelectionMode,
    toggleTheme,
    manualRetry,
    initiateClearAll,
    selectedIds,
    pendingMessageIdsRef,
    highlightedMessageId,
    isListening,
    isThinking,
    timeLeft,
    messagesEndRef,
    inputRef,
    handleSelectMessage,
    handleRecall,
    handleReply,
    selectedImage,
    replyingToMsg,
    inputValue,
    inputAreaBg,
    inputShadow,
    inputBoxBg,
    fileInputRef,
    setInputValue,
    handleKeyDown,
    handleImageSelect,
    handleSend,
    messagesRef,
    handleCancelReply,
    setSelectedImage,
    initiateDeleteSelected,
    sidebarBg,
    chatContainerShadow
  });

  if (!isDataLoaded) {
    return <LoadingDataScreen />;
  }

  return (
  <div
    ref={appShellRef}
    className={`fixed inset-0 w-screen overflow-hidden transition-colors duration-500 ${
      flowState === 'APP' ? containerBg : 'bg-[#f9f7f2]'
    }`}
    style={{
      height: 'var(--app-height)',
      minHeight: 'var(--app-height)',
      maxHeight: 'var(--app-height)',
    }}
  >
    {flowState === 'APP' && ( <div className={`absolute inset-0 z-0 amadeus-bg-grid ${isDarkMode ? 'opacity-100' : 'opacity-30'}`}></div> )}
    {flowState === 'APP' && (
      <AppMainView {...appMainViewProps} />
    )}
    {backfillGapInfo && backfillGapInfo.totalMissing > 0 && (
      <DiaryBackfillDialogLazy
        gapInfo={backfillGapInfo}
        language={language}
        isDarkMode={isDarkMode}
        onConfirmAll={handleBackfillAll}
        onConfirmOne={handleBackfillOne}
        onDismiss={handleBackfillDismiss}
        progress={backfillProgress}
        isComplete={backfillComplete}
        generatedCount={backfillGeneratedCount}
      />
    )}
      <AppFlowScreens
          flowState={flowState}
          appState={appState}
          language={language}
          backupConfig={backupConfig}
          connectedFileName={connectedFileName}
          onLanguageChange={setLanguage}
          onBackupConfigChange={handleBackupConfigChange}
          onSelectLocalFile={handleOpenLocalFile}
          onImportBackup={handleImportBackup}
          onConnectCloud={handleCloudConnect}
          onRestoreCloud={handleCloudRestore}
          onDisconnectLocalFile={handleDisconnectLocalFile}
          onShowAuth={() => setFlowState('AUTH')}
          onShowConfig={() => setFlowState('CONFIG')}
          onShowApp={() => setFlowState('APP')}
          onReconfigure={() => {
              setAppState(AppState.CONNECTING);
              setFlowState('CONFIG');
          }}
      />
      {voiceCallOverlayData && (
        <VoiceCallOverlay
          reminderEvent={voiceCallOverlayData.reminderEvent}
          reminderText={voiceCallOverlayData.reminderText}
          ringtoneFileId={ttsConfig.ringtoneFileId}
          isDarkMode={isDarkMode}
          language={language}
          onAccept={voiceCallOverlayData.onAccept}
          onReject={voiceCallOverlayData.onReject}
          onClose={voiceCallOverlayData.onClose || (() => setVoiceCallOverlayData(null))}
          isConnecting={voiceCallOverlayData.isConnecting}
          isPlayingVoice={voiceCallOverlayData.isPlayingVoice}
          isEnded={voiceCallOverlayData.isEnded}
        />
      )}
      <SystemToast message={systemNotice} onClose={() => setSystemNotice(null)} isDarkMode={isDarkMode} />
      {isAutoZipping && (
        <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 text-white">
            <div className="w-10 h-10 border-4 border-white/30 border-t-white rounded-full animate-spin" />
            <p className="text-sm font-bold">{language === 'zh' ? '正在备份数据，请稍候...' : 'Backing up data, please wait...'}</p>
          </div>
        </div>
      )}
    </div>
  );
};
