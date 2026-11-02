#!/usr/bin/env node
'use strict';

// Real Electron/IndexedDB/Dexie checks, with a new disposable profile on every
// run. The application entrypoint and the user's profile are never loaded.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const tempRoot = fs.realpathSync(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tempRoot, 'kumiko-psyche-test-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('electron'), [__filename, `--psyche-test-profile=${profile}`], {
    env, cwd: root, windowsHide: true, encoding: 'utf8', timeout: 90_000,
  });
  const receipt = path.join(profile, 'checks-passed.json');
  const passed = child.status === 0 && fs.existsSync(receipt)
    && JSON.parse(fs.readFileSync(receipt, 'utf8')).passed === true;
  if (passed) console.log('real Electron / IndexedDB psyche checks passed: nested transaction rollback, reload, concurrent renderers');
  else {
    console.error('Electron database checks did not produce a completion receipt.');
    process.stderr.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    if (child.error) console.error(child.error);
  }
  // Delete only the exact fresh directory this process created, after Electron
  // has exited. Reject a link/reparse-point replacement or an escaped path.
  const resolved = fs.realpathSync(profile);
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('kumiko-psyche-test-') || fs.lstatSync(profile).isSymbolicLink()) {
    throw new Error('Unexpected temporary profile path; refusing cleanup');
  }
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
  catch (error) { console.warn(`Temporary test profile retained: ${profile}`, error.message); }
  process.exitCode = passed ? 0 : 1;
} else {
  const { app, BrowserWindow } = require('electron');
  const ts = require('typescript');
  const profileArg = process.argv.find(arg => arg.startsWith('--psyche-test-profile='));
  if (!profileArg) throw new Error('An isolated profile is required');
  const profile = profileArg.slice('--psyche-test-profile='.length);
  if (path.dirname(fs.realpathSync(profile)) !== fs.realpathSync(os.tmpdir()) || !path.basename(profile).startsWith('kumiko-psyche-test-')) {
    throw new Error('Profile must be the dedicated temporary test directory');
  }
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  app.disableHardwareAcceleration();
  // This database fixture needs no graphics; avoid a separate GPU subprocess
  // on restricted Windows runners. This switch never changes the application.
  app.commandLine.appendSwitch('in-process-gpu');
  const page = path.join(profile, 'test.html');
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>Isolated database test</title>');
  const modules = {};
  for (const name of ['dataRestoreGate', 'memoryMaintenanceGate', 'taskRuntime', 'stateProvenance', 'db', 'kumikoStateMachine', 'psycheStateService', 'responseEffectCommit', 'responsePsycheCommit']) {
    modules[name] = ts.transpileModule(fs.readFileSync(path.join(root, 'services', `${name}.ts`), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  }
  const bootstrap = `(() => {
    const source = ${JSON.stringify(modules)};
    const cache = {};
    const Clock = class extends Date {
      constructor(...args) { super(...(args.length ? args : [1789344000000])); }
      static now() { return 1789344000000; }
    };
    function load(id) {
      if (id === 'dexie') return require(${JSON.stringify(require.resolve('dexie'))});
      const name = id.startsWith('./') ? id.slice(2) : id;
      if (name === 'artifactIndexService') return { assertSourceRefsCurrent: async () => {} };
      if (cache[name]) return cache[name].exports;
      if (!source[name]) throw new Error('Unexpected test dependency ' + id);
      const module = { exports: {} }; cache[name] = module;
      new Function('require', 'module', 'exports', 'Date', source[name])(load, module, module.exports, Clock);
      return module.exports;
    }
    window.testDB = load('./db').db;
    window.testCommit = load('./responsePsycheCommit').commitVisibleResponsePsyche;
    window.testAssert = require('node:assert/strict');
    return testDB.open().then(() => true);
  })()`;

  app.whenReady().then(async () => {
    const windows = [];
    async function openWindow() {
      const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
      windows.push(win);
      win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) console.error(message); });
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/i.test(details.url) }));
      await win.loadFile(page);
      await win.webContents.executeJavaScript(bootstrap);
      return win;
    }
    const first = await openWindow();
    const run = code => first.webContents.executeJavaScript(`(async () => { ${code} })()`);
    await run(`
      await testDB.psycheState.put({ id: 'current', stress: 30, energy: 80, relaxation: 50, lastUpdated: Date.parse('2026-09-14T09:00:00+09:00'), lastDriftAt: Date.parse('2026-09-14T09:00:00+09:00') });
      const response = { responseEventId: 'accepted-once', psycheDelta: { stress: 5, energy: 0, relaxation: 0 } };
      const message = { id: 'visible-1', role: 'model', text: 'test reply', timestamp: Date.now() };
      const results = await Promise.all([testCommit(response, message), testCommit(response, message)]);
      testAssert.equal(results.filter(Boolean).length, 1);
      testAssert.equal((await testDB.psycheState.get('current')).stress, 35);
      testAssert.equal(await testDB.messages.count(), 1);

      const before = await testDB.psycheState.get('current');
      const failMarker = function(changes) {
        if (Object.keys(changes).some(key => key.startsWith('committedResponseEvents'))) throw new Error('injected final write failure');
      };
      testDB.psycheState.hook('updating', failMarker);
      try {
        await testAssert.rejects(testCommit({ responseEventId: 'must-rollback', psycheDelta: { stress: 5, energy: 0, relaxation: 0 } }, { ...message, id: 'rolled-back-message' }), /injected/);
      } finally { testDB.psycheState.hook('updating').unsubscribe(failMarker); }
      testAssert.deepEqual(await testDB.psycheState.get('current'), before);
      testAssert.equal(await testDB.messages.get('rolled-back-message'), undefined);
      await testDB.close();
    `);
    await first.loadFile(page);
    await first.webContents.executeJavaScript(bootstrap);
    await run(`
      testAssert.equal(await testCommit({ responseEventId: 'accepted-once', psycheDelta: { stress: 5, energy: 0, relaxation: 0 } }, { id: 'reload-duplicate', role: 'model', text: 'test reply', timestamp: Date.now() }), false);
      testAssert.equal((await testDB.psycheState.get('current')).stress, 35);
    `);
    const second = await openWindow();
    const competing = `(async () => testCommit({ responseEventId: 'two-renderers', psycheDelta: { stress: 5, energy: 0, relaxation: 0 } }, { id: 'two-renderers-message', role: 'model', text: 'test reply', timestamp: Date.now() }))()`;
    const results = await Promise.all([first.webContents.executeJavaScript(competing), second.webContents.executeJavaScript(competing)]);
    if (results.filter(Boolean).length !== 1) throw new Error('Concurrent renderer commits were not deduplicated');
    await run(`testAssert.equal((await testDB.psycheState.get('current')).stress, 39);`);
    fs.writeFileSync(path.join(profile, 'checks-passed.json'), JSON.stringify({ passed: true }));
    for (const win of windows) {
      await win.webContents.executeJavaScript('testDB.close()');
      win.destroy();
    }
    console.log('real Electron / IndexedDB psyche checks passed: nested transaction rollback, reload, concurrent renderers');
    app.exit(0);
  }).catch(error => {
    console.error(error.stack || error);
    app.exit(1);
  });
}
