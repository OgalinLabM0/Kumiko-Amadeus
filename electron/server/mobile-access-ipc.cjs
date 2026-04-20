// electron/server/mobile-access-ipc.cjs
//
// IPC surface the renderer (Settings panel) talks to when the user
// enables / disables mobile access, rotates the pairing token, or asks
// for connection info. Keeps electron-main.cjs free of Fastify lifecycle
// awareness — it only needs to route the channels to these handlers and
// to hand us back a reference to the main BrowserWindow for the IPC
// bridge target.
//
// All handlers return a single-object shape so the renderer can trust
// `result.ok` + narrow on `result.error` / `result.code` without having
// to parse exceptions.

'use strict';

const auth = require('./auth.cjs');
const tailscaleCert = require('./tailscale-cert.cjs');
const fastifyServer = require('./fastify-server.cjs');

let getMainWindowRef = null;

function bind({ getMainWindow }) {
  if (typeof getMainWindow === 'function') {
    getMainWindowRef = getMainWindow;
  }
}

function currentMainWindow() {
  if (typeof getMainWindowRef !== 'function') return null;
  try { return getMainWindowRef(); } catch { return null; }
}

async function composeState() {
  const authState = auth.getState();
  const tsStatus = await tailscaleCert.getStatus();
  const running = fastifyServer.isRunning();
  const active = fastifyServer.getActiveConfig();
  return {
    ok: true,
    enabled: authState.enabled,
    running,
    hasPairingToken: authState.hasPairingToken,
    pairingTokenCreatedAt: authState.pairingTokenCreatedAt,
    activeSessionCount: authState.activeSessionCount,
    tailscale: {
      ok: tsStatus.ok,
      code: tsStatus.ok ? null : tsStatus.code,
      message: tsStatus.ok ? null : tsStatus.message,
      hostname: tsStatus.ok ? tsStatus.hostname : null,
      ipv4: tsStatus.ok ? tsStatus.ipv4 : null,
      tailnet: tsStatus.ok ? tsStatus.tailnet : null,
    },
    server: running && active
      ? {
        port: active.port,
        hostname: active.hostname,
        ipv4: active.ipv4,
        url: `https://${active.hostname}:${active.port}/`,
        certExpiresAt: active.certExpiresAt,
      }
      : null,
  };
}

async function handleGetState() {
  try {
    return await composeState();
  } catch (e) {
    return { ok: false, error: e && e.message, code: 'E_STATE' };
  }
}

// Reveal the pairing token. Kept as a separate channel (rather than in
// the default state blob) so the token never flows across IPC unless
// the user explicitly clicks "show / copy" in the Settings UI.
async function handleGetPairingToken() {
  try {
    const token = auth.getPairingToken();
    if (!token) {
      return { ok: false, error: 'No pairing token', code: 'E_NO_TOKEN' };
    }
    return { ok: true, token };
  } catch (e) {
    return { ok: false, error: e && e.message, code: 'E_STATE' };
  }
}

async function handleEnable() {
  try {
    if (!auth.getPairingToken()) auth.generatePairingToken();
    auth.setEnabled(true);
    const win = currentMainWindow();
    const startResult = await fastifyServer.start({ mainWindow: win });
    if (!startResult.ok) {
      // Leave `enabled` true so the UI still reflects user intent; the
      // surface error message is what the UI displays. A later retry
      // (e.g. after the user fixes Tailscale) will succeed without a
      // second toggle.
      return { ok: false, error: startResult.message || 'Failed to start server', code: startResult.code };
    }
    return { ok: true, state: await composeState() };
  } catch (e) {
    return { ok: false, error: e && e.message, code: 'E_ENABLE' };
  }
}

async function handleDisable() {
  try {
    await fastifyServer.stop();
    auth.setEnabled(false);
    return { ok: true, state: await composeState() };
  } catch (e) {
    return { ok: false, error: e && e.message, code: 'E_DISABLE' };
  }
}

async function handleRotateToken() {
  try {
    const token = auth.generatePairingToken();
    return { ok: true, token };
  } catch (e) {
    return { ok: false, error: e && e.message, code: 'E_ROTATE' };
  }
}

async function handleRevokeSessions() {
  try {
    auth.revokeAllSessions();
    return { ok: true, state: await composeState() };
  } catch (e) {
    return { ok: false, error: e && e.message, code: 'E_REVOKE' };
  }
}

async function stopOnQuit() {
  try {
    await fastifyServer.stop();
  } catch (e) {
    console.warn('[MOBILE-ACCESS] stopOnQuit failed:', e && e.message);
  }
}

function refreshRendererTarget() {
  const win = currentMainWindow();
  if (!win || !win.webContents) return;
  fastifyServer.setRendererTarget(win.webContents);
}

module.exports = {
  bind,
  handleGetState,
  handleGetPairingToken,
  handleEnable,
  handleDisable,
  handleRotateToken,
  handleRevokeSessions,
  stopOnQuit,
  refreshRendererTarget,
};
