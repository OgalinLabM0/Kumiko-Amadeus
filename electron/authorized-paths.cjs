// electron/authorized-paths.cjs
//
// Authorization registries for three kinds of user-approved filesystem
// paths. All three share the same pattern:
//   1. A private Set<string> holding resolved, absolute paths.
//   2. A JSON file under userData/ for persistence across restarts.
//   3. A load*() to re-hydrate the Set on startup, a persist*() to flush
//      after every mutation, an authorize*() to add a new entry, and an
//      isValid*() (for SoVITS) to refuse obviously bogus input.
//
// Why these are authorization gates, not just caches:
//   - SoVITS directory: genie:start spawns processes out of this path. A
//     compromised renderer asking the main process to launch python.exe
//     from an attacker-controlled directory is a path-injection → RCE.
//     Only paths the user picked via native dialog AND that pass the
//     install fingerprint check can ever enter the Set.
//   - SoVITS python: Linux/macOS require the user to supply their own
//     python interpreter (see pick-sovits-python-executable-file). Same
//     RCE vector as above, closed the same way.
//   - Backup path: backup:read/write IPC touches files on the user's disk.
//     Paths outside userData must have been explicitly picked via native
//     dialog or we refuse to read/write them. This hardens against a
//     compromised renderer driving arbitrary-file I/O.
//
// All three Sets are intentionally module-private. Callers interact with
// them through the isValid/authorize/isAuthorized helpers below.

'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const IS_WINDOWS = process.platform === 'win32';

// ── SoVITS directory authorization ────────────────────────────────

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

function isAuthorizedSovitsDir(resolvedPath) {
  return typeof resolvedPath === 'string' && authorizedSovitsDirs.has(resolvedPath);
}

// ── SoVITS python interpreter authorization ───────────────────────
//
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

function isAuthorizedSovitsPython(resolvedPath) {
  return typeof resolvedPath === 'string' && authorizedSovitsPythons.has(resolvedPath);
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

// ── Backup path authorization ─────────────────────────────────────
//
// Backup path safety: maintain a set of filesystem paths that the user has explicitly
// approved through a native dialog (backup:pick-save-file / backup:pick-open-file), or
// that live inside the app's userData directory (our own data). Any backup:* IPC that
// actually touches disk must resolve its input against this set, blocking renderer-driven
// writes/reads to arbitrary paths (hardens against a XSS-style attacker who controls the
// renderer message bus). See assertBackupPathAllowed() in electron/backup-files.cjs.
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

function isBackupPathAuthorized(resolvedPath) {
  return typeof resolvedPath === 'string' && allowedBackupPaths.has(resolvedPath);
}

// ── Unified startup entry point ──────────────────────────────────
//
// Called once from app.whenReady() in electron-main.cjs. Replaces the three
// separate load*() calls so the main file's whenReady callback stays short.

function loadAllAuthorizedPaths() {
  loadAuthorizedBackupPaths();
  loadAuthorizedSovitsDirs();
  loadAuthorizedSovitsPythons();
}

module.exports = {
  loadAllAuthorizedPaths,
  isValidSovitsDir,
  getSovitsDirFingerprintError,
  authorizeSovitsDir,
  isAuthorizedSovitsDir,
  isValidSovitsPython,
  authorizeSovitsPython,
  isAuthorizedSovitsPython,
  authorizeBackupPath,
  isBackupPathAuthorized,
};
