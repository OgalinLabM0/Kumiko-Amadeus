// services/androidRagHnswIndex.ts
//
// v2.14.2 J.3 — HNSW WASM index for the Android Capacitor APK.
//
// Why this exists:
//   v2.14.1 shipped an Android RAG path that scored every Dexie row in JS
//   with a hand-rolled cosine kernel (services/androidRagService.ts handle-
//   Search). That's fine at 4-12k vectors (~50-100 ms / query), but degrades
//   linearly and the user-facing search latency budget is ~150-300 ms total
//   (the cloud embedding round-trip eats most of it). HNSW gives us O(log N)
//   approximate search with a single C++ implementation — same algorithm as
//   PC's hnswlib-node, same upstream nmslib/hnswlib library, just via the
//   WebAssembly port (`hnswlib-wasm`).
//
// Failure model (every entry point falls back to brute force gracefully):
//   - HNSW init throws  → mode = 'bruteforce', WARN log, callers stay happy
//   - HNSW load throws  → drop file, treat as needsRebuild, fall back
//   - HNSW search throws → fall back per-call, do NOT poison the module
//   - Vector count > HNSW_MAX_ELEMENTS → mode = 'bruteforce' on init
//   - Embedding dim drifted (provider switch) → drop file, needsRebuild,
//     fall back this call
//
// Persistence:
//   - Index file lives in Emscripten IDBFS at IDBFS_INDEX_FILENAME.
//   - label↔vectorId map persisted via Dexie keyval rows
//     (rag.hnsw.idMap / rag.hnsw.dim / rag.hnsw.savedAt).
//   - flush() debounces writeIndex + syncFs(false) so we don't pay full
//     persistence cost on every add — instead batch every FLUSH_DEBOUNCE_MS.
//
// PC behavior:
//   This module is NEVER imported on Electron. The androidRagService side
//   imports it dynamically; localRagService.getRagInvoker() routes Electron
//   to ipcRenderer.invoke('rag:*') and Capacitor to invokeAndroidRag(),
//   which is the only thing that touches this file.

import { db } from './db';
import { getEmbeddingConfig } from './cloudEmbeddingService';

// Lazy-loaded; never imported synchronously to keep the brute-force fallback
// path 100% functional even when hnswlib-wasm fails to load on a given device.
type HnswModule = {
  HierarchicalNSW: new (
    spaceName: 'l2' | 'ip' | 'cosine',
    numDimensions: number,
    autoSaveFilename: string,
  ) => HnswIndexInstance;
  EmscriptenFileSystemManager: {
    checkFileExists(filename: string): boolean;
    setDebugLogs(enable: boolean): void;
  };
};

type HnswIndexInstance = {
  initIndex(maxElements: number, m: number, efConstruction: number, randomSeed: number): void;
  isIndexInitialized(): boolean;
  readIndex(filename: string, maxElements: number): Promise<boolean>;
  writeIndex(filename: string): Promise<boolean>;
  resizeIndex(newMaxElements: number): void;
  addPoint(point: Float32Array | number[], label: number, replaceDeleted: boolean): void;
  addItems(items: Float32Array[] | number[][], replaceDeleted: boolean): number[];
  markDelete(label: number): void;
  markDeleteItems(labels: number[]): void;
  unmarkDelete(label: number): void;
  searchKnn(
    queryPoint: Float32Array | number[],
    numNeighbors: number,
    filter: ((label: number) => boolean) | undefined,
  ): { distances: number[]; neighbors: number[] };
  getCurrentCount(): number;
  getMaxElements(): number;
  getNumDimensions(): number;
  setEfSearch(ef: number): void;
};

type IndexMode = 'hnsw' | 'bruteforce' | 'uninitialized';

interface HnswStatus {
  mode: IndexMode;
  count: number;
  dim: number | null;
  capacity: number;
  needsRebuild: boolean;
  deletedRatio: number;
  lastError?: string;
}

const IDBFS_INDEX_FILENAME = 'kumiko-rag.hnsw';
const KEYVAL_DIM_KEY = 'rag.hnsw.dim';
const KEYVAL_IDMAP_KEY = 'rag.hnsw.idMap';
const KEYVAL_SAVED_AT_KEY = 'rag.hnsw.savedAt';
const HNSW_MAX_ELEMENTS = 50_000;
const HNSW_M = 32;
const HNSW_EF_CONSTRUCTION = 200;
const HNSW_EF_SEARCH = 64;
const HNSW_MIN_CAPACITY = 10_000;
const HNSW_DELETED_RATIO_THRESHOLD = 0.3;
const FLUSH_DEBOUNCE_MS = 5_000;

let mode: IndexMode = 'uninitialized';
let lib: HnswModule | null = null;
let index: HnswIndexInstance | null = null;
let dim: number | null = null;
let needsRebuild = false;
let lastError: string | undefined;
let deletedCount = 0;
let initPromise: Promise<void> | null = null;

let labelToVectorId = new Map<number, string>();
let vectorIdToLabel = new Map<string, number>();
let nextLabel = 0;

let flushHandle: ReturnType<typeof setTimeout> | null = null;
let flushDirty = false;

function setBrute(reason: string, error?: unknown): void {
  mode = 'bruteforce';
  lastError = error instanceof Error ? `${reason}: ${error.message}` : reason;
  console.warn(`[androidRagHnsw] falling back to brute force — ${lastError}`);
}

function clearMaps(): void {
  labelToVectorId = new Map();
  vectorIdToLabel = new Map();
  nextLabel = 0;
  deletedCount = 0;
}

async function loadModule(): Promise<HnswModule | null> {
  if (lib) return lib;
  try {
    const mod = (await import('hnswlib-wasm')) as unknown as {
      loadHnswlib: () => Promise<HnswModule>;
    };
    lib = await mod.loadHnswlib();
    try {
      lib.EmscriptenFileSystemManager.setDebugLogs(false);
    } catch {
      // Older builds may not expose this — non-fatal.
    }
    return lib;
  } catch (e) {
    setBrute('hnswlib-wasm load failed', e);
    return null;
  }
}

async function syncFsRead(): Promise<void> {
  const mod = await import('hnswlib-wasm');
  const sync = (mod as unknown as { syncFileSystem: (a: 'read' | 'write') => Promise<void> }).syncFileSystem;
  await sync('read');
}

async function syncFsWrite(): Promise<void> {
  const mod = await import('hnswlib-wasm');
  const sync = (mod as unknown as { syncFileSystem: (a: 'read' | 'write') => Promise<void> }).syncFileSystem;
  await sync('write');
}

async function loadIdMapFromKeyval(): Promise<void> {
  try {
    const raw = await db.getVal<{ entries?: Array<[number, string]>; nextLabel?: number } | null>(
      KEYVAL_IDMAP_KEY,
      null,
    );
    if (raw && Array.isArray(raw.entries)) {
      labelToVectorId = new Map(raw.entries);
      vectorIdToLabel = new Map(raw.entries.map(([label, id]) => [id, label]));
      nextLabel = typeof raw.nextLabel === 'number' ? raw.nextLabel : labelToVectorId.size;
    } else {
      clearMaps();
    }
  } catch (e) {
    console.warn('[androidRagHnsw] failed to load idMap from keyval, starting fresh:', e);
    clearMaps();
  }
}

function scheduleFlush(): void {
  flushDirty = true;
  if (flushHandle) clearTimeout(flushHandle);
  flushHandle = setTimeout(() => {
    flushHandle = null;
    void flush().catch((e) => console.warn('[androidRagHnsw] flush failed:', e));
  }, FLUSH_DEBOUNCE_MS);
}

async function persistIdMap(): Promise<void> {
  try {
    await db.setVal(KEYVAL_IDMAP_KEY, {
      entries: Array.from(labelToVectorId.entries()),
      nextLabel,
    });
  } catch (e) {
    console.warn('[androidRagHnsw] persistIdMap failed:', e);
  }
}

async function dropIndexFile(): Promise<void> {
  try {
    const mod = await import('hnswlib-wasm');
    const factoryLib = (mod as unknown as { loadHnswlib: () => Promise<HnswModule> });
    const liveLib = lib || (await factoryLib.loadHnswlib());
    if (liveLib?.EmscriptenFileSystemManager?.checkFileExists?.(IDBFS_INDEX_FILENAME)) {
      // Emscripten doesn't expose a direct unlink API in the typed surface;
      // we rely on overwriting on next writeIndex. Mark needsRebuild to make
      // sure we don't readIndex the stale file.
      needsRebuild = true;
    }
    await syncFsWrite();
  } catch (e) {
    console.warn('[androidRagHnsw] dropIndexFile encountered:', e);
  }
}

async function ensureInit(): Promise<void> {
  if (mode === 'hnsw' || mode === 'bruteforce') return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const targetDim = getEmbeddingConfig().dimensions;
    const cnt = await db.vectors.count();

    if (cnt > HNSW_MAX_ELEMENTS) {
      setBrute(`vector count ${cnt} exceeds HNSW cap ${HNSW_MAX_ELEMENTS}`);
      return;
    }

    const hnswMod = await loadModule();
    if (!hnswMod) return;

    try {
      await syncFsRead();
    } catch (e) {
      console.warn('[androidRagHnsw] IDBFS read sync failed (non-fatal):', e);
    }

    const persistedDim = await db.getVal<number | null>(KEYVAL_DIM_KEY, null);
    const dimMismatch = typeof persistedDim === 'number' && persistedDim !== targetDim;
    if (dimMismatch) {
      console.warn(
        `[androidRagHnsw] dim drift detected (persisted=${persistedDim} target=${targetDim}); marking rebuild`,
      );
      needsRebuild = true;
      clearMaps();
    } else {
      await loadIdMapFromKeyval();
    }

    let inst: HnswIndexInstance;
    try {
      inst = new hnswMod.HierarchicalNSW('cosine', targetDim, '');
    } catch (e) {
      setBrute('HierarchicalNSW constructor threw', e);
      return;
    }

    const fileExists = (() => {
      try {
        return hnswMod.EmscriptenFileSystemManager.checkFileExists(IDBFS_INDEX_FILENAME);
      } catch {
        return false;
      }
    })();

    if (fileExists && !dimMismatch && !needsRebuild) {
      try {
        const capacity = Math.max(HNSW_MIN_CAPACITY, cnt * 2);
        await inst.readIndex(IDBFS_INDEX_FILENAME, capacity);
        inst.setEfSearch(HNSW_EF_SEARCH);
        index = inst;
        dim = targetDim;
        mode = 'hnsw';
        return;
      } catch (e) {
        console.warn('[androidRagHnsw] readIndex failed, will rebuild empty:', e);
        needsRebuild = true;
        clearMaps();
      }
    }

    try {
      const capacity = Math.max(HNSW_MIN_CAPACITY, cnt * 2);
      inst.initIndex(capacity, HNSW_M, HNSW_EF_CONSTRUCTION, 100);
      inst.setEfSearch(HNSW_EF_SEARCH);
      index = inst;
      dim = targetDim;
      mode = 'hnsw';
      await db.setVal(KEYVAL_DIM_KEY, targetDim);
    } catch (e) {
      setBrute('initIndex failed', e);
    }
  })();
  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

function ensureCapacityFor(extra: number): boolean {
  if (!index) return false;
  const used = index.getCurrentCount();
  const cap = index.getMaxElements();
  if (used + extra <= cap) return true;
  try {
    const newCap = Math.max(cap * 2, used + extra + HNSW_MIN_CAPACITY);
    if (newCap > HNSW_MAX_ELEMENTS) {
      setBrute(`would exceed HNSW cap ${HNSW_MAX_ELEMENTS}`);
      return false;
    }
    index.resizeIndex(newCap);
    return true;
  } catch (e) {
    setBrute('resizeIndex failed', e);
    return false;
  }
}

export async function add(vectorId: string, vector: Float32Array): Promise<boolean> {
  await ensureInit();
  if (mode !== 'hnsw' || !index) return false;
  if (dim !== null && vector.length !== dim) {
    console.warn(
      `[androidRagHnsw] add(${vectorId}) dim mismatch (vector=${vector.length} index=${dim}); skipping HNSW`,
    );
    needsRebuild = true;
    return false;
  }
  if (vectorIdToLabel.has(vectorId)) {
    // Same id resaved — mark old label deleted, then insert fresh so the
    // search graph reflects the new vector.
    const oldLabel = vectorIdToLabel.get(vectorId)!;
    try {
      index.markDelete(oldLabel);
      labelToVectorId.delete(oldLabel);
      vectorIdToLabel.delete(vectorId);
      deletedCount += 1;
    } catch (e) {
      console.warn(`[androidRagHnsw] markDelete(${oldLabel}) for resave failed:`, e);
    }
  }
  if (!ensureCapacityFor(1)) return false;
  try {
    const label = nextLabel++;
    index.addPoint(vector, label, true);
    labelToVectorId.set(label, vectorId);
    vectorIdToLabel.set(vectorId, label);
    scheduleFlush();
    return true;
  } catch (e) {
    setBrute(`addPoint(${vectorId}) failed`, e);
    return false;
  }
}

export async function search(
  query: Float32Array,
  k: number,
): Promise<Array<{ vectorId: string; score: number }> | null> {
  await ensureInit();
  if (mode !== 'hnsw' || !index) return null;
  if (dim !== null && query.length !== dim) {
    console.warn(
      `[androidRagHnsw] search dim mismatch (query=${query.length} index=${dim}); skipping HNSW`,
    );
    needsRebuild = true;
    return null;
  }
  try {
    const want = Math.max(1, k);
    const result = index.searchKnn(query, want, undefined);
    const out: Array<{ vectorId: string; score: number }> = [];
    for (let i = 0; i < result.neighbors.length; i += 1) {
      const label = result.neighbors[i];
      const vectorId = labelToVectorId.get(label);
      if (!vectorId) continue;
      // hnswlib cosine returns distance = 1 - cos(a,b); convert back to a
      // similarity score so scoring stays consistent with the brute-force
      // cosine path elsewhere in the codebase.
      const score = 1 - result.distances[i];
      out.push({ vectorId, score });
    }
    return out;
  } catch (e) {
    console.warn('[androidRagHnsw] searchKnn failed, caller should fall back:', e);
    return null;
  }
}

export async function markDeleted(vectorId: string): Promise<void> {
  await ensureInit();
  if (mode !== 'hnsw' || !index) return;
  const label = vectorIdToLabel.get(vectorId);
  if (label === undefined) return;
  try {
    index.markDelete(label);
    labelToVectorId.delete(label);
    vectorIdToLabel.delete(vectorId);
    deletedCount += 1;
    scheduleFlush();
    if (deletedRatio() > HNSW_DELETED_RATIO_THRESHOLD) needsRebuild = true;
  } catch (e) {
    console.warn(`[androidRagHnsw] markDeleted(${vectorId}) failed:`, e);
  }
}

export async function markDeletedBatch(vectorIds: string[]): Promise<void> {
  await ensureInit();
  if (mode !== 'hnsw' || !index) return;
  const labels: number[] = [];
  for (const id of vectorIds) {
    const label = vectorIdToLabel.get(id);
    if (label === undefined) continue;
    labels.push(label);
    labelToVectorId.delete(label);
    vectorIdToLabel.delete(id);
  }
  if (labels.length === 0) return;
  try {
    index.markDeleteItems(labels);
    deletedCount += labels.length;
    scheduleFlush();
    if (deletedRatio() > HNSW_DELETED_RATIO_THRESHOLD) needsRebuild = true;
  } catch (e) {
    console.warn(`[androidRagHnsw] markDeleteItems(${labels.length}) failed:`, e);
  }
}

export async function clearAll(): Promise<void> {
  if (flushHandle) {
    clearTimeout(flushHandle);
    flushHandle = null;
  }
  flushDirty = false;
  index = null;
  mode = 'uninitialized';
  dim = null;
  needsRebuild = false;
  lastError = undefined;
  clearMaps();
  try {
    await db.setVal(KEYVAL_IDMAP_KEY, null);
    await db.setVal(KEYVAL_DIM_KEY, null);
    await db.setVal(KEYVAL_SAVED_AT_KEY, null);
  } catch (e) {
    console.warn('[androidRagHnsw] keyval clear failed:', e);
  }
  await dropIndexFile();
}

export async function flush(): Promise<void> {
  if (mode !== 'hnsw' || !index) return;
  if (!flushDirty) return;
  flushDirty = false;
  try {
    await index.writeIndex(IDBFS_INDEX_FILENAME);
    await syncFsWrite();
    await persistIdMap();
    await db.setVal(KEYVAL_SAVED_AT_KEY, Date.now());
  } catch (e) {
    console.warn('[androidRagHnsw] flush writeIndex/syncFs failed:', e);
  }
}

function deletedRatio(): number {
  if (!index) return 0;
  const live = index.getCurrentCount();
  if (live === 0) return 0;
  return deletedCount / (live + deletedCount);
}

export function getStatus(): HnswStatus {
  return {
    mode,
    count: index ? index.getCurrentCount() : 0,
    dim,
    capacity: index ? index.getMaxElements() : 0,
    needsRebuild,
    deletedRatio: deletedRatio(),
    lastError,
  };
}

/**
 * Hard reset used by handleRebuildStart — drops everything and re-inits the
 * index empty so the rebuild loop can stream Dexie rows back in.
 */
export async function reinitEmpty(targetCapacity: number): Promise<boolean> {
  if (flushHandle) {
    clearTimeout(flushHandle);
    flushHandle = null;
  }
  flushDirty = false;
  index = null;
  mode = 'uninitialized';
  needsRebuild = false;
  clearMaps();

  const targetDim = getEmbeddingConfig().dimensions;
  if (targetCapacity > HNSW_MAX_ELEMENTS) {
    setBrute(`rebuild target ${targetCapacity} exceeds HNSW cap ${HNSW_MAX_ELEMENTS}`);
    return false;
  }

  const hnswMod = await loadModule();
  if (!hnswMod) return false;

  try {
    const inst = new hnswMod.HierarchicalNSW('cosine', targetDim, '');
    inst.initIndex(Math.max(HNSW_MIN_CAPACITY, targetCapacity), HNSW_M, HNSW_EF_CONSTRUCTION, 100);
    inst.setEfSearch(HNSW_EF_SEARCH);
    index = inst;
    dim = targetDim;
    mode = 'hnsw';
    await db.setVal(KEYVAL_DIM_KEY, targetDim);
    return true;
  } catch (e) {
    setBrute('reinitEmpty initIndex failed', e);
    return false;
  }
}

/**
 * Bulk path used by the rebuild loop. Skips the per-vector resave-delete
 * fast path since the index is guaranteed empty here.
 */
export function addBatchFresh(
  rows: Array<{ id: string; vector: Float32Array }>,
): { added: number; skipped: number } {
  if (mode !== 'hnsw' || !index) return { added: 0, skipped: rows.length };
  if (!ensureCapacityFor(rows.length)) return { added: 0, skipped: rows.length };

  let added = 0;
  let skipped = 0;
  for (const row of rows) {
    if (dim !== null && row.vector.length !== dim) {
      skipped += 1;
      continue;
    }
    try {
      const label = nextLabel++;
      index.addPoint(row.vector, label, false);
      labelToVectorId.set(label, row.id);
      vectorIdToLabel.set(row.id, label);
      added += 1;
    } catch {
      skipped += 1;
    }
  }
  if (added > 0) flushDirty = true;
  return { added, skipped };
}

/**
 * For tests / diagnostics — never imported by production callers.
 */
export function _resetForTests(): void {
  if (flushHandle) clearTimeout(flushHandle);
  flushHandle = null;
  flushDirty = false;
  index = null;
  lib = null;
  mode = 'uninitialized';
  dim = null;
  needsRebuild = false;
  lastError = undefined;
  initPromise = null;
  clearMaps();
}
