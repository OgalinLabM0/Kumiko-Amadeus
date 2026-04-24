// services/environment.ts
//
// Runtime detection for the renderer. After F2B.3 there are exactly two
// supported runtime shapes (plus a "neither" web preview that exists only
// for `npm run dev` smoke-tests):
//
//   1. Electron desktop: `window.electronAPI` + `window.__KUMIKO_ENV__`
//      are injected by preload.cjs.
//   2. Capacitor native (Android APK): `window.Capacitor` is set by the
//      WebView bootstrap and `Capacitor.isNativePlatform()` returns true.
//
// The legacy "phone PWA paired with PC's Fastify server" runtime is gone
// (along with `services/httpApi.ts` and `MobilePairingGate`). Anything
// that used to gate on `isMobilePwa()` should now choose between
// Electron and Capacitor explicitly.

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
  return typeof (window as unknown as { electronAPI?: { invoke?: unknown } }).electronAPI?.invoke === 'function';
}

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

/**
 * True for any phone-class runtime — currently only Capacitor native.
 * Use this when the decision is "should we apply mobile-screen UX
 * tweaks?" (audio autoplay unlock, viewport sizing caches, OS badge,
 * mobile action sheet styles, etc.). Desktop Electron always returns
 * false; web preview returns false too because there is no longer a
 * supported pure-PWA target.
 */
export function isMobileLikeRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  if (isElectron()) return false;
  return isCapacitorNative();
}

export function getPlatformHint(): string {
  if (typeof window === 'undefined') return 'unknown';
  return window.__KUMIKO_ENV__?.platform || 'browser';
}
