'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
let now=1_000_000,generation='generation-a',blocked=false,failDelete=false;
const records=new Map(),files=new Set(),messages=[],runtimeJobs=[];
const clone=value=>value===undefined?undefined:structuredClone(value);
class FixtureDate extends Date {static now(){return now;}}
const locksHeld=new Set();
const locks={async request(name,options,callback){
  if(typeof options==='function'){callback=options;options={};}
  if(locksHeld.has(name)){if(options.ifAvailable)return callback(null);throw Error('fixture lock unexpectedly busy');}
  locksHeld.add(name);try{return await callback({name});}finally{locksHeld.delete(name);}
}};
const keyval={get:async key=>records.has(key)?{key,value:clone(records.get(key))}:undefined,
  put:async row=>records.set(row.key,clone(row.value)),delete:async key=>records.delete(key),
  where:()=>({startsWith:prefix=>({filter:predicate=>({limit:n=>({toArray:async()=>[...records].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value:clone(value)})).filter(predicate).slice(0,n)})})})}),
  toCollection:()=>({each:async callback=>{for(const [key,value] of records)callback({key,value:clone(value)});}})};
const db={keyval,messages:{toArray:async()=>clone(messages)},runtimeJobs:{toArray:async()=>clone(runtimeJobs)},
  transaction:async(...args)=>args.at(-1)()};
const dataGate={assertDataWritesAllowed(){if(blocked)throw Error('blocked');},getDataRestoreVersion:()=> 'dataset',isDataRestoreBlocked:()=>blocked};
const memoryGate={assertMemoryAvailable(){if(blocked)throw Error('blocked');},assertMemoryGenerationCurrent:async value=>{if(blocked||value!==generation)throw Error('generation changed');},isMemoryMaintenanceBlocked:()=>blocked};
let deleteCalls=0;
const deps={'./db':{db},'./dataRestoreGate':dataGate,'./memoryMaintenanceGate':memoryGate,
  './mediaWriteFence':{withMediaResetFence:async work=>locks.request('media',work)},
  './voiceFileService':{deleteVoiceFile:async id=>{deleteCalls++;if(failDelete)return false;files.delete(id);return true;}}};
function load(file='voiceWriteLedger.ts'){const box={exports:{}};const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../services',file),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code,{module:box,exports:box.exports,require:id=>{assert.ok(deps[id],id);return deps[id];},navigator:{locks},Date:FixtureDate,Promise,Set,Object,Array,Number,console});return box.exports;}
deps['./voiceWriteRecord']=load('voiceWriteRecord.ts');
const a=load(),b=load(), row=id=>records.get(a.VOICE_WRITE_PREFIX+id);
(async()=>{
  const reserve=async(id,source='source')=>{await a.beginVoiceWrite({id,sourceIds:[source],memoryGeneration:generation});files.add(id);};
  await reserve('voice-one');assert.deepEqual(row('voice-one').sourceIds,['source']);assert.equal(row('voice-one').status,'reserved');
  await assert.rejects(b.beginVoiceWrite({id:'voice-one',sourceIds:['source'],memoryGeneration:generation}),/another window/);
  await b.discardVoiceSafely('voice-one');assert.ok(files.has('voice-one'),'explicit discard must not bypass another window lease');
  assert.equal((await b.reconcileVoiceLedger()).checked,0,'another window cannot reclaim a live lease');assert.ok(files.has('voice-one'));
  await a.finishVoiceWrite('voice-one');assert.equal((await b.reconcileVoiceLedger()).removed,1);assert.ok(!files.has('voice-one'));
  await reserve('voice-committed');messages.push({id:'message',voiceFileId:'voice-committed'});await a.finishVoiceWrite('voice-committed');
  assert.equal((await b.reconcileVoiceLedger()).retained,1);assert.equal(row('voice-committed').status,'referenced');assert.ok(files.has('voice-committed'));
  messages.length=0;now+=60_001;assert.equal((await b.reconcileVoiceLedger()).removed,1,'lost reference is rechecked later');
  await reserve('voice-task');runtimeJobs.push({id:'task',status:'pending',payload:{voiceFileId:'voice-task'}});await a.finishVoiceWrite('voice-task');
  assert.equal((await b.reconcileVoiceLedger()).retained,1);runtimeJobs.length=0;now+=60_001;assert.equal((await b.reconcileVoiceLedger()).removed,1);
  await reserve('voice-retry');await a.finishVoiceWrite('voice-retry');failDelete=true;
  assert.equal((await b.reconcileVoiceLedger()).failed,1);assert.equal(row('voice-retry').attempt,1);assert.ok(files.has('voice-retry'));
  failDelete=false;const before=deleteCalls;await b.reconcileVoiceLedger();assert.equal(deleteCalls,before,'backoff persists');
  now=row('voice-retry').retryAt;const reopened=load();assert.equal((await reopened.reconcileVoiceLedger()).removed,1,'restart retries pending deletion');
  await reserve('voice-old');generation='generation-b';await assert.rejects(a.finishVoiceWrite('voice-old'),/generation changed/);
  assert.equal(row('voice-old').status,'reserved');assert.equal((await b.reconcileVoiceLedger()).removed,1,'failed finish releases lease and leaves obligation');
  for(let i=0;i<4;i++){
    const id='voice-reference-'+i;records.set(a.VOICE_WRITE_PREFIX+id,{version:1,id,sourceIds:['source'],memoryGeneration:generation,status:'referenced',createdAt:now,updatedAt:now,attempt:0,retryAt:0});
    messages.push({id:'message-'+i,voiceFileId:id});files.add(id);
  }
  const pendingId='voice-pending-late';records.set(a.VOICE_WRITE_PREFIX+pendingId,{version:1,id:pendingId,sourceIds:['source'],memoryGeneration:generation,status:'pending',createdAt:now,updatedAt:now,attempt:0,retryAt:0});files.add(pendingId);
  await b.reconcileVoiceLedger(4);assert.equal(files.has(pendingId),false,'referenced rows must not starve pending deletion');
  records.set('kumiko_memory_generation_v1',generation);files.add('voice-legacy');failDelete=true;
  await b.discardVoiceSafely('voice-legacy');assert.equal(row('voice-legacy').status,'pending','legacy delete failure remains durable');
  failDelete=false;now=row('voice-legacy').retryAt;await b.reconcileVoiceLedger();assert.equal(files.has('voice-legacy'),false);
  await assert.rejects(a.beginVoiceWrite({id:'../unsafe',sourceIds:[],memoryGeneration:generation}),/Invalid/);
  let filesystemError;
  const voiceBox={exports:{}};
  const voiceCode=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../services/voiceFileService.ts'),'utf8'),
    {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const voiceDeps={'./environment':{isCapacitorNative:()=>true},'./db':{db},'./mediaWriteFence':{},'./dataRestoreGate':dataGate,
    '@capacitor/filesystem':{Filesystem:{deleteFile:async()=>{if(filesystemError)throw filesystemError;}},Directory:{Data:'Data'}}};
  vm.runInNewContext(voiceCode,{module:voiceBox,exports:voiceBox.exports,require:id=>{assert.ok(voiceDeps[id],id);return voiceDeps[id];},Error,String,Promise,console});
  filesystemError={code:'ENOENT'};assert.equal(await voiceBox.exports.deleteVoiceFile('not-created'),true);
  filesystemError=new Error('File does not exist.');assert.equal(await voiceBox.exports.deleteVoiceFile('not-created'),true);
  filesystemError=new Error('Permission denied');assert.equal(await voiceBox.exports.deleteVoiceFile('not-created'),false);
  filesystemError=new Error('Plugin not found');assert.equal(await voiceBox.exports.deleteVoiceFile('not-created'),false);
  console.log('Voice write ledger passed: cross-window lease, durable references, failed deletion retry, restart and generation fence.');
})().catch(error=>{console.error(error);process.exitCode=1;});
