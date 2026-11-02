// electron/backup-files.cjs
//
// Backup file I/O helpers for the main process. This module owns the actual
// bytes-on-disk side of backups — writing / reading JSON backup files, the
// atomic rename-on-write temp-file pattern, and the ZIP import parser that
// unpacks data.json + images/ + voice/ + ringtone/ into a restore-ready
// payload.
//
// Every public function gates its filesystem access through
// assertBackupPathAllowed(), which in turn consults authorized-paths.cjs.
// Paths outside userData must have been explicitly picked by the user via
// a native dialog (backup:pick-save-file / backup:pick-open-file) — the
// renderer cannot grow the authorization set, so a compromised renderer
// cannot redirect backup IO to arbitrary disk locations.
//
// Legacy kumiko_backup.json archives remain readable.

'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const JSZip = require('jszip');

const { isBackupPathAuthorized } = require('./authorized-paths.cjs');

function ensureDirectory(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }
}

function normalizeBackupFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('A valid backup file path is required.');
  }

  return path.resolve(filePath);
}

// Check whether a resolved path is allowed for backup IO. Allowed paths are:
//   1. Anything under the app's userData directory (our own data, safe to read/write).
//   2. Anything the user explicitly approved in this session via pick-save / pick-open
//      (tracked by the authorized-paths module's allowedBackupPaths Set).
// This prevents a compromised renderer from asking the main process to read or overwrite
// arbitrary files on the user's disk (e.g., AppData of other applications, system files).
function assertBackupPathAllowed(resolvedPath) {
  if (typeof resolvedPath !== 'string' || !resolvedPath) {
    throw new Error('Backup path is required.');
  }
  const userDataRoot = path.resolve(app.getPath('userData'));
  const isInsideUserData = resolvedPath === userDataRoot
    || resolvedPath.startsWith(userDataRoot + path.sep);
  if (isInsideUserData) return;
  if (isBackupPathAuthorized(resolvedPath)) return;
  throw new Error('Backup path not authorized. Please re-select the file via the native dialog.');
}

function writeBackupFile(filePath, content) {
  const normalizedPath = normalizeBackupFilePath(filePath);
  assertBackupPathAllowed(normalizedPath);
  const serializedContent = typeof content === 'string' ? content : String(content ?? '');
  const tempFilePath = `${normalizedPath}.${process.pid}.tmp`;

  ensureDirectory(path.dirname(normalizedPath));

  try {
    fs.writeFileSync(tempFilePath, serializedContent, 'utf8');
    fs.renameSync(tempFilePath, normalizedPath);
  } catch (error) {
    try {
      if (fs.existsSync(tempFilePath)) {
        fs.rmSync(tempFilePath, { force: true });
      }
    } catch {
      // Ignore temp cleanup failures.
    }

    throw error;
  }

  return {
    success: true,
    filePath: normalizedPath,
    fileName: path.basename(normalizedPath),
  };
}

function readBackupFile(filePath) {
  const normalizedPath = normalizeBackupFilePath(filePath);
  assertBackupPathAllowed(normalizedPath);

  return {
    success: true,
    filePath: normalizedPath,
    fileName: path.basename(normalizedPath),
    content: fs.readFileSync(normalizedPath, 'utf8'),
  };
}

function getBackupFileInfo(filePath) {
  const normalizedPath = normalizeBackupFilePath(filePath);
  assertBackupPathAllowed(normalizedPath);

  return {
    success: true,
    exists: fs.existsSync(normalizedPath),
    filePath: normalizedPath,
    fileName: path.basename(normalizedPath),
  };
}

async function parseBackupImportFile(filePath, password) {
  const { validateBackupImportPayload } = await import('./backup-import-validation.mjs');
  const normalizedPath = normalizeBackupFilePath(filePath);
  assertBackupPathAllowed(normalizedPath);
  const fileName = path.basename(normalizedPath);
  if (fs.statSync(normalizedPath).size > 720 * 1024 * 1024) throw new Error('Backup is too large');
  let extension = path.extname(normalizedPath).toLowerCase();
  let source = fs.readFileSync(normalizedPath);
  const crypto = await import('../services/portableBackupCrypto.mjs');
  if (crypto.isEncryptedBackup(source.subarray(0, 16).toString('utf8'))) {
    const decoded = await crypto.decryptPortableBackup(source.toString('utf8'), password);
    source = Buffer.from(decoded.bytes);
    extension = decoded.kind === 'zip' ? '.zip' : '.json';
  }

  if (extension === '.zip') {
    const zipBuffer = source;
    const zip = await JSZip.loadAsync(zipBuffer);
    const { createBackupArchiveReader } = await import('../services/backupArchiveValidation.mjs');
    const reader = createBackupArchiveReader(zip);
    let dataFile = zip.file('data.json');
    if (!dataFile) {
      dataFile = zip.file('kumiko_backup.json');
      if (dataFile) {
        console.warn('[IMPORT] Legacy auto-backup filename kumiko_backup.json detected; please re-export after loading to migrate.');
      }
    }

    if (!dataFile) {
      throw new Error('data.json not found in ZIP');
    }

    const jsonText = await reader.read(dataFile, 'string');
    const json = JSON.parse(jsonText);
    const validation = validateBackupImportPayload(json);
    if (!validation.valid) {
      throw new Error(`Invalid backup payload: ${validation.reason || 'unrecognized structure'}`);
    }
    const images = [];
    const imagesFolder = zip.folder('images');

    if (imagesFolder) {
      const imageFiles = Object.keys(imagesFolder.files).filter((name) => name.startsWith('images/') && !imagesFolder.files[name].dir);
      for (const imageName of imageFiles) {
        const imageFile = imagesFolder.files[imageName];
        const base64Data = await reader.read(imageFile, 'base64');
        const ext = imageName.split('.').pop()?.toLowerCase();
        const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
        const id = imageName.split('/').pop()?.split('.')[0];

        if (!id) continue;

        images.push({
          id,
          dataUrl: `data:${mimeType};base64,${base64Data}`,
        });
      }
    }

    // Parsing is read-only: restore commits media only after validation.
    const voices = [];
    const voiceFolder = zip.folder('voice');
    if (voiceFolder) {
      for (const name of Object.keys(voiceFolder.files).filter(n => n.startsWith('voice/') && !voiceFolder.files[n].dir && /\.mp3$/i.test(n))) {
        const id = name.split('/').pop()?.replace(/\.mp3$/i, '');
        if (id) voices.push({ id, base64: await reader.read(voiceFolder.files[name], 'base64') });
      }
    }
    const ringtoneFolder = zip.folder('ringtone');
    let ringtone;
    if (ringtoneFolder) {
      const audio = Object.keys(ringtoneFolder.files).filter(n => n.startsWith('ringtone/') && !ringtoneFolder.files[n].dir && /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(n));
      if (audio.length > 1) throw new Error('Backup has multiple custom ringtones');
      if (audio.length) {
        const meta = ringtoneFolder.file('custom.meta.json');
        const parsed = meta ? JSON.parse(await reader.read(meta, 'string')) : null;
        ringtone = { base64: await reader.read(ringtoneFolder.files[audio[0]], 'base64'), ext: audio[0].split('.').pop(), originalName: parsed?.originalName || audio[0].split('/').pop() };
      }
    }

    return {
      success: true,
      filePath: normalizedPath,
      fileName,
      json,
      images,
      voices,
      ringtone,
      imageCount: images.length,
    };
  }

  const content = source.toString('utf8');
  const json = JSON.parse(content);
  const validation = validateBackupImportPayload(json);
  if (!validation.valid) {
    throw new Error(`Invalid backup payload: ${validation.reason || 'unrecognized structure'}`);
  }

  return {
    success: true,
    filePath: normalizedPath,
    fileName,
    json,
    images: [],
    imageCount: 0,
  };
}

function getDefaultBackupFilePath(defaultFileName) {
  const normalizedFileName = defaultFileName && typeof defaultFileName === 'string'
    ? defaultFileName
    : `kumiko_backup_${new Date().toISOString().slice(0, 10)}.json`;

  return path.join(app.getPath('documents'), normalizedFileName);
}

module.exports = {
  assertBackupPathAllowed,
  writeBackupFile,
  readBackupFile,
  getBackupFileInfo,
  parseBackupImportFile,
  getDefaultBackupFilePath,
};
