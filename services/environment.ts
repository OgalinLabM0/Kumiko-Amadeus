// services/environment.ts
//
// Runtime environment detection for the renderer. We support three shapes:
//
//   1. Electron desktop: `window.electronAPI` + `window.__KUMIKO_ENV__`
//      are injected by preload.cjs. This is the authoritative build.
//   2. Phone PWA served by the desktop Fastify server: no electronAPI,
//      but `location.pathname` is served from the same origin that
//      exposes `/api/*`. We treat any non-Electron origin that accepts
//      our HTTP calls as "mobile PWA".
//   3. Legacy / offline web preview (plain Vite dev server on port 3000
//      without the Electron wrapper): no electronAPI either. Kept as a
//      distinct case because HTTP proxy calls will fail, which is
//      diagnosable rather than a regression.
//
// This module MUST stay side-effect-free and synchronous at import time.
// UI components rely on environment detection during their first render
// to decide which code path to wire up.

export type RuntimeKind = 'electron' | 'mobilePwa' | 'webFallback';

interface KumikoEnvBridge {
  runtime?: string;
  platform?: string;
}

declare global {
  interface Window {
    __KUMIKO_ENV__?: KumikoEnvBridge;
  }
}

export function isElectron(): boolean {
  if (typeof window === 'undefined') return false;
  const envBridge = window.__KUMIKO_ENV__;
  if (envBridge && envBridge.runtime === 'electron') return true;
  // Belt-and-braces fallback: the preload may be missing if we ever ship
  // a dev mode without the bridge, but window.electronAPI.invoke is a
  // strong signal on its own.
  return typeof (window as unknown as { electronAPI?: { invoke?: unknown } }).electronAPI?.invoke === 'function';
}

export function isMobilePwa(): boolean {
  if (typeof window === 'undefined') return false;
  if (isElectron()) return false;
  // Anything served from https:// under Tailscale by our own Fastify is
  // treated as PWA. We don't try to distinguish the genuine "installed
  // to home screen" case from Safari tab mode — both should act the
  // same. `location.protocol === 'https:'` filters out the plain
  // `npm run dev` fallback below.
  const hasHttps = window.location?.protocol === 'https:';
  return hasHttps;
}

export function runtimeKind(): RuntimeKind {
  if (isElectron()) return 'electron';
  if (isMobilePwa()) return 'mobilePwa';
  return 'webFallback';
}

// The base URL for HTTP proxy calls. In PWA mode this is always the
// current origin; in Electron / web fallback mode it's unused but kept
// stable so callers don't have to branch.
export function getApiBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  return window.location?.origin || '';
}

export function getPlatformHint(): string {
  if (typeof window === 'undefined') return 'unknown';
  return window.__KUMIKO_ENV__?.platform || 'browser';
}
