// services/androidRagService.ts
//
// v2.14.2 (J.4/J.5/J.6) — RAG service for the Android Capacitor APK.
// Implements the same `rag:*` channel surface that PC's electron-rag.cjs
// exposes (so localRagService's invoker abstraction can swap PC ↔ phone
// without touching the consumer-facing API). Backed by:
//   - Cloud embeddings via cloudEmbeddingService (5 providers).
//   - **Primary search path**: HNSW WASM index in androidRagHnswIndex
//     (hnswlib-wasm — same upstream nmslib/hnswlib as PC's hnswlib-node).
//   - **Fallback path**: brute-force cosine over Dexie's existing
//     `vectors` table. Used when HNSW init / load / search fails, when
//     the embedding dim drifts (provider switch), or when the corpus
//     exceeds HNSW_MAX_ELEMENTS (50 000). The fallback used to be the
//     primary path through v2.14.1 — keeping it as the safety net costs
//     nothing and guarantees Android RAG never goes dark.
//
// Capacity & latency budget:
//   - Typical Kumiko users have 4 000-12 000 vectors after a year of use.
//     With HNSW that's a sub-10 ms query on modern phones; brute force
//     at the same scale is ~50-100 ms. Either way well below the
//     200-800 ms cloud embedding round-trip the search already pays.
//   - At 50 000 vectors HNSW is still snappy (~15-30 ms) but RAM grows
//     to ~170 MB on the WASM heap; we hard-cap there and fall back to
//     brute force on Dexie streaming for users above that threshold.
//
// Channels implemented:
//   - rag:embed              → cloudEmbedding round-trip
//   - rag:save               → upsert into db.vectors AND HNSW (best-effort)
//   - rag:search             → HNSW first, fall back to brute force; same
//                              `results: [{ id, text, score, ... }]` shape
//                              PC returns.
//   - rag:get-all            → dump db.vectors (used by export)
//   - rag:clear-all          → wipe db.vectors AND drop HNSW index file
//   - rag:clear-message-vectors → bulk delete + HNSW markDelete batch
//   - rag:stats              → count + total vector bytes
//   - rag:status             → backend reflects current HNSW mode
//   - rag:expand-context     → ±5 min message lookup from db.messages
//   - rag:get-messages       → return full Dexie messages corpus
//   - rag:sync-messages      → no-op success (Dexie IS source of truth)
//   - rag:rebuild:start      → drop HNSW + stream Dexie back into a fresh
//                              index in 200-row batches; progress queryable
//   - rag:rebuild:status     → snapshot of the current rebuild loop state
//
// PC behavior: this module is NEVER imported on Electron. The Capacitor
// branch in localRagService.getRagInvoker() short-circuits to here only
// when isCapacitorNative() is true. PC continues to dispatch through
// Electron IPC exactly as before.

import { db, type VectorEntity } from './db';
import { generateCloudEmbedding } from './cloudEmbeddingService';
import * as hnsw from './androidRagHnswIndex';

interface RagSearchPayload {
  query: string;
  topK?: number;
  keywords?: string[];
  // Temporal filters (PC honors these via SQL WHERE; on Android we apply
  // them post-cosine in JS — same semantic outcome, just less efficient).
  beforeTimestamp?: number;
  afterTimestamp?: number;
}

interface RagSearchResultRow {
  id: string;
  messageId?: string;
  text: string;
  score: number;
  timestamp: number;
  tier?: VectorEntity['tier'];
  source?: VectorEntity['source'];
  canonicalKey?: string;
  tags?: string[];
}

interface RagSearchResponse {
  success: true;
  results: RagSearchResultRow[];
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  // Defensive on dimension mismatch — return 0 so the row sorts to the
  // bottom instead of crashing the search. Happens when the user changed
  // embedding provider without rebuilding (different dim).
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

function ensureFloat32(input: unknown): Float32Array | null {
  if (input instanceof Float32Array) return input;
  if (Array.isArray(input)) {
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i += 1) out[i] = Number(input[i]) || 0;
    return out;
  }
  // Dexie sometimes round-trips Float32Array as an ArrayBuffer-backed
  // Uint8Array. Try to recover it.
  if (input && typeof input === 'object' && 'buffer' in (input as ArrayBufferView)) {
    try {
      const view = input as ArrayBufferView;
      return new Float32Array(view.buffer, view.byteOffset, view.byteLength / 4);
    } catch {
      return null;
    }
  }
  return null;
}

async function handleEmbed(text: string): Promise<{ success: boolean; vector?: number[]; error?: string }> {
  try {
    const result = await generateCloudEmbedding(text);
    return { success: true, vector: Array.from(result.vector) };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Unknown error' };
  }
}

async function handleSave(payload: any): Promise<{ success: boolean; id?: string; error?: string }> {
  const {
    id: providedId,
    text,
    vector,
    messageId,
    tier,
    source,
    score,
    canonicalKey,
    timestamp,
    tags,
  } = payload || {};

  if (!text || typeof text !== 'string') {
    return { success: false, error: 'Missing text' };
  }

  let vectorBuf = ensureFloat32(vector);
  if (!vectorBuf) {
    // Caller didn't provide a vector → embed inline.
    try {
      const result = await generateCloudEmbedding(text);
      vectorBuf = result.vector;
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Embedding failed' };
    }
  }

  const id: string = providedId || `vec_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const entity: VectorEntity = {
    id,
    text,
    vector: vectorBuf,
    timestamp: typeof timestamp === 'number' ? timestamp : Date.now(),
  };
  if (messageId) entity.messageId = messageId;
  if (tier === 'core' || tier === 'episodic' || tier === 'background') entity.tier = tier;
  if (source) entity.source = source;
  if (typeof score === 'number') entity.score = score;
  if (canonicalKey) entity.canonicalKey = canonicalKey;
  if (Array.isArray(tags)) entity.tags = tags as string[];

  try {
    await db.vectors.put(entity);
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Dexie put failed' };
  }
  try {
    await hnsw.add(id, vectorBuf);
  } catch (e) {
    console.warn(`[androidRag] HNSW add(${id}) raised; brute force will catch this row:`, e);
  }
  return { success: true, id };
}

function shapeRow(row: VectorEntity, score: number): RagSearchResultRow {
  return {
    id: row.id,
    messageId: row.messageId,
    text: row.text,
    score,
    timestamp: row.timestamp,
    tier: row.tier,
    source: row.source,
    canonicalKey: row.canonicalKey,
    tags: row.tags,
  };
}

async function bruteForceSearch(
  queryVec: Float32Array,
  topK: number,
  beforeTimestamp: number | undefined,
  afterTimestamp: number | undefined,
): Promise<RagSearchResultRow[]> {
  const all = await db.vectors.limit(50_000).toArray();

  const candidates = all.filter((row) => {
    if (typeof beforeTimestamp === 'number' && row.timestamp >= beforeTimestamp) return false;
    if (typeof afterTimestamp === 'number' && row.timestamp <= afterTimestamp) return false;
    return true;
  });

  const scored = candidates
    .map((row) => {
      const vec = ensureFloat32(row.vector);
      if (!vec) return null;
      const score = cosineSimilarity(queryVec, vec);
      return { row, score };
    })
    .filter((x): x is { row: VectorEntity; score: number } => !!x);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, topK)).map(({ row, score }) => shapeRow(row, score));
}

async function hnswSearch(
  queryVec: Float32Array,
  topK: number,
  beforeTimestamp: number | undefined,
  afterTimestamp: number | undefined,
): Promise<RagSearchResultRow[] | null> {
  const hits = await hnsw.search(queryVec, Math.max(topK * 2, topK));
  if (!hits || hits.length === 0) return hits ? [] : null;

  const ids = hits.map((h) => h.vectorId);
  const rows = await db.vectors.bulkGet(ids);
  const out: RagSearchResultRow[] = [];
  for (let i = 0; i < hits.length && out.length < topK; i += 1) {
    const row = rows[i];
    if (!row) continue;
    if (typeof beforeTimestamp === 'number' && row.timestamp >= beforeTimestamp) continue;
    if (typeof afterTimestamp === 'number' && row.timestamp <= afterTimestamp) continue;
    out.push(shapeRow(row, hits[i].score));
  }
  return out;
}

async function handleSearch(payload: RagSearchPayload): Promise<RagSearchResponse> {
  const { query, topK = 15, beforeTimestamp, afterTimestamp } = payload || ({} as RagSearchPayload);
  if (!query || typeof query !== 'string') {
    return { success: true, results: [] };
  }

  let queryVec: Float32Array;
  try {
    const result = await generateCloudEmbedding(query);
    queryVec = result.vector;
  } catch (e) {
    console.warn('[androidRag] embedding query failed, returning empty results:', e);
    return { success: true, results: [] };
  }

  // Try HNSW first; on null (mode≠hnsw, dim drift, throw) fall through to
  // brute force so the user always gets results even if the WASM index is
  // unavailable.
  try {
    const hnswResults = await hnswSearch(queryVec, topK, beforeTimestamp, afterTimestamp);
    if (hnswResults) {
      return { success: true, results: hnswResults };
    }
  } catch (e) {
    console.warn('[androidRag] HNSW search threw, falling back to brute force:', e);
  }

  const bruteResults = await bruteForceSearch(queryVec, topK, beforeTimestamp, afterTimestamp);
  return { success: true, results: bruteResults };
}

async function handleGetAll(): Promise<{ success: boolean; vectors: any[] }> {
  const rows = await db.vectors.toArray();
  // Match PC's serialization: Float32Array → number[] for JSON safety.
  const vectors = rows.map((row) => ({
    ...row,
    vector: row.vector ? Array.from(ensureFloat32(row.vector) || []) : [],
  }));
  return { success: true, vectors };
}

async function handleClearAll(): Promise<{ success: boolean }> {
  await db.vectors.clear();
  try {
    await hnsw.clearAll();
  } catch (e) {
    console.warn('[androidRag] hnsw.clearAll threw:', e);
  }
  return { success: true };
}

async function handleClearMessageVectors(payload: any): Promise<{ success: boolean; deleted?: number }> {
  const ids: string[] = Array.isArray(payload?.messageIds) ? payload.messageIds : [];
  if (ids.length === 0) return { success: true, deleted: 0 };
  // Dexie compound `where` — `messageId` is not indexed but the table is
  // small enough for a full scan to be fine on phones.
  const matching = await db.vectors.filter((v) => !!v.messageId && ids.includes(v.messageId)).toArray();
  const vectorIds = matching.map((v) => v.id);
  await db.vectors.bulkDelete(vectorIds);
  try {
    await hnsw.markDeletedBatch(vectorIds);
  } catch (e) {
    console.warn('[androidRag] hnsw.markDeletedBatch threw:', e);
  }
  return { success: true, deleted: matching.length };
}

async function handleStats(): Promise<{ success: boolean; count: number; totalBytes: number }> {
  const count = await db.vectors.count();
  // Cheap byte estimate: assume average 2 KB per vector (768d × 4 bytes
  // + overhead). Used by the Settings panel "vector store size" surface.
  const totalBytes = count * 2 * 1024;
  return { success: true, count, totalBytes };
}

async function handleStatus(): Promise<{
  enabled: boolean;
  ready: boolean;
  backend: string;
  hnsw?: ReturnType<typeof hnsw.getStatus>;
}> {
  const status = hnsw.getStatus();
  const backend =
    status.mode === 'hnsw'
      ? 'android-hnsw-wasm'
      : status.mode === 'bruteforce'
        ? 'android-bruteforce'
        : 'android-uninitialized';
  return { enabled: true, ready: true, backend, hnsw: status };
}

async function handleExpandContext(payload: any): Promise<{ success: boolean; messages: any[] }> {
  const ts = Number(payload?.timestamp);
  if (!Number.isFinite(ts)) return { success: true, messages: [] };
  // Pull a ±5 minute window of messages around the timestamp. Mirrors the
  // PC SQLite path which does WHERE timestamp BETWEEN ts-5min AND ts+5min.
  const windowMs = 5 * 60 * 1000;
  const messages = await db.messages
    .where('timestamp')
    .between(ts - windowMs, ts + windowMs, true, true)
    .toArray();
  return { success: true, messages };
}

async function handleGetMessages(): Promise<{ success: boolean; messages: any[] }> {
  // On Android, db.messages IS the source of truth (no separate SQLite
  // mirror like on PC). Hand the caller the full message list so the
  // diary / psyche / temporal recall pipelines can build their corpora.
  const messages = await db.messages.toArray();
  return { success: true, messages };
}

async function handleSyncMessages(): Promise<{ success: boolean }> {
  // PC mirrors messages from Dexie into SQLite for full-text search.
  // On Android db.messages already IS the corpus, so this is a no-op
  // success. Returning `success: true` keeps the existing
  // localRagService.syncMessagesToRag flow happy.
  return { success: true };
}

// =====================================================================
// J.5 — RAG rebuild flow (Android)
//
// PC's electron-rag.cjs runs rebuild as a long-lived background job that
// emits IPC events. Android/Capacitor has no IPC event channel, so this
// runs the rebuild in-process and exposes a poll-able snapshot via
// rag:rebuild:status. The localRagService subscribe wrapper polls every
// ~300 ms on Capacitor to translate snapshots into LocalRagRebuildEvent
// transitions (started / progress / done / error).
//
// The rebuild is intentionally minimal compared to PC's pipeline:
//   1. Drop the in-memory + IDBFS HNSW index.
//   2. Re-init empty at capacity = max(10k, vector count + headroom).
//   3. Stream Dexie rows in batches of 200, insert into HNSW.
//   4. flush() to IDBFS.
//
// Steps PC's rebuild does that we DON'T do on Android:
//   - re-embed messages: cloud spend would be punitive; Dexie already
//     has the raw vectors so we reuse them as-is.
//   - rebuild episodes/fragments: those flow through their own pipelines
//     that already write into Dexie + the HNSW save path.
//   - rebuild SQLite: no SQLite on Android.
// =====================================================================

interface RebuildSnapshot {
  jobId: string;
  stage:
    | 'loading_source_history'
    | 'grouping_fragments'
    | 'generating_embeddings'
    | 'writing_sqlite_rows'
    | 'building_indexes'
    | 'finalizing_statistics';
  processed: number;
  total: number;
  startedAt: number;
  elapsedMs: number;
  storedCount: number;
  candidateCount: number;
  filteredCount: number;
  duplicateCount: number;
  groupedCount: number;
  mergedCount: number;
  skippedExistingCount: number;
  clearedCount: number;
  extra: string | null;
  finished: boolean;
  error: string | null;
}

const REBUILD_BATCH_SIZE = 200;

let rebuildSnapshot: RebuildSnapshot = makeIdleSnapshot();
let rebuildPromise: Promise<void> | null = null;

function makeIdleSnapshot(): RebuildSnapshot {
  return {
    jobId: '',
    stage: 'finalizing_statistics',
    processed: 0,
    total: 0,
    startedAt: 0,
    elapsedMs: 0,
    storedCount: 0,
    candidateCount: 0,
    filteredCount: 0,
    duplicateCount: 0,
    groupedCount: 0,
    mergedCount: 0,
    skippedExistingCount: 0,
    clearedCount: 0,
    extra: null,
    finished: true,
    error: null,
  };
}

async function runRebuild(): Promise<void> {
  try {
    rebuildSnapshot.stage = 'building_indexes';
    rebuildSnapshot.extra = 'Resetting HNSW index';

    const initOk = await hnsw.reinitEmpty(Math.max(rebuildSnapshot.total + 1024, 10_000));
    if (!initOk) {
      // 50k cap or WASM load failure — surface a clear error and let the
      // brute-force path keep serving searches.
      rebuildSnapshot.error =
        hnsw.getStatus().lastError || 'HNSW unavailable — brute force fallback in use';
      rebuildSnapshot.stage = 'finalizing_statistics';
      rebuildSnapshot.finished = true;
      return;
    }

    rebuildSnapshot.stage = 'building_indexes';
    rebuildSnapshot.extra = `Rebuilding HNSW (${rebuildSnapshot.total} vectors)`;

    let cursor = 0;
    while (true) {
      const rows = await db.vectors.offset(cursor).limit(REBUILD_BATCH_SIZE).toArray();
      if (rows.length === 0) break;

      const cleaned: Array<{ id: string; vector: Float32Array }> = [];
      for (const row of rows) {
        const vec = ensureFloat32(row.vector);
        if (vec) cleaned.push({ id: row.id, vector: vec });
      }
      const { added, skipped } = hnsw.addBatchFresh(cleaned);
      rebuildSnapshot.storedCount += added;
      rebuildSnapshot.skippedExistingCount += skipped;

      cursor += rows.length;
      rebuildSnapshot.processed = cursor;
      rebuildSnapshot.elapsedMs = Date.now() - rebuildSnapshot.startedAt;

      // Yield so the UI can render progress and any pending tasks (e.g.
      // user typing) get a turn. setTimeout(0) is a real macrotask on
      // Capacitor's WebView so this also lets IndexedDB queues drain.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    rebuildSnapshot.stage = 'finalizing_statistics';
    rebuildSnapshot.extra = 'Persisting HNSW index to IDBFS';
    await hnsw.flush();
    rebuildSnapshot.finished = true;
    rebuildSnapshot.elapsedMs = Date.now() - rebuildSnapshot.startedAt;
    rebuildSnapshot.extra = null;
  } catch (e) {
    rebuildSnapshot.error = e instanceof Error ? e.message : String(e);
    rebuildSnapshot.finished = true;
    rebuildSnapshot.elapsedMs = Date.now() - rebuildSnapshot.startedAt;
    console.error('[androidRag] rebuild loop threw:', e);
  }
}

async function handleRebuildStart(): Promise<{
  success: boolean;
  started: boolean;
  alreadyRunning: boolean;
  snapshot: RebuildSnapshot;
  error?: string;
}> {
  if (rebuildPromise) {
    return {
      success: true,
      started: false,
      alreadyRunning: true,
      snapshot: { ...rebuildSnapshot },
    };
  }

  const total = await db.vectors.count();
  rebuildSnapshot = {
    jobId: `android_rebuild_${Date.now()}`,
    stage: 'loading_source_history',
    processed: 0,
    total,
    startedAt: Date.now(),
    elapsedMs: 0,
    storedCount: 0,
    candidateCount: total,
    filteredCount: 0,
    duplicateCount: 0,
    groupedCount: 0,
    mergedCount: 0,
    skippedExistingCount: 0,
    clearedCount: 0,
    extra: 'Reading vectors from Dexie',
    finished: false,
    error: null,
  };

  rebuildPromise = runRebuild().finally(() => {
    rebuildPromise = null;
  });

  return {
    success: true,
    started: true,
    alreadyRunning: false,
    snapshot: { ...rebuildSnapshot },
  };
}

async function handleRebuildStatus(): Promise<{
  success: boolean;
  running: boolean;
  snapshot: RebuildSnapshot;
}> {
  return {
    success: true,
    running: !!rebuildPromise,
    snapshot: { ...rebuildSnapshot },
  };
}

interface RagDispatchTable {
  [channel: string]: (payload?: any) => Promise<any>;
}

const dispatch: RagDispatchTable = {
  'rag:embed': (payload) => handleEmbed(typeof payload === 'string' ? payload : payload?.text || ''),
  'rag:save': handleSave,
  'rag:search': handleSearch,
  'rag:get-all': handleGetAll,
  'rag:clear-all': handleClearAll,
  'rag:clear-message-vectors': handleClearMessageVectors,
  'rag:stats': handleStats,
  'rag:status': handleStatus,
  'rag:expand-context': handleExpandContext,
  'rag:get-messages': handleGetMessages,
  'rag:sync-messages': handleSyncMessages,
  'rag:rebuild:start': handleRebuildStart,
  'rag:rebuild:status': handleRebuildStatus,
};

/**
 * Single entry point for localRagService's invoker abstraction. Returns a
 * graceful degraded response (instead of throwing) for any channel we
 * haven't ported, so UIs that expect `success: true / false` keep working.
 */
export async function invokeAndroidRag<T = any>(channel: string, payload?: any): Promise<T> {
  const handler = dispatch[channel];
  if (!handler) {
    // Channels we haven't implemented (e.g., rag:rebuild:start, rag:restore).
    // Return success:false so callers gracefully fall back. Logged at warn
    // level so we can see in DevTools which paths still need wiring.
    console.warn(`[androidRag] unimplemented channel: ${channel}`);
    return { success: false, error: `Channel not available on Android: ${channel}` } as unknown as T;
  }
  try {
    return (await handler(payload)) as T;
  } catch (e) {
    console.error(`[androidRag] channel ${channel} threw:`, e);
    return { success: false, error: e instanceof Error ? e.message : 'Unknown error' } as unknown as T;
  }
}
