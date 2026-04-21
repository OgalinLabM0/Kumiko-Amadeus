// electron/server/push-routes.cjs
//
// Phase 5 Part A: Fastify routes that let the phone PWA register and
// manage its Web Push subscription with the desktop.
//
//   GET  /api/push/vapid-public-key   (session-only)
//     Response: 200 { ok: true, publicKey: string }
//     Returns the server's VAPID public key. The PWA passes this to
//     `pushManager.subscribe({ applicationServerKey })` so the push
//     service (FCM/APNS bridge/Mozilla's autopush) trusts pushes
//     signed by our private key.
//
//   POST /api/push/subscribe          (session-only)
//     Body: application/json { endpoint, keys: { p256dh, auth } }
//     Response: 200 { ok: true, id: string }
//     Persists the subscription to userData/push/subscriptions.json.
//     Idempotent on endpoint: re-subscribing an existing endpoint
//     just refreshes its `lastUsedAt`.
//
//   POST /api/push/unsubscribe        (session-only)
//     Body: application/json { endpoint: string }
//     Response: 200 { ok: true, removed: boolean }
//
// All routes require the mobile session cookie. The PWA calls these
// straight after `MobilePairingGate` completes (or whenever the user
// opts in / out via Settings → Mobile Access → Notifications).

'use strict';

const pushNotifications = require('./push-notifications.cjs');

async function registerPushRoutes(scoped) {
  scoped.get('/api/push/vapid-public-key', async (_req, reply) => {
    const publicKey = pushNotifications.getVapidPublicKey();
    if (!publicKey) {
      reply.code(503);
      return { ok: false, error: 'push not initialized' };
    }
    return { ok: true, publicKey };
  });

  scoped.post('/api/push/subscribe', async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object') {
      reply.code(400);
      return { ok: false, error: 'missing body' };
    }
    const userAgent = (request.headers && typeof request.headers['user-agent'] === 'string')
      ? request.headers['user-agent']
      : undefined;
    const result = pushNotifications.addSubscription(body, { userAgent });
    if (!result.ok) {
      reply.code(400);
      return { ok: false, error: result.error };
    }
    return { ok: true, id: result.id };
  });

  scoped.post('/api/push/unsubscribe', async (request, reply) => {
    const body = request.body || {};
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
    if (!endpoint) {
      reply.code(400);
      return { ok: false, error: 'missing endpoint' };
    }
    const result = pushNotifications.removeSubscription(endpoint);
    if (!result.ok) {
      reply.code(400);
      return { ok: false, error: result.error };
    }
    return { ok: true, removed: result.removed };
  });
}

module.exports = {
  registerPushRoutes,
};
