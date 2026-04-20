const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, Notification, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const JSZip = require('jszip');
const { initRag, closeRag } = require('./electron-rag.cjs');
const {
  readConfigValue,
  writeConfigValue,
  migrateRegistryToConfigStoreOnce,
} = require('./electron/user-config.cjs');
const {
  loadAllAuthorizedPaths,
  authorizeBackupPath,
} = require('./electron/authorized-paths.cjs');
const {
  writeBackupFile,
  readBackupFile,
  getBackupFileInfo,
  parseBackupImportFile,
  getDefaultBackupFilePath,
} = require('./electron/backup-files.cjs');
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
  setAppUpdaterWindow,
  setAppUpdaterLifecycleHooks,
  getUpdateState,
  isUpdateInstalling,
  emitAppUpdateState,
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
  setGenieDialogParent,
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

let mainWindow;
let tray = null;
let unreadMessageCount = 0;
let lastWrittenBackupPath = null;

const isDev = !app.isPackaged;
let isAutoBackupDone = false;

// electron-updater side-effects (skip auto-backup + mark quitting intent
// for the tray/window-close logic) get invoked by app-updater.cjs via
// setAppUpdaterLifecycleHooks, registered during app initialization
// below.
setAppUpdaterLifecycleHooks({
  beforeQuitForInstall: () => {
    isAutoBackupDone = true;
    app.isQuiting = true;
  },
  onQuitAndInstallError: () => {
    isAutoBackupDone = false;
  },
});

// App icon resolution. Windows Tray/BrowserWindow strongly prefer .ico (multi-DPI
// sprite). Linux desktops (GNOME/KDE) only reliably render PNG for StatusNotifier
// trays, so on Linux we prefer the PNG and fall back to the ICO only if the PNG
// is missing. macOS also prefers PNG. fs.existsSync is used so a stale build
// missing one of the assets still starts up cleanly rather than throwing at
// app startup.
function resolveAppIconPath() {
  const icoPath = path.join(__dirname, 'public', 'favicon-KA.ico');
  const pngPath = path.join(__dirname, 'public', 'favicon-KA.png');
  if (IS_WINDOWS) {
    return fs.existsSync(icoPath) ? icoPath : pngPath;
  }
  return fs.existsSync(pngPath) ? pngPath : icoPath;
}
const iconPath = resolveAppIconPath();

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    icon: iconPath,
    backgroundColor: '#f9f7f2',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  setAppUpdaterWindow(mainWindow);
  setGenieDialogParent(mainWindow);

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }

  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });

  mainWindow.webContents.once('did-finish-load', () => {
    emitAppUpdateState();
  });

  // Bump renderer frame rate ceiling from 60 to 120 for faster post-resize recovery.
  try {
    mainWindow.webContents.setFrameRate(120);
  } catch { /* older Electron versions may not support this */ }
}

// Module-level IPC: theme-matched BrowserWindow background color.
// Placed here (not inside createWindow) so it is registered exactly once.
ipcMain.on('app:set-bg-color', (_event, color) => {
  if (mainWindow && !mainWindow.isDestroyed() && typeof color === 'string') {
    try {
      mainWindow.setBackgroundColor(color);
    } catch { /* ignore invalid color strings */ }
  }
});

function createTray() {
  try {
    tray = new Tray(iconPath);
    const contextMenu = Menu.buildFromTemplate([
      {
        label: '打开/隐藏 界面',
        click: () => {
          if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
          else if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      { type: 'separator' },
      {
        label: '彻底退出',
        click: () => {
          app.isQuiting = true;
          app.quit();
        }
      }
    ]);
    tray.setToolTip('Kumiko·Amadeus 后台守护中...');
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (err) {
    console.warn('Tray icon creation failed, maybe icon is missing?', err);
  }
}

function applyUnreadShellState() {
  const baseTitle = 'Kumiko·Amadeus';
  const nextTitle = unreadMessageCount > 0 ? `(${unreadMessageCount}) ${baseTitle}` : baseTitle;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(nextTitle);
    mainWindow.flashFrame(unreadMessageCount > 0);
  }

  if (tray) {
    const tooltip = unreadMessageCount > 0
      ? `Kumiko·Amadeus 后台守护中 · ${unreadMessageCount} 条未读来信`
      : 'Kumiko·Amadeus 后台守护中...';
    tray.setToolTip(tooltip);
  }
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  ipcMain.on('show-window', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
      mainWindow.flashFrame(false);
    }
  });

  ipcMain.on('app:send-notification', (_event, payload = {}) => {
    try {
      if (Notification.isSupported()) {
        const notif = new Notification({
          title: payload.title || 'Kumiko Amadeus',
          body: payload.body || '',
          icon: payload.icon || path.join(__dirname, 'public', 'CCA-P2.png'),
          silent: false,
          urgency: 'critical'
        });
        notif.on('click', () => {
          if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            if (!mainWindow.isVisible()) mainWindow.show();
            mainWindow.focus();
          }
        });
        notif.show();
      }
    } catch (e) {
      console.error('[Notification] Failed to show:', e);
    }
  });

  let callNotifWindow = null;
  ipcMain.on('app:send-call-notification', (_event, payload = {}) => {
    try {
      if (callNotifWindow && !callNotifWindow.isDestroyed()) callNotifWindow.close();
      const { screen } = require('electron');
      const display = screen.getPrimaryDisplay();
      const { width: sw, height: sh } = display.workAreaSize;
      const nw = 360, nh = 120;
      callNotifWindow = new BrowserWindow({
        width: nw, height: nh,
        x: sw - nw - 16, y: sh - nh - 16,
        frame: false, transparent: true, alwaysOnTop: true,
        resizable: false, skipTaskbar: true, focusable: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
      });
      const title = (payload.title || 'Incoming Call').replace(/'/g, "\\'").replace(/\n/g, ' ');
      const body = (payload.body || '').replace(/'/g, "\\'").replace(/\n/g, ' ');
      let avatarBase64 = '';
      try { avatarBase64 = fs.readFileSync(path.join(__dirname, 'public', 'CCA-P2.png')).toString('base64'); } catch(_e) {}
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Segoe UI',system-ui,sans-serif;background:rgba(20,20,30,0.95);color:#fff;border-radius:14px;overflow:hidden;cursor:pointer;user-select:none;border:1px solid rgba(255,255,255,0.1)}
        .c{display:flex;align-items:center;gap:14px;padding:18px 20px;height:100%}
        .avatar{width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#a855f7,#ec4899);display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;flex-shrink:0;overflow:hidden}
        .avatar img{width:100%;height:100%;object-fit:cover}
        .info{flex:1;min-width:0}
        .title{font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .body{font-size:11px;color:rgba(255,255,255,0.6);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .ring{font-size:11px;color:#a855f7;margin-top:4px;animation:blink 1.2s infinite}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:0.4}}
      </style></head><body onclick="window.close()"><div class="c">
        <div class="avatar"><img src="data:image/png;base64,${avatarBase64}" onerror="this.style.display='none';this.parentElement.innerText='久'"/></div>
        <div class="info"><div class="title">${title}</div><div class="body">${body}</div><div class="ring">📞 来电中...</div></div>
      </div></body></html>`;
      callNotifWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      callNotifWindow.on('closed', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          if (!mainWindow.isVisible()) mainWindow.show();
          mainWindow.focus();
        }
        callNotifWindow = null;
      });
    } catch (e) {
      console.error('[CallNotification] Failed:', e);
    }
  });

  ipcMain.on('app:close-call-notification', () => {
    if (callNotifWindow && !callNotifWindow.isDestroyed()) {
      callNotifWindow.close();
      callNotifWindow = null;
    }
  });

  ipcMain.on('app:update-unread-state', (_event, payload = {}) => {
    const nextCount = Number(payload.count);
    unreadMessageCount = Number.isFinite(nextCount) && nextCount > 0 ? Math.floor(nextCount) : 0;
    applyUnreadShellState();
  });

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

  ipcMain.handle('app:set-background-throttling', (_event, payload = {}) => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { success: false, error: 'Main window is unavailable.' };
      }

      const allowed = payload.allowed !== false;
      mainWindow.webContents.setBackgroundThrottling(allowed);
      return { success: true, allowed };
    } catch (error) {
      console.error('[APP] Failed to update background throttling:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle('app:refocus-webcontents', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
      mainWindow.webContents.focus();
      return { success: true };
    }
    return { success: false };
  });

  ipcMain.handle('app:open-external', async (_event, payload = {}) => {
    try {
      const url = typeof payload.url === 'string' ? payload.url.trim() : '';
      if (!/^https?:\/\//i.test(url)) {
        return { success: false, error: 'A valid http(s) URL is required.' };
      }
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      console.error('[APP] Failed to open external url:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle('app:pick-data-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
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

  ipcMain.handle('backup:pick-save-file', async (_event, payload = {}) => {
    try {
      const result = await dialog.showSaveDialog(mainWindow || undefined, {
        title: '选择本地同步文件',
        defaultPath: getDefaultBackupFilePath(payload.defaultFileName),
        filters: [
          { name: 'JSON Backup File', extensions: ['json'] }
        ]
      });

      if (result.canceled || !result.filePath) {
        return { canceled: true };
      }

      const filePath = path.resolve(result.filePath);
      // The user just approved this path via the native dialog — authorize it for
      // subsequent write/read/parse IPC calls (persisted across restarts).
      authorizeBackupPath(filePath);
      return {
        success: true,
        canceled: false,
        filePath,
        fileName: path.basename(filePath)
      };
    } catch (error) {
      console.error('[LOCAL BACKUP] Failed to select save file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle('backup:pick-open-file', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow || undefined, {
        title: '选择本地同步文件',
        properties: ['openFile'],
        filters: [
          { name: 'JSON Backup File', extensions: ['json'] }
        ],
        defaultPath: app.getPath('documents')
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }

      const pickedPath = path.resolve(result.filePaths[0]);
      authorizeBackupPath(pickedPath);
      return readBackupFile(pickedPath);
    } catch (error) {
      console.error('[LOCAL BACKUP] Failed to open backup file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle('backup:write-file', (_event, payload = {}) => {
    try {
      if (payload.filePath) lastWrittenBackupPath = payload.filePath;
      return writeBackupFile(payload.filePath, payload.content);
    } catch (error) {
      console.error('[LOCAL BACKUP] Failed to write backup file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle('backup:read-file', (_event, payload = {}) => {
    try {
      return readBackupFile(payload.filePath);
    } catch (error) {
      console.error('[LOCAL BACKUP] Failed to read backup file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle('backup:get-file-info', (_event, payload = {}) => {
    try {
      return getBackupFileInfo(payload.filePath);
    } catch (error) {
      console.error('[LOCAL BACKUP] Failed to inspect backup file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle('backup:parse-import-file', async (_event, payload = {}) => {
    try {
      return await parseBackupImportFile(payload.filePath);
    } catch (error) {
      console.error('[LOCAL BACKUP] Failed to parse backup import file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle('app:set-auto-zip-backup', (_event, payload = {}) => {
    try {
      const enabled = !!payload.enabled;
      writeConfigValue('AutoZipBackupEnabled', enabled ? '1' : '0');
      return { success: true, enabled };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('app:get-auto-zip-backup', () => {
    try {
      const val = readConfigValue('AutoZipBackupEnabled');
      return { success: true, enabled: val === '1' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

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

  app.on('before-quit', (event) => {
    if (isAutoBackupDone || isUpdateInstalling()) return;
    try {
      const autoZipVal = readConfigValue('AutoZipBackupEnabled');
      if (autoZipVal !== '1') return;

      event.preventDefault();
      console.log('[AUTO BACKUP] Starting auto ZIP backup before quit...');
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.webContents.send('app:auto-zip-progress', { status: 'start' }); } catch(_e){}
      }

      let latestJson = null;

      if (lastWrittenBackupPath && fs.existsSync(lastWrittenBackupPath)) {
        latestJson = lastWrittenBackupPath;
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
  });

  app.on('will-quit', () => {
    closeRag();
    terminateGenieProcess();
  });
}
