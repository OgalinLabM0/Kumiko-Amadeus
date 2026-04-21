// electron/mobile-fs.cjs
//
// Phase 6 Part C: sandboxed filesystem API for the mobile remote file browser.
//
// The mobile PWA has no File System Access API on iOS Safari and we deliberately
// don't want a second copy of the user's data to live on each phone. Instead
// the phone renders a dedicated file browser (components/MobileRemoteFileBrowser.tsx)
// and every listing/read/write it performs is proxied to this module via the
// Fastify HTTP bridge.
//
// Every path is canonicalized through `resolveSafe()` before touching the disk.
// If the resolved absolute path isn't inside `mobileBrowseRoot` we reject the
// call with `E_OUT_OF_ROOT`. The root itself comes from either an explicit
// user override (stored via user-config.cjs under `mobile-browse-root`) or a
// computed default:
//
//   default = dirname(app.getPath('userData'))
//     …unless that parent is in our "unsafe public directory" list
//     (AppData\Roaming, ~/.config, ~/Library/Application Support, …)
//     in which case we fall back to `userData` itself.
//
// This balances:
//   - Portable/dev setups where users expect to browse siblings of Kumiko AI Data
//     (e.g. `D:\work\测试-03-23\Kumiko Amadeus\` next to `D:\work\测试-03-23\Kumiko AI Data\`
//     — the natural root is the parent `D:\work\测试-03-23\`).
//   - Standard installs where userData lives under AppData\Roaming and the
//     parent would otherwise expose every Electron-app user data on the system.
//
// The override is writable only from the desktop renderer's
// SettingsPanel > MobileBrowseRootSection. The corresponding channel
// `fs:set-mobile-browse-root` is intentionally NOT in
// electron/server/ipc-bridge.cjs's ALLOWED_CHANNELS, so mobile PWAs cannot
// enlarge their own sandbox over HTTP — only a human at the PC keyboard can.

'use strict';

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const os = require('os');
const { app, dialog } = require('electron');
const { readConfigValue, writeConfigValue, deleteConfigValue } = require('./user-config.cjs');

const ROOT_OVERRIDE_KEY = 'MobileBrowseRoot';

// ── Broadcast hook ───────────────────────────────────────────────
//
// When the PC renderer (or a phone) registers a new backup target via
// `backup:set-desktop-backup-path`, we fan the new path out to every
// connected phone via the ws-broadcast layer so their UI stays in sync.
// Require is intentionally lazy so unit tests that don't load the full
// Fastify stack can still import this module.
function broadcast(event) {
  try {
    const wsBroadcast = require('./server/ws-broadcast.cjs');
    if (wsBroadcast && typeof wsBroadcast.broadcast === 'function') {
      wsBroadcast.broadcast(event);
    }
  } catch (e) {
    console.warn('[mobile-fs] broadcast failed:', e && e.message);
  }
}

// ── Root computation ─────────────────────────────────────────────

function getBlockedDefaultParents() {
  // Lowercase set of "too broad" public OS directories. If computeDefaultMobileBrowseRoot()
  // lands on one of these we refuse to promote and fall back to userData itself.
  const homedir = os.homedir();
  const blocked = [];
  if (process.platform === 'win32') {
    blocked.push(path.join(homedir, 'AppData', 'Roaming'));
    blocked.push(path.join(homedir, 'AppData', 'Local'));
    blocked.push(path.join(homedir, 'AppData'));
  }
  if (process.platform === 'linux') {
    blocked.push(path.join(homedir, '.config'));
    blocked.push(path.join(homedir, '.local', 'share'));
    blocked.push(path.join(homedir, '.local'));
  }
  if (process.platform === 'darwin') {
    blocked.push(path.join(homedir, 'Library', 'Application Support'));
    blocked.push(path.join(homedir, 'Library'));
  }
  blocked.push(homedir);
  return blocked.map(p => path.resolve(p).toLowerCase());
}

function computeDefaultMobileBrowseRoot() {
  const userData = path.resolve(app.getPath('userData'));
  const parent = path.resolve(path.dirname(userData));
  const blocked = getBlockedDefaultParents();
  const parentLower = parent.toLowerCase();
  const isBlocked = blocked.includes(parentLower);
  return isBlocked ? userData : parent;
}

// ── Override persistence ─────────────────────────────────────────

function getOverride() {
  try {
    const raw = readConfigValue(ROOT_OVERRIDE_KEY);
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;
    const resolved = path.resolve(raw);
    if (!fs.existsSync(resolved)) return null;
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return null;
    return resolved;
  } catch (e) {
    console.warn('[mobile-fs] getOverride failed:', e && e.message);
    return null;
  }
}

function setOverride(value) {
  if (value == null || value === '') {
    deleteConfigValue(ROOT_OVERRIDE_KEY);
    return;
  }
  const resolved = path.resolve(String(value));
  if (!fs.existsSync(resolved)) {
    const err = new Error(`Path does not exist: ${resolved}`);
    err.code = 'E_NOENT';
    throw err;
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    const err = new Error(`Not a directory: ${resolved}`);
    err.code = 'E_NOT_DIR';
    throw err;
  }
  writeConfigValue(ROOT_OVERRIDE_KEY, resolved);
}

function getMobileBrowseRoot() {
  return getOverride() || computeDefaultMobileBrowseRoot();
}

// ── Path traversal protection ───────────────────────────────────

function normalizeForCompare(p) {
  // Windows is case-insensitive; Linux / mac are not. Compare lowercased
  // on win32 only so sibling directories that differ only in case on
  // Linux aren't treated as the same target.
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function isInsideRoot(target, root) {
  const tn = normalizeForCompare(path.resolve(target));
  const rn = normalizeForCompare(path.resolve(root));
  if (tn === rn) return true;
  const rel = path.relative(rn, tn);
  if (!rel || rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

function resolveSafe(rawPath) {
  const root = getMobileBrowseRoot();
  const rootReal = path.resolve(root);
  let target;
  if (!rawPath || rawPath === '' || rawPath === '/' || rawPath === '\\') {
    target = rootReal;
  } else if (path.isAbsolute(rawPath)) {
    target = path.resolve(rawPath);
  } else {
    target = path.resolve(rootReal, rawPath);
  }
  if (!isInsideRoot(target, rootReal)) {
    const err = new Error(`Path is outside mobileBrowseRoot: ${target}`);
    err.code = 'E_OUT_OF_ROOT';
    throw err;
  }
  return { root: rootReal, target };
}

// ── IPC handlers ────────────────────────────────────────────────

function handleGetMobileBrowseRoot() {
  const root = getMobileBrowseRoot();
  const defaultRoot = computeDefaultMobileBrowseRoot();
  const override = getOverride();
  return {
    ok: true,
    root,
    defaultRoot,
    isOverride: !!override,
    userData: path.resolve(app.getPath('userData')),
    appDir: path.resolve(app.getAppPath()),
  };
}

function handleSetMobileBrowseRoot(_event, payload) {
  const value = typeof payload === 'string'
    ? payload
    : (payload && typeof payload === 'object' ? payload.path : undefined);
  try {
    setOverride(value);
    return { ok: true, root: getMobileBrowseRoot() };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code || 'E_UNKNOWN' };
  }
}

async function handlePickMobileBrowseRoot() {
  const current = getMobileBrowseRoot();
  const result = await dialog.showOpenDialog({
    title: '选择手机可浏览的根目录',
    defaultPath: current,
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) {
    return { ok: false, canceled: true };
  }
  try {
    setOverride(result.filePaths[0]);
    return { ok: true, root: getMobileBrowseRoot() };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code || 'E_UNKNOWN' };
  }
}

async function handleListDirectory(_event, payload) {
  const rawPath = typeof payload === 'string' ? payload : (payload && payload.path);
  try {
    const { root, target } = resolveSafe(rawPath);
    let entries;
    try {
      entries = await fsPromises.readdir(target, { withFileTypes: true });
    } catch (e) {
      return { ok: false, error: e.message, code: e.code || 'E_READDIR' };
    }
    const items = [];
    for (const entry of entries) {
      const fullPath = path.join(target, entry.name);
      const isDir = entry.isDirectory();
      const isFile = entry.isFile();
      if (!isDir && !isFile) continue;
      let size = 0;
      let mtime = 0;
      try {
        const st = await fsPromises.stat(fullPath);
        size = st.size;
        mtime = st.mtimeMs;
      } catch { /* ignore unreadable entries */ }
      items.push({ name: entry.name, path: fullPath, isDirectory: isDir, isFile, size, mtime });
    }
    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const atRoot = normalizeForCompare(target) === normalizeForCompare(root);
    return {
      ok: true,
      root,
      path: target,
      items,
      parent: atRoot ? null : path.dirname(target),
      atRoot,
    };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code || 'E_UNKNOWN' };
  }
}

function handleGetShortcuts() {
  const root = getMobileBrowseRoot();
  const userData = path.resolve(app.getPath('userData'));
  const appDir = path.resolve(app.getAppPath());
  const shortcuts = [{ key: 'root', label: '根目录', path: root }];
  if (isInsideRoot(userData, root)) {
    shortcuts.push({ key: 'data', label: '数据目录', path: userData });
  }
  if (isInsideRoot(appDir, root)) {
    shortcuts.push({ key: 'app', label: '软件目录', path: appDir });
  }
  return { ok: true, shortcuts, root };
}

async function handleCheckPathExists(_event, payload) {
  const rawPath = typeof payload === 'string' ? payload : (payload && payload.path);
  try {
    const { target } = resolveSafe(rawPath);
    try {
      const st = await fsPromises.stat(target);
      return { ok: true, exists: true, isFile: st.isFile(), isDirectory: st.isDirectory(), path: target };
    } catch {
      return { ok: true, exists: false, path: target };
    }
  } catch (e) {
    return { ok: false, error: e.message, code: e.code || 'E_UNKNOWN' };
  }
}

async function handleReadDesktopFile(_event, payload) {
  const rawPath = typeof payload === 'string' ? payload : (payload && payload.path);
  try {
    const { target } = resolveSafe(rawPath);
    let buffer;
    try {
      buffer = await fsPromises.readFile(target);
    } catch (e) {
      return { ok: false, error: e.message, code: e.code || 'E_READ' };
    }
    return {
      ok: true,
      path: target,
      fileName: path.basename(target),
      // base64 keeps the HTTP JSON safe for larger backup files. Phones
      // decode via atob → Uint8Array before parsing.
      content: buffer.toString('base64'),
      size: buffer.byteLength,
    };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code || 'E_UNKNOWN' };
  }
}

async function handleWriteDesktopFile(_event, payload) {
  const rawPath = payload && payload.path;
  const contentB64 = payload && payload.contentB64;
  const contentText = payload && payload.contentText;
  try {
    const { target } = resolveSafe(rawPath);
    let buffer;
    if (typeof contentB64 === 'string' && contentB64.length > 0) {
      buffer = Buffer.from(contentB64, 'base64');
    } else if (typeof contentText === 'string') {
      buffer = Buffer.from(contentText, 'utf-8');
    } else {
      return { ok: false, error: 'Missing contentB64 or contentText', code: 'E_ARGS' };
    }
    try {
      await fsPromises.mkdir(path.dirname(target), { recursive: true });
      await fsPromises.writeFile(target, buffer);
    } catch (e) {
      return { ok: false, error: e.message, code: e.code || 'E_WRITE' };
    }
    return { ok: true, path: target, size: buffer.byteLength };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code || 'E_UNKNOWN' };
  }
}

// ── Backup target registration ──────────────────────────────────
//
// When a phone selects (or creates) a backup file via the remote browser,
// it calls `backup:set-desktop-backup-path` with the absolute `filePath`.
// We validate that it's inside the sandbox, remember it as the "current
// mobile backup target" (only used as a last-known-good hint for logs /
// diagnostics), and broadcast `backup:desktop-path-changed` to every
// connected phone so their UI sync their own connectedFileName.
//
// The PC renderer's `connectedFileName`/`fileHandleRef` is deliberately
// NOT mutated here — the desktop side owns its own Electron handle
// state and the two can coexist (each device holds its own connection;
// the broadcast merely echoes the basename so the user sees "saving to
// kumiko_backup.json" on every device for confidence).

let currentMobileBackupPath = null;

function handleSetDesktopBackupPath(_event, payload) {
  const rawPath = typeof payload === 'string' ? payload : (payload && payload.path);
  try {
    const { target } = resolveSafe(rawPath);
    currentMobileBackupPath = target;
    broadcast({
      type: 'backup:desktop-path-changed',
      filePath: target,
      fileName: path.basename(target),
    });
    return { ok: true, path: target, fileName: path.basename(target) };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code || 'E_UNKNOWN' };
  }
}

function handleDisconnectDesktopFile() {
  currentMobileBackupPath = null;
  broadcast({
    type: 'backup:desktop-path-changed',
    filePath: null,
    fileName: null,
  });
  return { ok: true };
}

function getCurrentMobileBackupPath() {
  return currentMobileBackupPath;
}

// ── Registration ────────────────────────────────────────────────

function register(ipcMain) {
  ipcMain.handle('fs:get-mobile-browse-root', handleGetMobileBrowseRoot);
  ipcMain.handle('fs:set-mobile-browse-root', handleSetMobileBrowseRoot);
  ipcMain.handle('fs:pick-mobile-browse-root', handlePickMobileBrowseRoot);
  ipcMain.handle('fs:list-directory', handleListDirectory);
  ipcMain.handle('fs:get-shortcuts', handleGetShortcuts);
  ipcMain.handle('fs:check-path-exists', handleCheckPathExists);
  ipcMain.handle('backup:read-desktop-file', handleReadDesktopFile);
  ipcMain.handle('backup:write-desktop-file', handleWriteDesktopFile);
  ipcMain.handle('backup:set-desktop-backup-path', handleSetDesktopBackupPath);
  ipcMain.handle('backup:disconnect-desktop-file', handleDisconnectDesktopFile);
}

module.exports = {
  register,
  computeDefaultMobileBrowseRoot,
  getMobileBrowseRoot,
  setOverride,
  resolveSafe,
  isInsideRoot,
  getCurrentMobileBackupPath,
};
