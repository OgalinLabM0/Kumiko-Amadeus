const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, Notification, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const JSZip = require('jszip');
const { autoUpdater } = require('electron-updater');
const { initRag, closeRag } = require('./electron-rag.cjs');

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
let genieProcess = null;
let unreadMessageCount = 0;
let lastWrittenBackupPath = null;

// GPT-SoVITS directory authorization: pre-approved install locations. genie:start will
// only spawn processes from a sovitsDir that the user explicitly picked via the native
// dialog (genie:pick-sovits-dir), AND that still passes install-fingerprint checks at
// spawn time. This closes a path-injection → RCE vector where a compromised renderer
// could otherwise tell the main process to spawn python.exe out of any attacker-controlled
// directory. Persisted across restarts to keep the "Start server" UX seamless.
const authorizedSovitsDirs = new Set();
function getAuthorizedSovitsDirsFile() {
  return path.join(app.getPath('userData'), 'authorized-sovits-dirs.json');
}
function loadAuthorizedSovitsDirs() {
  try {
    const file = getAuthorizedSovitsDirsFile();
    if (!fs.existsSync(file)) return;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry === 'string' && entry) {
          authorizedSovitsDirs.add(path.resolve(entry));
        }
      }
    }
  } catch (e) {
    console.warn('[GENIE] Failed to load authorized sovits dirs:', e && e.message);
  }
}
function persistAuthorizedSovitsDirs() {
  try {
    const file = getAuthorizedSovitsDirsFile();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Array.from(authorizedSovitsDirs), null, 2), 'utf8');
  } catch (e) {
    console.warn('[GENIE] Failed to persist authorized sovits dirs:', e && e.message);
  }
}
// Install fingerprint: the canonical GPT-SoVITS directory layout the project relies on.
// If any of these is missing the dir is clearly NOT a legitimate SoVITS install and we
// refuse to spawn anything from it.
//
// Platform notes:
//   - Windows: requires the bundled `runtime/python.exe`, since genie:start launches
//     that specific interpreter directly. This is how the Windows SoVITS distribution
//     is packaged.
//   - Linux (BYO Python): users are expected to supply their own python interpreter
//     via the separate authorizedSovitsPythons authorization flow (pick-sovits-python).
//     So on Linux we only validate that the directory holds SoVITS's own Python code
//     (api_v2.py + tts_infer.yaml) and do not require any bundled runtime.
function isValidSovitsDir(sovitsDir) {
  if (typeof sovitsDir !== 'string' || !sovitsDir) return false;
  try {
    const resolved = path.resolve(sovitsDir);
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return false;
    if (IS_WINDOWS && !fs.existsSync(path.join(resolved, 'runtime', 'python.exe'))) return false;
    if (!fs.existsSync(path.join(resolved, 'api_v2.py'))) return false;
    if (!fs.existsSync(path.join(resolved, 'GPT_SoVITS', 'configs', 'tts_infer.yaml'))) return false;
    return true;
  } catch {
    return false;
  }
}
function getSovitsDirFingerprintError() {
  return IS_WINDOWS
    ? 'The selected directory is not a valid GPT-SoVITS install (missing runtime/python.exe, api_v2.py, or GPT_SoVITS/configs/tts_infer.yaml).'
    : 'The selected directory is not a valid GPT-SoVITS install (missing api_v2.py or GPT_SoVITS/configs/tts_infer.yaml). On Linux you supply your own Python interpreter separately.';
}
function authorizeSovitsDir(resolvedPath) {
  if (typeof resolvedPath !== 'string' || !resolvedPath) return;
  if (!authorizedSovitsDirs.has(resolvedPath)) {
    authorizedSovitsDirs.add(resolvedPath);
    persistAuthorizedSovitsDirs();
  }
}

// Linux/macOS GPT-SoVITS brings its own Python interpreter — the app does not bundle
// a python runtime for those platforms because packaging SoVITS's full inference
// stack would inflate the AppImage considerably and is version-sensitive. Instead,
// the user picks their own python (conda env / venv) through the native file dialog
// in Settings → TTS → GPT-SoVITS; the selected path lands in authorizedSovitsPythons
// and gets persisted so the approval survives restarts. genie:start refuses to spawn
// any python executable that isn't in this set, closing the same path-injection /
// RCE vector that authorizedSovitsDirs closes for the SoVITS directory itself.
const authorizedSovitsPythons = new Set();
function getAuthorizedSovitsPythonsFile() {
  return path.join(app.getPath('userData'), 'authorized-sovits-pythons.json');
}
function loadAuthorizedSovitsPythons() {
  try {
    const file = getAuthorizedSovitsPythonsFile();
    if (!fs.existsSync(file)) return;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry === 'string' && entry) {
          authorizedSovitsPythons.add(path.resolve(entry));
        }
      }
    }
  } catch (e) {
    console.warn('[GENIE] Failed to load authorized sovits pythons:', e && e.message);
  }
}
function persistAuthorizedSovitsPythons() {
  try {
    const file = getAuthorizedSovitsPythonsFile();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Array.from(authorizedSovitsPythons), null, 2), 'utf8');
  } catch (e) {
    console.warn('[GENIE] Failed to persist authorized sovits pythons:', e && e.message);
  }
}
function authorizeSovitsPython(resolvedPath) {
  if (typeof resolvedPath !== 'string' || !resolvedPath) return;
  if (!authorizedSovitsPythons.has(resolvedPath)) {
    authorizedSovitsPythons.add(resolvedPath);
    persistAuthorizedSovitsPythons();
  }
}
// Fingerprint an explicit python interpreter path: must be an absolute path to an
// existing regular file, and on Unix we also require the executable bit. On Windows
// we don't enforce executable bit because the concept doesn't match (any .exe is
// executable if the user has read access).
function isValidSovitsPython(pythonPath) {
  if (typeof pythonPath !== 'string' || !pythonPath) return false;
  try {
    const resolved = path.resolve(pythonPath);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return false;
    if (!IS_WINDOWS) {
      fs.accessSync(resolved, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

// Cross-platform termination of the detached SoVITS server process tree.
//   - Windows: taskkill with /T walks the process tree (cmd.exe → python.exe →
//     torch worker) and /F forces; this is the same behaviour the pre-Linux
//     code had.
//   - Linux: we spawned with detached:true so the child sits in its own process
//     group. A negative PID signals the whole group, which is how we reach
//     python's own subprocesses (DataLoader workers etc.). SIGTERM first for
//     graceful shutdown, then a SIGKILL backstop 3s later if anything is still
//     hanging. We use process.kill instead of genieProcess.kill because that
//     only signals the immediate child.
function terminateGenieProcess() {
  if (!genieProcess) return;
  const pid = genieProcess.pid;
  if (IS_WINDOWS) {
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
    } catch { /* nothing actionable if taskkill itself fails */ }
  } else if (pid) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try { genieProcess.kill('SIGTERM'); } catch { /* already gone */ }
    }
    setTimeout(() => {
      try {
        process.kill(-pid, 0);
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already dead */ }
      } catch { /* group already exited, nothing to do */ }
    }, 3000).unref();
  }
  genieProcess = null;
}

// Backup path safety: maintain a set of filesystem paths that the user has explicitly
// approved through a native dialog (backup:pick-save-file / backup:pick-open-file), or
// that live inside the app's userData directory (our own data). Any backup:* IPC that
// actually touches disk must resolve its input against this set, blocking renderer-driven
// writes/reads to arbitrary paths (hardens against a XSS-style attacker who controls the
// renderer message bus). See assertBackupPathAllowed().
//
// Persisted to userData/authorized-backup-paths.json so that after an app restart the
// existing auto-save connection to the user's previously chosen backup file still works
// without forcing them to re-authorize. Only paths the user themselves picked via native
// dialog ever get added; the renderer cannot grow this set.
const allowedBackupPaths = new Set();
function getAuthorizedBackupPathsFile() {
  return path.join(app.getPath('userData'), 'authorized-backup-paths.json');
}
function loadAuthorizedBackupPaths() {
  try {
    const file = getAuthorizedBackupPathsFile();
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry === 'string' && entry) {
          allowedBackupPaths.add(path.resolve(entry));
        }
      }
    }
  } catch (e) {
    console.warn('[BACKUP] Failed to load authorized backup paths:', e && e.message);
  }
}
function persistAuthorizedBackupPaths() {
  try {
    const file = getAuthorizedBackupPathsFile();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Array.from(allowedBackupPaths), null, 2), 'utf8');
  } catch (e) {
    console.warn('[BACKUP] Failed to persist authorized backup paths:', e && e.message);
  }
}
function authorizeBackupPath(resolvedPath) {
  if (typeof resolvedPath !== 'string' || !resolvedPath) return;
  if (!allowedBackupPaths.has(resolvedPath)) {
    allowedBackupPaths.add(resolvedPath);
    persistAuthorizedBackupPaths();
  }
}
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
// Windows-only PowerShell/registry constants. On Linux these are never invoked
// because configStore short-circuits to JSON — see readConfigValue() below.
const POWERSHELL_PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const USER_DATA_REGISTRY_KEY = 'HKCU:\\Software\\KumikoAIAmadeus';
const USER_DATA_VALUE_NAME = 'UserDataPath';
const PENDING_SOURCE_VALUE_NAME = 'PendingMigrationSource';
const PENDING_TARGET_VALUE_NAME = 'PendingMigrationTarget';
const CUSTOM_DATA_DIRECTORY_NAME = 'Kumiko AI Data';
const legacyDefaultUserDataPath = path.resolve(app.getPath('userData'));
// Windows-specific drive-letter root (e.g. "C:\"). On non-Windows platforms the
// "drive" concept is meaningless, so SYSTEM_DRIVE_ROOT is only referenced from
// inside IS_WINDOWS branches in resolvePreferredDefaultUserDataPath().
const SYSTEM_DRIVE_ROOT = IS_WINDOWS
  ? `${(process.env.SystemDrive || legacyDefaultUserDataPath).slice(0, 2)}\\`.toUpperCase()
  : '/';
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
  // Linux: follow the freedesktop.org XDG Base Directory spec. User data goes
  // under $XDG_DATA_HOME (commonly ~/.local/share), which is the canonical
  // place for per-user application data on Linux desktops and survives app
  // uninstall/reinstall cleanly. This is independent of install location
  // (AppImage typically runs from ~/Applications or /tmp/.mount_*), so the
  // Windows-style "install drive != system drive" heuristic doesn't apply.
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

  // Windows: if the app is installed on a non-system drive (e.g. D:/E:/F:), we
  // prefer to keep user data on the same drive so it survives OS reinstalls
  // and so the SSD/HDD choice is respected. This preserves the pre-Linux
  // behaviour exactly.
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
const RINGTONE_AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);

// ── configStore: cross-platform key/value persistence ──────────────
// Historically (Windows-only) this project stored UserDataPath / pending
// migration markers / AutoZipBackupEnabled in HKCU via PowerShell. Linux has
// no equivalent registry, so we now persist the same keys to a JSON file
// alongside the legacy default userData directory. Windows still works
// identically from the caller's perspective — on first launch of a
// configStore-aware build we one-shot copy any legacy registry values into
// the JSON so existing users don't lose their settings.
//
// We intentionally anchor the config file at legacyDefaultUserDataPath, NOT
// at app.getPath('userData'): userData may itself be redirected to a
// different drive via UserDataPath, and we need to read UserDataPath *before*
// that redirect is applied. Anchoring here keeps the config file's own
// location stable and avoids a chicken-and-egg lookup.
const CONFIG_STORE_FILENAME = 'kumiko-config.json';
const CONFIG_STORE_MIGRATION_MARKER = '__migratedFromRegistry';
const MIGRATABLE_REGISTRY_KEYS = [
  USER_DATA_VALUE_NAME,
  PENDING_SOURCE_VALUE_NAME,
  PENDING_TARGET_VALUE_NAME,
  'AutoZipBackupEnabled',
];

function getConfigStoreFilePath() {
  return path.join(legacyDefaultUserDataPath, CONFIG_STORE_FILENAME);
}

function loadConfigStoreObject() {
  try {
    const file = getConfigStoreFilePath();
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (error) {
    console.warn('[CONFIG] Failed to read kumiko-config.json, treating as empty:', error && error.message);
    return {};
  }
}

function saveConfigStoreObject(nextStore) {
  const file = getConfigStoreFilePath();
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch { /* mkdir race is harmless */ }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(nextStore, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw error;
  }
}

function readConfigValue(key) {
  const store = loadConfigStoreObject();
  const value = store[key];
  return typeof value === 'string' && value ? value : null;
}

function writeConfigValue(key, value) {
  const store = loadConfigStoreObject();
  store[key] = String(value);
  saveConfigStoreObject(store);
}

function deleteConfigValue(key) {
  const store = loadConfigStoreObject();
  if (!(key in store)) return;
  delete store[key];
  saveConfigStoreObject(store);
}

// Windows-only one-shot import of legacy HKCU values. Called once at startup
// before any readConfigValue(). If the JSON already carries the migration
// marker (or we're not on Windows) this is a no-op. Values already present
// in the JSON are never overwritten — the JSON is authoritative.
function migrateRegistryToConfigStoreOnce() {
  if (!IS_WINDOWS) return;
  const store = loadConfigStoreObject();
  if (store[CONFIG_STORE_MIGRATION_MARKER]) return;
  let mutated = false;
  for (const regKey of MIGRATABLE_REGISTRY_KEYS) {
    if (typeof store[regKey] === 'string' && store[regKey]) continue;
    try {
      const value = readRegistryValue(regKey);
      if (typeof value === 'string' && value) {
        store[regKey] = value;
        mutated = true;
      }
    } catch (error) {
      console.warn(`[CONFIG] Failed to read legacy registry value ${regKey}:`, error && error.message);
    }
  }
  store[CONFIG_STORE_MIGRATION_MARKER] = new Date().toISOString();
  try {
    saveConfigStoreObject(store);
    if (mutated) {
      console.log('[CONFIG] Imported legacy HKCU values into kumiko-config.json');
    }
  } catch (error) {
    console.warn('[CONFIG] Failed to persist registry migration marker:', error && error.message);
  }
}

// Legacy Windows registry accessors. Kept intentionally so
// migrateRegistryToConfigStoreOnce() can still import pre-JSON values on
// first launch. All new business code goes through readConfigValue /
// writeConfigValue / deleteConfigValue above, so these three functions are
// only called from the migration path now.
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

// Check whether a resolved path is allowed for backup IO. Allowed paths are:
//   1. Anything under the app's userData directory (our own data, safe to read/write).
//   2. Anything the user explicitly approved in this session via pick-save / pick-open
//      (and kept in allowedBackupPaths).
// This prevents a compromised renderer from asking the main process to read or overwrite
// arbitrary files on the user's disk (e.g., AppData of other applications, system files).
function assertBackupPathAllowed(resolvedPath) {
  if (typeof resolvedPath !== 'string' || !resolvedPath) {
    throw new Error('Backup path is required.');
  }
  const userDataRoot = path.resolve(app.getPath('userData'));
  const isInsideUserData = resolvedPath === userDataRoot
    || resolvedPath.startsWith(userDataRoot + path.sep);
  if (isInsideUserData) return;
  if (allowedBackupPaths.has(resolvedPath)) return;
  throw new Error('Backup path not authorized. Please re-select the file via the native dialog.');
}

function writeBackupFile(filePath, content) {
  const normalizedPath = normalizeBackupFilePath(filePath);
  assertBackupPathAllowed(normalizedPath);
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
  assertBackupPathAllowed(normalizedPath);

  return {
    success: true,
    filePath: normalizedPath,
    fileName: path.basename(normalizedPath),
    content: fs.readFileSync(normalizedPath, 'utf8')
  };
}

function getBackupFileInfo(filePath) {
  const normalizedPath = normalizeBackupFilePath(filePath);
  assertBackupPathAllowed(normalizedPath);

  return {
    success: true,
    exists: fs.existsSync(normalizedPath),
    filePath: normalizedPath,
    fileName: path.basename(normalizedPath)
  };
}

async function parseBackupImportFile(filePath) {
  const normalizedPath = normalizeBackupFilePath(filePath);
  assertBackupPathAllowed(normalizedPath);
  const fileName = path.basename(normalizedPath);
  const extension = path.extname(normalizedPath).toLowerCase();

  if (extension === '.zip') {
    const zipBuffer = fs.readFileSync(normalizedPath);
    const zip = await JSZip.loadAsync(zipBuffer);
    let dataFile = zip.file('data.json');
    if (!dataFile) {
      dataFile = zip.file('kumiko_backup.json');
      if (dataFile) {
        console.warn('[IMPORT] Legacy auto-backup filename kumiko_backup.json detected; please re-export after loading to migrate.');
      }
    }

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
  if (readConfigValue(USER_DATA_VALUE_NAME)) {
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
  const configuredPath = readConfigValue(USER_DATA_VALUE_NAME);
  const resolvedPath = path.resolve(configuredPath || defaultUserDataPath);
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
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

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
      
      // User location based on IP.
      // P2 #55: swapped the free ip-api.com endpoint (HTTP-only unless you pay)
      // for ipapi.co's HTTPS endpoint, so the user's IP-derived coordinates can
      // no longer be observed / modified by a man in the middle. If the HTTPS
      // call fails we simply don't surface a user-side weather block — we used
      // to silently drop it anyway when ip-api timed out.
      let userWeather = null;
      try {
        const ipResponse = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(5000) });
        const ipData = await ipResponse.json();
        const lat = ipData.latitude ?? ipData.lat;
        const lon = ipData.longitude ?? ipData.lon;
        if (typeof lat === 'number' && typeof lon === 'number') {
          const userWeatherResponse = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
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

  ipcMain.handle('app:get-historical-weather', async (_event, dateStr) => {
    try {
      if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return { success: false, error: 'Invalid date format' };
      }
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=34.8906&longitude=135.8016&start_date=${dateStr}&end_date=${dateStr}&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=Asia%2FTokyo`;
      const response = await fetch(url);
      const data = await response.json();
      if (data.daily && data.daily.weathercode && data.daily.weathercode.length > 0) {
        const weathercode = data.daily.weathercode[0];
        const tempMax = data.daily.temperature_2m_max?.[0];
        const tempMin = data.daily.temperature_2m_min?.[0];
        const mapCode = (code) => {
          if (code === 0) return '晴';
          if (code === 1 || code === 2 || code === 3) return '多云';
          if (code >= 45 && code <= 48) return '雾';
          if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return '雨';
          if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return '雪';
          if (code >= 95) return '雷雨';
          return '';
        };
        const cond = typeof weathercode === 'number' ? mapCode(weathercode) : '';
        const tempStr = (tempMax != null && tempMin != null) ? `, ${tempMin}~${tempMax}°C` : '';
        return {
          success: true,
          weather: `${cond}${tempStr}`,
          weathercode,
          conditionText: cond,
        };
      }
      return { success: false, error: 'No data for date' };
    } catch (e) {
      console.warn('[Weather] Historical weather fetch failed:', e.message);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('app:get-japan-holidays', async () => {
    try {
      const cachePath = path.join(app.getPath('userData'), 'holidays-cache.json');
      let cachedData = null;
      
      try {
        if (fs.existsSync(cachePath)) {
          const stat = fs.statSync(cachePath);
          const now = new Date().getTime();
          // Cache for 24 hours
          if (now - stat.mtimeMs < 24 * 60 * 60 * 1000) {
            cachedData = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
          }
        }
      } catch (e) {
        console.warn('[Holidays] Failed to read cache:', e);
      }

      if (cachedData) {
        return { success: true, holidays: cachedData };
      }

      const response = await fetch('https://holidays-jp.github.io/api/v1/date.json');
      const data = await response.json();
      
      try {
        fs.writeFileSync(cachePath, JSON.stringify(data), 'utf-8');
      } catch (e) {
        console.warn('[Holidays] Failed to write cache:', e);
      }

      return { success: true, holidays: data };
    } catch (e) {
      console.error('[Holidays] Failed to fetch holiday data:', e);
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
    return scheduleUserDataMigration(defaultUserDataPath);
  });

  // ── Voice file IPC ──────────────────────────────────────────────

  // Safe ID pattern for voice/ringtone message IDs — prevents path traversal
  // via payloads like "../../../../Windows/System32/evil". All voice: handlers
  // must run the caller-supplied messageId through this.
  const SAFE_VOICE_ID = /^[a-zA-Z0-9_-]{1,80}$/;

  function getVoiceDir() {
    const dir = path.join(app.getPath('userData'), 'voice');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // Resolve a voice file path and guarantee it still lives inside the voice dir
  // after normalization. Throws on any unsafe input.
  function resolveVoicePath(messageId) {
    if (typeof messageId !== 'string' || !SAFE_VOICE_ID.test(messageId)) {
      throw new Error('Invalid voice messageId');
    }
    const voiceDir = path.resolve(getVoiceDir());
    const full = path.resolve(path.join(voiceDir, `${messageId}.mp3`));
    if (full !== path.join(voiceDir, `${messageId}.mp3`) || !full.startsWith(voiceDir + path.sep)) {
      throw new Error('Voice path escaped voice directory');
    }
    return full;
  }

function getRingtoneDir() {
  const dir = path.join(app.getPath('userData'), 'ringtone');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getRingtoneMetadataPath(dir) {
  return path.join(dir, 'custom.meta.json');
}

function clearRingtoneMetadata(dir) {
  const metadataPath = getRingtoneMetadataPath(dir);
  if (fs.existsSync(metadataPath)) {
    fs.unlinkSync(metadataPath);
  }
}

function readRingtoneMetadata(dir) {
  try {
    const metadataPath = getRingtoneMetadataPath(dir);
    if (!fs.existsSync(metadataPath)) return null;
    const raw = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const originalName = typeof raw.originalName === 'string' ? raw.originalName.trim() : '';
    return originalName ? { originalName } : null;
  } catch {
    return null;
  }
}

function writeRingtoneMetadata(dir, originalName) {
  const normalizedName = typeof originalName === 'string' ? path.basename(originalName.trim()) : '';
  if (!normalizedName) {
    clearRingtoneMetadata(dir);
    return;
  }

  fs.writeFileSync(
    getRingtoneMetadataPath(dir),
    JSON.stringify({ originalName: normalizedName }, null, 2),
    'utf8'
  );
}

  function listCustomRingtoneFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((fileName) => {
      if (!fileName.startsWith('custom.')) return false;
      const hasValidAudioExtension = RINGTONE_AUDIO_EXTENSIONS.has(path.extname(fileName).toLowerCase());
      if (!hasValidAudioExtension) {
        try {
          fs.unlinkSync(path.join(dir, fileName));
        } catch {
          // Ignore stale invalid ringtone files that cannot be removed right now.
        }
      }
      return hasValidAudioExtension;
    });
  }

  // ── Image file IPC (P1 #36) ─────────────────────────────────────
  // Images now live as real files under userData/images/{id}.{ext} instead of
  // being stored as base64 strings inside Dexie. Renderer side still holds only
  // the ID + caption; bytes are loaded on demand by the UI (<img> via the
  // kumiko-image:// protocol registered below) or by the model (view_historical_image
  // tool, which calls images:load).

  const SAFE_IMAGE_ID = /^[a-zA-Z0-9_-]{1,80}$/;
  const IMAGE_EXT_WHITELIST = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);

  function getImagesDir() {
    const dir = path.join(app.getPath('userData'), 'images');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function resolveImagePath(imageId, ext) {
    if (typeof imageId !== 'string' || !SAFE_IMAGE_ID.test(imageId)) {
      throw new Error('Invalid image id');
    }
    const safeExt = typeof ext === 'string' && IMAGE_EXT_WHITELIST.has(ext.toLowerCase())
      ? ext.toLowerCase()
      : 'jpg';
    const dir = path.resolve(getImagesDir());
    const full = path.resolve(path.join(dir, `${imageId}.${safeExt}`));
    if (full !== path.join(dir, `${imageId}.${safeExt}`) || !full.startsWith(dir + path.sep)) {
      throw new Error('Image path escaped images directory');
    }
    return full;
  }

  function findImageFile(imageId) {
    if (typeof imageId !== 'string' || !SAFE_IMAGE_ID.test(imageId)) return null;
    const dir = getImagesDir();
    for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'gif']) {
      const candidate = path.join(dir, `${imageId}.${ext}`);
      if (fs.existsSync(candidate)) {
        const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        return { path: candidate, ext, mimeType };
      }
    }
    return null;
  }

  ipcMain.handle('images:save', (_event, payload = {}) => {
    try {
      const { imageId, ext, buffer } = payload;
      if (!imageId || !buffer) return { success: false, error: 'Missing params' };
      const filePath = resolveImagePath(imageId, ext);
      fs.writeFileSync(filePath, Buffer.from(buffer));
      return { success: true, filePath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('images:load', (_event, payload = {}) => {
    try {
      const found = findImageFile(payload.imageId);
      if (!found) return { success: false, error: 'Not found' };
      const buffer = fs.readFileSync(found.path);
      return { success: true, buffer, mimeType: found.mimeType, ext: found.ext };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('images:delete', (_event, payload = {}) => {
    try {
      const found = findImageFile(payload.imageId);
      if (found) { try { fs.unlinkSync(found.path); } catch {} }
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('images:list', () => {
    try {
      const dir = getImagesDir();
      const entries = fs.readdirSync(dir).filter(f => /^[\w-]+\.(jpg|jpeg|png|webp|gif)$/i.test(f));
      const files = entries.map(f => {
        const stat = fs.statSync(path.join(dir, f));
        const id = f.replace(/\.(jpg|jpeg|png|webp|gif)$/i, '');
        return { id, size: stat.size, mtime: stat.mtimeMs };
      });
      return { success: true, files };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Mirror voice:open-folder. `getImagesDir()` will lazily mkdir-p on first call,
  // so this IPC is still safe to invoke before the user has ever sent an image.
  ipcMain.handle('images:open-folder', () => {
    try {
      shell.openPath(getImagesDir());
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Aggregate the userData/images/ footprint for display (count + total bytes).
  // Same contract as voice:get-storage-info.
  ipcMain.handle('images:get-storage-info', () => {
    try {
      const dir = getImagesDir();
      const entries = fs.readdirSync(dir).filter(f => /^[\w-]+\.(jpg|jpeg|png|webp|gif)$/i.test(f));
      let totalBytes = 0;
      for (const f of entries) {
        try { totalBytes += fs.statSync(path.join(dir, f)).size; } catch {}
      }
      return { success: true, count: entries.length, totalBytes };
    } catch (e) {
      return { success: true, count: 0, totalBytes: 0 };
    }
  });

  ipcMain.handle('voice:save', (_event, payload = {}) => {
    try {
      const { messageId, buffer } = payload;
      if (!messageId || !buffer) return { success: false, error: 'Missing params' };
      const filePath = resolveVoicePath(messageId);
      fs.writeFileSync(filePath, Buffer.from(buffer));
      return { success: true, filePath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('voice:load', (_event, payload = {}) => {
    try {
      const filePath = resolveVoicePath(payload.messageId);
      if (!fs.existsSync(filePath)) return { success: false, error: 'Not found' };
      const buffer = fs.readFileSync(filePath);
      return { success: true, buffer };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('voice:delete', (_event, payload = {}) => {
    try {
      const filePath = resolveVoicePath(payload.messageId);
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
      const { buffer, ext, originalName } = payload;
      if (!buffer || !ext) return { success: false, error: 'Missing params' };
      const normalizedExt = `.${String(ext).replace(/^\./, '').toLowerCase()}`;
      if (!RINGTONE_AUDIO_EXTENSIONS.has(normalizedExt)) {
        return { success: false, error: 'Unsupported ringtone format' };
      }
      const dir = getRingtoneDir();
      const existing = listCustomRingtoneFiles(dir);
      for (const f of existing) fs.unlinkSync(path.join(dir, f));
      clearRingtoneMetadata(dir);
      const filePath = path.join(dir, `custom${normalizedExt}`);
      fs.writeFileSync(filePath, Buffer.from(buffer));
      writeRingtoneMetadata(dir, originalName);
      return { success: true, filePath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('ringtone:load', () => {
    try {
      const dir = getRingtoneDir();
      const entries = listCustomRingtoneFiles(dir);
      if (entries.length === 0) return { success: false };
      const filePath = path.join(dir, entries[0]);
      const buffer = fs.readFileSync(filePath);
      const metadata = readRingtoneMetadata(dir);
      return {
        success: true,
        buffer,
        fileName: entries[0],
        displayName: metadata?.originalName || entries[0],
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('ringtone:delete', () => {
    try {
      const dir = getRingtoneDir();
      const entries = listCustomRingtoneFiles(dir);
      for (const f of entries) fs.unlinkSync(path.join(dir, f));
      clearRingtoneMetadata(dir);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('ringtone:get-info', () => {
    try {
      const dir = getRingtoneDir();
      if (!fs.existsSync(dir)) return { exists: false, fileName: null, size: 0 };
      const entries = listCustomRingtoneFiles(dir);
      if (entries.length === 0) return { exists: false, fileName: null, size: 0 };
      const file = entries[0];
      const size = fs.statSync(path.join(dir, file)).size;
      const metadata = readRingtoneMetadata(dir);
      return {
        exists: true,
        fileName: file,
        displayName: metadata?.originalName || file,
        size,
      };
    } catch (e) {
      return { exists: false, fileName: null, size: 0 };
    }
  });

  ipcMain.handle('ringtone:open-folder', () => {
    try {
      const dir = getRingtoneDir();
      listCustomRingtoneFiles(dir);
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
    // Restore persisted backup path authorization (paths the user previously picked
    // via native dialog). Must happen before any backup:* IPC is serviced so that
    // auto-save from a pre-existing connection survives restart.
    loadAuthorizedBackupPaths();
    loadAuthorizedSovitsDirs();
    loadAuthorizedSovitsPythons();

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

    // User-driven native directory picker. This is the ONLY code path that may add a new
    // sovits directory to authorizedSovitsDirs. The dialog requires a human at the keyboard
    // to confirm the selection, and the fingerprint check ensures the picked directory is
    // really a GPT-SoVITS install. Persisted so the authorization survives app restarts.
    ipcMain.handle('genie:pick-sovits-dir', async () => {
      try {
        const result = await dialog.showOpenDialog(mainWindow || undefined, {
          title: 'Select GPT-SoVITS installation directory',
          properties: ['openDirectory'],
          defaultPath: app.getPath('home'),
        });
        if (result.canceled || !result.filePaths[0]) {
          return { success: false, canceled: true };
        }
        const resolved = path.resolve(result.filePaths[0]);
        if (!isValidSovitsDir(resolved)) {
          return { success: false, error: getSovitsDirFingerprintError() };
        }
        authorizeSovitsDir(resolved);
        return { success: true, path: resolved };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // Linux/macOS BYO-Python flow: user picks their own python3 interpreter (conda
    // env / system python / venv). We persist authorization the same way as the
    // sovits install directory, so the approval survives restarts. On Windows this
    // IPC is still wired up (the bundled runtime/python.exe remains the default),
    // but the Settings UI only surfaces it for Linux users.
    ipcMain.handle('genie:pick-sovits-python', async () => {
      try {
        const result = await dialog.showOpenDialog(mainWindow || undefined, {
          title: IS_LINUX
            ? 'Select the Python interpreter for GPT-SoVITS (e.g. ~/miniconda3/envs/GPTSoVits/bin/python)'
            : 'Select a Python executable for GPT-SoVITS',
          properties: ['openFile'],
          defaultPath: IS_LINUX ? '/usr/bin' : app.getPath('home'),
        });
        if (result.canceled || !result.filePaths[0]) {
          return { success: false, canceled: true };
        }
        const resolved = path.resolve(result.filePaths[0]);
        if (!isValidSovitsPython(resolved)) {
          return {
            success: false,
            error: IS_WINDOWS
              ? 'The selected file is not a valid Python executable.'
              : 'The selected file is not a valid executable Python interpreter. Check that the file exists and has the executable bit set.'
          };
        }
        authorizeSovitsPython(resolved);
        return { success: true, path: resolved };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // Smoke-test an authorized python interpreter by spawning `python --version`.
    // Surfaces the first line of stdout/stderr back to the renderer so the user can
    // confirm they picked the interpreter they thought they did (e.g. the env with
    // torch / transformers installed, not system python3.12 that lacks SoVITS deps).
    ipcMain.handle('genie:test-sovits-python', async (_event, payload = {}) => {
      try {
        const { pythonPath } = payload || {};
        if (!pythonPath || typeof pythonPath !== 'string') {
          return { success: false, error: 'No python interpreter path provided.' };
        }
        const resolved = path.resolve(pythonPath);
        if (!authorizedSovitsPythons.has(resolved)) {
          return { success: false, error: 'This Python interpreter has not been authorized. Please pick it via the Browse dialog first.' };
        }
        if (!isValidSovitsPython(resolved)) {
          return { success: false, error: 'Python interpreter is missing or not executable at this path.' };
        }
        return await new Promise((resolveOuter) => {
          let stdout = '';
          let stderr = '';
          let settled = false;
          let proc;
          try {
            proc = spawn(resolved, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
          } catch (spawnErr) {
            resolveOuter({ success: false, error: spawnErr && spawnErr.message ? spawnErr.message : 'Failed to spawn python' });
            return;
          }
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { proc.kill('SIGKILL'); } catch { /* already dead */ }
            resolveOuter({ success: false, error: 'Timed out waiting for `python --version` output.' });
          }, 5000);
          proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
          proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
          proc.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolveOuter({ success: false, error: err && err.message ? err.message : 'Python process error' });
          });
          proc.on('exit', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            // Python 2 writes version to stderr, Python 3 writes to stdout — accept either.
            const version = ((stdout || stderr).trim().split(/\r?\n/)[0] || '').trim();
            if (code === 0 && version) {
              resolveOuter({ success: true, version });
            } else {
              resolveOuter({
                success: false,
                error: stderr.trim() || stdout.trim() || `python exited with code ${code}`
              });
            }
          });
        });
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('genie:start', async (_event, config) => {
      if (genieProcess) return { success: false, error: 'Already running' };
      try {
        const { sovitsDir: rawDir, port, gptWeights, vitsWeights, pythonInterpreter: rawPython } = config || {};
        if (!rawDir) return { success: false, error: 'GPT-SoVITS directory not configured' };
        const sovitsDir = path.resolve(rawDir);

        // SECURITY: require the user to have picked this exact directory via the native
        // dialog (genie:pick-sovits-dir) at least once. This blocks a renderer-side
        // attacker from redirecting spawn to an arbitrary attacker-controlled folder
        // whose runtime/python.exe has been swapped for malware.
        if (!authorizedSovitsDirs.has(sovitsDir)) {
          return {
            success: false,
            error: 'This GPT-SoVITS directory has not been authorized. Please click the "Browse" button and pick the install folder via the system dialog.'
          };
        }
        // Re-verify fingerprint at spawn time in case the directory got swapped out
        // after authorization.
        if (!isValidSovitsDir(sovitsDir)) {
          return {
            success: false,
            error: IS_WINDOWS
              ? 'The authorized GPT-SoVITS directory is no longer valid (missing runtime/python.exe, api_v2.py, or GPT_SoVITS/configs/tts_infer.yaml).'
              : 'The authorized GPT-SoVITS directory is no longer valid (missing api_v2.py or GPT_SoVITS/configs/tts_infer.yaml).'
          };
        }

        // Resolve weights paths and require them to live INSIDE the authorized sovitsDir
        // (i.e. files supplied by the SoVITS install itself or a subfolder the user has
        // populated there). This stops a renderer from passing paths to files outside the
        // install, which HTTP /set_*_weights would then load.
        function resolveInsideSovits(p) {
          if (!p) return null;
          // SoVITS accepts both absolute paths and paths relative to its own cwd; resolve
          // relative to sovitsDir so both shapes end up anchored there.
          const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(sovitsDir, p);
          if (abs !== sovitsDir && !abs.startsWith(sovitsDir + path.sep)) return null;
          return abs;
        }
        const resolvedGptWeights = gptWeights ? resolveInsideSovits(gptWeights) : null;
        if (gptWeights && !resolvedGptWeights) {
          return { success: false, error: 'gptWeights must be a path inside the authorized GPT-SoVITS directory.' };
        }
        const resolvedVitsWeights = vitsWeights ? resolveInsideSovits(vitsWeights) : null;
        if (vitsWeights && !resolvedVitsWeights) {
          return { success: false, error: 'vitsWeights must be a path inside the authorized GPT-SoVITS directory.' };
        }

        const apiScript = path.join(sovitsDir, 'api_v2.py');
        const configYaml = path.join(sovitsDir, 'GPT_SoVITS', 'configs', 'tts_infer.yaml');
        const serverPort = port || 9880;

        if (IS_WINDOWS) {
          // Windows path: use the bundled runtime/python.exe launched through a temp
          // .bat wrapper so the user gets a visible console window showing model load
          // progress (SoVITS prints to stdout and this is the simplest way to keep
          // the existing UX). Closing the console window is a user-understood "stop".
          const pythonExe = path.join(sovitsDir, 'runtime', 'python.exe');
          const batPath = path.join(app.getPath('temp'), 'kumiko-sovits-server.bat');
          fs.writeFileSync(batPath, [
            '@echo off',
            'title GPT-SoVITS Server [Kumiko Amadeus]',
            `"${pythonExe}" -u "${apiScript}" -a 127.0.0.1 -p ${serverPort} -c "${configYaml}"`,
          ].join('\r\n'));

          genieProcess = spawn('cmd.exe', ['/c', batPath], {
            cwd: sovitsDir,
            detached: true,
            windowsHide: false,
            stdio: 'ignore',
            env: { ...process.env, PATH: path.join(sovitsDir, 'runtime') + path.delimiter + (process.env.PATH || '') },
          });
        } else if (IS_LINUX) {
          // Linux BYO Python path: no bundled runtime, no .bat wrapper. Spawn the
          // user-supplied python interpreter directly. detached:true + a separate
          // session lets us later kill the whole process group (python plus any
          // child torch workers) via a negative PID SIGTERM/SIGKILL in terminateGenieProcess.
          if (!rawPython) {
            return {
              success: false,
              error: 'Python interpreter path not configured. Pick one via Settings → TTS → GPT-SoVITS → Browse (Python).'
            };
          }
          const pythonExe = path.resolve(rawPython);
          if (!authorizedSovitsPythons.has(pythonExe)) {
            return {
              success: false,
              error: 'Python interpreter has not been authorized. Please re-pick it via the Browse dialog.'
            };
          }
          if (!isValidSovitsPython(pythonExe)) {
            return { success: false, error: 'Python interpreter is missing or not executable at the configured path.' };
          }

          genieProcess = spawn(
            pythonExe,
            ['-u', apiScript, '-a', '127.0.0.1', '-p', String(serverPort), '-c', configYaml],
            {
              cwd: sovitsDir,
              detached: true,
              stdio: 'ignore',
              env: {
                ...process.env,
                PATH: [path.join(sovitsDir, 'runtime'), process.env.PATH || ''].filter(Boolean).join(path.delimiter),
              },
            }
          );
        } else {
          return { success: false, error: `GPT-SoVITS is not supported on platform "${process.platform}".` };
        }

        genieProcess.on('exit', (code) => {
          genieProcess = null;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('genie:status-changed', { running: false, code });
          }
        });
        genieProcess.on('error', (err) => {
          console.error('[GPT-SoVITS] Process error:', err.message);
          genieProcess = null;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('genie:status-changed', { running: false, error: err.message });
          }
        });
        for (let i = 0; i < 180; i++) {
          await new Promise(r => setTimeout(r, 1000));
          if (!genieProcess) return { success: false, error: 'Process exited during startup' };
          try {
            const res = await fetch(`http://127.0.0.1:${serverPort}/tts`, { method: 'GET', signal: AbortSignal.timeout(2000) });
            if (res.status) {
              if (resolvedGptWeights) {
                try { await fetch(`http://127.0.0.1:${serverPort}/set_gpt_weights?weights_path=${encodeURIComponent(resolvedGptWeights)}`); } catch {}
              }
              if (resolvedVitsWeights) {
                try { await fetch(`http://127.0.0.1:${serverPort}/set_sovits_weights?weights_path=${encodeURIComponent(resolvedVitsWeights)}`); } catch {}
              }
              return { success: true, pid: genieProcess.pid };
            }
          } catch {}
        }
        if (genieProcess) {
          return { success: true, pid: genieProcess.pid };
        }
        return { success: false, error: 'Server startup timeout' };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('genie:stop', () => {
      terminateGenieProcess();
      return { success: true };
    });

    ipcMain.handle('genie:status', () => ({
      running: genieProcess !== null,
      pid: genieProcess?.pid || null,
    }));

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', (event) => {
    if (isAutoBackupDone || isInstallingUpdate) return;
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
