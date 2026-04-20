// electron/server/media-routes.cjs
//
// Fastify route registration for mobile-accessible media files. Phase 1
// ships `/media/images/:id` only; voice + ringtone follow in Phase 2 so
// they can be co-designed with the new media write path.
//
// The underlying resolution + SAFE_IMAGE_ID validation is delegated to
// `electron/media-files.cjs` so this module doesn't accidentally diverge
// from the kumiko-image:// protocol handler in electron-main.cjs. If you
// ever change the ID regex, change it there.

'use strict';

const fs = require('fs');
const { findImageFile } = require('../media-files.cjs');

async function registerMediaRoutes(fastify) {
  fastify.get('/media/images/:id', async (request, reply) => {
    const { id } = request.params || {};
    const found = findImageFile(id);
    if (!found) {
      reply.code(404).type('application/json').send({ error: 'Image not found' });
      return;
    }
    let stats;
    try {
      stats = fs.statSync(found.path);
    } catch (e) {
      reply.code(500).type('application/json').send({ error: 'Stat failed', detail: e.message });
      return;
    }
    const etag = `W/"img-${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
    if (request.headers['if-none-match'] === etag) {
      reply.code(304).send();
      return;
    }
    reply.header('Content-Type', found.mimeType);
    // 1-day phone cache: these blobs are immutable per-id, so even the
    // browser cache is safe long-term. We keep it at 24h to balance phone
    // storage churn with the occasional re-save-same-id case (voice
    // pipelines sometimes overwrite by design).
    reply.header('Cache-Control', 'private, max-age=86400');
    reply.header('ETag', etag);
    reply.header('Content-Length', String(stats.size));
    return fs.createReadStream(found.path);
  });
}

module.exports = {
  registerMediaRoutes,
};
