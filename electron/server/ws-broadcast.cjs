// electron/server/ws-broadcast.cjs
//
// WebSocket fan-out layer for phone clients.
//
// Desktop Kumiko drives one-way events (new message, updated status,
// model emotion, etc.) into this module via the `mobile-event-broadcast`
// IPC channel. We maintain the live `Set<SocketStream>` of connected
// phones and forward every event to every socket. No per-phone
// addressing, no per-phone filtering — the payload itself carries
// `{ type, ... }` and the phone decides what to do with it.
//
// Phone → desktop is NOT done here; the phone uses normal HTTPS POSTs
// through the ipc-bridge for that. This keeps the WS path read-only
// so it's:
//   - reconnectable without losing state (phone re-fetches /messages
//     on resume and replays events from the last seen timestamp)
//   - cheap (no per-socket auth token refresh, cookie already gated
//     the upgrade request)
//   - survivable (a dropped socket doesn't lose outgoing commands —
//     the phone just re-issues the HTTP call)
//
// Lifecycle contract (called by fastify-server.cjs):
//   - install(): wire up the ipcMain listener. Safe to call multiple
//     times — the second call is a no-op. Must run before any /ws
//     upgrade is accepted.
//   - uninstall(): remove the ipcMain listener, close all live
//     sockets, empty the set. Runs during server stop().
//   - register(socket): called from the fastify websocket route once
//     the upgrade is complete and the cookie check passed. We install
//     close/error handlers, push the socket into the live set, and
//     optionally send a 'ready' frame so the phone knows it's live.
//
// Payload schema (see also services/httpApi.ts subscribeEvents).
//
// Phase 2 (chat / state mirror):
//   { type: 'message:added', message: SlimMessage }
//   { type: 'message:updated', message: SlimMessage }
//   { type: 'message:deleted', messageId: string }
//   { type: 'status:line', text: string }
//   { type: 'status:emotion', emotion: string }
//   { type: 'status:unread', count: number }
//
// Phase 3 Part D (main-process background streams). These mirror the
// one-way IPC events that ship from electron-rag.cjs / auto-zip-backup
// .cjs / app-updater.cjs / genie-process.cjs, bridged at the renderer
// via useMobileBroadcaster so phone UI can react live.
//   { type: 'rag:rebuild:started', job }
//   { type: 'rag:rebuild:progress', job }
//   { type: 'rag:rebuild:done', job }
//   { type: 'rag:rebuild:error', job }
//   { type: 'backup:auto-zip', status }
//   { type: 'update:state', state }
//   { type: 'genie:state', state }
//
// Handshake / keepalive (server-originated):
//   { type: 'hello', ts, clients }
//   { type: 'ping', ts: number }           // optional keepalive
//
// Type strings are case-sensitive and MUST match useMobileBroadcaster.

'use strict';

const { ipcMain } = require('electron');

const sockets = new Set();
let ipcListenerInstalled = false;

function safeSend(socket, payload) {
  try {
    // Fastify-websocket v11 sockets are the raw `ws` sockets. readyState
    // === 1 means OPEN; closing/closed sockets will still accept send()
    // but the message will silently drop, so we check defensively.
    if (socket && socket.readyState === 1) {
      socket.send(payload);
    }
  } catch {
    // A send failure usually means the underlying TCP connection went
    // away between our readyState check and the write. We let the close
    // handler clean up; no point in throwing here because fan-out must
    // continue to other sockets.
  }
}

function broadcast(event) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;
  if (sockets.size === 0) return;
  let payload;
  try {
    payload = JSON.stringify(event);
  } catch {
    // An event with a circular or non-serializable field shouldn't
    // crash the broadcaster. Drop it loudly (console) but keep going.
    console.warn('[MOBILE-WS] broadcast: unserializable event, dropped', event && event.type);
    return;
  }
  for (const socket of sockets) {
    safeSend(socket, payload);
  }
}

function handleIpcBroadcast(_event, payload) {
  broadcast(payload);
}

function install() {
  if (ipcListenerInstalled) return;
  ipcMain.on('mobile-event-broadcast', handleIpcBroadcast);
  ipcListenerInstalled = true;
}

function uninstall() {
  if (ipcListenerInstalled) {
    ipcMain.removeListener('mobile-event-broadcast', handleIpcBroadcast);
    ipcListenerInstalled = false;
  }
  for (const socket of sockets) {
    try { socket.close(1001, 'server shutting down'); } catch { /* ignore */ }
  }
  sockets.clear();
}

function register(socket) {
  if (!socket) return;
  sockets.add(socket);
  const drop = () => {
    sockets.delete(socket);
  };
  socket.on('close', drop);
  socket.on('error', drop);
  // Greeting frame. The phone's subscribeEvents() uses this as the
  // "connection is healthy" signal and resets its reconnect backoff.
  safeSend(socket, JSON.stringify({ type: 'hello', ts: Date.now(), clients: sockets.size }));

  // Seed the updater store on every WS connection. Without this, a
  // phone that opens while the desktop is idle keeps the
  // DEFAULT_APP_UPDATE_STATE.currentVersion='0.0.0' stuck on screen:
  // the renderer-based app:update-status -> update:state fan-out
  // (useMobileBroadcaster) only fires on state transitions, and
  // setupAutoUpdater never emits at boot. The phone's initial HTTP
  // fetch of app:update:get-state also races the Fastify listen and
  // often fails with E_NETWORK. So we piggy-back on the proven
  // liveness of this /ws upgrade to push the authoritative state
  // from app-updater.cjs, which sets currentVersion = app.getVersion()
  // at module-load time. Lazy require avoids any load-order hazard;
  // mobile-fs.cjs already uses the same pattern to reach this file
  // from the other direction.
  try {
    const { getUpdateState } = require('../app-updater.cjs');
    const state = typeof getUpdateState === 'function' ? getUpdateState() : null;
    if (state) {
      safeSend(socket, JSON.stringify({ type: 'update:state', state }));
    }
  } catch (e) {
    console.warn('[MOBILE-WS] register: initial update:state snapshot failed:', e && e.message);
  }
}

function getClientCount() {
  return sockets.size;
}

module.exports = {
  install,
  uninstall,
  register,
  broadcast,
  getClientCount,
};
