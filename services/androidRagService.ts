// services/androidRagService.ts
//
// A5.1 lite: pure-JS brute-force RAG service for the Android Capacitor APK.
// Implements the same `rag:*` channel surface that PC's electron-rag.cjs
// exposes (so localRagService's invoker abstraction can swap PC ↔ phone
// without touching the consumer-facing API), but uses:
//   - Cloud embeddings via cloudEmbeddingService (5 providers).
//   - Brute-force cosine similarity over Dexie's existing `vectors` table
//     (same schema PC writes to during backup restore — see VectorEntity).
//
// Why brute force instead of sqlite-vec right now?
//   - Typical Kumiko users have 4 000-12 000 vectors after a year of use.
//     At 768 dimensions that's ~7 M multiplications per query, ~50-100 ms
//     on modern phones (Snapdragon 8 Gen 1 / A15+). Imperceptible compared
//     to the 200-800 ms cloud embedding round-trip the search already pays.
//   - A5.1.2 (sqlite-vec NDK cross-compile + jniLibs.so) is a separate
//     research-heavy item. The plan explicitly says brute-force is the
//     documented fallback — we ship the fallback first so Android RAG
//     works end-to-end, then swap in sqlite-vec when the .so build lands.
//
// Channels implemented (everything else returns a graceful degraded result
// and a console.warn for visibility):
//   - rag:embed              → cloudEmbedding round-trip
//   - rag:save               → upsert into db.vectors
//   - rag:search             → cosine similarity over db.vectors, returns
//                              top-K with the same `results: [{ id, text,
//                              score, ... }]` shape PC returns.
//   - rag:get-all            → dump db.vectors (used by export)
//   - rag:clear-all          → wipe db.vectors
//   - rag:clear-message-vectors / rag:delete (by id)
//   - rag:stats              → count + total vector bytes
//   - rag:status             → always { enabled: true } on Android
//   - rag:expand-context     → simple ±N message lookup from db.messages
//                              by timestamp (no SQLite quote-context needed)
//   - rag:get-messages       → degraded {success:true, messages: []} since
//                              the message store IS Dexie on phone
//   - rag:sync-messages      → no-op success (Dexie is the source of truth)
//
// Channels NOT implemented (return degraded but non-throwing payloads so
// the UI doesn't crash; see comments below):
//   - rag:restore            → would re-embed every chunk, expensive cloud
//                              spend; deferred until rebuild UX is wired
//   - rag:rebuild:start /:status → same reason; UI shows "rebuild
//                              unavailable on this device" via the WS
//                              fallback in localRagService.
//
// PC behavior: this module is NEVER imported on Electron. The Capacitor
// branch in localRagService.getRagInvoker() short-circuits to here only
// when isCapacitorNative() is true. PC and PWA continue to dispatch
// through Electron IPC / Fastify HTTP exactly as before.

import { db, type VectorEntity } from './db';
import { generateCloudEmbedding } from './cloudEmbeddingService';

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
    return { success: true, id };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Dexie put failed' };
  }
}

async function handleSearch(payload: RagSearchPayload): Promise<RagSearchResponse> {
  const { query, topK = 15, beforeTimestamp, afterTimestamp } = payload || ({} as RagSearchPayload);
  if (!query || typeof query !== 'string') {
    return { success: true, results: [] };
  }

  // 1) Embed the query via cloud.
  let queryVec: Float32Array;
  try {
    const result = await generateCloudEmbedding(query);
    queryVec = result.vector;
  } catch (e) {
    console.warn('[androidRag] embedding query failed, returning empty results:', e);
    return { success: true, results: [] };
  }

  // 2) Pull candidate vectors from Dexie.
  // Cap at 50 000 rows so the in-memory work stays bounded; users with more
  // than that have bigger problems than search latency anyway.
  const all = await db.vectors.limit(50_000).toArray();

  // 3) Apply temporal filters first (cheap), then score.
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

  const top = scored.slice(0, Math.max(1, topK));
  return {
    success: true,
    results: top.map(({ row, score }) => ({
      id: row.id,
      messageId: row.messageId,
      text: row.text,
      score,
      timestamp: row.timestamp,
      tier: row.tier,
      source: row.source,
      canonicalKey: row.canonicalKey,
      tags: row.tags,
    })),
  };
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
  return { success: true };
}

async function handleClearMessageVectors(payload: any): Promise<{ success: boolean; deleted?: number }> {
  const ids: string[] = Array.isArray(payload?.messageIds) ? payload.messageIds : [];
  if (ids.length === 0) return { success: true, deleted: 0 };
  // Dexie compound `where` — `messageId` is not indexed but the table is
  // small enough for a full scan to be fine on phones.
  const matching = await db.vectors.filter((v) => !!v.messageId && ids.includes(v.messageId)).toArray();
  await db.vectors.bulkDelete(matching.map((v) => v.id));
  return { success: true, deleted: matching.length };
}

async function handleStats(): Promise<{ success: boolean; count: number; totalBytes: number }> {
  const count = await db.vectors.count();
  // Cheap byte estimate: assume average 2 KB per vector (768d × 4 bytes
  // + overhead). Used by the Settings panel "vector store size" surface.
  const totalBytes = count * 2 * 1024;
  return { success: true, count, totalBytes };
}

async function handleStatus(): Promise<{ enabled: boolean; ready: boolean; backend: string }> {
  return { enabled: true, ready: true, backend: 'android-bruteforce' };
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
