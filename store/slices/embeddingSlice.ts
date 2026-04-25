// store/slices/embeddingSlice.ts
//
// v2.14.12 — Single source of truth for the Cloud Embedding configuration.
//
// Why this slice exists:
//   Pre-v2.14.12 the embedding config lived only in localStorage, and the two
//   places that show the form (AIConfigScreen first-launch wizard +
//   SettingsPanel ApiConfigSection) each kept their own `useState` initialised
//   from `getEmbeddingConfig()` and stayed in sync via a `kumiko:embedding-
//   config-changed` custom-event broadcast. That pattern was fragile in three
//   ways:
//     (a) the side-effect `setEmbeddingConfig(next)` was wedged inside a
//         `setConfig((prev) => { ... })` updater, which React 19 StrictMode /
//         concurrent rendering can re-invoke an arbitrary number of times;
//     (b) two `useState` mirrors meant a missed event = silent divergence;
//     (c) WebView localStorage corner cases (quota, isolation, kill+restart)
//         were swallowed by the try/catch and produced silent default-fallback
//         reads. Reported by the user: "在开始页面配置好了测试通过了，结果设置
//         页面这边是默认面板."
//
//   Lifting the config into the Zustand store removes the dual-state pattern
//   entirely. Both forms now subscribe to the same `embeddingConfig` selector
//   and stay in sync without any event plumbing. localStorage is downgraded
//   from "source of truth" to "persistence sink" — written once on every
//   setter call so the value survives WebView reloads, but never read after
//   the initial hydrate.
//
// Module load ordering note:
//   This slice imports config-only values from cloudEmbeddingConfig.ts, not
//   cloudEmbeddingService.ts. The service may import the root store at runtime;
//   the slice must remain a leaf of that graph so hydration cannot be affected
//   by module-cycle timing.

import type { StateCreator } from 'zustand';
import {
  DEFAULT_EMBEDDING_CONFIG,
  EMBEDDING_CONFIG_STORAGE_KEY,
  type EmbeddingProviderConfig,
} from '../../services/cloudEmbeddingConfig';

let loggedHydrate = false;
let loggedSetter = false;

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

function describeEmbeddingConfig(config: EmbeddingProviderConfig) {
  return {
    provider: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    hasApiKey: !!config.apiKey.trim(),
    hasCustomEndpoint: !!config.customEndpoint?.trim(),
  };
}

function readInitialEmbeddingConfig(): EmbeddingProviderConfig {
  if (typeof window === 'undefined') return DEFAULT_EMBEDDING_CONFIG;
  try {
    const raw = window.localStorage.getItem(EMBEDDING_CONFIG_STORAGE_KEY);
    if (!raw) return DEFAULT_EMBEDDING_CONFIG;
    const parsed = JSON.parse(raw) as Partial<EmbeddingProviderConfig>;
    const normalized = normalizeEmbeddingConfig(parsed);
    if (!loggedHydrate) {
      console.log('[embeddingSlice] hydrated embeddingConfig from localStorage:', describeEmbeddingConfig(normalized));
      loggedHydrate = true;
    }
    return normalized;
  } catch {
    return DEFAULT_EMBEDDING_CONFIG;
  }
}

function persistEmbeddingConfig(cfg: EmbeddingProviderConfig): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(EMBEDDING_CONFIG_STORAGE_KEY, JSON.stringify(cfg));
  } catch (e) {
    console.warn('[embeddingSlice] localStorage persist failed:', e);
  }
}

export interface EmbeddingSlice {
  embeddingConfig: EmbeddingProviderConfig;
  setEmbeddingConfig: (cfg: EmbeddingProviderConfig) => void;
}

export const createEmbeddingSlice: StateCreator<EmbeddingSlice, [], [], EmbeddingSlice> = (set) => ({
  embeddingConfig: readInitialEmbeddingConfig(),
  setEmbeddingConfig: (cfg) => {
    if (!loggedSetter) {
      console.log('[embeddingSlice] setEmbeddingConfig:', describeEmbeddingConfig(cfg));
      loggedSetter = true;
    }
    set({ embeddingConfig: cfg });
    persistEmbeddingConfig(cfg);
  },
});
