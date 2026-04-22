// electron/logService.cjs
//
// File-based logging for the Electron main process. The renderer already
// gets console output piped through DevTools, but the main process writes
// to stdout/stderr which vanishes the moment autoUpdater.quitAndInstall()
// takes down the app — making post-mortem diagnosis of install failures
// impossible.
//
// This module wraps console.log/info/warn/error so every call also
// appends a timestamped line to
//   <userData>/logs/main-YYYY-MM-DD.log
// Files roll over at midnight (on next write) and are pruned at install()
// time + whenReady if older than KEEP_DAYS. A single file is also rotated
// mid-day when it exceeds MAX_FILE_BYTES so a runaway log loop can't fill
// the disk.
//
// Designed to be installed as the very first require in electron-main.cjs
// so that even early-boot console calls (migrateRegistryToConfigStoreOnce,
// processPendingUserDataMigration, promoteDefaultUserDataPath, etc.) land
// in the file. userData path is resolved lazily on first write so we do
// not need to wait for whenReady — Electron exposes getPath('userData')
// before the ready event, returning the (possibly-default) path. This is
// fine because the log file is only written on each console call, which
// in practice starts happening after the userData override in the main
// file has already run.
//
// The module is intentionally dependency-free (fs/path/electron only) so
// it cannot itself break early boot.

'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const LOG_DIR_NAME = 'logs';
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB per daily file before rotate
const KEEP_DAYS = 7;

let installed = false;
let writeStream = null;
let currentDay = '';
let currentDir = '';

// Resolved every call: userData path can change between install-time and
// first write (electron-main.cjs applies the migrated/custom userData path
// AFTER logService.install() to ensure even migration logs are captured).
// getPath is cheap; no need to memoize.
function resolveLogDir() {
  try {
    return path.join(app.getPath('userData'), LOG_DIR_NAME);
  } catch (_e) {
    return null;
  }
}

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function rotateIfOversized(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(filePath, filePath.replace(/\.log$/, `.${ts}.log`));
    }
  } catch (_e) {
    // File may not exist yet; ignore.
  }
}

function openStream(dir, key) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_e) {
    return null;
  }
  const filePath = path.join(dir, `main-${key}.log`);
  rotateIfOversized(filePath);
  try {
    const stream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
    currentDay = key;
    currentDir = dir;
    return stream;
  } catch (_e) {
    return null;
  }
}

function getStream() {
  const dir = resolveLogDir();
  if (!dir) return null;
  const key = todayKey();
  // Rotate if day changed OR userData path moved (happens once during boot
  // when applyConfiguredUserDataPath runs after install()).
  if (writeStream && (currentDay !== key || currentDir !== dir)) {
    try { writeStream.end(); } catch (_e) { /* ignore */ }
    writeStream = null;
  }
  if (!writeStream) {
    writeStream = openStream(dir, key);
  }
  return writeStream;
}

function formatArg(a) {
  if (a instanceof Error) {
    return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ''}`;
  }
  if (typeof a === 'object' && a !== null) {
    try { return JSON.stringify(a); } catch (_e) { return String(a); }
  }
  return String(a);
}

function formatLine(level, args) {
  const ts = new Date().toISOString();
  const msg = Array.from(args).map(formatArg).join(' ');
  return `${ts} [${level}] ${msg}\n`;
}

function writeLine(level, args) {
  try {
    const s = getStream();
    if (s) s.write(formatLine(level, args));
  } catch (_e) {
    // Never let a failed log append break the caller.
  }
}

function pruneOld() {
  const dir = resolveLogDir();
  if (!dir) return;
  try {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(dir)) {
      if (!/^main-.*\.log$/i.test(entry)) continue;
      const full = path.join(dir, entry);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(full);
        }
      } catch (_e) { /* skip */ }
    }
  } catch (_e) { /* dir may not exist yet */ }
}

function install() {
  if (installed) return;
  installed = true;

  const origLog = console.log.bind(console);
  const origInfo = console.info.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = function patchedLog(...args) { writeLine('LOG', args); origLog(...args); };
  console.info = function patchedInfo(...args) { writeLine('INFO', args); origInfo(...args); };
  console.warn = function patchedWarn(...args) { writeLine('WARN', args); origWarn(...args); };
  console.error = function patchedError(...args) { writeLine('ERROR', args); origError(...args); };

  process.on('uncaughtException', (err) => {
    writeLine('FATAL', [`uncaughtException: ${err && err.stack || err}`]);
  });
  process.on('unhandledRejection', (reason) => {
    writeLine('FATAL', [`unhandledRejection: ${reason && (reason.stack || reason.message) || reason}`]);
  });

  pruneOld();
  try {
    app.whenReady().then(() => {
      pruneOld();
    }).catch(() => { /* ignore */ });
  } catch (_e) { /* electron not ready yet — that's ok */ }

  try {
    const version = typeof app.getVersion === 'function' ? app.getVersion() : 'unknown';
    writeLine('LOG', [`[LOG SERVICE] installed pid=${process.pid} version=${version} platform=${process.platform}`]);
  } catch (_e) { /* noop */ }
}

function getLogDir() {
  return resolveLogDir();
}

module.exports = {
  install,
  getLogDir,
};
