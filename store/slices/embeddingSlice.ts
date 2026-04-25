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
// Module load ordering (v2.14.17):
//   This slice now imports only from cloudEmbeddingConfig.ts — a pure leaf
//   module with no other imports. The previous v2.14.12 cycle (slice → service
//   → store) is gone: cloudEmbeddingService.ts is the only module that imports
//   useAppStore, and it isn't loaded at slice-construction time. This removes
//   any module-load-time risk to React mount that the cycle could have caused
//   on slow Capacitor WebView starts (suspected v2.14.13/14 booting cause).

import type { StateCreator } from 'zustand';
import {
  DEFAULT_EMBEDDING_CONFIG,
  EMBEDDING_CONFIG_STORAGE_KEY,
  type EmbeddingProviderConfig,
} from '../../services/cloudEmbeddingConfig';

function normalizeEmbeddingConfig(raw: Partial<EmbeddingProviderConfig> | null | undefined): EmbeddingProviderConfig {
  const merged = { ...DEFAULT_EMBEDDING_CONFIG, ...(raw || {}) };
  // Reject corrupt persists where dimensions came back as null / 0 / NaN —
  // those would survive a JSON.parse round trip and silently break the
  // embedding pipeline on the next call. Also reject negative values.
  if (
    typeof merged.dimensions !== 'number' ||
    !Number.isFinite(merged.dimensions) ||
    merged.dimensions <= 0
  ) {
    merged.dimensions = DEFAULT_EMBEDDING_CONFIG.dimensions;
  } else {
    merged.dimensions = Math.round(merged.dimensions);
  }
  return merged;
}

function readInitialEmbeddingConfig(): EmbeddingProviderConfig {
  if (typeof window === 'undefined') return { ...DEFAULT_EMBEDDING_CONFIG };
  try {
    const raw = window.localStorage.getItem(EMBEDDING_CONFIG_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_EMBEDDING_CONFIG };
    return normalizeEmbeddingConfig(JSON.parse(raw) as Partial<EmbeddingProviderConfig>);
  } catch {
    return { ...DEFAULT_EMBEDDING_CONFIG };
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
    const next = normalizeEmbeddingConfig(cfg);
    set({ embeddingConfig: next });
    persistEmbeddingConfig(next);
  },
});
