// services/cloudEmbeddingService.ts
//
// A5.0: cloud embedding API client for the Android Capacitor APK so it
// can replace PC's local bge-m3 ONNX inference without dragging the 500 MB
// model + ONNX runtime into the phone. Five providers covered out of the
// box (OpenAI / Gemini / 智谱 GLM / 通义 / custom OpenAI-compatible)
// because that's what most users already have keys for, and dimension
// agility is critical (different providers ship different sizes; mixing
// dimensions inside the same vector store breaks cosine similarity, so
// we pin a target dimension in config and either reduce server-side
// when supported or fail loud if the user picks an incompatible model).
//
// On Capacitor (A5), CapacitorHttp is enabled in capacitor.config.ts so
// every fetch() here goes through native HTTP — bypasses CORS preflight
// against capacitor://localhost which would otherwise break direct calls
// to OpenAI / Gemini / 智谱 / 通义 from the WebView.
//
// PWA / Electron desktop never call into this module (they have PC's
// bge-m3 ONNX through electron-rag.cjs / Fastify HTTP bridge), so the
// module is mobile-Capacitor-only and PC's RAG behaviour is unchanged.

import {
  DEFAULT_EMBEDDING_CONFIG,
  EMBEDDING_CONFIG_STORAGE_KEY,
  type EmbeddingProviderConfig,
} from './cloudEmbeddingConfig';
import { useAppStore } from '../store';

export {
  DEFAULT_EMBEDDING_CONFIG,
  EMBEDDING_CONFIG_STORAGE_KEY,
  EMBEDDING_MODEL_CATALOG,
} from './cloudEmbeddingConfig';
export type {
  EmbeddingProvider,
  EmbeddingProviderConfig,
  EmbeddingModelPreset,
} from './cloudEmbeddingConfig';

export interface EmbeddingResult {
  vector: Float32Array;
  /** What the provider actually returned, for debugging dimension mismatches. */
  actualDimensions: number;
}

// v2.14.12 — getEmbeddingConfig / setEmbeddingConfig now route through the
// Zustand store (`embeddingSlice`), which is the single source of truth for
// the embedding configuration. Persistence to localStorage and any future
// cross-tab notifications are handled by the slice's setter — the legacy
// `kumiko:embedding-config-changed` custom event is gone, since every
// consumer now subscribes to `useAppStore(s => s.embeddingConfig)` directly
// and gets reactive updates without a manual event channel.
//
// The `useAppStore` import is intentionally a top-level ESM import. The
// embedding slice imports only cloudEmbeddingConfig.ts, so this module no
// longer participates in the store construction graph; the helpers below
// still access the store lazily inside function bodies.
//
// NB: `EMBEDDING_CONFIG_STORAGE_KEY` and `DEFAULT_EMBEDDING_CONFIG` now live
// in cloudEmbeddingConfig.ts so the slice can hydrate without importing this
// file's runtime helpers, avoiding a store <-> service module cycle.

let loggedStoreRead = false;
let loggedLocalStorageHeal = false;
let loggedConfigSet = false;

function normalizeEmbeddingConfig(raw: Partial<EmbeddingProviderConfig>): EmbeddingProviderConfig {
  const dimensions = typeof raw.dimensions === 'number' && Number.isFinite(raw.dimensions) && raw.dimensions > 0
    ? Math.round(raw.dimensions)
    : DEFAULT_EMBEDDING_CONFIG.dimensions;
  return {
    ...DEFAULT_EMBEDDING_CONFIG,
    ...raw,
    dimensions,
  };
}

function readPersistedEmbeddingConfig(): EmbeddingProviderConfig | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(EMBEDDING_CONFIG_STORAGE_KEY);
    if (!raw) return null;
    return normalizeEmbeddingConfig(JSON.parse(raw) as Partial<EmbeddingProviderConfig>);
  } catch (e) {
    console.warn('[cloudEmbeddingService] failed to read persisted embedding config:', e);
    return null;
  }
}

function isDefaultEmbeddingConfig(config: EmbeddingProviderConfig): boolean {
  return (
    config.provider === DEFAULT_EMBEDDING_CONFIG.provider &&
    (config.apiKey || '') === DEFAULT_EMBEDDING_CONFIG.apiKey &&
    config.model === DEFAULT_EMBEDDING_CONFIG.model &&
    (config.customEndpoint || '') === (DEFAULT_EMBEDDING_CONFIG.customEndpoint || '') &&
    (config.dimensions || 0) === (DEFAULT_EMBEDDING_CONFIG.dimensions || 0)
  );
}

function isMeaningfulEmbeddingConfig(config: EmbeddingProviderConfig): boolean {
  return !isDefaultEmbeddingConfig(config) || !!config.apiKey.trim();
}

function describeEmbeddingConfig(config: EmbeddingProviderConfig) {
  return {
    provider: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    hasApiKey: !!config.apiKey.trim(),
    hasCustomEndpoint: !!config.customEndpoint?.trim(),
  };
}

export function getEmbeddingConfig(): EmbeddingProviderConfig {
  const state = useAppStore.getState();
  const storeConfig = state.embeddingConfig;
  if (!loggedStoreRead) {
    console.log('[cloudEmbeddingService] getEmbeddingConfig store snapshot:', describeEmbeddingConfig(storeConfig));
    loggedStoreRead = true;
  }

  const persistedConfig = readPersistedEmbeddingConfig();
  if (
    isDefaultEmbeddingConfig(storeConfig) &&
    persistedConfig &&
    isMeaningfulEmbeddingConfig(persistedConfig)
  ) {
    if (!loggedLocalStorageHeal) {
      console.log('[cloudEmbeddingService] recovered embedding config from localStorage:', describeEmbeddingConfig(persistedConfig));
      loggedLocalStorageHeal = true;
    }
    state.setEmbeddingConfig(persistedConfig);
    return persistedConfig;
  }

  return storeConfig;
}

export function setEmbeddingConfig(config: EmbeddingProviderConfig): void {
  if (!loggedConfigSet) {
    console.log('[cloudEmbeddingService] setEmbeddingConfig:', describeEmbeddingConfig(config));
    loggedConfigSet = true;
  }
  useAppStore.getState().setEmbeddingConfig(config);
}

interface OpenAIEmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
  error?: { message?: string };
}

interface GeminiEmbeddingResponse {
  embedding?: { values?: number[] };
  error?: { message?: string };
}

async function postJsonWithTimeout<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs = 30_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status} ${res.statusText}`;
      try {
        const errBody = await res.text();
        if (errBody) detail += ` — ${errBody.slice(0, 256)}`;
      } catch {
        /* ignore */
      }
      throw new Error(detail);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function arrayToFloat32(arr: number[]): Float32Array {
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i += 1) out[i] = arr[i];
  return out;
}

async function embedOpenAICompatible(
  text: string,
  apiKey: string,
  model: string,
  baseUrl: string,
  dimensions?: number,
): Promise<EmbeddingResult> {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const url = `${cleanBase}/embeddings`;
  const body: Record<string, unknown> = { input: text, model };
  if (typeof dimensions === 'number' && dimensions > 0) {
    body.dimensions = dimensions;
  }
  const reply = await postJsonWithTimeout<OpenAIEmbeddingResponse>(url, body, {
    Authorization: `Bearer ${apiKey}`,
  });
  if (reply.error?.message) throw new Error(reply.error.message);
  const vec = reply.data?.[0]?.embedding;
  if (!Array.isArray(vec)) {
    throw new Error('Embedding response missing data[0].embedding');
  }
  return { vector: arrayToFloat32(vec), actualDimensions: vec.length };
}

async function embedGemini(
  text: string,
  apiKey: string,
  model: string,
  dimensions?: number,
): Promise<EmbeddingResult> {
  // Gemini's embedContent is a different endpoint shape from OpenAI; the
  // API key goes in the URL (?key=...) since Bearer isn't supported.
  // gemini-embedding-001 supports `outputDimensionality`; text-embedding-004
  // does not, so we only set it when the caller asked for it AND the model
  // supports it. We cap at the model's max as defined in EMBEDDING_MODEL_CATALOG.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:embedContent?key=${encodeURIComponent(apiKey)}`;
  const body: Record<string, unknown> = {
    content: { parts: [{ text }] },
  };
  if (typeof dimensions === 'number' && dimensions > 0 && model.includes('embedding-001')) {
    body.outputDimensionality = dimensions;
  }
  const reply = await postJsonWithTimeout<GeminiEmbeddingResponse>(url, body, {});
  if (reply.error?.message) throw new Error(reply.error.message);
  const values = reply.embedding?.values;
  if (!Array.isArray(values)) {
    throw new Error('Gemini embedding response missing embedding.values');
  }
  return { vector: arrayToFloat32(values), actualDimensions: values.length };
}

async function embedZhipu(text: string, apiKey: string, model: string): Promise<EmbeddingResult> {
  // 智谱 BigModel API is OpenAI-compatible at the embeddings endpoint shape.
  return embedOpenAICompatible(text, apiKey, model, 'https://open.bigmodel.cn/api/paas/v4');
}

async function embedTongyi(text: string, apiKey: string, model: string): Promise<EmbeddingResult> {
  // 通义 DashScope ships an OpenAI-compatible mode at compatible-mode/v1.
  // We use that instead of the native /api/v1/services/embeddings/text-embedding/text-embedding
  // path because the OpenAI-compatible mode keeps request/response shape
  // identical to OpenAI/Zhipu, simplifying our switching here.
  return embedOpenAICompatible(text, apiKey, model, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
}

export async function generateCloudEmbedding(
  text: string,
  config?: EmbeddingProviderConfig,
): Promise<EmbeddingResult> {
  const cfg = config || getEmbeddingConfig();
  const apiKey = cfg.apiKey?.trim();
  if (!apiKey) {
    throw new Error('Embedding API key is empty — please configure one in Settings → Cloud Embedding.');
  }
  const dimensions = cfg.dimensions;
  switch (cfg.provider) {
    case 'openai':
      return embedOpenAICompatible(text, apiKey, cfg.model, 'https://api.openai.com/v1', dimensions);
    case 'gemini':
      return embedGemini(text, apiKey, cfg.model, dimensions);
    case 'zhipu':
      return embedZhipu(text, apiKey, cfg.model);
    case 'tongyi':
      return embedTongyi(text, apiKey, cfg.model);
    case 'custom': {
      const endpoint = (cfg.customEndpoint || '').trim();
      if (!endpoint) {
        throw new Error('Custom provider selected but no endpoint URL configured.');
      }
      return embedOpenAICompatible(text, apiKey, cfg.model, endpoint, dimensions);
    }
    default:
      throw new Error(`Unsupported embedding provider: ${cfg.provider}`);
  }
}

/**
 * Connectivity probe used by EmbeddingConfigSection's "Test connection"
 * button. Sends a tiny "test" string and reports the actual returned
 * dimensions so the user can verify the provider config + see a
 * dimension-mismatch warning if the model differs from the recorded
 * `dimensions` field.
 */
export async function testEmbeddingConfig(
  config: EmbeddingProviderConfig,
): Promise<{ ok: boolean; actualDimensions?: number; error?: string }> {
  try {
    const result = await generateCloudEmbedding('test', config);
    return { ok: true, actualDimensions: result.actualDimensions };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Unknown error' };
  }
}
