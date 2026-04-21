// electron/server/backup-routes.cjs
//
// Phase 3 Part C of the mobile-parity roadmap. Exposes two dedicated
// HTTP routes so the phone can trigger a full backup export/import
// without forcing the zip bytes through the JSON IPC bridge (which
// would mean 4/3x base64 bloat on every multi-MB backup).
//
//   POST /api/backup/export
//     Body: application/json { dataJsonString: string, defaultFileName?: string }
//     Response: 200 application/zip (attachment) — raw zip bytes
//              500 application/json { ok:false, error } — builder failed
//     Semantics: main-process `buildBackupZipBuffer` attaches the same
//     userData/images|voice|ringtone folders that the desktop "manual"
//     export uses, then streams the buffer back. The phone initiates
//     a normal download via <a download> on the returned blob.
//
//   POST /api/backup/import
//     Body: application/zip | application/octet-stream | application/json (raw)
//     Query:  ?fileName=kumiko_backup.zip  (used only to pick extension)
//     Response: 200 application/json { ok:true, result: { success, json, images[], ... } }
//              4xx/5xx application/json { ok:false, error }
//     Semantics: we write the uploaded bytes to userData/mobile-imports/
//     <hash>.<ext> (authorized-paths automatically allows userData-
//     relative paths) and then delegate to the existing
//     `parseBackupImportFile()` in electron/backup-files.cjs. Voice /
//     ringtone files are unpacked to userData/{voice,ringtone}/ server-
//     side; the returned JSON carries `data.json` + image dataUrls the
//     renderer still needs to write into Dexie via imageService.
//     After the phone has consumed the result it can optionally trigger
//     the full-import renderer orchestration through the existing
//     `backup:run-mobile-import` IPC channel (Phase 3 Part C2), which
//     calls `handleImportBackup` in the desktop renderer with the same
//     deps that AppBackup wires up for the desktop UI.
//
// Design decisions:
//   - No multipart. `@fastify/multipart` would add a dependency + parser
//     overhead; the phone already knows the file name (it picked the
//     file) and can ship the bytes as `application/octet-stream` with
//     the filename in a query param. This also makes it straightforward
//     to stream very large backups (the phone's File object → fetch
//     body → fs.writeFileSync on the server) without ever materializing
//     the full base64-encoded form in memory.
//   - We enforce a hard 2GB body limit on these routes — generous enough
//     for any realistic Kumiko backup (the largest test backup we've
//     seen in-house is ~180MB with 3 years of voice clips).
//   - Temp uploads go to `userData/mobile-imports/` with a random hex
//     basename. We clean them up after parseBackupImportFile returns,
//     even on error, so a phone that disconnects mid-import doesn't
//     leak gigabytes.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { buildBackupZipBuffer } = require('../backup-zip-builder.cjs');
const { parseBackupImportFile } = require('../backup-files.cjs');

// 2GB hard ceiling on backup uploads. Distinct from the 5MB JSON limit
// set on the default Fastify instance — those are IPC envelopes; these
// are binary backups and can legitimately reach hundreds of MB.
const BACKUP_BODY_LIMIT = 2 * 1024 * 1024 * 1024;

const MOBILE_IMPORTS_DIRNAME = 'mobile-imports';

function getMobileImportsDir() {
  const dir = path.join(app.getPath('userData'), MOBILE_IMPORTS_DIRNAME);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.warn('[BACKUP-ROUTES] Failed to create mobile-imports dir:', e);
  }
  return dir;
}

function pickImportExtension(queryFileName, contentType) {
  if (typeof queryFileName === 'string') {
    const ext = path.extname(queryFileName).toLowerCase();
    if (ext === '.zip' || ext === '.json') return ext;
  }
  if (typeof contentType === 'string') {
    if (contentType.includes('zip')) return '.zip';
    if (contentType.includes('json')) return '.json';
  }
  // Default to .zip — the server-side parser handles both but treats
  // unknown extensions as a parse error, so we bias toward the format
  // 99% of users are shipping.
  return '.zip';
}

function sanitizeFileNameForHeader(name) {
  // RFC 6266 / curl-safe. No CR/LF/quotes; collapse control chars.
  const safe = String(name || 'kumiko_backup.zip')
    .replace(/[\r\n"\\]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .slice(0, 200);
  return safe || 'kumiko_backup.zip';
}

async function registerBackupRoutes(fastify) {
  // Raw-body parser for binary backup uploads. Fastify 4's default
  // parser chain only covers application/json + text/plain; we opt in
  // to treating application/zip and application/octet-stream as
  // buffers so we can write them to disk without base64 decoding.
  // The `application/json` parser stays default (fastify ships one).
  const bufferParser = (_req, body, done) => done(null, body);
  fastify.addContentTypeParser(
    ['application/zip', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: BACKUP_BODY_LIMIT },
    bufferParser,
  );

  fastify.post('/api/backup/export', {
    bodyLimit: 32 * 1024 * 1024, // 32MB is plenty for dataJsonString (JSON only, no media)
  }, async (request, reply) => {
    const body = request.body || {};
    const dataJsonString = typeof body.dataJsonString === 'string' ? body.dataJsonString : '';
    const defaultFileName = typeof body.defaultFileName === 'string' && body.defaultFileName.trim()
      ? body.defaultFileName.trim()
      : `kumiko_backup_${new Date().toISOString().slice(0, 10)}.zip`;

    if (!dataJsonString) {
      reply.code(400);
      return { ok: false, error: 'dataJsonString is required' };
    }

    const result = await buildBackupZipBuffer({
      dataJsonString,
      mode: 'manual',
    });
    if (!result.success || !result.buffer) {
      reply.code(500);
      return { ok: false, error: result.error || 'Zip build failed' };
    }

    reply.header('Content-Type', 'application/zip');
    reply.header(
      'Content-Disposition',
      `attachment; filename="${sanitizeFileNameForHeader(defaultFileName)}"`,
    );
    reply.header('Content-Length', String(result.buffer.length));
    reply.header('X-Images-Included', String(result.imagesIncluded || 0));
    reply.header('X-Images-Total', String(result.imagesTotal || 0));
    return reply.send(result.buffer);
  });

  fastify.post('/api/backup/import', {
    bodyLimit: BACKUP_BODY_LIMIT,
  }, async (request, reply) => {
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      reply.code(400);
      return { ok: false, error: 'empty or invalid body (expected raw zip/json bytes)' };
    }

    const queryFileName = request.query && request.query.fileName;
    const contentType = request.headers && request.headers['content-type'];
    const ext = pickImportExtension(queryFileName, contentType);

    const importsDir = getMobileImportsDir();
    const tmpName = `mobile_import_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
    const tmpPath = path.join(importsDir, tmpName);

    try {
      fs.writeFileSync(tmpPath, body);
    } catch (e) {
      reply.code(500);
      return {
        ok: false,
        error: `Failed to persist upload: ${e && e.message ? e.message : String(e)}`,
      };
    }

    try {
      const parsed = await parseBackupImportFile(tmpPath);
      if (!parsed || !parsed.success) {
        reply.code(422);
        return {
          ok: false,
          error: (parsed && parsed.error) || 'Backup parse failed',
          filePath: tmpPath,
        };
      }
      // We hand the phone enough to kick off `handleImportBackup`:
      // the parsed `json` payload and image dataUrls that still need to
      // land in Dexie via imageService.saveImageWithId. Voice /
      // ringtone were already unpacked server-side into userData/.
      // `filePath` is returned so the phone can optionally invoke
      // `backup:run-mobile-import` IPC to let the renderer drive the
      // rest of the import pipeline (updateBaseline, Zustand rehydrate,
      // memory re-embed) without duplicating that logic on mobile.
      return {
        ok: true,
        result: {
          success: true,
          filePath: tmpPath,
          fileName: parsed.fileName,
          json: parsed.json,
          images: parsed.images || [],
          imageCount: parsed.imageCount || 0,
        },
      };
    } catch (e) {
      reply.code(500);
      return {
        ok: false,
        error: e && e.message ? e.message : String(e),
        filePath: tmpPath,
      };
    } finally {
      // Fire-and-forget temp cleanup. A failed unlink leaves the file
      // under userData/mobile-imports/ where the OS disk-cleanup tools
      // can catch it later — we don't block the response on it.
      setImmediate(() => {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      });
    }
  });
}

module.exports = {
  registerBackupRoutes,
};
