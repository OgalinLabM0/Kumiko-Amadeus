'use strict';
const assert=require('node:assert/strict');
const {registerArtifactIndex,replaceArtifactProvenance}=require('../electron/artifact-index.cjs');
const handlers=new Map(), metadata=new Map(), vectors=new Map(); let generation=1;
let failInsert=false;
const db={exec(sql){if(sql==='DELETE FROM artifact_registry')metadata.clear();},prepare(sql){
  if(sql.startsWith('PRAGMA table_info'))return{all:()=>[{name:'source_epoch'},{name:'memory_generation'}]};
  if(sql.startsWith('SELECT * FROM artifact_registry'))return{get:id=>metadata.get(id)};
  if(sql.startsWith('INSERT OR REPLACE INTO artifact_registry'))return{run:(id,version,token,lease_until,gen,state,sources,chunks,source_epoch,memory_generation)=>{if(failInsert)throw Error('injected');metadata.set(id,{id,version,token,lease_until,generation:gen,state,sources,chunks,source_epoch,memory_generation});}};
  if(sql.startsWith('SELECT id,text,canonical_key FROM vectors'))return{get:id=>vectors.get(id)};
  if(sql.startsWith('UPDATE artifact_registry'))return{run:(id,token)=>{const row=metadata.get(id);if(row?.token===token)row.state='active';}};
  throw Error(sql);
}};
registerArtifactIndex({handle:(name,fn)=>handlers.set(name,fn)},()=>db,()=>generation,()=>true);
const invoke=(name,payload)=>handlers.get(name)({},payload);
(async()=>{
  const id='ka-'+'a'.repeat(64), chunkId=id+':0', canonical='ka-artifact:'+chunkId;
  const payload={id,version:'v1',token:'owner',leaseUntil:Date.now()+60000,epoch:'epoch',memoryGeneration:'initial',sourceRefs:[{kind:'message',id:'m',version:'r'}],
    chunkIds:[chunkId],canonicalKeys:[canonical],textChunks:['fixture']};
  assert.equal((await invoke('rag:artifact-stage',payload)).success,true);
  assert.equal((await invoke('rag:artifact-stage',{...payload,renew:true,token:'other',leaseUntil:Date.now()+90000})).success,false);
  assert.equal((await invoke('rag:artifact-stage',{...payload,renew:true,leaseUntil:Date.now()+90000})).success,true);
  assert.equal((await invoke('rag:artifact-commit',payload)).success,false,'no vector is not ready');
  vectors.set(chunkId,{id:chunkId,text:'wrong',canonical_key:canonical});
  assert.equal((await invoke('rag:artifact-commit',payload)).success,false,'mismatched text is not ready');
  vectors.set(chunkId,{id:chunkId,text:'fixture',canonical_key:canonical});
  assert.equal((await invoke('rag:artifact-commit',{...payload,token:'other'})).success,false);
  assert.equal((await invoke('rag:artifact-commit',payload)).success,true);
  assert.equal(metadata.get(id).state,'active');
  assert.equal((await invoke('rag:artifact-get',{id:chunkId})).row.text,'fixture');
  generation++;assert.equal((await invoke('rag:artifact-commit',payload)).success,false,'old generation rejected');
  const item={id:chunkId,canonicalKey:canonical,artifactId:id,artifactVersion:'v1',sourceRefs:payload.sourceRefs};
  const transaction=fn=>{const previous=structuredClone(metadata);try{return fn();}catch(error){metadata.clear();for(const [key,value] of previous)metadata.set(key,value);throw error;}};
  failInsert=true;assert.throws(()=>transaction(()=>replaceArtifactProvenance(db,[item],generation)),/injected/);
  assert.equal(metadata.get(id).state,'active','failed restore preserves previous metadata');
  failInsert=false;transaction(()=>replaceArtifactProvenance(db,[item],generation));
  assert.equal(metadata.get(id).state,'staged');assert.deepEqual(JSON.parse(metadata.get(id).sources),payload.sourceRefs);
  console.log('Artifact native metadata passed: staged, readback verification, ownership and generation.');
})().catch(error=>{console.error(error);process.exitCode=1;});
