// services/environment.ts
//
// Runtime environment detection for the renderer. We support three shapes:
//
//   1. Electron desktop: `window.electronAPI` + `window.__KUMIKO_ENV__`
//      are injected by preload.cjs. This is the authoritative build.
//   2. Phone PWA served by the desktop Fastify server (HTTPS via Tailscale
//      or a plain-HTTP LAN access). Detected by probing `/api/status` on
//      module load; the same origin exposes our own HTTP API.
//   3. Legacy / offline web preview (plain Vite `npm run dev` without the
//      Electron wrapper and without the Fastify proxy). `/api/status`
//      returns 404 there, so the probe falls through to `webFallback`.
//
// Phase 7 Part t3_api_probe: `isMobilePwa()` used to gate on
// `location.protocol === 'https:'`, which meant a phone reaching the
// Fastify server over plain HTTP (local LAN, or Tailscale without the
// HTTPS cert deployed) saw every mobile-specific code branch short out,
// so the file picker fell back to `showOpenFilePicker` / `<input
// type="file">` and the user got the iOS system picker instead of the
// remote-file browser. We now:
//
//   1. Synchronously fall back to the HTTPS heuristic so callers during
//      the very first render tick still get a sensible answer (the
//      runtime kind can't change mid-session).
//   2. Kick off a single async `HEAD /api/status` probe at module load,
//      cache the result, and if it disagrees with the sync answer dispatch
//      `kumiko:runtime-changed` so `index.tsx` can force a reload and
//      re-render under the correct runtime.
//   3. Expose `waitForRuntimeDetection()` so the entry bootstrap can
//      `await` the probe before mounting React, eliminating the single
//      render flash where the sync heuristic disagreed with the real
//      runtime.
//
// Electron desktop is NEVER re-evaluated; `isElectron()` short-circuits
// the probe entirely. Desktop behaviour is unchanged — no HTTP hit, no
// event dispatch, no reload.
//
// This module MUST stay synchronous at import time for callers that read
// the runtime during their first render. Any async work is fire-and-forget.

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

// Module-local cache. `null` = probe hasn't resolved yet, use sync fallback.
let cachedRuntime: RuntimeKind | null = null;

// Resolved once the async probe completes (success OR failure). Consumers
// that need to wait for a definitive answer can `await` this.
let runtimeResolved: Promise<RuntimeKind> | null = null;

export function isElectron(): boolean {
  if (typeof window === 'undefined') return false;
  const envBridge = window.__KUMIKO_ENV__;
  if (envBridge && envBridge.runtime === 'electron') return true;
  return typeof (window as unknown as { electronAPI?: { invoke?: unknown } }).electronAPI?.invoke === 'function';
}

function syncFallbackIsMobilePwa(): boolean {
  if (typeof window === 'undefined') return false;
  if (isElectron()) return false;
  const hasHttps = window.location?.protocol === 'https:';
  return hasHttps;
}

async function probeMobilePwa(): Promise<RuntimeKind> {
  if (typeof window === 'undefined') return 'webFallback';
  if (isElectron()) return 'electron';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch('/api/status', {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return 'mobilePwa';
      }
    }
    return 'webFallback';
  } catch {
    return 'webFallback';
  }
}

function startRuntimeProbe() {
  if (runtimeResolved || typeof window === 'undefined') return;
  if (isElectron()) {
    cachedRuntime = 'electron';
    runtimeResolved = Promise.resolve(cachedRuntime);
    return;
  }
  runtimeResolved = probeMobilePwa().then((kind) => {
    const syncFallback = syncFallbackIsMobilePwa() ? 'mobilePwa' : 'webFallback';
    cachedRuntime = kind;
    if (kind !== syncFallback) {
      try {
        window.dispatchEvent(new CustomEvent('kumiko:runtime-changed', {
          detail: { from: syncFallback, to: kind },
        }));
      } catch {
        // CustomEvent failures are non-fatal; callers rely on polling.
      }
    }
    return kind;
  });
}

// Kick off the probe as early as possible (module load).
if (typeof window !== 'undefined') {
  startRuntimeProbe();
}

export function isMobilePwa(): boolean {
  if (typeof window === 'undefined') return false;
  if (isElectron()) return false;
  if (cachedRuntime !== null) return cachedRuntime === 'mobilePwa';
  // Async probe hasn't resolved yet — fall back to the HTTPS heuristic.
  // Caller will be re-rendered once the probe dispatches
  // `kumiko:runtime-changed` if the answers disagree.
  return syncFallbackIsMobilePwa();
}

export function runtimeKind(): RuntimeKind {
  if (isElectron()) return 'electron';
  if (cachedRuntime !== null) return cachedRuntime;
  return syncFallbackIsMobilePwa() ? 'mobilePwa' : 'webFallback';
}

export function waitForRuntimeDetection(): Promise<RuntimeKind> {
  if (isElectron()) return Promise.resolve('electron');
  if (runtimeResolved) return runtimeResolved;
  // Defensive: if for some reason startRuntimeProbe didn't run (e.g. SSR),
  // return the sync fallback immediately.
  return Promise.resolve(syncFallbackIsMobilePwa() ? 'mobilePwa' : 'webFallback');
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
