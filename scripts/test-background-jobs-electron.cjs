'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '..'), prefix = 'kumiko-jobs-v2-', flag = '--fixture-profile=';
function safe(dir) {
  const real = fs.realpathSync(dir);
  if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith(prefix) || fs.lstatSync(dir).isSymbolicLink()) throw Error('Unsafe test directory');
  return real;
}
if (!process.versions.electron) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawnSync(require('electron'), [__filename, flag + dir], { env, cwd: root, windowsHide: true, encoding: 'utf8', timeout: 60000 });
  const passed = child.status === 0 && fs.existsSync(path.join(safe(dir), 'passed.json'));
  if (!passed) { process.stderr.write(child.stdout || ''); process.stderr.write(child.stderr || ''); }
  else console.log('Electron IndexedDB checks passed: atomic diary and job, two-window claim, persisted retry.');
  fs.rmSync(safe(dir), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  process.exitCode = passed ? 0 : 1;
} else {
  const { app, BrowserWindow } = require('electron'), ts = require('typescript');
  const dir = safe(process.argv.find(x => x.startsWith(flag)).slice(flag.length));
  app.setPath('userData', dir); app.setPath('sessionData', dir); app.disableHardwareAcceleration();
  const page = path.join(dir, 'test.html'); fs.writeFileSync(page, '<!doctype html><title>Fixture</title>');
  const sources = {};
  for (const name of ['services/voiceWriteRecord', 'services/db', 'services/dataRestoreGate', 'services/memoryMaintenanceGate', 'services/backgroundJobs', 'services/diaryIndexJobs', 'services/diaryGenerationJobs', 'services/artifactIndexService', 'services/summaryJobs', 'services/taskRuntime', 'services/executionArchive', 'services/runtimeStateBackup', 'services/turnStateBackup', 'components/app/summaryCycle']) {
    sources[name] = ts.transpileModule(fs.readFileSync(path.join(root, name + '.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  }
  const bootstrap = `(() => {
    const sources=${JSON.stringify(sources)}, cache={};
    function load(name) {
      if(name==='dexie') return require(${JSON.stringify(require.resolve('dexie'))});
      if(name==='services/environment') return {isCapacitorNative:()=>false};
      if(name==='services/androidRagService') return {};
      if(name==='store') return {useAppStore:{getState:()=>window.fixtureStore}};
      if(name==='components/app/appConstants') return {SUMMARY_ARCHIVE_STATE_STORAGE_KEY:'kumiko_summary_archive_state'};
      if(name==='services/conversationSummarizer') return {summarizeConversation:async()=>{window.summaryModelCalls=(window.summaryModelCalls||0)+1;return {diary:'saved summary',notebook:'saved notebook',chunks:['saved chunk']};}};
      if(name==='services/responseEffectCommit') return {RESPONSE_EFFECT_PREFIX:'kumiko_response_effect_v1:',isResponseEffectReceipt:()=>false};
      if(name==='services/preferencesSync') return {noteKeyvalPreferenceWrite(){}};
      if(name==='services/ambientWeatherDirect') return {fetchHistoricalWeatherDirect:async()=>{window.fixtureWeatherCalls=(window.fixtureWeatherCalls||0)+1;return {success:true,weather:'fixture weather'};},fetchJapanHolidaysDirect:async()=>({success:false})};
      if(name==='services/lifeStreamService') return {generateDailyDiary:async(date,messages,_after,_weather,_holiday,_freeze,_existing,context)=>{
        window.generatedInputs=messages;
        if(window.failGenerationOnce){window.failGenerationOnce=false;throw Error('fixture generation failure');}
        if(window.draftOnly) { await context.saveDraft({id:'draft-only',date,timestamp:43,content:'draft'}); return null; }
        return window.diary.saveDiaryWithIndexJob({id:window.fixtureDiaryId||'generated',date,timestamp:42,content:'fixture diary'}, {jobContext:context});
      }};
      if(cache[name]) return cache[name].exports;
      if(!sources[name]) throw Error('Unexpected dependency '+name);
      const module={exports:{}}; cache[name]=module; const from=name.slice(0,name.lastIndexOf('/'));
      new Function('require','module','exports',sources[name])(id=>load(id.startsWith('.')?require('node:path').posix.normalize(from+'/'+id):id),module,module.exports);
      return module.exports;
    }
    window.fetch=async()=>{throw Error('Network forbidden');}; window.db=load('services/db').db;
    window.jobs=load('services/backgroundJobs'); window.diary=load('services/diaryIndexJobs');
    window.generation=load('services/diaryGenerationJobs');
    window.artifact=load('services/artifactIndexService');
    window.summaryCycle=load('components/app/summaryCycle');
    window.fixtureStore={summaryArchiveState:summaryCycle.createInitialSummaryArchiveState(0),kumikoNotebook:'',locationConfig:{},language:'zh',backupConfig:{ragEnabled:false},
      setCoreMemory(value){this.coreMemory=value;},setKumikoNotebook(value){this.kumikoNotebook=value;},setSummaryArchiveState(value){this.summaryArchiveState=value;}};
    window.summary=load('services/summaryJobs');
    window.executionBackup=load('services/turnStateBackup');
    window.assert=require('node:assert/strict'); return db.open().then(()=>true);
  })()`;
  app.whenReady().then(async () => {
    const windows=[];
    async function open() { const w=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false}}); windows.push(w); await w.loadFile(page); await w.webContents.executeJavaScript(bootstrap); return w; }
    const a=await open(), b=await open();
    const run=(w,code)=>w.webContents.executeJavaScript('(async()=>{'+code+'})().catch(e=>{console.error(e.stack||String(e));throw e})');
    for(const w of windows) w.webContents.on('console-message',(_event,_level,message)=>console.error(message));
    await run(a, `
      const fail=()=>{throw Error('injected');}; db.runtimeJobs.hook('creating',fail);
      await assert.rejects(diary.saveDiaryWithIndexJob({id:'atomic',date:'2026-01-01',timestamp:1,content:'x'}),/injected/);
      db.runtimeJobs.hook('creating').unsubscribe(fail); assert.equal(await db.kumikoDiary.get('atomic'),undefined);
      await assert.rejects(diary.saveDiaryWithIndexJob({id:'provenance-fail',date:'2026-01-03',timestamp:1,content:'x'},
        {afterDiaryWrite:async()=>{await db.memoryDependencies.put({id:'failure',artifactId:'x',artifactKind:'diary',artifactVersion:'v',sourceId:'s',sourceKind:'message',sourceVersion:'v',relation:'basis',createdAt:1});throw Error('provenance failure');}}),/provenance failure/);
      assert.equal(await db.kumikoDiary.get('provenance-fail'),undefined);assert.equal(await db.memoryDependencies.get('failure'),undefined);
      await diary.saveDiaryWithIndexJob({id:'one',date:'2026-01-02',timestamp:2,content:'y'});
      assert.equal(await db.runtimeJobs.count(),1);
    `);
    const results=await Promise.all([run(a,`window.claim=await jobs.claimBackgroundJob('diary-index','a'); return !!claim;`),run(b,`window.claim=await jobs.claimBackgroundJob('diary-index','b'); return !!claim;`)]);
    if(results.filter(Boolean).length!==1) throw Error('Claim was not exclusive');
    const owner=results[0]?a:b;
    await run(owner,`await jobs.finishBackgroundJob(claim,'retrying',Error('fixture')); await assert.rejects(jobs.finishBackgroundJob(claim,'completed'));`);
    await run(b,`const rows=await db.runtimeJobs.toArray(); assert.equal(rows.length,1); assert.equal(rows[0].status,'retrying');`);
    await run(a, `
      await db.keyval.put({key:'kumiko_turn_epoch_v1',value:'initial'});
      const time=Date.parse('2026-02-01T12:00:00+09:00');
      await db.messages.put({id:'input',role:'user',text:'fixture',timestamp:time});
      await generation.enqueueDailyDiary('2026-02-01',{weather:'fixture'});
      await db.messages.update('input',{text:'changed'});
      await generation.runDailyDiaryJob('worker');
      let row=(await db.runtimeJobs.where('kind').equals('diary-generate').toArray())[0];
      assert.equal(row.status,'superseded'); assert.equal(await db.kumikoDiary.get('generated'),undefined);
      await generation.enqueueDailyDiary('2026-02-01',{weather:'fixture'});
      await generation.runDailyDiaryJob('worker');
      const rows=await db.runtimeJobs.where('kind').equals('diary-generate').toArray();
      assert.equal(rows.filter(r=>r.status==='completed').length,1);
      assert.equal((await db.kumikoDiary.get('generated')).content,'fixture diary');
      assert.equal(generatedInputs[0].text,'changed');
      const before=await db.runtimeJobs.where('kind').equals('diary-index').count();
      window.draftOnly=true; await generation.enqueueDailyDiary('2026-02-02'); await generation.runDailyDiaryJob('worker');
      const draft=(await db.runtimeJobs.where('kind').equals('diary-generate').toArray()).find(r=>r.sourceId==='2026-02-02');
      assert.equal(draft.status,'deferred'); assert.equal(draft.checkpoint.draft.content,'draft');
      assert.equal(await db.kumikoDiary.get('draft-only'),undefined);
      assert.equal(await db.runtimeJobs.where('kind').equals('diary-index').count(),before);
      window.draftOnly=false;window.fixtureDiaryId='generated-retry';window.failGenerationOnce=true;
      await generation.enqueueDailyDiary('2026-02-03');await generation.runDailyDiaryJob('worker');
      let weatherJob=(await db.runtimeJobs.where('kind').equals('diary-generate').toArray()).find(r=>r.sourceId==='2026-02-03');
      assert.equal(weatherJob.status,'retrying');assert.equal(weatherJob.checkpoint.weather,'fixture weather');
      const weatherCalls=window.fixtureWeatherCalls;await db.runtimeJobs.update(weatherJob.id,{retryAt:0});
      await generation.runDailyDiaryJob('worker');weatherJob=await db.runtimeJobs.get(weatherJob.id);
      assert.equal(weatherJob.status,'completed');assert.equal(window.fixtureWeatherCalls,weatherCalls,'retry reuses historical weather');
      const id='ka-'+'a'.repeat(64), sourceRow=await db.messages.get('input');
      await db.keyval.put({key:'kumiko_summary_artifact_v1:'+id,value:{id,version:'v',state:'active',epoch:'',memoryGeneration:'initial',
        sourceRefs:[{kind:'message',id:'input',version:sourceRow.contentRevision||sourceRow.sourceRevision||'legacy'}]}});
      const candidate={text:'derived',canonicalKey:'ka-artifact:'+id+':0',artifactState:'active'};
      assert.equal((await artifact.filterValidArtifactCandidates([candidate])).length,1);
      await db.messages.update('input',{text:'edited'});
      assert.equal((await artifact.filterValidArtifactCandidates([candidate])).length,0,'edited evidence cannot be retrieved');
      const safeId='ka-'+'b'.repeat(64), lostId='ka-'+'c'.repeat(64), updatedSource=await db.messages.get('input');
      const refs=[{kind:'message',id:'input',version:updatedSource.contentRevision||updatedSource.sourceRevision||'legacy'}];
      const deniedRefs=[{kind:'message',id:'removed',version:'legacy'}];
      await db.messages.put({id:'removed',role:'user',text:'hidden fixture',timestamp:time});
      await db.memoryCorrections.put({id:'correction',version:1,generation:'initial',createdAt:1,updatedAt:1,phase:'done',includeLegacyDerived:true,messageIds:['removed'],artifactIds:[],sourceVersions:{},status:'completed'});
      for (const [artifactId,sourceRefs] of [[safeId,refs],[lostId,deniedRefs]]) await db.keyval.put({key:'kumiko_summary_artifact_v1:'+artifactId,
        value:{id:artifactId,version:'v',state:'active',epoch:'old',memoryGeneration:'initial',sourceRefs}});
      window.electronAPI={invoke:async channel=>{assert.equal(channel,'rag:artifact-list');return {success:true,vectors:[
        {id:safeId+':0',text:'safe',canonicalKey:'ka-artifact:'+safeId+':0',artifactId:safeId,artifactVersion:'v',sourceRefs:refs,artifactChunkCount:1},
        {id:lostId+':0',text:'removed',canonicalKey:'ka-artifact:'+lostId+':0',artifactId:lostId,artifactVersion:'v',sourceRefs:deniedRefs,artifactChunkCount:1}]};}};
      await artifact.reconcileArtifactJobs();delete window.electronAPI;
      assert.ok((await db.runtimeJobs.toArray()).some(job=>job.sourceId===safeId && job.kind==='summary-index'));
      assert.ok(!(await db.runtimeJobs.toArray()).some(job=>job.sourceId===lostId),'corrected source cannot be reindexed');
    `);
    await run(a, `
      const message={id:'summary-source',role:'user',text:'summary fixture',timestamp:4};await db.messages.put(message);
      const initial=fixtureStore.summaryArchiveState;
      await db.keyval.bulkPut([{key:'kumiko_summary_archive_state',value:initial},{key:'kumiko_core_memory',value:''},{key:'kumiko_notebook',value:''}]);
      const params={currentCount:1,currentMemory:'',archiveState:initial,reason:'manual',isComplete:true,turnsInSegment:1,nextSegmentStartTurn:1,nextSegmentStartMessageId:null};
      await summary.enqueueSummaryJob([message],params);
      const fail=()=>{throw Error('summary provenance failure');};db.memoryDependencies.hook('creating',fail);
      await summary.runSummaryMaintenance('summary-worker');db.memoryDependencies.hook('creating').unsubscribe(fail);
      let task=(await db.runtimeJobs.where('kind').equals('summary-generate').toArray())[0];
      assert.equal(task.status,'retrying');assert.equal(summaryModelCalls,1);
      assert.equal((await db.keyval.get('kumiko_core_memory')).value,'');
      assert.equal((await db.keyval.get('kumiko_summary_archive_state')).value.segmentStartTurn,0);
      await db.runtimeJobs.update(task.id,{retryAt:0});await summary.runSummaryMaintenance('summary-worker');
      task=await db.runtimeJobs.get(task.id);assert.equal(task.status,'completed');assert.equal(summaryModelCalls,1,'checkpoint prevents re-generation');
      assert.equal((await db.keyval.get('kumiko_core_memory')).value,'saved summary');
      assert.equal((await db.keyval.get('kumiko_summary_archive_state')).value.segmentStartTurn,1);
      const savedCore=await db.keyval.get('kumiko_core_memory'), meta=(await db.keyval.get('kumiko_memory_asset_v1:kumiko_core_memory')).value;
      assert.equal(meta.sourceRevision,savedCore.sourceRevision);assert.equal(meta.sourceRefs[0].id,'summary-source');
      assert.ok((await db.memoryDependencies.toArray()).some(row=>row.artifactId==='kumiko_core_memory' && row.sourceId==='summary-source'));
      const index=(await db.runtimeJobs.where('kind').equals('summary-index').toArray()).find(row=>row.sourceId===initial.activeSegmentId);
      assert.equal(index.status,'deferred');
    `);
    await run(a, `
      const legacy={version:1,id:'legacy',kind:'diary-index',sourceId:'old',sourceVersion:'v1',epoch:'old',status:'completed',attempt:1,retryAt:1,createdAt:1,updatedAt:1};
      const generated={...legacy,id:'draft',kind:'diary.generate',status:'running',checkpoint:{draft:'test'},owner:'old',token:'old',leaseUntil:999};
      await db.transaction('rw',[db.keyval,db.runtimeJobs],async()=>{
        await db.keyval.put({key:'kumiko_turn_epoch_v1',value:'restored'});
        await db.keyval.put({key:jobs.BACKGROUND_JOB_PREFIX+'legacy',value:legacy});
        await db.runtimeJobs.put(generated);
        await jobs.rebaseBackgroundJobsAfterRestore();
      });
      const old=await db.runtimeJobs.get('legacy'), draft=await db.runtimeJobs.get('draft');
      assert.equal(old.epoch,'restored'); assert.equal(old.status,'pending'); assert.equal(old.restoredStatus,'completed');
      assert.equal(draft.status,'deferred'); assert.equal(draft.checkpoint.draft,'test'); assert.equal(draft.token,undefined);
      assert.equal(await db.keyval.get(jobs.BACKGROUND_JOB_PREFIX+'legacy'),undefined);
    `);
    await run(a, `
      const exported=await executionBackup.exportTurnExecutionState();assert.equal(exported.version,3);
      const entries=executionBackup.executionStateEntries(exported);
      assert.ok(entries.some(row=>row.key.startsWith('runtime13:') && row.value.kind==='summary-generate'));
      assert.ok(entries.some(row=>row.key==='kumiko_memory_asset_v1:kumiko_core_memory'));
      await db.transaction('rw',db.tables,async()=>executionBackup.replaceTurnExecutionState(exported));
      assert.ok((await db.runtimeJobs.toArray()).some(row=>row.kind==='summary-generate'));
      assert.ok(await db.keyval.get('kumiko_memory_asset_v1:kumiko_core_memory'));
      assert.ok(await db.memoryCorrections.get('correction'));
    `);
    for(const w of windows) w.destroy(); fs.writeFileSync(path.join(dir,'passed.json'),'{}'); app.exit(0);
  }).catch(error=>{console.error(error);app.exit(1);});
}
