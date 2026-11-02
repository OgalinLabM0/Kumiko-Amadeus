'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const prefix = 'kumiko-diary-index-test-';
const flag = '--diary-profile=';
function safe(dir) {
  const real = fs.realpathSync(dir);
  if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith(prefix) || fs.lstatSync(dir).isSymbolicLink()) throw Error('Unsafe profile');
  return real;
}
if (!process.versions.electron) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawnSync(require('electron'), [__filename, flag + dir], { env, cwd: root, windowsHide: true, encoding: 'utf8', timeout: 90000 });
  const receipt = path.join(safe(dir), 'passed.json');
  const passed = child.status === 0 && fs.existsSync(receipt) && JSON.parse(fs.readFileSync(receipt)).passed === true;
  if (!passed) { console.error('Diary Electron checks failed:', child.status, child.error?.message); process.stderr.write(child.stdout || ''); process.stderr.write(child.stderr || ''); }
  else console.log('Real Electron diary IndexedDB: atomic save, legacy reconciliation, concurrent claims, index retry, reset recovery and restart passed.');
  fs.rmSync(safe(dir), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  process.exitCode = passed ? 0 : 1;
} else {
  const { app, BrowserWindow } = require('electron');
  const ts = require('typescript');
  const dir = safe(process.argv.find(x => x.startsWith(flag)).slice(flag.length));
  app.setPath('userData', dir); app.setPath('sessionData', dir);
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('in-process-gpu');
  const page = path.join(dir, 'test.html'); fs.writeFileSync(page, '<!doctype html><title>Fixture</title>');
  const sources = {};
  for (const name of ['services/db', 'services/dataRestoreGate', 'services/memoryMaintenanceGate', 'services/mediaWriteFence', 'services/backgroundJobs', 'services/diaryIndexJobs', 'services/dataResetSession']) {
    sources[name] = ts.transpileModule(fs.readFileSync(path.join(root, name + '.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  }
  const bootstrap = `(() => {
    const sources = ${JSON.stringify(sources)}, cache = {};
    function load(name) {
      if (name === 'dexie') return require(${JSON.stringify(require.resolve('dexie'))});
      if (name === 'services/environment') return { isCapacitorNative: () => false, getCapacitorPlatform: () => 'web' };
      if (name === 'services/preferencesSync') return { noteKeyvalPreferenceWrite() {} };
      if (name === 'services/androidAlarmService') return {};
      if (name === 'services/reminderNativeCancellation') return {};
      if (name === 'services/backupProtection') return { clearSessionBackupPassword() {} };
      if (name === 'services/llmCore') return { clearBrowserModelCredentials() {} };
      if (name === 'services/tavilyCredentials') return { clearBrowserSearchCredential() {} };
      if (cache[name]) return cache[name].exports;
      if (!sources[name]) throw Error('Unexpected dependency: ' + name);
      const module = { exports: {} }; cache[name] = module;
      const from = name.slice(0, name.lastIndexOf('/'));
      new Function('require', 'module', 'exports', sources[name])(id => load(id.startsWith('.') ? require('node:path').posix.normalize(from + '/' + id) : id), module, module.exports);
      return module.exports;
    }
    window.fetch = async () => { throw Error('Network forbidden'); };
    window.testDB = load('services/db').db; window.jobs = load('services/backgroundJobs');
    window.diary = load('services/diaryIndexJobs'); window.assert = require('node:assert/strict');
    window.reset = load('services/dataResetSession'); window.gate = load('services/dataRestoreGate');
    window.mediaFence = load('services/mediaWriteFence');
    return testDB.open().then(() => true);
  })()`;
  app.whenReady().then(async () => {
    const windows = [];
    async function open() { const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } }); windows.push(w); await w.loadFile(page); await w.webContents.executeJavaScript(bootstrap); return w; }
    const a = await open(), b = await open();
    const run = (w, code) => w.webContents.executeJavaScript('(async () => {' + code + '})()');
    await run(a, `
      const fail = () => { throw Error('injected'); };
      testDB.runtimeJobs.hook('creating', fail);
      await assert.rejects(diary.saveDiaryWithIndexJob({ id:'atomic', date:'2026-01-01', timestamp:1, content:'text' }), /injected/);
      testDB.runtimeJobs.hook('creating').unsubscribe(fail);
      assert.equal(await testDB.kumikoDiary.get('atomic'), undefined);
      await testDB.kumikoDiary.put({id:'legacy', date:'2026-01-02', timestamp:2, content:'legacy'});
      await diary.reconcileDiaryIndexJobs();
      const rows = await testDB.runtimeJobs.toArray();
      assert.equal(rows.length, 1); assert.equal(rows[0].sourceId, 'legacy');
    `);
    const claims = await Promise.all([run(a, `window.claim = await jobs.claimBackgroundJob('diary-index','a'); return !!claim;`), run(b, `window.claim = await jobs.claimBackgroundJob('diary-index','b'); return !!claim;`)]);
    if (claims.filter(Boolean).length !== 1) throw Error('Concurrent claims were not exclusive');
    const owner = claims[0] ? a : b;
    await run(owner, `
      await jobs.finishBackgroundJob(claim, 'retrying', Error('fixture failure'));
      await assert.rejects(jobs.finishBackgroundJob(claim, 'completed'), /expired|superseded/);
      const row = await testDB.runtimeJobs.get(claim.job.id);
      row.status = 'failed'; row.attempt = 8; await testDB.runtimeJobs.put(row);
      assert.equal(await jobs.retryFailedBackgroundJobs(), 1);
      assert.equal((await testDB.runtimeJobs.get(row.id)).previousAttempts, 8);
    `);
    await run(a, `testDB.close()`); await a.loadFile(page); await a.webContents.executeJavaScript(bootstrap);
    await run(a, `
      const rows = await testDB.runtimeJobs.toArray();
      assert.equal(rows.length, 1); assert.equal(rows[0].status, 'pending');
      const claim = await jobs.claimBackgroundJob('diary-index','after-restart'); assert.ok(claim);
      await testDB.keyval.put({key:'kumiko_turn_epoch_v1', value:'restored'});
      await assert.rejects(jobs.finishBackgroundJob(claim, 'completed'), /restored|expired/);
    `);
    await run(a, `
      let stored = null, saves = 0, wrongRead = true;
      window.electronAPI = { invoke: async (channel, payload) => {
        if (channel === 'rag:diary-lease') return {success:true};
        if (channel === 'rag:save') { saves++; stored = {...payload}; return {success:true}; }
        if (channel === 'rag:get-by-id') return {success:true, row: stored && {id:stored.id,
          text: wrongRead ? 'wrong version' : stored.text, canonicalKey:stored.canonicalKey, timestamp:stored.timestamp}};
        throw Error('Unexpected native fixture call ' + channel);
      }};
      const entry = {id:'new',date:'2026-01-03',timestamp:3,content:'new diary'};
      await diary.saveDiaryWithIndexJob(entry);
      const id = 'diary:new:' + await diary.diaryIndexVersion(entry);
      await diary.runDiaryIndexJob('first', id);
      let row = await testDB.runtimeJobs.get(id); assert.equal(row.status, 'retrying'); assert.equal(saves, 1);
      wrongRead = false; row.retryAt = 0; await testDB.runtimeJobs.put(row);
      const failReceipt = mods => { if (mods.status === 'completed') throw Error('receipt failed'); };
      testDB.runtimeJobs.hook('updating', failReceipt);
      await diary.runDiaryIndexJob('second', id);
      testDB.runtimeJobs.hook('updating').unsubscribe(failReceipt);
      row = await testDB.runtimeJobs.get(id); assert.equal(row.status, 'retrying'); assert.equal(saves, 1);
      row.retryAt = 0; await testDB.runtimeJobs.put(row);
      await diary.runDiaryIndexJob('third', id);
      row = await testDB.runtimeJobs.get(id); assert.equal(row.status, 'completed'); assert.equal(saves, 1);
      window.electronAPI = { invoke: async () => { throw Error("No handler registered for 'rag:diary-lease'"); } };
      const offline = {id:'offline',date:'2026-01-04',timestamp:4,content:'offline diary'};
      await diary.saveDiaryWithIndexJob(offline);
      assert.equal((await testDB.kumikoDiary.get('offline')).content, 'offline diary');
      const offlineId = 'diary:offline:' + await diary.diaryIndexVersion(offline);
      assert.equal((await testDB.runtimeJobs.get(offlineId)).status, 'pending');
      window.electronAPI = { invoke: async (channel, payload) => {
        if (channel === 'rag:diary-lease') return {success:true};
        if (channel === 'rag:save') { saves++; stored = {...payload}; return {success:true}; }
        if (channel === 'rag:get-by-id') return {success:true, row: stored && {id:stored.id, text:stored.text,
          canonicalKey:stored.canonicalKey, timestamp:stored.timestamp}};
        throw Error('Unexpected native fixture call');
      }};
      const revised = {...offline, content:'edited diary'};
      await diary.saveDiaryWithIndexJob(revised);
      await diary.runDiaryIndexJob('old', offlineId);
      assert.equal((await testDB.runtimeJobs.get(offlineId)).status, 'superseded');
      const revisedId = 'diary:offline:' + await diary.diaryIndexVersion(revised);
      await diary.runDiaryIndexJob('new', revisedId);
      assert.equal((await testDB.runtimeJobs.get(revisedId)).status, 'completed');
      const removed = {id:'removed',date:'2026-01-05',timestamp:5,content:'deleted'};
      await diary.saveDiaryWithIndexJob(removed);
      const removedId = 'diary:removed:' + await diary.diaryIndexVersion(removed);
      await testDB.kumikoDiary.delete('removed');
      await diary.runDiaryIndexJob('removed', removedId);
      assert.equal((await testDB.runtimeJobs.get(removedId)).status, 'superseded');
    `);
    await run(a, `
      window.failReset = true;
      window.electronAPI = { invoke: async (channel, payload) => {
        if (channel === 'credentials:clear-user-credentials' && failReset) return {success:false,error:'injected failure'};
        if (channel === 'rag:restore') return {success:true,count:0};
        if (channel === 'images:list' || channel === 'voice:list') return {success:true,files:[]};
        return {success:true};
      }};
      const d = {id:'before-reset', date:'2026-02-01', timestamp:6, content:'fixture'};
      await diary.saveDiaryWithIndexJob(d);
      const id = 'diary:before-reset:' + await diary.diaryIndexVersion(d);
      window.preResetClaim = await jobs.claimBackgroundJob('diary-index','old-reset',id);
      assert.ok(preResetClaim);
      await assert.rejects(reset.runDataResetSession(), /injected failure/);
      assert.equal(gate.readDataRestoreGate().kind, 'reset');
      assert.ok(await testDB.kumikoDiary.get('before-reset'));
      await assert.rejects(jobs.finishBackgroundJob(preResetClaim, 'completed'), /restor|paused|expired/i);
      testDB.close();
    `);
    await a.loadFile(page); await a.webContents.executeJavaScript(bootstrap);
    await run(a, `
      assert.equal(gate.readDataRestoreGate().kind, 'reset');
      window.electronAPI = { invoke: async channel => {
        if (channel === 'rag:restore') return {success:true,count:0};
        if (channel === 'images:list' || channel === 'voice:list') return {success:true,files:[]};
        return {success:true};
      }};
      assert.equal(await reset.recoverInterruptedDataReset(), true);
      assert.equal(gate.readDataRestoreGate(), null);
      assert.equal(gate.requiresDataRestoreReload(), true);
      assert.equal(await testDB.kumikoDiary.count(), 0);
      testDB.close();
    `);
    await a.loadFile(page); await a.webContents.executeJavaScript(bootstrap);
    await run(a, `
      window.electronAPI = { invoke: async channel => {
        if (channel === 'rag:restore') return {success:true,count:0};
        if (channel === 'images:list' || channel === 'voice:list') return {success:true,files:[]};
        return {success:true};
      }};
      await testDB.messages.put({id:'fixture-message',role:'user',text:'fixture',timestamp:1});
      await testDB.kumikoDiary.put({id:'fixture-diary',date:'2026-02-02',timestamp:1,content:'fixture'});
      const failDelete = () => { throw Error('injected table failure'); };
      testDB.kumikoDiary.hook('deleting', failDelete);
      await assert.rejects(reset.runDataResetSession(), /injected table failure/);
      testDB.kumikoDiary.hook('deleting').unsubscribe(failDelete);
      assert.equal(gate.readDataRestoreGate().kind, 'reset');
      assert.ok(await testDB.messages.get('fixture-message'));
      assert.ok(await testDB.kumikoDiary.get('fixture-diary'));
      assert.equal(await reset.recoverInterruptedDataReset(), true);
      assert.equal(await testDB.messages.count(), 0); assert.equal(await testDB.kumikoDiary.count(), 0);
    `);
    await run(b, `assert.equal(gate.requiresDataRestoreReload(), true);`);
    await a.loadFile(page); await a.webContents.executeJavaScript(bootstrap);
    await b.loadFile(page); await b.webContents.executeJavaScript(bootstrap);
    await run(a, `
      window.oldVersion = gate.getDataRestoreVersion(); window.releaseMedia = null;
      window.mediaEntered = false;
      window.inflightMedia = mediaFence.withMediaWriteFence(oldVersion, async () => {
        mediaEntered = true; await new Promise(resolve => { releaseMedia = resolve; });
      });
      while (!mediaEntered) await new Promise(resolve => setTimeout(resolve, 0));
    `);
    await run(b, `
      window.electronAPI = { invoke: async channel => {
        if (channel === 'rag:restore') return {success:true,count:0};
        if (channel === 'images:list' || channel === 'voice:list') return {success:true,files:[]};
        return {success:true};
      }};
      window.resetDone = false;
      window.resetTask = reset.runDataResetSession().then(() => { resetDone = true; });
      while (!gate.readDataRestoreGate()) await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(resetDone, false);
    `);
    await run(a, `releaseMedia(); await assert.rejects(inflightMedia, /restor|earlier|paused/i);`);
    await run(b, `await resetTask; assert.equal(resetDone, true);`);
    await run(a, `
      let wrote = false;
      await assert.rejects(mediaFence.withMediaWriteFence(oldVersion, async () => { wrote = true; }), /restor|earlier|paused/i);
      assert.equal(wrote, false);
    `);
    // Exercise the actual preload bridge: its token belongs to the renderer
    // load, not the instant an old asynchronous callback finally sends IPC.
    const { ipcMain } = require('electron');
    let expectedGeneration = null;
    ipcMain.handle('images:save', (_event, payload) => ({ success: expectedGeneration === null || payload.dataResetGeneration === expectedGeneration }));
    const mediaWindow = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'preload.cjs'), contextIsolation: true, sandbox: false } });
    await mediaWindow.loadFile(page);
    const initial = await mediaWindow.webContents.executeJavaScript("window.electronAPI.invoke('images:save', {imageId:'fixture'})");
    if (!initial.success) throw Error('Fresh media renderer could not write');
    expectedGeneration = 'synthetic-reset-generation';
    await mediaWindow.webContents.executeJavaScript("localStorage.setItem('kumiko_media_reset_generation_v1', 'synthetic-reset-generation')");
    const stale = await mediaWindow.webContents.executeJavaScript("window.electronAPI.invoke('images:save', {imageId:'late'})");
    if (stale.success) throw Error('Old preload adopted a reset generation');
    await new Promise(resolve => { mediaWindow.webContents.once('did-finish-load', resolve); mediaWindow.reload(); });
    const fresh = await mediaWindow.webContents.executeJavaScript("window.electronAPI.invoke('images:save', {imageId:'fresh'})");
    if (!fresh.success) throw Error('Reloaded preload did not adopt reset generation');
    mediaWindow.destroy(); ipcMain.removeHandler('images:save');
    fs.writeFileSync(path.join(dir, 'passed.json'), JSON.stringify({ passed: true }));
    for (const w of windows) { await run(w, 'testDB.close()'); w.destroy(); } app.exit(0);
  }).catch(error => { console.error(error.stack || error); app.exit(1); });
}
