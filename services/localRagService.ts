import { db } from './db';
import { AIConfig, Message } from '../types';

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
  tier?: 'core' | 'episodic' | 'background';
  source?: 'rebuild_message' | 'rebuild_fragment' | 'turn_pair' | 'memory_chunk' | 'episodic_merge';
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

export const initRagModel = async () => {
  // Model loading is handled by the main process (electron-rag.cjs)
  // Just check if the model is ready
  const ipc = getIpcRenderer();
  if (ipc) {
      const status = await ipc.invoke('rag:status');
      console.log('[LOCAL RAG] Status:', status);
      return status.modelLoaded;
  }
  return true; // fallback: assume ready for API mode
};

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
    image: message.image,
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
export const generateEmbedding = async (text: string, aiConfig: AIConfig, retries = 5, backoff = 2000): Promise<Float32Array> => {
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
            return generateEmbedding(text, aiConfig, retries - 1, backoff * 2);
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
  aiConfig: AIConfig,
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
  try {
    const ipc = getIpcRenderer();
    if (ipc) {
      const result = await ipc.invoke('rag:get-all');
      if (result.success) {
        return result.vectors;
      }
    }

    // Fallback: IndexedDB
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
    console.error("Failed to get all vectors", e);
    return [];
  }
};

// ==========================================
// RESTORE VECTORS (from backup/import)
// ==========================================
export const restoreVectors = async (vectorsData: any[]) => {
  try {
    if (!vectorsData || !Array.isArray(vectorsData)) return;
    
    const ipc = getIpcRenderer();
    if (ipc) {
      const result = await ipc.invoke('rag:restore', vectorsData);
      if (result.success) {
        console.log(`[LOCAL RAG] Restored ${result.count} vectors to SQLite.`);
        return;
      }
      console.warn('[LOCAL RAG] SQLite restore failed, falling back to IndexedDB');
    }

    // Fallback: IndexedDB
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
  } catch (e) {
    console.error("Failed to restore vectors", e);
  }
};

// ==========================================
// CLEAR ALL VECTORS
// ==========================================
export const clearAllLocalRagMemory = async () => {
  try {
    const ipc = getIpcRenderer();
    if (ipc) {
      const result = await ipc.invoke('rag:clear-all');
      if (result.success) {
        console.log('[LOCAL RAG] Cleared all SQLite vectors.');
        return;
      }
      console.warn('[LOCAL RAG] SQLite clear failed, falling back to IndexedDB:', result.error);
    }

    await db.vectors.clear();
    console.log('[LOCAL RAG] Cleared all IndexedDB vectors.');
  } catch (e) {
    console.error('Failed to clear local RAG memory', e);
    throw e;
  }
};

export const clearMessageLinkedLocalRagMemory = async () => {
  try {
    const ipc = getIpcRenderer();
    if (ipc) {
      const result = await ipc.invoke('rag:clear-message-vectors');
      if (result.success) {
        console.log(`[LOCAL RAG] Cleared ${result.count || 0} message-linked SQLite vectors.`);
        return;
      }
      console.warn('[LOCAL RAG] SQLite message-vector clear failed, falling back to IndexedDB:', result.error);
    }

    await db.vectors.filter(v => !!v.messageId).delete();
    console.log('[LOCAL RAG] Cleared message-linked IndexedDB vectors.');
  } catch (e) {
    console.error('Failed to clear message-linked local RAG memory', e);
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

export const getLocalRagRebuildStatus = async () => {
  const ipc = getIpcRenderer();
  if (!ipc) {
    return { active: false, snapshot: null as LocalRagRebuildSnapshot | null };
  }

  const result = await ipc.invoke('rag:rebuild:status');
  if (!result?.success) {
    throw new Error(result?.error || 'Failed to read local RAG rebuild status.');
  }

  return {
    active: !!result.active,
    snapshot: result.snapshot ? normalizeLocalRagRebuildSnapshot(result.snapshot) : null,
  };
};

export const subscribeLocalRagRebuild = (
  listener: (event: LocalRagRebuildEvent) => void
) => {
  const ipc = getIpcRenderer();
  if (!ipc) {
    return () => {};
  }

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
};

export const getLocalRagStats = async (): Promise<LocalRagStats> => {
  const ipc = getIpcRenderer();
  if (ipc) {
    const result = await ipc.invoke('rag:stats');
    if (result?.success && result.stats) {
      return normalizeLocalRagStats(result.stats);
    }
    throw new Error(result?.error || 'Failed to read local RAG stats.');
  }

  const allVectors = await db.vectors.toArray();
  const sourceCounts = allVectors.reduce<Record<string, number>>((acc, item) => {
    const key = item.source || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    vectorCount: allVectors.length,
    coreCount: allVectors.filter(item => item.tier === 'core').length,
    episodicCount: allVectors.filter(item => item.tier === 'episodic').length,
    backgroundCount: allVectors.filter(item => item.tier === 'background').length,
    messageLinkedCount: allVectors.filter(item => !!item.messageId).length,
    messageCount: await db.messages.count(),
    groupedCount: sourceCounts.rebuild_fragment || 0,
    mergedCount: sourceCounts.episodic_merge || 0,
    sourceCounts,
    hnswIndexed: 0,
    coreIndexed: 0,
    episodicIndexed: 0,
    backgroundIndexed: 0,
  };
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
    aiConfig: AIConfig, 
    topK: number = 3,
    temporalFilters?: { startTime?: number | null, endTime?: number | null, role?: string },
    memoryIntent: LocalRagSearchIntent = 'default',
    keywords?: string[]
): Promise<string[]> => {
  const result = await searchLocalRagMemoryDetailed(query, aiConfig, topK, temporalFilters, memoryIntent, keywords);
  return result.blocks;
};

export const searchLocalRagMemoryDetailed = async (
    query: string, 
    aiConfig: AIConfig, 
    topK: number = 3,
    temporalFilters?: { startTime?: number | null, endTime?: number | null, role?: string },
    memoryIntent: LocalRagSearchIntent = 'default',
    keywords?: string[]
): Promise<LocalRagRecallResult> => {
  try {
    let rawCandidates: { text: string, messageId?: string, source?: string, timestamp?: number, tier?: 'core' | 'episodic' | 'background', role?: string }[] = [];
    
    const ipc = getIpcRenderer();
    if (ipc) {
      const ipcPayload: Record<string, unknown> = { query, topK: 15, ...temporalFilters, memoryIntent };
      if (keywords && keywords.length > 0) ipcPayload.keywords = keywords;
      const result = await ipc.invoke('rag:search', ipcPayload);
      if (result.success && result.results.length > 0) {
        rawCandidates = result.results;
      } else if (!result.success) {
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
        rawCandidates = recentVectors.map(v => ({ text: v.text, messageId: v.messageId, source: v.source, timestamp: v.timestamp, role: 'unknown', tier: v.tier }));
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
