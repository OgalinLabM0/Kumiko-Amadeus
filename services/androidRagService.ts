// services/androidRagService.ts
//
// v2.14.3 (M.2 / M.3 / M.4 / M.5 / M.6) — RAG service for the Android
// Capacitor APK. Implements the same `rag:*` channel surface that PC's
// electron-rag.cjs exposes (so localRagService's invoker abstraction can
// swap PC ↔ phone without touching consumer-facing API). Backed by:
//
//   - Cloud embeddings via cloudEmbeddingService (5 providers).
//   - **Per-tier HNSW WASM indexes** (androidRagHnswIndex) — `core`,
//     `episodic`, `background` each own a separate hnswlib-wasm graph,
//     mirroring electron-rag.cjs's three-tier topology.
//   - **PC-parity hybrid scoring** (androidRagHybridScore) — BM25 +
//     RRF + boostHybridScore byte-for-byte equal to PC.
//   - **Brute-force fallback** over Dexie's `vectors` table for the cases
//     where HNSW is unavailable: init failure, resize/add failure
//     (including WASM heap exhaustion), dim drift, mid-rebuild, or temporal
//     filter active (PC also brute-forces with filters).
//
// PC behavior: this module is NEVER imported on Electron. The Capacitor
// branch in localRagService.getRagInvoker() short-circuits to here only
// when isCapacitorNative() is true. PC continues to dispatch through
// Electron IPC exactly as before.

import { db, type VectorEntity } from './db';
import { generateCloudEmbedding, getEmbeddingConfig } from './cloudEmbeddingService';
import * as hnsw from './androidRagHnswIndex';
import type { RagTier } from './androidRagHnswIndex';
import {
  tokenize,
  calculateBM25,
  computeRRF,
  boostHybridScore,
  dedupeRetrievedResults,
  getRetrievalDedupeKey,
  type MemoryIntent,
  type RetrievedResult,
} from './androidRagHybridScore';

// =====================================================================
// Channel payload shapes
// =====================================================================

interface RagSearchPayload {
  query: string;
  topK?: number;
  keywords?: string[];
  // v2.14.3 M.3: PC parity — temporal filters use `startTime` / `endTime`
  // (not the v2.14.2 `beforeTimestamp` / `afterTimestamp` typo). The client
  // (`localRagService.searchLocalRagMemoryDetailed`) already sends these
  // names; v2.14.2's mismatch silently turned all temporal filters into
  // no-ops. There is no compat layer — old payloads with `beforeTimestamp`
  // are dropped on the floor (no production users on v2.14.2).
  startTime?: number | null;
  endTime?: number | null;
  role?: string;
  memoryIntent?: MemoryIntent;
}

interface RagSearchResultRow {
  id?: string;
  messageId?: string;
  text: string;
  score: number;
  timestamp: number;
  tier?: RagTier;
  source?: string;
  canonicalKey?: string;
  tags?: string[];
  role?: string;
  vectorScore?: number;
  keywordScore?: number;
  memoryScore?: number;
}

interface RagSearchResponse {
  success: true;
  results: RagSearchResultRow[];
}

interface Filters {
  startTime?: number;
  endTime?: number;
  role?: string;
}

// =====================================================================
// Helpers
// =====================================================================

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
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

function buildFilters(payload: RagSearchPayload): Filters {
  const f: Filters = {};
  if (typeof payload.startTime === 'number' && Number.isFinite(payload.startTime)) {
    f.startTime = payload.startTime;
  }
  if (typeof payload.endTime === 'number' && Number.isFinite(payload.endTime)) {
    f.endTime = payload.endTime;
  }
  if (typeof payload.role === 'string' && payload.role && payload.role !== 'any') {
    f.role = payload.role;
  }
  return f;
}

function hasFilters(filters: Filters): boolean {
  return (
    typeof filters.startTime === 'number' ||
    typeof filters.endTime === 'number' ||
    !!filters.role
  );
}

function rowMatchesFilters(row: VectorEntity, filters: Filters): boolean {
  if (typeof filters.startTime === 'number' && row.timestamp < filters.startTime) return false;
  if (typeof filters.endTime === 'number' && row.timestamp > filters.endTime) return false;
  if (filters.role && row.role && row.role !== filters.role) return false;
  return true;
}

async function loadTierRows(tier: RagTier, filters: Filters): Promise<VectorEntity[]> {
  // v2.14.3 M.2: per-tier scan via Dexie's `tier` index. PC normalizes
  // legacy NULL/'' tiers to `core` in `searchTierVectors`; we mirror that
  // by routing untiered rows to core's scan (untiered + 'core').
  let candidates: VectorEntity[];
  if (tier === 'core') {
    const tierRows = await db.vectors.where('tier').equals('core').toArray();
    const untiered = await db.vectors
      .filter((v) => v.tier !== 'core' && v.tier !== 'episodic' && v.tier !== 'background')
      .toArray();
    candidates = tierRows.concat(untiered);
  } else {
    candidates = await db.vectors.where('tier').equals(tier).toArray();
  }
  if (!hasFilters(filters)) return candidates;
  return candidates.filter((row) => rowMatchesFilters(row, filters));
}

// =====================================================================
// embed / save handlers
// =====================================================================

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
    role,
  } = payload || {};

  if (!text || typeof text !== 'string') {
    return { success: false, error: 'Missing text' };
  }

  let vectorBuf = ensureFloat32(vector);
  if (!vectorBuf) {
    try {
      const result = await generateCloudEmbedding(text);
      vectorBuf = result.vector;
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Embedding failed' };
    }
  }

  const id: string = providedId || `vec_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const ts = typeof timestamp === 'number' ? timestamp : Date.now();
  const normalizedTier = hnsw.normalizeTier(tier);

  const entity: VectorEntity = {
    id,
    text,
    vector: vectorBuf,
    timestamp: ts,
    tier: normalizedTier,
  };
  if (messageId) entity.messageId = messageId;
  if (source) entity.source = source;
  if (typeof score === 'number') entity.score = score;
  if (canonicalKey) entity.canonicalKey = canonicalKey;
  if (Array.isArray(tags)) entity.tags = tags as string[];
  if (typeof role === 'string' && role) entity.role = role;

  try {
    await db.vectors.put(entity);
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Dexie put failed' };
  }
  try {
    await hnsw.add(id, vectorBuf, normalizedTier, ts);
  } catch (e) {
    console.warn(`[androidRag] HNSW add(${id}, tier=${normalizedTier}) raised; brute force will catch this row:`, e);
  }
  return { success: true, id };
}

// =====================================================================
// search — PC parity staged hybrid retrieval (M.2 + M.3 + M.5)
// =====================================================================

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
    role: row.role,
  };
}

async function searchTierVectors(
  queryVec: Float32Array,
  queryTokens: string[],
  tier: RagTier,
  topK: number,
  filters: Filters,
  memoryIntent: MemoryIntent,
): Promise<RagSearchResultRow[]> {
  const hasFilter = hasFilters(filters);
  const hnswK = Math.max(topK * 5, 25);

  // === Pull every candidate row in this tier (with filters applied via JS).
  // Mirrors PC's `getTierSearchRows(normalizedTier, filters)` — Dexie has
  // an index on `tier` so the tier slice is cheap; the timestamp/role
  // narrowing happens in JS like the PC SQL filter.
  const allRows = await loadTierRows(tier, filters);
  if (allRows.length === 0) return [];

  // === Vector retrieval. PC uses HNSW only when there are NO temporal
  // filters (HNSW would return vectors outside the time window without
  // FilterFunction, requiring a brute-force pass anyway). Android matches
  // that policy exactly: HNSW for the unfiltered case, brute-force cosine
  // when any filter is active. M.4's rebuildInProgress gate inside hnsw.search
  // also returns `null` here, falling through to brute-force gracefully.
  let vectorCandidates: Array<{ id: string; score: number }> = [];

  if (!hasFilter) {
    try {
      const hits = await hnsw.search(queryVec, hnswK, tier);
      if (hits && hits.length > 0) {
        vectorCandidates = hits.map((h) => ({ id: h.vectorId, score: h.score }));
      }
    } catch (e) {
      console.warn(`[androidRag] tier=${tier} HNSW search threw, falling back:`, e);
    }
  }

  if (vectorCandidates.length === 0) {
    // Brute-force cosine over the (possibly filtered) candidate rows.
    vectorCandidates = allRows
      .map((row) => {
        const vec = ensureFloat32(row.vector);
        if (!vec) return null;
        return { id: row.id, score: cosineSimilarity(queryVec, vec) };
      })
      .filter((x): x is { id: string; score: number } => !!x)
      .sort((a, b) => b.score - a.score)
      .slice(0, hnswK);
  }

  // === BM25 over the same row set, then RRF fusion. PC parity.
  const docsForBM25 = allRows.map((row) => ({ id: row.id, tokens: tokenize(row.text) }));
  const bm25ScoreMap = calculateBM25(queryTokens, docsForBM25);
  const bm25Results = allRows
    .map((row) => ({ id: row.id, score: bm25ScoreMap.get(row.id) || 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, hnswK);

  const rrfScores = computeRRF(vectorCandidates, bm25Results);
  const candidateIds = new Set<string>([
    ...vectorCandidates.map((c) => c.id),
    ...bm25Results.filter((c) => c.score > 0).map((c) => c.id),
  ]);

  const rowMap = new Map<string, VectorEntity>();
  for (const row of allRows) rowMap.set(row.id, row);

  const vectorScoreMap = new Map(vectorCandidates.map((c) => [c.id, c.score]));
  const keywordScoreMap = new Map(bm25Results.map((c) => [c.id, c.score]));

  const results: RagSearchResultRow[] = [];
  for (const id of candidateIds) {
    const row = rowMap.get(id);
    if (!row) continue;
    const vectorScore = vectorScoreMap.get(id) || 0;
    const keywordScore = keywordScoreMap.get(id) || 0;
    const fusionScore = rrfScores.get(id) || 0;
    const memoryScore = row.score || 0;

    const finalScore = boostHybridScore(
      fusionScore,
      memoryScore,
      tier,
      row.source || 'unknown',
      row.role || 'unknown',
      memoryIntent,
      keywordScore,
    );
    results.push({
      id: row.id,
      messageId: row.messageId,
      text: row.text || '',
      tier,
      source: row.source,
      canonicalKey: row.canonicalKey,
      timestamp: row.timestamp || 0,
      score: finalScore,
      vectorScore,
      keywordScore,
      memoryScore,
      role: row.role,
      tags: row.tags,
    });
  }

  return results
    .sort((a, b) => b.score - a.score)
    .filter((r) => (r.vectorScore || 0) > 0.1 || (r.keywordScore || 0) > 0)
    .slice(0, topK);
}

async function searchByKeywords(
  keywords: string[],
  topK: number,
  filters: Filters,
): Promise<RagSearchResultRow[]> {
  const safeKeywords = keywords
    .map((k) => String(k || '').trim())
    .filter((k) => k.length > 0);
  if (safeKeywords.length === 0) return [];

  // Dexie has no LIKE; full scan is fine at our corpus sizes (4-50k rows).
  // PC limits to LIMIT topK*2 but Android's filter has to read everything
  // in any case (no SQL prepared statement to push down).
  const all = await db.vectors.toArray();
  const matched = all.filter((row) => {
    if (!rowMatchesFilters(row, filters)) return false;
    const text = String(row.text || '');
    return safeKeywords.some((kw) => text.includes(kw));
  });

  matched.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return matched.slice(0, topK * 2).map((row) => ({
    id: row.id,
    text: row.text || '',
    messageId: row.messageId,
    tier: hnsw.normalizeTier(row.tier),
    source: row.source,
    canonicalKey: row.canonicalKey,
    timestamp: row.timestamp || 0,
    // PC: 0.04 + (row.score || 0) * 0.005 — keep verbatim.
    score: 0.04 + (row.score || 0) * 0.005,
    vectorScore: 0,
    keywordScore: 1.0,
    memoryScore: row.score || 0,
    role: row.role,
  }));
}

async function handleSearch(payload: RagSearchPayload): Promise<RagSearchResponse> {
  const { query, topK = 5, keywords = [], memoryIntent = 'default' as MemoryIntent } = payload || ({} as RagSearchPayload);
  if (!query || typeof query !== 'string') {
    return { success: true, results: [] };
  }

  const filters = buildFilters(payload);
  const vectorCount = await db.vectors.count();
  if (vectorCount === 0) return { success: true, results: [] };

  let queryVec: Float32Array;
  try {
    const result = await generateCloudEmbedding(query);
    queryVec = result.vector;
  } catch (e) {
    console.warn('[androidRag] embedding query failed, returning empty results:', e);
    return { success: true, results: [] };
  }

  const baseTokens = tokenize(query);
  const extraTokens = Array.isArray(keywords)
    ? keywords.flatMap((k) => tokenize(String(k || '')))
    : [];
  const queryTokens = Array.from(new Set<string>([...baseTokens, ...extraTokens]));
  const isSemanticRecall = memoryIntent === 'semantic_recall';

  // === Stage 1: core only.
  const coreResults = await searchTierVectors(
    queryVec,
    queryTokens,
    'core',
    topK * 2,
    filters,
    memoryIntent,
  );
  const dedupedCore = dedupeRetrievedResults<RetrievedResult>(coreResults, topK);
  if (!isSemanticRecall && dedupedCore.length >= topK) {
    return { success: true, results: dedupedCore.slice(0, topK).map(asResultRow) };
  }

  // === Stage 2: core + episodic.
  const episodicResults = await searchTierVectors(
    queryVec,
    queryTokens,
    'episodic',
    topK * 2,
    filters,
    memoryIntent,
  );
  const dedupedCoreEp = dedupeRetrievedResults<RetrievedResult>(
    [...dedupedCore, ...episodicResults],
    topK,
  );
  const minimumStablePrimary = topK <= 1 ? 1 : Math.min(topK, 2);
  if (!isSemanticRecall && (dedupedCoreEp.length >= topK || dedupedCoreEp.length >= minimumStablePrimary)) {
    return { success: true, results: dedupedCoreEp.slice(0, topK).map(asResultRow) };
  }

  // === Stage 3: + background (gated by intent + role filter, per PC).
  const canUseBackground = isSemanticRecall || !filters.role;
  const backgroundBudget = canUseBackground
    ? isSemanticRecall
      ? topK
      : Math.max(1, topK - dedupedCoreEp.length)
    : 0;
  const backgroundResults =
    backgroundBudget > 0
      ? await searchTierVectors(
          queryVec,
          queryTokens,
          'background',
          backgroundBudget,
          filters,
          memoryIntent,
        )
      : [];

  const allHybridResults = dedupeRetrievedResults<RetrievedResult>(
    [...dedupedCoreEp, ...backgroundResults],
    topK * 2,
  );

  // === Stage 4: keyword direct hits (semantic_recall + keywords only).
  const safeKeywords = Array.isArray(keywords) ? keywords.filter((k) => String(k || '').trim()) : [];
  let keywordReserved: RagSearchResultRow[] = [];
  if (isSemanticRecall && safeKeywords.length > 0) {
    const keywordDirectHits = await searchByKeywords(safeKeywords, topK, filters);
    if (keywordDirectHits.length > 0) {
      const existingKeys = new Set(allHybridResults.map(getRetrievalDedupeKey));
      const uniqueKeywordHits = keywordDirectHits.filter((r) => {
        const key = getRetrievalDedupeKey(r);
        return !key || !existingKeys.has(key);
      });
      const reserve = Math.min(uniqueKeywordHits.length, Math.ceil(topK / 3));
      keywordReserved = uniqueKeywordHits.slice(0, reserve);
    }
  }

  const hybridSlots = topK - keywordReserved.length;
  const finalResults = [...allHybridResults.slice(0, hybridSlots), ...keywordReserved];
  return { success: true, results: finalResults.map(asResultRow) };
}

function asResultRow(r: RetrievedResult): RagSearchResultRow {
  return {
    id: (r as RagSearchResultRow).id,
    messageId: r.messageId,
    text: r.text || '',
    tier: r.tier as RagTier | undefined,
    source: r.source,
    canonicalKey: r.canonicalKey,
    timestamp: r.timestamp || 0,
    score: r.score || 0,
    vectorScore: r.vectorScore,
    keywordScore: r.keywordScore,
    memoryScore: r.memoryScore,
    role: r.role,
    tags: (r as RagSearchResultRow).tags,
  };
}

// =====================================================================
// Maintenance / introspection handlers
// =====================================================================

async function handleGetAll(): Promise<{ success: boolean; vectors: any[] }> {
  const rows = await db.vectors.toArray();
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
  const matching = await db.vectors.filter((v) => !!v.messageId && ids.includes(v.messageId)).toArray();
  if (matching.length === 0) return { success: true, deleted: 0 };

  const vectorIds = matching.map((v) => v.id);
  const tierMap = new Map<string, RagTier>();
  for (const m of matching) tierMap.set(m.id, hnsw.normalizeTier(m.tier));

  await db.vectors.bulkDelete(vectorIds);
  try {
    await hnsw.markDeletedBatch(vectorIds, tierMap);
  } catch (e) {
    console.warn('[androidRag] hnsw.markDeletedBatch threw:', e);
  }
  return { success: true, deleted: matching.length };
}

async function handleStats(): Promise<{ success: boolean; count: number; totalBytes: number }> {
  const count = await db.vectors.count();
  const totalBytes = count * 2 * 1024;
  return { success: true, count, totalBytes };
}

async function handleStatus(): Promise<{
  enabled: boolean;
  ready: boolean;
  backend: string;
  hnsw?: hnsw.AggregateStatus;
  perTierCounts?: Record<RagTier, number>;
}> {
  const status = hnsw.getStatus();
  const modes = (['core', 'episodic', 'background'] as RagTier[]).map((t) => status.tiers[t].mode);
  const allHnsw = modes.every((m) => m === 'hnsw');
  const anyHnsw = modes.some((m) => m === 'hnsw');
  const backend = allHnsw
    ? 'android-hnsw-wasm-tiered'
    : anyHnsw
      ? 'android-hnsw-wasm-mixed'
      : status.tiers.core.mode === 'bruteforce'
        ? 'android-bruteforce'
        : 'android-uninitialized';

  let perTierCounts: Record<RagTier, number> = { core: 0, episodic: 0, background: 0 };
  try {
    perTierCounts.core = await db.vectors.where('tier').equals('core').count();
    perTierCounts.episodic = await db.vectors.where('tier').equals('episodic').count();
    perTierCounts.background = await db.vectors.where('tier').equals('background').count();
    const untiered = await db.vectors
      .filter((v) => v.tier !== 'core' && v.tier !== 'episodic' && v.tier !== 'background')
      .count();
    perTierCounts.core += untiered;
  } catch (e) {
    console.warn('[androidRag] handleStatus per-tier count failed:', e);
  }

  return { enabled: true, ready: true, backend, hnsw: status, perTierCounts };
}

async function handleExpandContext(payload: any): Promise<{ success: boolean; messages: any[] }> {
  const ts = Number(payload?.timestamp);
  if (!Number.isFinite(ts)) return { success: true, messages: [] };
  const windowMs = 5 * 60 * 1000;
  const messages = await db.messages
    .where('timestamp')
    .between(ts - windowMs, ts + windowMs, true, true)
    .toArray();
  return { success: true, messages };
}

async function handleGetMessages(): Promise<{ success: boolean; messages: any[] }> {
  const messages = await db.messages.toArray();
  return { success: true, messages };
}

async function handleSyncMessages(): Promise<{ success: boolean }> {
  return { success: true };
}

// =====================================================================
// J.5 — RAG rebuild flow (Android)
//
// Drops every tier's HNSW graph and streams Dexie rows back in. Uses the
// existing Dexie vectors as-is — no re-embedding (M.6 handles that as a
// separate flow). M.4's `rebuildInProgress` flag forces searches mid-run
// to fall through to brute force on the current Dexie state.
// =====================================================================

interface RebuildSnapshot {
  jobId: string;
  stage:
    | 'loading_source_history'
    | 'grouping_fragments'
    | 'generating_embeddings'
    | 'writing_sqlite_rows'
    | 'building_indexes'
    | 'finalizing_statistics'
    | 'reembedding';
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
  // M.6 reembed-only fields. Snapshot is shared so the localRagService
  // poller doesn't have to track two state machines.
  apiCallsCount?: number;
  failedCount?: number;
  failedIds?: string[];
  resumed?: boolean;
  reembedKind?: 'rebuild' | 'reembed';
}

const REBUILD_BATCH_SIZE = 200;
const REEMBED_BATCH_SIZE = 50;
const REEMBED_RETRY_MAX = 3;
const REEMBED_RETRY_BACKOFF_MS = 500;
const KEYVAL_REEMBED_CURSOR = 'rag.reembed.cursor';
const KEYVAL_REEMBED_FAILED_IDS = 'rag.reembed.failed.ids';
const KEYVAL_REEMBED_PROVIDER = 'rag.reembed.provider';
const KEYVAL_LAST_EMBEDDING_PROVIDER = 'rag.last.embedding.provider';

let rebuildSnapshot: RebuildSnapshot = makeIdleSnapshot('rebuild');
let rebuildPromise: Promise<void> | null = null;

function makeIdleSnapshot(kind: 'rebuild' | 'reembed' = 'rebuild'): RebuildSnapshot {
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
    apiCallsCount: 0,
    failedCount: 0,
    failedIds: [],
    resumed: false,
    reembedKind: kind,
  };
}

async function runRebuild(): Promise<void> {
  hnsw.setRebuildInProgress(true);
  try {
    rebuildSnapshot.stage = 'building_indexes';
    rebuildSnapshot.extra = 'Resetting HNSW indexes';

    // Per-tier counts so each HNSW graph is sized to its own load.
    const perTierTotals: Record<RagTier, number> = { core: 0, episodic: 0, background: 0 };
    perTierTotals.core = await db.vectors.where('tier').equals('core').count();
    perTierTotals.episodic = await db.vectors.where('tier').equals('episodic').count();
    perTierTotals.background = await db.vectors.where('tier').equals('background').count();
    const untiered = await db.vectors
      .filter((v) => v.tier !== 'core' && v.tier !== 'episodic' && v.tier !== 'background')
      .count();
    perTierTotals.core += untiered;

    const initOk = await hnsw.reinitEmpty(perTierTotals);
    if (!initOk) {
      rebuildSnapshot.error =
        'One or more tiers fell back to brute force — see settings → RAG status for details';
      // Still continue; tiers that DID succeed will get rebuilt.
    }

    rebuildSnapshot.stage = 'building_indexes';
    rebuildSnapshot.extra = `Rebuilding HNSW (${rebuildSnapshot.total} vectors across 3 tiers)`;

    let cursor = 0;
    while (true) {
      const rows = await db.vectors.offset(cursor).limit(REBUILD_BATCH_SIZE).toArray();
      if (rows.length === 0) break;

      const cleaned: Array<{ id: string; vector: Float32Array; tier: RagTier; timestamp: number }> = [];
      for (const row of rows) {
        const vec = ensureFloat32(row.vector);
        if (vec) {
          cleaned.push({
            id: row.id,
            vector: vec,
            tier: hnsw.normalizeTier(row.tier),
            timestamp: row.timestamp,
          });
        }
      }
      const { added, skipped } = hnsw.addBatchFresh(cleaned);
      rebuildSnapshot.storedCount += added;
      rebuildSnapshot.skippedExistingCount += skipped;

      cursor += rows.length;
      rebuildSnapshot.processed = cursor;
      rebuildSnapshot.elapsedMs = Date.now() - rebuildSnapshot.startedAt;

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    rebuildSnapshot.stage = 'finalizing_statistics';
    rebuildSnapshot.extra = 'Persisting HNSW indexes to IDBFS';
    await hnsw.flush();
    rebuildSnapshot.finished = true;
    rebuildSnapshot.elapsedMs = Date.now() - rebuildSnapshot.startedAt;
    rebuildSnapshot.extra = null;
  } catch (e) {
    rebuildSnapshot.error = e instanceof Error ? e.message : String(e);
    rebuildSnapshot.finished = true;
    rebuildSnapshot.elapsedMs = Date.now() - rebuildSnapshot.startedAt;
    console.error('[androidRag] rebuild loop threw:', e);
  } finally {
    hnsw.setRebuildInProgress(false);
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
    ...makeIdleSnapshot('rebuild'),
    jobId: `android_rebuild_${Date.now()}`,
    stage: 'loading_source_history',
    total,
    startedAt: Date.now(),
    candidateCount: total,
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

// =====================================================================
// M.6 — Full re-embedding flow (provider/dimension switch)
//
// Triggered when the user changes embedding provider or target dimension.
// Old vectors are no longer compatible (cosine across mixed dimensions is
// undefined), so every Dexie row's `text` is re-embedded with the new
// provider, the vector field is updated in-place, and HNSW is rebuilt.
//
// Resume contract: cursor is persisted to keyval every batch, so a kill
// (process backgrounded for too long, OOM, network drop) resumes from the
// last persisted offset on next start. Failed rows accumulate in
// `rag.reembed.failed.ids` and skip on resume — the user can retry the
// failed list from the Settings → Data → Embedding card.
// =====================================================================

async function clearReembedState(): Promise<void> {
  await db.setVal(KEYVAL_REEMBED_CURSOR, 0);
  await db.setVal(KEYVAL_REEMBED_FAILED_IDS, []);
}

async function getStoredFailedIds(): Promise<string[]> {
  const raw = await db.getVal<string[]>(KEYVAL_REEMBED_FAILED_IDS, []);
  return Array.isArray(raw) ? raw : [];
}

function providerFingerprint(): string {
  const cfg = getEmbeddingConfig();
  return `${cfg.provider}|${cfg.model}|${cfg.dimensions ?? 0}`;
}

async function runReembed(opts: { fromScratch: boolean }): Promise<void> {
  hnsw.setRebuildInProgress(true);
  try {
    let cursor = await db.getVal<number>(KEYVAL_REEMBED_CURSOR, 0);
    const failedSet = new Set<string>(await getStoredFailedIds());

    if (opts.fromScratch) {
      cursor = 0;
      failedSet.clear();
      // Wipe HNSW + tier dim — actual vectors stay in Dexie so we can
      // rewrite them in place; the HNSW graph is rebuilt as we go.
      await hnsw.clearAll();
      rebuildSnapshot.clearedCount = 1;
    } else {
      rebuildSnapshot.resumed = true;
    }

    const total = await db.vectors.count();
    rebuildSnapshot.total = total;
    rebuildSnapshot.candidateCount = total;
    rebuildSnapshot.processed = cursor;
    rebuildSnapshot.failedCount = failedSet.size;
    rebuildSnapshot.failedIds = Array.from(failedSet);

    const perTierTotals: Record<RagTier, number> = { core: 0, episodic: 0, background: 0 };
    perTierTotals.core = await db.vectors.where('tier').equals('core').count();
    perTierTotals.episodic = await db.vectors.where('tier').equals('episodic').count();
    perTierTotals.background = await db.vectors.where('tier').equals('background').count();
    const untiered = await db.vectors
      .filter((v) => v.tier !== 'core' && v.tier !== 'episodic' && v.tier !== 'background')
      .count();
    perTierTotals.core += untiered;
    if (opts.fromScratch) {
      await hnsw.reinitEmpty(perTierTotals);
    }

    while (true) {
      const rows = await db.vectors.offset(cursor).limit(REEMBED_BATCH_SIZE).toArray();
      if (rows.length === 0) break;

      for (const row of rows) {
        // Skip if this row is in the failed set (user can retry by clearing
        // it via the Settings UI). Also skip empty text.
        if (!row.text || typeof row.text !== 'string') {
          cursor += 1;
          rebuildSnapshot.processed = cursor;
          continue;
        }

        let success = false;
        let lastErr: Error | null = null;
        for (let attempt = 0; attempt < REEMBED_RETRY_MAX; attempt += 1) {
          try {
            const result = await generateCloudEmbedding(row.text);
            rebuildSnapshot.apiCallsCount = (rebuildSnapshot.apiCallsCount || 0) + 1;
            const tier = hnsw.normalizeTier(row.tier);
            const updated: VectorEntity = { ...row, vector: result.vector, tier };
            await db.vectors.put(updated);
            await hnsw.add(row.id, result.vector, tier, row.timestamp);
            success = true;
            failedSet.delete(row.id);
            break;
          } catch (e) {
            lastErr = e instanceof Error ? e : new Error(String(e));
            rebuildSnapshot.error = lastErr.message;
            await new Promise<void>((resolve) =>
              setTimeout(resolve, REEMBED_RETRY_BACKOFF_MS * (attempt + 1)),
            );
          }
        }

        if (!success) {
          rebuildSnapshot.failedCount = (rebuildSnapshot.failedCount || 0) + 1;
          failedSet.add(row.id);
          console.warn(
            `[androidRag] reembed gave up on row ${row.id} after ${REEMBED_RETRY_MAX} attempts: ${lastErr?.message ?? 'unknown'}`,
          );
        }

        cursor += 1;
        rebuildSnapshot.processed = cursor;
      }

      // Persist cursor + failed list every batch so a kill resumes cleanly.
      await db.setVal(KEYVAL_REEMBED_CURSOR, cursor);
      await db.setVal(KEYVAL_REEMBED_FAILED_IDS, Array.from(failedSet));
      rebuildSnapshot.failedIds = Array.from(failedSet);
      rebuildSnapshot.elapsedMs = Date.now() - rebuildSnapshot.startedAt;

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    rebuildSnapshot.stage = 'finalizing_statistics';
    rebuildSnapshot.extra = 'Persisting HNSW indexes to IDBFS';
    await hnsw.flush();
    // Clear cursor on clean finish so the next time we don't think we're
    // resuming. Keep the failed list around — user may want to retry.
    await db.setVal(KEYVAL_REEMBED_CURSOR, 0);
    await db.setVal(KEYVAL_REEMBED_PROVIDER, providerFingerprint());
    await db.setVal(KEYVAL_LAST_EMBEDDING_PROVIDER, providerFingerprint());

    rebuildSnapshot.finished = true;
    rebuildSnapshot.elapsedMs = Date.now() - rebuildSnapshot.startedAt;
    rebuildSnapshot.extra = null;
  } catch (e) {
    rebuildSnapshot.error = e instanceof Error ? e.message : String(e);
    rebuildSnapshot.finished = true;
    rebuildSnapshot.elapsedMs = Date.now() - rebuildSnapshot.startedAt;
    console.error('[androidRag] reembed loop threw:', e);
  } finally {
    hnsw.setRebuildInProgress(false);
  }
}

async function handleReembedStart(payload?: { resume?: boolean }): Promise<{
  success: boolean;
  started: boolean;
  alreadyRunning: boolean;
  snapshot: RebuildSnapshot;
}> {
  if (rebuildPromise) {
    return {
      success: true,
      started: false,
      alreadyRunning: true,
      snapshot: { ...rebuildSnapshot },
    };
  }

  const cursor = await db.getVal<number>(KEYVAL_REEMBED_CURSOR, 0);
  const fromScratch = !payload?.resume || cursor === 0;
  const total = await db.vectors.count();

  rebuildSnapshot = {
    ...makeIdleSnapshot('reembed'),
    jobId: `android_reembed_${Date.now()}`,
    stage: 'reembedding',
    total,
    startedAt: Date.now(),
    candidateCount: total,
    extra: fromScratch
      ? 'Re-embedding all vectors with the new provider'
      : `Resuming re-embedding from offset ${cursor}`,
    finished: false,
    error: null,
    failedIds: await getStoredFailedIds(),
    failedCount: (await getStoredFailedIds()).length,
  };

  rebuildPromise = runReembed({ fromScratch }).finally(() => {
    rebuildPromise = null;
  });

  return {
    success: true,
    started: true,
    alreadyRunning: false,
    snapshot: { ...rebuildSnapshot },
  };
}

async function handleReembedStatus(): Promise<{
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

async function handleReembedReset(): Promise<{ success: boolean }> {
  await clearReembedState();
  return { success: true };
}

/**
 * Polled by the Settings UI on EmbeddingConfigSection mount to detect a
 * pending resume (cursor > 0) so it can offer the user a "continue where
 * you left off" pill. Also surfaces the count of failed ids accumulated
 * across previous attempts.
 */
async function handleReembedInfo(): Promise<{
  success: boolean;
  hasResumable: boolean;
  cursor: number;
  failedCount: number;
  providerFingerprint: string;
  lastFingerprint: string;
}> {
  const cursor = await db.getVal<number>(KEYVAL_REEMBED_CURSOR, 0);
  const failed = await getStoredFailedIds();
  const last = await db.getVal<string>(KEYVAL_LAST_EMBEDDING_PROVIDER, '');
  return {
    success: true,
    hasResumable: cursor > 0,
    cursor,
    failedCount: failed.length,
    providerFingerprint: providerFingerprint(),
    lastFingerprint: last || '',
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
  // M.6 reembed channels
  'rag:reembed:start': handleReembedStart,
  'rag:reembed:status': handleReembedStatus,
  'rag:reembed:reset': handleReembedReset,
  'rag:reembed:info': handleReembedInfo,
};

/**
 * Single entry point for localRagService's invoker abstraction. Returns a
 * graceful degraded response (instead of throwing) for any channel we
 * haven't ported, so UIs that expect `success: true / false` keep working.
 */
export async function invokeAndroidRag<T = any>(channel: string, payload?: any): Promise<T> {
  const handler = dispatch[channel];
  if (!handler) {
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
