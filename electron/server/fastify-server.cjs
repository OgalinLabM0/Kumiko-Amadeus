// electron/server/fastify-server.cjs
//
// Fastify HTTPS + WebSocket server that makes the desktop reachable from
// the user's phone over Tailscale. Owned by the main process; started
// lazily by electron-main.cjs when the user enables Mobile Access from
// the Settings panel, stopped in `will-quit`. Only one instance may run
// at a time; callers must `stop()` before starting with a new config.
//
// Phase 1 route surface:
//   GET  /healthz                   (no auth, liveness probe)
//   GET  /api/status                (no auth, returns { paired: boolean, hostname })
//   POST /api/auth/pair             (no auth, rate-limited, accepts { token })
//   POST /api/auth/logout           (session-only, clears cookie + revokes)
//   POST /api/ipc/:channel          (session-only, proxies through ipc-bridge)
//   GET  /media/images/:id          (session-only, streams userData/images/)
//   GET  /ws                        (session-only, WebSocket stub; filled in Phase 2)
//   GET  /*                         (static PWA bundle from dist/, SPA fallback)
//
// The `dist/` location differs between dev and packaged builds; resolution
// is centralized in `resolveDistDir()` so if either side moves we only
// touch one place.

'use strict';

const fs = require('fs');
const path = require('path');
const Fastify = require('fastify');
const fastifyCookie = require('@fastify/cookie');
const fastifyRateLimit = require('@fastify/rate-limit');
const fastifyStatic = require('@fastify/static');
const fastifyWebsocket = require('@fastify/websocket');
const { app } = require('electron');

const auth = require('./auth.cjs');
const ipcBridge = require('./ipc-bridge.cjs');
const tailscaleCert = require('./tailscale-cert.cjs');
const { registerMediaRoutes } = require('./media-routes.cjs');
const wsBroadcast = require('./ws-broadcast.cjs');

let fastifyInstance = null;
let activeConfig = null; // { port, hostname, certPath, keyPath }
let certWatcherDispose = null;

function isRunning() {
  return !!fastifyInstance;
}

function getActiveConfig() {
  return activeConfig ? { ...activeConfig } : null;
}

// Locate the built PWA bundle. In `npm run desktop:dev` the renderer is
// served by Vite on port 3000 — if that is the case we fall back to a
// redirect to that URL so the phone still gets fresh JS. In packaged
// builds the bundle lives under resources/app/dist/ after electron-builder
// copies it.
function resolveDistDir() {
  const candidates = [
    path.join(__dirname, '..', '..', 'dist'),                           // dev / unpacked
    path.join(process.resourcesPath || '', 'app', 'dist'),              // packaged asar root
    path.join(process.resourcesPath || '', 'app.asar', 'dist'),         // packaged asar
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'index.html'))) {
        return candidate;
      }
    } catch { /* continue */ }
  }
  return null;
}

async function buildApp({ certPath, keyPath }) {
  const fastify = Fastify({
    logger: false,
    https: {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
      minVersion: 'TLSv1.2',
    },
    trustProxy: false, // tailscale tunnels come in direct; no proxy header spoofing to trust
    bodyLimit: 5 * 1024 * 1024, // 5MB — chat payloads can include reasonably long history refs
  });

  await fastify.register(fastifyCookie, {});
  await fastify.register(fastifyRateLimit, {
    global: false, // applied per-route; avoids throttling static asset fetches
  });
  await fastify.register(fastifyWebsocket, {});

  // ── Public endpoints ──────────────────────────────────────────

  fastify.get('/healthz', async () => ({ ok: true, ts: Date.now() }));

  fastify.get('/api/status', async () => {
    const state = auth.getState();
    return {
      paired: state.activeSessionCount > 0,
      port: state.port,
      hostname: activeConfig ? activeConfig.hostname : null,
    };
  });

  fastify.post('/api/auth/pair', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    const body = request.body || {};
    const candidate = typeof body.token === 'string' ? body.token.trim() : '';
    if (!candidate) {
      reply.code(400);
      return { ok: false, error: 'missing token' };
    }
    const ok = auth.verifyPairingToken(candidate);
    if (!ok) {
      reply.code(401);
      return { ok: false, error: 'invalid token' };
    }
    const { sessionId, expiresAt } = auth.issueSession();
    reply.setCookie(auth.SESSION_COOKIE_NAME, sessionId, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      expires: new Date(expiresAt),
    });
    return { ok: true, expiresAt };
  });

  // ── Authenticated surface ─────────────────────────────────────

  function requireSession(request, reply, done) {
    const cookie = request.cookies && request.cookies[auth.SESSION_COOKIE_NAME];
    if (!auth.verifySessionCookie(cookie)) {
      reply.code(401).send({ ok: false, error: 'unauthorized' });
      return;
    }
    done();
  }

  fastify.post('/api/auth/logout', { preHandler: requireSession }, async (request, reply) => {
    const cookie = request.cookies && request.cookies[auth.SESSION_COOKIE_NAME];
    if (cookie) auth.revokeSession(cookie);
    reply.clearCookie(auth.SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  // Cookie-bound identity check. Used by the phone PWA to decide between
  // "show pairing screen" and "jump straight to chat" without relying on
  // /api/status (which is public and can't see the cookie). 401 here means
  // the cookie is missing / expired / revoked — the UI reacts accordingly.
  fastify.get('/api/auth/me', { preHandler: requireSession }, async () => ({ ok: true }));

  fastify.post('/api/ipc/:channel', { preHandler: requireSession }, async (request, reply) => {
    const channel = request.params && request.params.channel;
    if (!ipcBridge.ALLOWED_CHANNELS.has(channel)) {
      reply.code(404);
      return { ok: false, error: `channel not allowed: ${channel}` };
    }
    try {
      const result = await ipcBridge.dispatch(channel, request.body || {});
      return { ok: true, result };
    } catch (e) {
      const code = e && e.code;
      const status = code === 'E_TIMEOUT' ? 504 : code === 'E_NO_RENDERER' ? 503 : 500;
      reply.code(status);
      return { ok: false, error: e.message, code };
    }
  });

  // Phase 2 fan-out: every authenticated phone gets added to the
  // broadcaster's live set and receives every `mobile-event-broadcast`
  // the renderer emits. We still accept ping frames so phones can do
  // their own keepalive / health-check; everything else is ignored.
  fastify.register(async function wsScope(scoped) {
    scoped.get('/ws', { websocket: true, preHandler: requireSession }, (socket /* SocketStream */) => {
      wsBroadcast.register(socket);
      socket.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg && msg.type === 'ping') {
            try {
              socket.send(JSON.stringify({ type: 'pong', ts: Date.now(), echo: msg.nonce }));
            } catch { /* socket closed between ping/pong */ }
          }
        } catch { /* ignore malformed */ }
      });
    });
  });

  // ── Media ─────────────────────────────────────────────────────

  fastify.register(async function mediaScope(scoped) {
    scoped.addHook('preHandler', requireSession);
    await registerMediaRoutes(scoped);
  });

  // ── PWA static bundle ─────────────────────────────────────────
  //
  // Served last so the SPA fallback doesn't accidentally match an /api/
  // path. In dev mode the bundle might not exist yet; we return a short
  // helpful message so the user knows to run `npm run build:cap` first.

  const distDir = resolveDistDir();
  if (distDir) {
    await fastify.register(fastifyStatic, {
      root: distDir,
      prefix: '/',
      index: ['index.html'],
      decorateReply: false,
      wildcard: false,
    });
    // SPA fallback: any unmatched GET that accepts html renders index.html
    // so client-side routing (if any) doesn't 404 on deep links.
    fastify.setNotFoundHandler((request, reply) => {
      if (request.method !== 'GET') {
        reply.code(404).send({ ok: false, error: 'not found' });
        return;
      }
      const accept = request.headers.accept || '';
      if (!accept.includes('text/html')) {
        reply.code(404).send({ ok: false, error: 'not found' });
        return;
      }
      reply.type('text/html').sendFile('index.html');
    });
  } else {
    fastify.get('/', async (_req, reply) => {
      reply.code(503).type('text/plain').send(
        'Mobile Access is running, but the PWA bundle was not found.\n'
        + 'Run `npm run build:cap` on the desktop to produce dist/, then restart the app.',
      );
    });
  }

  return fastify;
}

// ── Public lifecycle ──────────────────────────────────────────────

async function start({ mainWindow, preferredPort } = {}) {
  if (fastifyInstance) {
    return { ok: false, code: 'E_ALREADY_RUNNING' };
  }

  const tsStatus = await tailscaleCert.getStatus();
  if (!tsStatus.ok) {
    return {
      ok: false,
      code: tsStatus.code,
      message: tsStatus.message,
    };
  }

  const certResult = await tailscaleCert.ensureCertificate({ hostname: tsStatus.hostname });
  if (!certResult.ok) {
    return {
      ok: false,
      code: certResult.code,
      message: certResult.message,
    };
  }

  let fastify;
  try {
    fastify = await buildApp({
      certPath: certResult.certPath,
      keyPath: certResult.keyPath,
    });
  } catch (e) {
    return { ok: false, code: 'E_BUILD', message: e && e.message };
  }

  // Listen on 0.0.0.0 so the Tailscale interface (100.x.x.x) is reachable.
  // Using port 0 lets the OS pick a free port on first start, which is
  // then persisted via auth.setPort for subsequent runs.
  const listenPort = typeof preferredPort === 'number' && preferredPort > 0
    ? preferredPort
    : (auth.getState().port || 0);

  try {
    await fastify.listen({ port: listenPort, host: '0.0.0.0' });
  } catch (e) {
    try { await fastify.close(); } catch { /* ignore */ }
    // Classify common listen errors so the UI can display a targeted
    // remediation card. EADDRINUSE (port conflict) and EACCES
    // (permission denied by firewall or OS) are both worth distinguishing
    // from the generic E_LISTEN bucket because their fix steps differ.
    let listenCode = 'E_LISTEN';
    const raw = (e && (e.code || e.message)) || '';
    if (typeof raw === 'string' && raw.toUpperCase().includes('EADDRINUSE')) {
      listenCode = 'E_LISTEN_EADDRINUSE';
    } else if (e && e.code === 'EADDRINUSE') {
      listenCode = 'E_LISTEN_EADDRINUSE';
    }
    return { ok: false, code: listenCode, message: e && e.message };
  }

  const actualPort = fastify.server.address().port;
  auth.setPort(actualPort);

  if (mainWindow && mainWindow.webContents) {
    ipcBridge.setRendererTarget(mainWindow.webContents);
    ipcBridge.installIpcListener();
  }
  wsBroadcast.install();

  fastifyInstance = fastify;
  activeConfig = {
    port: actualPort,
    hostname: tsStatus.hostname,
    ipv4: tsStatus.ipv4 || null,
    tailnet: tsStatus.tailnet || null,
    certPath: certResult.certPath,
    keyPath: certResult.keyPath,
    certExpiresAt: certResult.expiresAt || null,
  };

  // Keep the cert fresh in the background. If a renewal happens we log a
  // warning; Phase 1 does not hot-swap TLS context — the user just
  // restarts the app on the next launch (cert is re-loaded then). A
  // proper hot-swap lands once we have a reason to ship it.
  certWatcherDispose = tailscaleCert.watchCertificate({
    hostname: tsStatus.hostname,
    onRenew: (info) => {
      console.log('[MOBILE-SERVER] Certificate renewed; restart to apply new material.', {
        expiresAt: info.expiresAt,
      });
    },
    onError: (err) => {
      console.warn('[MOBILE-SERVER] Certificate renewal check failed:', err);
    },
  });

  return {
    ok: true,
    port: actualPort,
    hostname: tsStatus.hostname,
    ipv4: tsStatus.ipv4 || null,
    url: `https://${tsStatus.hostname}:${actualPort}/`,
  };
}

async function stop() {
  const instance = fastifyInstance;
  fastifyInstance = null;
  activeConfig = null;
  if (typeof certWatcherDispose === 'function') {
    try { certWatcherDispose(); } catch { /* ignore */ }
    certWatcherDispose = null;
  }
  ipcBridge.clearRendererTarget();
  ipcBridge.uninstallIpcListener();
  wsBroadcast.uninstall();
  if (instance) {
    try { await instance.close(); } catch (e) {
      console.warn('[MOBILE-SERVER] Error while closing Fastify:', e && e.message);
    }
  }
  return { ok: true };
}

function setRendererTarget(webContents) {
  ipcBridge.setRendererTarget(webContents);
  if (fastifyInstance) ipcBridge.installIpcListener();
}

module.exports = {
  start,
  stop,
  isRunning,
  getActiveConfig,
  setRendererTarget,
};
