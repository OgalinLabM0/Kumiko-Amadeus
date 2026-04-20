// electron/app-updater.cjs
//
// electron-updater integration: check / download / quit-and-install flow
// plus the four `app:update:*` IPC handlers invoked by the renderer's
// Settings > App Update section.
//
// The state is held privately inside this module (isInstallingUpdate,
// updateCheckPromise, updateDownloadPromise, appUpdateState). The only
// way renderer/main have to observe it is through:
//   - getUpdateState() / isUpdateInstalling() getters
//   - setAppUpdaterWindow(win) to receive the push channel
//     (mainWindow.webContents.send('app:update-status', state))
//
// Quit-and-install needs two cross-module side-effects that live in
// electron-main.cjs (isAutoBackupDone flag + app.isQuiting flag used by
// the tray/window-close handlers). Rather than pull those into the
// updater, we let the main file register callbacks via
// setAppUpdaterLifecycleHooks so the updater stays a leaf module.
//
// The module deliberately re-implements getLocalAppDataPath (3 lines)
// to avoid creating a dedicated user-data-path module just for one
// caller.

'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

const isDev = !app.isPackaged;

// Historical installer-cache directory names (electron-builder names them
// "<productName>-updater"). We try to clear all known layouts on startup
// because rename-driven product-name changes leave orphan caches behind;
// the set is deliberately redundant rather than derived from the current
// name so the cleanup stays effective across future renames.
const UPDATER_CACHE_DIRECTORY_NAMES = [
  'kumiko-ai-amadeus-updater',
  'Kumiko AI-updater',
  'kumiko-amadeus-updater',
  'Kumiko-Amadeus-updater',
];

// Internal state ────────────────────────────────────────────────────

let isInstallingUpdate = false;
let updateCheckPromise = null;
let updateDownloadPromise = null;
let appUpdateState = {
  status: isDev ? 'unsupported' : 'idle',
  currentVersion: app.getVersion(),
  availableVersion: null,
  releaseDate: null,
  progressPercent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  error: null,
  isPackaged: app.isPackaged,
};

// electron-main.cjs injects its BrowserWindow here once createWindow()
// runs. We use webContents.send to push state patches; before that
// point we just cache state and replay it implicitly (every push is a
// full snapshot already).
let updaterWindow = null;

// Cross-module lifecycle hooks. Main file installs callbacks that get
// called right before autoUpdater.quitAndInstall() (to set
// isAutoBackupDone + app.isQuiting) and when that path errors (to undo
// isAutoBackupDone). Keeping these flags out of this module avoids
// leaking backup/tray semantics into the updater.
let lifecycleHooks = {
  beforeQuitForInstall: null,
  onQuitAndInstallError: null,
};

// Public setters ────────────────────────────────────────────────────

function setAppUpdaterWindow(win) {
  updaterWindow = win || null;
}

function setAppUpdaterLifecycleHooks(hooks = {}) {
  lifecycleHooks = {
    beforeQuitForInstall: typeof hooks.beforeQuitForInstall === 'function' ? hooks.beforeQuitForInstall : null,
    onQuitAndInstallError: typeof hooks.onQuitAndInstallError === 'function' ? hooks.onQuitAndInstallError : null,
  };
}

// Getters ───────────────────────────────────────────────────────────

function getUpdateState() {
  return appUpdateState;
}

function isUpdateInstalling() {
  return isInstallingUpdate;
}

// Helpers ───────────────────────────────────────────────────────────

function getLocalAppDataPath() {
  if (process.env.LOCALAPPDATA) {
    return path.resolve(process.env.LOCALAPPDATA);
  }

  return path.resolve(path.join(app.getPath('appData'), '..', 'Local'));
}

function cleanupUpdaterCache() {
  if (updateCheckPromise || updateDownloadPromise || isInstallingUpdate) {
    return;
  }

  const localAppDataPath = getLocalAppDataPath();

  for (const directoryName of UPDATER_CACHE_DIRECTORY_NAMES) {
    const directoryPath = path.join(localAppDataPath, directoryName);
    try {
      fs.rmSync(directoryPath, { recursive: true, force: true });
    } catch (error) {
      console.warn('[INSTALL CACHE] Failed to remove installer cache:', directoryPath, error);
    }
  }
}

function stringifyUpdateError(error) {
  if (!error) return 'Unknown updater error';
  if (error instanceof Error) return error.message;
  return String(error);
}

function emitAppUpdateState(patch = {}) {
  appUpdateState = {
    ...appUpdateState,
    ...patch,
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
  };

  if (updaterWindow && !updaterWindow.isDestroyed()) {
    try {
      updaterWindow.webContents.send('app:update-status', appUpdateState);
    } catch (error) {
      console.warn('[UPDATER] Failed to send update state to renderer:', error);
    }
  }

  return appUpdateState;
}

// Flow ──────────────────────────────────────────────────────────────

async function checkForAppUpdates(trigger = 'manual') {
  if (!app.isPackaged || isDev) {
    const reason = 'Automatic updates are only available in packaged desktop builds.';
    emitAppUpdateState({ status: 'unsupported', error: reason });
    return { success: false, error: reason };
  }

  if (updateCheckPromise) {
    return { success: true, alreadyChecking: true };
  }

  emitAppUpdateState({
    status: 'checking',
    error: null,
  });

  updateCheckPromise = autoUpdater.checkForUpdates()
    .then((result) => ({
      success: true,
      trigger,
      updateInfo: result?.updateInfo || null,
    }))
    .catch((error) => {
      const message = stringifyUpdateError(error);
      emitAppUpdateState({ status: 'error', error: message });
      return { success: false, error: message };
    })
    .finally(() => {
      updateCheckPromise = null;
    });

  return updateCheckPromise;
}

async function downloadAppUpdate() {
  if (!app.isPackaged || isDev) {
    const reason = 'Automatic updates are only available in packaged desktop builds.';
    emitAppUpdateState({ status: 'unsupported', error: reason });
    return { success: false, error: reason };
  }

  if (appUpdateState.status === 'downloaded') {
    return { success: true, alreadyDownloaded: true };
  }

  if (updateDownloadPromise) {
    return { success: true, alreadyDownloading: true };
  }

  if (!appUpdateState.availableVersion) {
    return { success: false, error: 'No update available to download.' };
  }

  emitAppUpdateState({
    status: 'downloading',
    error: null,
    progressPercent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
  });

  updateDownloadPromise = autoUpdater.downloadUpdate()
    .then(() => ({ success: true }))
    .catch((error) => {
      const message = stringifyUpdateError(error);
      emitAppUpdateState({ status: 'error', error: message });
      return { success: false, error: message };
    })
    .finally(() => {
      updateDownloadPromise = null;
    });

  return updateDownloadPromise;
}

async function quitAndInstallAppUpdate() {
  if (appUpdateState.status !== 'downloaded') {
    return { success: false, error: 'No downloaded update is ready to install.' };
  }

  isInstallingUpdate = true;

  try {
    lifecycleHooks.beforeQuitForInstall?.();
  } catch (hookError) {
    console.warn('[UPDATER] beforeQuitForInstall hook threw:', hookError);
  }

  setTimeout(() => {
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (error) {
      console.error('[UPDATER] Failed to quit and install update:', error);
      isInstallingUpdate = false;
      try {
        lifecycleHooks.onQuitAndInstallError?.();
      } catch (hookError) {
        console.warn('[UPDATER] onQuitAndInstallError hook threw:', hookError);
      }
      emitAppUpdateState({ status: 'error', error: stringifyUpdateError(error) });
    }
  }, 120);

  return { success: true };
}

function setupAutoUpdater() {
  if (!app.isPackaged || isDev) {
    emitAppUpdateState({
      status: 'unsupported',
      error: 'Automatic updates are only available in packaged desktop builds.',
    });
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => {
    console.log('[UPDATER] Checking for updates...');
    emitAppUpdateState({ status: 'checking', error: null });
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[UPDATER] Update available:', info?.version);
    emitAppUpdateState({
      status: 'available',
      availableVersion: info?.version || null,
      releaseDate: info?.releaseDate || null,
      progressPercent: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
      error: null,
    });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[UPDATER] No updates available.');
    emitAppUpdateState({
      status: 'not-available',
      availableVersion: null,
      releaseDate: null,
      progressPercent: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
      error: null,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    emitAppUpdateState({
      status: 'downloading',
      progressPercent: Number.isFinite(progress?.percent) ? progress.percent : 0,
      transferred: Number.isFinite(progress?.transferred) ? progress.transferred : 0,
      total: Number.isFinite(progress?.total) ? progress.total : 0,
      bytesPerSecond: Number.isFinite(progress?.bytesPerSecond) ? progress.bytesPerSecond : 0,
      error: null,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[UPDATER] Update downloaded:', info?.version);
    emitAppUpdateState({
      status: 'downloaded',
      availableVersion: info?.version || appUpdateState.availableVersion,
      releaseDate: info?.releaseDate || appUpdateState.releaseDate,
      progressPercent: 100,
      transferred: appUpdateState.total || appUpdateState.transferred,
      total: appUpdateState.total || appUpdateState.transferred,
      bytesPerSecond: 0,
      error: null,
    });
  });

  autoUpdater.on('error', (error) => {
    const message = stringifyUpdateError(error);
    console.error('[UPDATER] Error:', message);
    emitAppUpdateState({ status: 'error', error: message });
  });
}

module.exports = {
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
};
