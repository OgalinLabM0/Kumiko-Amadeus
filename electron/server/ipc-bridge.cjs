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
//     images:list, voice:list
//     rag:search, rag:get-messages, rag:stats, rag:status,
//     rag:rebuild:status
//
//   Write passthrough (binary payloads arrive as base64; handler decodes
//   before forwarding):
//     images:save, images:delete, voice:save, voice:delete,
//     rag:sync-messages
//
// Intentionally NOT in the list: backup:*, genie:*, app:update:*,
// app:*-directory-*, app:open-external, ringtone:*, mobile-access:*,
// images:open-folder, voice:open-folder, images:load, voice:load
// (the last two go through /media/{images,voices}/:id instead of JSON).
const ALLOWED_CHANNELS = new Set([
  // --- Synthetic Dexie ------------------------------------------------
  'ping',
  'chat',
  'messages:recent',
  'messages:search',
  'messages:load-older',
  // --- Passthrough reads ---------------------------------------------
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
  // --- Passthrough writes --------------------------------------------
  'images:save',
  'images:delete',
  'voice:save',
  'voice:delete',
  'rag:sync-messages',
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
