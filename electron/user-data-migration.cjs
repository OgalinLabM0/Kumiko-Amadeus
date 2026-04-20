// electron/user-data-migration.cjs
//
// userData directory resolution + migration state machine + the four
// `app:*-data-directory` IPC-backing functions.
//
// Responsibilities split:
//   - resolvePreferredDefaultUserDataPath / getDefaultUserDataPath:
//     cross-platform "where should data live by default?" answer.
//     Linux: $XDG_DATA_HOME/Kumiko-Amadeus (freedesktop XDG spec).
//     Windows: if the app is installed on a non-system drive, we prefer
//       a sibling "Kumiko AI Data" directory on the install drive so
//       the data survives OS reinstalls and follows the SSD/HDD choice.
//       Falls back to the legacy Electron default (%APPDATA%/Kumiko AI)
//       if the install drive === system drive or write access fails.
//     macOS: legacy Electron default (~/Library/Application Support).
//   - promoteDefaultUserDataPath: first-run silently moves any existing
//     legacy userData content onto the new preferred location.
//   - applyConfiguredUserDataPath: applies the user's explicit pick
//     (if any) from kumiko-config.json onto app.setPath.
//   - processPendingUserDataMigration: completes a migration that was
//     queued pre-quit by scheduleUserDataMigration (source/target were
//     persisted, quit/relaunch happened, now we execute the copy on
//     the fresh process so we don't race open file handles).
//   - scheduleUserDataMigration: persists the next-boot migration
//     request, triggers app.relaunch() + app.quit() after a 150ms
//     grace period so the renderer has time to flush its IPC response.
//
// Nothing here takes a mainWindow — scheduleUserDataMigration only
// drives app.relaunch/app.quit, and the 4 IPC handlers are backed by
// pure functions. The renderer side (dialog parent) is handled by
// electron-main.cjs where `dialog.showOpenDialog(mainWindow, ...)`
// lives (we re-use the raw dialog module there).
//
// Cross-module dependencies: only ./user-config.cjs for the
// key/value store that holds USER_DATA / PENDING_SOURCE / PENDING_TARGET.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const {
  readConfigValue,
  writeConfigValue,
  deleteConfigValue,
  USER_DATA_VALUE_NAME,
  PENDING_SOURCE_VALUE_NAME,
  PENDING_TARGET_VALUE_NAME,
} = require('./user-config.cjs');

const IS_WINDOWS = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

const CUSTOM_DATA_DIRECTORY_NAME = 'Kumiko AI Data';

// Resolved at module load time (before app.setPath), so it represents
// whatever userData path Electron chose on boot — i.e. the historical
// default before this module migrates anything. Subsequent
// applyConfiguredUserDataPath calls may override app.getPath('userData'),
// which is deliberately NOT reflected here.
const legacyDefaultUserDataPath = path.resolve(app.getPath('userData'));

// Windows-specific drive-letter root (e.g. "C:\"). On non-Windows
// platforms the "drive" concept is meaningless, so SYSTEM_DRIVE_ROOT is
// only referenced from inside IS_WINDOWS branches in
// resolvePreferredDefaultUserDataPath().
const SYSTEM_DRIVE_ROOT = IS_WINDOWS
  ? `${(process.env.SystemDrive || legacyDefaultUserDataPath).slice(0, 2)}\\`.toUpperCase()
  : '/';

let lastDataMigrationError = null;
let defaultUserDataPathCache = null;

function getDriveRoot(targetPath) {
  return path.parse(path.resolve(targetPath)).root.toUpperCase();
}

function getLocalAppDataPath() {
  if (process.env.LOCALAPPDATA) {
    return path.resolve(process.env.LOCALAPPDATA);
  }

  return path.resolve(path.join(app.getPath('appData'), '..', 'Local'));
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function isDirectoryEmpty(directoryPath) {
  return !fs.existsSync(directoryPath) || fs.readdirSync(directoryPath).length === 0;
}

function isNestedPath(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function copyDirectoryContents(sourcePath, targetPath) {
  ensureDirectory(targetPath);

  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    const sourceEntryPath = path.join(sourcePath, entry.name);
    const targetEntryPath = path.join(targetPath, entry.name);
    fs.cpSync(sourceEntryPath, targetEntryPath, {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
  }
}

function canUseDataDirectory(candidatePath) {
  try {
    ensureDirectory(candidatePath);
    fs.accessSync(candidatePath, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePreferredDefaultUserDataPath() {
  // Linux: follow the freedesktop.org XDG Base Directory spec. User data
  // goes under $XDG_DATA_HOME (commonly ~/.local/share), which is the
  // canonical place for per-user application data on Linux desktops and
  // survives app uninstall/reinstall cleanly. This is independent of
  // install location (AppImage typically runs from ~/Applications or
  // /tmp/.mount_*), so the Windows-style "install drive != system drive"
  // heuristic doesn't apply.
  if (IS_LINUX) {
    const xdgDataHome = process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim();
    const base = xdgDataHome
      ? path.resolve(xdgDataHome)
      : path.join(os.homedir(), '.local', 'share');
    return path.join(base, 'Kumiko-Amadeus');
  }

  // macOS falls back to Electron's default (~/Library/Application Support/Kumiko AI).
  if (!IS_WINDOWS) {
    return legacyDefaultUserDataPath;
  }

  // Windows: if the app is installed on a non-system drive (e.g.
  // D:/E:/F:), we prefer to keep user data on the same drive so it
  // survives OS reinstalls and so the SSD/HDD choice is respected.
  // This preserves the pre-Linux behaviour exactly.
  const executablePath = app.getPath('exe');
  const executableDirectory = path.dirname(path.resolve(executablePath));
  const installDriveRoot = getDriveRoot(executableDirectory);

  if (!installDriveRoot || installDriveRoot === SYSTEM_DRIVE_ROOT) {
    return legacyDefaultUserDataPath;
  }

  // Use sibling directory instead of internal directory to survive uninstalls.
  const siblingScopedPath = path.join(path.dirname(executableDirectory), CUSTOM_DATA_DIRECTORY_NAME);
  if (canUseDataDirectory(siblingScopedPath)) {
    return siblingScopedPath;
  }

  const driveScopedPath = path.join(installDriveRoot, CUSTOM_DATA_DIRECTORY_NAME);
  if (canUseDataDirectory(driveScopedPath)) {
    return driveScopedPath;
  }

  return legacyDefaultUserDataPath;
}

function getDefaultUserDataPath() {
  if (defaultUserDataPathCache === null) {
    defaultUserDataPathCache = resolvePreferredDefaultUserDataPath();
  }
  return defaultUserDataPathCache;
}

function getManagedDataDirectoryPath(selectedDirectory) {
  return path.join(path.resolve(selectedDirectory), CUSTOM_DATA_DIRECTORY_NAME);
}

// ── Migration primitives ─────────────────────────────────────────────

function promoteDefaultUserDataPath() {
  if (readConfigValue(USER_DATA_VALUE_NAME)) {
    return;
  }

  const defaultUserDataPath = getDefaultUserDataPath();

  if (defaultUserDataPath === legacyDefaultUserDataPath) {
    return;
  }

  try {
    if (fs.existsSync(defaultUserDataPath) && !isDirectoryEmpty(defaultUserDataPath)) {
      return;
    }

    if (fs.existsSync(legacyDefaultUserDataPath) && !isDirectoryEmpty(legacyDefaultUserDataPath)) {
      copyDirectoryContents(legacyDefaultUserDataPath, defaultUserDataPath);
      try {
        fs.rmSync(legacyDefaultUserDataPath, { recursive: true, force: true });
      } catch (error) {
        console.warn('[DATA DIR] Legacy data directory could not be removed yet:', error);
      }
    } else {
      ensureDirectory(defaultUserDataPath);
    }

    lastDataMigrationError = null;
  } catch (error) {
    lastDataMigrationError = error instanceof Error ? error.message : String(error);
    console.error('[DATA DIR] Failed to promote the default data directory:', error);
  }
}

function applyConfiguredUserDataPath() {
  const configuredPath = readConfigValue(USER_DATA_VALUE_NAME);
  const resolvedPath = path.resolve(configuredPath || getDefaultUserDataPath());
  ensureDirectory(resolvedPath);
  app.setPath('userData', resolvedPath);
  app.setPath('sessionData', resolvedPath);
}

function processPendingUserDataMigration() {
  const pendingSource = readConfigValue(PENDING_SOURCE_VALUE_NAME);
  const pendingTarget = readConfigValue(PENDING_TARGET_VALUE_NAME);

  if (!pendingSource || !pendingTarget) {
    return;
  }

  const defaultUserDataPath = getDefaultUserDataPath();

  try {
    const sourcePath = path.resolve(pendingSource);
    const targetPath = path.resolve(pendingTarget);

    if (sourcePath !== targetPath) {
      if (isNestedPath(sourcePath, targetPath) || isNestedPath(targetPath, sourcePath)) {
        throw new Error('Source and target data directories cannot contain each other.');
      }

      if (fs.existsSync(sourcePath)) {
        if (targetPath !== defaultUserDataPath && !isDirectoryEmpty(targetPath)) {
          throw new Error('The selected data directory is not empty. Please choose an empty folder.');
        }

        copyDirectoryContents(sourcePath, targetPath);
        fs.rmSync(sourcePath, { recursive: true, force: true });
      } else {
        ensureDirectory(targetPath);
      }
    }

    if (targetPath === defaultUserDataPath) {
      deleteConfigValue(USER_DATA_VALUE_NAME);
    } else {
      writeConfigValue(USER_DATA_VALUE_NAME, targetPath);
    }

    lastDataMigrationError = null;
  } catch (error) {
    lastDataMigrationError = error instanceof Error ? error.message : String(error);
    console.error('[DATA DIR] Failed to migrate user data directory:', error);
  } finally {
    deleteConfigValue(PENDING_SOURCE_VALUE_NAME);
    deleteConfigValue(PENDING_TARGET_VALUE_NAME);
  }
}

function getDataDirectoryInfo() {
  const currentPath = path.resolve(app.getPath('userData'));
  const defaultUserDataPath = getDefaultUserDataPath();
  return {
    success: true,
    currentPath,
    defaultPath: defaultUserDataPath,
    isCustom: currentPath !== defaultUserDataPath,
    managedFolderName: CUSTOM_DATA_DIRECTORY_NAME,
    migrationError: lastDataMigrationError,
  };
}

function scheduleUserDataMigration(targetPath) {
  const currentPath = path.resolve(app.getPath('userData'));
  const resolvedTargetPath = path.resolve(targetPath);
  const defaultUserDataPath = getDefaultUserDataPath();

  if (currentPath === resolvedTargetPath) {
    return { success: true, alreadyActive: true };
  }

  if (isNestedPath(currentPath, resolvedTargetPath) || isNestedPath(resolvedTargetPath, currentPath)) {
    return {
      success: false,
      error: 'The source and target data directories cannot contain each other.',
    };
  }

  if (resolvedTargetPath !== defaultUserDataPath && !isDirectoryEmpty(resolvedTargetPath)) {
    return {
      success: false,
      error: 'The selected data directory is not empty. Please choose an empty folder.',
    };
  }

  try {
    ensureDirectory(resolvedTargetPath);
    writeConfigValue(PENDING_SOURCE_VALUE_NAME, currentPath);
    writeConfigValue(PENDING_TARGET_VALUE_NAME, resolvedTargetPath);
    lastDataMigrationError = null;

    setTimeout(() => {
      app.isQuiting = true;
      app.relaunch();
      app.quit();
    }, 150);

    return { success: true, relaunching: true };
  } catch (error) {
    console.error('[DATA DIR] Failed to schedule user data migration:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

module.exports = {
  getDefaultUserDataPath,
  getManagedDataDirectoryPath,
  promoteDefaultUserDataPath,
  applyConfiguredUserDataPath,
  processPendingUserDataMigration,
  getDataDirectoryInfo,
  scheduleUserDataMigration,
};
