'use strict';

// Regression coverage for F01. Runs only against temporary fixtures and VM
// mocks: it never opens a user backup, database, or media directory.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const JSZip = require('jszip');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
let validateBackupImportPayload;

function currentExport(data = {}) {
  return {
    timestamp: Date.now(),
    version: '1.3',
    data: {
      messages: [],
      worldBook: [],
      coreMemory: '',
      contextLimit: 100,
      turnCount: 0,
      summaryArchiveState: {},
      currentEmotion: 'neutral',
      locationConfig: {},
      language: 'zh',
      anchors: [],
      kumikoNotebook: '',
      relativeReminders: [],
      dailyReminders: [],
      ...data,
    },
  };
}

function testValidationContract() {
  for (const invalid of [
    {},
    { title: 'ordinary JSON', values: [1, 2, 3] },
    { data: {} },
    { data: { messages: {}, worldBook: [] } },
    { data: { messages: [], worldBook: 'not-an-array' } },
    { data: { messages: [null], worldBook: [] } },
    { data: { messages: [{}], worldBook: [] } },
    { data: { messages: [{ text: 42 }], worldBook: [] } },
    { data: { messages: [{ id: 'm1', role: 'user', timestamp: 'bad', text: 'bad timestamp' }], worldBook: [] } },
    { data: { messages: [], worldBook: [], kumikoNotebook: 42 } },
    { data: { messages: [], worldBook: [], anchors: {} } },
    { data: { messages: [], worldBook: [] }, vectors: {} },
    { data: { messages: [], worldBook: [] }, vectors: [{}] },
    { data: { messages: [], worldBook: [] }, vectors: [
      { id: 'v1', text: 'first', timestamp: 1, vector: [0.1, 0.2] },
      { id: 'v1', text: 'duplicate', timestamp: 2, vector: [0.3, 0.4] },
    ] },
  ]) {
    assert.equal(validateBackupImportPayload(invalid).valid, false, JSON.stringify(invalid));
  }

  assert.equal(validateBackupImportPayload(currentExport()).valid, true, 'current export shape');
  assert.equal(validateBackupImportPayload(currentExport({
    messages: [{ id: 'historic-message', role: 'user', timestamp: '1712345678901', text: 'legacy timestamp string' }],
  })).valid, true, 'historical message timestamp string');
  assert.equal(validateBackupImportPayload({
    ...currentExport(),
    // Exact nullable shape produced by electron-rag.cjs `rag:get-all` for a
    // summary block with no source message link.
    vectors: [{
      id: 'summary-vector',
      messageId: null,
      text: 'summary block fixture',
      vector: [0.1, 0.2],
      timestamp: 1,
      tier: 'core',
      source: undefined,
      score: 0,
      canonicalKey: undefined,
      role: 'unknown',
    }],
  }).valid, true, 'actual desktop rag:get-all summary vector shape');
  assert.equal(validateBackupImportPayload({
    ...currentExport(),
    vectors: [{ id: 'legacy-string-time', text: 'bad contract', timestamp: '1', vector: [0.1] }],
  }).valid, false, 'vector timestamps must match native numeric restore contract');
  assert.equal(
    validateBackupImportPayload({ messages: [], worldBook: [], coreMemory: 'legacy memory' }).valid,
    true,
    'legacy direct payload remains supported',
  );
  assert.equal(
    validateBackupImportPayload(currentExport({ messages: [], worldBook: [], kumikoNotebook: '' })).valid,
    true,
    'explicit empty backup remains supported',
  );
}

function loadBackupActionsForInvalidRestore() {
  const filename = path.join(root, 'components', 'app', 'backupActions.ts');
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  let storeReads = 0;
  let databaseWrites = 0;
  const noop = () => undefined;
  const requireMap = {
    react: { default: { startTransition: noop }, startTransition: noop },
    jszip: class {},
    'file-saver': { saveAs: noop },
    '../../store': { useAppStore: { getState: () => { storeReads += 1; return {}; } } },
    '../../constants': {},
    './messageMappers': { normalizeImportedBackupMessages: noop },
    './backupHelpers': {},
    './summaryCycle': {},
    './rawHistorySync': { syncRawHistoryMessages: async () => { databaseWrites += 1; } },
    './appUtils': { yieldToMainThread: async () => undefined },
    './backupData': {},
    './backupImportValidation': { validateBackupImportPayload },
    '../../services/db': { db: { transaction: async () => { databaseWrites += 1; } } },
    '../../services/appConfig': {},
    '../../services/userKnownLocation': {},
    '../../services/turnStateBackup': {},
    '../../services/backupRestoreSession': {
      runBackupRestoreSession: () => { throw new Error('Invalid import must not begin a restore session'); },
    },
    '../../services/dataRestoreGate': {},
    '../../services/backupMediaStaging': {},
    '../../services/reminderNativeCancellation': {},
    '../../services/desktopBackupService': {},
    '../../services/environment': {},
    '../../services/capacitorBackupNative': {},
    '../../services/dialogService': {},
    '../../services/backupProtection': {},
    '../../services/portableBackupCrypto.mjs': {},
    '../../services/backupArchiveValidation.mjs': {},
    '../../services/mediaWriteFence': {},
    '../../services/temporalEpisodeService': {},
    '../../services/imageService': {},
    '../../services/voiceFileService': {},
    '../../services/localRagService': {},
    '../../store/slices/ragSlice': {},
    '../../store/slices/reminderSlice': {},
    './appConstants': {},
  };
  const module = { exports: {} };
  vm.runInNewContext(js, {
    module,
    exports: module.exports,
    console,
    setTimeout,
    clearTimeout,
    require(id) {
      if (Object.prototype.hasOwnProperty.call(requireMap, id)) return requireMap[id];
      throw new Error(`Unexpected backupActions import: ${id}`);
    },
  }, { filename });
  return { restoreBackupData: module.exports.restoreBackupData, getStoreReads: () => storeReads, getDatabaseWrites: () => databaseWrites };
}

async function testInvalidRestoreDoesNotWriteState() {
  const loaded = loadBackupActionsForInvalidRestore();
  let uiWrites = 0;
  const result = await loaded.restoreBackupData({}, {
    isBulkRestoreInProgressRef: { current: false },
    rawHistorySyncedIdsRef: { current: new Set() },
    forceRawHistoryResyncRef: { current: false },
    updateMemoryQuerySession: () => { uiWrites += 1; },
    setWorldCharacterStatus: () => { uiWrites += 1; },
    setAutoSavedKumikoDiary: () => { uiWrites += 1; },
    setAutoSavedDailyFragments: () => { uiWrites += 1; },
    setAutoSavedPsycheState: () => { uiWrites += 1; },
    worldCharacterStatus: {},
    autoSavedKumikoDiary: [],
    autoSavedDailyFragments: [],
    autoSavedPsycheState: null,
  });
  assert.equal(result, null);
  assert.equal(loaded.getStoreReads(), 0, 'invalid backup must not read or mutate app state');
  assert.equal(loaded.getDatabaseWrites(), 0, 'invalid backup must not write persistence');
  assert.equal(uiWrites, 0, 'invalid backup must not update UI state');
}

function loadBackupFileParser(userDataDir) {
  const filename = path.join(root, 'electron', 'backup-files.cjs');
  const Module = require('module');
  const originalLoad = Module._load;
  delete require.cache[filename];
  Module._load = function patchedLoad(id, parent, isMain) {
    if (id === 'electron') return { app: { getPath: () => userDataDir } };
    if (id === './authorized-paths.cjs') return { isBackupPathAuthorized: () => true };
    return originalLoad.call(this, id, parent, isMain);
  };
  try {
    return require(filename).parseBackupImportFile;
  } finally {
    Module._load = originalLoad;
  }
}

async function testZipParserValidatesBeforeMediaWrite() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kumiko-backup-validation-'));
  try {
    const parseBackupImportFile = loadBackupFileParser(path.join(tempRoot, 'user-data'));
    const invalidZip = new JSZip();
    invalidZip.file('data.json', JSON.stringify({}));
    invalidZip.file('voice/should-not-write.mp3', Buffer.from('not-audio'));
    const invalidPath = path.join(tempRoot, 'invalid.zip');
    fs.writeFileSync(invalidPath, await invalidZip.generateAsync({ type: 'nodebuffer' }));
    await assert.rejects(() => parseBackupImportFile(invalidPath), /Invalid backup payload/);
    assert.equal(fs.existsSync(path.join(tempRoot, 'user-data', 'voice')), false, 'invalid ZIP must not create media directories');

    const validZip = new JSZip();
    validZip.file('data.json', JSON.stringify(currentExport()));
    validZip.file('voice/valid.mp3', Buffer.from('fixture-audio'));
    validZip.file('ringtone/custom.mp3', Buffer.from('fixture-ringtone'));
    fs.mkdirSync(path.join(tempRoot, 'user-data', 'voice'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, 'user-data', 'ringtone'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'user-data', 'voice', 'valid.mp3'), 'old-voice');
    fs.writeFileSync(path.join(tempRoot, 'user-data', 'ringtone', 'custom.mp3'), 'old-ringtone');
    const validPath = path.join(tempRoot, 'valid.zip');
    fs.writeFileSync(validPath, await validZip.generateAsync({ type: 'nodebuffer' }));
    const parsed = await parseBackupImportFile(validPath);
    assert.equal(parsed.success, true);
    assert.equal(parsed.json.data.messages.length, 0, 'valid empty export restores as an explicit empty backup');
    assert.deepEqual(Buffer.from(parsed.voices[0].base64, 'base64'), Buffer.from('fixture-audio'));
    assert.deepEqual(Buffer.from(parsed.ringtone.base64, 'base64'), Buffer.from('fixture-ringtone'));
    assert.equal(fs.readFileSync(path.join(tempRoot, 'user-data', 'voice', 'valid.mp3'), 'utf8'), 'old-voice');
    assert.equal(fs.readFileSync(path.join(tempRoot, 'user-data', 'ringtone', 'custom.mp3'), 'utf8'), 'old-ringtone');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

(async () => {
  ({ validateBackupImportPayload } = await import('../electron/backup-import-validation.mjs'));
  testValidationContract();
  await testInvalidRestoreDoesNotWriteState();
  await testZipParserValidatesBeforeMediaWrite();
  console.log('backup import validation regression tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
