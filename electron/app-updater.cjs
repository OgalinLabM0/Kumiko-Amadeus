// electron/app-updater.cjs
//
// electron-updater integration: check / download / quit-and-install flow
// plus the `app:update:*` IPC handlers invoked by the renderer's
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
// ─ Install UX (2026 Q2 fix) ────────────────────────────────────────
// Running `autoUpdater.quitAndInstall(false, true)` while the main app
// is still holding file locks (BrowserWindow, Fastify, RAG, Genie
// subprocess) causes the NSIS installer to flash and exit silently when
// `perMachine: true` is set: UAC elevates, the elevated installer fails
// to replace locked files, and there is no parent process left to surface
// the error. The fix is two-pronged:
//   1. beforeQuitForInstall is awaited so electron-main.cjs can destroy
//      the window and tear down every child process before the installer
//      spawns.
//   2. We wait 500ms (instead of the old 120ms) before calling
//      autoUpdater.quitAndInstall() so the OS finishes releasing handles
//      from the torn-down window / subprocess tree.
// If the install still errors out (e.g. user hits Cancel on UAC), we
// immediately force-clean the downloaded cache so the Setup-*.exe no
// longer squats on the disk.
//
// ─ Cache location (2026 Q2 fix) ────────────────────────────────────
// The default electron-updater cache lives under %LOCALAPPDATA%, which
// is surprising because the rest of the app data lives in %APPDATA%
// (or a user-picked custom drive). We monkey-patch
// `autoUpdater.app.baseCachePath` to redirect it to the parent directory
// of the effective userData path (i.e. a sibling of the data folder),
// so users can find / clear the ~200MB installer next to their data
// without spelunking %LOCALAPPDATA%. cleanupUpdaterCache / clearUpdaterCache
// scan BOTH bases so installers downloaded by previous versions are still
// picked up during the migration window.
//
// The module deliberately re-implements getLocalAppDataPath (3 lines)
// to avoid creating a dedicated user-data-path module just for one
// caller.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { app, shell } = require('electron');
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

// Current installer executable names emitted by electron-builder (see
// nsis.artifactName in package.json). Any stray process holding a lock on
// the pending/ folder blocks rmSync, so we proactively taskkill these
// before attempting cleanup. Redundant across renames for the same reason
// the cache-directory list above is redundant.
const STALE_INSTALLER_IMAGE_NAMES = [
  'Kumiko-Amadeus-Setup-x64.exe',
  'Kumiko-Amadeus-Setup-arm64.exe',
  'Kumiko AI Setup.exe',
  'Kumiko-Amadeus-Setup.exe',
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
// isAutoBackupDone + app.isQuiting + tear down windows/children) and
// when that path errors (to undo isAutoBackupDone + restore the normal
// window-close behavior). Keeping these flags out of this module avoids
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

// Parent directory of the effective userData path. On packaged Windows
// builds this defaults to %APPDATA% (sibling of "Kumiko·Amadeus/"), but
// respects the user's custom data directory when they have picked one
// via Settings > Data Management. Falls back to %APPDATA% if userData
// is somehow at a filesystem root (never happens in practice, but we
// don't want to accidentally dump installers at C:\).
function resolveUpdaterCacheBase() {
  try {
    const userDataPath = app.getPath('userData');
    const parent = path.dirname(userDataPath);
    if (parent && parent !== userDataPath) {
      return path.resolve(parent);
    }
  } catch (_e) {
    // fall through to %APPDATA%
  }
  try {
    return path.resolve(app.getPath('appData'));
  } catch (_e) {
    return getLocalAppDataPath();
  }
}

// Current active base (post-monkey-patch). electron-builder writes
// downloads to `<base>/<productName>-updater/pending/Kumiko-Amadeus-Setup-*.exe`.
function getUpdaterCacheBaseDir() {
  return path.join(resolveUpdaterCacheBase(), 'kumiko-ai-amadeus-updater');
}

function getUpdaterCachePendingDir() {
  return path.join(getUpdaterCacheBaseDir(), 'pending');
}

function directorySizeAndCount(dir) {
  let bytes = 0;
  let count = 0;
  let stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_e) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        count += 1;
        try {
          bytes += fs.statSync(full).size;
        } catch (_e) {
          // skip unreadable file (likely a locked partial download)
        }
      }
    }
  }
  return { bytes, count };
}

function getUpdaterCacheInfo() {
  const pendingDir = getUpdaterCachePendingDir();
  let exists = false;
  try {
    exists = fs.existsSync(pendingDir);
  } catch (_e) {
    exists = false;
  }
  const { bytes, count } = exists ? directorySizeAndCount(pendingDir) : { bytes: 0, count: 0 };
  return {
    path: pendingDir,
    exists,
    sizeBytes: bytes,
    fileCount: count,
  };
}

// Synchronously taskkill any lingering installer processes. NSIS installer
// processes that died without cleaning up (UAC cancel, OS reboot during
// install, crashed NSIS) keep a write-lock on the pending/ directory and
// make fs.rmSync throw EBUSY. On non-Windows this is a no-op.
function killStaleInstallerProcesses() {
  if (process.platform !== 'win32') return;
  for (const imageName of STALE_INSTALLER_IMAGE_NAMES) {
    try {
      spawnSync('taskkill.exe', ['/F', '/IM', imageName, '/T'], {
        windowsHide: true,
        timeout: 3000,
      });
    } catch (_e) {
      // taskkill returns non-zero when the image isn't running, which
      // the spawnSync contract reports via status/stderr rather than
      // throwing — the try/catch here is purely defense against
      // spawnSync itself failing (e.g. locked-down Windows sandbox).
    }
  }
}

// Enumerate (baseDir × historical product-name) pairs we should try to
// clear. Current base is the monkey-patched sibling-of-userData dir;
// legacy base is %LOCALAPPDATA% for users migrating from previous
// versions. The set of product names is deliberately redundant so we
// catch orphan caches left by rename events.
function enumerateUpdaterCacheDirs() {
  const bases = new Set();
  try { bases.add(resolveUpdaterCacheBase()); } catch (_e) { /* ignore */ }
  try { bases.add(getLocalAppDataPath()); } catch (_e) { /* ignore */ }

  const results = [];
  for (const base of bases) {
    if (!base) continue;
    for (const name of UPDATER_CACHE_DIRECTORY_NAMES) {
      results.push(path.join(base, name));
    }
  }
  return results;
}

function removeDirectoryTree(directoryPath) {
  try {
    fs.rmSync(directoryPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

// Unconditional cleanup helper shared by cleanupUpdaterCache (idle-tick
// auto-clean), clearUpdaterCache (user button) and onQuitAndInstallError
// (install failed — kill the wasted cache immediately so the next attempt
// re-downloads from scratch instead of resuming a possibly corrupt file).
function forceCleanupUpdaterCache({ reason = 'unknown' } = {}) {
  killStaleInstallerProcesses();

  const targets = enumerateUpdaterCacheDirs();
  let removed = 0;
  let failed = 0;
  for (const directoryPath of targets) {
    const existed = (() => {
      try { return fs.existsSync(directoryPath); } catch (_e) { return false; }
    })();
    if (!existed) continue;
    const result = removeDirectoryTree(directoryPath);
    if (result.ok) {
      removed += 1;
    } else {
      failed += 1;
      console.warn('[INSTALL CACHE] Failed to remove installer cache:', directoryPath, result.error && result.error.message);
    }
  }
  if (removed > 0 || failed > 0) {
    console.log(`[INSTALL CACHE] cleanup(${reason}): removed=${removed} failed=${failed}`);
  }
  return { removed, failed };
}

function cleanupUpdaterCache() {
  if (updateCheckPromise || updateDownloadPromise || isInstallingUpdate) {
    return;
  }
  forceCleanupUpdaterCache({ reason: 'startup' });
}

async function clearUpdaterCache() {
  if (updateCheckPromise || updateDownloadPromise || isInstallingUpdate) {
    return {
      success: false,
      error: 'Update check / download / install is in progress. Please wait until it finishes before clearing the cache.',
    };
  }
  const sizeBefore = (() => {
    try { return directorySizeAndCount(getUpdaterCachePendingDir()).bytes; } catch (_e) { return 0; }
  })();
  const { removed, failed } = forceCleanupUpdaterCache({ reason: 'manual' });
  if (failed > 0 && removed === 0) {
    return {
      success: false,
      error: 'Failed to remove installer cache. The file may be locked by another process — please close any running installer windows and retry.',
    };
  }
  return { success: true, removed, failed, sizeBytes: sizeBefore };
}

async function openUpdaterCacheFolder() {
  const pendingDir = getUpdaterCachePendingDir();
  try {
    // Ensure the directory exists so shell.openPath doesn't fail on a
    // fresh install that hasn't downloaded anything yet. mkdirSync with
    // recursive:true is idempotent and cheap.
    fs.mkdirSync(pendingDir, { recursive: true });
  } catch (error) {
    console.warn('[UPDATER] Failed to ensure cache dir exists before opening:', error && error.message);
  }
  try {
    const errorMessage = await shell.openPath(pendingDir);
    if (errorMessage) {
      return { success: false, error: errorMessage };
    }
    return { success: true, path: pendingDir };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
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

  // Await the beforeQuitForInstall hook so electron-main.cjs can
  // synchronously destroy the window + close RAG + terminate Genie
  // + await Fastify shutdown before we hand control to the installer.
  // The old fire-and-forget call meant Fastify's close() races against
  // quitAndInstall(), leaving file handles open and causing the NSIS
  // installer to silently exit after UAC elevation.
  try {
    await lifecycleHooks.beforeQuitForInstall?.();
  } catch (hookError) {
    console.warn('[UPDATER] beforeQuitForInstall hook threw:', hookError);
  }

  // 500ms (up from 120ms) gives Windows time to release every file
  // handle the torn-down Electron process was holding. Without this
  // delay the installer races the OS and fails to open the .exe for
  // write, then silently exits — exactly the "flash and close" bug
  // this fix is targeting.
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
      // Force-clean the wasted cache so the user isn't stuck with a
      // 200MB partial/unused installer on disk after a failed attempt.
      // Do this synchronously inside the error path so the renderer's
      // next refreshUpdaterCacheInfo() sees the cleared state.
      try {
        forceCleanupUpdaterCache({ reason: 'install-error' });
      } catch (cleanupError) {
        console.warn('[UPDATER] forceCleanupUpdaterCache after install error threw:', cleanupError);
      }
      emitAppUpdateState({ status: 'error', error: stringifyUpdateError(error) });
    }
  }, 500);

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

  // ── Cache base monkey-patch ───────────────────────────────────────
  // electron-updater's DownloadedUpdateHelper resolves its output path
  // from `autoUpdater.app.baseCachePath`, which upstream hard-codes to
  // %LOCALAPPDATA% on Windows. Overriding the getter with
  // Object.defineProperty redirects every future resolution to the
  // sibling-of-userData directory while leaving the rest of the library
  // untouched (the upstream code only reads the getter, never writes,
  // so this is safe across electron-updater minor versions).
  try {
    const customBase = resolveUpdaterCacheBase();
    if (autoUpdater.app && typeof autoUpdater.app === 'object') {
      Object.defineProperty(autoUpdater.app, 'baseCachePath', {
        get: () => customBase,
        configurable: true,
      });
      console.log('[UPDATER] cache base overridden to:', customBase);
    }
  } catch (error) {
    console.warn('[UPDATER] Failed to override cache base, falling back to LOCALAPPDATA:', error && error.message);
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
  // Cache inspection + manual cleanup — wired into app:update:* IPC
  // handlers by electron-main.cjs and surfaced to the user through the
  // Settings > App Update > Download Cache UI block.
  getUpdaterCacheInfo,
  getUpdaterCacheBaseDir,
  getUpdaterCachePendingDir,
  openUpdaterCacheFolder,
  clearUpdaterCache,
};
