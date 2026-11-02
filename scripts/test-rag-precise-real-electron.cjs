'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=path.resolve(__dirname,'..'), prefix='kumiko-real-rag-cleanup-', profileFlag='--fixture-profile=', stageFlag='--fixture-stage=';
function safe(dir) {
  const real=fs.realpathSync(dir);
  if(path.dirname(real)!==fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith(prefix) || fs.lstatSync(dir).isSymbolicLink()) throw Error('Unsafe fixture profile');
  return real;
}
if(!process.versions.electron){
  const profile=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),prefix));
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  try {
    for(const stage of ['cleanup','reopen']){
      const child=require('node:child_process').spawnSync(require('electron'),[__filename,profileFlag+profile,stageFlag+stage],
        {env,cwd:root,windowsHide:true,encoding:'utf8',timeout:90000});
      if(child.status!==0 || !fs.existsSync(path.join(safe(profile),stage+'.ok'))){
        console.error('Real RAG fixture failed:',stage,'exit:',child.status,'signal:',child.signal,'error:',child.error?.message);
        process.stderr.write(child.stdout||'');process.stderr.write(child.stderr||'');process.exitCode=1;break;
      }
    }
    if(!process.exitCode)console.log('Real Electron RAG cleanup passed: production IPC, SQLite/HNSW, provenance, precise preservation, stale sender, process reopen; no ONNX model or network.');
  } finally { fs.rmSync(safe(profile),{recursive:true,force:true,maxRetries:3,retryDelay:200}); }
} else {
  const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict'),vm=require('node:vm'),ts=require('typescript');
  const profile=safe(process.argv.find(x=>x.startsWith(profileFlag)).slice(profileFlag.length));
  const stage=process.argv.find(x=>x.startsWith(stageFlag)).slice(stageFlag.length);
  if(!['cleanup','reopen'].includes(stage))throw Error('Invalid fixture stage');
  app.setPath('userData',profile);app.setPath('sessionData',profile);app.disableHardwareAcceleration();
  const page=path.join(profile,'fixture.html');fs.writeFileSync(page,'<!doctype html><title>RAG cleanup fixture</title>');
  app.whenReady().then(async()=>{
    assert.equal(path.resolve(app.getPath('userData')),path.resolve(profile));
    let networkAttempts=0;
    const forbidNetwork=()=>{networkAttempts++;throw Error('Network is forbidden in the RAG fixture.');};
    global.fetch=forbidNetwork;
    for(const protocol of ['node:http','node:https']){const transport=require(protocol);transport.request=forbidNetwork;transport.get=forbidNetwork;}
    const rag=require('../electron-rag.cjs');
    await rag.initRag({loadEmbeddingModel:false});
    const windows=[];
    async function open(){const w=new BrowserWindow({show:false,webPreferences:{preload:path.join(root,'preload.cjs'),contextIsolation:true,sandbox:false}});
      windows.push(w);await w.loadFile(page);return w;}
    const invoke=(w,channel,data)=>w.webContents.executeJavaScript(`window.electronAPI.invoke(${JSON.stringify(channel)},${JSON.stringify(data)})`);
    const owner=await open(), other=await open();
    const initial=await invoke(owner,'rag:status');assert.equal(initial.modelLoaded,false);assert.equal(initial.modelLoading,false);
    assert.equal(initial.hnswIndexed,initial.vectorCount,'HNSW must actually initialize; no mock/fallback');
    const targetArtifact='ka-'+'a'.repeat(64), safeArtifact='ka-'+'b'.repeat(64);
    const expected=['future','lore',safeArtifact+':0'].sort();
    if(stage==='cleanup'){
      assert.equal(initial.vectorCount,0,'fixture must not reuse a profile');
      const vector=Array(1024).fill(0.01);
      const artifact=(id,sourceId,text)=>({id:id+':0',text,vector,timestamp:10,tier:'core',source:'memory_chunk',
        canonicalKey:'ka-artifact:'+id+':0',artifactId:id,artifactVersion:'v1',artifactEpoch:'',artifactMemoryGeneration:'initial',
        sourceRefs:[{kind:'message',id:sourceId,version:'v1',relation:'basis'}]});
      const fixtures=[
        {id:'direct',messageId:'target',text:'fixture target',vector,timestamp:10,tier:'core',source:'rebuild_message'},
        artifact(targetArtifact,'target','fixture derived'), artifact(safeArtifact,'other','fixture safe'),
        {id:'legacy',text:'fixture unproven',vector,timestamp:10,tier:'core',source:'memory_chunk'},
        {id:'future',text:'fixture future',vector,timestamp:200,tier:'core',source:'memory_chunk'},
        {id:'lore',text:'fixture official',vector,timestamp:10,tier:'core',source:'official_lore'},
      ];
      const inserted=await invoke(owner,'rag:restore',fixtures);assert.equal(inserted.success,true,inserted.error);assert.equal(inserted.count,fixtures.length);
      const seeded=await invoke(owner,'rag:sync-messages',{messages:[{id:'target',role:'user',text:'fixture target',timestamp:10},
        {id:'other',role:'user',text:'fixture other',timestamp:11}],replaceAll:true});assert.equal(seeded.success,true,seeded.error);
      const locked=await invoke(owner,'rag:restore-lock',{id:'fixture-correction',kind:'memory',action:'begin'});assert.equal(locked.success,true,locked.error);
      const denied=await invoke(other,'rag:get-all',{restoreSessionId:'fixture-correction'});assert.equal(denied.success,false,'another sender must not access correction snapshot');
      const before=await invoke(owner,'rag:get-all',{restoreSessionId:'fixture-correction'});assert.equal(before.success,true,before.error);
      assert.equal(before.vectors.find(row=>row.id===targetArtifact+':0').sourceRefs[0].id,'target');
      assert.equal(before.vectors.find(row=>row.id===safeArtifact+':0').sourceRefs[0].id,'other');
      const source=ts.transpileModule(fs.readFileSync(path.join(root,'services/memoryCorrectionPolicy.ts'),'utf8'),
        {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
      const box={exports:{}};vm.runInNewContext(source,{module:box,exports:box.exports,Set,Object,Array,Number,String});
      const rule={messageIds:['target'],artifactIds:[],includeLegacyDerived:true,legacyCutoff:100,createdAt:100};
      const retained=before.vectors.filter(row=>!box.exports.ruleMatchesRow(row,'vectors',rule));
      const restored=await invoke(owner,'rag:restore',{vectors:retained,restoreSessionId:'fixture-correction',purpose:'memory-maintenance'});
      assert.equal(restored.success,true,restored.error);assert.equal(restored.count,expected.length);
      const synced=await invoke(owner,'rag:sync-messages',{messages:[{id:'other',role:'user',text:'fixture other',timestamp:11}],replaceAll:true,restoreSessionId:'fixture-correction'});
      assert.equal(synced.success,true,synced.error);
      const after=await invoke(owner,'rag:get-all',{restoreSessionId:'fixture-correction'});
      assert.deepEqual(after.vectors.map(row=>row.id).sort(),expected);
      assert.equal(after.vectors.find(row=>row.id===safeArtifact+':0').sourceRefs[0].id,'other');
      const raw=await invoke(owner,'rag:get-messages',{restoreSessionId:'fixture-correction'});assert.deepEqual(raw.messages.map(row=>row.id),['other']);
      await owner.webContents.executeJavaScript("localStorage.setItem('kumiko_memory_generation_v1','fixture-correction')");
      const ended=await invoke(owner,'rag:restore-lock',{id:'fixture-correction',kind:'memory',action:'end',committed:true});assert.equal(ended.success,true,ended.error);
      const staleSave=await invoke(other,'rag:save',{id:'late',text:'fixture target'});assert.equal(staleSave.success,false,'old preload must be fenced before embedding');
      const staleSync=await invoke(other,'rag:sync-messages',{messages:[{id:'target',role:'user',text:'fixture target',timestamp:10}],replaceAll:false});assert.equal(staleSync.success,false);
      const fresh=await open(), freshData=await invoke(fresh,'rag:get-all');assert.equal(freshData.success,true,freshData.error);
      assert.deepEqual(freshData.vectors.map(row=>row.id).sort(),expected);
      const status=await invoke(fresh,'rag:status');assert.equal(status.modelLoaded,false);assert.equal(status.modelLoading,false);assert.equal(status.hnswIndexed,expected.length);
    } else {
      const after=await invoke(owner,'rag:get-all');assert.equal(after.success,true,after.error);
      assert.deepEqual(after.vectors.map(row=>row.id).sort(),expected,'deleted target must not reappear after process restart');
      assert.equal(after.vectors.find(row=>row.id===safeArtifact+':0').sourceRefs[0].id,'other');
      const raw=await invoke(owner,'rag:get-messages');assert.deepEqual(raw.messages.map(row=>row.id),['other']);
      const status=await invoke(owner,'rag:status');assert.equal(status.modelLoaded,false);assert.equal(status.hnswIndexed,expected.length);
    }
    assert.equal(networkAttempts,0,'fixture must not attempt a network request');
    for(const w of windows)w.destroy();await rag.closeRag();fs.writeFileSync(path.join(profile,stage+'.ok'),'ok');app.exit(0);
  }).catch(error=>{console.error(error.stack||error);app.exit(1);});
}
