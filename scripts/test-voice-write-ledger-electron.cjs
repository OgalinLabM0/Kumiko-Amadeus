'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=path.resolve(__dirname,'..'),prefix='kumiko-voice-ledger-',flag='--fixture-profile=';
function safe(dir){const real=fs.realpathSync(dir);if(path.dirname(real)!==fs.realpathSync(os.tmpdir())||!path.basename(real).startsWith(prefix)||fs.lstatSync(dir).isSymbolicLink())throw Error('Unsafe fixture');return real;}
if(!process.versions.electron){
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),prefix)),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=require('node:child_process').spawnSync(require('electron'),[__filename,flag+dir],{env,cwd:root,windowsHide:true,encoding:'utf8',timeout:60000});
  const ok=child.status===0&&fs.existsSync(path.join(safe(dir),'passed.json'));
  if(ok)console.log('Electron voice ledger passed: shared Web Locks, IndexedDB persistence, reference protection and failed-delete retry.');
  else{console.error('Voice ledger fixture failed:',child.status,child.error?.message);process.stderr.write(child.stdout||'');process.stderr.write(child.stderr||'');}
  fs.rmSync(safe(dir),{recursive:true,force:true,maxRetries:3,retryDelay:200});process.exitCode=ok?0:1;
} else {
  const {app,BrowserWindow}=require('electron'),ts=require('typescript');
  const dir=safe(process.argv.find(value=>value.startsWith(flag)).slice(flag.length));
  app.setPath('userData',dir);app.setPath('sessionData',dir);app.disableHardwareAcceleration();
  const page=path.join(dir,'fixture.html');fs.writeFileSync(page,'<!doctype html><title>Voice ledger fixture</title>');
  const source={};for(const name of ['services/db','services/dataRestoreGate','services/memoryMaintenanceGate','services/mediaWriteFence','services/voiceWriteRecord','services/voiceWriteLedger','services/backupVoiceRemap','services/backupMediaStaging','services/reminderVoiceCommit','components/app/messageMappers'])
    source[name]=ts.transpileModule(fs.readFileSync(path.join(root,name+'.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const bootstrap=`(()=>{const source=${JSON.stringify(source)},cache={},fixtureDir=${JSON.stringify(dir)};
    function load(name){
      if(name==='dexie')return require(${JSON.stringify(require.resolve('dexie'))});
      if(name==='services/preferencesSync')return {noteKeyvalPreferenceWrite(){}};
      if(name==='services/imageService')return {imageService:{}};
      if(name==='services/environment')return {isCapacitorNative:()=>false};
      if(name==='services/turnStateBackup')return {getBackupExecutionState:x=>x?.data?.executionState??x?.executionState,executionStateEntries:x=>x?.entries||[],packExecutionState:async entries=>({version:3,entries})};
      if(name==='services/voiceFileService')return {deleteVoiceFile:async id=>{
        if(window.failVoiceDelete)return false;if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id))throw Error('Invalid fixture ID');
        const f=require('node:path').join(fixtureDir,id+'.mp3'),fs=require('node:fs');if(fs.existsSync(f))fs.unlinkSync(f);return true;},
        isVoiceServiceAvailable:()=>true,saveVoiceFile:async(id,bytes)=>{if(window.failVoiceSave)return false;require('node:fs').writeFileSync(window.fixtureVoicePath(id),Buffer.from(bytes));return true;},
        loadVoiceFile:async id=>{const b=require('node:fs').readFileSync(window.fixtureVoicePath(id));return Uint8Array.from(b).buffer;}};
      if(cache[name])return cache[name].exports;if(!source[name])throw Error('Unexpected dependency '+name);
      const module={exports:{}};cache[name]=module;const base=name.slice(0,name.lastIndexOf('/'));
      new Function('require','module','exports',source[name])(id=>load(id.startsWith('.')?require('node:path').posix.normalize(base+'/'+id):id),module,module.exports);return module.exports;
    }
    window.db=load('services/db').db;window.gate=load('services/dataRestoreGate');window.mediaFenceFixture=load('services/mediaWriteFence');
    window.ledger=load('services/voiceWriteLedger');window.assert=require('node:assert/strict');
    window.staging=load('services/backupMediaStaging');
    window.reminderCommit=load('services/reminderVoiceCommit');
    window.fixtureVoicePath=id=>{if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id))throw Error('Invalid fixture ID');return require('node:path').join(fixtureDir,id+'.mp3');};
    window.fixtureFs=require('node:fs');window.fetch=async()=>{throw Error('Network forbidden');};return db.open().then(()=>true);
  })()`;
  app.whenReady().then(async()=>{
    const windows=[];async function open(){const w=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false}});windows.push(w);await w.loadFile(page);await w.webContents.executeJavaScript(bootstrap);return w;}
    const a=await open(),b=await open();const run=(w,code)=>w.webContents.executeJavaScript('(async()=>{'+code+'})()');
    await run(a,`await mediaFenceFixture.withMediaWriteFence(gate.getDataRestoreVersion(),async()=>{await ledger.beginVoiceWrite({id:'voice-one',sourceIds:['source'],memoryGeneration:'initial'});fixtureFs.writeFileSync(fixtureVoicePath('voice-one'),'fixture');},'initial');`);
    await run(b,`await ledger.discardVoiceSafely('voice-one');assert.equal((await ledger.reconcileVoiceLedger()).checked,0);assert.ok(fixtureFs.existsSync(fixtureVoicePath('voice-one')));`);
    await run(a,`assert.equal(await ledger.finishVoiceWrite('voice-one'),true);`);
    await run(b,`assert.equal((await ledger.reconcileVoiceLedger()).removed,1);assert.equal(fixtureFs.existsSync(fixtureVoicePath('voice-one')),false);`);
    await run(a,`await mediaFenceFixture.withMediaWriteFence(gate.getDataRestoreVersion(),async()=>{await ledger.beginVoiceWrite({id:'voice-shared',sourceIds:['source'],memoryGeneration:'initial'});fixtureFs.writeFileSync(fixtureVoicePath('voice-shared'),'fixture');},'initial');await db.messages.put({id:'message',role:'model',text:'fixture',timestamp:1,voiceFileId:'voice-shared'});await ledger.finishVoiceWrite('voice-shared');`);
    await run(b,`assert.equal((await ledger.reconcileVoiceLedger()).retained,1);assert.ok(fixtureFs.existsSync(fixtureVoicePath('voice-shared')));`);
    await run(a,`await mediaFenceFixture.withMediaWriteFence(gate.getDataRestoreVersion(),async()=>{await ledger.beginVoiceWrite({id:'voice-reminder',sourceIds:['source'],memoryGeneration:'initial'});fixtureFs.writeFileSync(fixtureVoicePath('voice-reminder'),'fixture');},'initial');`);
    await run(b,`await ledger.discardVoiceSafely('voice-reminder');assert.ok(fixtureFs.existsSync(fixtureVoicePath('voice-reminder')),'other window must not discard in-flight reminder');`);
    await run(a,`await reminderCommit.commitStandaloneReminderVoice({id:'reminder-message',role:'model',text:'fixture',timestamp:2,voiceFileId:'voice-reminder',isVoiceMessage:true},async()=>{});
      assert.equal((await db.messages.get('reminder-message')).voiceFileId,'voice-reminder');await ledger.discardVoiceSafely('voice-reminder');`);
    await run(b,`assert.ok(fixtureFs.existsSync(fixtureVoicePath('voice-reminder')),'durably referenced reminder voice must survive cleanup');`);
    await run(a,`await mediaFenceFixture.withMediaWriteFence(gate.getDataRestoreVersion(),async()=>{await ledger.beginVoiceWrite({id:'voice-failed',sourceIds:['source'],memoryGeneration:'initial'});fixtureFs.writeFileSync(fixtureVoicePath('voice-failed'),'fixture');},'initial');
      const fail=()=>{throw Error('injected reminder persistence failure');};db.messages.hook('creating',fail);
      await assert.rejects(reminderCommit.commitStandaloneReminderVoice({id:'reminder-failed',role:'model',text:'fixture',timestamp:3,voiceFileId:'voice-failed'},async()=>{}),/injected/);
      db.messages.hook('creating').unsubscribe(fail);assert.equal(await db.messages.get('reminder-failed'),undefined);`);
    await run(b,`await ledger.discardVoiceSafely('voice-failed');assert.ok(fixtureFs.existsSync(fixtureVoicePath('voice-failed')),'failed commit remains protected while owner holds lease');`);
    await run(a,`await ledger.discardVoiceSafely('voice-failed');assert.equal(fixtureFs.existsSync(fixtureVoicePath('voice-failed')),false);`);
    await run(a,`await mediaFenceFixture.withMediaWriteFence(gate.getDataRestoreVersion(),async()=>{await ledger.beginVoiceWrite({id:'voice-retry',sourceIds:['source'],memoryGeneration:'initial'});fixtureFs.writeFileSync(fixtureVoicePath('voice-retry'),'fixture');},'initial');await ledger.finishVoiceWrite('voice-retry');`);
    await run(b,`window.failVoiceDelete=true;assert.equal((await ledger.reconcileVoiceLedger()).failed,1);const row=(await db.keyval.get(ledger.VOICE_WRITE_PREFIX+'voice-retry')).value;assert.equal(row.attempt,1);await db.keyval.put({key:ledger.VOICE_WRITE_PREFIX+'voice-retry',value:{...row,retryAt:0}});db.close();`);
    await b.loadFile(page);await b.webContents.executeJavaScript(bootstrap);
    await run(b,`assert.equal((await ledger.reconcileVoiceLedger()).removed,1);assert.equal(fixtureFs.existsSync(fixtureVoicePath('voice-retry')),false);assert.ok(fixtureFs.existsSync(fixtureVoicePath('voice-shared')));`);
    await run(a,`fixtureFs.writeFileSync(fixtureVoicePath('old-voice'),'old');window.imported=await staging.prepareBackupMedia({data:{messages:[{id:'imported-message',voiceFileId:'old-voice'}],executionState:{version:3,entries:[{key:'kumiko_voice_write_v1:old-voice',value:{version:1,id:'old-voice',sourceIds:['basis'],memoryGeneration:'initial',status:'pending',createdAt:1,updatedAt:1,attempt:0,retryAt:1}}]}}},[],{voices:[{id:'old-voice',base64:'bmV3'}]});window.importedId=imported.json.data.messages[0].voiceFileId;assert.notEqual(importedId,'old-voice');assert.ok((await db.keyval.get(ledger.VOICE_WRITE_PREFIX+importedId)).value.sourceIds.includes('basis'));`);
    const importedId=await run(a,'return importedId;');
    await run(b,`await ledger.discardVoiceSafely(${JSON.stringify(importedId)});assert.ok(fixtureFs.existsSync(fixtureVoicePath(${JSON.stringify(importedId)})),'staged import lease protects file across windows');`);
    await run(a,`await db.messages.put({id:'imported-message',role:'model',text:'fixture',timestamp:4,voiceFileId:importedId});await imported.releaseVoiceLeases();`);
    await run(b,`await ledger.discardVoiceSafely(${JSON.stringify(importedId)});assert.ok(fixtureFs.existsSync(fixtureVoicePath(${JSON.stringify(importedId)})));assert.equal(fixtureFs.readFileSync(fixtureVoicePath('old-voice'),'utf8'),'old');`);
    await run(a,`window.failVoiceSave=true;await assert.rejects(staging.prepareBackupMedia({messages:[{id:'failure',voiceFileId:'failed-old'}]},[],{voices:[{id:'failed-old',base64:'eA=='}]}),/voice write failed/);window.failVoiceSave=false;const rows=await db.keyval.toArray();assert.ok(rows.some(r=>r.key.startsWith(ledger.VOICE_WRITE_PREFIX)&&r.value.sourceIds.includes('failure')&&r.value.status==='pending'),'failed staging keeps durable cleanup obligation');`);
    for(const w of windows){await run(w,'db.close()');w.destroy();}fs.writeFileSync(path.join(dir,'passed.json'),'{}');app.exit(0);
  }).catch(error=>{console.error(error.stack||error);app.exit(1);});
}
