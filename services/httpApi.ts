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
  // Phase 4 Part E hydration channels. Phones fetch these once on boot
  // so `<App />` sees PC data / PC API keys rather than empty local state.
  'bootstrap:snapshot',
  'bootstrap:ai-config',
  // Phase 5 Part D: mobile taps on the call overlay buttons route
  // through this synthetic channel. The renderer looks up the active
  // voiceCallOverlayData and invokes the matching closure; the phone
  // just relays the user intent and trusts PC-side state.
  'call:action',
  // Phase 6 Part B: AIConfigScreen on mobile proxies validate + save
  // through the PC renderer so API keys + provider choices remain
  // authoritative on the desktop side. The phone's localStorage is
  // re-synced from bootstrap:ai-config after each save via the
  // ai-config:changed WebSocket event.
  'ai-config:update-from-mobile',
  'ai-config:validate-from-mobile',
  'ai-config:validate-search-from-mobile',
  'ai-config:validate-models-from-mobile',
  // Phase 6 Part C: mobile remote file browser for the AuthScreen LOCAL
  // tab. `fs:*` traverse the PC filesystem inside `mobileBrowseRoot`;
  // `backup:*-desktop-file` read / write / register the backup source.
  // Root mutation (`fs:set-mobile-browse-root`) is PC-renderer-only and
  // deliberately absent from this HTTP allowlist.
  'fs:get-mobile-browse-root',
  'fs:list-directory',
  'fs:get-shortcuts',
  'fs:check-path-exists',
  'backup:read-desktop-file',
  'backup:write-desktop-file',
  'backup:set-desktop-backup-path',
  'backup:disconnect-desktop-file',
  // Read-mostly passthrough to renderer IPC.
  'app:get-weather',
  'app:get-historical-weather',
  'app:get-japan-holidays',
  'app:get-data-directory-info',
  'app:get-auto-zip-backup',
  // Read-only mirror of the desktop electron-updater state. Phones use
  // this on boot to seed `appUpdateState` so the Settings → 应用更新
  // page reflects the current snapshot before the WS `update:state`
  // push arrives. The write side (check / download / quit-and-install)
  // stays PC-only and is intentionally absent from this allowlist.
  'app:update:get-state',
  'images:list',
  'images:get-storage-info',
  'voice:list',
  'voice:get-storage-info',
  'ringtone:get-info',
  'backup:parse-import-file',
  'backup:build-zip-from-payload',
  'mobile-access:get-state',
  'genie:status',
  'genie:test-sovits-python',
  'rag:search',
  'rag:get-messages',
  'rag:get-all',
  'rag:stats',
  'rag:status',
  'rag:rebuild:status',
  'rag:embed',
  'rag:expand-context',
  // Write passthrough (base64 payloads decoded in renderer).
  'images:save',
  'images:delete',
  'voice:save',
  'voice:delete',
  'ringtone:save',
  'ringtone:delete',
  'app:set-auto-zip-backup',
  'genie:start',
  'genie:stop',
  'rag:sync-messages',
  'rag:save',
  'rag:restore',
  'rag:clear-all',
  'rag:clear-message-vectors',
  'rag:rebuild:start',
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

// Phase 5 Part D: return the PWA-reachable URL for the user's custom
// ringtone. There is at most one custom ringtone per user so this
// takes no id — the server's `/media/ringtone` route resolves the
// file based on userData alone. Callers that might also need to
// handle the built-in 01.mp3..08.mp3 bucket should go through
// voiceFileService.resolveRingtoneAudioSource instead; that wrapper
// picks the right flavor (static /ringtones/ vs this HTTP stream).
export function getHttpCustomRingtoneUrl(): string {
  assertMobileContext();
  return `${getApiBaseUrl()}/media/ringtone`;
}

// ── Backup export / import (Phase 3 Part C) ──────────────────────
//
// Phone-side wrappers for the POST /api/backup/export and
// POST /api/backup/import routes. These intentionally bypass the JSON
// IPC bridge because backups can reach hundreds of MB — JSON base64
// would mean 4/3x in-memory bloat on every round trip and would also
// bust the 5MB body limit on the default Fastify instance.

export interface BackupExportResponse {
  ok: boolean;
  blob?: Blob;
  fileName: string;
  imagesIncluded: number;
  imagesTotal: number;
  error?: string;
}

// Post a pre-serialized `dataJsonString` (same JSON that
// handleExportBackup would pass through `backup:build-zip-from-payload`
// on desktop) and download the resulting .zip. The server reads
// userData/images|voice|ringtone directly, so the phone does NOT
// need to upload any media — only the JSON state snapshot.
export async function httpBackupExport(
  dataJsonString: string,
  defaultFileName: string,
): Promise<BackupExportResponse> {
  assertMobileContext();
  const url = `${getApiBaseUrl()}/api/backup/export`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataJsonString, defaultFileName }),
    });
    if (!response.ok) {
      const err = await parseJson(response) as { error?: string } | null;
      return {
        ok: false,
        fileName: defaultFileName,
        imagesIncluded: 0,
        imagesTotal: 0,
        error: (err && err.error) || `HTTP ${response.status}`,
      };
    }
    const blob = await response.blob();
    const imagesIncluded = Number(response.headers.get('X-Images-Included') || 0) || 0;
    const imagesTotal = Number(response.headers.get('X-Images-Total') || 0) || 0;
    return { ok: true, blob, fileName: defaultFileName, imagesIncluded, imagesTotal };
  } catch (e) {
    return {
      ok: false,
      fileName: defaultFileName,
      imagesIncluded: 0,
      imagesTotal: 0,
      error: (e as Error).message || 'Network error',
    };
  }
}

export interface BackupImportResponse {
  ok: boolean;
  result?: {
    success: boolean;
    filePath: string;
    fileName: string;
    json: unknown;
    images: Array<{ id: string; dataUrl: string }>;
    imageCount: number;
  };
  error?: string;
}

// Upload a backup file (zip or json) as raw binary. The server parses
// it via the same `parseBackupImportFile` path that desktop uses, then
// returns the data.json payload + image dataUrls. Voice / ringtone are
// unpacked into userData server-side and are NOT returned in the
// response — the renderer-side import orchestration can simply
// re-resolve voice clips through /media/voices/:id afterward.
export async function httpBackupImport(
  file: Blob,
  fileName: string,
): Promise<BackupImportResponse> {
  assertMobileContext();
  const contentType =
    (file as Blob & { type?: string }).type
    || (fileName.toLowerCase().endsWith('.json') ? 'application/json' : 'application/zip');
  const encodedName = encodeURIComponent(fileName || 'backup.zip');
  const url = `${getApiBaseUrl()}/api/backup/import?fileName=${encodedName}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': contentType },
      body: file,
    });
    const body = await parseJson(response) as BackupImportResponse | null;
    if (!response.ok || !body || body.ok !== true) {
      return {
        ok: false,
        error: (body && body.error) || `HTTP ${response.status}`,
      };
    }
    return body;
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'Network error' };
  }
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
