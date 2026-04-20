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
// Zero behavior changes vs. the prior inline implementation in
// electron-main.cjs: file names, temp-file naming, ZIP layout, voice /
// ringtone unpacking targets (userData/voice/, userData/ringtone/), and
// the console.warn prefix for legacy kumiko_backup.json detection are all
// byte-identical.

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

async function parseBackupImportFile(filePath) {
  const normalizedPath = normalizeBackupFilePath(filePath);
  assertBackupPathAllowed(normalizedPath);
  const fileName = path.basename(normalizedPath);
  const extension = path.extname(normalizedPath).toLowerCase();

  if (extension === '.zip') {
    const zipBuffer = fs.readFileSync(normalizedPath);
    const zip = await JSZip.loadAsync(zipBuffer);
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

    const jsonText = await dataFile.async('string');
    const json = JSON.parse(jsonText);
    const images = [];
    const imagesFolder = zip.folder('images');

    if (imagesFolder) {
      const imageFiles = Object.keys(imagesFolder.files).filter((name) => !imagesFolder.files[name].dir);
      for (const imageName of imageFiles) {
        const imageFile = imagesFolder.files[imageName];
        const base64Data = await imageFile.async('base64');
        const ext = imageName.split('.').pop()?.toLowerCase();
        const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
        const id = imageName.split('/').pop()?.split('.')[0];

        if (!id) continue;

        images.push({
          id,
          dataUrl: `data:${mimeType};base64,${base64Data}`,
        });
      }
    }

    const voiceFolder = zip.folder('voice');
    if (voiceFolder) {
      const voiceDir = path.join(app.getPath('userData'), 'voice');
      if (!fs.existsSync(voiceDir)) fs.mkdirSync(voiceDir, { recursive: true });
      const voiceFiles = Object.keys(voiceFolder.files).filter(n => !voiceFolder.files[n].dir && n.endsWith('.mp3'));
      for (const vfName of voiceFiles) {
        const buf = await voiceFolder.files[vfName].async('nodebuffer');
        const id = vfName.split('/').pop();
        if (id) fs.writeFileSync(path.join(voiceDir, id), buf);
      }
    }

    const ringtoneFolder = zip.folder('ringtone');
    if (ringtoneFolder) {
      const ringtoneDir = path.join(app.getPath('userData'), 'ringtone');
      if (!fs.existsSync(ringtoneDir)) fs.mkdirSync(ringtoneDir, { recursive: true });
      const rtFiles = Object.keys(ringtoneFolder.files).filter(n => !ringtoneFolder.files[n].dir);
      for (const rtName of rtFiles) {
        const buf = await ringtoneFolder.files[rtName].async('nodebuffer');
        const fName = rtName.split('/').pop();
        if (fName) fs.writeFileSync(path.join(ringtoneDir, fName), buf);
      }
    }

    return {
      success: true,
      filePath: normalizedPath,
      fileName,
      json,
      images,
      imageCount: images.length,
    };
  }

  const content = fs.readFileSync(normalizedPath, 'utf8');
  const json = JSON.parse(content);

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
  writeBackupFile,
  readBackupFile,
  getBackupFileInfo,
  parseBackupImportFile,
  getDefaultBackupFilePath,
};
