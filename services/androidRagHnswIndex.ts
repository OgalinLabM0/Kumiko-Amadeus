// services/androidRagHnswIndex.ts
//
// v2.14.3 M.1 / M.3 / M.4 — Tier-sharded HNSW WASM index for the Android
// Capacitor APK. Replaces v2.14.2's single-graph implementation so Android
// matches PC's electron-rag.cjs three-tier topology byte-for-byte:
//
//   - core        — turn pairs, memory chunks, anchor highlights (signal)
//   - episodic    — per-window summaries, episode boundaries
//   - background  — wide-net periphery (lower priority, max-budget noise)
//
// Each tier owns its own HNSW graph, IDBFS file, idMap blob, and label
// space. Search is per-tier (callers stage core → episodic → background
// at the service layer). Capacity follows the PC path: start from the
// current per-tier count and expand with resizeIndex on demand. Brute
// force is only the real fallback when HNSW itself cannot load/init/resize.
//
// M.3 — `labelToTimestamp` is persisted alongside `labelToVectorId` so the
// service layer can pass a `FilterFunction` to `searchKnn` for true
// pre-filtering by `startTime` / `endTime` (instead of post-filter on
// topK*2 results which silently truncates when the time window is tight).
//
// M.4 — `rebuildInProgress` short-circuits `search()` to `null`. The
// service layer routes that to brute-force so users searching mid-rebuild
// don't hit a half-populated graph. The rebuild loop itself uses
// `addBatchFresh` which bypasses the gate (it has to write).
//
// Failure model (per tier — one tier degrading does not poison the others):
//   - HNSW init throws       → tier.mode = 'bruteforce', service falls back
//   - HNSW load throws       → mark needsRebuild, fall back this call
//   - HNSW resize/add throws → tier.mode = 'bruteforce', service falls back
//   - HNSW search throws     → return null, service falls back per-call
//   - Embedding dim drift    → mark needsRebuild on first detect, fall back
//
// Persistence layout:
//   IDBFS file:    kumiko-rag-{tier}.hnsw                     (per tier)
//   keyval blob:   rag.hnsw.idMap.{tier}                       (per tier)
//                  → { entries: [[label, vectorId, timestamp], …], nextLabel }
//   keyval shared: rag.hnsw.dim                                (any tier writes
//                                                                 same value;
//                                                                 dim drift is
//                                                                 a global event)
//                  rag.hnsw.savedAt                            (last flush ms)
//
// PC behavior: this module is NEVER imported on Electron. The Android
// service layer (`services/androidRagService.ts`) imports it dynamically;
// `localRagService.getRagInvoker()` routes Electron to ipcRenderer.invoke()
// and Capacitor to invokeAndroidRag(), which is the only thing that touches
// this file. Zero impact on PC's electron-rag.cjs.
//
// **No backward compatibility:** v2.14.3 is a clean break from v2.14.2's
// single-graph layout. Old `kumiko-rag.hnsw` / `rag.hnsw.idMap` artifacts
// in IDBFS / keyval are NOT read or migrated; treat any leftovers as if
// they were never there. Rationale: zero current users, zero install base
// to protect.

import { db } from './db';
import { getEmbeddingConfig } from './cloudEmbeddingService';

// =====================================================================
// Tier definitions — mirror electron-rag.cjs RAG_TIER_* constants.
// =====================================================================

export type RagTier = 'core' | 'episodic' | 'background';

const TIERS: readonly RagTier[] = ['core', 'episodic', 'background'] as const;

export function normalizeTier(tier: unknown): RagTier {
  if (tier === 'episodic') return 'episodic';
  if (tier === 'background') return 'background';
  return 'core';
}

// =====================================================================
// hnswlib-wasm dynamic typing — kept identical to v2.14.2 J.3 so we
// don't pin to a stricter shape than upstream actually exports.
// =====================================================================

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

type FilterFunction = (label: number) => boolean;

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
    filter: FilterFunction | undefined,
  ): { distances: number[]; neighbors: number[] };
  getCurrentCount(): number;
  getMaxElements(): number;
  getNumDimensions(): number;
  setEfSearch(ef: number): void;
};

type IndexMode = 'hnsw' | 'bruteforce' | 'uninitialized';

interface TierIndexState {
  tier: RagTier;
  mode: IndexMode;
  index: HnswIndexInstance | null;
  dim: number | null;
  labelToVectorId: Map<number, string>;
  vectorIdToLabel: Map<string, number>;
  labelToTimestamp: Map<number, number>;
  nextLabel: number;
  needsRebuild: boolean;
  deletedCount: number;
  lastError?: string;
  flushDirty: boolean;
  initialized: boolean;
}

export interface TierStatus {
  tier: RagTier;
  mode: IndexMode;
  count: number;
  dim: number | null;
  capacity: number;
  needsRebuild: boolean;
  deletedRatio: number;
  lastError?: string;
}

export interface AggregateStatus {
  tiers: Record<RagTier, TierStatus>;
  rebuildInProgress: boolean;
}

const KEYVAL_DIM_KEY = 'rag.hnsw.dim';
const KEYVAL_SAVED_AT_KEY = 'rag.hnsw.savedAt';
const HNSW_M = 32;
const HNSW_EF_CONSTRUCTION = 200;
const HNSW_EF_SEARCH = 64;
const HNSW_MIN_CAPACITY = 1_000;
const HNSW_DELETED_RATIO_THRESHOLD = 0.3;
const FLUSH_DEBOUNCE_MS = 5_000;

const idbfsFilename = (tier: RagTier): string => `kumiko-rag-${tier}.hnsw`;
const idMapKey = (tier: RagTier): string => `rag.hnsw.idMap.${tier}`;

function makeTierState(tier: RagTier): TierIndexState {
  return {
    tier,
    mode: 'uninitialized',
    index: null,
    dim: null,
    labelToVectorId: new Map(),
    vectorIdToLabel: new Map(),
    labelToTimestamp: new Map(),
    nextLabel: 0,
    needsRebuild: false,
    deletedCount: 0,
    lastError: undefined,
    flushDirty: false,
    initialized: false,
  };
}

const tiers: Record<RagTier, TierIndexState> = {
  core: makeTierState('core'),
  episodic: makeTierState('episodic'),
  background: makeTierState('background'),
};

let lib: HnswModule | null = null;
let initPromise: Promise<void> | null = null;
let rebuildInProgress = false;
let flushHandle: ReturnType<typeof setTimeout> | null = null;
let initialFsRead = false;

// =====================================================================
// Diagnostics + small helpers
// =====================================================================

function setTierBrute(state: TierIndexState, reason: string, error?: unknown): void {
  state.mode = 'bruteforce';
  state.lastError = error instanceof Error ? `${reason}: ${error.message}` : reason;
  console.warn(`[androidRagHnsw] tier=${state.tier} → brute force: ${state.lastError}`);
}

function clearTierMaps(state: TierIndexState): void {
  state.labelToVectorId = new Map();
  state.vectorIdToLabel = new Map();
  state.labelToTimestamp = new Map();
  state.nextLabel = 0;
  state.deletedCount = 0;
}

function tierDeletedRatio(state: TierIndexState): number {
  if (!state.index) return 0;
  const live = state.index.getCurrentCount();
  if (live === 0) return 0;
  return state.deletedCount / (live + state.deletedCount);
}

// =====================================================================
// hnswlib-wasm module / IDBFS sync — shared across all tiers
// =====================================================================

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
      /* older hnswlib-wasm builds don't expose setDebugLogs — non-fatal */
    }
    return lib;
  } catch (e) {
    for (const t of TIERS) setTierBrute(tiers[t], 'hnswlib-wasm load failed', e);
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

// =====================================================================
// Per-tier idMap + timestamp persistence
// =====================================================================

interface IdMapEntry {
  label: number;
  vectorId: string;
  timestamp: number;
}

interface IdMapBlob {
  // v2.14.3 layout: triples [label, vectorId, timestamp]. timestamp can be 0
  // for legacy or unknown — service layer will tolerate that and skip the
  // pre-filter when it sees ts === 0.
  entries?: Array<[number, string, number]>;
  nextLabel?: number;
}

async function loadTierIdMap(state: TierIndexState): Promise<void> {
  try {
    const raw = await db.getVal<IdMapBlob | null>(idMapKey(state.tier), null);
    if (raw && Array.isArray(raw.entries)) {
      state.labelToVectorId = new Map();
      state.vectorIdToLabel = new Map();
      state.labelToTimestamp = new Map();
      let maxLabel = -1;
      for (const triple of raw.entries) {
        if (!Array.isArray(triple) || triple.length < 2) continue;
        const label = typeof triple[0] === 'number' ? triple[0] : Number(triple[0]);
        const vectorId = typeof triple[1] === 'string' ? triple[1] : String(triple[1]);
        const timestamp =
          triple.length >= 3 && typeof triple[2] === 'number' ? (triple[2] as number) : 0;
        if (!Number.isFinite(label) || !vectorId) continue;
        state.labelToVectorId.set(label, vectorId);
        state.vectorIdToLabel.set(vectorId, label);
        state.labelToTimestamp.set(label, timestamp);
        if (label > maxLabel) maxLabel = label;
      }
      state.nextLabel =
        typeof raw.nextLabel === 'number' && raw.nextLabel > maxLabel
          ? raw.nextLabel
          : maxLabel + 1;
    } else {
      clearTierMaps(state);
    }
  } catch (e) {
    console.warn(`[androidRagHnsw] tier=${state.tier} loadIdMap failed:`, e);
    clearTierMaps(state);
  }
}

async function persistTierIdMap(state: TierIndexState): Promise<void> {
  try {
    const entries: Array<[number, string, number]> = [];
    for (const [label, vectorId] of state.labelToVectorId.entries()) {
      const ts = state.labelToTimestamp.get(label) ?? 0;
      entries.push([label, vectorId, ts]);
    }
    const blob: IdMapBlob = { entries, nextLabel: state.nextLabel };
    await db.setVal(idMapKey(state.tier), blob);
  } catch (e) {
    console.warn(`[androidRagHnsw] tier=${state.tier} persistIdMap failed:`, e);
  }
}

// Backfill labelToTimestamp from db.vectors when an existing IDBFS file is
// loaded but the new triple layout was empty (e.g., crashed before flush).
// One-shot per tier per process.
async function backfillTimestampsFromDexie(state: TierIndexState): Promise<void> {
  if (state.labelToTimestamp.size > 0) return;
  if (state.labelToVectorId.size === 0) return;
  try {
    const ids = Array.from(state.labelToVectorId.values());
    const rows = await db.vectors.bulkGet(ids);
    let i = 0;
    for (const [label, vectorId] of state.labelToVectorId.entries()) {
      const row = rows[i];
      const ts = row && typeof row.timestamp === 'number' ? row.timestamp : 0;
      state.labelToTimestamp.set(label, ts);
      i += 1;
    }
  } catch (e) {
    console.warn(`[androidRagHnsw] tier=${state.tier} timestamp backfill failed:`, e);
  }
}

// =====================================================================
// Init — eagerly initialize all tiers on first ensureInit() call.
// Each tier independently lands in 'hnsw' / 'bruteforce'; one tier failing
// does not poison the others (PC has the same independence).
// =====================================================================

async function ensureInit(): Promise<void> {
  if (initPromise) return initPromise;
  if (TIERS.every((t) => tiers[t].initialized)) return;

  initPromise = (async () => {
    const targetDim = getEmbeddingConfig().dimensions ?? 768;

    const hnswMod = await loadModule();
    if (!hnswMod) {
      // setTierBrute already called inside loadModule's catch.
      for (const t of TIERS) tiers[t].initialized = true;
      return;
    }

    // Single global FS read for the whole process — IDBFS sync covers all
    // files in one shot, so we don't pay it three times.
    if (!initialFsRead) {
      try {
        await syncFsRead();
      } catch (e) {
        console.warn('[androidRagHnsw] IDBFS read sync failed (non-fatal):', e);
      }
      initialFsRead = true;
    }

    const persistedDim = await db.getVal<number | null>(KEYVAL_DIM_KEY, null);
    const dimMismatch = typeof persistedDim === 'number' && persistedDim !== targetDim;

    // Per-tier vector counts let us size capacity proportionally instead of
    // forcing every tier to start at the same min/cap.
    const counts: Record<RagTier, number> = {
      core: 0,
      episodic: 0,
      background: 0,
    };
    try {
      counts.core = await db.vectors.where('tier').equals('core').count();
      counts.episodic = await db.vectors.where('tier').equals('episodic').count();
      counts.background = await db.vectors.where('tier').equals('background').count();
      // PC normalizes legacy null/undefined tiers to 'core'; mirror that
      // by counting them as core for capacity sizing.
      const untiered = await db.vectors
        .filter((v) => v.tier !== 'core' && v.tier !== 'episodic' && v.tier !== 'background')
        .count();
      counts.core += untiered;
    } catch (e) {
      console.warn('[androidRagHnsw] per-tier count failed (sizing with defaults):', e);
    }

    for (const tier of TIERS) {
      const state = tiers[tier];
      state.initialized = true;
      const cnt = counts[tier];

      if (dimMismatch) {
        console.warn(
          `[androidRagHnsw] tier=${tier} dim drift (persisted=${persistedDim} target=${targetDim}); marking rebuild`,
        );
        state.needsRebuild = true;
        clearTierMaps(state);
      } else {
        await loadTierIdMap(state);
      }

      let inst: HnswIndexInstance;
      try {
        inst = new hnswMod.HierarchicalNSW('cosine', targetDim, '');
      } catch (e) {
        setTierBrute(state, 'HierarchicalNSW constructor threw', e);
        continue;
      }

      const fileExists = (() => {
        try {
          return hnswMod.EmscriptenFileSystemManager.checkFileExists(idbfsFilename(tier));
        } catch {
          return false;
        }
      })();

      const capacity = Math.max(HNSW_MIN_CAPACITY, cnt * 2 + 256);

      if (fileExists && !dimMismatch && !state.needsRebuild) {
        try {
          await inst.readIndex(idbfsFilename(tier), capacity);
          inst.setEfSearch(HNSW_EF_SEARCH);
          state.index = inst;
          state.dim = targetDim;
          state.mode = 'hnsw';
          // Belt-and-braces: timestamps may be missing if the idMap blob was
          // written before v2.14.3's triple layout. Backfill from Dexie once.
          await backfillTimestampsFromDexie(state);
          continue;
        } catch (e) {
          console.warn(`[androidRagHnsw] tier=${tier} readIndex failed; will rebuild empty:`, e);
          state.needsRebuild = true;
          clearTierMaps(state);
        }
      }

      try {
        inst.initIndex(capacity, HNSW_M, HNSW_EF_CONSTRUCTION, 100);
        inst.setEfSearch(HNSW_EF_SEARCH);
        state.index = inst;
        state.dim = targetDim;
        state.mode = 'hnsw';
        await db.setVal(KEYVAL_DIM_KEY, targetDim);
      } catch (e) {
        setTierBrute(state, 'initIndex failed', e);
      }
    }
  })();

  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

function ensureTierCapacityFor(state: TierIndexState, extra: number): boolean {
  if (!state.index) return false;
  const used = state.index.getCurrentCount();
  const cap = state.index.getMaxElements();
  if (used + extra <= cap) return true;
  try {
    const newCap = Math.max(cap * 2, used + extra + HNSW_MIN_CAPACITY);
    state.index.resizeIndex(newCap);
    return true;
  } catch (e) {
    setTierBrute(state, 'resizeIndex failed', e);
    return false;
  }
}

// =====================================================================
// Debounced flush — one global timer that walks every dirty tier.
// =====================================================================

function scheduleFlush(): void {
  if (flushHandle) clearTimeout(flushHandle);
  flushHandle = setTimeout(() => {
    flushHandle = null;
    void flush().catch((e) => console.warn('[androidRagHnsw] flush failed:', e));
  }, FLUSH_DEBOUNCE_MS);
}

async function flushTier(state: TierIndexState): Promise<void> {
  if (state.mode !== 'hnsw' || !state.index) return;
  if (!state.flushDirty) return;
  state.flushDirty = false;
  try {
    await state.index.writeIndex(idbfsFilename(state.tier));
    await persistTierIdMap(state);
  } catch (e) {
    console.warn(`[androidRagHnsw] tier=${state.tier} writeIndex/persist failed:`, e);
    state.flushDirty = true; // retry next tick
  }
}

export async function flush(): Promise<void> {
  let any = false;
  for (const tier of TIERS) {
    const state = tiers[tier];
    if (state.flushDirty) any = true;
    await flushTier(state);
  }
  if (!any) return;
  try {
    await syncFsWrite();
    await db.setVal(KEYVAL_SAVED_AT_KEY, Date.now());
  } catch (e) {
    console.warn('[androidRagHnsw] global syncFsWrite failed:', e);
  }
}

// =====================================================================
// Public API — add / search / markDeleted* / clearAll / status
// =====================================================================

export async function add(
  vectorId: string,
  vector: Float32Array,
  tierInput: RagTier | string | null | undefined,
  timestamp: number,
): Promise<boolean> {
  await ensureInit();
  const tier = normalizeTier(tierInput);
  const state = tiers[tier];
  if (state.mode !== 'hnsw' || !state.index) return false;

  if (state.dim !== null && vector.length !== state.dim) {
    console.warn(
      `[androidRagHnsw] add(${vectorId}, tier=${tier}) dim mismatch (vector=${vector.length} index=${state.dim}); skipping HNSW`,
    );
    state.needsRebuild = true;
    return false;
  }

  // Same id resaved within this tier — mark old label deleted, then insert
  // fresh so the search graph reflects the new vector.
  if (state.vectorIdToLabel.has(vectorId)) {
    const oldLabel = state.vectorIdToLabel.get(vectorId)!;
    try {
      state.index.markDelete(oldLabel);
      state.labelToVectorId.delete(oldLabel);
      state.labelToTimestamp.delete(oldLabel);
      state.vectorIdToLabel.delete(vectorId);
      state.deletedCount += 1;
    } catch (e) {
      console.warn(`[androidRagHnsw] tier=${tier} markDelete(${oldLabel}) for resave failed:`, e);
    }
  }

  if (!ensureTierCapacityFor(state, 1)) return false;

  try {
    const label = state.nextLabel++;
    state.index.addPoint(vector, label, true);
    state.labelToVectorId.set(label, vectorId);
    state.vectorIdToLabel.set(vectorId, label);
    state.labelToTimestamp.set(label, timestamp);
    state.flushDirty = true;
    scheduleFlush();
    return true;
  } catch (e) {
    setTierBrute(state, `addPoint(${vectorId}) failed`, e);
    return false;
  }
}

export async function search(
  query: Float32Array,
  k: number,
  tierInput: RagTier | string | null | undefined,
  filter?: FilterFunction,
): Promise<Array<{ vectorId: string; score: number }> | null> {
  // M.4 — rebuild gate: while a rebuild is in flight, the graph is
  // half-populated. Returning null here makes the service layer fall
  // through to brute-force on the Dexie corpus, which is always correct.
  if (rebuildInProgress) return null;

  await ensureInit();
  const tier = normalizeTier(tierInput);
  const state = tiers[tier];
  if (state.mode !== 'hnsw' || !state.index) return null;

  if (state.dim !== null && query.length !== state.dim) {
    console.warn(
      `[androidRagHnsw] tier=${tier} search dim mismatch (query=${query.length} index=${state.dim}); skipping HNSW`,
    );
    state.needsRebuild = true;
    return null;
  }

  try {
    const want = Math.max(1, k);
    const result = state.index.searchKnn(query, want, filter);
    const out: Array<{ vectorId: string; score: number }> = [];
    for (let i = 0; i < result.neighbors.length; i += 1) {
      const label = result.neighbors[i];
      const vectorId = state.labelToVectorId.get(label);
      if (!vectorId) continue;
      // hnswlib cosine returns distance = 1 - cos(a, b); convert back so
      // scoring is consistent with the brute-force cosine path elsewhere.
      const score = 1 - result.distances[i];
      out.push({ vectorId, score });
    }
    return out;
  } catch (e) {
    console.warn(`[androidRagHnsw] tier=${tier} searchKnn failed; caller should fall back:`, e);
    return null;
  }
}

export function getLabelTimestamp(tier: RagTier, label: number): number | undefined {
  return tiers[tier].labelToTimestamp.get(label);
}

export async function markDeleted(vectorId: string, tierHint?: RagTier): Promise<void> {
  await ensureInit();
  const targets: RagTier[] = tierHint ? [tierHint] : [...TIERS];
  for (const tier of targets) {
    const state = tiers[tier];
    if (state.mode !== 'hnsw' || !state.index) continue;
    const label = state.vectorIdToLabel.get(vectorId);
    if (label === undefined) continue;
    try {
      state.index.markDelete(label);
      state.labelToVectorId.delete(label);
      state.labelToTimestamp.delete(label);
      state.vectorIdToLabel.delete(vectorId);
      state.deletedCount += 1;
      state.flushDirty = true;
      if (tierDeletedRatio(state) > HNSW_DELETED_RATIO_THRESHOLD) state.needsRebuild = true;
    } catch (e) {
      console.warn(`[androidRagHnsw] tier=${tier} markDeleted(${vectorId}) failed:`, e);
    }
  }
  scheduleFlush();
}

export async function markDeletedBatch(
  vectorIds: string[],
  tierMap?: Map<string, RagTier>,
): Promise<void> {
  if (vectorIds.length === 0) return;
  await ensureInit();

  // Bucket ids by tier — caller may pass a tier hint per id (faster), or
  // omit it (we then probe all three tiers per id, which is O(3n) maps
  // lookups but no IDBFS work).
  const byTier: Record<RagTier, number[]> = { core: [], episodic: [], background: [] };
  const seen = new Set<string>();
  for (const id of vectorIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const hinted = tierMap?.get(id);
    if (hinted) {
      const label = tiers[hinted].vectorIdToLabel.get(id);
      if (label !== undefined) byTier[hinted].push(label);
      tiers[hinted].labelToVectorId.delete(label!);
      tiers[hinted].labelToTimestamp.delete(label!);
      tiers[hinted].vectorIdToLabel.delete(id);
      continue;
    }
    for (const t of TIERS) {
      const state = tiers[t];
      const label = state.vectorIdToLabel.get(id);
      if (label === undefined) continue;
      byTier[t].push(label);
      state.labelToVectorId.delete(label);
      state.labelToTimestamp.delete(label);
      state.vectorIdToLabel.delete(id);
    }
  }

  for (const tier of TIERS) {
    const state = tiers[tier];
    const labels = byTier[tier];
    if (labels.length === 0) continue;
    if (state.mode !== 'hnsw' || !state.index) continue;
    try {
      state.index.markDeleteItems(labels);
      state.deletedCount += labels.length;
      state.flushDirty = true;
      if (tierDeletedRatio(state) > HNSW_DELETED_RATIO_THRESHOLD) state.needsRebuild = true;
    } catch (e) {
      console.warn(
        `[androidRagHnsw] tier=${tier} markDeleteItems(${labels.length}) failed:`,
        e,
      );
    }
  }
  scheduleFlush();
}

export async function clearAll(): Promise<void> {
  if (flushHandle) {
    clearTimeout(flushHandle);
    flushHandle = null;
  }
  for (const tier of TIERS) {
    const state = tiers[tier];
    state.index = null;
    state.mode = 'uninitialized';
    state.dim = null;
    state.needsRebuild = false;
    state.lastError = undefined;
    state.flushDirty = false;
    state.initialized = false;
    clearTierMaps(state);
    try {
      await db.setVal(idMapKey(tier), null);
    } catch (e) {
      console.warn(`[androidRagHnsw] tier=${tier} idMap clear failed:`, e);
    }
  }
  try {
    await db.setVal(KEYVAL_DIM_KEY, null);
    await db.setVal(KEYVAL_SAVED_AT_KEY, null);
  } catch (e) {
    console.warn('[androidRagHnsw] dim/savedAt clear failed:', e);
  }
  // We can't reliably unlink IDBFS files from JS — overwriting on next
  // writeIndex is sufficient. syncFsWrite to commit the cleared idMap blob.
  try {
    await syncFsWrite();
  } catch (e) {
    console.warn('[androidRagHnsw] clearAll syncFsWrite failed:', e);
  }
}

export function getStatus(): AggregateStatus {
  const out: Record<RagTier, TierStatus> = {
    core: emptyTierStatus('core'),
    episodic: emptyTierStatus('episodic'),
    background: emptyTierStatus('background'),
  };
  for (const tier of TIERS) {
    const state = tiers[tier];
    out[tier] = {
      tier,
      mode: state.mode,
      count: state.index ? state.index.getCurrentCount() : 0,
      dim: state.dim,
      capacity: state.index ? state.index.getMaxElements() : 0,
      needsRebuild: state.needsRebuild,
      deletedRatio: tierDeletedRatio(state),
      lastError: state.lastError,
    };
  }
  return { tiers: out, rebuildInProgress };
}

function emptyTierStatus(tier: RagTier): TierStatus {
  return {
    tier,
    mode: 'uninitialized',
    count: 0,
    dim: null,
    capacity: 0,
    needsRebuild: false,
    deletedRatio: 0,
  };
}

// =====================================================================
// Rebuild gate (M.4) + bulk add path (rebuild loop only)
// =====================================================================

export function setRebuildInProgress(value: boolean): void {
  rebuildInProgress = value;
}

export function isRebuildInProgress(): boolean {
  return rebuildInProgress;
}

/**
 * Hard reset used by handleRebuildStart — drops every tier and re-inits
 * each one empty, sized to the per-tier vector count provided by the caller.
 * The rebuild loop then streams Dexie rows back in via addBatchFresh().
 */
export async function reinitEmpty(
  perTierTotals: Partial<Record<RagTier, number>>,
): Promise<boolean> {
  if (flushHandle) {
    clearTimeout(flushHandle);
    flushHandle = null;
  }

  const targetDim = getEmbeddingConfig().dimensions ?? 768;
  const hnswMod = await loadModule();
  if (!hnswMod) return false;

  let allOk = true;
  for (const tier of TIERS) {
    const state = tiers[tier];
    state.index = null;
    state.mode = 'uninitialized';
    state.needsRebuild = false;
    state.lastError = undefined;
    state.flushDirty = false;
    state.initialized = true;
    clearTierMaps(state);

    const want = perTierTotals[tier] ?? 0;
    const capacity = Math.max(HNSW_MIN_CAPACITY, want * 2 + 256);

    try {
      const inst = new hnswMod.HierarchicalNSW('cosine', targetDim, '');
      inst.initIndex(capacity, HNSW_M, HNSW_EF_CONSTRUCTION, 100);
      inst.setEfSearch(HNSW_EF_SEARCH);
      state.index = inst;
      state.dim = targetDim;
      state.mode = 'hnsw';
    } catch (e) {
      setTierBrute(state, 'reinitEmpty initIndex failed', e);
      allOk = false;
    }
  }

  try {
    await db.setVal(KEYVAL_DIM_KEY, targetDim);
  } catch (e) {
    console.warn('[androidRagHnsw] reinitEmpty dim persist failed:', e);
  }

  return allOk;
}

/**
 * Bulk path used by the rebuild loop. Skips the per-vector resave-delete
 * fast path since `reinitEmpty` guarantees every tier index is empty.
 * Bypasses the rebuildInProgress gate (the rebuild itself needs to write).
 */
export function addBatchFresh(
  rows: Array<{ id: string; vector: Float32Array; tier: RagTier; timestamp: number }>,
): { added: number; skipped: number } {
  let added = 0;
  let skipped = 0;
  for (const row of rows) {
    const tier = normalizeTier(row.tier);
    const state = tiers[tier];
    if (state.mode !== 'hnsw' || !state.index) {
      skipped += 1;
      continue;
    }
    if (state.dim !== null && row.vector.length !== state.dim) {
      skipped += 1;
      continue;
    }
    if (!ensureTierCapacityFor(state, 1)) {
      skipped += 1;
      continue;
    }
    try {
      const label = state.nextLabel++;
      state.index.addPoint(row.vector, label, false);
      state.labelToVectorId.set(label, row.id);
      state.vectorIdToLabel.set(row.id, label);
      state.labelToTimestamp.set(label, row.timestamp);
      state.flushDirty = true;
      added += 1;
    } catch {
      skipped += 1;
    }
  }
  return { added, skipped };
}

/**
 * For tests / diagnostics — never imported by production callers.
 */
export function _resetForTests(): void {
  if (flushHandle) clearTimeout(flushHandle);
  flushHandle = null;
  for (const tier of TIERS) {
    tiers[tier] = makeTierState(tier);
  }
  lib = null;
  initPromise = null;
  rebuildInProgress = false;
  initialFsRead = false;
}
