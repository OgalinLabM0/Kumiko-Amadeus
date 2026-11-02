'use strict';
// Synthetic data only. Exercises portable envelope, archive validation,
// desktop assembly/import and protected-file preservation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const JSZip = require('jszip');
const vm = require('node:vm');
const ts = require('typescript');
(async () => {
  const crypto = await import('../services/portableBackupCrypto.mjs');
  const { validateBackupArchive, createBackupArchiveReader } = await import('../services/backupArchiveValidation.mjs');
  const secret = 'fixture-passphrase';
  const plain = new TextEncoder().encode('synthetic backup');
  const envelope = await crypto.encryptPortableBackup(plain, secret, 'json');
  assert.equal(new TextDecoder().decode((await crypto.decryptPortableBackup(envelope, secret)).bytes), 'synthetic backup');
  await assert.rejects(crypto.decryptPortableBackup(envelope, 'wrong-password'), /password|corrupted/i);
  const header = JSON.parse(envelope.slice('KUMIKO-BACKUP-1\n'.length));
  header.kind = 'zip';
  await assert.rejects(crypto.decryptPortableBackup('KUMIKO-BACKUP-1\n' + JSON.stringify(header), secret), /password|corrupted/i);
  const zip = new JSZip(); zip.file('../escape', 'x');
  const invalid = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer' }));
  assert.throws(() => validateBackupArchive(invalid), /path/i);
  const source = fs.readFileSync(path.join(__dirname, '../components/app/backupActions.ts'), 'utf8');
  const begin = source.indexOf('async function buildWebBackupZipBlob(');
  const end = source.indexOf('// handleImportBackup', begin);
  const exportSource = source.slice(begin, end).replace('export async function handleExportBackup', 'async function handleExportBackup');
  const unicodeMemory = '久美子 🎶\n'.repeat(9000);
  let exportedBytes;
  for (const mobile of [false, true]) {
    let output;
    const state = { language: 'en', setSystemNotice() {} };
    const table = { orderBy: () => ({ toArray: async () => [] }), get: async () => null };
    const context = { JSZip, Blob, Uint8Array, TextEncoder, Date, console, validateBackupArchive,
      require: id => { if (id === '../../services/runtimeBackupSnapshot') return { captureRuntimeBackupData: async data => ({ ...data, kumikoDiary: [], dailyFragments: [], psycheState: null, episodes: [], userKnownLocation: null }) }; throw new Error('Unexpected fixture dependency ' + id); },
      imageService: { getAllImages: async () => [] }, isVoiceServiceAvailable: () => false,
      getDataRestoreVersion: () => 'v1', withMediaWriteFence: async (_v, work) => work(),
      useAppStore: { getState: () => state }, getAllVectors: async () => [], db: { kumikoDiary: table, dailyFragments: table, psycheState: table, episodes: table },
      getUserKnownLocation: async () => null, exportTurnExecutionState: async () => undefined,
      protectionStatus: async () => true, getSessionBackupPassword: () => secret,
      encryptPortableBackup: crypto.encryptPortableBackup, isDesktopElectron: () => false, isCapacitorNative: () => mobile,
      exportBackupZipNative: async (blob, name) => { output = { blob, name }; return { ok: true }; },
      saveAs: (blob, name) => { output = { blob, name }; }, dialogService: { alert: x => { throw new Error(x.message); } },
    };
    const js = ts.transpileModule(exportSource + '\nthis.runExport = handleExportBackup;', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(js, context);
    await context.runExport({ messages: [], coreMemory: unicodeMemory });
    assert.match(output.name, /\.kab$/);
    const decoded = await crypto.decryptPortableBackup(await output.blob.text(), secret);
    assert.equal(decoded.kind, 'zip');
    const exportedZip = await JSZip.loadAsync(decoded.bytes);
    assert.ok(exportedZip.file('data.json'), mobile ? 'Android export' : 'web export');
    assert.equal(JSON.parse(await createBackupArchiveReader(exportedZip).read(exportedZip.file('data.json'))).data.coreMemory, unicodeMemory, 'emoji survives ZIP string chunk boundaries');
    exportedBytes = await output.blob.arrayBuffer();
  }
  const importStart = source.indexOf('export async function handleImportBackup(');
  const importEnd = source.indexOf('// handleCloudRestore removed', importStart);
  const importSource = source.slice(importStart, importEnd).replace('export async function handleImportBackup', 'async function handleImportBackup');
  for (const password of ['incorrect', secret]) {
    let restores = 0;
    const context = { JSZip: { loadAsync: async blob => JSZip.loadAsync(Buffer.from(await blob.arrayBuffer())) }, Blob, Uint8Array, TextEncoder, TextDecoder, Date, console,
      useAppStore: { getState: () => ({ language: 'en', flowState: 'AUTH', backupConfig: {} }) },
      isDataRestoreBlocked: () => false, getDataRestoreVersion: () => 'v1', isDesktopElectron: () => false,
      isEncryptedBackup: crypto.isEncryptedBackup, decryptPortableBackup: crypto.decryptPortableBackup, validateBackupArchive, createBackupArchiveReader,
      dialogService: { prompt: async () => password, alert: async () => {} }, yieldToMainThread: async () => {},
      getBackupExecutionState() {}, validateBackupImportPayload: () => ({ valid: true }),
    };
    const js = ts.transpileModule(importSource + '\nthis.runImport = handleImportBackup;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(js, context);
    const result = await context.runImport(new File([exportedBytes], 'fixture.kab'), {
      restoreParsedBackupPayload: async () => { restores++; return {}; }, updateBaseline() {},
    });
    assert.equal(result, password === secret);
    assert.equal(restores, password === secret ? 1 : 0, 'wrong password must not begin restore');
  }
  const sessionSource = fs.readFileSync(path.join(__dirname, '../services/backupProtection.ts'), 'utf8');
  const sessionModule = { exports: {} };
  const settings = new Map();
  vm.runInNewContext(ts.transpileModule(sessionSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module: sessionModule, exports: sessionModule.exports, TextEncoder, TextDecoder,
    localStorage: { getItem: key => settings.get(key) ?? null, setItem: (key, value) => settings.set(key, value) },
    require(id) { if (id === './desktopBackupService') return { isDesktopElectron: () => false }; if (id === './portableBackupCrypto.mjs') return crypto; throw new Error(id); },
  });
  const session = sessionModule.exports;
  const handleFor = text => ({ getFile: async () => new File([text], 'fixture.kab') });
  await session.enableProtection(secret);
  const protectedJson = await session.protectSessionJson('{"data":{}}', handleFor(''));
  assert.equal(await session.openSessionJson(protectedJson), '{"data":{}}');
  await assert.rejects(session.protectSessionJson('{}', handleFor('old plaintext')), /plaintext/i);
  session.clearSessionBackupPassword();
  assert.equal(await session.protectionStatus(), true, 'protection choice survives loss of session password');
  assert.equal(session.requiresSessionBackupPassword(), true);
  await assert.rejects(session.protectSessionJson('{}', handleFor('')), /password/i, 'new exports must not silently fall back to plaintext');
  await assert.rejects(session.protectSessionJson('{}', handleFor(protectedJson)), /password/i);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-portable-test-'));
  const oldLoad = Module._load;
  Module._load = function (id, parent, main) {
    if (id === 'electron') return { app: { getPath: () => dir } };
    if (id === './authorized-paths.cjs') return { isBackupPathAuthorized: () => true };
    return oldLoad.call(this, id, parent, main);
  };
  let builder, parser;
  try { builder = require('../electron/backup-zip-builder.cjs'); parser = require('../electron/backup-files.cjs'); }
  finally { Module._load = oldLoad; }
  try {
    const data = { timestamp: 1, version: '1.3', data: { messages: [], worldBook: [], coreMemory: '', contextLimit: 100, turnCount: 0, summaryArchiveState: {}, currentEmotion: 'neutral', locationConfig: {}, language: 'zh', anchors: [], kumikoNotebook: '', relativeReminders: [], dailyReminders: [] } };
    data.data.coreMemory = unicodeMemory;
    const out = path.join(dir, 'test.kab');
    assert.equal((await builder.buildBackupZip({ dataJsonString: JSON.stringify(data), mode: 'manual', outputPath: out, userDataDir: dir, password: secret })).success, true);
    assert.ok(crypto.isEncryptedBackup(fs.readFileSync(out, 'utf8')));
    const saved = fs.readFileSync(out);
    await assert.rejects(parser.parseBackupImportFile(out, 'wrong-password'), /password|corrupted/i);
    assert.equal((await parser.parseBackupImportFile(out, secret)).json.data.messages.length, 0);
    assert.equal((await parser.parseBackupImportFile(out, secret)).json.data.coreMemory, unicodeMemory);
    assert.equal((await builder.buildBackupZip({ dataJsonString: JSON.stringify(data), mode: 'manual', outputPath: out, userDataDir: dir, password: 'other-password' })).success, false);
    assert.deepEqual(fs.readFileSync(out), saved);
    const legacy = path.join(dir, 'legacy.zip'); fs.writeFileSync(legacy, 'existing plaintext');
    assert.equal((await builder.buildBackupZip({ dataJsonString: JSON.stringify(data), mode: 'manual', outputPath: legacy, userDataDir: dir, password: secret })).success, false);
    assert.equal(fs.readFileSync(legacy, 'utf8'), 'existing plaintext');
    const cancelled = path.join(dir, 'cancelled.kab');
    assert.equal((await builder.buildBackupZip({ dataJsonString: JSON.stringify(data), mode: 'auto', outputPath: cancelled, userDataDir: dir, password: secret, canCommit: () => false })).success, false);
    assert.equal(fs.existsSync(cancelled), false, 'old shutdown backup cannot commit after reset');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const secureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ka-backup-vault-test-'));
  let secureAvailable = true;
  const safeStorage = { isEncryptionAvailable: () => secureAvailable, encryptString: s => Buffer.from('fixture:' + s), decryptString: b => b.toString().slice(8) };
  Module._load = function (id, parent, main) {
    if (id === 'electron') return { app: { getPath: () => secureDir }, safeStorage };
    return oldLoad.call(this, id, parent, main);
  };
  let protection;
  try { protection = require('../electron/backup-protection.cjs'); }
  finally { Module._load = oldLoad; }
  try {
    assert.equal(protection.enabled(), false);
    secureAvailable = false;
    await assert.rejects(protection.enable(secret), /storage/i);
    assert.equal(protection.enabled(), false, 'failed secure storage cannot enable protection');
    secureAvailable = true; await protection.enable(secret);
    assert.equal(await protection.key(), secret);
    Module._load = function (id, parent, main) {
      if (id === 'electron') return { app: { getPath: () => secureDir }, safeStorage, dialog: {} };
      if (id === './authorized-paths.cjs') return { isBackupPathAuthorized: () => true, authorizeBackupPath() {} };
      if (id === '../electron-rag.cjs') return { isDataRestoreActive: () => false, getDataRestoreGeneration: () => 0, isDataResetOwner: (event, token) => event?.sender === 'owner' && token === 'reset-token' };
      return oldLoad.call(this, id, parent, main);
    };
    const ipc = require('../electron/backup-ipc.cjs');
    const jsonPath = path.join(secureDir, 'sync.kab');
    const payload = JSON.stringify({ data: { messages: [] } });
    assert.equal((await ipc.handleWriteFile({}, { filePath: jsonPath, content: payload })).success, true);
    assert.ok(crypto.isEncryptedBackup(fs.readFileSync(jsonPath, 'utf8')));
    assert.equal((await ipc.handleReadFile({}, { filePath: jsonPath })).content, payload);
    const beforeDenied = fs.readFileSync(jsonPath);
    assert.equal((await ipc.handleProtectionClear({ sender: 'other' }, { restoreSessionId: 'reset-token' })).success, false);
    assert.equal(protection.enabled(), true, 'foreign reset cannot clear backup key');
    secureAvailable = false;
    await assert.rejects(protection.key(), /storage/i);
    assert.equal((await ipc.handleWriteFile({}, { filePath: jsonPath, content: 'changed' })).success, false);
    assert.deepEqual(fs.readFileSync(jsonPath), beforeDenied, 'key outage preserves last backup');
    assert.equal(protection.enabled(), true, 'storage outage must not permit plaintext fallback');
    assert.equal((await ipc.handleProtectionClear({ sender: 'owner' }, { restoreSessionId: 'reset-token' })).success, true);
    assert.equal((await ipc.handleProtectionClear({ sender: 'owner' }, { restoreSessionId: 'reset-token' })).success, true);
    assert.equal(protection.enabled(), false, 'reset is idempotent');
    assert.equal((await ipc.handleWriteFile({}, { filePath: jsonPath, content: 'plaintext' })).success, false);
    assert.deepEqual(fs.readFileSync(jsonPath), beforeDenied, 'protected file cannot silently become plaintext');
  } finally { Module._load = oldLoad; fs.rmSync(secureDir, { recursive: true, force: true }); }
  console.log('Portable backup passed: encryption, tamper/password rejection, unsafe paths, desktop ZIP import and preservation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
