// electron/server/ipc-bridge.cjs
//
// Proxy layer between the mobile Fastify server (main process) and the
// Electron renderer that owns Dexie / all renderer-bound business logic.
// Every HTTP request that needs renderer-side state resolves through here:
//
//   Phone HTTP → Fastify route → ipcBridge.dispatch(channel, args)
//     → webContents.send('mobile-api-proxy', { requestId, channel, args })
//     → renderer handler runs (reusing existing services/* code)
//     → renderer ipcRenderer.send('mobile-api-proxy-reply', { requestId, payload })
//     → we resolve the pending Promise and the Fastify route sends JSON back
//
// The contract is deliberately narrow in Phase 1:
//   - Only three "channels" are live (`ping`, `chat`, `messages:recent`);
//     Phase 2 broadens the whitelist to the full IPC surface.
//   - Renderer handlers MUST reply even on error (shape:
//     { ok: false, error: string }). Silent handlers trip the timeout
//     and return a 504 to the phone — this is intentional, it keeps
//     the bridge self-diagnosing.

'use strict';

const crypto = require('crypto');
const { ipcMain } = require('electron');

// Channel whitelist. Anything the mobile PWA might plausibly call goes
// here; everything else rejects with E_CHANNEL before we even consider
// dispatching to the renderer. Categories:
//
//   Synthetic Dexie-backed (renderer-only, never passes through
//   electronAPI.invoke):
//     ping, chat, messages:recent, messages:search, messages:load-older
//
//   Read-mostly passthrough to existing renderer invoke channels:
//     app:get-weather, app:get-historical-weather, app:get-japan-holidays
//     app:get-data-directory-info, app:get-auto-zip-backup
//     app:update:get-state (read-only mirror of electron-updater state;
//       the *write* side — app:update:check / app:update:download /
//       app:update:quit-and-install — stays PC-only and is listed below)
//     images:list, images:get-storage-info
//     voice:list, voice:get-storage-info
//     ringtone:get-info
//     backup:parse-import-file, backup:build-zip-from-payload
//     mobile-access:get-state
//     genie:status, genie:test-sovits-python
//     rag:search, rag:get-messages, rag:get-all, rag:stats, rag:status,
//     rag:rebuild:status, rag:embed, rag:expand-context
//
//   Write passthrough (binary payloads arrive as base64; renderer
//   handler decodes before forwarding):
//     images:save, images:delete, voice:save, voice:delete,
//     ringtone:save, ringtone:delete,
//     app:set-auto-zip-backup,
//     genie:start, genie:stop,
//     rag:sync-messages, rag:save, rag:restore,
//     rag:clear-all, rag:clear-message-vectors, rag:rebuild:start
//
// Intentionally NOT in the list (PC-only by design):
//   quit-app,
//   app:update:check, app:update:download, app:update:quit-and-install
//     (desktop electron-updater write side — phones can read state via
//     app:update:get-state above, but the actual install ritual must
//     happen on the desktop process that owns the .exe),
//   app:pick-data-directory, app:migrate-data-directory,
//   app:reset-data-directory, app:set-background-throttling,
//   app:refocus-webcontents (PC renderer plumbing),
//   app:open-external (phone uses window.open directly),
//   backup:pick-save-file/pick-open-file/write-file/read-file/get-file-info
//   (phone uses /api/backup/export + /api/backup/import routes),
//   images:open-folder / voice:open-folder / ringtone:open-folder
//   (opens PC file explorer — meaningless on phone),
//   images:load / voice:load
//   (arrive via /media/{images,voices}/:id routes instead of base64-
//   over-JSON),
//   ringtone:load (Phase 5 Part D will add /media/ringtone for the
//   incoming-call UI; until then phone reads only ringtone:get-info
//   for the displayName + format fields),
//   mobile-access:enable/disable/get-pairing-token/rotate-token/
//   revoke-sessions (PC admin only — phone shouldn't revoke itself),
//   genie:pick-sovits-dir / genie:pick-sovits-python (native file
//   dialogs — phone uses genie:test-sovits-python with manual paths
//   instead, and Phase 3 Part B2 adds a scan-candidates endpoint).
const ALLOWED_CHANNELS = new Set([
  // --- Synthetic Dexie ------------------------------------------------
  'ping',
  'chat',
  'messages:recent',
  'messages:search',
  'messages:load-older',
  // Phase 4 Part E: one-shot hydration channels for mobile PWAs that
  // render full <App /> instead of the old MobilePhase1App shell. These
  // let the phone mirror the PC's Dexie + AI config on first load so
  // the App.tsx boot path (useInitialLoadBootstrap, getCurrentAIConfig)
  // finds real data instead of the phone's empty local IndexedDB and
  // missing localStorage.
  'bootstrap:snapshot',
  'bootstrap:ai-config',
  // Phase 5 Part D: mobile's only way to invoke the PC-side
  // VoiceCallOverlay closures (accept/reject/close). Forwarded to the
  // renderer's useMobileApiProxy handleCallAction, which reads the live
  // Zustand state so a late-arriving action for an already-closed call
  // is a harmless no-op.
  'call:action',
  // Phase 6 Part B: mobile's AIConfigScreen routes validate + save through
  // these so the PC renderer remains the sole localStorage.kumiko_ai_config
  // owner. `validate-*-from-mobile` run against PC-resident network access
  // (API keys never leave the PC beyond the single POST body that carries
  // the candidate config), `update-from-mobile` commits to localStorage and
  // fans out an `ai-config:changed` event so every other phone re-hydrates.
  'ai-config:update-from-mobile',
  'ai-config:validate-from-mobile',
  'ai-config:validate-search-from-mobile',
  'ai-config:validate-models-from-mobile',
  // Phase 6 Part C: mobile remote file browser + desktop file I/O for the
  // AuthScreen LOCAL tab. All `fs:*` + `backup:*-desktop-file` handlers
  // resolve paths against `mobileBrowseRoot` and reject anything outside
  // the allowed root (see electron/mobile-fs.cjs). The root itself is set
  // from the desktop renderer via `fs:set-mobile-browse-root` which is
  // intentionally NOT listed here — HTTP can only READ the current root
  // through `fs:get-mobile-browse-root`, not change it.
  'fs:get-mobile-browse-root',
  'fs:list-directory',
  'fs:get-shortcuts',
  'fs:check-path-exists',
  'backup:read-desktop-file',
  'backup:write-desktop-file',
  'backup:set-desktop-backup-path',
  'backup:disconnect-desktop-file',
  // --- Passthrough reads ---------------------------------------------
  'app:get-weather',
  'app:get-historical-weather',
  'app:get-japan-holidays',
  'app:get-data-directory-info',
  'app:get-auto-zip-backup',
  // Read-only mirror of the desktop electron-updater state. Phones use
  // this once on boot to seed the Settings → 应用更新 page; thereafter
  // the WS `update:state` push keeps it live (see app-updater.cjs ->
  // emitAppUpdateState fan-out). The write half (check/download/install)
  // intentionally stays PC-only — see the comment block above.
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
  // --- Passthrough writes --------------------------------------------
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

const DEFAULT_TIMEOUT_MS = 60000; // chat responses can stream for a while

const pending = new Map();
let targetWebContents = null;

function setRendererTarget(webContents) {
  targetWebContents = webContents && !webContents.isDestroyed() ? webContents : null;
}

function clearRendererTarget() {
  targetWebContents = null;
}

function isChannelAllowed(channel) {
  return typeof channel === 'string' && ALLOWED_CHANNELS.has(channel);
}

function dispatch(channel, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!isChannelAllowed(channel)) {
    return Promise.reject(Object.assign(new Error(`Channel not allowed: ${channel}`), { code: 'E_CHANNEL' }));
  }
  if (!targetWebContents || targetWebContents.isDestroyed()) {
    return Promise.reject(Object.assign(new Error('Renderer target not available'), { code: 'E_NO_RENDERER' }));
  }
  const requestId = crypto.randomBytes(12).toString('base64url');
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        reject(Object.assign(new Error('Renderer response timeout'), { code: 'E_TIMEOUT' }));
      }
    }, timeoutMs);
    if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();

    pending.set(requestId, { resolve, reject, timeoutHandle });
    try {
      targetWebContents.send('mobile-api-proxy', { requestId, channel, args });
    } catch (e) {
      pending.delete(requestId);
      clearTimeout(timeoutHandle);
      reject(Object.assign(new Error(`Renderer dispatch failed: ${e.message}`), { code: 'E_DISPATCH' }));
    }
  });
}

function handleReply(_event, payload) {
  if (!payload || typeof payload !== 'object') return;
  const { requestId, result, error } = payload;
  if (typeof requestId !== 'string') return;
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  clearTimeout(entry.timeoutHandle);
  if (error) {
    entry.reject(Object.assign(new Error(typeof error === 'string' ? error : 'Renderer error'), {
      code: 'E_RENDERER',
      detail: error,
    }));
  } else {
    entry.resolve(result);
  }
}

let ipcListenerInstalled = false;
function installIpcListener() {
  if (ipcListenerInstalled) return;
  ipcMain.on('mobile-api-proxy-reply', handleReply);
  ipcListenerInstalled = true;
}

function uninstallIpcListener() {
  if (!ipcListenerInstalled) return;
  ipcMain.removeListener('mobile-api-proxy-reply', handleReply);
  ipcListenerInstalled = false;
  // Reject all pending requests so nothing hangs forever on shutdown.
  for (const [, entry] of pending) {
    clearTimeout(entry.timeoutHandle);
    try {
      entry.reject(Object.assign(new Error('IPC bridge shutting down'), { code: 'E_SHUTDOWN' }));
    } catch { /* ignore */ }
  }
  pending.clear();
}

module.exports = {
  ALLOWED_CHANNELS,
  dispatch,
  setRendererTarget,
  clearRendererTarget,
  installIpcListener,
  uninstallIpcListener,
};
