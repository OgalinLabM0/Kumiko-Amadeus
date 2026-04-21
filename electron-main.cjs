const { app, BrowserWindow, Menu, ipcMain, dialog, protocol } = require('electron');
const path = require('path');
const { initRag, closeRag } = require('./electron-rag.cjs');
const {
  migrateRegistryToConfigStoreOnce,
} = require('./electron/user-config.cjs');
const {
  loadAllAuthorizedPaths,
} = require('./electron/authorized-paths.cjs');
const {
  findImageFile,
  handleImagesSave,
  handleImagesLoad,
  handleImagesDelete,
  handleImagesList,
  handleImagesOpenFolder,
  handleImagesGetStorageInfo,
  handleVoiceSave,
  handleVoiceLoad,
  handleVoiceDelete,
  handleVoiceList,
  handleVoiceOpenFolder,
  handleVoiceGetStorageInfo,
  handleRingtoneSave,
  handleRingtoneLoad,
  handleRingtoneDelete,
  handleRingtoneGetInfo,
  handleRingtoneOpenFolder,
} = require('./electron/media-files.cjs');
const {
  setAppUpdaterLifecycleHooks,
  getUpdateState,
  checkForAppUpdates,
  downloadAppUpdate,
  quitAndInstallAppUpdate,
  setupAutoUpdater,
  cleanupUpdaterCache,
} = require('./electron/app-updater.cjs');
const {
  getDefaultUserDataPath,
  getManagedDataDirectoryPath,
  promoteDefaultUserDataPath,
  applyConfiguredUserDataPath,
  processPendingUserDataMigration,
  getDataDirectoryInfo,
  scheduleUserDataMigration,
} = require('./electron/user-data-migration.cjs');
const {
  terminateGenieProcess,
  handlePickSovitsDir,
  handlePickSovitsPython,
  handleTestSovitsPython,
  handleStart: handleGenieStart,
  handleStop: handleGenieStop,
  handleStatus: handleGenieStatus,
} = require('./electron/genie-process.cjs');
const {
  handleGetWeather,
  handleGetHistoricalWeather,
  handleGetJapanHolidays,
} = require('./electron/weather-calendar.cjs');
const {
  handlePickSaveFile,
  handlePickOpenFile,
  handleWriteFile,
  handleReadFile,
  handleGetFileInfo,
  handleParseImportFile,
  handleBuildZipFromPayload,
} = require('./electron/backup-ipc.cjs');
const {
  markAutoBackupDone,
  handleGetAutoZip,
  handleSetAutoZip,
  runAutoZipBeforeQuit,
} = require('./electron/auto-zip-backup.cjs');
const {
  applyUnreadShellState,
  handleShowWindow,
  handleSendNotification,
  handleSendCallNotification,
  handleCloseCallNotification,
  handleUpdateUnreadState,
} = require('./electron/notifications.cjs');
const {
  createWindow,
  createTray,
  getMainWindow,
  focusMainWindow,
  handleSetBgColor,
  handleSetBackgroundThrottling,
  handleRefocusWebcontents,
  handleOpenExternal,
} = require('./electron/window-manager.cjs');
const mobileAccessIpc = require('./electron/server/mobile-access-ipc.cjs');
const mobileAccessAuth = require('./electron/server/auth.cjs');
const mobileFs = require('./electron/mobile-fs.cjs');

// Platform detection. Used throughout this file to branch registry/PowerShell
// (Windows-only) vs JSON config store (Linux), drive-letter preference (Windows)
// vs XDG_DATA_HOME (Linux), and the SoVITS launch pipeline.
const IS_WINDOWS = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const IS_MAC = process.platform === 'darwin';

// --- Chromium GPU acceleration flags (must be applied before app.whenReady) ---
// P2 #51: trimmed flag set.
//   - Dropped `ignore-gpu-blocklist`: forcing the GPU path on blocklisted drivers
//     crashes Chromium on a non-trivial fraction of older Intel/AMD laptops.
//     We accept the slightly slower software-composite fallback on those
//     machines rather than hard-crashing the app.
//   - Dropped `PaintHolding` from enable-features: that experiment was part of
//     the rolled-back resize "paint hold" investigation. The currently shipping
//     resize smoothing comes from the backdrop-filter freeze CSS in index.html
//     and the theme-matched BrowserWindow.backgroundColor below. (The earlier
//     `opacity: 0.9999` transparent-composition workaround was removed in the
//     resize_brown_flash_fix plan: it caused newly-exposed pixels during resize
//     to show the desktop underneath.) Leaving this feature flag on was just
//     experimental surface area that could shift composition behaviour
//     between Electron versions.
//   - Kept zero-copy + GPU rasterization + Skia/Canvas OOP raster, which are
//     low-risk and well-established.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-features', 'UseSkiaRenderer,CanvasOopRasterization');

// electron-updater side-effects (skip auto-backup + mark quitting intent
// for the tray/window-close logic) get invoked by app-updater.cjs via
// setAppUpdaterLifecycleHooks, registered during app initialization
// below. `markAutoBackupDone` lives on auto-zip-backup.cjs now, so the
// updater hooks just flip its private flag through the exported setter.
setAppUpdaterLifecycleHooks({
  beforeQuitForInstall: () => {
    markAutoBackupDone(true);
    app.isQuiting = true;
  },
  onQuitAndInstallError: () => {
    markAutoBackupDone(false);
  },
});

// Initialization order matters: migrate legacy Windows HKCU keys into
// the JSON config store first, then replay any pending data-directory
// migration persisted from the previous session, then promote to the
// preferred default (Linux XDG / Windows non-system-drive sibling),
// then apply the resolved userData path onto app.setPath. Anything
// calling app.getPath('userData') before this block sees the Electron
// default, not the final location — keep this trio flush against the
// start of the module.
migrateRegistryToConfigStoreOnce();
processPendingUserDataMigration();
promoteDefaultUserDataPath();
applyConfiguredUserDataPath();

// Global remove application basic menus
Menu.setApplicationMenu(null);

// Module-level IPC: theme-matched BrowserWindow background color.
// Placed here (not inside createWindow) so it is registered exactly once.
ipcMain.on('app:set-bg-color', handleSetBgColor);

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', focusMainWindow);

  ipcMain.on('show-window', handleShowWindow);
  ipcMain.on('app:send-notification', handleSendNotification);
  ipcMain.on('app:send-call-notification', handleSendCallNotification);
  ipcMain.on('app:close-call-notification', handleCloseCallNotification);
  ipcMain.on('app:update-unread-state', handleUpdateUnreadState);

  ipcMain.handle('quit-app', () => {
    app.isQuiting = true;
    app.quit();
    return { success: true };
  });

  ipcMain.handle('app:update:get-state', () => {
    return { success: true, state: getUpdateState() };
  });

  ipcMain.handle('app:update:check', async () => {
    return checkForAppUpdates('manual');
  });

  ipcMain.handle('app:update:download', async () => {
    return downloadAppUpdate();
  });

  ipcMain.handle('app:update:quit-and-install', async () => {
    return quitAndInstallAppUpdate();
  });

  ipcMain.handle('app:get-weather', handleGetWeather);
  ipcMain.handle('app:get-historical-weather', handleGetHistoricalWeather);
  ipcMain.handle('app:get-japan-holidays', handleGetJapanHolidays);

  ipcMain.handle('app:get-data-directory-info', () => getDataDirectoryInfo());

  ipcMain.handle('app:set-background-throttling', handleSetBackgroundThrottling);
  ipcMain.handle('app:refocus-webcontents', handleRefocusWebcontents);
  ipcMain.handle('app:open-external', handleOpenExternal);

  ipcMain.handle('app:pick-data-directory', async () => {
    const result = await dialog.showOpenDialog(getMainWindow() || undefined, {
      title: 'Select Kumiko·Amadeus data location',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: path.dirname(app.getPath('userData'))
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    return {
      canceled: false,
      targetPath: getManagedDataDirectoryPath(result.filePaths[0]),
      selectedRoot: result.filePaths[0]
    };
  });

  ipcMain.handle('app:migrate-data-directory', (_event, payload = {}) => {
    const targetPath = payload.targetPath;
    if (!targetPath || typeof targetPath !== 'string') {
      return { success: false, error: 'No target path was provided.' };
    }
    return scheduleUserDataMigration(targetPath);
  });

  ipcMain.handle('app:reset-data-directory', () => {
    return scheduleUserDataMigration(getDefaultUserDataPath());
  });

  // ── Media file IPC (images / voice / ringtone) ─────────────────
  // Implementation lives in electron/media-files.cjs; we only register
  // the channel → handler binding here so the IPC surface stays visible
  // in one file. All three namespaces share a path-traversal-hardened
  // resolver + SAFE_*_ID regex pattern. See module header for details.

  ipcMain.handle('images:save', handleImagesSave);
  ipcMain.handle('images:load', handleImagesLoad);
  ipcMain.handle('images:delete', handleImagesDelete);
  ipcMain.handle('images:list', handleImagesList);
  ipcMain.handle('images:open-folder', handleImagesOpenFolder);
  ipcMain.handle('images:get-storage-info', handleImagesGetStorageInfo);

  ipcMain.handle('voice:save', handleVoiceSave);
  ipcMain.handle('voice:load', handleVoiceLoad);
  ipcMain.handle('voice:delete', handleVoiceDelete);
  ipcMain.handle('voice:list', handleVoiceList);
  ipcMain.handle('voice:open-folder', handleVoiceOpenFolder);
  ipcMain.handle('voice:get-storage-info', handleVoiceGetStorageInfo);

  ipcMain.handle('ringtone:save', handleRingtoneSave);
  ipcMain.handle('ringtone:load', handleRingtoneLoad);
  ipcMain.handle('ringtone:delete', handleRingtoneDelete);
  ipcMain.handle('ringtone:get-info', handleRingtoneGetInfo);
  ipcMain.handle('ringtone:open-folder', handleRingtoneOpenFolder);

  // ── Backup file IPC ────────────────────────────────────────────

  ipcMain.handle('backup:pick-save-file', handlePickSaveFile);
  ipcMain.handle('backup:pick-open-file', handlePickOpenFile);
  ipcMain.handle('backup:write-file', handleWriteFile);
  ipcMain.handle('backup:read-file', handleReadFile);
  ipcMain.handle('backup:get-file-info', handleGetFileInfo);
  ipcMain.handle('backup:parse-import-file', handleParseImportFile);
  ipcMain.handle('backup:build-zip-from-payload', handleBuildZipFromPayload);

  // ── Phase 6 Part C: mobile remote filesystem + desktop backup I/O ──
  // Registers:
  //   fs:get-mobile-browse-root
  //   fs:set-mobile-browse-root        (desktop-renderer only — not in HTTP allowlist)
  //   fs:pick-mobile-browse-root       (desktop-renderer only — opens native dialog)
  //   fs:list-directory
  //   fs:get-shortcuts
  //   fs:check-path-exists
  //   backup:read-desktop-file
  //   backup:write-desktop-file
  //   backup:set-desktop-backup-path   (broadcasts backup:desktop-path-changed to phones)
  //   backup:disconnect-desktop-file   (broadcasts null-path to phones)
  // Every handler sandboxes paths inside `mobileBrowseRoot` (default = parent
  // of userData, with fallback to userData itself when the parent is a broad
  // public OS dir).
  mobileFs.register(ipcMain);

  ipcMain.handle('app:set-auto-zip-backup', handleSetAutoZip);
  ipcMain.handle('app:get-auto-zip-backup', handleGetAutoZip);

  // ── Mobile remote-access IPC (Phase 1) ────────────────────────
  // The handler bodies live in electron/server/mobile-access-ipc.cjs so
  // electron-main.cjs stays free of Fastify + Tailscale awareness. See
  // docs/mobile-remote-access.md for the architectural overview.
  mobileAccessIpc.bind({ getMainWindow });
  ipcMain.handle('mobile-access:get-state', mobileAccessIpc.handleGetState);
  ipcMain.handle('mobile-access:get-pairing-token', mobileAccessIpc.handleGetPairingToken);
  ipcMain.handle('mobile-access:enable', mobileAccessIpc.handleEnable);
  ipcMain.handle('mobile-access:disable', mobileAccessIpc.handleDisable);
  ipcMain.handle('mobile-access:rotate-token', mobileAccessIpc.handleRotateToken);
  ipcMain.handle('mobile-access:revoke-sessions', mobileAccessIpc.handleRevokeSessions);

  app.whenReady().then(async () => {
    // Restore persisted backup path + SoVITS authorization registries (paths the user
    // previously picked via native dialogs). Must happen before any backup:* or genie:*
    // IPC is serviced so that auto-save from a pre-existing connection and "start SoVITS"
    // from a previously-approved directory both survive restart.
    loadAllAuthorizedPaths();

    // Register the kumiko-image:// protocol. ChatBubble / MemoryPanel bind <img src>
    // to URLs like `kumiko-image://{imageId}`; we map those to the corresponding file
    // under userData/images/. The protocol is strictly a *read* surface anchored
    // inside that directory — the SAFE_IMAGE_ID regex and path.startsWith check
    // prevent any URL from escaping. Any non-well-formed / missing image resolves
    // to an "image not found" error, which <img onerror> handles.
    try {
      protocol.registerFileProtocol('kumiko-image', (request, callback) => {
        try {
          const raw = request.url.replace(/^kumiko-image:\/\//i, '');
          const without = raw.split('?')[0].split('#')[0].split('/')[0];
          const imageId = decodeURIComponent(without);
          const found = findImageFile(imageId);
          if (found) {
            callback({ path: found.path });
          } else {
            callback({ error: -6 });
          }
        } catch (_e) {
          callback({ error: -6 });
        }
      });
    } catch (e) {
      console.warn('[IMAGES] Failed to register kumiko-image:// protocol:', e && e.message);
    }

    setTimeout(() => {
      cleanupUpdaterCache();
    }, 15000);

    createWindow();
    try {
      createTray();
    } catch (e) {
      console.error('Failed to create tray:', e);
    }
    applyUnreadShellState();
    setupAutoUpdater();

    // If the user previously enabled Mobile Access, restart the Fastify
    // server on launch so the phone PWA survives a desktop reboot without
    // the user having to re-open Settings. A failure here (e.g. Tailscale
    // not yet running because it launches after Electron) is swallowed —
    // the Settings UI will surface it on the next state refresh.
    try {
      if (mobileAccessAuth.getState().enabled) {
        const startResult = await mobileAccessIpc.handleEnable();
        if (!startResult.ok) {
          console.warn('[MOBILE-ACCESS] Auto-start failed:', startResult.error, startResult.code);
        }
      }
    } catch (e) {
      console.warn('[MOBILE-ACCESS] Auto-start exception:', e && e.message);
    }

    setTimeout(() => {
      checkForAppUpdates('startup').catch((error) => {
        console.warn('[UPDATER] Startup check failed:', error);
      });
    }, 20000);

    try {
      await initRag();
    } catch (e) {
      console.error('Failed to initialize RAG:', e);
    }

    // ── GPT-SoVITS server management ─────────────────────────────
    // Subprocess lifecycle + authorization + native dialogs all live in
    // ./electron/genie-process.cjs. The handlers here are thin delegates so
    // the module fully owns the single-genieProcess invariant.
    ipcMain.handle('genie:pick-sovits-dir', handlePickSovitsDir);
    ipcMain.handle('genie:pick-sovits-python', handlePickSovitsPython);
    ipcMain.handle('genie:test-sovits-python', handleTestSovitsPython);
    ipcMain.handle('genie:start', handleGenieStart);
    ipcMain.handle('genie:stop', handleGenieStop);
    ipcMain.handle('genie:status', handleGenieStatus);

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', runAutoZipBeforeQuit);

  app.on('will-quit', () => {
    closeRag();
    terminateGenieProcess();
    // Fire-and-forget: Fastify close() is async but fast (<500ms) and
    // resolves against the Electron shutdown timer just fine. Awaiting
    // here would require event.preventDefault which we can't cleanly
    // thread through the legacy synchronous will-quit cleanups above.
    mobileAccessIpc.stopOnQuit().catch((e) => {
      console.warn('[MOBILE-ACCESS] stopOnQuit raised:', e && e.message);
    });
  });
}
