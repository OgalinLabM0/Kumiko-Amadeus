// Shared backup ZIP builder. Extracted in Plan 14 Phase B.
//
// Owns the actual zipping of `data.json` + `images/` + `voice/` + `ringtone/`
// for BOTH the before-quit auto-backup flow (electron/auto-zip-backup.cjs)
// and the user-triggered manual export flow (components/app/backupActions.ts
// via the `backup:build-zip-from-payload` IPC handler in electron-main.cjs).
//
// Previous architecture (before Plan 14 Phase B):
//   - auto path:   main-process JSZip, reads userData/* from fs.
//   - manual path: renderer-process JSZip, reads images from Dexie + voice/
//                  ringtone via IPC.
// Two independent implementations that drifted over time and each had to be
// kept in sync with every new media folder. This module collapses them into
// one code path; userData/images|voice|ringtone is the unambiguous source
// of truth for binary media (imageService writes to both Dexie and userData;
// voice / ringtone live only in userData).
//
// Caller contract:
//   - Renderer callers must produce `dataJsonString` themselves (the renderer
//     has the Zustand store + Dexie vectors / episodes etc.) and pass it in.
//     Main process does NOT re-read app state; it only stamps _autoZipMeta
//     on the auto path.
//   - `outputPath` must be an absolute path the main process is allowed to
//     write to. For manual exports this comes from a native save dialog; for
//     auto-backup it's `path.dirname(latestJson)/kumiko_backup_auto.zip`.
//
// Failure modes:
//   - If a media folder is missing or unreadable, the builder skips that
//     folder entirely (warning log) instead of aborting. On auto mode, images
//     errors get stamped into `_autoZipMeta.imagesErrorReason` so the
//     importer can surface a degraded-backup notice.
//   - If JSON.parse on `dataJsonString` fails in auto mode (malformed live
//     backup), we give up stamping and write the raw string verbatim so the
//     core backup is never lost to a cosmetic metadata patch.

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { app } = require('electron');

const IMAGE_NAME_REGEX = /^[\w-]+\.(jpg|jpeg|png|webp|gif)$/i;
const RINGTONE_AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.m4a', '.flac'];

function attachImagesFolder(zip, userDataDir) {
  const result = {
    imagesIncluded: 0,
    imagesTotal: 0,
    imagesErrorReason: null,
  };
  try {
    const imagesDir = path.join(userDataDir, 'images');
    if (!fs.existsSync(imagesDir)) return result;
    const imageEntries = fs
      .readdirSync(imagesDir)
      .filter((f) => IMAGE_NAME_REGEX.test(f));
    result.imagesTotal = imageEntries.length;
    if (imageEntries.length === 0) return result;
    const imagesFolder = zip.folder('images');
    for (const fileName of imageEntries) {
      try {
        imagesFolder.file(fileName, fs.readFileSync(path.join(imagesDir, fileName)));
        result.imagesIncluded += 1;
      } catch (imgErr) {
        console.warn('[backup-zip-builder] Skipped image', fileName, imgErr);
      }
    }
  } catch (e) {
    result.imagesErrorReason = (e && e.message) ? e.message : String(e);
    console.warn('[backup-zip-builder] Images snapshot failed:', e);
  }
  return result;
}

function attachVoiceFolder(zip, userDataDir) {
  try {
    const voiceDir = path.join(userDataDir, 'voice');
    if (!fs.existsSync(voiceDir)) return;
    const voiceFolder = zip.folder('voice');
    const vFiles = fs.readdirSync(voiceDir);
    for (const f of vFiles) {
      if (!f.endsWith('.mp3')) continue;
      try {
        voiceFolder.file(f, fs.readFileSync(path.join(voiceDir, f)));
      } catch (voiceErr) {
        console.warn('[backup-zip-builder] Skipped voice', f, voiceErr);
      }
    }
  } catch (e) {
    console.warn('[backup-zip-builder] Voice snapshot failed:', e);
  }
}

function attachRingtoneFolder(zip, userDataDir) {
  try {
    const ringtoneDir = path.join(userDataDir, 'ringtone');
    if (!fs.existsSync(ringtoneDir)) return;
    const ringtoneFolder = zip.folder('ringtone');
    const rFiles = fs.readdirSync(ringtoneDir).filter((f) => {
      if (!f.startsWith('custom.')) return false;
      if (f.endsWith('.meta.json')) return true;
      return RINGTONE_AUDIO_EXTS.some((ext) => f.endsWith(ext));
    });
    for (const f of rFiles) {
      try {
        ringtoneFolder.file(f, fs.readFileSync(path.join(ringtoneDir, f)));
      } catch (rtErr) {
        console.warn('[backup-zip-builder] Skipped ringtone', f, rtErr);
      }
    }
  } catch (e) {
    console.warn('[backup-zip-builder] Ringtone snapshot failed:', e);
  }
}

function stampAutoZipMeta(dataJsonString, autoZipMeta) {
  try {
    const parsed = JSON.parse(dataJsonString);
    return JSON.stringify({ ...parsed, _autoZipMeta: autoZipMeta }, null, 2);
  } catch (patchErr) {
    console.warn('[backup-zip-builder] Failed to stamp _autoZipMeta; writing raw bytes:', patchErr);
    return dataJsonString;
  }
}

/**
 * Build a backup ZIP.
 *
 * @param {object} params
 * @param {string} params.dataJsonString Already-serialized backup JSON.
 *   Caller is responsible for worldBook sanitization and any other payload
 *   shaping. On `mode: 'auto'` we re-parse and re-serialize to stamp
 *   `_autoZipMeta`; on `mode: 'manual'` we write the string verbatim.
 * @param {'manual' | 'auto'} params.mode
 * @param {string} params.outputPath Absolute destination path for the ZIP.
 * @param {string} [params.userDataDir] Override `app.getPath('userData')`
 *   (test seam).
 * @returns {Promise<{ success: boolean, bytesWritten?: number, imagesIncluded?: number, imagesTotal?: number, autoZipMeta?: object | null, error?: string }>}
 */
async function assembleZipBuffer({ dataJsonString, mode, userDataDir }) {
  const ud = userDataDir || app.getPath('userData');
  const zip = new JSZip();

  const imagesResult = attachImagesFolder(zip, ud);
  attachVoiceFolder(zip, ud);
  attachRingtoneFolder(zip, ud);

  let autoZipMeta = null;
  let dataJsonPayload = dataJsonString;
  if (mode === 'auto') {
    autoZipMeta = {
      autoZipGeneratedAt: new Date().toISOString(),
      hasImages: imagesResult.imagesIncluded > 0,
      imagesIncludedCount: imagesResult.imagesIncluded,
      imagesTotalCount: imagesResult.imagesTotal,
    };
    if (imagesResult.imagesErrorReason) {
      autoZipMeta.imagesErrorReason = imagesResult.imagesErrorReason;
    }
    dataJsonPayload = stampAutoZipMeta(dataJsonString, autoZipMeta);
  }

  zip.file('data.json', dataJsonPayload);

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });

  return { buffer, imagesResult, autoZipMeta };
}

async function buildBackupZip({ dataJsonString, mode, outputPath, userDataDir }) {
  if (typeof dataJsonString !== 'string' || dataJsonString.length === 0) {
    return { success: false, error: 'dataJsonString is required and must be a non-empty string' };
  }
  if (mode !== 'manual' && mode !== 'auto') {
    return { success: false, error: `Unknown mode: ${mode}` };
  }
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    return { success: false, error: 'outputPath is required' };
  }

  try {
    const { buffer, imagesResult, autoZipMeta } = await assembleZipBuffer({
      dataJsonString, mode, userDataDir,
    });
    fs.writeFileSync(outputPath, buffer);
    return {
      success: true,
      bytesWritten: buffer.length,
      imagesIncluded: imagesResult.imagesIncluded,
      imagesTotal: imagesResult.imagesTotal,
      autoZipMeta,
    };
  } catch (writeErr) {
    console.error('[backup-zip-builder] ZIP generation / write failed:', writeErr);
    return {
      success: false,
      error: (writeErr && writeErr.message) ? writeErr.message : String(writeErr),
    };
  }
}

/**
 * In-memory variant of `buildBackupZip`. Used by the mobile HTTP export
 * route which streams the zip buffer straight to the phone instead of
 * landing it on disk. Same media attachment + _autoZipMeta stamping as
 * `buildBackupZip` (both go through the shared `assembleZipBuffer`
 * helper so the zip layout stays byte-identical across manual, auto,
 * and mobile paths).
 *
 * @returns {Promise<{ success: boolean, buffer?: Buffer, bytesWritten?: number, imagesIncluded?: number, imagesTotal?: number, autoZipMeta?: object | null, error?: string }>}
 */
async function buildBackupZipBuffer({ dataJsonString, mode = 'manual', userDataDir }) {
  if (typeof dataJsonString !== 'string' || dataJsonString.length === 0) {
    return { success: false, error: 'dataJsonString is required and must be a non-empty string' };
  }
  if (mode !== 'manual' && mode !== 'auto') {
    return { success: false, error: `Unknown mode: ${mode}` };
  }
  try {
    const { buffer, imagesResult, autoZipMeta } = await assembleZipBuffer({
      dataJsonString, mode, userDataDir,
    });
    return {
      success: true,
      buffer,
      bytesWritten: buffer.length,
      imagesIncluded: imagesResult.imagesIncluded,
      imagesTotal: imagesResult.imagesTotal,
      autoZipMeta,
    };
  } catch (e) {
    console.error('[backup-zip-builder] ZIP buffer assembly failed:', e);
    return {
      success: false,
      error: (e && e.message) ? e.message : String(e),
    };
  }
}

module.exports = {
  buildBackupZip,
  buildBackupZipBuffer,
};
