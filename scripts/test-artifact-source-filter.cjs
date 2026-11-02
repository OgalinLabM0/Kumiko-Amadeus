'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
let generation='g1', corrections=[]; const values=new Map(), messages=new Map();
const db={keyval:{get:async key=>values.has(key)?{key,value:structuredClone(values.get(key))}:undefined},
  messages:{get:async id=>messages.get(id)},kumikoDiary:{get:async()=>undefined},dailyFragments:{get:async()=>undefined},memoryCorrections:{toArray:async()=>corrections},
  transaction:async(...args)=>args.at(-1)()};
const deps={'./db':{db},'./dataRestoreGate':{getDataRestoreVersion:()=> 'epoch'},
  './memoryMaintenanceGate':{assertMemoryGenerationCurrent:async g=>{if(g!==generation)throw Error('stale');}},
  './backgroundJobs':{},'./environment':{},'./androidRagService':{}};
const moduleBox={exports:{}};
const source=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../services/artifactIndexService.ts'),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
vm.runInNewContext(source,{module:moduleBox,exports:moduleBox.exports,require:id=>{assert.ok(deps[id],id);return deps[id];},console});
const {filterValidArtifactCandidates}=moduleBox.exports;
(async()=>{
  const id='ka-'+'a'.repeat(64), key='kumiko_summary_artifact_v1:'+id;
  const artifact={text:'derived',canonicalKey:'ka-artifact:'+id+':0',artifactState:'active'}, ordinary={text:'other'};
  const registry={id,version:'v1',state:'staged',epoch:'epoch',memoryGeneration:'g1',sourceRefs:[{kind:'message',id:'m',version:'revision-a'}]};
  messages.set('m',{id:'m',contentRevision:'revision-a'}); values.set(key,registry);
  assert.equal((await filterValidArtifactCandidates([artifact,ordinary])).length,1,'staged artifact is hidden');
  registry.state='active'; assert.equal((await filterValidArtifactCandidates([artifact,ordinary])).length,2);
  assert.equal((await filterValidArtifactCandidates([{...artifact,artifactState:undefined}])).length,0,'missing native metadata fails closed');
  messages.set('m',{id:'m',contentRevision:'revision-b'});
  assert.equal((await filterValidArtifactCandidates([artifact,ordinary])).length,1,'edited source is hidden');
  messages.set('m',{id:'m',contentRevision:'revision-a'}); generation='g2';
  assert.equal((await filterValidArtifactCandidates([artifact,ordinary])).length,1,'changed memory generation is hidden');
  generation='g1';corrections=[{messageIds:['m'],artifactIds:[],sourceVersions:{}}];
  assert.equal((await filterValidArtifactCandidates([artifact])).length,0,'corrected source cannot be resurrected');
  corrections=[];
  values.delete(key); assert.equal((await filterValidArtifactCandidates([artifact])).length,0,'missing provenance fails closed');
  console.log('Artifact candidate filter passed: staged, source change, generation change, missing provenance.');
})().catch(error=>{console.error(error);process.exitCode=1;});
