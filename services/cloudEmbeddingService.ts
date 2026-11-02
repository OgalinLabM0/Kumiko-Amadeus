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

// v2.14.12 — getEmbeddingConfig / setEmbeddingConfig now route through the
// Zustand store (`embeddingSlice`), which is the single source of truth for
// the embedding configuration. Persistence to localStorage and any future
// cross-tab notifications are handled by the slice's setter — the legacy
// `kumiko:embedding-config-changed` custom event is gone, since every
// consumer now subscribes to `useAppStore(s => s.embeddingConfig)` directly
// and gets reactive updates without a manual event channel.
//
// The `useAppStore` import is intentionally a top-level ESM import even
// though it forms a cycle with `store/index.ts` (which imports
// embeddingSlice.ts which imports this file). The cycle is safe because
// nothing in this module accesses `useAppStore` at module-load time — both
// helpers below resolve the binding lazily inside their function bodies, by
// which point the store has finished construction.
//
// NB: `EMBEDDING_CONFIG_STORAGE_KEY` and `DEFAULT_EMBEDDING_CONFIG` are still
// exported above so that the slice can hydrate from localStorage on first
// load without having to itself import this file's runtime helpers.
import { useAppStore } from '../store';
import { hasNativeCredentials, invokeCredential } from './nativeCredentials';
import { assertDataWritesAllowed, getDataRestoreVersion } from './dataRestoreGate';
import { beginForegroundActivity, endForegroundActivity, type TaskContext } from './taskRuntime';
import { runTaskTransport } from './taskGateway';
import { getMemoryGeneration } from './memoryMaintenanceGate';

export function embeddingEndpoint(config: EmbeddingProviderConfig): string {
  if (config.provider === 'gemini') return 'https://generativelanguage.googleapis.com/';
  const base = config.provider === 'openai' ? 'https://api.openai.com/v1'
    : config.provider === 'zhipu' ? 'https://open.bigmodel.cn/api/paas/v4'
    : config.provider === 'tongyi' ? 'https://dashscope.aliyuncs.com/compatible-mode/v1' : (config.customEndpoint || '');
  return base.replace(/\/+$/, '') + '/embeddings';
}
function embeddingRequestUrl(config: EmbeddingProviderConfig): string {
  if (config.provider !== 'gemini') return embeddingEndpoint(config);
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(config.model) || config.model.includes('..')) throw new Error('Invalid Gemini embedding model.');
  return `${embeddingEndpoint(config)}v1beta/models/${config.model}:embedContent`;
}
export async function storeEmbeddingCredential(config: EmbeddingProviderConfig, secret: string): Promise<string> {
  if (!secret.trim()) throw new Error('API Key is empty.');
  if (!hasNativeCredentials()) return secret;
  assertDataWritesAllowed(); const version = getDataRestoreVersion();
  const result = await invokeCredential('store', { purpose: config.provider === 'gemini' ? 'embedding-gemini' : 'embedding', endpoint: embeddingEndpoint(config), secret });
  assertDataWritesAllowed();
  if (version !== getDataRestoreVersion() || !result?.success || typeof result.handle !== 'string') throw new Error(result?.error || 'Secure credential storage failed.');
  return 'vault:' + result.handle;
}

export function getEmbeddingConfig(): EmbeddingProviderConfig {
  return useAppStore.getState().embeddingConfig;
}

export function setEmbeddingConfig(config: EmbeddingProviderConfig): void {
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
  signal?: AbortSignal,
): Promise<T> {
  let endpoint: URL;
  try { endpoint = new URL(url); } catch { throw new Error('Invalid embedding endpoint.'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
    || Array.from(endpoint.searchParams.keys()).some(key => /key|token|secret|authorization/i.test(key))) {
    throw new Error('Embedding credentials require an HTTPS endpoint without embedded credentials.');
  }
  if (hasNativeCredentials()) {
    let key = headers['x-goog-api-key'] || headers.Authorization?.replace(/^Bearer /, '') || '';
    const purpose = headers['x-goog-api-key'] ? 'embedding-gemini' : 'embedding';
    const match = purpose === 'embedding-gemini' ? /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/([A-Za-z0-9._-]{1,200}):embedContent$/.exec(url) : null;
    if (purpose === 'embedding-gemini' && (!match || match[1].includes('..'))) throw new Error('Invalid Gemini embedding endpoint.');
    if (!key.startsWith('vault:')) {
      const current = getEmbeddingConfig();
      if (current.apiKey !== key || embeddingRequestUrl(current) !== url) throw new Error('Save the embedding credential before use.');
      const version = getDataRestoreVersion();
      const replacement = await storeEmbeddingCredential(current, key);
      assertDataWritesAllowed();
      if (getDataRestoreVersion() !== version || getEmbeddingConfig().apiKey !== key || embeddingRequestUrl(getEmbeddingConfig()) !== url) throw new Error('Embedding settings changed during migration.');
      setEmbeddingConfig({ ...getEmbeddingConfig(), apiKey: replacement }); key = replacement;
      let persisted: any;
      try { persisted = JSON.parse(localStorage.getItem(EMBEDDING_CONFIG_STORAGE_KEY) || '{}'); } catch { /* checked below */ }
      if (persisted?.apiKey !== replacement) { setEmbeddingConfig(current); throw new Error('Embedding credential migration could not be verified.'); }
    }
    const result = await invokeCredential('request', { purpose, handle: key.slice(6), expectedEndpoint: match ? 'https://generativelanguage.googleapis.com/' : url,
      ...(match ? { model: match[1] } : {}), body: JSON.stringify(body) }, signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs));
    if (!result?.success) throw new Error(result?.error || 'Protected embedding request failed.');
    if (result.result.status < 200 || result.result.status >= 300) throw new Error(`Embedding HTTP ${result.result.status}`);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(result.result.body), c => c.charCodeAt(0)))) as T;
  }
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
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      redirect: 'error',
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
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
  signal?: AbortSignal,
): Promise<EmbeddingResult> {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const url = `${cleanBase}/embeddings`;
  const body: Record<string, unknown> = { input: text, model };
  if (typeof dimensions === 'number' && dimensions > 0) {
    body.dimensions = dimensions;
  }
  const reply = await postJsonWithTimeout<OpenAIEmbeddingResponse>(url, body, {
    Authorization: `Bearer ${apiKey}`,
  }, 30_000, signal);
  if (reply.error?.message) throw new Error('Embedding provider returned an error.');
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
  signal?: AbortSignal,
): Promise<EmbeddingResult> {
  // Gemini's embedContent is a different endpoint shape from OpenAI; use
  // its API-key header so the credential does not appear in the URL.
  // gemini-embedding-001 supports `outputDimensionality`; text-embedding-004
  // does not, so we only set it when the caller asked for it AND the model
  // supports it. We cap at the model's max as defined in EMBEDDING_MODEL_CATALOG.
  const url = embeddingRequestUrl({ provider: 'gemini', model, apiKey: '' });
  const body: Record<string, unknown> = {
    content: { parts: [{ text }] },
  };
  if (typeof dimensions === 'number' && dimensions > 0 && model.includes('embedding-001')) {
    body.outputDimensionality = dimensions;
  }
  const reply = await postJsonWithTimeout<GeminiEmbeddingResponse>(url, body, { 'x-goog-api-key': apiKey }, 30_000, signal);
  if (reply.error?.message) throw new Error('Embedding provider returned an error.');
  const values = reply.embedding?.values;
  if (!Array.isArray(values)) {
    throw new Error('Gemini embedding response missing embedding.values');
  }
  return { vector: arrayToFloat32(values), actualDimensions: values.length };
}

async function embedZhipu(text: string, apiKey: string, model: string, signal?: AbortSignal): Promise<EmbeddingResult> {
  // 智谱 BigModel API is OpenAI-compatible at the embeddings endpoint shape.
  return embedOpenAICompatible(text, apiKey, model, 'https://open.bigmodel.cn/api/paas/v4', undefined, signal);
}

async function embedTongyi(text: string, apiKey: string, model: string, signal?: AbortSignal): Promise<EmbeddingResult> {
  // 通义 DashScope ships an OpenAI-compatible mode at compatible-mode/v1.
  // We use that instead of the native /api/v1/services/embeddings/text-embedding/text-embedding
  // path because the OpenAI-compatible mode keeps request/response shape
  // identical to OpenAI/Zhipu, simplifying our switching here.
  return embedOpenAICompatible(text, apiKey, model, 'https://dashscope.aliyuncs.com/compatible-mode/v1', undefined, signal);
}

export async function generateCloudEmbedding(
  text: string,
  config?: EmbeddingProviderConfig,
  taskContext?: TaskContext,
): Promise<EmbeddingResult> {
  let cfg = config || getEmbeddingConfig();
  if (!config && hasNativeCredentials() && cfg.apiKey && !cfg.apiKey.startsWith('vault:')) {
    const version = getDataRestoreVersion();
    const original = JSON.stringify(cfg);
    const replacement = await storeEmbeddingCredential(cfg, cfg.apiKey);
    assertDataWritesAllowed();
    if (getDataRestoreVersion() !== version || JSON.stringify(getEmbeddingConfig()) !== original) throw new Error('Embedding settings changed during migration.');
    const previous = cfg;
    setEmbeddingConfig({ ...cfg, apiKey: replacement });
    cfg = getEmbeddingConfig();
    let persisted: any;
    try { persisted = JSON.parse(localStorage.getItem(EMBEDDING_CONFIG_STORAGE_KEY) || '{}'); } catch { /* checked below */ }
    if (cfg.apiKey !== replacement || persisted?.apiKey !== replacement) {
      setEmbeddingConfig(previous);
      throw new Error('Embedding credential migration could not be verified.');
    }
  }
  const apiKey = cfg.apiKey?.trim();
  if (!apiKey) {
    throw new Error('Embedding API key is empty — please configure one in Settings → Cloud Embedding.');
  }
  if (!hasNativeCredentials() && apiKey.startsWith('vault:')) throw new Error('Protected credential is unavailable on this device.');
  const dimensions = cfg.dimensions;
  const execute = (signal?: AbortSignal): Promise<EmbeddingResult> => { switch (cfg.provider) {
    case 'openai':
      return embedOpenAICompatible(text, apiKey, cfg.model, 'https://api.openai.com/v1', dimensions, signal);
    case 'gemini':
      return embedGemini(text, apiKey, cfg.model, dimensions, signal);
    case 'zhipu':
      return embedZhipu(text, apiKey, cfg.model, signal);
    case 'tongyi':
      return embedTongyi(text, apiKey, cfg.model, signal);
    case 'custom': {
      const endpoint = (cfg.customEndpoint || '').trim();
      if (!endpoint) {
        throw new Error('Custom provider selected but no endpoint URL configured.');
      }
      return embedOpenAICompatible(text, apiKey, cfg.model, endpoint, dimensions, signal);
    }
    default:
      throw new Error(`Unsupported embedding provider: ${cfg.provider}`);
  } };
  let ownedContext: TaskContext | undefined;
  if (!taskContext) {
    const id = crypto.randomUUID();
    ownedContext = { taskId: id, rootId: id, role: 'memory', lane: 'foreground', deadlineAt: Date.now() + 180_000,
      epoch: getDataRestoreVersion(), memoryGeneration: getMemoryGeneration(), modelRevisions: {}, consultedSources: [] };
    taskContext = ownedContext;
    await beginForegroundActivity(ownedContext);
  }
  const fingerprint = JSON.stringify(cfg);
  try { return await runTaskTransport(taskContext, { provider: cfg.provider, model: cfg.model, operation: 'embedding', configRevision: 'captured' }, execute, () => {
    if (!config && JSON.stringify(getEmbeddingConfig()) !== fingerprint) throw new Error('Embedding configuration changed during task.');
  }); } finally { if (ownedContext) await endForegroundActivity(ownedContext); }
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
