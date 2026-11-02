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
//   This slice imports `EmbeddingProviderConfig`, `DEFAULT_EMBEDDING_CONFIG`,
//   and `EMBEDDING_CONFIG_STORAGE_KEY` from cloudEmbeddingService.ts at module
//   load. cloudEmbeddingService.ts in turn imports `useAppStore` from the root
//   store entry — the cycle is safe because cloudEmbeddingService only
//   *references* useAppStore inside function bodies (resolved at call time,
//   not at module-load time), and the slice never calls back into
//   cloudEmbeddingService during initialisation.

import type { StateCreator } from 'zustand';
import { hasNativeCredentials } from '../../services/nativeCredentials';
import { assertDataWritesAllowed } from '../../services/dataRestoreGate';
import {
  DEFAULT_EMBEDDING_CONFIG,
  EMBEDDING_CONFIG_STORAGE_KEY,
  type EmbeddingProviderConfig,
} from '../../services/cloudEmbeddingService';

function readInitialEmbeddingConfig(): EmbeddingProviderConfig {
  if (typeof window === 'undefined') return DEFAULT_EMBEDDING_CONFIG;
  try {
    const raw = window.localStorage.getItem(EMBEDDING_CONFIG_STORAGE_KEY);
    if (!raw) return DEFAULT_EMBEDDING_CONFIG;
    const parsed = JSON.parse(raw) as Partial<EmbeddingProviderConfig>;
    return { ...DEFAULT_EMBEDDING_CONFIG, ...parsed };
  } catch {
    return DEFAULT_EMBEDDING_CONFIG;
  }
}

function persistEmbeddingConfig(cfg: EmbeddingProviderConfig): void {
  if (typeof window === 'undefined') return;
  try {
    let persisted = cfg;
    if (!hasNativeCredentials()) {
      const raw = window.localStorage.getItem(EMBEDDING_CONFIG_STORAGE_KEY);
      const previous = JSON.parse(raw || '{}') as Partial<EmbeddingProviderConfig>;
      if (raw && previous.apiKey) {
        const archiveKey = 'kumiko_legacy_embedding_config_' + crypto.randomUUID();
        window.localStorage.setItem(archiveKey, raw);
        if (window.localStorage.getItem(archiveKey) !== raw) throw new Error('Existing embedding credential could not be preserved.');
      }
      persisted = { ...cfg, apiKey: '' };
    }
    window.localStorage.setItem(EMBEDDING_CONFIG_STORAGE_KEY, JSON.stringify(persisted));
  } catch (e) {
    throw new Error('Embedding settings could not be saved.');
  }
}

export interface EmbeddingSlice {
  embeddingConfig: EmbeddingProviderConfig;
  setEmbeddingConfig: (cfg: EmbeddingProviderConfig) => void;
}

export const createEmbeddingSlice: StateCreator<EmbeddingSlice, [], [], EmbeddingSlice> = (set, get) => ({
  embeddingConfig: readInitialEmbeddingConfig(),
  setEmbeddingConfig: (cfg) => {
    assertDataWritesAllowed();
    const previous = get().embeddingConfig;
    if (previous?.apiKey && cfg.apiKey === previous.apiKey
      && (cfg.provider !== previous.provider || (cfg.provider === 'custom' && cfg.customEndpoint !== previous.customEndpoint))) {
      // Preserve both the currently effective configuration and any distinct
      // persisted predecessor before removing its key from the active binding.
      if (typeof window === 'undefined') throw new Error('Cannot safely preserve existing embedding credentials.');
      const raw = window.localStorage.getItem(EMBEDDING_CONFIG_STORAGE_KEY);
      // Browser session keys must never be copied into a persistent archive.
      // Only preserve bytes that were already stored there by an older build.
      const candidates = [...new Set([raw, hasNativeCredentials() ? JSON.stringify(previous) : null]
        .filter((value): value is string => !!value))];
      for (const value of candidates) {
        const archiveKey = 'kumiko_legacy_embedding_config_' + crypto.randomUUID();
        window.localStorage.setItem(archiveKey, value);
        if (window.localStorage.getItem(archiveKey) !== value) throw new Error('Existing embedding credentials could not be preserved.');
      }
      cfg = { ...cfg, apiKey: '' };
    }
    persistEmbeddingConfig(cfg);
    set({ embeddingConfig: cfg });
  },
});
