'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
let clock=1793516400000,generation='a',blocked=false,known=null,resolveCalls=0;
const rows=new Map(), jobRows=new Map();
const copy=value=>value===undefined?undefined:structuredClone(value);
const jobTable={get:async key=>copy(jobRows.get(key)),put:async value=>jobRows.set(value.id,copy(value)),toArray:async()=>[...jobRows.values()].map(copy)};
const db={table:name=>{assert.equal(name,'runtimeJobs');return jobTable;},keyval:{get:async key=>rows.has(key)?{key,value:copy(rows.get(key))}:undefined,
  put:async({key,value})=>{if(blocked)throw Error('blocked');rows.set(key,copy(value));},
  where:()=>({startsWith:prefix=>({toArray:async()=>[...rows].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value:copy(value)}))})})},
  transaction:async(...args)=>args.at(-1)()};
const gate={getDataRestoreVersion:()=>generation,isDataRestoreBlocked:()=>blocked,assertDataWritesAllowed(){if(blocked)throw Error('blocked');}};
class Clock extends Date{static now(){return clock;}}
function load(file,deps){const module={exports:{}};const output=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(output,{module,exports:module.exports,Date:Clock,crypto,AbortController,setTimeout,clearTimeout,console,
    require(id){assert.ok(Object.hasOwn(deps,id),id);return deps[id];},fetch(){throw Error('No weather or model calls allowed');}});return module.exports;}
const memory={getMemoryGeneration:()=> 'initial',assertMemoryGenerationCurrent:async value=>{if(value!=='initial')throw Error('memory changed');}};
const jobs=load('services/backgroundJobs.ts',{'./db':{db},'./dataRestoreGate':gate,'./memoryMaintenanceGate':memory});
let resolver=async()=>known, lastContext;
const worker=load('services/locationResolutionJobs.ts',{'./db':{db},'./dataRestoreGate':gate,'./backgroundJobs':jobs,
  './memoryMaintenanceGate':memory,
  './userKnownLocation':{getUserKnownLocation:async()=>copy(known),resolveKnownUserLocation:async (signal,context)=>{resolveCalls++;lastContext=context;return resolver(signal);}}});
function disclosure(id='a',revision=1){return {sourceMessage:{id,text:'我在巴黎',role:'user',timestamp:clock},locationText:'巴黎',revision,updatedAt:clock,status:'unresolved'};}
function allJobs(){return [...jobRows.values()].map(copy);}
function reset(){rows.clear();jobRows.clear();generation='a';blocked=false;known=disclosure();resolveCalls=0;resolver=async()=>known;}
(async()=>{
  reset();await worker.reconcileLocationResolutionJob();await worker.reconcileLocationResolutionJob();assert.equal(allJobs().length,1);
  const original=copy(known);await worker.runLocationResolutionJob('first');assert.equal(allJobs()[0].status,'retrying');assert.deepEqual(known,original);
  assert.equal(await worker.runLocationResolutionJob('reload'),false,'backoff survives another worker');
  clock=allJobs()[0].retryAt;resolver=async()=>{known={...known,status:'resolved',timeZone:'Europe/Paris'};return known;};
  await worker.runLocationResolutionJob('reload');assert.equal(allJobs()[0].status,'completed');assert.equal(resolveCalls,2);assert.equal(known.sourceMessage.text,'我在巴黎');
  reset();await worker.reconcileLocationResolutionJob();resolver=async()=>{known={...known,status:'ambiguous'};return known;};
  await worker.runLocationResolutionJob('worker');assert.equal(allJobs()[0].status,'completed','ambiguity awaits user clarification, not endless querying');
  reset();await worker.reconcileLocationResolutionJob();resolver=async()=>{throw {kind:'budget',nextEligibleAt:clock+100000};};
  await worker.runLocationResolutionJob('worker');assert.equal(allJobs()[0].attempt,0);assert.equal(allJobs()[0].retryAt,clock+100000);
  assert.equal(lastContext.lane,'background');assert.equal(lastContext.role,'location-resolution');
  reset();await worker.reconcileLocationResolutionJob();known=disclosure('new',2);await worker.runLocationResolutionJob('worker');assert.equal(resolveCalls,0);assert.equal(allJobs()[0].status,'superseded');
  await worker.reconcileLocationResolutionJob();assert.equal(allJobs().length,2,'new disclosure has a separate retry identity');
  reset();await worker.reconcileLocationResolutionJob();for(let i=0;i<8;i++){clock=Math.max(clock,allJobs()[0].retryAt);await worker.runLocationResolutionJob('worker');}
  assert.equal(allJobs()[0].status,'failed');const attempts=resolveCalls;await worker.reconcileLocationResolutionJob();assert.equal(await worker.runLocationResolutionJob('worker'),false);assert.equal(resolveCalls,attempts);
  await jobs.retryFailedBackgroundJobs();assert.equal(allJobs()[0].status,'pending');assert.equal(allJobs()[0].previousAttempts,8);
  reset();await worker.reconcileLocationResolutionJob();let release,started;const inFlight=new Promise(r=>started=r);resolver=()=>{started();return new Promise(r=>release=r);};
  const running=worker.runLocationResolutionJob('old');await inFlight;generation='new';rows.set('kumiko_turn_epoch_v1','new');known=disclosure('restored',99);release(known);await running;
  assert.equal(allJobs()[0].status,'running','expired dataset cannot record success or retry in new dataset');assert.equal(known.sourceMessage.id,'restored');
  blocked=true;assert.equal(await worker.runLocationResolutionJob('blocked'),false);await worker.reconcileLocationResolutionJob();
  console.log('Location jobs passed: durable identity, offline retry, backoff, resolution, ambiguity, newer disclosure, bounded attempts, manual retry and restore fence.');
})().catch(e=>{console.error(e);process.exitCode=1;});
