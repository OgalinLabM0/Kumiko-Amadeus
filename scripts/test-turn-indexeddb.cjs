#!/usr/bin/env node
'use strict';

// Production Dexie DB + reminder slice + turn coordinator in two hidden
// renderers. Every run gets a fresh profile; the app entrypoint is never loaded.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const profilePrefix = 'kumiko-turn-indexeddb-test-';
const profileFlag = '--turn-test-profile=';
const checks = ['save rollback', 'mutation rollback', 'two-renderer action identity',
  'atomic mutation conflict', 'persisted source verification', 'two-renderer turn ownership', 'restored epoch rejection', 'reload persistence'];

function assertIsolatedProfile(profile) {
  const resolved = fs.realpathSync(profile);
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir())
    || !path.basename(resolved).startsWith(profilePrefix) || fs.lstatSync(profile).isSymbolicLink()) {
    throw new Error('Unexpected temporary profile path; refusing access or cleanup');
  }
  return resolved;
}

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), profilePrefix));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('electron'), [__filename, profileFlag + profile], {
    env, cwd: root, windowsHide: true, encoding: 'utf8', timeout: 90_000,
  });
  let passed = false;
  try {
    const receiptPath = path.join(assertIsolatedProfile(profile), 'checks-passed.json');
    const receipt = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : null;
    passed = child.status === 0 && receipt?.passed === true
      && JSON.stringify(receipt.checks) === JSON.stringify(checks);
    if (passed) console.log('Real Electron / IndexedDB turn checks passed: ' + checks.join(', ') + '.');
    else {
      console.error('Electron turn checks did not produce the complete success receipt.');
      console.error(JSON.stringify({ exitCode: child.status, signal: child.signal, error: child.error?.message }));
      process.stderr.write(child.stdout || ''); process.stderr.write(child.stderr || '');
      if (child.error) console.error(child.error);
    }
  } finally {
    assertIsolatedProfile(profile);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
    catch (error) { console.warn(`Temporary test profile retained: ${profile}`, error.message); }
  }
  process.exitCode = passed ? 0 : 1;
} else {
  const { app, BrowserWindow } = require('electron');
  const ts = require('typescript');
  const profileArg = process.argv.find(arg => arg.startsWith(profileFlag));
  if (!profileArg) throw new Error('An isolated profile is required');
  const profile = assertIsolatedProfile(profileArg.slice(profileFlag.length));
  app.setPath('userData', profile); app.setPath('sessionData', profile);
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('in-process-gpu');
  const page = path.join(profile, 'test.html');
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>Isolated turn database test</title>');
  const sources = {};
  for (const name of ['services/db', 'services/dataRestoreGate', 'services/memoryMaintenanceGate', 'services/taskRuntime', 'services/roleProfiles', 'services/reminderNativeCancellation', 'services/reminderTime', 'services/taskModelRouter',
    'services/turnUnderstanding', 'services/turnCoordinator', 'store/slices/reminderSlice']) {
    sources[name] = ts.transpileModule(fs.readFileSync(path.join(root, name + '.ts'), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: name + '.ts',
    }).outputText;
  }
  const bootstrap = `(() => {
    const sources = ${JSON.stringify(sources)};
    const cache = {};
    const now = Date.parse('2026-11-01T08:00:00Z');
    const Clock = class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    };
    const location = {
      getUserKnownLocation: async () => null,
      resolveUserKnownLocation: async () => null,
      extractExplicitLocationFact: () => null,
      validateLocationFactCandidate: () => null,
      commitUserLocationFact: async () => { throw new Error('No location writes in this fixture'); },
    };
    const core = {
      getCurrentAIConfig: () => ({ provider: 'openai', model_main: 'fixture-main' }),
      callLLMRaw: async (system, user) => {
        if (system.startsWith('Verify action proposals')) return '{"valid":true}';
        if (!system.startsWith('You extract proposals')) return '{"valid":false}';
        const input = JSON.parse(user);
        const source = input.messages[0];
        return JSON.stringify({ locations: [], reminders: [{ kind: 'create', sourceMessageId: source.id,
          sourceQuote: source.text, event: '喝水', delaySeconds: 600 }] });
      },
    };
    function load(name) {
      if (name === 'dexie') return require(${JSON.stringify(require.resolve('dexie'))});
      if (name === 'services/llmCore') return core;
      if (name === 'services/userKnownLocation') return location;
      if (name === 'services/appConfig') return { getDefaultMainModel: () => 'fixture-main' };
      if (name === 'services/preferencesSync') return { noteKeyvalPreferenceWrite() {} };
      if (name === 'services/environment') return { isCapacitorNative: () => false, getCapacitorPlatform: () => 'web' };
      if (name === 'services/capacitorNotifications') return { reminderNotificationId: () => 1, cancelReminderNotification: async () => true };
      if (name === 'services/androidAlarmService') return { cancelAndroidAlarm: async () => true };
      if (cache[name]) return cache[name].exports;
      if (!sources[name]) throw new Error('Unexpected fixture dependency ' + name);
      const module = { exports: {} }; cache[name] = module;
      const from = name.slice(0, name.lastIndexOf('/'));
      const localRequire = id => load(id.startsWith('.') ? require('node:path').posix.normalize(from + '/' + id) : id);
      new Function('require', 'module', 'exports', 'Date', sources[name])(localRequire, module, module.exports, Clock);
      return module.exports;
    }
    window.fetch = async () => { throw new Error('Network is forbidden in this fixture'); };
    window.testDB = load('services/db').db;
    window.testAssert = require('node:assert/strict');
    window.testNow = now;
    const slice = load('store/slices/reminderSlice');
    window.testKeys = { relative: slice.RELATIVE_REMINDER_STORAGE_KEY, daily: slice.DAILY_REMINDER_STORAGE_KEY };
    window.testMakeSlice = () => {
      const state = { locationConfig: { modelTimezone: 'Asia/Tokyo', userTimezone: 'Asia/Shanghai' } };
      Object.assign(state, slice.createReminderSlice(value => Object.assign(state,
        typeof value === 'function' ? value(state) : value), () => state));
      return state;
    };
    window.testState = testMakeSlice();
    window.testCreateTurn = load('services/turnCoordinator').createTurnCoordinator;
    window.testInput = source => ({ sources: [source], recentMessages: [], language: 'zh',
      privateTimeZone: 'Asia/Shanghai', reminders: testState, isCancelled: () => false });
    return testDB.open().then(() => true);
  })()`;

  app.whenReady().then(async () => {
    const windows = [];
    async function openWindow() {
      const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
      windows.push(win);
      win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) console.error(message); });
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/i.test(details.url) }));
      await win.loadFile(page); await win.webContents.executeJavaScript(bootstrap);
      return win;
    }
    const first = await openWindow();
    const runIn = (win, code) => win.webContents.executeJavaScript('(async () => { ' + code + ' })()');
    const run = code => runIn(first, code);
    await run(`
      const fail = function(_key, row) { if (row.key === testKeys.relative) throw new Error('injected reminder write failure'); };
      testDB.keyval.hook('creating', fail);
      try {
        const result = await testState.saveRelativeReminder('喝水', 60, '', { actionId: 'rollback:create' });
        testAssert.equal(result.status, 'failed');
      } finally { testDB.keyval.hook('creating').unsubscribe(fail); }
      testAssert.equal(testState.relativeReminders.length, 0);
      testAssert.equal(await testDB.keyval.get(testKeys.relative), undefined);
      testAssert.equal(await testDB.keyval.get('kumiko_reminder_action:rollback:create'), undefined);

      testAssert.equal((await testState.saveRelativeReminder('喝水', 600, '', { actionId: 'rollback:target' })).status, 'saved');
      const target = testState.relativeReminders[0];
      const before = await testDB.keyval.toArray();
      const replacement = { id: target.id, event: target.event, createdAt: target.createdAt, hour: 9, minute: 0, timeZone: 'Asia/Tokyo' };
      const failReceipt = function(_key, row) { if (row.key === 'kumiko_reminder_action:rollback:mutation') throw new Error('injected mutation receipt failure'); };
      testDB.keyval.hook('creating', failReceipt);
      try {
        const result = await testState.applyReminderMutation('rollback:mutation', { id: target.id, kind: 'once', expected: target }, replacement);
        testAssert.equal(result.status, 'failed');
      } finally { testDB.keyval.hook('creating').unsubscribe(failReceipt); }
      testAssert.deepEqual(await testDB.keyval.toArray(), before);
      testAssert.equal(testState.relativeReminders.length, 1); testAssert.equal(testState.dailyReminders.length, 0);
    `);
    const second = await openWindow();
    const sameAction = `return testState.saveRelativeReminder('喝水', 600, '10分钟后提醒我喝水',
      { actionId: 'renderers:shared-action', referenceAt: testNow, timeZone: 'Asia/Shanghai' });`;
    const competing = await Promise.all([runIn(first, sameAction), runIn(second, sameAction)]);
    if (competing.filter(result => result.status === 'saved').length !== 1
      || competing.filter(result => result.status === 'existing').length !== 1) throw new Error('Two renderers did not deduplicate the reminder');
    const target = await run(`
      const rows = await testDB.getVal(testKeys.relative, []);
      testAssert.equal(rows.filter(row => row.id === 'renderers:shared-action').length, 1);
      return rows.find(row => row.id === 'renderers:shared-action');
    `);
    const expected = JSON.stringify({ id: target.id, kind: 'once', expected: target });
    const changed = JSON.stringify({ ...target, event: '喝茶', dueAt: target.dueAt + 60_000 });
    const mutations = await Promise.all([
      runIn(first, `return testState.applyReminderMutation('renderers:edit', ${expected}, ${changed});`),
      runIn(second, `return testState.applyReminderMutation('renderers:cancel', ${expected});`),
    ]);
    if (mutations.filter(result => result.status === 'saved').length !== 1
      || mutations.filter(result => result.status === 'rejected').length !== 1) throw new Error('Concurrent stale edit/cancel did not conflict');
    await run(`
      const rows = await testDB.getVal(testKeys.relative, []);
      testAssert.ok(rows.filter(row => row.id === 'renderers:shared-action').length <= 1);
      await testAssert.rejects(testCreateTurn(testInput({ id: 'missing-source', role: 'user', text: '10分钟后提醒我喝水', timestamp: testNow })), /not saved/);
      await testDB.messages.put({ id: 'turn:shared', role: 'user', text: '10分钟后提醒我喝水', timestamp: testNow });
      await testAssert.rejects(testCreateTurn(testInput({ id: 'turn:shared', role: 'user', text: '被改过的原话', timestamp: testNow })), /not saved/);
    `);
    const claim = `try {
      window.testRuntime = await testCreateTurn(testInput(await testDB.messages.get('turn:shared')));
      return { acquired: true };
    } catch (error) { return { acquired: false, message: error.message }; }`;
    const claims = await Promise.all([runIn(first, claim), runIn(second, claim)]);
    if (claims.filter(result => result.acquired).length !== 1
      || !claims.find(result => !result.acquired)?.message.includes('already being processed')) throw new Error('Persisted turn source was not exclusively claimed');
    const owner = claims[0].acquired ? first : second;
    await runIn(owner, `
      await testRuntime.prepare();
      testAssert.equal(testRuntime.createdReminder(), true);
      testAssert.ok(await testDB.keyval.get('kumiko_turn_source_v1:turn:shared'));
      testAssert.ok(await testDB.keyval.get('kumiko_turn_v1:turn:shared'));
      testAssert.equal((await testDB.getVal(testKeys.relative, [])).filter(row => row.id === 'turn:shared:reminder:0').length, 1);
    `);
    await run(`await testDB.keyval.put({ key: 'kumiko_turn_epoch_v1', value: 'restored:test' });`);
    await runIn(owner, `
      await testAssert.rejects(testRuntime.prepare(), /restored|cancelled|timed out/i);
      let executed = false;
      await testAssert.rejects(testRuntime.executeTool({ id: 'no-network', name: 'query_known_user_weather', args: {} }, async () => { executed = true; return {}; }), /restored|cancelled|timed out/i);
      testAssert.equal(executed, false);
      await testRuntime.dispose();
      await testAssert.rejects(testCreateTurn(testInput(await testDB.messages.get('turn:shared'))), /restored/i);
      const late = await testState.saveRelativeReminder('喝水', 600, '', { actionId: 'late:after-restore', expectedEpoch: 'initial' });
      testAssert.equal(late.status, 'rejected'); testAssert.equal(late.reason, 'stale_epoch');
      testAssert.equal(await testDB.keyval.get('kumiko_reminder_action:late:after-restore'), undefined);
    `);
    await run(`testDB.close();`);
    await first.loadFile(page); await first.webContents.executeJavaScript(bootstrap);
    await run(`
      testAssert.equal((await testDB.getVal(testKeys.relative, [])).filter(row => row.id === 'turn:shared:reminder:0').length, 1);
      testAssert.ok(await testDB.keyval.get('kumiko_reminder_action:renderers:shared-action'));
      testAssert.equal((await testDB.keyval.get('kumiko_turn_epoch_v1')).value, 'restored:test');
    `);
    // The parent requires every check name and a fresh on-disk receipt, so a
    // prematurely exiting Electron process cannot report a false pass.
    fs.writeFileSync(path.join(profile, 'checks-passed.json'), JSON.stringify({ passed: true, checks }));
    for (const win of windows) {
      await win.webContents.executeJavaScript('testDB.close()'); win.destroy();
    }
    app.exit(0);
  }).catch(error => { console.error(error.stack || error); app.exit(1); });
}
