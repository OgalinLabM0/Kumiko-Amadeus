const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
const images = new Map(), imageSources = new Map(), voices = new Map(), ledgerRows = new Map();
const compile = file => ts.transpileModule(fs.readFileSync(file,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const recordBox={exports:{}};vm.runInNewContext(compile('services/voiceWriteRecord.ts'),{module:recordBox,exports:recordBox.exports});
const remapBox={exports:{}};vm.runInNewContext(compile('services/backupVoiceRemap.ts'),{module:remapBox,exports:remapBox.exports,
  require:name=>{assert.equal(name,'./voiceWriteRecord');return recordBox.exports;}});
const sharedDeps={
  './memoryMaintenanceGate':{getMemoryGeneration:()=> 'initial'},
  './mediaWriteFence':{withMediaWriteFence:async(_version,work)=>work()},
  './voiceWriteRecord':recordBox.exports,'./backupVoiceRemap':remapBox.exports,
  './turnStateBackup':{getBackupExecutionState:source=>source?.data?.executionState??source?.executionState,
    executionStateEntries:state=>state?.entries||[],packExecutionState:async entries=>({version:3,entries})},
  './voiceWriteLedger':{beginVoiceWrite:async input=>{const now=Date.now();ledgerRows.set('kumiko_voice_write_v1:'+input.id,
    {version:1,...input,status:'reserved',createdAt:now,updatedAt:now,attempt:0,retryAt:now});},
    finishVoiceWrite:async id=>{const row=ledgerRows.get('kumiko_voice_write_v1:'+id);if(row)row.status='pending';return !!row;}},
};
let voiceFails = false;
const imageService = {
  saveImageWithId: async (id, data, _strict, _version, sources) => { images.set(id, data); imageSources.set(id, sources); },
  getImageBase64: async id => images.get(id),
};
const voice = {
  isVoiceServiceAvailable: () => true,
  saveVoiceFile: async (id, bytes) => { assert.ok(ledgerRows.has('kumiko_voice_write_v1:'+id),'voice must be registered before write'); if (voiceFails) return false; voices.set(id, bytes); return true; },
  loadVoiceFile: async id => voices.get(id),
};
const moduleObject = { exports: {} };
const source = fs.readFileSync('services/backupMediaStaging.ts', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mockRequire = name => {
  if (name === './imageService') return { imageService };
  if (name === './voiceFileService') return voice;
  if (name === './environment') return { isCapacitorNative: () => false };
  if (name === './db') return { db: {keyval:{get:async key=>ledgerRows.has(key)?{key,value:structuredClone(ledgerRows.get(key))}:undefined}} };
  if (name === './dataRestoreGate') return { getDataRestoreVersion: () => 'fixture' };
  if (sharedDeps[name]) return sharedDeps[name];
  if (name === 'dexie') return {};
  throw new Error(name);
};
vm.runInNewContext(compiled, { module: moduleObject, exports: moduleObject.exports, require: mockRequire, crypto, structuredClone, atob, btoa, Uint8Array, ArrayBuffer, Map, Error });
function ringtoneHarness(capacitor = false) {
  let current = null, copy = null, readError = false, failAfterWrite = false;
  let activeTx = null;
  const recoveryId = 'authorized-restore';
  const dexie = { currentTransaction: null };
  const gateModule = { exports: {} };
  const gateSource = fs.readFileSync('services/dataRestoreGate.ts', 'utf8');
  const gateCode = ts.transpileModule(gateSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(gateCode, { module: gateModule, exports: gateModule.exports, WeakSet, JSON, Error, Date });
  const gate = gateModule.exports;
  gate.beginDataRestore(recoveryId);
  const bytes = text => Uint8Array.from(Buffer.from(text)).buffer;
  const keyval = {
    put: async row => {
      assert.ok(activeTx, 'keyval write requires a transaction');
      gate.assertDataTransactionAllowed(activeTx.idbtrans);
      current = row.value;
    },
    delete: async () => {
      assert.ok(activeTx, 'keyval delete requires a transaction');
      gate.assertDataTransactionAllowed(activeTx.idbtrans);
      current = null;
    },
  };
  const db = {
    keyval,
    getVal: async () => { if (readError) throw new Error('read denied'); return current; },
    transaction: async (_mode, _table, fn) => {
      activeTx = { idbtrans: {} }; dexie.currentTransaction = activeTx;
      try { return await fn(); } finally { activeTx = null; dexie.currentTransaction = null; }
    },
  };
  const ipc = { invoke: async name => {
    assert.equal(name, 'ringtone:load');
    if (readError) return { success: false, error: 'read denied' };
    if (!current) return { success: false };
    return { success: true, buffer: bytes(Buffer.from(current.base64, 'base64').toString()), fileName: `custom.${current.ext}`, displayName: current.originalName };
  } };
  const api = {
    isVoiceServiceAvailable: () => true,
    saveRingtoneFile: async (buffer, ext, originalName) => {
      current = { base64: Buffer.from(buffer).toString('base64'), ext, originalName };
      if (failAfterWrite) { failAfterWrite = false; return false; }
      return true;
    },
    deleteRingtoneFile: async () => { current = null; return true; },
    loadRingtoneFileWithName: async () => current && ({ buffer: bytes(Buffer.from(current.base64, 'base64').toString()), fileName: `custom.${current.ext}`, displayName: current.originalName }),
    restoreNativeRingtoneCopy: async entry => {
      copy = entry ? Buffer.from(entry.buffer).toString() : null;
      if (failAfterWrite) { failAfterWrite = false; throw new Error('native copy write failed'); }
    },
  };
  const mod = { exports: {} };
  const requireMock = name => {
    if (name === './imageService') return { imageService };
    if (name === './voiceFileService') return api;
    if (name === './environment') return { isCapacitorNative: () => capacitor };
    if (name === './db') return { db };
    if (name === './dataRestoreGate') return gate;
    if (sharedDeps[name]) return sharedDeps[name];
    if (name === 'dexie') return { default: dexie };
    throw new Error(name);
  };
  vm.runInNewContext(compiled, { module: mod, exports: mod.exports, require: requireMock, crypto, structuredClone, atob, btoa, Uint8Array, ArrayBuffer, Map, Error, window: capacitor ? {} : { electronAPI: ipc } });
  return {
    ...mod.exports, recoveryId,
    set: value => { current = value ? { base64: Buffer.from(value).toString('base64'), ext: 'mp3', originalName: 'old.mp3' } : null; copy = value; },
    get: () => current ? Buffer.from(current.base64, 'base64').toString() : null,
    copy: () => copy,
    failRead: value => { readError = value; },
    failWrite: () => { failAfterWrite = true; },
  };
}

async function testRingtoneRecovery(capacitor) {
  const h = ringtoneHarness(capacitor);
  const prepare = () => h.prepareBackupMedia({ messages: [] }, [], { ringtone: { base64: 'Qg==', ext: 'mp3', originalName: 'new.mp3' } });
  h.set('A');
  let hooks = (await prepare()).hooks;
  const original = await hooks.snapshot();
  await hooks.commit(h.recoveryId);
  assert.equal(h.get(), 'B');
  if (capacitor) assert.equal(h.copy(), 'B');
  await h.rollbackPreparedBackupMedia(original, h.recoveryId);
  assert.equal(h.get(), 'A');
  if (capacitor) assert.equal(h.copy(), 'A');

  hooks = (await prepare()).hooks;
  const beforeFailure = await hooks.snapshot();
  h.failWrite();
  await assert.rejects(() => hooks.commit(h.recoveryId), /write failed/i);
  await h.rollbackPreparedBackupMedia(beforeFailure, h.recoveryId);
  assert.equal(h.get(), 'A');
  if (capacitor) assert.equal(h.copy(), 'A');

  h.set(null);
  hooks = (await prepare()).hooks;
  const absent = await hooks.snapshot();
  assert.equal(absent.present, false);
  await hooks.commit(h.recoveryId);
  await h.rollbackPreparedBackupMedia(absent, h.recoveryId);
  await h.rollbackPreparedBackupMedia(absent, h.recoveryId);
  assert.equal(h.get(), null);
  if (capacitor) assert.equal(h.copy(), null);
  h.failRead(true);
  await assert.rejects(() => hooks.snapshot(), /read denied/);
  h.failRead(false);
  if (capacitor) {
    await assert.rejects(() => hooks.commit('wrong-id'), /not owned/);
    assert.equal(h.get(), null);
  }
}

(async () => {
  const { prepareBackupMedia } = moduleObject.exports;
  voices.set('same', Uint8Array.from([9]).buffer);
  const source = { data: { executionState: {version:3,entries:[
    {key:'kumiko_voice_write_v1:same',value:{version:1,id:'same',sourceIds:['source-original'],memoryGeneration:'initial',status:'pending',createdAt:1,updatedAt:1,attempt:0,retryAt:1}},
    {key:'runtime13:test',value:{voiceFileId:'same',nested:{voiceFileId:'unavailable'},sourceIds:['same'],eventId:'same'}},
  ]}, messages: [
    { id: '1', imageId: 'same', voiceFileId: 'same' },
    { id: '2', imageId: 'missing-image', voiceFileId: 'missing-voice' },
    { id: '3', image: 'data:image/png;base64,YWJj' },
  ] } };
  const result = await prepareBackupMedia(source, [{ id: 'same', dataUrl: 'data:image/png;base64,YWJj' }], { voices: [{ id: 'same', base64: 'ZGVm' }] });
  const rows = result.json.data.messages;
  assert.notEqual(rows[0].imageId, 'same');
  assert.notEqual(rows[0].voiceFileId, 'same');
  assert.equal(images.get(rows[0].imageId), 'data:image/png;base64,YWJj');
  assert.deepEqual([...new Uint8Array(voices.get(rows[0].voiceFileId))], [100,101,102]);
  assert.notEqual(rows[1].imageId, 'missing-image');
  assert.notEqual(rows[1].voiceFileId, 'missing-voice');
  assert.equal(result.missingMediaCount, 3);
  assert.ok(rows[2].imageId);
  assert.deepEqual([...imageSources.get(rows[0].imageId)], ['1']);
  assert.deepEqual([...imageSources.get(rows[2].imageId)], ['3']);
  assert.equal(rows[2].image, undefined);
  assert.equal(source.data.messages[0].imageId, 'same');
  const stagedEntries = result.json.data.executionState.entries;
  const stagedLedger = stagedEntries.find(e => e.key === 'kumiko_voice_write_v1:' + rows[0].voiceFileId);
  assert.ok(stagedLedger);
  assert.deepEqual([...stagedLedger.value.sourceIds].sort(), ['1','source-original']);
  const task = stagedEntries.find(e => e.key === 'runtime13:test').value;
  assert.equal(task.voiceFileId, rows[0].voiceFileId);
  assert.notEqual(task.nested.voiceFileId, 'unavailable');
  assert.equal(task.sourceIds[0], 'same');
  assert.equal(task.eventId, 'same');
  assert.equal(ledgerRows.get(stagedLedger.key).status, 'reserved');
  await result.releaseVoiceLeases();
  assert.equal(ledgerRows.get(stagedLedger.key).status, 'pending');
  assert.deepEqual([...new Uint8Array(voices.get('same'))], [9]);
  const beforeFailure = new Set(ledgerRows.keys());
  voiceFails = true;
  await assert.rejects(() => prepareBackupMedia(source, [], { voices: [{ id: 'same', base64: 'ZGVm' }] }), /voice write failed/);
  const failed = [...ledgerRows].find(([key]) => !beforeFailure.has(key));
  assert.ok(failed, 'failed import must retain a cleanup obligation');
  assert.equal(failed[1].status, 'pending');
  await assert.rejects(() => prepareBackupMedia(source, [{ id: 'x', dataUrl: 'data:image/png;base64,YWJj' }, { id: 'x', dataUrl: 'data:image/png;base64,YWJj' }]), /Duplicate/);
  await testRingtoneRecovery(false);
  await testRingtoneRecovery(true);
  console.log('backup media staging regression tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
