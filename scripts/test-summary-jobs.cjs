'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const crypto=require('node:crypto').webcrypto;
const values=new Map(), revisions=new Map(), jobsMap=new Map(), messageMap=new Map();let revisionCount=0;
const copy=x=>x===undefined?undefined:structuredClone(x);
const keyval={get:async key=>values.has(key)?{key,value:copy(values.get(key)),...(revisions.has(key)?{sourceRevision:revisions.get(key)}:{})}:undefined,
  put:async row=>{values.set(row.key,copy(row.value));revisions.set(row.key,row.sourceRevision||'revision-'+(++revisionCount));}};
const jobTable={get:async id=>copy(jobsMap.get(id)),put:async row=>jobsMap.set(row.id,copy(row)),toArray:async()=>[...jobsMap.values()].map(copy),
  where:()=>({equals:kind=>({toArray:async()=>[...jobsMap.values()].filter(row=>row.kind===kind).map(copy)})})};
const db={keyval,runtimeJobs:jobTable,memoryDependencies:{put:async()=>{}},table:name=>{assert.equal(name,'runtimeJobs');return jobTable;},
  messages:{get:async id=>copy(messageMap.get(id))},kumikoDiary:{get:async()=>undefined},dailyFragments:{get:async()=>undefined},
  transaction:async(...args)=>args.at(-1)()};
const gate={assertDataWritesAllowed(){},getDataRestoreVersion:()=> 'epoch',isDataRestoreBlocked:()=>false};
const memory={getMemoryGeneration:()=> 'generation',assertMemoryGenerationCurrent:async value=>assert.equal(value,'generation')};
const state={kumikoNotebook:'notebook',locationConfig:{},language:'zh',backupConfig:{ragEnabled:false},summaryArchiveState:{activeSegmentId:'segment',segmentStartTurn:0},
  setCoreMemory(v){state.coreMemory=v;},setKumikoNotebook(v){state.kumikoNotebook=v;},setSummaryArchiveState(v){state.summaryArchiveState=v;}};
let modelCalls=0,indexCalls=0,failIndex=true,mutateSource=false,failModel=false;
function load(file,deps){const box={exports:{}};const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code,{module:box,exports:box.exports,require:id=>{assert.ok(deps[id],id);return deps[id];},crypto,TextEncoder,Uint8Array,
    structuredClone,Date,setTimeout,clearTimeout,setInterval,clearInterval,AbortController,console});return box.exports;}
const jobs=load('services/backgroundJobs.ts',{'./db':{db},'./dataRestoreGate':gate,'./memoryMaintenanceGate':memory});
const artifact={assertSourceRefsCurrent:async refs=>{for(const ref of refs){const row=messageMap.get(ref.id);if(!row||row.contentRevision!==ref.version)throw Error('Summary source changed.');}},
  saveIndexedArtifact:async()=>{indexCalls++;if(failIndex)throw Error('fixture index failure');return {success:true,searchReady:true};}};
const cycle={getSummarySegmentMessages:m=>m,buildSummarySegmentId:()=> 'next',appendRecentSummarySegment:(_state,meta)=>[meta],
  buildRecentSummaryBuffer:(_rows,text)=>text,getSummaryContinuationCarryoverState:()=>({carryoverStartMessageId:null,carryoverEndMessageId:null}),
  normalizeSummaryArchiveState:row=>row};
const summary=load('services/summaryJobs.ts',{'./db':{db},'../store':{useAppStore:{getState:()=>state}},'./dataRestoreGate':gate,
  './memoryMaintenanceGate':memory,'./backgroundJobs':jobs,'./conversationSummarizer':{summarizeConversation:async()=>{modelCalls++;if(failModel)throw Error('fixture model failure');if(mutateSource)messageMap.get('m2').contentRevision='r3';return {diary:'summary',notebook:'new notebook',chunks:['memory']};}},
  './artifactIndexService':artifact,'./taskRuntime':{assertTaskModelRevisionsCurrent:async()=>{}},'../components/app/appConstants':{SUMMARY_ARCHIVE_STATE_STORAGE_KEY:'archive'},'../components/app/summaryCycle':cycle});
(async()=>{
  const message={id:'m1',role:'user',text:'fixture',timestamp:1,contentRevision:'r1'};messageMap.set('m1',message);
  const params={currentCount:1,currentMemory:'',archiveState:copy(state.summaryArchiveState),reason:'manual',isComplete:true,turnsInSegment:1,nextSegmentStartTurn:1,nextSegmentStartMessageId:null};
  await summary.enqueueSummaryJob([message],params);await summary.runSummaryMaintenance('worker');
  assert.equal(modelCalls,1);assert.equal(indexCalls,0);assert.equal(state.coreMemory,'summary');
  let index=[...jobsMap.values()].find(j=>j.kind==='summary-index');assert.equal(index.status,'deferred');assert.equal(index.attempt,0);
  state.backupConfig.ragEnabled=true;await summary.runSummaryMaintenance('worker');
  index=jobsMap.get(index.id);assert.equal(index.status,'retrying');assert.equal(indexCalls,1);assert.equal(modelCalls,1);
  failIndex=false;index.retryAt=0;jobsMap.set(index.id,index);await summary.runSummaryMaintenance('worker');
  assert.equal(jobsMap.get(index.id).status,'completed');assert.equal(indexCalls,2);assert.equal(modelCalls,1,'index retry must not regenerate');
  const next={id:'m2',role:'user',text:'next',timestamp:2,contentRevision:'r2'};messageMap.set('m2',next);
  const before=copy(state.summaryArchiveState), nextParams={...params,currentCount:2,currentMemory:'summary',archiveState:before,nextSegmentStartTurn:2};
  await summary.enqueueSummaryJob([next],nextParams);mutateSource=true;await summary.runSummaryMaintenance('worker');
  const stale=[...jobsMap.values()].find(row=>row.kind==='summary-generate' && row.payload.messages[0].id==='m2');
  assert.equal(stale.status,'superseded');assert.equal(JSON.stringify(state.summaryArchiveState),JSON.stringify(before),'source mutation cannot advance cursor');
  const legacy={id:'m3',role:'user',text:'legacy',timestamp:3,contentRevision:'r3'};messageMap.set('m3',legacy);
  const pending={segmentEndMessageId:'m3',summaryText:'old summary',notebook:'old notebook',chunks:['already','remaining'],timeRangeStr:'old',savedChunkPayloads:['【MEMORY CHUNK (old)】\nalready']};
  state.summaryArchiveState={...state.summaryArchiveState,activeSegmentId:'legacy',pendingArchive:pending};
  values.set('archive',copy(state.summaryArchiveState));state.backupConfig.ragEnabled=false;
  const callsBefore=modelCalls;
  await summary.enqueueSummaryJob([legacy],{...params,currentCount:3,currentMemory:'summary',archiveState:copy(state.summaryArchiveState),nextSegmentStartTurn:3});
  await summary.runSummaryMaintenance('worker');
  const migrated=[...jobsMap.values()].find(row=>row.kind==='summary-index' && row.sourceId==='legacy');
  assert.equal(modelCalls,callsBefore,'legacy pending output is reused');
  assert.equal(migrated.payload.chunks.length,1,'already indexed legacy chunk must not be duplicated');
  assert.ok(migrated.payload.chunks[0].includes('remaining'));
  const failed={id:'m4',role:'user',text:'retry',timestamp:4,contentRevision:'r4'};messageMap.set('m4',failed);
  const archiveBefore=copy(state.summaryArchiveState);failModel=true;mutateSource=false;
  await summary.enqueueSummaryJob([failed],{...params,currentCount:4,currentMemory:'old summary',archiveState:archiveBefore,nextSegmentStartTurn:4});
  await summary.runSummaryMaintenance('worker');
  let failedJob=[...jobsMap.values()].find(row=>row.kind==='summary-generate' && row.payload.messages[0].id==='m4');
  assert.equal(failedJob.status,'retrying');assert.equal(JSON.stringify(state.summaryArchiveState),JSON.stringify(archiveBefore));
  failModel=false;failedJob.retryAt=0;jobsMap.set(failedJob.id,failedJob);await summary.runSummaryMaintenance('worker');
  failedJob=jobsMap.get(failedJob.id);assert.equal(failedJob.status,'completed','failed generation retries from saved task');
  console.log('Summary jobs passed: durable checkpoint, cursor commit, disabled RAG and index-only retry.');
})().catch(error=>{console.error(error);process.exitCode=1;});
