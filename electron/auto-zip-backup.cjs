// Auto-ZIP backup at app-quit. Extracted from electron-main.cjs
// (Plan 9 SubPhase 3.3).
//
// Owns the "roll the most recent JSON backup + userData media into
// kumiko_backup_auto.zip before the app actually exits" flow, plus the
// two small IPC handlers that let the renderer toggle the feature flag
// in `user-config` (AutoZipBackupEnabled).
//
// Behaviour preservation (do not change without test coverage):
//   - `runAutoZipBeforeQuit` is the only handler `electron-main` binds
//     to `app.on('before-quit', ...)`. It *must* short-circuit when
//     the feature is disabled, when an update is about to install
//     (`isUpdateInstalling`), and when it has already run once
//     (`isAutoBackupDone` gate) — otherwise we recurse into `app.quit()`.
//   - `event.preventDefault()` on first entry lets us finish the zip
//     job on a background Promise before the process actually exits;
//     the `.finally()` calls `markAutoBackupDone(true)` + `app.quit()`
//     to let the second pass through before-quit short-circuit and let
//     Electron tear down normally.
//   - `app:auto-zip-progress` message to the renderer is best-effort;
//     if the window is gone we swallow the send error.
//   - Media (images / voice / ringtone) snapshots match the exact same
//     file filters used by the main backup pipeline (images regex,
//     voice .mp3 only, ringtone custom.* + whitelisted audio exts).

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { app } = require('electron');
const { readConfigValue, writeConfigValue } = require('./user-config.cjs');
const { getLastWrittenBackupPath } = require('./backup-ipc.cjs');
const { isUpdateInstalling } = require('./app-updater.cjs');

// Renderer target for `app:auto-zip-progress` progress messages.
// Injected via setAutoZipProgressTarget(mainWindow) from electron-main.cjs
// inside createWindow, same setter pattern as
// setBackupDialogParent / setGenieDialogParent / setAppUpdaterWindow.
let progressTarget = null;

// Re-entry guard. Flipped to true the first time we reach app.quit(),
// so the subsequent before-quit pass falls through without running the
// zip job a second time. Also flipped true by updater lifecycle hook
// (beforeQuitForInstall) so an installer-driven quit skips auto-backup.
let isAutoBackupDone = false;

function setAutoZipProgressTarget(win) {
  progressTarget = win || null;
}

function markAutoBackupDone(value) {
  isAutoBackupDone = !!value;
}

function handleSetAutoZip(_event, payload = {}) {
  try {
    const enabled = !!payload.enabled;
    writeConfigValue('AutoZipBackupEnabled', enabled ? '1' : '0');
    return { success: true, enabled };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function handleGetAutoZip() {
  try {
    const val = readConfigValue('AutoZipBackupEnabled');
    return { success: true, enabled: val === '1' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function runAutoZipBeforeQuit(event) {
  if (isAutoBackupDone || isUpdateInstalling()) return;
  try {
    const autoZipVal = readConfigValue('AutoZipBackupEnabled');
    if (autoZipVal !== '1') return;

    event.preventDefault();
    console.log('[AUTO BACKUP] Starting auto ZIP backup before quit...');
    if (progressTarget && !progressTarget.isDestroyed()) {
      try { progressTarget.webContents.send('app:auto-zip-progress', { status: 'start' }); } catch(_e){}
    }

    let latestJson = null;

    const lastWritten = getLastWrittenBackupPath();
    if (lastWritten && fs.existsSync(lastWritten)) {
      latestJson = lastWritten;
    } else {
      const searchDirs = [app.getPath('documents'), app.getPath('userData')];
      let latestMtime = 0;
      for (const dir of searchDirs) {
        try {
          const files = fs.readdirSync(dir);
          for (const file of files) {
            if (file.startsWith('kumiko_backup_') && file.endsWith('.json')) {
              const fullPath = path.join(dir, file);
              const stat = fs.statSync(fullPath);
              if (stat.mtimeMs > latestMtime) {
                latestMtime = stat.mtimeMs;
                latestJson = fullPath;
              }
            }
          }
        } catch (_) {}
      }
    }

    if (!latestJson) {
      console.log('[AUTO BACKUP] No JSON backup found, skipping.');
      isAutoBackupDone = true;
      app.quit();
      return;
    }

    const zip = new JSZip();

    // P0 #2 (Plan 2): attach images/ snapshot and stamp _autoZipMeta so the
    // importer can detect degraded auto-backups. Images live as real files
    // under userData/images/{id}.{ext} (see imageService.ts + images:save
    // handler above), so we can just read the folder directly from the main
    // process — no IPC round-trip needed. The manual-export path does the
    // equivalent from renderer-side Dexie; for the auto-backup path,
    // filesystem is the source of truth.
    const autoZipMeta = {
      autoZipGeneratedAt: new Date().toISOString(),
      hasImages: false,
      imagesIncludedCount: 0,
      imagesTotalCount: 0,
    };
    try {
      const imagesDir = path.join(app.getPath('userData'), 'images');
      if (fs.existsSync(imagesDir)) {
        const imageEntries = fs.readdirSync(imagesDir)
          .filter((f) => /^[\w-]+\.(jpg|jpeg|png|webp|gif)$/i.test(f));
        autoZipMeta.imagesTotalCount = imageEntries.length;
        if (imageEntries.length > 0) {
          const imagesFolder = zip.folder('images');
          for (const fileName of imageEntries) {
            try {
              imagesFolder.file(fileName, fs.readFileSync(path.join(imagesDir, fileName)));
              autoZipMeta.imagesIncludedCount += 1;
            } catch (imgErr) {
              console.warn('[AUTO BACKUP] Skipped image', fileName, imgErr);
            }
          }
          autoZipMeta.hasImages = autoZipMeta.imagesIncludedCount > 0;
        }
      }
    } catch (imgListErr) {
      autoZipMeta.imagesErrorReason = imgListErr && imgListErr.message ? imgListErr.message : String(imgListErr);
      console.warn('[AUTO BACKUP] Images snapshot failed:', imgListErr);
    }

    // Stamp _autoZipMeta into data.json by re-parsing + re-serializing. If
    // the latest JSON is malformed, fall back to writing the raw bytes
    // untouched so the core backup is never lost to a cosmetic metadata
    // patch.
    let dataJsonPayload;
    try {
      const parsedBackup = JSON.parse(fs.readFileSync(latestJson, 'utf-8'));
      dataJsonPayload = JSON.stringify({ ...parsedBackup, _autoZipMeta: autoZipMeta }, null, 2);
    } catch (patchErr) {
      console.warn('[AUTO BACKUP] Failed to stamp _autoZipMeta into data.json; writing raw bytes:', patchErr);
      dataJsonPayload = fs.readFileSync(latestJson);
    }
    zip.file('data.json', dataJsonPayload);

    const voiceDir = path.join(app.getPath('userData'), 'voice');
    if (fs.existsSync(voiceDir)) {
      const voiceFolder = zip.folder('voice');
      const vFiles = fs.readdirSync(voiceDir);
      for (const f of vFiles) {
        if (f.endsWith('.mp3')) {
          voiceFolder.file(f, fs.readFileSync(path.join(voiceDir, f)));
        }
      }
    }

    const ringtoneDir = path.join(app.getPath('userData'), 'ringtone');
    if (fs.existsSync(ringtoneDir)) {
      const ringtoneFolder = zip.folder('ringtone');
      const audioExts = ['.mp3', '.wav', '.ogg', '.m4a', '.flac'];
      const rFiles = fs.readdirSync(ringtoneDir).filter(f => f.startsWith('custom.') && audioExts.some(ext => f.endsWith(ext)));
      for (const f of rFiles) {
        ringtoneFolder.file(f, fs.readFileSync(path.join(ringtoneDir, f)));
      }
    }

    zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }).then((zipContent) => {
      const zipName = 'kumiko_backup_auto.zip';
      const zipPath = path.join(path.dirname(latestJson), zipName);
      fs.writeFileSync(zipPath, zipContent);
      console.log('[AUTO BACKUP] Auto ZIP backup created:', zipName);
    }).catch((err) => {
      console.error('[AUTO BACKUP] ZIP generation failed:', err);
    }).finally(() => {
      isAutoBackupDone = true;
      app.quit();
    });
  } catch (e) {
    console.error('[AUTO BACKUP] Failed during before-quit:', e);
    isAutoBackupDone = true;
    app.quit();
  }
}

module.exports = {
  setAutoZipProgressTarget,
  markAutoBackupDone,
  handleGetAutoZip,
  handleSetAutoZip,
  runAutoZipBeforeQuit,
};
