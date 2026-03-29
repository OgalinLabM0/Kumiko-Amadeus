const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const JSZip = require('jszip');
const { autoUpdater } = require('electron-updater');
const { initRag, closeRag } = require('./electron-rag.cjs');

let mainWindow;
let tray = null;
let unreadMessageCount = 0;
let lastWrittenBackupPath = null;
const isDev = !app.isPackaged;
let isInstallingUpdate = false;
let isAutoBackupDone = false;
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
  isPackaged: app.isPackaged
};

const iconPath = path.join(__dirname, 'public/favicon-KA.ico');
const POWERSHELL_PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const USER_DATA_REGISTRY_KEY = 'HKCU:\\Software\\KumikoAIAmadeus';
const USER_DATA_VALUE_NAME = 'UserDataPath';
const PENDING_SOURCE_VALUE_NAME = 'PendingMigrationSource';
const PENDING_TARGET_VALUE_NAME = 'PendingMigrationTarget';
const CUSTOM_DATA_DIRECTORY_NAME = 'Kumiko AI Data';
const legacyDefaultUserDataPath = path.resolve(app.getPath('userData'));
const SYSTEM_DRIVE_ROOT = `${(process.env.SystemDrive || legacyDefaultUserDataPath).slice(0, 2)}\\`.toUpperCase();
const UPDATER_CACHE_DIRECTORY_NAMES = [
  'kumiko-ai-amadeus-updater',
  'Kumiko AI-updater',
  'kumiko-amadeus-updater',
  'Kumiko-Amadeus-updater'
];
let lastDataMigrationError = null;

function getDriveRoot(targetPath) {
  return path.parse(path.resolve(targetPath)).root.toUpperCase();
}

function getLocalAppDataPath() {
  if (process.env.LOCALAPPDATA) {
    return path.resolve(process.env.LOCALAPPDATA);
  }

  return path.resolve(path.join(app.getPath('appData'), '..', 'Local'));
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
  const executablePath = app.getPath('exe');
  const executableDirectory = path.dirname(path.resolve(executablePath));
  const installDriveRoot = getDriveRoot(executableDirectory);

  if (!installDriveRoot || installDriveRoot === SYSTEM_DRIVE_ROOT) {
    return legacyDefaultUserDataPath;
  }

  // Use sibling directory instead of internal directory to survive uninstalls
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

const defaultUserDataPath = resolvePreferredDefaultUserDataPath();

function readRegistryValue(valueName) {
  try {
    const output = execFileSync(
      POWERSHELL_PATH,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; (Get-ItemProperty -Path '${USER_DATA_REGISTRY_KEY.replace(/'/g, "''")}' -Name '${valueName.replace(/'/g, "''")}').${valueName}`
      ],
      {
      encoding: 'utf8',
      windowsHide: true
      }
    );
    const value = output.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

function writeRegistryValue(valueName, value) {
  execFileSync(
    POWERSHELL_PATH,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference='Stop'; if (-not (Test-Path '${USER_DATA_REGISTRY_KEY.replace(/'/g, "''")}')) { New-Item -Path '${USER_DATA_REGISTRY_KEY.replace(/'/g, "''")}' -Force | Out-Null }; New-ItemProperty -Path '${USER_DATA_REGISTRY_KEY.replace(/'/g, "''")}' -Name '${valueName.replace(/'/g, "''")}' -Value '${value.replace(/'/g, "''")}' -PropertyType String -Force | Out-Null`
    ],
    {
    windowsHide: true
    }
  );
}

function deleteRegistryValue(valueName) {
  try {
    execFileSync(
      POWERSHELL_PATH,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference='SilentlyContinue'; if (Test-Path '${USER_DATA_REGISTRY_KEY.replace(/'/g, "''")}') { Remove-ItemProperty -Path '${USER_DATA_REGISTRY_KEY.replace(/'/g, "''")}' -Name '${valueName.replace(/'/g, "''")}' -ErrorAction SilentlyContinue }`
      ],
      {
      windowsHide: true
      }
    );
  } catch {
    // Ignore missing registry values.
  }
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
      errorOnExist: false
    });
  }
}

function getManagedDataDirectoryPath(selectedDirectory) {
  return path.join(path.resolve(selectedDirectory), CUSTOM_DATA_DIRECTORY_NAME);
}

function normalizeBackupFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('A valid backup file path is required.');
  }

  return path.resolve(filePath);
}

function writeBackupFile(filePath, content) {
  const normalizedPath = normalizeBackupFilePath(filePath);
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
    fileName: path.basename(normalizedPath)
  };
}

function readBackupFile(filePath) {
  const normalizedPath = normalizeBackupFilePath(filePath);

  return {
    success: true,
    filePath: normalizedPath,
    fileName: path.basename(normalizedPath),
    content: fs.readFileSync(normalizedPath, 'utf8')
  };
}

function getBackupFileInfo(filePath) {
  const normalizedPath = normalizeBackupFilePath(filePath);

  return {
    success: true,
    exists: fs.existsSync(normalizedPath),
    filePath: normalizedPath,
    fileName: path.basename(normalizedPath)
  };
}

async function parseBackupImportFile(filePath) {
  const normalizedPath = normalizeBackupFilePath(filePath);
  const fileName = path.basename(normalizedPath);
  const extension = path.extname(normalizedPath).toLowerCase();

  if (extension === '.zip') {
    const zipBuffer = fs.readFileSync(normalizedPath);
    const zip = await JSZip.loadAsync(zipBuffer);
    const dataFile = zip.file('data.json');

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
          dataUrl: `data:${mimeType};base64,${base64Data}`
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
      imageCount: images.length
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
    imageCount: 0
  };
}

function getDefaultBackupFilePath(defaultFileName) {
  const normalizedFileName = defaultFileName && typeof defaultFileName === 'string'
    ? defaultFileName
    : `kumiko_backup_${new Date().toISOString().slice(0, 10)}.json`;

  return path.join(app.getPath('documents'), normalizedFileName);
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
    isPackaged: app.isPackaged
  };

  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('app:update-status', appUpdateState);
    } catch (error) {
      console.warn('[UPDATER] Failed to send update state to renderer:', error);
    }
  }

  return appUpdateState;
}

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
    error: null
  });

  updateCheckPromise = autoUpdater.checkForUpdates()
    .then((result) => ({
      success: true,
      trigger,
      updateInfo: result?.updateInfo || null
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
    bytesPerSecond: 0
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
  isAutoBackupDone = true;
  app.isQuiting = true;

  setTimeout(() => {
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (error) {
      console.error('[UPDATER] Failed to quit and install update:', error);
      isInstallingUpdate = false;
      isAutoBackupDone = false;
      emitAppUpdateState({ status: 'error', error: stringifyUpdateError(error) });
    }
  }, 120);

  return { success: true };
}

function setupAutoUpdater() {
  if (!app.isPackaged || isDev) {
    emitAppUpdateState({
      status: 'unsupported',
      error: 'Automatic updates are only available in packaged desktop builds.'
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
      error: null
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
      error: null
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    emitAppUpdateState({
      status: 'downloading',
      progressPercent: Number.isFinite(progress?.percent) ? progress.percent : 0,
      transferred: Number.isFinite(progress?.transferred) ? progress.transferred : 0,
      total: Number.isFinite(progress?.total) ? progress.total : 0,
      bytesPerSecond: Number.isFinite(progress?.bytesPerSecond) ? progress.bytesPerSecond : 0,
      error: null
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
      error: null
    });
  });

  autoUpdater.on('error', (error) => {
    const message = stringifyUpdateError(error);
    console.error('[UPDATER] Error:', message);
    emitAppUpdateState({ status: 'error', error: message });
  });
}

function promoteDefaultUserDataPath() {
  if (readRegistryValue(USER_DATA_VALUE_NAME)) {
    return;
  }

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
  const configuredPath = readRegistryValue(USER_DATA_VALUE_NAME);
  const resolvedPath = path.resolve(configuredPath || defaultUserDataPath);
  ensureDirectory(resolvedPath);
  app.setPath('userData', resolvedPath);
  app.setPath('sessionData', resolvedPath);
}

function processPendingUserDataMigration() {
  const pendingSource = readRegistryValue(PENDING_SOURCE_VALUE_NAME);
  const pendingTarget = readRegistryValue(PENDING_TARGET_VALUE_NAME);

  if (!pendingSource || !pendingTarget) {
    return;
  }

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
      deleteRegistryValue(USER_DATA_VALUE_NAME);
    } else {
      writeRegistryValue(USER_DATA_VALUE_NAME, targetPath);
    }

    lastDataMigrationError = null;
  } catch (error) {
    lastDataMigrationError = error instanceof Error ? error.message : String(error);
    console.error('[DATA DIR] Failed to migrate user data directory:', error);
  } finally {
    deleteRegistryValue(PENDING_SOURCE_VALUE_NAME);
    deleteRegistryValue(PENDING_TARGET_VALUE_NAME);
  }
}

function getDataDirectoryInfo() {
  const currentPath = path.resolve(app.getPath('userData'));
  return {
    success: true,
    currentPath,
    defaultPath: defaultUserDataPath,
    isCustom: currentPath !== defaultUserDataPath,
    managedFolderName: CUSTOM_DATA_DIRECTORY_NAME,
    migrationError: lastDataMigrationError
  };
}

function scheduleUserDataMigration(targetPath) {
  const currentPath = path.resolve(app.getPath('userData'));
  const resolvedTargetPath = path.resolve(targetPath);

  if (currentPath === resolvedTargetPath) {
    return { success: true, alreadyActive: true };
  }

  if (isNestedPath(currentPath, resolvedTargetPath) || isNestedPath(resolvedTargetPath, currentPath)) {
    return {
      success: false,
      error: 'The source and target data directories cannot contain each other.'
    };
  }

  if (resolvedTargetPath !== defaultUserDataPath && !isDirectoryEmpty(resolvedTargetPath)) {
    return {
      success: false,
      error: 'The selected data directory is not empty. Please choose an empty folder.'
    };
  }

  try {
    ensureDirectory(resolvedTargetPath);
    writeRegistryValue(PENDING_SOURCE_VALUE_NAME, currentPath);
    writeRegistryValue(PENDING_TARGET_VALUE_NAME, resolvedTargetPath);
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
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

processPendingUserDataMigration();
promoteDefaultUserDataPath();
applyConfiguredUserDataPath();

// Global remove application basic menus
Menu.setApplicationMenu(null);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

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
}

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
    return { success: true, state: appUpdateState };
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

  ipcMain.handle('app:get-weather', async () => {
    try {
      // Uji, Kyoto coordinates: 34.8906, 135.8016
      const ujiResponse = await fetch('https://api.open-meteo.com/v1/forecast?latitude=34.8906&longitude=135.8016&current_weather=true&timezone=Asia%2FTokyo');
      const ujiData = await ujiResponse.json();
      
      // User location based on IP (using ip-api.com for rough coordinates)
      let userWeather = null;
      try {
        const ipResponse = await fetch('http://ip-api.com/json/');
        const ipData = await ipResponse.json();
        if (ipData.lat && ipData.lon) {
          const userWeatherResponse = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${ipData.lat}&longitude=${ipData.lon}&current_weather=true`);
          userWeather = await userWeatherResponse.json();
        }
      } catch (e) {
        console.warn('[Weather] Failed to fetch user weather:', e);
      }

      return {
        success: true,
        uji: ujiData.current_weather,
        user: userWeather?.current_weather || null
      };
    } catch (e) {
      console.error('[Weather] Failed to fetch weather data:', e);
      return { success: false, error: e.message };
    }
  });

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
    return scheduleUserDataMigration(defaultUserDataPath);
  });

  // ── Voice file IPC ──────────────────────────────────────────────

  function getVoiceDir() {
    const dir = path.join(app.getPath('userData'), 'voice');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function getRingtoneDir() {
    const dir = path.join(app.getPath('userData'), 'ringtone');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  ipcMain.handle('voice:save', (_event, payload = {}) => {
    try {
      const { messageId, buffer } = payload;
      if (!messageId || !buffer) return { success: false, error: 'Missing params' };
      const filePath = path.join(getVoiceDir(), `${messageId}.mp3`);
      fs.writeFileSync(filePath, Buffer.from(buffer));
      return { success: true, filePath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('voice:load', (_event, payload = {}) => {
    try {
      const filePath = path.join(getVoiceDir(), `${payload.messageId}.mp3`);
      if (!fs.existsSync(filePath)) return { success: false, error: 'Not found' };
      const buffer = fs.readFileSync(filePath);
      return { success: true, buffer };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('voice:delete', (_event, payload = {}) => {
    try {
      const filePath = path.join(getVoiceDir(), `${payload.messageId}.mp3`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('voice:list', () => {
    try {
      const dir = getVoiceDir();
      const entries = fs.readdirSync(dir);
      const files = entries
        .filter(f => f.endsWith('.mp3'))
        .map(f => {
          const stat = fs.statSync(path.join(dir, f));
          return { id: f.replace(/\.mp3$/, ''), size: stat.size, mtime: stat.mtimeMs };
        });
      return { success: true, files };
    } catch (e) {
      return { success: true, files: [] };
    }
  });

  ipcMain.handle('voice:open-folder', () => {
    try {
      shell.openPath(getVoiceDir());
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('voice:get-storage-info', () => {
    try {
      const dir = getVoiceDir();
      const entries = fs.readdirSync(dir).filter(f => f.endsWith('.mp3'));
      let totalBytes = 0;
      for (const f of entries) {
        totalBytes += fs.statSync(path.join(dir, f)).size;
      }
      return { success: true, count: entries.length, totalBytes };
    } catch (e) {
      return { success: true, count: 0, totalBytes: 0 };
    }
  });

  ipcMain.handle('ringtone:save', (_event, payload = {}) => {
    try {
      const { buffer, ext } = payload;
      if (!buffer || !ext) return { success: false, error: 'Missing params' };
      const dir = getRingtoneDir();
      const existing = fs.readdirSync(dir).filter(f => f.startsWith('custom.'));
      for (const f of existing) fs.unlinkSync(path.join(dir, f));
      const filePath = path.join(dir, `custom.${ext}`);
      fs.writeFileSync(filePath, Buffer.from(buffer));
      return { success: true, filePath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('ringtone:load', () => {
    try {
      const dir = getRingtoneDir();
      const entries = fs.readdirSync(dir).filter(f => f.startsWith('custom.'));
      if (entries.length === 0) return { success: false };
      const filePath = path.join(dir, entries[0]);
      const buffer = fs.readFileSync(filePath);
      return { success: true, buffer, fileName: entries[0] };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('ringtone:delete', () => {
    try {
      const dir = getRingtoneDir();
      const entries = fs.readdirSync(dir).filter(f => f.startsWith('custom.'));
      for (const f of entries) fs.unlinkSync(path.join(dir, f));
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('ringtone:get-info', () => {
    try {
      const dir = getRingtoneDir();
      if (!fs.existsSync(dir)) return { exists: false, fileName: null, size: 0 };
      const entries = fs.readdirSync(dir).filter(f => f.startsWith('custom.'));
      if (entries.length === 0) return { exists: false, fileName: null, size: 0 };
      const file = entries[0];
      const size = fs.statSync(path.join(dir, file)).size;
      return { exists: true, fileName: file, size };
    } catch (e) {
      return { exists: false, fileName: null, size: 0 };
    }
  });

  ipcMain.handle('ringtone:open-folder', () => {
    try {
      const dir = getRingtoneDir();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      shell.openPath(dir);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

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

      return readBackupFile(result.filePaths[0]);
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
      writeRegistryValue('AutoZipBackupEnabled', enabled ? '1' : '0');
      return { success: true, enabled };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('app:get-auto-zip-backup', () => {
    try {
      const val = readRegistryValue('AutoZipBackupEnabled');
      return { success: true, enabled: val === '1' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  app.whenReady().then(async () => {
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

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', (event) => {
    if (isAutoBackupDone || isInstallingUpdate) return;
    try {
      const autoZipVal = readRegistryValue('AutoZipBackupEnabled');
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
      zip.file('kumiko_backup.json', fs.readFileSync(latestJson));

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
  });
}
