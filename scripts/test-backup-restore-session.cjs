#!/usr/bin/env node
'use strict';

// Real production Dexie + restore gate/session in two hidden Electron windows.
// Only native/media boundaries are injected; no app entrypoint or user profile.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const prefix = 'kumiko-backup-restore-test-';
const flag = '--backup-restore-test-profile=';
const checks = ['owned transaction fence', 'cross-window write fence', 'all-table rollback before UI publication',
  'production restore wiring defers UI and preserves refs on failure', 'strict native snapshot failures abort safely',
  'query session clears atomically and publish performs no duplicate storage write',
  'committed startup recovery retains the persisted RAG dirty flag without UI publication',
  'invalid recovery journal refuses destructive compensation',
  'native failure compensation', 'media commit failure compensation', 'successful commit publication',
  'active restore is not stolen by startup recovery',
  'stale renderer writes stay fenced until reload',
  'prepared startup recovery', 'partially-applied startup recovery', 'committed startup recovery',
  'failed compensation keeps writes blocked', 'old turn epoch rejection', 'original snapshot preservation'];

function isolated(profile) {
  const actual = fs.realpathSync(profile);
  if (path.dirname(actual) !== fs.realpathSync(os.tmpdir()) || !path.basename(actual).startsWith(prefix)
    || fs.lstatSync(profile).isSymbolicLink()) throw new Error('Unsafe test profile; refusing access or cleanup');
  return actual;
}

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('electron'), [__filename, flag + profile], {
    env, cwd: root, windowsHide: true, encoding: 'utf8', timeout: 90_000,
  });
  let passed = false;
  try {
    const receiptPath = path.join(isolated(profile), 'checks-passed.json');
    const receipt = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : null;
    passed = child.status === 0 && receipt?.passed === true && JSON.stringify(receipt.checks) === JSON.stringify(checks);
    if (passed) console.log('Real Electron / IndexedDB restore checks passed: ' + checks.join(', ') + '.');
    else {
      console.error('Restore checks did not produce the complete success receipt.');
      console.error(JSON.stringify({ exitCode: child.status, signal: child.signal, error: child.error?.message }));
      process.stderr.write(child.stdout || ''); process.stderr.write(child.stderr || '');
    }
  } finally {
    isolated(profile);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
    catch (error) { console.warn('Temporary restore profile retained: ' + profile, error.message); }
  }
  process.exitCode = passed ? 0 : 1;
} else {
  const { app, BrowserWindow } = require('electron');
  const ts = require('typescript');
  const argument = process.argv.find(value => value.startsWith(flag));
  if (!argument) throw new Error('An isolated profile is required');
  const profile = isolated(argument.slice(flag.length));
  app.setPath('userData', profile); app.setPath('sessionData', profile);
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('in-process-gpu');
  const page = path.join(profile, 'test.html');
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>Isolated restore test</title>');
  const sources = {};
  for (const name of ['services/voiceWriteRecord', 'services/db', 'services/dataRestoreGate', 'services/memoryMaintenanceGate', 'services/runtimeStateBackup', 'services/memoryCorrectionBackup', 'services/memoryCorrectionPolicy', 'services/taskRuntime', 'services/artifactIndexService', 'services/mediaWriteFence', 'services/backupRestoreSession', 'services/turnCoordinator',
    'services/turnStateBackup', 'services/executionArchive', 'services/backgroundJobs', 'services/responseEffectCommit', 'services/reminderTime', 'services/temporalEpisodeService',
    'components/app/backupActions', 'components/app/messageMappers', 'components/app/backupHelpers',
    'components/app/summaryCycle', 'components/app/backupData', 'components/app/backupImportValidation',
    'components/app/appConstants', 'electron/backup-import-validation.mjs']) {
    sources[name] = ts.transpileModule(fs.readFileSync(path.join(root, name.endsWith('.mjs') ? name : name + '.ts'), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: name + '.ts',
    }).outputText;
  }
  const bootstrap = `(() => {
    const sources = ${JSON.stringify(sources)};
    const cache = {};
    const clone = value => structuredClone(value);
    const fixture = window.fixture = { nativeMessages: [], nativeVectors: [], media: null, snapshotFailure: null,
      lock: null, calls: [], failNative: false, failRollback: false, published: 0 };
    window.electronAPI = { invoke: async (channel, args) => {
      fixture.calls.push({ channel, args: clone(args) });
      if (channel === 'rag:get-messages') return fixture.snapshotFailure === 'raw-error' ? { success: false, error: 'raw snapshot failure' }
        : { success: true, messages: fixture.snapshotFailure === 'raw-shape' ? {} : clone(fixture.nativeMessages) };
      if (channel === 'rag:get-all') return fixture.snapshotFailure === 'vector-error' ? { success: false, error: 'vector snapshot failure' }
        : { success: true, vectors: fixture.snapshotFailure === 'vector-shape' ? undefined : clone(fixture.nativeVectors) };
      if (channel === 'rag:restore-lock') {
        if (args.action === 'begin') {
          if (fixture.lock && fixture.lock !== args.id) return { success: false, error: 'foreign lock' };
          fixture.lock = args.id;
        } else { if (fixture.lock !== args.id) return { success: false, error: 'wrong unlock' }; fixture.lock = null; }
        return { success: true };
      }
      if (args.restoreSessionId !== fixture.lock) throw new Error('Native write without owner');
      if (channel === 'rag:sync-messages') { fixture.nativeMessages = clone(args.messages); return { success: true }; }
      if (channel === 'rag:restore') {
        fixture.nativeVectors = clone(args.vectors);
        if (fixture.failNative) { fixture.failNative = false; return { success: false, error: 'injected native restore failure' }; }
        return { success: true, count: args.vectors.length };
      }
      throw new Error('Unexpected native IPC ' + channel);
    } };
    function load(name) {
      if (name === 'dexie') return require(${JSON.stringify(require.resolve('dexie'))});
      if (name === 'services/preferencesSync') return { noteKeyvalPreferenceWrite() {} };
      // Platform cancellation draining is covered by its own native-reminder
      // regression; keep this fixture limited to restore storage/UI behavior.
      if (name === 'services/reminderNativeCancellation') return {
        captureReminderNativeCancellationsForRestore: async () => [],
        mergeReminderNativeCancellationsAfterRestore: async () => {},
        drainReminderNativeCancellations: async () => {},
      };
      if (name === 'services/localRagService') return {
        getAllVectors: async () => clone(fixture.nativeVectors), loadRawHistoryMessagesFromMain: async () => clone(fixture.nativeMessages),
      };
      if (name === 'services/androidRagService') return {};
      if (name === 'services/backupMediaStaging') return { rollbackPreparedBackupMedia: async (snapshot, id) => {
        if (fixture.lock !== id) throw new Error('Media rollback without owner');
        if (fixture.failRollback) throw new Error('injected media rollback failure');
        fixture.media = clone(snapshot);
      } };
      if (name === 'constants') return { DEFAULT_WORLD_BOOK: [], LOCALIZED_WORLD_BOOK: { zh: [] }, DEFAULT_LOCATION_CONFIG: {} };
      if (name === 'store') return { useAppStore: { getState: () => window.uiState } };
      if (name === 'store/slices/reminderSlice') return { RELATIVE_REMINDER_STORAGE_KEY: 'kumiko_relative_reminders',
        DAILY_REMINDER_STORAGE_KEY: 'kumiko_daily_reminders', normalizeReminderEvent: value => value };
      if (name === 'store/slices/ragSlice') return { RAG_HISTORY_DIRTY_STORAGE_KEY: 'kumiko_rag_history_dirty' };
      if (name === 'services/desktopBackupService') return { isDesktopElectron: () => true };
      if (['services/backupProtection', 'services/portableBackupCrypto.mjs', 'services/backupArchiveValidation.mjs'].includes(name)) return {};
      if (['react', 'jszip', 'file-saver', 'services/llmCore', 'services/taskModelRouter', 'services/userKnownLocation',
        'services/turnUnderstanding', 'services/appConfig', 'services/environment', 'services/capacitorBackupNative',
        'services/dialogService', 'services/imageService', 'services/voiceFileService', 'components/app/rawHistorySync',
        'components/app/appUtils'].includes(name)) return {};
      if (cache[name]) return cache[name].exports;
      if (!sources[name]) throw new Error('Unexpected fixture dependency ' + name);
      const module = { exports: {} }; cache[name] = module;
      const from = name.slice(0, name.lastIndexOf('/'));
      const localRequire = id => load(id.startsWith('.') ? require('node:path').posix.normalize(from + '/' + id) : id);
      new Function('require', 'module', 'exports', sources[name])(localRequire, module, module.exports);
      return module.exports;
    }
    window.fetch = async () => { throw new Error('Network forbidden in restore fixture'); };
    window.testAssert = require('node:assert/strict');
    window.testDB = load('services/db').db;
    window.gate = load('services/dataRestoreGate');
    window.restore = load('services/backupRestoreSession');
    window.turns = load('services/turnCoordinator');
    window.backupActions = load('components/app/backupActions');
    window.makeUi = () => {
      window.uiEvents = [];
      window.memoryQueryPublishOptions = null;
      window.uiState = { language: 'zh', turnCount: 0, coreMemory: 'original UI memory', worldBook: [], messages: [],
        relativeReminders: [], dailyReminders: [], locationConfig: {}, anchors: [], kumikoNotebook: '',
        summaryArchiveState: {}, contextLimit: 24, currentEmotion: 'neutral' };
      for (const name of ['Messages', 'CoreMemory', 'WorldBook', 'ContextLimit', 'TurnCount', 'SummaryArchiveState',
        'CurrentEmotion', 'LocationConfig', 'Language', 'Anchors', 'KumikoNotebook', 'RelativeReminders',
        'DailyReminders', 'MissedReminders', 'BusyFollowUp', 'PendingApology', 'BusySlotRuntime', 'DataLoadError', 'IsRagHistoryDirty']) {
        uiState['set' + name] = value => { uiEvents.push(name); uiState[name[0].toLowerCase() + name.slice(1)] = value; };
      }
      const update = name => value => { uiEvents.push(name); };
      return { isBulkRestoreInProgressRef: { current: false }, rawHistorySyncedIdsRef: { current: new Set(['original-sync']) },
        forceRawHistoryResyncRef: { current: true }, updateMemoryQuerySession: (value, options) => {
          memoryQueryPublishOptions = options; update('memory query')(value);
        },
        setWorldCharacterStatus: update('world status'), setAutoSavedKumikoDiary: update('diary'),
        setAutoSavedDailyFragments: update('fragments'), setAutoSavedPsycheState: update('psyche'),
        worldCharacterStatus: {}, autoSavedKumikoDiary: [], autoSavedDailyFragments: [], autoSavedPsycheState: null };
    };
    window.testData = { messages: [{ id: 'imported-message', role: 'user', text: 'imported', timestamp: 2 }],
      vectors: [{ id: 'imported-vector', text: 'imported independent vector', vector: [0.2], timestamp: 2 }] };
    window.captureTables = async () => {
      const tables = {};
      for (const table of testDB.tables) tables[table.name] = (await table.toArray()).filter(row => table.name !== 'keyval'
        || ![restore.RESTORE_JOURNAL_KEY, restore.LAST_RESTORE_SNAPSHOT_KEY, 'kumiko_turn_epoch_v1'].includes(row.key));
      return tables;
    };
    window.resetFixture = async () => {
      testAssert.equal(gate.isDataRestoreBlocked(), false);
      await testDB.transaction('rw', testDB.tables, async () => {
        for (const table of testDB.tables) {
          await table.clear();
          if (table.name === 'memoryCorrections') continue; // No correction in this ordinary restore fixture; dedicated suite covers correction rules.
          await table.put(table.name === 'keyval' ? { key: 'original-preference', value: { preserved: true } }
            : { id: 'original-' + table.name, timestamp: 1, text: 'original ' + table.name, preserved: true });
        }
        await testDB.keyval.put({ key: 'kumiko_turn_epoch_v1', value: 'original-epoch' });
        await testDB.keyval.put({ key: 'kumiko_memory_query_session', value: { sourceQuery: 'old dataset query', lastUsedAt: 1 } });
      });
      fixture.nativeMessages = [{ id: 'original-native', role: 'user', text: 'original raw history', timestamp: 1, originalOpaqueField: { retained: true } }];
      fixture.nativeVectors = [{ id: 'original-independent', text: 'not derived from raw history', vector: [0.1], timestamp: 1 }];
      fixture.media = { present: true, base64: 'b3JpZ2luYWw=', ext: 'wav' };
      fixture.calls = []; fixture.published = 0; fixture.failNative = false; fixture.failRollback = false; fixture.snapshotFailure = null;
      window.original = { tables: await captureTables(), nativeMessages: clone(fixture.nativeMessages),
        nativeVectors: clone(fixture.nativeVectors), media: clone(fixture.media) };
    };
    window.persistImported = async id => testDB.transaction('rw', testDB.tables, async tx => {
      gate.permitDataRestoreTransaction(tx, id);
      for (const table of testDB.tables) {
        if (table.name === 'keyval') await table.put({ key: 'imported-preference', value: true });
        else { await table.clear(); await table.put({ id: 'imported-' + table.name, timestamp: 2, text: 'imported' }); }
      }
      await testDB.keyval.put({ key: 'kumiko_turn_epoch_v1', value: 'new-epoch' });
    });
    window.verifyOriginal = async () => {
      testAssert.deepEqual(await captureTables(), original.tables);
      testAssert.deepEqual(fixture.nativeMessages, original.nativeMessages);
      testAssert.deepEqual(fixture.nativeVectors, original.nativeVectors);
      testAssert.deepEqual(fixture.media, original.media);
      testAssert.deepEqual((await testDB.keyval.get(restore.LAST_RESTORE_SNAPSHOT_KEY)).value.tables.keyval,
        [...original.tables.keyval, { key: 'kumiko_turn_epoch_v1', value: 'original-epoch' }]
          .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      testAssert.notEqual((await testDB.keyval.get('kumiko_turn_epoch_v1')).value, 'original-epoch');
      testAssert.equal(fixture.published, 0);
      testAssert.equal(gate.isDataRestoreBlocked(), false);
      testAssert.equal(await testDB.keyval.get(restore.RESTORE_JOURNAL_KEY), undefined);
    };
    window.installJournal = async (phase, dirty) => {
      const id = crypto.randomUUID();
      const snapshot = { tables: {} , nativeMessages: clone(fixture.nativeMessages), nativeVectors: clone(fixture.nativeVectors) };
      for (const table of testDB.tables) snapshot.tables[table.name] = await table.toArray();
      gate.beginDataRestore(id);
      await testDB.transaction('rw', testDB.tables, async tx => {
        gate.permitDataRestoreTransaction(tx, id);
        if (dirty) for (const table of testDB.tables) {
          await table.clear(); await table.put(table.name === 'keyval' ? { key: 'dirty', value: true } : { id: 'dirty-' + table.name });
        }
        await testDB.keyval.put({ key: restore.RESTORE_JOURNAL_KEY, value: {
          id, phase, snapshot, mediaSnapshot: clone(fixture.media), nativeChanged: dirty, mediaChanged: dirty,
        } });
      });
      if (dirty) { fixture.nativeMessages = testData.messages; fixture.nativeVectors = testData.vectors; fixture.media = { present: false }; }
      return id;
    };
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
    const first = await openWindow(); const second = await openWindow();
    const runIn = (win, code) => win.webContents.executeJavaScript('(async () => { ' + code + ' })()');
    const run = code => runIn(first, code);
    const reloadWindow = async win => {
      await runIn(win, 'testDB.close();');
      await win.loadFile(page);
      await win.webContents.executeJavaScript(bootstrap);
    };
    await run(`
      await resetFixture();
      gate.beginDataRestore('fence-owner');
      await testAssert.rejects(testDB.messages.put({ id: 'unowned' }), /restoration is in progress/);
      await testDB.transaction('rw', testDB.messages, async tx => {
        gate.permitDataRestoreTransaction(tx, 'fence-owner');
        await testDB.messages.put({ id: 'owned', text: 'permitted' });
      });
      testAssert.equal((await testDB.messages.get('owned')).text, 'permitted');
    `);
    await runIn(second, `
      testAssert.equal(gate.isDataRestoreBlocked(), true);
      await testAssert.rejects(testDB.messages.put({ id: 'foreign' }), /restoration is in progress/);
      await testAssert.rejects(testDB.messages.clear(), /restoration is in progress/);
      await testAssert.rejects(testDB.keyval.bulkPut([{ key: 'foreign', value: true }]), /restoration is in progress/);
      await testAssert.rejects(testDB.transaction('rw', testDB.messages, async tx => {
        gate.permitDataRestoreTransaction(tx, 'fence-owner'); await testDB.messages.put({ id: 'stolen' });
      }), /not owned/);
    `);
    await run(`gate.finishDataRestore('fence-owner');`);
    await runIn(second, `
      testAssert.equal(gate.readDataRestoreGate(), null);
      testAssert.equal(gate.isDataRestoreBlocked(), true);
      await testAssert.rejects(testDB.messages.put({ id: 'stale-after-gate-cleared' }), /restoration is in progress/);
    `);
    await reloadWindow(second);
    await runIn(second, `
      testAssert.equal(gate.isDataRestoreBlocked(), false);
      testAssert.equal((await testDB.messages.get('owned')).text, 'permitted');
    `);
    await run(`
      for (const failure of ['raw-error', 'raw-shape', 'vector-error', 'vector-shape']) {
        await resetFixture(); fixture.snapshotFailure = failure;
        await testAssert.rejects(restore.runBackupRestoreSession(testData,
          async () => { throw new Error('persist must not run'); }, () => fixture.published++), /Cannot snapshot/);
        testAssert.deepEqual(await captureTables(), original.tables);
        testAssert.deepEqual(fixture.nativeMessages, original.nativeMessages);
        testAssert.deepEqual(fixture.nativeVectors, original.nativeVectors);
        testAssert.equal(gate.isDataRestoreBlocked(), false);
        testAssert.equal(fixture.published, 0); testAssert.equal(fixture.lock, null);
        testAssert.equal(fixture.calls.some(call => ['rag:sync-messages', 'rag:restore'].includes(call.channel)), false);
      }
      await resetFixture(); const deps = makeUi(); fixture.failNative = true;
      const backup = { data: { messages: testData.messages, worldBook: [], coreMemory: 'imported UI memory' }, vectors: testData.vectors };
      await testAssert.rejects(backupActions.restoreBackupData(backup, deps), /injected native/);
      testAssert.deepEqual(uiEvents, []); testAssert.equal(uiState.coreMemory, 'original UI memory');
      testAssert.deepEqual([...deps.rawHistorySyncedIdsRef.current], ['original-sync']);
      testAssert.equal(deps.forceRawHistoryResyncRef.current, true);
      testAssert.equal((await testDB.keyval.get('kumiko_memory_query_session')).value.sourceQuery, 'old dataset query');
      testAssert.equal(deps.isBulkRestoreInProgressRef.current, false); await verifyOriginal();
      // The same production normalize/persist/session/publish path succeeds.
      const result = await backupActions.restoreBackupData(backup, deps);
      testAssert.ok(result); testAssert.deepEqual(JSON.parse(JSON.stringify(uiState.messages)), testData.messages);
      testAssert.equal(uiState.coreMemory, 'imported UI memory');
      testAssert.deepEqual([...deps.rawHistorySyncedIdsRef.current], ['imported-message']);
      testAssert.equal(deps.forceRawHistoryResyncRef.current, false);
      testAssert.equal((await testDB.keyval.get('kumiko_memory_query_session')).value, null);
      testAssert.deepEqual(memoryQueryPublishOptions, { persist: false });
      testAssert.equal((await testDB.keyval.get('kumiko_rag_history_dirty')).value, false);
      testAssert.equal((await testDB.messages.get('imported-message')).text, 'imported');
      testAssert.ok(await testDB.keyval.get('kumiko_chat_history'));
      // A legacy backup has no vectors. Simulate a renderer failure at the
      // first UI publish callback after the committed journal was persisted.
      const crashDeps = makeUi();
      crashDeps.updateMemoryQuerySession = () => { throw new Error('injected publication failure'); };
      await testAssert.rejects(backupActions.restoreBackupData({ data: {
        messages: testData.messages, worldBook: [], coreMemory: 'legacy imported memory',
      } }, crashDeps), /injected publication failure/);
      testAssert.equal((await testDB.keyval.get(restore.RESTORE_JOURNAL_KEY)).value.phase, 'committed');
      testAssert.equal(gate.isDataRestoreBlocked(), true);
      testAssert.equal(uiEvents.includes('IsRagHistoryDirty'), false);
      testAssert.equal((await testDB.keyval.get('kumiko_rag_history_dirty')).value, true);
      testAssert.deepEqual(fixture.nativeVectors, []);
      await restore.recoverInterruptedBackupRestore();
      testAssert.equal(gate.isDataRestoreBlocked(), false);
      testAssert.equal((await testDB.keyval.get('kumiko_rag_history_dirty')).value, true);
      testAssert.equal((await testDB.keyval.get('kumiko_memory_query_session')).value, null);
    `);
    await run(`
      await resetFixture();
      await testAssert.rejects(restore.runBackupRestoreSession(testData, async id => {
        await persistImported(id); testAssert.equal(fixture.published, 0); throw new Error('injected persist failure');
      }, () => fixture.published++), /injected persist failure/);
      await verifyOriginal();
      const snapshot = (await testDB.keyval.get(restore.LAST_RESTORE_SNAPSHOT_KEY)).value;
      testAssert.deepEqual(snapshot.nativeVectors, original.nativeVectors);
      testAssert.deepEqual(snapshot.nativeMessages, original.nativeMessages);
    `);
    await run(`
      await resetFixture(); fixture.failNative = true;
      await testAssert.rejects(restore.runBackupRestoreSession(testData, persistImported, () => fixture.published++), /injected native/);
      await verifyOriginal();
      testAssert.equal(fixture.calls.filter(call => call.channel === 'rag:restore').length, 2);
    `);
    await run(`
      await resetFixture(); let persisted = false;
      await testAssert.rejects(restore.runBackupRestoreSession(testData, async id => { persisted = true; await persistImported(id); },
        () => fixture.published++, { snapshot: async () => structuredClone(fixture.media), commit: async () => {
          fixture.media = { present: false }; throw new Error('injected media commit failure');
        } }), /injected media commit/);
      testAssert.equal(persisted, false); await verifyOriginal();
    `);
    await run(`
      await resetFixture();
      await restore.runBackupRestoreSession(testData, persistImported, () => {
        testAssert.equal(gate.readDataRestoreGate().phase, 'committed');
        testAssert.deepEqual(fixture.nativeMessages, testData.messages);
        testAssert.deepEqual(fixture.nativeVectors, testData.vectors); fixture.published++;
      });
      testAssert.equal(fixture.published, 1); testAssert.equal(gate.isDataRestoreBlocked(), false);
      testAssert.equal(await testDB.keyval.get(restore.RESTORE_JOURNAL_KEY), undefined);
      testAssert.equal((await testDB.messages.get('imported-messages')).text, 'imported');
    `);
    await run(`
      await resetFixture(); testAssert.ok(navigator.locks, 'Web Locks must exist in the real Electron file origin');
      const entered = new Promise(resolve => window.signalRestoreEntered = resolve);
      window.activeRestore = restore.runBackupRestoreSession(testData, async id => {
        window.activeRestoreId = id; signalRestoreEntered();
        await new Promise(resolve => window.releaseActiveRestore = resolve);
        await persistImported(id);
      }, () => fixture.published++);
      await entered;
    `);
    await runIn(second, `
      window.recoveryDone = false;
      window.waitingRecovery = restore.recoverInterruptedBackupRestore().then(value => { recoveryDone = true; return value; });
      await testAssert.rejects(restore.runBackupRestoreSession(testData, persistImported, () => fixture.published++), /Another window/);
      const locks = await navigator.locks.query();
      testAssert.equal(locks.held.filter(lock => lock.name === 'kumiko-data-restore-v1').length, 1);
      testAssert.equal(locks.pending.filter(lock => lock.name === 'kumiko-data-restore-v1').length, 1);
      testAssert.equal(recoveryDone, false); testAssert.equal(fixture.calls.length, 0);
      await testAssert.rejects(testDB.messages.put({ id: 'active-restore-foreign-write' }), /restoration is in progress/);
    `);
    await run(`
      testAssert.equal(gate.readDataRestoreGate().id, activeRestoreId);
      testAssert.equal((await testDB.keyval.get(restore.RESTORE_JOURNAL_KEY)).value.id, activeRestoreId);
      testAssert.equal(fixture.published, 0); releaseActiveRestore(); await activeRestore;
      testAssert.equal(fixture.published, 1); testAssert.equal(gate.isDataRestoreBlocked(), false);
    `);
    await runIn(second, `
      testAssert.equal(await waitingRecovery, false); testAssert.equal(recoveryDone, true);
      testAssert.equal(fixture.calls.length, 0);
      testAssert.equal(gate.readDataRestoreGate(), null);
      testAssert.equal(gate.isDataRestoreBlocked(), true);
      await testAssert.rejects(testDB.messages.put({ id: 'old-window-after-success' }), /restoration is in progress/);
      await testAssert.rejects(testDB.keyval.put({ key: 'kumiko_chat_history', value: ['stale UI history'] }), /restoration is in progress/);
      testAssert.ok(await testDB.messages.get('imported-messages'));
    `);
    await reloadWindow(second);
    await runIn(second, `
      testAssert.equal(gate.isDataRestoreBlocked(), false);
      testAssert.ok(await testDB.messages.get('imported-messages'));
      testAssert.equal(await testDB.messages.get('old-window-after-success'), undefined);
      testAssert.equal(await testDB.keyval.get('kumiko_chat_history'), undefined);
      await testDB.keyval.put({ key: 'fresh-window-write', value: true });
      testAssert.equal((await testDB.keyval.get('fresh-window-write')).value, true);
    `);
    for (const phase of ['prepared', 'applying', 'committed']) {
      await run(`await resetFixture(); await installJournal(${JSON.stringify(phase)}, ${phase !== 'prepared'});`);
      // A fresh renderer has no in-memory ownership token: this exercises the
      // actual startup recovery path over the durable marker and real journal.
      const fresh = await openWindow();
      // Native/media fixture state stands for a separately persistent native
      // store; move it explicitly without loading any user filesystem data.
      const nativeState = await run(`return { nativeMessages: fixture.nativeMessages, nativeVectors: fixture.nativeVectors, media: fixture.media };`);
      await runIn(fresh, `Object.assign(fixture, ${JSON.stringify(nativeState)}); await restore.recoverInterruptedBackupRestore();
        testAssert.equal(gate.isDataRestoreBlocked(), false);
        testAssert.equal(await testDB.keyval.get(restore.RESTORE_JOURNAL_KEY), undefined);
        testAssert.equal(fixture.published, 0);
        ${phase === 'committed' ? `testAssert.ok(await testDB.messages.get('dirty-messages')); testAssert.equal(await testDB.messages.get('original-messages'), undefined);`
          : `testAssert.ok(await testDB.messages.get('original-messages')); testAssert.equal(await testDB.messages.get('dirty-messages'), undefined);
             testAssert.equal(fixture.nativeMessages[0].id, 'original-native'); testAssert.equal(fixture.nativeVectors[0].id, 'original-independent');
             testAssert.equal(fixture.media.base64, 'b3JpZ2luYWw=');`}
      `);
      await runIn(fresh, `testDB.close();`); fresh.destroy();
    }
    await run(`
      await resetFixture(); const id = await installJournal('applying', true);
      let journal = (await testDB.keyval.get(restore.RESTORE_JOURNAL_KEY)).value;
      const complete = structuredClone(journal);
      delete journal.snapshot.tables.images;
      await testDB.transaction('rw', testDB.keyval, async tx => {
        gate.permitDataRestoreTransaction(tx, id); await testDB.keyval.put({ key: restore.RESTORE_JOURNAL_KEY, value: journal });
      });
      const before = await captureTables(); fixture.calls = [];
      await testAssert.rejects(restore.recoverInterruptedBackupRestore(), /snapshot is incomplete/);
      testAssert.equal(gate.isDataRestoreBlocked(), true); testAssert.deepEqual(await captureTables(), before);
      testAssert.equal(fixture.calls.some(call => ['rag:sync-messages', 'rag:restore'].includes(call.channel)), false);
      await testAssert.rejects(testDB.messages.put({ id: 'bad-journal-write' }), /restoration is in progress/);
      journal = structuredClone(complete); delete journal.snapshot.nativeVectors;
      await testDB.transaction('rw', testDB.keyval, async tx => {
        gate.permitDataRestoreTransaction(tx, id); await testDB.keyval.put({ key: restore.RESTORE_JOURNAL_KEY, value: journal });
      });
      await testAssert.rejects(restore.recoverInterruptedBackupRestore(), /Native restore snapshot is incomplete/);
      testAssert.deepEqual(await captureTables(), before); testAssert.equal(gate.isDataRestoreBlocked(), true);
      await testDB.transaction('rw', testDB.keyval, async tx => {
        gate.permitDataRestoreTransaction(tx, id); await testDB.keyval.put({ key: restore.RESTORE_JOURNAL_KEY, value: complete });
      });
      await restore.recoverInterruptedBackupRestore(); await verifyOriginal();
    `);
    await run(`
      await resetFixture(); fixture.failRollback = true;
      await testAssert.rejects(restore.runBackupRestoreSession(testData, persistImported, () => fixture.published++, {
        snapshot: async () => structuredClone(fixture.media), commit: async () => { fixture.media = { present: false }; throw new Error('commit failed'); },
      }), /recovery is incomplete/);
      testAssert.equal(gate.isDataRestoreBlocked(), true); testAssert.equal(fixture.published, 0);
      testAssert.ok(await testDB.keyval.get(restore.RESTORE_JOURNAL_KEY));
      await testAssert.rejects(testDB.messages.put({ id: 'after-failed-compensation' }), /restoration is in progress/);
      fixture.failRollback = false; await restore.recoverInterruptedBackupRestore(); await verifyOriginal();
      await resetFixture();
      const message = { id: 'old-turn-message', role: 'user', text: 'preserved source', timestamp: 1 };
      await testDB.messages.put(message);
      await testDB.keyval.bulkPut([
        { key: 'kumiko_turn_source_v1:' + message.id, value: { turnId: 'old-turn' } },
        { key: 'kumiko_turn_v1:old-turn', value: { id: 'old-turn', epoch: 'original-epoch', sources: [message] } },
      ]);
      testAssert.equal((await turns.readTurnSources(message.id)).turnId, 'old-turn');
      await testAssert.rejects(restore.runBackupRestoreSession(testData, async () => { throw new Error('epoch rollback'); }, () => fixture.published++), /epoch rollback/);
      await testAssert.rejects(turns.readTurnSources(message.id), /restored data/);
      testAssert.equal((await testDB.messages.get(message.id)).text, 'preserved source');
    `);
    fs.writeFileSync(path.join(isolated(profile), 'checks-passed.json'), JSON.stringify({ passed: true, checks }));
    for (const win of windows) if (!win.isDestroyed()) { await runIn(win, 'testDB.close();'); win.destroy(); }
    app.exit(0);
  }).catch(error => { console.error(error.stack || error); app.exit(1); });
}
