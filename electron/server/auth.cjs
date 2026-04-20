// electron/server/auth.cjs
//
// Pairing token + session cookie authentication for the mobile remote-access
// Fastify server. Everything lives in userData/mobile-access.json so the
// config survives app restarts. The file is written with mode 0o600 on
// unix-like platforms to reduce over-shoulder exposure; on Windows the
// user profile ACLs already restrict it.
//
// Threat model (Phase 1):
//   - The transport is Tailscale, which already authenticates both peers
//     via the Tailscale account. The pairing token is a second factor
//     that protects the desktop against a rogue device the user may have
//     previously authorized on their Tailnet.
//   - Phone-side compromise (stolen session cookie) is mitigated by
//     short-ish session TTL + explicit rotate / revoke actions exposed
//     through the Settings UI in Phase 2.
//   - Main-process compromise is out of scope — if someone can write to
//     userData, they already own the database.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const STORAGE_FILENAME = 'mobile-access.json';
const SESSION_COOKIE_NAME = 'kumiko_mobile_session';
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const PAIRING_TOKEN_BYTES = 32; // 256-bit
const SESSION_ID_BYTES = 32;

let cachedConfig = null;

function getStoragePath() {
  return path.join(app.getPath('userData'), STORAGE_FILENAME);
}

function createDefaultConfig() {
  return {
    enabled: false,
    port: null,
    pairingToken: null,
    pairingTokenCreatedAt: null,
    sessions: {},
  };
}

function loadConfig() {
  if (cachedConfig) return cachedConfig;
  const storagePath = getStoragePath();
  try {
    if (!fs.existsSync(storagePath)) {
      cachedConfig = createDefaultConfig();
      return cachedConfig;
    }
    const raw = fs.readFileSync(storagePath, 'utf8');
    const parsed = JSON.parse(raw);
    cachedConfig = {
      ...createDefaultConfig(),
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
    };
    if (!cachedConfig.sessions || typeof cachedConfig.sessions !== 'object') {
      cachedConfig.sessions = {};
    }
    return cachedConfig;
  } catch (e) {
    console.warn('[MOBILE-AUTH] Failed to load config, starting fresh:', e && e.message);
    cachedConfig = createDefaultConfig();
    return cachedConfig;
  }
}

function saveConfig() {
  const storagePath = getStoragePath();
  try {
    const serialized = JSON.stringify(cachedConfig, null, 2);
    fs.writeFileSync(storagePath, serialized, 'utf8');
    if (process.platform !== 'win32') {
      try { fs.chmodSync(storagePath, 0o600); } catch { /* best-effort */ }
    }
  } catch (e) {
    console.error('[MOBILE-AUTH] Failed to persist config:', e && e.message);
  }
}

function pruneExpiredSessions(config) {
  const now = Date.now();
  let mutated = false;
  for (const sessionId of Object.keys(config.sessions)) {
    const entry = config.sessions[sessionId];
    if (!entry || typeof entry.expiresAt !== 'number' || entry.expiresAt <= now) {
      delete config.sessions[sessionId];
      mutated = true;
    }
  }
  return mutated;
}

// ── Public API ────────────────────────────────────────────────────

function getState() {
  const config = loadConfig();
  return {
    enabled: !!config.enabled,
    port: typeof config.port === 'number' ? config.port : null,
    hasPairingToken: !!config.pairingToken,
    pairingTokenCreatedAt: config.pairingTokenCreatedAt || null,
    activeSessionCount: Object.keys(config.sessions || {}).length,
  };
}

function setEnabled(enabled) {
  const config = loadConfig();
  config.enabled = !!enabled;
  saveConfig();
  return getState();
}

function setPort(port) {
  const config = loadConfig();
  if (typeof port !== 'number' || !Number.isFinite(port)) {
    throw new Error('Invalid port');
  }
  config.port = Math.floor(port);
  saveConfig();
}

function getPairingToken() {
  const config = loadConfig();
  return config.pairingToken || null;
}

function generatePairingToken() {
  const config = loadConfig();
  config.pairingToken = crypto.randomBytes(PAIRING_TOKEN_BYTES).toString('base64url');
  config.pairingTokenCreatedAt = Date.now();
  // Rotating the pairing token does not invalidate existing sessions —
  // those are independent credentials. If the user wants a full reset
  // they can call `revokeAllSessions` too; the UI pairs both buttons.
  saveConfig();
  return config.pairingToken;
}

function clearPairingToken() {
  const config = loadConfig();
  config.pairingToken = null;
  config.pairingTokenCreatedAt = null;
  saveConfig();
}

function verifyPairingToken(candidate) {
  const config = loadConfig();
  if (!config.pairingToken || typeof candidate !== 'string') return false;
  const expected = Buffer.from(config.pairingToken, 'utf8');
  const provided = Buffer.from(candidate, 'utf8');
  if (expected.length !== provided.length) return false;
  try {
    return crypto.timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

// Issue a new session (called after a successful pair). Returns { sessionId,
// expiresAt } that the caller sets on the cookie.
function issueSession() {
  const config = loadConfig();
  pruneExpiredSessions(config);
  const sessionId = crypto.randomBytes(SESSION_ID_BYTES).toString('base64url');
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  config.sessions[sessionId] = { issuedAt: now, expiresAt };
  saveConfig();
  return { sessionId, expiresAt };
}

function verifySessionCookie(cookieValue) {
  if (typeof cookieValue !== 'string' || !cookieValue) return false;
  const config = loadConfig();
  const entry = config.sessions[cookieValue];
  if (!entry || typeof entry.expiresAt !== 'number') return false;
  if (entry.expiresAt <= Date.now()) {
    delete config.sessions[cookieValue];
    saveConfig();
    return false;
  }
  return true;
}

function revokeSession(cookieValue) {
  if (typeof cookieValue !== 'string' || !cookieValue) return;
  const config = loadConfig();
  if (config.sessions[cookieValue]) {
    delete config.sessions[cookieValue];
    saveConfig();
  }
}

function revokeAllSessions() {
  const config = loadConfig();
  config.sessions = {};
  saveConfig();
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  getState,
  setEnabled,
  setPort,
  getPairingToken,
  generatePairingToken,
  clearPairingToken,
  verifyPairingToken,
  issueSession,
  verifySessionCookie,
  revokeSession,
  revokeAllSessions,
};
