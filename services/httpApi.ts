// services/httpApi.ts
//
// HTTP shim that mirrors the `electronAPI.invoke(channel, payload)`
// contract on phone PWA builds. The desktop Fastify server exposes a
// 1:1 endpoint at `POST /api/ipc/:channel`; this module wraps that with
// cookie-based session handling and a consistent error surface so
// higher-level services/* code can treat remote and local the same.
//
// Phase 2 grew the allowlist from 3 to ~20 phone-safe channels. The
// source of truth is `electron/server/ipc-bridge.cjs`'s ALLOWED_CHANNELS;
// this set must stay in lockstep with it or the phone will get E_CHANNEL
// before the fastify layer even sees the request. Anything not here
// rejects locally with HttpApiError(code='E_CHANNEL').

import { getApiBaseUrl, isMobilePwa } from './environment';

export class HttpApiError extends Error {
  code: string;
  status: number;
  detail?: unknown;

  constructor(message: string, opts: { code: string; status?: number; detail?: unknown } = { code: 'E_HTTP' }) {
    super(message);
    this.name = 'HttpApiError';
    this.code = opts.code;
    this.status = opts.status ?? 0;
    this.detail = opts.detail;
  }
}

export const PWA_ALLOWED_CHANNELS: ReadonlySet<string> = new Set([
  // Synthetic Dexie-backed channels (served by useMobileApiProxy).
  'ping',
  'chat',
  'messages:recent',
  'messages:search',
  'messages:load-older',
  // Read-mostly passthrough to renderer IPC.
  'app:get-weather',
  'app:get-historical-weather',
  'app:get-japan-holidays',
  'images:list',
  'voice:list',
  'rag:search',
  'rag:get-messages',
  'rag:stats',
  'rag:status',
  'rag:rebuild:status',
  // Write passthrough (base64 payloads decoded in renderer).
  'images:save',
  'images:delete',
  'voice:save',
  'voice:delete',
  'rag:sync-messages',
]);

const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

function assertMobileContext() {
  if (!isMobilePwa()) {
    throw new HttpApiError('httpApi called outside PWA context', { code: 'E_CONTEXT' });
  }
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

interface HttpInvokeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function httpInvoke<TResult = unknown>(
  channel: string,
  args?: unknown,
  options: HttpInvokeOptions = {},
): Promise<TResult> {
  assertMobileContext();
  if (!PWA_ALLOWED_CHANNELS.has(channel)) {
    throw new HttpApiError(`Channel not allowed over HTTP: ${channel}`, { code: 'E_CHANNEL' });
  }
  const url = `${getApiBaseUrl()}/api/ipc/${encodeURIComponent(channel)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  let upstreamSignalCleanup: (() => void) | null = null;
  if (options.signal) {
    const external = options.signal;
    if (external.aborted) controller.abort();
    else {
      const forward = () => controller.abort();
      external.addEventListener('abort', forward, { once: true });
      upstreamSignalCleanup = () => external.removeEventListener('abort', forward);
    }
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args ?? {}),
      signal: controller.signal,
    });
    const body = await parseJson(response);
    if (!response.ok || !body || typeof body !== 'object' || (body as Record<string, unknown>).ok === false) {
      const err = body as { error?: unknown; code?: unknown } | null;
      throw new HttpApiError(
        typeof err?.error === 'string' ? err.error : `HTTP ${response.status}`,
        {
          code: typeof err?.code === 'string' ? err.code : `E_HTTP_${response.status}`,
          status: response.status,
          detail: body,
        },
      );
    }
    return (body as { result: TResult }).result;
  } catch (e) {
    if (e instanceof HttpApiError) throw e;
    if ((e as { name?: string }).name === 'AbortError') {
      throw new HttpApiError('Request aborted', { code: 'E_ABORT' });
    }
    throw new HttpApiError((e as Error).message || 'Network error', { code: 'E_NETWORK' });
  } finally {
    clearTimeout(timeoutId);
    if (upstreamSignalCleanup) upstreamSignalCleanup();
  }
}

export interface PairResult {
  ok: boolean;
  expiresAt?: number;
  error?: string;
}

export async function httpPair(token: string): Promise<PairResult> {
  assertMobileContext();
  const url = `${getApiBaseUrl()}/api/auth/pair`;
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const body = await parseJson(response) as { ok?: boolean; error?: string; expiresAt?: number } | null;
  if (!response.ok || !body || body.ok !== true) {
    return {
      ok: false,
      error: (body && body.error) || `HTTP ${response.status}`,
    };
  }
  return { ok: true, expiresAt: body.expiresAt };
}

export async function httpLogout(): Promise<void> {
  assertMobileContext();
  const url = `${getApiBaseUrl()}/api/auth/logout`;
  try {
    await fetch(url, { method: 'POST', credentials: 'include' });
  } catch {
    // Best-effort; cookie will expire on its own anyway.
  }
}

export interface ServerStatus {
  paired: boolean;
  port: number | null;
  hostname: string | null;
}

export async function httpStatus(): Promise<ServerStatus | null> {
  assertMobileContext();
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/status`, { credentials: 'include' });
    if (!response.ok) return null;
    const body = await parseJson(response) as ServerStatus;
    return body;
  } catch {
    return null;
  }
}

// Returns true iff the current cookie is accepted by the server. Use this
// (not httpStatus().paired) to gate between "show pairing screen" and
// "proceed to chat"; /api/status is public and can't see our cookie.
export async function httpCheckSession(): Promise<boolean> {
  assertMobileContext();
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/auth/me`, { credentials: 'include' });
    return response.ok;
  } catch {
    return false;
  }
}

// Resolve a phone-visible URL for a userData image id. Desktop code uses
// the `kumiko-image://` protocol; PWA code must fall through to HTTP.
// Callers that don't know their runtime should go through the wrapper
// in imageService.ts instead of calling this directly.
export function getHttpImageUrl(imageId: string): string {
  assertMobileContext();
  return `${getApiBaseUrl()}/media/images/${encodeURIComponent(imageId)}`;
}

// Voice counterpart of getHttpImageUrl. The desktop side reaches voice
// clips via ipcRenderer.invoke('voice:load', ...); the PWA uses this
// directly against an <audio> element.
export function getHttpVoiceUrl(voiceFileId: string): string {
  assertMobileContext();
  return `${getApiBaseUrl()}/media/voices/${encodeURIComponent(voiceFileId)}`;
}

// ── WebSocket event subscription (Phase 2) ─────────────────────────
//
// Opens wss:// to the desktop and forwards every parsed event to
// `handler`. Handles reconnect with exponential backoff (1s → 30s cap)
// and Page Visibility resume. Returns an unsubscribe function that
// closes the socket and disables reconnection.

export interface MobileEvent {
  type: string;
  [key: string]: unknown;
}

export interface SubscribeOptions {
  onOpen?: () => void;
  onClose?: (reason: string) => void;
  onError?: (err: Error) => void;
}

export function subscribeEvents(
  handler: (event: MobileEvent) => void,
  options: SubscribeOptions = {},
): () => void {
  assertMobileContext();

  let socket: WebSocket | null = null;
  let closed = false;
  let backoffMs = 1000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Keepalive timer. Some middleboxes idle-kill sockets at 30s; we send
  // a cheap JSON ping every 20s so both sides remain sure the pipe is
  // alive and both sides get a chance to notice a drop.
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  const apiBase = getApiBaseUrl();
  const wsUrl = apiBase.replace(/^http/i, 'ws') + '/ws';

  function scheduleReconnect() {
    if (closed) return;
    if (reconnectTimer) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, 30_000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (closed) return;
    try {
      socket = new WebSocket(wsUrl);
    } catch (e) {
      options.onError?.(e as Error);
      scheduleReconnect();
      return;
    }
    socket.onopen = () => {
      backoffMs = 1000; // reset on a successful connection
      options.onOpen?.();
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      keepaliveTimer = setInterval(() => {
        try {
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'ping', nonce: Date.now() }));
          }
        } catch { /* ignore */ }
      }, 20_000);
    };
    socket.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        if (parsed && typeof parsed === 'object' && typeof (parsed as MobileEvent).type === 'string') {
          handler(parsed as MobileEvent);
        }
      } catch {
        // non-JSON frames are ignored; server never sends them.
      }
    };
    socket.onerror = (ev) => {
      options.onError?.(new Error((ev as ErrorEvent).message || 'WebSocket error'));
    };
    socket.onclose = (ev) => {
      options.onClose?.(ev.reason || `code ${ev.code}`);
      socket = null;
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      scheduleReconnect();
    };
  }

  connect();

  // When the page becomes visible again after a long backgrounding,
  // immediately retry instead of waiting out the current backoff. Phones
  // often kill background WSS connections silently, so this keeps the
  // feel-good "pull to refresh is instant" property.
  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        backoffMs = 1000;
        connect();
      }
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    closed = true;
    document.removeEventListener('visibilitychange', onVisibility);
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    if (socket) {
      try { socket.close(1000, 'client unsubscribe'); } catch { /* ignore */ }
      socket = null;
    }
  };
}
