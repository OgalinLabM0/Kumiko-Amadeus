'use strict';

// Isolated regression test for the 0.x version restart update boundary.
// It executes the desktop updater with mocked Electron/electron-updater and
// transpiles the Android service in a VM; no network, downloads, installers,
// or application data are touched.

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');

function loadDesktop(version) {
  class MockUpdater extends EventEmitter {
    constructor() {
      super();
      this.downloadCalls = 0;
      this.installCalls = 0;
      this.checkResult = { updateInfo: null };
      this.app = {};
    }
    checkForUpdates() { return Promise.resolve(this.checkResult); }
    downloadUpdate() { this.downloadCalls += 1; return Promise.resolve([]); }
    quitAndInstall() { this.installCalls += 1; }
  }
  const autoUpdater = new MockUpdater();
  const app = {
    isPackaged: true,
    getVersion: () => version,
    getPath: () => path.join(root, '.version-restart-test-cache'),
  };
  const filename = path.join(root, 'electron', 'app-updater.cjs');
  const sandbox = {
    module: { exports: {} }, exports: {}, __filename: filename, __dirname: path.dirname(filename),
    console, Buffer, setTimeout, clearTimeout, process: { env: {}, platform: 'linux' },
    require(id) {
      if (id === 'electron') return { app, shell: { openPath: async () => '' } };
      if (id === 'electron-updater') return { autoUpdater, CancellationToken: class { cancel() {} } };
      if (id === 'fs') return fs;
      if (id === 'path') return path;
      if (id === 'child_process') return { spawnSync() {} };
      throw new Error(`unexpected module: ${id}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return { updater: sandbox.module.exports, autoUpdater };
}

async function testDesktop() {
  for (const version of ['0.0.0', '0.0.1']) {
    const restarted = loadDesktop(version);
    restarted.updater.setupAutoUpdater();
    assert.equal(restarted.autoUpdater.autoDownload, false);
    assert.equal(restarted.autoUpdater.autoInstallOnAppQuit, false);
    restarted.autoUpdater.checkResult = { updateInfo: { version: '2.14.31' } };
    const oldCheck = await restarted.updater.checkForAppUpdates();
    assert.equal(oldCheck.updateInfo, null, 'check result must hide legacy 2.x');
    restarted.autoUpdater.emit('update-available', { version: '2.14.31' });
    assert.equal(restarted.updater.getUpdateState().status, 'not-available');
    assert.equal(restarted.updater.getUpdateState().availableVersion, null);
    restarted.autoUpdater.emit('update-downloaded', { version: '2.14.31' });
    assert.equal(restarted.updater.getUpdateState().status, 'not-available');
    restarted.updater.emitAppUpdateState({ status: 'available', availableVersion: '2.14.31' });
    const blockedDownload = await restarted.updater.downloadAppUpdate();
    restarted.updater.emitAppUpdateState({ status: 'downloaded', availableVersion: '2.14.31' });
    const blockedInstall = await restarted.updater.quitAndInstallAppUpdate();
    assert.equal(blockedDownload.success, false);
    assert.equal(blockedInstall.success, false);
    assert.equal(restarted.autoUpdater.downloadCalls, 0);
    assert.equal(restarted.autoUpdater.installCalls, 0);
  }

  const pointRelease = loadDesktop('0.0.1');
  pointRelease.updater.setupAutoUpdater();
  pointRelease.autoUpdater.emit('update-available', { version: '0.0.2' });
  assert.equal(pointRelease.updater.getUpdateState().status, 'available');
  assert.equal(pointRelease.updater.getUpdateState().availableVersion, '0.0.2');

  const legacy = loadDesktop('2.14.30');
  legacy.updater.setupAutoUpdater();
  legacy.autoUpdater.checkResult = { updateInfo: { version: '2.14.31' } };
  assert.deepEqual(await legacy.updater.checkForAppUpdates(), {
    success: true, trigger: 'manual', updateInfo: { version: '2.14.31' },
  });
  legacy.autoUpdater.emit('update-available', { version: '2.14.31' });
  assert.equal(legacy.updater.getUpdateState().status, 'available');
}

function loadAndroid(currentVersion, release) {
  const filename = path.join(root, 'services', 'androidUpdaterService.ts');
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const storage = new Map();
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, console, setTimeout, clearTimeout, AbortController,
    __APP_VERSION__: currentVersion,
    window: { Capacitor: { isNativePlatform: () => true }, localStorage: {
      getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value),
    }, open() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => release }),
    require(id) { if (id === './environment') return { isCapacitorNative: () => true }; throw new Error(id); },
  };
  vm.runInNewContext(js, sandbox, { filename });
  return module.exports;
}

async function testAndroid() {
  const release2 = { tag_name: 'v2.14.31', html_url: 'https://example.test/2', assets: [] };
  for (const current of ['0.0.0', '0.0.1']) {
    const service = loadAndroid(current, release2);
    const result = await service.checkForAndroidUpdate(true);
    assert.deepEqual(result, { hasUpdate: false, currentVersion: current });
  }
  const service0 = loadAndroid('0.0.1', { tag_name: 'v0.0.2', html_url: 'https://example.test/0', assets: [] });
  assert.equal((await service0.checkForAndroidUpdate(true)).hasUpdate, true);
  const legacy = loadAndroid('2.14.30', release2);
  assert.equal((await legacy.checkForAndroidUpdate(true)).hasUpdate, true);
}

(async () => {
  await testDesktop();
  await testAndroid();
  console.log('version restart updater regression tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
