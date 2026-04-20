// electron/user-config.cjs
//
// Cross-platform key/value persistence for the main process.
//
// Historically (Windows-only) this project stored UserDataPath / pending
// migration markers / AutoZipBackupEnabled in HKCU via PowerShell. Linux has
// no equivalent registry, so we now persist the same keys to a JSON file
// alongside the legacy default userData directory. Windows still works
// identically from the caller's perspective — on first launch of a
// configStore-aware build we one-shot copy any legacy registry values into
// the JSON so existing users don't lose their settings.
//
// We intentionally anchor the config file at the Electron default userData
// directory (computed lazily here via app.getPath('userData')), NOT at any
// redirected path: userData may itself be redirected to a different drive
// via UserDataPath, and we need to read UserDataPath *before* that redirect
// is applied. Anchoring here keeps the config file's own location stable
// and avoids a chicken-and-egg lookup.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { app } = require('electron');

const IS_WINDOWS = process.platform === 'win32';

// The legacy (pre-UserDataPath-override) userData directory. This is where
// the config JSON lives regardless of any later userData redirect, so that
// the redirect marker itself is always read back from the same spot.
const legacyDefaultUserDataPath = path.resolve(app.getPath('userData'));

// Windows-only PowerShell/registry constants. On Linux these are never
// invoked because configStore short-circuits to JSON — see readConfigValue.
const POWERSHELL_PATH = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const USER_DATA_REGISTRY_KEY = 'HKCU:\\Software\\KumikoAIAmadeus';

// Public config key names. Exported so callers in electron-main.cjs can
// readConfigValue(USER_DATA_VALUE_NAME) without duplicating the string.
const USER_DATA_VALUE_NAME = 'UserDataPath';
const PENDING_SOURCE_VALUE_NAME = 'PendingMigrationSource';
const PENDING_TARGET_VALUE_NAME = 'PendingMigrationTarget';

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
        `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; (Get-ItemProperty -Path '${USER_DATA_REGISTRY_KEY.replace(/'/g, "''")}' -Name '${valueName.replace(/'/g, "''")}').${valueName}`,
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    const value = output.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

// eslint-disable-next-line no-unused-vars
function writeRegistryValue(valueName, value) {
  execFileSync(
    POWERSHELL_PATH,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference='Stop'; if (-not (Test-Path '${USER_DATA_REGISTRY_KEY.replace(/'/g, "''")}')) { New-Item -Path '${USER_DATA_REGISTRY_KEY.replace(/'/g, "''")}' -Force | Out-Null }; New-ItemProperty -Path '${USER_DATA_REGISTRY_KEY.replace(/'/g, "''")}' -Name '${valueName.replace(/'/g, "''")}' -Value '${value.replace(/'/g, "''")}' -PropertyType String -Force | Out-Null`,
    ],
    {
      windowsHide: true,
    },
  );
}

// eslint-disable-next-line no-unused-vars
function deleteRegistryValue(valueName) {
  try {
    execFileSync(
      POWERSHELL_PATH,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference='SilentlyContinue'; if (Test-Path '${USER_DATA_REGISTRY_KEY.replace(/'/g, "''")}') { Remove-ItemProperty -Path '${USER_DATA_REGISTRY_KEY.replace(/'/g, "''")}' -Name '${valueName.replace(/'/g, "''")}' -ErrorAction SilentlyContinue }`,
      ],
      {
        windowsHide: true,
      },
    );
  } catch {
    // Ignore missing registry values.
  }
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

module.exports = {
  readConfigValue,
  writeConfigValue,
  deleteConfigValue,
  migrateRegistryToConfigStoreOnce,
  USER_DATA_VALUE_NAME,
  PENDING_SOURCE_VALUE_NAME,
  PENDING_TARGET_VALUE_NAME,
};
