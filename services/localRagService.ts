import { db } from './db';
import { Message } from '../types';
import { isMobilePwa } from './environment';
import { subscribeEvents } from './httpApi';

// --- Electron IPC Bridge ---
// In Electron, embedding generation and vector search run in the main process (bge-m3 ONNX + SQLite).
// The renderer communicates via ipcRenderer.invoke().
// Desktop RAG is local-only. We do not fall back to external API embeddings.

const getIpcRenderer = () => {
    if (typeof window !== 'undefined' && (window as any).electronAPI) {
        return (window as any).electronAPI;
    }
    return null;
};

export interface LocalRagMemoryMetadata {
  tier?: 'core' | 'episodic' | 'background' | 'lore';
  source?: 'rebuild_message' | 'rebuild_fragment' | 'turn_pair' | 'memory_chunk' | 'episodic_merge' | 'official_lore' | 'lore';
  score?: number;
  canonicalKey?: string;
  timestamp?: number;
  role?: 'user' | 'model' | 'system' | 'mixed' | 'unknown';
  quiet?: boolean;
}

type LocalRagSearchIntent = 'default' | 'semantic_recall';
export type LocalRagEntryKind = 'message' | 'episode' | 'semantic_chunk' | 'background' | 'mixed';
export type LocalRagEvidenceStrength = 'primary' | 'secondary' | 'supporting';
export interface LocalRagGroupedRecallSection {
  kind: LocalRagEntryKind;
  strength: LocalRagEvidenceStrength;
  quoteSafe: boolean;
  blocks: string[];
}

export interface LocalRagRecallResult {
  blocks: string[];
  groupedBlocks: LocalRagGroupedRecallSection[];
  entryKindSummary: Record<LocalRagEntryKind, number>;
  dominantEntryKind: LocalRagEntryKind | null;
  candidateCount: number;
}

export type LocalRagRebuildStage =
  | 'loading_source_history'
  | 'grouping_fragments'
  | 'generating_embeddings'
  | 'writing_sqlite_rows'
  | 'building_indexes'
  | 'finalizing_statistics';

export interface LocalRagStats {
  vectorCount: number;
  coreCount: number;
  episodicCount: number;
  backgroundCount: number;
  messageLinkedCount: number;
  messageCount: number;
  groupedCount: number;
  mergedCount: number;
  sourceCounts: Record<string, number>;
  hnswIndexed: number;
  coreIndexed: number;
  episodicIndexed: number;
  backgroundIndexed: number;
}

export interface LocalRagRebuildSnapshot {
  jobId: string;
  stage: LocalRagRebuildStage;
  processed: number | null;
  total: number | null;
  extra: string | null;
  elapsedMs: number;
  candidateCount: number;
  filteredCount: number;
  duplicateCount: number;
  groupedCount: number;
  storedCount: number;
  mergedCount: number;
  skippedExistingCount: number;
  clearedCount: number;
  finalStats: LocalRagStats | null;
}

export type LocalRagRebuildEvent =
  | ({ type: 'started' | 'progress' } & LocalRagRebuildSnapshot)
  | ({ type: 'done' } & LocalRagRebuildSnapshot & { appliedCount?: number })
  | ({ type: 'error' } & LocalRagRebuildSnapshot & { error?: string });

const LOCAL_RAG_ENTRY_KIND_ORDER: LocalRagEntryKind[] = ['semantic_chunk', 'episode', 'message', 'background', 'mixed'];

/** Hybrid scores from main are RRF-based (~0.02–0.2); IPC may omit score and we use rank order as a proxy. */
const LORE_RETRIEVAL_SCORE_MULTIPLIER = 0.75;
const MAX_LORE_RESULTS_PER_SEARCH = 3;

const isLoreRagCandidate = (candidate: { tier?: string; source?: string }) =>
  candidate.tier === 'lore'
  || candidate.source === 'official_lore'
  || candidate.source === 'lore';

const applyLoreRetrievalWeightingAndCap = <
  T extends { tier?: string; source?: string; score?: number }
>(
  results: T[],
): T[] => {
  if (results.length === 0) return results;
  const n = results.length;
  const scored = results.map((candidate, index) => {
    const base = Number.isFinite(candidate.score) ? Number(candidate.score) : n - index;
    const lore = isLoreRagCandidate(candidate);
    // Apply tier-based weighting for lore results
    // Lore has medium priority: lower than user's own chat history, higher than old summaries
    const effectiveScore = lore ? base * LORE_RETRIEVAL_SCORE_MULTIPLIER : base;
    return { candidate, effectiveScore, lore };
  });
  const loreRanked = scored.filter(s => s.lore).sort((a, b) => b.effectiveScore - a.effectiveScore);
  const nonLore = scored.filter(s => !s.lore);
  // Cap lore results to prevent overwhelming user memories
  const cappedLore = loreRanked.slice(0, MAX_LORE_RESULTS_PER_SEARCH);
  return [...nonLore, ...cappedLore].sort((a, b) => b.effectiveScore - a.effectiveScore).map(s => s.candidate);
};
const RAG_REBUILD_STARTED_CHANNEL = 'rag:rebuild:started';
const RAG_REBUILD_PROGRESS_CHANNEL = 'rag:rebuild:progress';
const RAG_REBUILD_DONE_CHANNEL = 'rag:rebuild:done';
const RAG_REBUILD_ERROR_CHANNEL = 'rag:rebuild:error';

const getLocalRagEvidenceStrength = (
  kind: LocalRagEntryKind,
  memoryIntent: LocalRagSearchIntent
): LocalRagEvidenceStrength => {
  if (memoryIntent === 'semantic_recall') {
    if (kind === 'semantic_chunk') return 'primary';
    if (kind === 'episode' || kind === 'message') return 'secondary';
    return 'supporting';
  }

  if (kind === 'message') return 'primary';
  if (kind === 'episode' || kind === 'semantic_chunk') return 'secondary';
  return 'supporting';
};

const isLocalRagQuoteSafeKind = (kind: LocalRagEntryKind) => kind === 'message';

const getMemoryEntryKindFromCandidate = (candidate: {
  source?: string;
  messageId?: string;
  role?: string;
}): LocalRagEntryKind => {
  if (candidate.source === 'memory_chunk') return 'semantic_chunk';
  if (candidate.source === 'episodic_merge' || candidate.source === 'rebuild_fragment') return 'episode';
  if (candidate.source === 'turn_pair' || candidate.role === 'mixed' || candidate.role === 'system') return 'mixed';
  if (candidate.messageId || candidate.source === 'rebuild_message') return 'message';
  return 'background';
};

const toFiniteNumber = (value: any, fallback: number = 0) => {
  return Number.isFinite(value) ? Number(value) : fallback;
};

const normalizeLocalRagStats = (stats: any): LocalRagStats => ({
  vectorCount: toFiniteNumber(stats?.vectorCount),
  coreCount: toFiniteNumber(stats?.coreCount),
  episodicCount: toFiniteNumber(stats?.episodicCount),
  backgroundCount: toFiniteNumber(stats?.backgroundCount),
  messageLinkedCount: toFiniteNumber(stats?.messageLinkedCount),
  messageCount: toFiniteNumber(stats?.messageCount),
  groupedCount: toFiniteNumber(stats?.groupedCount),
  mergedCount: toFiniteNumber(stats?.mergedCount),
  sourceCounts: stats && typeof stats.sourceCounts === 'object' && !Array.isArray(stats.sourceCounts)
    ? Object.fromEntries(
        Object.entries(stats.sourceCounts).map(([key, value]) => [key, toFiniteNumber(value)])
      )
    : {},
  hnswIndexed: toFiniteNumber(stats?.hnswIndexed),
  coreIndexed: toFiniteNumber(stats?.coreIndexed),
  episodicIndexed: toFiniteNumber(stats?.episodicIndexed),
  backgroundIndexed: toFiniteNumber(stats?.backgroundIndexed),
});

const normalizeLocalRagRebuildSnapshot = (payload: any): LocalRagRebuildSnapshot => ({
  jobId: typeof payload?.jobId === 'string' ? payload.jobId : '',
  stage: payload?.stage as LocalRagRebuildStage,
  processed: Number.isFinite(payload?.processed) ? Number(payload.processed) : null,
  total: Number.isFinite(payload?.total) ? Number(payload.total) : null,
  extra: typeof payload?.extra === 'string' ? payload.extra : null,
  elapsedMs: toFiniteNumber(payload?.elapsedMs),
  candidateCount: toFiniteNumber(payload?.candidateCount),
  filteredCount: toFiniteNumber(payload?.filteredCount),
  duplicateCount: toFiniteNumber(payload?.duplicateCount),
  groupedCount: toFiniteNumber(payload?.groupedCount),
  storedCount: toFiniteNumber(payload?.storedCount),
  mergedCount: toFiniteNumber(payload?.mergedCount),
  skippedExistingCount: toFiniteNumber(payload?.skippedExistingCount),
  clearedCount: toFiniteNumber(payload?.clearedCount),
  finalStats: payload?.finalStats ? normalizeLocalRagStats(payload.finalStats) : null,
});

const mapMainRawMessageToMessage = (raw: any): Message | null => {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || typeof raw.text !== 'string' || !Number.isFinite(raw.timestamp)) return null;
  if (raw.role !== 'user' && raw.role !== 'model') return null;

  return {
    id: raw.id,
    role: raw.role,
    text: raw.text,
    timestamp: raw.timestamp,
    image: typeof raw.image === 'string' ? raw.image : undefined,
    imageId: typeof raw.imageId === 'string' ? raw.imageId : undefined,
    imageCaption: typeof raw.imageCaption === 'string' ? raw.imageCaption : undefined,
    groundingSources: Array.isArray(raw.groundingSources) ? raw.groundingSources : undefined,
    isRead: typeof raw.isRead === 'boolean' ? raw.isRead : undefined,
    isHidden: typeof raw.isHidden === 'boolean' ? raw.isHidden : undefined,
    isPinned: typeof raw.isPinned === 'boolean' ? raw.isPinned : undefined,
    quote: raw.quote && typeof raw.quote === 'object' && typeof raw.quote.text === 'string' && (raw.quote.role === 'user' || raw.quote.role === 'model')
      ? {
          id: typeof raw.quote.id === 'string' ? raw.quote.id : undefined,
          text: raw.quote.text,
          role: raw.quote.role,
        }
      : undefined,
    storedEmotion: typeof raw.storedEmotion === 'string' ? raw.storedEmotion as any : undefined,
  };
};

export const loadRawHistoryMessagesFromMain = async (): Promise<Message[] | null> => {
  const ipc = getIpcRenderer();
  if (!ipc) return null;

  try {
    const result = await ipc.invoke('rag:get-messages');
    if (!result?.success || !Array.isArray(result.messages)) return [];
    return result.messages
      .map(mapMainRawMessageToMessage)
      .filter((message: Message | null): message is Message => !!message)
      .sort((a, b) => a.timestamp - b.timestamp);
  } catch (e) {
    console.warn('[LOCAL RAG] Failed to load raw history from main process.', e);
    return null;
  }
};

export const syncRawHistoryMessagesToMain = async (
  messages: Message[],
  options: { replaceAll?: boolean } = {}
) => {
  const ipc = getIpcRenderer();
  if (!ipc) return;

  const payload = messages.map(message => ({
    id: message.id,
    role: message.role,
    text: message.text,
    timestamp: message.timestamp,
    imageId: message.imageId,
    imageCaption: message.imageCaption,
    groundingSources: message.groundingSources,
    isRead: message.isRead,
    isHidden: message.isHidden,
    isPinned: message.isPinned,
    quote: message.quote,
    storedEmotion: message.storedEmotion,
    isVoiceMessage: message.isVoiceMessage,
    voiceFileId: message.voiceFileId,
    voiceDuration: message.voiceDuration,
    japaneseText: message.japaneseText,
  }));

  const result = await ipc.invoke('rag:sync-messages', {
    messages: payload,
    replaceAll: !!options.replaceAll,
  });
  if (!result?.success) {
    throw new Error(result?.error || 'Failed to sync raw history to main process');
  }
};

// ==========================================
// EMBEDDING GENERATION
// ==========================================
export const generateEmbedding = async (text: string, retries = 5, backoff = 2000): Promise<Float32Array> => {
  // Try local ONNX first (via IPC)
  const ipc = getIpcRenderer();
  if (ipc) {
      try {
          const result = await ipc.invoke('rag:embed', text);
          if (result.success) {
              return new Float32Array(result.vector);
          }
          throw new Error(result.error || 'Local embedding failed');
      } catch (e) {
          if (retries > 0) {
            console.warn(`[LOCAL RAG] Local embedding failed, retrying in ${backoff}ms... (${retries} retries left)`, e);
            await new Promise(resolve => setTimeout(resolve, backoff));
            return generateEmbedding(text, retries - 1, backoff * 2);
          }
          throw e;
      }
  }

  throw new Error('Local RAG is only available through the Electron main process.');
};

// ==========================================
// SAVE MEMORY
// ==========================================
export const saveLocalRagMemory = async (
  text: string,
  messageId?: string,
  metadata: LocalRagMemoryMetadata = {}
) => {
  try {
    const { quiet = false, ...persistedMetadata } = metadata;
    const ipc = getIpcRenderer();
    if (ipc) {
      // Use main process SQLite storage
      const result = await ipc.invoke('rag:save', { text, messageId, ...persistedMetadata });
      if (result.success) {
        if (result.skipped) {
          if (!quiet) {
            console.log("[LOCAL RAG] Skipped duplicate SQLite save:", result.reason || 'duplicate');
          }
          return;
        }
        if (result.merged) {
          if (!quiet) {
            console.log("[LOCAL RAG] Merged into episodic fragment:", text.substring(0, 50) + "...");
          }
          return;
        }
        if (!quiet) {
          console.log("[LOCAL RAG] Saved to SQLite:", text.substring(0, 50) + "...");
        }
        return;
      }
      throw new Error(result.error || 'SQLite save failed');
    }

    throw new Error('Local RAG save requires Electron IPC and SQLite support.');
  } catch (e) {
    console.error("Failed to save local RAG memory", e);
    throw e;
  }
};

// ==========================================
// GET ALL VECTORS (for backup/export)
// ==========================================
export const getAllVectors = async () => {
  const ipc = getIpcRenderer();
  if (ipc) {
    // P1 #13 follow-up (Plan 4): on desktop, SQLite is the real source of
    // RAG vectors — Dexie `vectors` is basically empty because `rag:save`
    // writes straight to SQLite. If the IPC fails we must NOT silently fall
    // back to Dexie and hand back an empty array, because the backup caller
    // would then write a structurally-valid but content-empty `vectors: []`
    // and the user would see "backup succeeded" with no RAG payload. Surface
    // the failure so handleExportBackup can alert the user.
    const result = await ipc.invoke('rag:get-all');
    if (!result?.success) {
      throw new Error(result?.error || 'Failed to read RAG vectors from main process.');
    }
    return result.vectors;
  }

  // Web/PWA build: Dexie is the real source of truth.
  try {
    const allVectors = await db.vectors.toArray();
    return allVectors.map(v => ({
      id: v.id,
      messageId: v.messageId,
      text: v.text,
      vector: Array.from(v.vector),
      timestamp: v.timestamp,
      tier: v.tier || 'core',
      source: v.source,
      score: v.score || 0,
      canonicalKey: v.canonicalKey,
    }));
  } catch (e) {
    console.error("Failed to get all vectors from IndexedDB", e);
    throw e instanceof Error ? e : new Error(String(e));
  }
};

// ==========================================
// RESTORE VECTORS (from backup/import)
// ==========================================

export interface RestoreVectorsResult {
  /** True only when every expected vector made it into SQLite (or the IndexedDB fallback). */
  ok: boolean;
  /** Number of vectors successfully restored. */
  restored: number;
  /** Number of vectors that failed (supplied but not persisted). */
  failed: number;
  /** Which storage backend was used ('sqlite' / 'indexeddb' / 'none'). */
  backend: 'sqlite' | 'indexeddb' | 'none';
  /** Human-readable error for the caller to surface, when `ok === false`. */
  error?: string;
}

// P1 #13: previously this helper returned `void` and swallowed both the SQLite
// failure path and any IndexedDB bulkAdd exception, so callers saw "Restore
// succeeded" even when part of the backup silently didn't land. Now we return
// a structured result so the importer can warn the user (and suggest rebuilding
// the RAG index) when recovery was partial.
export const restoreVectors = async (vectorsData: any[]): Promise<RestoreVectorsResult> => {
  if (!vectorsData || !Array.isArray(vectorsData) || vectorsData.length === 0) {
    return { ok: true, restored: 0, failed: 0, backend: 'none' };
  }

  const totalExpected = vectorsData.length;
  const ipc = getIpcRenderer();
  if (ipc) {
    try {
      const result = await ipc.invoke('rag:restore', vectorsData);
      if (result?.success) {
        const restored = typeof result.count === 'number' ? result.count : totalExpected;
        console.log(`[LOCAL RAG] Restored ${restored} vectors to SQLite.`);
        return { ok: restored === totalExpected, restored, failed: totalExpected - restored, backend: 'sqlite' };
      }
      console.warn('[LOCAL RAG] SQLite restore failed, falling back to IndexedDB:', result?.error);
    } catch (e) {
      console.warn('[LOCAL RAG] SQLite restore threw, falling back to IndexedDB:', e);
    }
  }

  // Fallback: IndexedDB
  try {
    const vectorsToRestore = vectorsData.map(v => ({
      id: v.id,
      messageId: v.messageId,
      text: v.text,
      vector: new Float32Array(v.vector),
      timestamp: v.timestamp,
      tier: v.tier || 'core',
      source: v.source,
      score: v.score || 0,
      canonicalKey: v.canonicalKey,
    }));
    await db.vectors.clear();
    await db.vectors.bulkAdd(vectorsToRestore);
    console.log(`Restored ${vectorsToRestore.length} vectors to local RAG memory (IndexedDB).`);
    return { ok: true, restored: vectorsToRestore.length, failed: 0, backend: 'indexeddb' };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('Failed to restore vectors', e);
    return { ok: false, restored: 0, failed: totalExpected, backend: 'indexeddb', error: message };
  }
};

// ==========================================
// CLEAR ALL VECTORS
// ==========================================
export const clearAllLocalRagMemory = async () => {
  const ipc = getIpcRenderer();
  if (ipc) {
    // P1 #13 follow-up (Plan 4): on desktop, clearing is SQLite-only because
    // that's where `rag:save` actually writes. Silently falling back to
    // `db.vectors.clear()` was a data-consistency trap — Dexie is almost
    // empty on desktop, so "Dexie cleared successfully" returned OK while
    // SQLite (the real RAG store) still held every vector. Surface the
    // failure instead so the user can retry or rebuild.
    const result = await ipc.invoke('rag:clear-all');
    if (!result?.success) {
      throw new Error(result?.error || 'Failed to clear RAG vectors in main process.');
    }
    console.log('[LOCAL RAG] Cleared all SQLite vectors.');
    return;
  }

  // Web/PWA build: Dexie is the real source of truth.
  try {
    await db.vectors.clear();
    console.log('[LOCAL RAG] Cleared all IndexedDB vectors.');
  } catch (e) {
    console.error('Failed to clear local RAG memory (IndexedDB)', e);
    throw e;
  }
};

export const startLocalRagRebuild = async () => {
  const ipc = getIpcRenderer();
  if (!ipc) {
    throw new Error('Local RAG rebuild requires Electron IPC.');
  }

  const result = await ipc.invoke('rag:rebuild:start');
  if (!result?.success) {
    throw new Error(result?.error || 'Failed to start local RAG rebuild.');
  }

  return {
    started: !!result.started,
    alreadyRunning: !!result.alreadyRunning,
    snapshot: result.snapshot ? normalizeLocalRagRebuildSnapshot(result.snapshot) : null,
  };
};

export const subscribeLocalRagRebuild = (
  listener: (event: LocalRagRebuildEvent) => void
) => {
  const ipc = getIpcRenderer();

  if (ipc) {
    const handleStarted = (_event: any, payload: any) => {
      listener({
        type: 'started',
        ...normalizeLocalRagRebuildSnapshot(payload),
      });
    };
    const handleProgress = (_event: any, payload: any) => {
      listener({
        type: 'progress',
        ...normalizeLocalRagRebuildSnapshot(payload),
      });
    };
    const handleDone = (_event: any, payload: any) => {
      listener({
        type: 'done',
        ...normalizeLocalRagRebuildSnapshot(payload),
        appliedCount: Number.isFinite(payload?.appliedCount) ? Number(payload.appliedCount) : undefined,
      });
    };
    const handleError = (_event: any, payload: any) => {
      listener({
        type: 'error',
        ...normalizeLocalRagRebuildSnapshot(payload),
        error: typeof payload?.error === 'string' ? payload.error : undefined,
      });
    };

    ipc.on(RAG_REBUILD_STARTED_CHANNEL, handleStarted);
    ipc.on(RAG_REBUILD_PROGRESS_CHANNEL, handleProgress);
    ipc.on(RAG_REBUILD_DONE_CHANNEL, handleDone);
    ipc.on(RAG_REBUILD_ERROR_CHANNEL, handleError);

    return () => {
      ipc.removeListener(RAG_REBUILD_STARTED_CHANNEL, handleStarted);
      ipc.removeListener(RAG_REBUILD_PROGRESS_CHANNEL, handleProgress);
      ipc.removeListener(RAG_REBUILD_DONE_CHANNEL, handleDone);
      ipc.removeListener(RAG_REBUILD_ERROR_CHANNEL, handleError);
    };
  }

  // Mobile PWA: no local IPC, but the desktop's useMobileBroadcaster
  // bridges the four rag:rebuild:* IPC events into the WebSocket fan-
  // out (Phase 3 Part D). We hook into that stream so mobile RAG UIs
  // see the exact same event sequence desktop UI sees.
  if (isMobilePwa()) {
    const unsubscribe = subscribeEvents((event) => {
      const type = event?.type;
      if (type === 'rag:rebuild:started') {
        const payload = (event as { job?: unknown }).job;
        listener({ type: 'started', ...normalizeLocalRagRebuildSnapshot(payload) });
      } else if (type === 'rag:rebuild:progress') {
        const payload = (event as { job?: unknown }).job;
        listener({ type: 'progress', ...normalizeLocalRagRebuildSnapshot(payload) });
      } else if (type === 'rag:rebuild:done') {
        const payload = (event as { job?: any }).job;
        listener({
          type: 'done',
          ...normalizeLocalRagRebuildSnapshot(payload),
          appliedCount: Number.isFinite(payload?.appliedCount) ? Number(payload.appliedCount) : undefined,
        });
      } else if (type === 'rag:rebuild:error') {
        const payload = (event as { job?: any }).job;
        listener({
          type: 'error',
          ...normalizeLocalRagRebuildSnapshot(payload),
          error: typeof payload?.error === 'string' ? payload.error : undefined,
        });
      }
    });
    return unsubscribe;
  }

  return () => {};
};

// ==========================================
// CONTEXT EXPANSION (stays in renderer - needs IndexedDB messages)
// ==========================================
interface RagMessage {
  messageId: string;
  text: string;
  timestamp: number;
  role: string;
}

const getStoredChatHistory = async (): Promise<any[]> => {
  try {
    const mainProcessMessages = await loadRawHistoryMessagesFromMain();
    const storedMessages = await db.messages.orderBy('timestamp').toArray();
    const mergedById = new Map<string, any>();

    if (Array.isArray(mainProcessMessages)) {
      mainProcessMessages.forEach(message => {
        if (!message?.id || typeof message.text !== 'string' || !Number.isFinite(message.timestamp)) return;
        mergedById.set(message.id, message);
      });
    }

    if (storedMessages.length > 0) {
      storedMessages.forEach(message => {
        if (!message?.id || typeof message.text !== 'string' || !Number.isFinite(message.timestamp)) return;
        mergedById.set(message.id, message);
      });
    }

    if (mergedById.size > 0) {
      return Array.from(mergedById.values()).sort((a, b) => a.timestamp - b.timestamp);
    }

    const stored = await db.getVal('kumiko_chat_history', []);
    if (!Array.isArray(stored)) return [];
    return stored
      .filter(message => message && typeof message.text === 'string' && Number.isFinite(message.timestamp))
      .sort((a, b) => a.timestamp - b.timestamp);
  } catch (e) {
    console.warn('[LOCAL RAG] Failed to load raw chat history from IndexedDB.', e);
    return [];
  }
};

const appendRawHistoryWindow = (
  messageMap: Map<string, RagMessage>,
  rawMessages: any[],
  targetIndex: number,
  windowSize: number = 5
) => {
  if (targetIndex < 0 || targetIndex >= rawMessages.length) return false;

  const start = Math.max(0, targetIndex - windowSize);
  const end = Math.min(rawMessages.length - 1, targetIndex + windowSize);
  for (let index = start; index <= end; index += 1) {
    const message = rawMessages[index];
    if (!message?.id || !message?.text || !Number.isFinite(message.timestamp)) continue;
    messageMap.set(message.id, {
      messageId: message.id,
      text: message.text,
      timestamp: message.timestamp,
      role: message.role || 'unknown',
    });
  }

  return true;
};

const expandContextBatch = async (candidates: { text: string, messageId?: string, source?: string, timestamp?: number }[]): Promise<string[]> => {
  const finalBlocks: string[] = [];
  const episodicBlocks: string[] = [];
  
  const messageMap = new Map<string, RagMessage>();
  const rawMessages = await getStoredChatHistory();
  
  for (const candidate of candidates) {
    if (candidate.source === 'episodic_merge') {
      episodicBlocks.push(candidate.text);
      continue;
    }
    
    try {
      const ipc = getIpcRenderer();
      if (candidate.messageId) {
          const rawIndex = rawMessages.findIndex(message => message.id === candidate.messageId);
          if (rawIndex >= 0 && appendRawHistoryWindow(messageMap, rawMessages, rawIndex)) {
             continue;
          }
      }

      if (Number.isFinite(candidate.timestamp)) {
          let closestIndex = -1;
          let smallestGap = Number.POSITIVE_INFINITY;
          rawMessages.forEach((message, index) => {
              const gap = Math.abs(message.timestamp - Number(candidate.timestamp));
              if (gap < smallestGap) {
                  smallestGap = gap;
                  closestIndex = index;
              }
          });

          if (closestIndex >= 0 && smallestGap <= 10 * 60 * 1000 && appendRawHistoryWindow(messageMap, rawMessages, closestIndex)) {
              continue;
          }
      }

      if (ipc && candidate.timestamp) {
          const result = await ipc.invoke('rag:expand-context', { timestamp: candidate.timestamp });
          if (result.success && result.messages) {
              result.messages.forEach((msg: any) => {
                  if (msg.messageId || msg.timestamp) {
                      const id = msg.messageId || `${msg.timestamp}`;
                      messageMap.set(id, {
                          messageId: msg.messageId,
                          text: msg.text,
                          timestamp: msg.timestamp,
                          role: msg.role || 'unknown'
                      });
                  }
              });
          }
      } else {
         episodicBlocks.push(candidate.text);
      }
    } catch (e) {
       console.error("Failed to expand candidate", e);
       episodicBlocks.push(candidate.text);
    }
  }

  const allMessages = Array.from(messageMap.values()).sort((a, b) => a.timestamp - b.timestamp);
  
  if (allMessages.length > 0) {
      let currentBlockMsgs = [allMessages[0]];
      
      for (let i = 1; i < allMessages.length; i++) {
          const prev = allMessages[i-1];
          const curr = allMessages[i];
          if (curr.timestamp - prev.timestamp > 60 * 60 * 1000) {
              finalBlocks.push(formatContextBlock(currentBlockMsgs));
              currentBlockMsgs = [curr];
          } else {
              currentBlockMsgs.push(curr);
          }
      }
      if (currentBlockMsgs.length > 0) {
          finalBlocks.push(formatContextBlock(currentBlockMsgs));
      }
  }

  const uniqueBlocks = Array.from(new Set([...episodicBlocks, ...finalBlocks]));
  return uniqueBlocks;
};

function formatContextBlock(msgs: RagMessage[]): string {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const formatted = msgs.map(msg => {
      const parts = formatter.formatToParts(new Date(msg.timestamp));
      const parsed: Record<string, string> = {};
      parts.forEach(part => {
        parsed[part.type] = part.value;
      });
      const timeStr = `${parsed.year}/${parsed.month}/${parsed.day} ${parsed.hour}:${parsed.minute} JST`;
      const prefix = msg.role === 'user'
        ? 'User: '
        : msg.role === 'model'
          ? 'Kumiko: '
          : msg.role === 'mixed'
            ? 'Mixed: '
            : '';
      return `[${timeStr}] ${prefix}${msg.text}`;
    }).join('\n');
    return `【Context Block】\n${formatted}`;
}

// ==========================================
// SEARCH (IPC to main process + context expansion + LLM re-ranking in renderer)
// ==========================================
export const searchLocalRagMemory = async (
    query: string,
    topK: number = 3,
    temporalFilters?: { startTime?: number | null, endTime?: number | null, role?: string },
    memoryIntent: LocalRagSearchIntent = 'default',
    keywords?: string[]
): Promise<string[]> => {
  const result = await searchLocalRagMemoryDetailed(query, topK, temporalFilters, memoryIntent, keywords);
  return result.blocks;
};

export const searchLocalRagMemoryDetailed = async (
    query: string,
    topK: number = 3,
    temporalFilters?: { startTime?: number | null, endTime?: number | null, role?: string },
    memoryIntent: LocalRagSearchIntent = 'default',
    keywords?: string[]
): Promise<LocalRagRecallResult> => {
  try {
    let rawCandidates: {
      text: string;
      messageId?: string;
      source?: string;
      timestamp?: number;
      tier?: 'core' | 'episodic' | 'background' | 'lore';
      role?: string;
      score?: number;
    }[] = [];
    
    const ipc = getIpcRenderer();
    if (ipc) {
      const ipcPayload: Record<string, unknown> = { query, topK: 15, ...temporalFilters, memoryIntent };
      if (keywords && keywords.length > 0) ipcPayload.keywords = keywords;
      const result = await ipc.invoke('rag:search', ipcPayload);
      // Defensive: result.results may legitimately be missing/undefined when the
      // SQLite vector table is empty or during race conditions. Accessing `.length`
      // on undefined would throw and the outer catch would mask the real "no results"
      // case as a generic failure, silently dropping all recall results.
      if (result?.success && Array.isArray(result.results) && result.results.length > 0) {
        rawCandidates = result.results;
      } else if (result && !result.success) {
        console.warn('[LOCAL RAG] IPC search failed:', result.error);
      }
    }

    // If no results from IPC, only use IndexedDB fallback when Electron IPC is unavailable.
    if (rawCandidates.length === 0) {
        if (ipc) {
            if (temporalFilters && (
              typeof temporalFilters.startTime === 'number'
              || typeof temporalFilters.endTime === 'number'
              || (temporalFilters.role && temporalFilters.role !== 'any')
            )) {
                console.warn('[LOCAL RAG] Temporal filters requested but IPC search returned no candidates. Skipping IndexedDB fallback to avoid wrong-time recall.');
            } else {
                console.warn('[LOCAL RAG] IPC search returned no candidates. Skipping recent-vector fallback to avoid false recall.');
            }
            return {
                blocks: [],
                groupedBlocks: [],
                entryKindSummary: {
                    message: 0,
                    episode: 0,
                    semantic_chunk: 0,
                    background: 0,
                    mixed: 0,
                },
                dominantEntryKind: null,
                candidateCount: 0,
            };
        }

        const allVectors = await db.vectors.toArray();
        if (allVectors.length === 0) {
            return {
                blocks: [],
                groupedBlocks: [],
                entryKindSummary: {
                    message: 0,
                    episode: 0,
                    semantic_chunk: 0,
                    background: 0,
                    mixed: 0,
                },
                dominantEntryKind: null,
                candidateCount: 0,
            };
        }
        console.log('[LOCAL RAG] Falling back to IndexedDB search...');
        const recentVectors = [...allVectors]
          .sort((a, b) => {
            const getTierOrder = (tier?: string) => tier === 'core' ? 0 : tier === 'episodic' ? 1 : 2;
            const tierOrder = getTierOrder(a.tier) - getTierOrder(b.tier);
            if (tierOrder !== 0) return tierOrder;
            return b.timestamp - a.timestamp;
          })
          .slice(0, topK);
        rawCandidates = recentVectors.map(v => ({
          text: v.text,
          messageId: v.messageId,
          source: v.source,
          timestamp: v.timestamp,
          role: 'unknown',
          tier: v.tier as 'core' | 'episodic' | 'background' | 'lore' | undefined,
          score: typeof v.score === 'number' ? v.score : undefined,
        }));
    }

    if (rawCandidates.length === 0) {
      return {
        blocks: [],
        groupedBlocks: [],
        entryKindSummary: {
          message: 0,
          episode: 0,
          semantic_chunk: 0,
          background: 0,
          mixed: 0,
        },
        dominantEntryKind: null,
        candidateCount: 0,
      };
    }

    if (temporalFilters?.role && temporalFilters.role !== 'any') {
        const strictRole = temporalFilters.role;
        const originalCount = rawCandidates.length;
        rawCandidates = rawCandidates.filter(candidate => {
            const candidateRole = candidate.role || 'unknown';
            const candidateSource = candidate.source || 'unknown';
            if (candidateSource === 'turn_pair') return false;
            if (candidateRole === 'mixed' || candidateRole === 'system' || candidateRole === 'unknown') return false;
            return candidateRole === strictRole;
        });
        if (rawCandidates.length !== originalCount) {
            console.log('[LOCAL RAG] Strict role cleanup applied:', {
                requestedRole: strictRole,
                before: originalCount,
                after: rawCandidates.length,
            });
        }
    }

    rawCandidates = applyLoreRetrievalWeightingAndCap(rawCandidates);

    if (rawCandidates.length === 0) {
      return {
        blocks: [],
        groupedBlocks: [],
        entryKindSummary: {
          message: 0,
          episode: 0,
          semantic_chunk: 0,
          background: 0,
          mixed: 0,
        },
        dominantEntryKind: null,
        candidateCount: 0,
      };
    }

    const candidateTierSummary = rawCandidates.reduce<Record<string, number>>((acc, candidate: any) => {
        const key = candidate.tier || 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
    const candidateEntryKindSummary = rawCandidates.reduce<Record<LocalRagEntryKind, number>>((acc, candidate: any) => {
        const key = getMemoryEntryKindFromCandidate(candidate);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {
        message: 0,
        episode: 0,
        semantic_chunk: 0,
        background: 0,
        mixed: 0,
    });
    const candidateSourceSummary = rawCandidates.reduce<Record<string, number>>((acc, candidate: any) => {
        const key = candidate.source || 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
    console.log('[LOCAL RAG] Retrieval mix:', {
        candidateCount: rawCandidates.length,
        tierSummary: candidateTierSummary,
        entryKindSummary: candidateEntryKindSummary,
        sourceSummary: candidateSourceSummary,
        temporalFiltered: !!(temporalFilters && (
          typeof temporalFilters.startTime === 'number'
          || typeof temporalFilters.endTime === 'number'
          || (temporalFilters.role && temporalFilters.role !== 'any')
        )),
        memoryIntent,
    });

    // Expand context for candidates (Parent-Document Retrieval)
    // Batch expansion properly groups them by timeline
    let consolidatedBlocks = await expandContextBatch(rawCandidates);
    const groupedBlocks: LocalRagGroupedRecallSection[] = [];
    for (const kind of LOCAL_RAG_ENTRY_KIND_ORDER) {
      const kindCandidates = rawCandidates.filter(candidate => getMemoryEntryKindFromCandidate(candidate) === kind);
      if (kindCandidates.length === 0) continue;
      const kindBlocks = await expandContextBatch(kindCandidates);
      if (kindBlocks.length === 0) continue;
      groupedBlocks.push({
        kind,
        strength: getLocalRagEvidenceStrength(kind, memoryIntent),
        quoteSafe: isLocalRagQuoteSafeKind(kind),
        blocks: kindBlocks.slice(0, topK),
      });
    }

    // Limit the number of unique blocks returned 
    const blocks = consolidatedBlocks.slice(0, topK);
    const dominantEntryKindEntry = (Object.entries(candidateEntryKindSummary) as [LocalRagEntryKind, number][])
      .sort((a, b) => b[1] - a[1])[0];
    const dominantEntryKind = dominantEntryKindEntry?.[1] ? dominantEntryKindEntry[0] : null;

    return {
      blocks,
      groupedBlocks,
      entryKindSummary: candidateEntryKindSummary,
      dominantEntryKind,
      candidateCount: rawCandidates.length,
    };
  } catch (e) {
    console.error("Failed to search local RAG memory", e);
    return {
      blocks: [],
      groupedBlocks: [],
      entryKindSummary: {
        message: 0,
        episode: 0,
        semantic_chunk: 0,
        background: 0,
        mixed: 0,
      },
      dominantEntryKind: null,
      candidateCount: 0,
    };
  }
};
