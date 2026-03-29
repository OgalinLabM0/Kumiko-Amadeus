import { db } from '../services/db';

// --- Shared Types ---
interface WorkerMessage {
  type: 'SEARCH';
  payload: {
    query: string;
    queryVector: Float32Array;
    topK: number;
  };
  id: string;
}

// --- Hybrid Search Components ---

// 1. Lightweight multilingual tokenizer
const tokenize = (text: string): string[] => {
  if (!text) return [];
  
  // Use Intl.Segmenter if available (modern browsers)
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    const segments = segmenter.segment(text);
    const tokens: string[] = [];
    for (const segment of segments) {
      if (segment.isWordLike) {
        tokens.push(segment.segment.toLowerCase());
      }
    }
    return tokens;
  }

  // Fallback for older browsers
  return text.toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fa5]/g, ' ') // Keep alphanumeric and Chinese chars
    .split(/\s+/)
    .filter(t => t.length > 0);
};

// 2. BM25 Implementation
const calculateBM25 = (queryTokens: string[], docs: { id: string, tokens: string[] }[]): Map<string, number> => {
  const k1 = 1.2;
  const b = 0.75;
  const N = docs.length;
  
  if (N === 0) return new Map();

  // Calculate average document length
  const avgdl = docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / N;

  // Calculate document frequencies (DF)
  const df = new Map<string, number>();
  docs.forEach(doc => {
    const uniqueTokens = new Set(doc.tokens);
    uniqueTokens.forEach(token => {
      df.set(token, (df.get(token) || 0) + 1);
    });
  });

  // Calculate IDF
  const idf = new Map<string, number>();
  df.forEach((freq, token) => {
    // Standard BM25 IDF formula
    const val = Math.log((N - freq + 0.5) / (freq + 0.5) + 1);
    idf.set(token, val);
  });

  // Calculate BM25 scores
  const scores = new Map<string, number>();
  docs.forEach(doc => {
    let score = 0;
    const docLen = doc.tokens.length;
    
    // Term frequencies in this document
    const tf = new Map<string, number>();
    doc.tokens.forEach(token => {
      tf.set(token, (tf.get(token) || 0) + 1);
    });

    queryTokens.forEach(token => {
      if (tf.has(token) && idf.has(token)) {
        const termFreq = tf.get(token)!;
        const idfScore = idf.get(token)!;
        
        const numerator = termFreq * (k1 + 1);
        const denominator = termFreq + k1 * (1 - b + b * (docLen / avgdl));
        
        score += idfScore * (numerator / denominator);
      }
    });

    scores.set(doc.id, score);
  });

  return scores;
};

// 3. Reciprocal Rank Fusion (RRF)
const computeRRF = (
  vectorScores: { id: string, score: number }[],
  bm25Scores: { id: string, score: number }[],
  k: number = 60
): Map<string, number> => {
  const rrfScores = new Map<string, number>();
  
  // Sort and rank vector scores
  const sortedVector = [...vectorScores].sort((a, b) => b.score - a.score);
  sortedVector.forEach((item, index) => {
    const rank = index + 1;
    rrfScores.set(item.id, 1 / (k + rank));
  });

  // Sort and rank BM25 scores
  const sortedBM25 = [...bm25Scores].sort((a, b) => b.score - a.score);
  sortedBM25.forEach((item, index) => {
    const rank = index + 1;
    const currentScore = rrfScores.get(item.id) || 0;
    rrfScores.set(item.id, currentScore + 1 / (k + rank));
  });

  return rrfScores;
};

export const cosineSimilarity = (a: Float32Array, b: Float32Array): number => {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  // Handle dimension mismatch gracefully
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
};

// --- Worker Message Handler ---
self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { type, payload, id } = e.data;

  if (type === 'SEARCH') {
    try {
      const { query, queryVector, topK } = payload;
      
      const allVectors = await db.vectors.toArray();
      if (allVectors.length === 0) {
        self.postMessage({ id, result: [] });
        return;
      }

      // 1. Vector Search (Cosine Similarity)
      const vectorScores = allVectors.map(v => ({
        id: v.id,
        text: v.text,
        score: cosineSimilarity(queryVector, v.vector)
      }));

      // 2. Keyword Search (BM25)
      const queryTokens = tokenize(query);
      const docsForBM25 = allVectors.map(v => ({
        id: v.id,
        tokens: tokenize(v.text)
      }));
      const bm25ScoreMap = calculateBM25(queryTokens, docsForBM25);
      
      const bm25Scores = allVectors.map(v => ({
        id: v.id,
        score: bm25ScoreMap.get(v.id) || 0
      }));

      // 3. Reciprocal Rank Fusion (RRF)
      const rrfScores = computeRRF(vectorScores, bm25Scores);

      // 4. Combine and Sort
      const finalResults = allVectors.map(v => ({
        text: v.text,
        messageId: v.messageId,
        score: rrfScores.get(v.id) || 0,
        vectorScore: vectorScores.find(vs => vs.id === v.id)?.score || 0
      }));
      
      // Sort by RRF score descending
      finalResults.sort((a, b) => b.score - a.score);
      
      // 5. Filter out low vector scores and get a larger pool for re-ranking
      const candidates = finalResults
        .filter(s => s.vectorScore > 0.1) // Relaxed threshold since BM25 helps
        .slice(0, topK)
        .map(s => ({ text: s.text, messageId: s.messageId }));

      self.postMessage({ id, result: candidates });
    } catch (error) {
      console.error("Worker search error:", error);
      self.postMessage({ id, error: String(error) });
    }
  }
};
