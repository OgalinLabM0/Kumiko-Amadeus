// Main BrowserWindow + tray lifecycle + icon resolution + 4 small
// "do something to mainWindow" IPC handlers. Extracted from
// electron-main.cjs (Plan 9 SubPhase 3.5).
//
// Ownership: this module is now the single source of truth for
// `mainWindow` and `tray`. electron-main.cjs keeps the thin app lifecycle
// (single-instance lock, whenReady → createWindow → createTray, before/will-quit)
// and forwards IPC channel registrations here.
//
// Dependency-injection fan-out:
//   - createWindow() pushes the fresh BrowserWindow into every module that
//     needs a reference (app-updater, genie-process, backup-ipc,
//     auto-zip-backup, notifications) via the setter pattern each of
//     those modules exposes.
//   - createTray() pushes the tray into notifications so
//     applyUnreadShellState can update its tooltip.
//
// Circular-dependency avoidance:
//   - The five DI target modules are required *inside* createWindow /
//     createTray, not at the top level. This is specifically to allow
//     those modules to one day re-import window-manager (via
//     getMainWindow) without crashing the module loader. app-updater's
//     emitAppUpdateState call inside did-finish-load is similarly
//     lazy-resolved.
//
// `focusMainWindow()` is exported both for the notifications module's
// "click-through → focus main" paths (via its own setter-captured
// reference, not via this getter — that import hop is a footgun we
// avoid) and for electron-main's `app.on('second-instance', ...)`
// handler.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Tray, Menu, shell } = require('electron');

// Local copies of platform / packaging flags. electron-main.cjs still
// owns the canonical IS_WINDOWS / IS_LINUX / IS_MAC constants for
// top-level platform branches it might add later, but this module
// needs its own copies so it can load in isolation during tests.
const IS_WINDOWS_LOCAL = process.platform === 'win32';
const isDev = !app.isPackaged;

// Private state. Initialized by createWindow / createTray.
let mainWindow = null;
let tray = null;

function getMainWindow() {
  return mainWindow;
}

function getTray() {
  return tray;
}

// App icon resolution. Windows Tray/BrowserWindow strongly prefer .ico (multi-DPI
// sprite). Linux desktops (GNOME/KDE) only reliably render PNG for StatusNotifier
// trays, so on Linux we prefer the PNG and fall back to the ICO only if the PNG
// is missing. macOS also prefers PNG. fs.existsSync is used so a stale build
// missing one of the assets still starts up cleanly rather than throwing at
// app startup.
function resolveAppIconPath() {
  const icoPath = path.join(__dirname, '..', 'public', 'favicon-KA.ico');
  const pngPath = path.join(__dirname, '..', 'public', 'favicon-KA.png');
  if (IS_WINDOWS_LOCAL) {
    return fs.existsSync(icoPath) ? icoPath : pngPath;
  }
  return fs.existsSync(pngPath) ? pngPath : icoPath;
}

function createWindow() {
  const iconPath = resolveAppIconPath();

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
      preload: path.join(__dirname, '..', 'preload.cjs')
    }
  });

  // Lazy-resolve the DI setter targets to sidestep potential circular
  // requires at module load time (notifications / auto-zip-backup etc.
  // could grow reverse dependencies on window-manager in the future).
  const { setAppUpdaterWindow, emitAppUpdateState } = require('./app-updater.cjs');
  const { setGenieDialogParent } = require('./genie-process.cjs');
  const { setBackupDialogParent } = require('./backup-ipc.cjs');
  const { setAutoZipProgressTarget } = require('./auto-zip-backup.cjs');
  const { setNotificationWindow } = require('./notifications.cjs');

  setAppUpdaterWindow(mainWindow);
  setGenieDialogParent(mainWindow);
  setBackupDialogParent(mainWindow);
  setAutoZipProgressTarget(mainWindow);
  setNotificationWindow(mainWindow);

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
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

function createTray() {
  try {
    const iconPath = resolveAppIconPath();
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

    const { setNotificationTray } = require('./notifications.cjs');
    setNotificationTray(tray);
  } catch (err) {
    console.warn('Tray icon creation failed, maybe icon is missing?', err);
  }
}

// `second-instance` on app forwards the "user tried to launch a second
// copy" event; we bring the existing main window back to the front. The
// Electron callback arg list (event, argv, workingDirectory) is unused.
function focusMainWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function handleSetBgColor(_event, color) {
  if (mainWindow && !mainWindow.isDestroyed() && typeof color === 'string') {
    try {
      mainWindow.setBackgroundColor(color);
    } catch { /* ignore invalid color strings */ }
  }
}

function handleSetBackgroundThrottling(_event, payload = {}) {
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
}

function handleRefocusWebcontents() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    mainWindow.webContents.focus();
    return { success: true };
  }
  return { success: false };
}

async function handleOpenExternal(_event, payload = {}) {
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
}

module.exports = {
  createWindow,
  createTray,
  getMainWindow,
  getTray,
  focusMainWindow,
  handleSetBgColor,
  handleSetBackgroundThrottling,
  handleRefocusWebcontents,
  handleOpenExternal,
};
