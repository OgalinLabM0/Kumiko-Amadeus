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

export type EmbeddingProvider = 'openai' | 'gemini' | 'zhipu' | 'tongyi' | 'custom';

export interface EmbeddingProviderConfig {
  provider: EmbeddingProvider;
  apiKey: string;
  model: string;
  /**
   * Custom OpenAI-compatible endpoint. Required when provider === 'custom',
   * ignored otherwise. Trailing slashes are stripped at use time so users
   * can paste either form without breaking the URL join.
   */
  customEndpoint?: string;
  /**
   * Target embedding dimension. The vector store is keyed on this — any
   * change should be followed by a rebuild (the localRagService rebuild
   * pipeline handles that). Currently only OpenAI text-embedding-3-* and
   * Gemini gemini-embedding-001 honor a server-side `dimensions` reduction.
   * For other providers we accept whatever the model returns and the
   * user must keep the dimension consistent with the recorded value.
   */
  dimensions?: number;
}

export interface EmbeddingResult {
  vector: Float32Array;
  /** What the provider actually returned, for debugging dimension mismatches. */
  actualDimensions: number;
}

const STORAGE_KEY = 'kumiko_embedding_config';
export const EMBEDDING_CONFIG_STORAGE_KEY = STORAGE_KEY;

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingProviderConfig = {
  provider: 'openai',
  apiKey: '',
  model: 'text-embedding-3-small',
  dimensions: 768,
};

// Catalog of model presets per provider, surfaced by EmbeddingConfigSection.tsx
// for the dropdown. `dimensions` here is the model's native dimension; users
// can override via the explicit dimensions field below the model picker.
export interface EmbeddingModelPreset {
  id: string;
  label: string;
  /** Native dimension at the provider's default. */
  defaultDimensions: number;
  /** Whether the provider supports server-side dimension reduction. */
  supportsDimensionReduction: boolean;
  /** Optional caps so the UI can reject impossible values. */
  minDimensions?: number;
  maxDimensions?: number;
}

export const EMBEDDING_MODEL_CATALOG: Record<EmbeddingProvider, EmbeddingModelPreset[]> = {
  openai: [
    {
      id: 'text-embedding-3-small',
      label: 'text-embedding-3-small (1536d, reducible)',
      defaultDimensions: 1536,
      supportsDimensionReduction: true,
      minDimensions: 256,
      maxDimensions: 1536,
    },
    {
      id: 'text-embedding-3-large',
      label: 'text-embedding-3-large (3072d, reducible)',
      defaultDimensions: 3072,
      supportsDimensionReduction: true,
      minDimensions: 256,
      maxDimensions: 3072,
    },
    {
      id: 'text-embedding-ada-002',
      label: 'text-embedding-ada-002 (1536d, legacy)',
      defaultDimensions: 1536,
      supportsDimensionReduction: false,
    },
  ],
  gemini: [
    {
      id: 'text-embedding-004',
      label: 'text-embedding-004 (768d)',
      defaultDimensions: 768,
      supportsDimensionReduction: false,
    },
    {
      id: 'gemini-embedding-001',
      label: 'gemini-embedding-001 (768d default, up to 3072)',
      defaultDimensions: 768,
      supportsDimensionReduction: true,
      minDimensions: 256,
      maxDimensions: 3072,
    },
  ],
  zhipu: [
    {
      id: 'embedding-3',
      label: 'embedding-3 (2048d)',
      defaultDimensions: 2048,
      supportsDimensionReduction: false,
    },
    {
      id: 'embedding-2',
      label: 'embedding-2 (1024d, legacy)',
      defaultDimensions: 1024,
      supportsDimensionReduction: false,
    },
  ],
  tongyi: [
    {
      id: 'text-embedding-v3',
      label: 'text-embedding-v3 (1024d)',
      defaultDimensions: 1024,
      supportsDimensionReduction: false,
    },
    {
      id: 'text-embedding-v4',
      label: 'text-embedding-v4 (2048d)',
      defaultDimensions: 2048,
      supportsDimensionReduction: false,
    },
  ],
  custom: [
    {
      id: 'custom-model',
      label: '自定义模型 (Custom OpenAI-compatible)',
      defaultDimensions: 768,
      supportsDimensionReduction: true,
      minDimensions: 1,
      maxDimensions: 8192,
    },
  ],
};

export function getEmbeddingConfig(): EmbeddingProviderConfig {
  if (typeof window === 'undefined') return DEFAULT_EMBEDDING_CONFIG;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_EMBEDDING_CONFIG;
    const parsed = JSON.parse(raw) as Partial<EmbeddingProviderConfig>;
    return { ...DEFAULT_EMBEDDING_CONFIG, ...parsed };
  } catch {
    return DEFAULT_EMBEDDING_CONFIG;
  }
}

export function setEmbeddingConfig(config: EmbeddingProviderConfig): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    window.dispatchEvent(new CustomEvent('kumiko:embedding-config-changed', { detail: config }));
  } catch (e) {
    console.warn('[cloudEmbedding] failed to persist config:', e);
  }
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
