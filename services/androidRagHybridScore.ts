// services/androidRagHybridScore.ts
//
// v2.14.3 M.5 — Hybrid scoring for Android RAG, ported byte-for-byte from
// `electron-rag.cjs` so PC and Android return identical scores for the
// same (vector, BM25, tier, source, role, memoryIntent, keywordScore)
// inputs. Every constant — `k1=1.2`, `b=0.75`, RRF `k=60`, tier penalties
// (-0.015 / -0.08), source penalties (-0.02 / -0.01), role penalty (-0.015),
// semantic_recall adjustments (+0.035 / -0.035 / +0.01 / +0.05), and
// `memoryScore * 0.015` — must stay locked to PC. **DO NOT** "improve" any
// of these without first changing PC's `boostHybridScore` and adding a
// dimensional regression test.
//
// PC behavior: zero impact. `electron-rag.cjs` keeps owning its own copies
// of these functions; this file only ever runs in the Capacitor WebView.
//
// Source of truth: electron-rag.cjs L1035 (tokenize) → L1259 (dedupeRetrievedResults).
// Kept as a verbatim port — comments paraphrased, code unchanged.

export const HYBRID_SCORE_VERSION = 'v2.14.3-m5-pc-parity';

// =====================================================================
// Tier constants — kept literal so this module has zero coupling with
// androidRagHnswIndex (avoids a circular import).
// =====================================================================
const RAG_TIER_CORE = 'core';
const RAG_TIER_EPISODIC = 'episodic';
const RAG_TIER_BACKGROUND = 'background';

export type HybridTier = 'core' | 'episodic' | 'background';

// =====================================================================
// tokenize(text) — char-bigram CJK + whitespace-split Latin/digits.
// Verbatim port of electron-rag.cjs L1035-L1054.
// =====================================================================
export function tokenize(text: unknown): string[] {
  if (!text) return [];
  const cleaned = String(text).toLowerCase().replace(/[^\w\s\u4e00-\u9fa5]/g, ' ');
  const tokens: string[] = [];
  const parts = cleaned.split(/\s+/).filter((t) => t.length > 0);
  for (const part of parts) {
    if (/[\u4e00-\u9fa5]/.test(part)) {
      const cjk = part.replace(/[^\u4e00-\u9fa5]/g, '');
      for (let i = 0; i < cjk.length - 1; i += 1) {
        tokens.push(cjk[i] + cjk[i + 1]);
      }
      if (cjk.length === 1) tokens.push(cjk);
      const nonCjk = part.replace(/[\u4e00-\u9fa5]/g, ' ').split(/\s+/).filter(Boolean);
      tokens.push(...nonCjk);
    } else {
      tokens.push(part);
    }
  }
  return tokens;
}

// =====================================================================
// calculateBM25(queryTokens, docs) — Okapi BM25, k1=1.2 / b=0.75.
// Verbatim port of electron-rag.cjs L1056-L1093.
//
// `docs` shape: Array<{ id: string; tokens: string[] }>
// Returns: Map<docId, score> for every doc (zero score if no overlap).
// =====================================================================
export interface Bm25Doc {
  id: string;
  tokens: string[];
}

export function calculateBM25(queryTokens: string[], docs: Bm25Doc[]): Map<string, number> {
  const k1 = 1.2;
  const b = 0.75;
  const N = docs.length;
  if (N === 0) return new Map();

  const avgdl = docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / N;

  const df = new Map<string, number>();
  docs.forEach((doc) => {
    const unique = new Set(doc.tokens);
    unique.forEach((token) => df.set(token, (df.get(token) || 0) + 1));
  });

  const idf = new Map<string, number>();
  df.forEach((freq, token) => {
    idf.set(token, Math.log((N - freq + 0.5) / (freq + 0.5) + 1));
  });

  const scores = new Map<string, number>();
  docs.forEach((doc) => {
    let score = 0;
    const docLen = doc.tokens.length;
    const tf = new Map<string, number>();
    doc.tokens.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));

    queryTokens.forEach((token) => {
      if (tf.has(token) && idf.has(token)) {
        const termFreq = tf.get(token)!;
        const idfScore = idf.get(token)!;
        score += idfScore * ((termFreq * (k1 + 1)) / (termFreq + k1 * (1 - b + b * (docLen / avgdl))));
      }
    });

    scores.set(doc.id, score);
  });

  return scores;
}

// =====================================================================
// computeRRF(vectorResults, bm25Results, k = 60) — Reciprocal Rank Fusion.
// Verbatim port of electron-rag.cjs L1095-L1108.
// =====================================================================
export interface RankedItem {
  id: string;
  score: number;
}

export function computeRRF(
  vectorResults: RankedItem[],
  bm25Results: RankedItem[],
  k = 60,
): Map<string, number> {
  const rrfScores = new Map<string, number>();

  vectorResults.forEach((item, index) => {
    rrfScores.set(item.id, 1 / (k + index + 1));
  });

  bm25Results.forEach((item, index) => {
    const current = rrfScores.get(item.id) || 0;
    rrfScores.set(item.id, current + 1 / (k + index + 1));
  });

  return rrfScores;
}

// =====================================================================
// boostHybridScore(rrf, memScore, tier, source, role, intent, keywordScore)
// Verbatim port of electron-rag.cjs L1144-L1178.
//
// Constants frozen by PC parity contract:
//   memoryScore clamp:               0..12
//   memoryScore weight:              × 0.015
//   tier penalty (episodic):         -0.015
//   tier penalty (background):       -0.08
//   source penalty (turn_pair):      -0.02
//   source penalty (episodic_merge): -0.01
//   role penalty (mixed):            -0.015
//   semantic_recall (memory_chunk):       +0.035
//   semantic_recall (turn_pair):          -0.035
//   semantic_recall (rebuild/episodic):   +0.01
//   semantic_recall (keywordScore > 0):   +0.05
// =====================================================================
export type MemoryIntent = 'default' | 'semantic_recall' | string;

export function boostHybridScore(
  rrfScore: number,
  memoryScore: number,
  tier: HybridTier | string = RAG_TIER_CORE,
  source: string = 'unknown',
  role: string = 'unknown',
  memoryIntent: MemoryIntent = 'default',
  keywordScore: number = 0,
): number {
  const normalizedMemoryScore = Math.max(0, Math.min(Number.isFinite(memoryScore) ? memoryScore : 0, 12));
  let boostedScore = rrfScore + normalizedMemoryScore * 0.015;

  if (tier === RAG_TIER_EPISODIC) {
    boostedScore -= 0.015;
  } else if (tier === RAG_TIER_BACKGROUND) {
    boostedScore -= 0.08;
  }

  if (source === 'turn_pair') {
    boostedScore -= 0.02;
  } else if (source === 'episodic_merge') {
    boostedScore -= 0.01;
  }

  if (role === 'mixed') {
    boostedScore -= 0.015;
  }

  if (memoryIntent === 'semantic_recall') {
    if (source === 'memory_chunk') {
      boostedScore += 0.035;
    } else if (source === 'turn_pair') {
      boostedScore -= 0.035;
    } else if (source === 'rebuild_fragment' || source === 'episodic_merge') {
      boostedScore += 0.01;
    }
    if (keywordScore > 0) {
      boostedScore += 0.05;
    }
  }

  return boostedScore;
}

// =====================================================================
// dedupeRetrievedResults(results, topK) + helpers.
// Verbatim port of electron-rag.cjs L1228-L1259.
//
// Dedupe key precedence:
//   1. canonicalKey  → "canonical:{key}"
//   2. messageId     → "message:{id}"
//   3. text prefix   → "text:{trim().lower().slice(0,160)}"
//
// Sort precedence (compareRetrievedResults):
//   1. Tier rank: core(0) → episodic(1) → background(2) ascending.
//   2. score descending.
//   3. timestamp descending.
// =====================================================================

export interface RetrievedResult {
  text?: string;
  messageId?: string;
  tier?: HybridTier | string;
  source?: string;
  timestamp?: number;
  score?: number;
  vectorScore?: number;
  keywordScore?: number;
  memoryScore?: number;
  role?: string;
  canonicalKey?: string;
}

export function getRetrievalDedupeKey(result: RetrievedResult): string {
  if (result.canonicalKey) {
    return `canonical:${result.canonicalKey}`;
  }
  if (result.messageId) {
    return `message:${result.messageId}`;
  }
  return `text:${String(result.text || '').trim().toLowerCase().slice(0, 160)}`;
}

function getTierRank(tier: HybridTier | string | undefined): number {
  if (tier === RAG_TIER_CORE) return 0;
  if (tier === RAG_TIER_EPISODIC) return 1;
  return 2;
}

export function compareRetrievedResults(a: RetrievedResult, b: RetrievedResult): number {
  const tierRank = getTierRank(a.tier) - getTierRank(b.tier);
  if (tierRank !== 0) return tierRank;
  if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
  return (b.timestamp || 0) - (a.timestamp || 0);
}

export function dedupeRetrievedResults<T extends RetrievedResult>(results: T[], topK: number): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];

  for (const result of [...results].sort(compareRetrievedResults)) {
    const key = getRetrievalDedupeKey(result);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
    if (deduped.length >= topK) break;
  }

  return deduped;
}
