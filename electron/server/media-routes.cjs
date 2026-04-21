// electron/server/media-routes.cjs
//
// Fastify route registration for mobile-accessible media files. Phase 1
// shipped `/media/images/:id` only. Phase 2 adds `/media/voices/:id`
// (Kumiko SoVITS voice clips) so the phone can stream audio instead of
// pulling it through the JSON IPC bridge as base64.
//
// The underlying resolution + SAFE_*_ID validation is delegated to
// `electron/media-files.cjs` so this module doesn't accidentally diverge
// from the kumiko-image:// protocol handler in electron-main.cjs. If you
// ever change the ID regex, change it there.

'use strict';

const fs = require('fs');
const { findImageFile, findVoiceFile, findRingtoneFile } = require('../media-files.cjs');

function streamFile(request, reply, found, kindTag) {
  let stats;
  try {
    stats = fs.statSync(found.path);
  } catch (e) {
    reply.code(500).type('application/json').send({ error: 'Stat failed', detail: e.message });
    return null;
  }
  const etag = `W/"${kindTag}-${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
  if (request.headers['if-none-match'] === etag) {
    reply.code(304).send();
    return null;
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
}

async function registerMediaRoutes(fastify) {
  fastify.get('/media/images/:id', async (request, reply) => {
    const { id } = request.params || {};
    const found = findImageFile(id);
    if (!found) {
      reply.code(404).type('application/json').send({ error: 'Image not found' });
      return;
    }
    return streamFile(request, reply, found, 'img');
  });

  fastify.get('/media/voices/:id', async (request, reply) => {
    const { id } = request.params || {};
    const found = findVoiceFile(id);
    if (!found) {
      reply.code(404).type('application/json').send({ error: 'Voice not found' });
      return;
    }
    return streamFile(request, reply, found, 'voice');
  });

  // Phase 5 Part D: stream the user's custom ringtone. Built-in
  // ringtones are handled transparently by the @fastify/static mount
  // at /ringtones/0X.mp3; this endpoint fills the gap for the single
  // custom upload saved under userData/ringtone/custom.{ext}. It
  // deliberately takes no id param (there is at most one custom
  // ringtone file per user) so callers don't need to know the
  // extension the user chose.
  fastify.get('/media/ringtone', async (request, reply) => {
    const found = findRingtoneFile();
    if (!found) {
      reply.code(404).type('application/json').send({ error: 'Custom ringtone not found' });
      return;
    }
    return streamFile(request, reply, found, 'ringtone');
  });
}

module.exports = {
  registerMediaRoutes,
};
