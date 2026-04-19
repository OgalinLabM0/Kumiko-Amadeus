#!/usr/bin/env node
// Regression test for the Windows registry → kumiko-config.json migration
// path introduced alongside Linux AppImage support. The production
// implementation lives in electron-main.cjs (see migrateRegistryToConfigStoreOnce
// and the configStore helpers around it). Because electron-main.cjs can only
// run inside an Electron process, we reproduce the exact same algorithm here
// against a temp directory with a stub registry reader. If the real
// implementation changes, update this mirror; the production code and this
// test MUST stay behavior-equivalent.
//
// Run with: node scripts/test-config-migration.cjs
//
// Exits non-zero on any assertion failure.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_STORE_FILENAME = 'kumiko-config.json';
const CONFIG_STORE_MIGRATION_MARKER = '__migratedFromRegistry';
const USER_DATA_VALUE_NAME = 'UserDataPath';
const PENDING_SOURCE_VALUE_NAME = 'PendingMigrationSource';
const PENDING_TARGET_VALUE_NAME = 'PendingMigrationTarget';
const MIGRATABLE_REGISTRY_KEYS = [
  USER_DATA_VALUE_NAME,
  PENDING_SOURCE_VALUE_NAME,
  PENDING_TARGET_VALUE_NAME,
  'AutoZipBackupEnabled',
];

function makeHarness({ userDataRoot, registryStub, platform }) {
  const IS_WINDOWS = platform === 'win32';

  function getConfigStoreFilePath() {
    return path.join(userDataRoot, CONFIG_STORE_FILENAME);
  }

  function loadConfigStoreObject() {
    try {
      const file = getConfigStoreFilePath();
      if (!fs.existsSync(file)) return {};
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  function saveConfigStoreObject(nextStore) {
    const file = getConfigStoreFilePath();
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(nextStore, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  function readRegistryValue(valueName) {
    if (!IS_WINDOWS) return null;
    const v = registryStub[valueName];
    return (typeof v === 'string' && v) ? v : null;
  }

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
        // swallow exactly like production
      }
    }
    store[CONFIG_STORE_MIGRATION_MARKER] = new Date().toISOString();
    saveConfigStoreObject(store);
    return mutated;
  }

  return {
    getConfigStoreFilePath,
    loadConfigStoreObject,
    saveConfigStoreObject,
    readRegistryValue,
    migrateRegistryToConfigStoreOnce,
  };
}

function makeTempDir(tag) {
  const base = path.join(os.tmpdir(), `kumiko-config-migration-${tag}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok  ${label}`);
    return;
  }
  console.error(`  FAIL ${label}\n    expected: ${e}\n    actual:   ${a}`);
  process.exitCode = 1;
}

function assertTrue(cond, label) {
  if (cond) {
    console.log(`  ok  ${label}`);
    return;
  }
  console.error(`  FAIL ${label} (condition was falsy)`);
  process.exitCode = 1;
}

function runScenario(name, fn) {
  console.log(`\n[scenario] ${name}`);
  const dir = makeTempDir(name.replace(/\s+/g, '-'));
  try {
    fn(dir);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

// --------- Scenarios ---------

runScenario('fresh install, empty registry (Windows)', (dir) => {
  const h = makeHarness({ userDataRoot: dir, registryStub: {}, platform: 'win32' });
  h.migrateRegistryToConfigStoreOnce();
  const store = h.loadConfigStoreObject();
  assertTrue(!!store[CONFIG_STORE_MIGRATION_MARKER], 'migration marker written');
  for (const k of MIGRATABLE_REGISTRY_KEYS) {
    assertTrue(!(k in store), `no legacy key imported: ${k}`);
  }
});

runScenario('fresh install, legacy registry populated (Windows)', (dir) => {
  const legacy = {
    [USER_DATA_VALUE_NAME]: 'D:\\KumikoData',
    [PENDING_SOURCE_VALUE_NAME]: 'C:\\OldData',
    [PENDING_TARGET_VALUE_NAME]: 'D:\\KumikoData',
    'AutoZipBackupEnabled': '1',
  };
  const h = makeHarness({ userDataRoot: dir, registryStub: legacy, platform: 'win32' });
  h.migrateRegistryToConfigStoreOnce();
  const store = h.loadConfigStoreObject();
  assertEq(store[USER_DATA_VALUE_NAME], 'D:\\KumikoData', 'UserDataPath migrated');
  assertEq(store[PENDING_SOURCE_VALUE_NAME], 'C:\\OldData', 'PendingMigrationSource migrated');
  assertEq(store[PENDING_TARGET_VALUE_NAME], 'D:\\KumikoData', 'PendingMigrationTarget migrated');
  assertEq(store['AutoZipBackupEnabled'], '1', 'AutoZipBackupEnabled migrated');
  assertTrue(!!store[CONFIG_STORE_MIGRATION_MARKER], 'migration marker written');
});

runScenario('already migrated, registry now empty, JSON keeps data (Windows)', (dir) => {
  const preexisting = {
    [USER_DATA_VALUE_NAME]: 'E:\\OtherDrive\\Kumiko',
    'AutoZipBackupEnabled': '0',
    [CONFIG_STORE_MIGRATION_MARKER]: '2025-01-01T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(dir, CONFIG_STORE_FILENAME), JSON.stringify(preexisting));
  const h = makeHarness({
    userDataRoot: dir,
    registryStub: { [USER_DATA_VALUE_NAME]: 'D:\\ShouldNeverOverwrite' },
    platform: 'win32',
  });
  h.migrateRegistryToConfigStoreOnce();
  const store = h.loadConfigStoreObject();
  assertEq(store[USER_DATA_VALUE_NAME], 'E:\\OtherDrive\\Kumiko', 'existing UserDataPath preserved');
  assertEq(store['AutoZipBackupEnabled'], '0', 'existing AutoZipBackupEnabled preserved');
  assertEq(store[CONFIG_STORE_MIGRATION_MARKER], '2025-01-01T00:00:00.000Z', 'migration marker preserved');
});

runScenario('partial registry, no JSON (Windows)', (dir) => {
  const legacy = { [USER_DATA_VALUE_NAME]: 'D:\\PartialOnly' };
  const h = makeHarness({ userDataRoot: dir, registryStub: legacy, platform: 'win32' });
  h.migrateRegistryToConfigStoreOnce();
  const store = h.loadConfigStoreObject();
  assertEq(store[USER_DATA_VALUE_NAME], 'D:\\PartialOnly', 'partial key migrated');
  assertTrue(!(PENDING_SOURCE_VALUE_NAME in store), 'missing keys not fabricated');
  assertTrue(!('AutoZipBackupEnabled' in store), 'missing AutoZipBackup not fabricated');
  assertTrue(!!store[CONFIG_STORE_MIGRATION_MARKER], 'marker written');
});

runScenario('existing JSON with one key, registry has others (Windows)', (dir) => {
  fs.writeFileSync(
    path.join(dir, CONFIG_STORE_FILENAME),
    JSON.stringify({ 'AutoZipBackupEnabled': '1' })
  );
  const legacy = {
    [USER_DATA_VALUE_NAME]: 'D:\\BrandNewFromRegistry',
    'AutoZipBackupEnabled': '0',
  };
  const h = makeHarness({ userDataRoot: dir, registryStub: legacy, platform: 'win32' });
  h.migrateRegistryToConfigStoreOnce();
  const store = h.loadConfigStoreObject();
  assertEq(store['AutoZipBackupEnabled'], '1', 'existing JSON wins over registry');
  assertEq(store[USER_DATA_VALUE_NAME], 'D:\\BrandNewFromRegistry', 'missing JSON key imported');
  assertTrue(!!store[CONFIG_STORE_MIGRATION_MARKER], 'marker written');
});

runScenario('migration is a no-op on Linux (platform !== win32)', (dir) => {
  const legacy = { [USER_DATA_VALUE_NAME]: 'D:\\ShouldNotBeTouched' };
  const h = makeHarness({ userDataRoot: dir, registryStub: legacy, platform: 'linux' });
  h.migrateRegistryToConfigStoreOnce();
  const file = path.join(dir, CONFIG_STORE_FILENAME);
  assertTrue(!fs.existsSync(file), 'no JSON file created on Linux');
});

runScenario('second invocation is idempotent (Windows)', (dir) => {
  const legacy = { [USER_DATA_VALUE_NAME]: 'D:\\Data' };
  const h = makeHarness({ userDataRoot: dir, registryStub: legacy, platform: 'win32' });
  h.migrateRegistryToConfigStoreOnce();
  const firstMarker = h.loadConfigStoreObject()[CONFIG_STORE_MIGRATION_MARKER];
  // ensure timestamp would differ if re-written
  const waitUntil = Date.now() + 10;
  while (Date.now() < waitUntil) { /* spin a few ms */ }
  h.migrateRegistryToConfigStoreOnce();
  const secondMarker = h.loadConfigStoreObject()[CONFIG_STORE_MIGRATION_MARKER];
  assertEq(secondMarker, firstMarker, 'migration marker not re-written on second call');
});

console.log(`\n${process.exitCode ? 'FAILED' : 'OK'} config migration regression`);
