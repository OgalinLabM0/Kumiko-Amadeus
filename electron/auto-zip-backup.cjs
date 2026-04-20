// Auto-ZIP backup at app-quit. Extracted from electron-main.cjs
// (Plan 9 SubPhase 3.3); delegates ZIP assembly to backup-zip-builder.cjs
// (Plan 14 Phase B).
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
//   - Media snapshots (images / voice / ringtone file filters) and the
//     `_autoZipMeta` stamp live inside backup-zip-builder.cjs now; this
//     module only locates the latest data.json, computes the output
//     path, and drives the shared builder.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { readConfigValue, writeConfigValue } = require('./user-config.cjs');
const { getLastWrittenBackupPath } = require('./backup-ipc.cjs');
const { isUpdateInstalling } = require('./app-updater.cjs');
const { buildBackupZip } = require('./backup-zip-builder.cjs');

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

    // Read the live JSON backup and hand everything else (media folders,
    // _autoZipMeta stamp, zip assembly, fs write) to the shared builder.
    let dataJsonString;
    try {
      dataJsonString = fs.readFileSync(latestJson, 'utf-8');
    } catch (readErr) {
      console.error('[AUTO BACKUP] Failed to read latest JSON backup:', readErr);
      isAutoBackupDone = true;
      app.quit();
      return;
    }

    const outputPath = path.join(path.dirname(latestJson), 'kumiko_backup_auto.zip');
    buildBackupZip({ dataJsonString, mode: 'auto', outputPath })
      .then((result) => {
        if (result.success) {
          console.log('[AUTO BACKUP] Auto ZIP backup created:', path.basename(outputPath), {
            imagesIncluded: result.imagesIncluded,
            imagesTotal: result.imagesTotal,
          });
        } else {
          console.error('[AUTO BACKUP] ZIP generation failed:', result.error);
        }
      })
      .catch((err) => {
        console.error('[AUTO BACKUP] Unexpected builder failure:', err);
      })
      .finally(() => {
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
