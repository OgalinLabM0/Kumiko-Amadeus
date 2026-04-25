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

export const EMBEDDING_CONFIG_STORAGE_KEY = 'kumiko_embedding_config';

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingProviderConfig = {
  provider: 'openai',
  apiKey: '',
  model: 'text-embedding-3-small',
  dimensions: 768,
};

// Catalog of model presets per provider, surfaced by EmbeddingConfigSection.tsx
// for the dropdown. `dimensions` here is the model's native dimension; users
// can override via the explicit dimensions field below the model picker.
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
