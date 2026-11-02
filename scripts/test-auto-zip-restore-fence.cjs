'use strict';

// Run the production shutdown handler without Electron, user files or ZIP I/O.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../electron/auto-zip-backup.cjs'), 'utf8');

function load({ restoring = false, enabled = true, updating = false, memoryGeneration = '', writtenGeneration = '' } = {}) {
  const calls = { files: [], builds: [], quits: 0, prevented: 0, progress: [] };
  let restoreActive = restoring;
  let settle;
  const pending = new Promise(resolve => { settle = resolve; });
  const priorJson = path.join('isolated-fixture', 'kumiko_backup_previous.json');
  const dependencies = {
    fs: {
      existsSync(file) { calls.files.push(['exists', file]); return file === priorJson; },
      readFileSync(file) { calls.files.push(['read', file]); assert.equal(file, priorJson); return '{"dataset":"previous"}'; },
      readdirSync() { throw new Error('Unexpected directory scan'); },
    },
    path,
    electron: { app: { quit() { calls.quits++; }, getPath() { throw new Error('Unexpected profile access'); } } },
    './user-config.cjs': { readConfigValue: key => key === 'MemoryMaintenanceGeneration' ? memoryGeneration : enabled ? '1' : '0', writeConfigValue() {} },
    './backup-ipc.cjs': { getLastWrittenBackupPath: required => required && required !== writtenGeneration ? null : priorJson },
    './app-updater.cjs': { isUpdateInstalling: () => updating },
    './backup-zip-builder.cjs': { buildBackupZip(input) { calls.builds.push(input); return pending; } },
    './backup-protection.cjs': { enabled: () => false },
    '../electron-rag.cjs': { isDataRestoreActive: () => restoreActive, getDataRestoreGeneration: () => restoreActive ? 1 : 0 },
  };
  const sandbox = { module: { exports: {} }, console: { log() {}, error() {} },
    require(name) { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; } };
  vm.runInNewContext(source, sandbox, { filename: 'auto-zip-backup.cjs' });
  const api = sandbox.module.exports;
  api.setAutoZipProgressTarget({ isDestroyed: () => false, webContents: {
    send(channel, payload) { calls.progress.push({ channel, payload }); },
  } });
  const quit = () => api.runAutoZipBeforeQuit({ preventDefault() { calls.prevented++; } });
  return { api, calls, quit, setRestoring(value) { restoreActive = value; },
    finish: () => settle({ success: true, imagesIncluded: 0, imagesTotal: 0 }) };
}

(async () => {
  const h = load({ restoring: true });
  h.quit(); h.quit();
  assert.equal(h.calls.prevented, 0, 'Restore shutdown proceeds so its persistent journal can recover next launch');
  assert.equal(h.calls.quits, 0, 'Restore shortcut does not recurse into quit');
  assert.equal(h.calls.files.length, 0, 'Restore shutdown never reads the previous JSON or changing media/journal');
  assert.equal(h.calls.builds.length, 0, 'Existing automatic ZIP cannot be overwritten with mixed data');
  assert.equal(h.calls.progress.length, 0);

  h.setRestoring(false);
  h.quit();
  assert.equal(h.calls.prevented, 1);
  assert.equal(h.calls.builds.length, 1, 'A later healthy quit can still back up');
  assert.equal(h.calls.builds[0].dataJsonString, '{"dataset":"previous"}');
  assert.equal(h.calls.builds[0].mode, 'auto');
  assert.equal(path.basename(h.calls.builds[0].outputPath), 'kumiko_backup_auto.zip');
  assert.equal(h.calls.quits, 0, 'Normal exit waits for ZIP completion');
  h.finish();
  await new Promise(setImmediate);
  assert.equal(h.calls.quits, 1);
  h.quit();
  assert.equal(h.calls.builds.length, 1, 'Quit re-entry does not rebuild');

  for (const options of [{ enabled: false }, { updating: true }]) {
    const guarded = load(options); guarded.quit();
    assert.equal(guarded.calls.files.length, 0);
    assert.equal(guarded.calls.prevented, 0);
    assert.equal(guarded.calls.builds.length, 0);
  }
  const marked = load(); marked.api.markAutoBackupDone(true); marked.quit();
  assert.equal(marked.calls.builds.length, 0);
  const stale = load({ memoryGeneration:'corrected',writtenGeneration:'previous' });stale.quit();
  assert.equal(stale.calls.builds.length,0,'old in-memory backup path must not resurrect corrected material');
  assert.equal(stale.calls.files.length,0,'stale backup is not read');
  const fresh = load({ memoryGeneration:'corrected',writtenGeneration:'corrected' });fresh.quit();
  assert.equal(fresh.calls.builds.length,1,'a newly written clean backup remains usable');fresh.finish();
  const ipcSource=fs.readFileSync(path.join(__dirname,'../electron/backup-ipc.cjs'),'utf8');
  let marker='interrupted-preparation';
  const ipcDeps={path, 'node:fs':fs, electron:{app:{},dialog:{}}, './authorized-paths.cjs':{}, './backup-files.cjs':{},
    './backup-zip-builder.cjs':{}, './backup-protection.cjs':{}, './user-config.cjs':{readConfigValue:()=>marker,writeConfigValue:(_key,value)=>{marker=value;}}};
  const box={module:{exports:{}},require:id=>{assert.ok(Object.hasOwn(ipcDeps,id),id);return ipcDeps[id];},console};
  vm.runInNewContext(ipcSource+'\nmodule.exports.setFixture=(p,g)=>{lastWrittenBackupPath=p;lastWrittenBackupMemoryGeneration=g;}; module.exports.noteFixture=rememberSuccessfulBackup;',box);
  box.module.exports.setFixture('old.json','before');
  assert.equal(box.module.exports.getLastWrittenBackupPath('after'),null,'production getter rejects old generation');
  box.module.exports.setFixture('clean.json','after');
  assert.equal(box.module.exports.getLastWrittenBackupPath('after'),'clean.json','production getter accepts matching generation');
  box.module.exports.noteFixture('fresh-after-crash.json','initial');
  assert.equal(marker,'initial','a successful clean save recovers an interrupted pre-journal marker');
  assert.equal(box.module.exports.getLastWrittenBackupPath(marker),'fresh-after-crash.json');
  console.log('Auto-ZIP restore fence passed: preserve previous ZIP/journal, healthy shutdown, completion and re-entry guards.');
})().catch(error => { console.error(error); process.exitCode = 1; });
