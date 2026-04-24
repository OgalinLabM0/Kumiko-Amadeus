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
  // Capacitor native (iOS / Android wrapper APK) is always treated as
  // mobilePwa — it uses the same HTTP bridge as the PWA, the only
  // difference is `getApiBaseUrl()` resolves to a user-configured PC
  // URL kept in localStorage instead of `window.location.origin`. We
  // do NOT probe `/api/status` here because the WebView origin is
  // `capacitor://localhost`, where the path 404s and the probe would
  // misclassify the runtime as `webFallback`.
  if (isCapacitorNative()) return 'mobilePwa';
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
  // A.2: Capacitor standalone — user explicitly chose "no PC, run
  // independently" from the pairing gate. Treat as NOT mobilePwa so
  // every legacy PC-bridge dispatch (TTS proxy / preferences sync /
  // backup HTTP / RAG IPC / etc.) short-circuits to the Capacitor-local
  // branches we already shipped in A2-A5. This is the runtime that
  // unblocks "Android = independent client" semantically.
  if (isCapacitorStandalone()) return false;
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

// ── Capacitor native (iOS / Android APK) detection + PC URL storage ──
//
// PWA path: the page is served by PC's Fastify, so `window.location.origin`
//   already points at the PC and `getApiBaseUrl()` works without config.
// Capacitor path: the WebView origin is `capacitor://localhost`, which
//   is the APK's own asset bundle. To talk to PC we need the user's PC
//   address (LAN `http://192.168.x.x:3000`, Tailscale `http://100.64.x.x:3000`,
//   or `https://<host>.<tailnet>.ts.net` once the cert ships). MobilePairingGate
//   collects this once on first launch via the `configure-pc-url` view and
//   pins it to localStorage.

const CAPACITOR_PC_BASE_URL_KEY = 'kumiko_capacitor_pc_url';

// A.2 standalone sentinel: written into CAPACITOR_PC_BASE_URL_KEY when
// the user opts into "no PC, run independently" from the pairing gate.
// Any non-URL string here means standalone. We pick a deliberately
// invalid URL prefix so a stray future call to fetch() against this
// value can't accidentally hit a real host.
const CAPACITOR_STANDALONE_SENTINEL = '__standalone__';

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

function readCapacitorGlobal(): CapacitorGlobal | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

export function isCapacitorNative(): boolean {
  const cap = readCapacitorGlobal();
  if (!cap) return false;
  if (typeof cap.isNativePlatform === 'function') return cap.isNativePlatform();
  if (typeof cap.getPlatform === 'function') return cap.getPlatform() !== 'web';
  return false;
}

export type CapacitorPlatform = 'ios' | 'android' | 'web' | 'unknown';

export function getCapacitorPlatform(): CapacitorPlatform {
  const cap = readCapacitorGlobal();
  if (!cap || typeof cap.getPlatform !== 'function') return 'unknown';
  const p = cap.getPlatform();
  if (p === 'ios' || p === 'android' || p === 'web') return p;
  return 'unknown';
}

export function getCapacitorPcBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  if (!isCapacitorNative()) return '';
  try {
    const raw = window.localStorage.getItem(CAPACITOR_PC_BASE_URL_KEY);
    if (typeof raw !== 'string') return '';
    const trimmed = raw.trim();
    // Standalone sentinel masquerades as "no URL" for callers that just
    // want to know "do we have a real PC URL to hit?". Use isCapacitorStandalone()
    // to disambiguate "user picked standalone" vs "first launch, never set".
    if (trimmed === CAPACITOR_STANDALONE_SENTINEL) return '';
    return trimmed.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function setCapacitorPcBaseUrl(url: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (!url) {
      window.localStorage.removeItem(CAPACITOR_PC_BASE_URL_KEY);
      return;
    }
    const cleaned = url.trim().replace(/\/+$/, '');
    window.localStorage.setItem(CAPACITOR_PC_BASE_URL_KEY, cleaned);
  } catch {
    // localStorage may be unavailable in some webviews; the next launch
    // will simply re-prompt for the URL, which is the same behavior as
    // a first install.
  }
}

/**
 * A.2: user picked "skip, run standalone" from the pairing gate.
 * Returns true ONLY on Capacitor AND when the standalone sentinel has
 * been pinned. Used by isMobilePwa() to short-circuit the HTTP-bridge
 * runtime kind into a no-PC mode, which in turn cuts every PC-proxy
 * dispatch (TTS, RAG, weather, backup) over to the local Capacitor
 * branch we already shipped in A2-A5.
 */
export function isCapacitorStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (!isCapacitorNative()) return false;
  try {
    const raw = window.localStorage.getItem(CAPACITOR_PC_BASE_URL_KEY);
    return typeof raw === 'string' && raw.trim() === CAPACITOR_STANDALONE_SENTINEL;
  } catch {
    return false;
  }
}

export function setCapacitorStandalone(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CAPACITOR_PC_BASE_URL_KEY, CAPACITOR_STANDALONE_SENTINEL);
  } catch {
    // ignore
  }
}

/**
 * A.3 helper: returns true for ANY mobile-like runtime — PWA paired
 * with PC OR Capacitor native APK (paired or standalone). Use this
 * when the decision is "should we apply mobile-screen UX tweaks?"
 * (audio autoplay unlock, viewport sizing caches, OS badge, mobile
 * action sheet styles, etc.) — anywhere the runtime is "phone /
 * tablet WebView" regardless of whether a PC is upstream.
 *
 * DON'T use this for "should we route through PC's HTTP bridge?" —
 * those checks must stay on plain `isMobilePwa()`, which already
 * returns false in Capacitor standalone mode (see comment there).
 */
export function isMobileLikeRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  if (isElectron()) return false;
  if (isCapacitorNative()) return true;
  return isMobilePwa();
}

// The base URL for HTTP proxy calls. In PWA mode this is always the
// current origin (PC's Fastify); in Capacitor mode it's the user-configured
// PC URL (empty until the gate's `configure-pc-url` view collects it,
// in which case all httpInvoke / httpStatus calls fail fast — that
// failure is what tells the gate to render the URL input view).
// Electron / web fallback callers never hit this branch.
export function getApiBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  if (isCapacitorNative()) return getCapacitorPcBaseUrl();
  return window.location?.origin || '';
}

export function getPlatformHint(): string {
  if (typeof window === 'undefined') return 'unknown';
  return window.__KUMIKO_ENV__?.platform || 'browser';
}
