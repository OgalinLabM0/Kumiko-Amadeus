// electron/server/push-notifications.cjs
//
// Phase 5 Part A: Web Push core module (main process side).
//
// Why we need this in addition to /ws:
//   The WebSocket fan-out only reaches phones that have an open socket,
//   which means the PWA is in foreground or in a warm-background tab
//   the OS hasn't yet killed. Once iOS/Android suspend the browser (app
//   backgrounded > ~30s, phone locked, or the user switched to another
//   app), the WS dies and the phone learns about nothing until it next
//   comes back to the PWA.
//   Web Push is the only cross-browser mechanism that:
//     - wakes the Service Worker even when the PWA process is fully
//       killed,
//     - shows a system notification so the user sees it with no app
//       open,
//     - works on iOS 16.4+ Safari (installed-as-PWA) and all Android
//       Chrome/Firefox.
//   The user's requirement: notifications within 5 minutes, even locked
//   screen, iOS included. Web Push delivers this.
//
// Architecture:
//   - Main process owns the VAPID keypair (generated once on first boot
//     and persisted in userData/push/vapid.json) plus the list of
//     subscriptions (userData/push/subscriptions.json). The private key
//     NEVER leaves the main process; the public key is exposed to
//     phones via an unauthenticated HTTP endpoint so the PWA service
//     worker can compute the correct `applicationServerKey` at
//     subscribe time.
//   - Fastify registers three routes (see push-routes.cjs):
//       GET  /api/push/vapid-public-key  (session-only)
//       POST /api/push/subscribe         (session-only)
//       POST /api/push/unsubscribe       (session-only)
//   - When the renderer broadcasts a 'message:added' or other
//     push-worthy event via `mobile-event-broadcast`, this module's
//     listener decides whether to emit a real browser-level push to
//     every registered subscription.
//   - Expired subscriptions (410 Gone) are pruned automatically so the
//     list doesn't bloat over time.
//
// File format — vapid.json:
//   { "publicKey": "base64url...", "privateKey": "base64url...", "createdAt": number }
//
// File format — subscriptions.json:
//   [
//     {
//       "id": "uuid-v4",
//       "endpoint": "https://fcm.googleapis.com/...",
//       "keys": { "p256dh": "...", "auth": "..." },
//       "createdAt": number,
//       "lastUsedAt": number,
//       "userAgent": "optional"
//     },
//     ...
//   ]

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const webPush = require('web-push');
const { app, ipcMain } = require('electron');

const DIR_NAME = 'push';
const VAPID_FILENAME = 'vapid.json';
const SUBSCRIPTIONS_FILENAME = 'subscriptions.json';
// Contact email is embedded in VAPID JWTs so push services can reach
// the administrator of a misbehaving sender. It does not need to be
// functional; browsers just require a mailto:/URL.
const VAPID_CONTACT = 'mailto:kumiko-amadeus@localhost';

// In-memory state. Loaded once at init(); persisted eagerly on every
// mutation. Subs are stored keyed by endpoint (the canonical identity
// of a push subscription).
let vapidKeys = null;
let subscriptions = new Map(); // endpoint → subscription row
let initialized = false;
let ipcListenerInstalled = false;

// ── File helpers ──────────────────────────────────────────────────

function getDir() {
  const dir = path.join(app.getPath('userData'), DIR_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  return dir;
}

function getVapidPath() {
  return path.join(getDir(), VAPID_FILENAME);
}

function getSubscriptionsPath() {
  return path.join(getDir(), SUBSCRIPTIONS_FILENAME);
}

function loadOrGenerateVapid() {
  const file = getVapidPath();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string') {
      return parsed;
    }
  } catch {
    // Missing / malformed — fall through to regenerate.
  }
  const generated = webPush.generateVAPIDKeys();
  const record = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    createdAt: Date.now(),
  };
  try {
    fs.writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn('[PUSH] Failed to persist VAPID keys:', e.message);
  }
  return record;
}

function loadSubscriptions() {
  const file = getSubscriptionsPath();
  const map = new Map();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        if (row && typeof row.endpoint === 'string' && row.keys && typeof row.keys.p256dh === 'string' && typeof row.keys.auth === 'string') {
          map.set(row.endpoint, row);
        }
      }
    }
  } catch {
    // Empty / malformed: start fresh.
  }
  return map;
}

function persistSubscriptions() {
  const file = getSubscriptionsPath();
  try {
    const list = Array.from(subscriptions.values());
    // Atomic write: stage to a .tmp then rename so a crash mid-write
    // doesn't leave a truncated list.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn('[PUSH] Failed to persist subscriptions:', e.message);
  }
}

// ── Public API ────────────────────────────────────────────────────

function init() {
  if (initialized) return;
  try {
    vapidKeys = loadOrGenerateVapid();
    subscriptions = loadSubscriptions();
    webPush.setVapidDetails(VAPID_CONTACT, vapidKeys.publicKey, vapidKeys.privateKey);

    // Listen for renderer events and decide per-event whether to push.
    // We listen separately from ws-broadcast.cjs so the two modules
    // stay independent — disabling pushes never affects the live WS
    // fan-out and vice versa.
    if (!ipcListenerInstalled) {
      ipcMain.on('mobile-event-broadcast', handleRendererEvent);
      ipcListenerInstalled = true;
    }

    initialized = true;
    console.log(`[PUSH] initialized (${subscriptions.size} subscription(s))`);
  } catch (e) {
    console.error('[PUSH] init failed:', e.message);
    initialized = false;
  }
}

function dispose() {
  if (ipcListenerInstalled) {
    ipcMain.removeListener('mobile-event-broadcast', handleRendererEvent);
    ipcListenerInstalled = false;
  }
  initialized = false;
}

function getVapidPublicKey() {
  return vapidKeys ? vapidKeys.publicKey : null;
}

function addSubscription(raw, meta = {}) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid subscription' };
  const { endpoint, keys } = raw;
  if (typeof endpoint !== 'string' || !endpoint.startsWith('http')) {
    return { ok: false, error: 'invalid endpoint' };
  }
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
    return { ok: false, error: 'missing keys' };
  }
  const now = Date.now();
  const existing = subscriptions.get(endpoint);
  const row = {
    id: existing ? existing.id : crypto.randomUUID(),
    endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    createdAt: existing ? existing.createdAt : now,
    lastUsedAt: now,
    userAgent: typeof meta.userAgent === 'string' ? meta.userAgent.slice(0, 200) : undefined,
  };
  subscriptions.set(endpoint, row);
  persistSubscriptions();
  return { ok: true, id: row.id };
}

function removeSubscription(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    return { ok: false, error: 'invalid endpoint' };
  }
  const had = subscriptions.delete(endpoint);
  if (had) persistSubscriptions();
  return { ok: true, removed: had };
}

function getSubscriptionCount() {
  return subscriptions.size;
}

// Dispatch a push to every registered phone. Returns a summary of
// deliveries. Expired subscriptions (410 Gone) are pruned on failure.
async function sendPushToAll(payload, options = {}) {
  if (!initialized || subscriptions.size === 0) {
    return { ok: true, sent: 0, failed: 0, removed: 0 };
  }
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
  const ttl = typeof options.ttl === 'number' ? options.ttl : 60 * 60; // 1h default
  const urgency = typeof options.urgency === 'string' ? options.urgency : 'normal';
  const pushOpts = { TTL: ttl, urgency };

  let sent = 0;
  let failed = 0;
  let removed = 0;

  const endpoints = Array.from(subscriptions.keys());
  await Promise.all(endpoints.map(async (endpoint) => {
    const row = subscriptions.get(endpoint);
    if (!row) return;
    try {
      await webPush.sendNotification(row, body, pushOpts);
      row.lastUsedAt = Date.now();
      sent += 1;
    } catch (e) {
      failed += 1;
      const status = e && e.statusCode;
      // 404 / 410 indicate the push subscription is permanently gone.
      // Anything else (network, 5xx) we leave alone — next push will
      // retry naturally.
      if (status === 404 || status === 410) {
        subscriptions.delete(endpoint);
        removed += 1;
      } else {
        console.warn('[PUSH] send failed:', endpoint, status || e.message);
      }
    }
  }));

  if (removed > 0) persistSubscriptions();
  return { ok: true, sent, failed, removed };
}

// ── Renderer event → push decision ────────────────────────────────
//
// We intentionally push sparingly. The WS fan-out already covers the
// foreground case, so duplicating every status tick as a system notif
// would be noisy. The rules below match what a reasonable chat app
// would surface when the user is away:
//   - message:added (role='model' only) → "Kumiko" + text preview.
//     User messages on the PC are self-originated so pushing them to
//     the same user's phone is spam.
//   - status:unread with a non-zero count → badge-only push (no body)
//     so the phone's badge updates even if the user dismissed the
//     text notification. Limited to once per tick to avoid hammering.
// Other event types (rag:*, genie:*, update:*, backup:*, status:line,
// status:emotion) are intentionally NOT pushed — they're background
// state that only matters when the app is open.

let lastBadgeCountPushed = -1;

function handleRendererEvent(_event, payload) {
  if (!payload || typeof payload !== 'object') return;
  const type = payload.type;
  if (type === 'message:added') {
    const msg = payload.message;
    if (!msg || msg.role !== 'model') return;
    const preview = buildMessagePreview(msg);
    const notif = {
      type: 'message',
      title: 'Kumiko',
      body: preview,
      tag: `kumiko-message-${msg.id}`,
      messageId: msg.id,
      url: '/',
      // Badge increment hint: the service worker will combine with
      // whatever the OS reports so we don't have to know the phone's
      // current badge count from this side.
      badgeIncrement: 1,
    };
    void sendPushToAll(notif, { urgency: 'high', ttl: 60 * 5 });
    return;
  }
  if (type === 'call:state') {
    // Phase 5 Part D: an incoming reminder call has just entered the
    // ringing phase. Push ONLY on the first ring event (before the
    // user answers on any device) — the subsequent connecting /
    // playing / ended transitions fan out over WS and don't need
    // a system notification.
    const state = payload.state;
    if (!state || typeof state !== 'object') return;
    if (state.isConnecting || state.isPlayingVoice || state.isEnded) return;
    const body = typeof state.reminderText === 'string' && state.reminderText.length > 0
      ? state.reminderText
      : (typeof state.reminderEvent === 'string' ? state.reminderEvent : '来电');
    const notif = {
      type: 'call',
      title: '黄前久美子 来电...',
      body: body.slice(0, 120),
      tag: 'kumiko-incoming-call',
      url: '/',
    };
    void sendPushToAll(notif, { urgency: 'high', ttl: 120 });
    return;
  }
  if (type === 'status:unread') {
    const count = typeof payload.count === 'number' ? payload.count : 0;
    if (count === lastBadgeCountPushed) return;
    lastBadgeCountPushed = count;
    // Only push the badge update when count is zero (clear) — non-zero
    // increments are already conveyed by the per-message push above
    // and would otherwise double-fire.
    if (count !== 0) return;
    const notif = {
      type: 'badge',
      badgeCount: 0,
      // No title/body → service worker updates badge without showing
      // a visible notification.
    };
    void sendPushToAll(notif, { urgency: 'low', ttl: 60 });
    return;
  }
}

function buildMessagePreview(msg) {
  const text = typeof msg.text === 'string' ? msg.text : '';
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    if (msg.imageId) return '[Image]';
    if (msg.isVoiceMessage) return '[Voice message]';
    return '…';
  }
  return trimmed.length > 140 ? `${trimmed.slice(0, 139)}…` : trimmed;
}

module.exports = {
  init,
  dispose,
  getVapidPublicKey,
  addSubscription,
  removeSubscription,
  getSubscriptionCount,
  sendPushToAll,
};
