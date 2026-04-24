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
// ─ Install UX (2026 Q2 reliability fix) ────────────────────────────
// Previous flow awaited a beforeQuitForInstall hook that synchronously
// destroyed the main window BEFORE calling autoUpdater.quitAndInstall,
// then used quitAndInstall(false, true) which left NSIS in interactive
// mode. The result on user machines was: app window goes away, NSIS
// tries to show a "close application" prompt against a dead parent,
// spawn race condition leaves installer orphaned, new version never
// launches — classic "clicked install, nothing happened" bug.
//
// New flow (v2.11.1 replanned):
//   1. Pre-verify the pending installer actually exists on disk. If the
//      cache was nuked (either by our own 15s idle cleanup or by the user
//      running a registry-cleaner), fall back to re-download instead of
//      handing autoUpdater a path to nowhere.
//   2. Run `prepareForInstall` (was `beforeQuitForInstall`) to close
//      heavy subsystems (RAG SQLite, Genie subprocess, Fastify mobile
//      server) but DO NOT destroy BrowserWindows — the UI overlay stays
//      visible so the user sees the transition, and if quitAndInstall
//      fails the error message can still be surfaced in-app.
//   3. Call autoUpdater.quitAndInstall(true, true). Silent mode means
//      NSIS installs without any modal prompts; forceRunAfter tells
//      electron-builder's RELAUNCH macro to re-launch the new version.
//      electron-updater's internal setImmediate triggers app.quit(),
//      which closes windows through the normal shutdown path (will-quit
//      hooks run, windows close cleanly, file handles release).
//   4. If quitAndInstall returns without triggering Electron's shutdown
//      (spawn failed synchronously, installer path invalid, ...) we stay
//      alive, restore isQuiting via onQuitAndInstallError, force-clean
//      the cache, and emit `status: 'error'` so the user can re-try.
//
// The 500ms delay between prepareForInstall and quitAndInstall is kept:
// it gives Windows time to finish releasing handles from closed
// subsystems before NSIS opens the executable for overwrite.
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
const { autoUpdater, CancellationToken } = require('electron-updater');

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
//
// F2B.5: artifactName became `Kumiko-Amadeus-Setup-${arch}-${version}.exe`,
// so the static literal list cannot enumerate every future filename. The
// arch-only variants below stay in the list for legacy installers cached
// from pre-F2B.5 builds (~2.13.x); newer versioned filenames are matched
// dynamically by hasReadyPendingInstaller's regex when needed.
const STALE_INSTALLER_IMAGE_NAMES = [
  'Kumiko-Amadeus-Setup-x64.exe',
  'Kumiko-Amadeus-Setup-arm64.exe',
  'Kumiko AI Setup.exe',
  'Kumiko-Amadeus-Setup.exe',
];

// Filename of the one-shot "cleanup on next startup" flag. Written as
// part of quitAndInstall() and consumed by cleanupUpdaterCache() on the
// next cold start; its presence means "the last install succeeded, the
// leftover installer in pending/ is now stale — delete it even though
// it still looks like a ready-to-install artifact, so disk usage does
// not balloon across updates".
const POST_INSTALL_FLAG_FILENAME = 'post-install-cleanup.flag';

// Internal state ────────────────────────────────────────────────────

let isInstallingUpdate = false;
let updateCheckPromise = null;
let updateDownloadPromise = null;
// CancellationToken for the in-flight downloadUpdate() call. We hand it
// to electron-updater at download-start and hold the reference here so
// the IPC-driven cancel button can reach in and call cancel() without
// needing to await the returned promise. Cleared in the downloadUpdate
// `finally` to avoid stale tokens persisting across runs.
let activeCancellationToken = null;
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
// called during the install flow:
//   - prepareForInstall: close heavy subsystems (RAG, Genie, Fastify),
//     mark auto-backup done, set app.isQuiting. Does NOT destroy
//     BrowserWindows — the UI overlay stays visible until Electron's
//     natural shutdown sequence closes them after quitAndInstall runs.
//   - onQuitAndInstallError: quitAndInstall failed, app is still alive;
//     undo isAutoBackupDone and app.isQuiting so the user's next window
//     close still minimizes to tray instead of quitting.
// Keeping these flags out of this module avoids leaking backup/tray
// semantics into the updater.
let lifecycleHooks = {
  prepareForInstall: null,
  onQuitAndInstallError: null,
};

// Public setters ────────────────────────────────────────────────────

function setAppUpdaterWindow(win) {
  updaterWindow = win || null;
}

function setAppUpdaterLifecycleHooks(hooks = {}) {
  lifecycleHooks = {
    prepareForInstall: typeof hooks.prepareForInstall === 'function' ? hooks.prepareForInstall : null,
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

// True if the current cache base has a freshly-downloaded, name-valid
// installer sitting in pending/. Used by cleanupUpdaterCache() to avoid
// blowing away a ready-to-install Setup-*.exe during the 15s idle cleanup
// tick on app startup — which was one of two root causes of the 2026 Q2
// "clicked install, nothing happened" failure mode: app closed + installer
// gone + no installer process running.
function hasReadyPendingInstaller() {
  try {
    const pendingDir = getUpdaterCachePendingDir();
    if (!fs.existsSync(pendingDir)) return false;
    const entries = fs.readdirSync(pendingDir);
    // F2B.5: accept both legacy `Setup-(x64|arm64).exe` and the new
    // version-suffixed `Setup-(x64|arm64)-X.Y.Z.exe` (e.g.
    // `Kumiko-Amadeus-Setup-x64-2.14.0.exe`). The trailing `(?:-X.Y.Z…)?`
    // group is optional so older cached installers keep getting recognised
    // and we don't blow them away during the startup idle sweep.
    return entries.some((name) =>
      /^Kumiko-Amadeus-Setup-(x64|arm64)(?:-[0-9]+\.[0-9]+\.[0-9]+(?:[A-Za-z0-9.\-+]*)?)?\.exe$/i.test(name)
    );
  } catch (_e) {
    return false;
  }
}

// Post-install flag file ────────────────────────────────────────────
//
// The flag is an empty marker file written into the updater-cache base
// directory right before quitAndInstall fires. When the new version
// cold-boots, cleanupUpdaterCache() at the top of its execution checks
// for this flag; if present, it bypasses the hasReadyPendingInstaller
// guard and forces a full wipe of pending/ (the ~200MB Setup-*.exe that
// the freshly-installed version no longer needs). This closes the
// "installer never cleaned up after successful install" leak without
// running destructive rmSync on every single startup.
//
// Writing happens in quitAndInstallAppUpdate(); consumption happens
// exactly once per install event in cleanupUpdaterCache(). Write failures
// are logged-and-swallowed — the worst case is the installer hangs
// around one extra cycle, which is strictly better than refusing to
// quit-and-install because a status file could not be persisted.

function getPostInstallFlagPath() {
  return path.join(getUpdaterCacheBaseDir(), POST_INSTALL_FLAG_FILENAME);
}

function writePostInstallFlag() {
  const flagPath = getPostInstallFlagPath();
  try {
    fs.mkdirSync(path.dirname(flagPath), { recursive: true });
    fs.writeFileSync(flagPath, String(Date.now()), 'utf8');
    console.log('[UPDATER] post-install cleanup flag written at', flagPath);
  } catch (error) {
    console.warn('[UPDATER] Failed to write post-install flag:', error && error.message);
  }
}

// Returns true iff the flag existed AND we successfully deleted it, so
// the cleanup only fires once regardless of how many restarts follow.
function consumePostInstallFlag() {
  const flagPath = getPostInstallFlagPath();
  try {
    if (!fs.existsSync(flagPath)) return false;
    try {
      fs.unlinkSync(flagPath);
    } catch (unlinkError) {
      console.warn('[UPDATER] Failed to delete post-install flag after consuming:', unlinkError && unlinkError.message);
      // Deleting failed but the flag was there. Treat as consumed anyway
      // so we don't loop wiping pending/ every startup; the orphan file
      // costs nothing and the next writePostInstallFlag overwrites it.
    }
    return true;
  } catch (error) {
    console.warn('[UPDATER] Failed to read post-install flag:', error && error.message);
    return false;
  }
}

function cleanupUpdaterCache() {
  if (updateCheckPromise || updateDownloadPromise || isInstallingUpdate) {
    return;
  }
  // Post-install sweep: last run wrote the flag right before
  // quitAndInstall, meaning the current process is the freshly-installed
  // version. The Setup-*.exe in pending/ is stale — we no longer need
  // it — so bypass the hasReadyPendingInstaller guard and wipe it out
  // to free the ~200MB of disk space.
  if (consumePostInstallFlag()) {
    console.log('[INSTALL CACHE] post-install flag detected, wiping stale installer from previous version');
    forceCleanupUpdaterCache({ reason: 'post-install' });
    return;
  }
  // Guard: if a fresh installer is already waiting in pending/, keep it.
  // electron-updater keeps the file around for the user to re-click
  // Install across restarts; the old behaviour deleted it and left the
  // renderer stuck in "downloaded" state with no file on disk, so the
  // next install attempt failed silently inside NsisUpdater.doInstall.
  if (hasReadyPendingInstaller()) {
    console.log('[INSTALL CACHE] cleanup skipped: pending installer is ready to install');
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

  // Fresh token per download so cancel() from an earlier, aborted run
  // cannot bleed into this one. Stored at module scope so
  // cancelAppUpdateDownload() can reach it without needing the returned
  // promise.
  const cancellationToken = new CancellationToken();
  activeCancellationToken = cancellationToken;

  updateDownloadPromise = autoUpdater.downloadUpdate(cancellationToken)
    .then(() => ({ success: true }))
    .catch((error) => {
      const message = stringifyUpdateError(error);
      // CancellationError is the intended outcome when the renderer
      // asked us to cancel; cancelAppUpdateDownload already emitted
      // `status: 'available'`, so we must NOT overwrite that with
      // `status: 'error'` here. Detect the upstream class name rather
      // than relying on a direct `instanceof` import — electron-updater
      // doesn't export CancellationError as a public constructor.
      const isCancellation =
        (error && error.name === 'CancellationError') ||
        /cancell?ed/i.test(message);
      if (isCancellation) {
        console.log('[UPDATER] downloadUpdate rejected with CancellationError — ignoring (status already reset by cancel flow)');
        return { success: false, cancelled: true };
      }
      emitAppUpdateState({ status: 'error', error: message });
      return { success: false, error: message };
    })
    .finally(() => {
      updateDownloadPromise = null;
      if (activeCancellationToken === cancellationToken) {
        activeCancellationToken = null;
      }
    });

  return updateDownloadPromise;
}

async function cancelAppUpdateDownload() {
  if (!app.isPackaged || isDev) {
    return { success: false, error: 'Automatic updates are only available in packaged desktop builds.' };
  }

  if (!updateDownloadPromise || !activeCancellationToken) {
    // Nothing in-flight. Still a successful no-op so the renderer can
    // uniformly clear the `cancelling` UI state without branching on
    // error strings — status is already whatever it was.
    return { success: true, cancelled: false, idle: true };
  }

  try {
    activeCancellationToken.cancel();
  } catch (error) {
    console.warn('[UPDATER] activeCancellationToken.cancel() threw (continuing):', error && error.message);
  }

  // Immediately reflect the cancelled state in the renderer instead of
  // waiting for the downloadUpdate().catch() path. This keeps the UI
  // responsive even if electron-updater delays its internal teardown.
  emitAppUpdateState({
    status: 'available',
    progressPercent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    error: null,
  });

  // Wipe the partial bytes so a subsequent retry does not try to resume
  // a possibly-corrupt segment — electron-updater's resume logic does
  // checksum validation, but on Windows a half-flushed file can leave
  // the NSIS installer in a broken state. Fire-and-forget; log failures.
  try {
    forceCleanupUpdaterCache({ reason: 'download-cancelled' });
  } catch (cleanupError) {
    console.warn('[UPDATER] cleanup after cancel threw:', cleanupError && cleanupError.message);
  }

  return { success: true, cancelled: true };
}

async function quitAndInstallAppUpdate() {
  if (appUpdateState.status !== 'downloaded') {
    return { success: false, error: 'No downloaded update is ready to install.' };
  }

  // Pre-install verify: NsisUpdater.doInstall's spawn error is reported
  // asynchronously via the 'error' event AFTER install() has already
  // returned true, so a missing installer file leads to Electron quitting
  // with no recovery path. Fall back to re-download here so the user
  // doesn't end up with a dead app + clean cache + no new version.
  if (!hasReadyPendingInstaller()) {
    console.warn('[UPDATER] quitAndInstall aborted: pending installer is missing on disk, triggering re-download');
    emitAppUpdateState({
      status: 'available',
      error: 'The downloaded installer file was missing; re-downloading. Please wait for the "Ready to install" state and click Install again.',
    });
    void downloadAppUpdate();
    // errorCode lets the renderer slice skip the reflexive status:'error'
    // override since main has already pushed status:'available' and the
    // download will push 'downloading' next. Without this the renderer
    // flickers to 'error' for ~1 frame before 'downloading' takes over.
    return {
      success: false,
      errorCode: 'installer-missing',
      error: 'Installer file was missing on disk. Re-downloading — please wait for the "Ready" state and click Install again.',
    };
  }

  isInstallingUpdate = true;
  emitAppUpdateState({ status: 'installing', error: null });

  // Fire-and-forget the heavy teardown so the IPC handler returns right
  // away and the renderer transitions to the install overlay. If we
  // awaited the hook before returning, the renderer would see the call
  // hang for >500ms and users assume the app froze.
  (async () => {
    // Stage 1: prepare (close RAG, Genie, Fastify; set app.isQuiting;
    // mark auto-backup done). Keeps every BrowserWindow alive so the
    // install overlay remains visible until Electron's natural shutdown
    // takes over after quitAndInstall fires.
    try {
      await lifecycleHooks.prepareForInstall?.();
    } catch (hookError) {
      console.warn('[UPDATER] prepareForInstall hook threw:', hookError);
    }

    // 500ms buffer so Windows finishes releasing handles on the
    // subsystems we just closed (sqlite WAL/SHM, Fastify TCP socket,
    // Genie child stdin) before NSIS opens the exe for overwrite.
    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
      // Arm the post-install cleanup one-shot BEFORE quitAndInstall: the
      // flag is read by the freshly-installed version's
      // cleanupUpdaterCache() on next cold start, which then bypasses
      // the pending-installer guard and wipes the ~200MB Setup-*.exe we
      // just ran. Writing before quitAndInstall (rather than inside
      // `will-quit`) avoids a race where Electron exits before the
      // synchronous write flushes.
      writePostInstallFlag();

      console.log('[UPDATER] invoking autoUpdater.quitAndInstall(isSilent=true, isForceRunAfter=true)');
      autoUpdater.quitAndInstall(true, true);
      // Success path: electron-updater's internal setImmediate triggers
      // app.quit() which fires the 'will-quit' handlers (they close the
      // remaining subsystems as a belt-and-suspenders measure) and
      // closes all BrowserWindows through the normal shutdown sequence.
      // Nothing more to do from userland.
    } catch (error) {
      // install() caught the error internally and dispatched it through
      // autoUpdater.emit('error', …); returning false means Electron was
      // NOT asked to quit, so all windows are still alive and can show
      // the error banner. We restore state here in case the upstream
      // 'error' event handler didn't cover the edge case.
      const message = stringifyUpdateError(error);
      console.error('[UPDATER] autoUpdater.quitAndInstall threw:', message);
      isInstallingUpdate = false;
      try {
        lifecycleHooks.onQuitAndInstallError?.();
      } catch (hookError) {
        console.warn('[UPDATER] onQuitAndInstallError hook threw:', hookError);
      }
      try {
        forceCleanupUpdaterCache({ reason: 'install-error' });
      } catch (cleanupError) {
        console.warn('[UPDATER] forceCleanupUpdaterCache after install error threw:', cleanupError);
      }
      emitAppUpdateState({ status: 'error', error: message });
    }
  })().catch((orchestrationError) => {
    // Safety net: the async IIFE above shouldn't throw (every await is
    // inside try/catch) but never let a bug here leave isInstallingUpdate
    // stuck at true — the user would otherwise be locked out of retry.
    const message = stringifyUpdateError(orchestrationError);
    console.error('[UPDATER] quitAndInstall orchestration failed:', message);
    isInstallingUpdate = false;
    try {
      lifecycleHooks.onQuitAndInstallError?.();
    } catch (_e) { /* ignore */ }
    emitAppUpdateState({ status: 'error', error: message });
  });

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
    // CancellationError is emitted both to the promise and to this
    // channel when the user-initiated cancelAppUpdateDownload() fires.
    // cancelAppUpdateDownload already pushed `status: 'available'` and
    // wiped pending/, so we must not overwrite that state with 'error'
    // here. Detect by class name — electron-updater does not export
    // CancellationError as a public constructor for instanceof checks.
    const isCancellation =
      (error && error.name === 'CancellationError') ||
      /cancell?ed/i.test(message);
    if (isCancellation) {
      console.log('[UPDATER] error event fired for CancellationError — ignoring (cancel flow already reset state)');
      return;
    }
    console.error('[UPDATER] Error:', message);
    // install() in BaseUpdater catches doInstall() throws and dispatches
    // them through this channel — by the time we see the 'error' event,
    // install() has already returned false and app.quit() was NOT
    // scheduled. Restore state so the user can re-try from the still-
    // alive Settings UI.
    if (isInstallingUpdate) {
      console.error('[UPDATER] error fired during install flow; restoring state so user can retry');
      isInstallingUpdate = false;
      try {
        lifecycleHooks.onQuitAndInstallError?.();
      } catch (hookError) {
        console.warn('[UPDATER] onQuitAndInstallError hook threw during error recovery:', hookError);
      }
      try {
        forceCleanupUpdaterCache({ reason: 'install-error-event' });
      } catch (cleanupError) {
        console.warn('[UPDATER] forceCleanupUpdaterCache in error recovery threw:', cleanupError);
      }
    }
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
  cancelAppUpdateDownload,
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
