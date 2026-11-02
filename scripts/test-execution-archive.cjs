#!/usr/bin/env node
'use strict';
// Production archive/backup code over isolated transactional memory. No user
// data, external service, paid model or real backup is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto').webcrypto;
const root = path.resolve(__dirname, '..');
const clone = value => structuredClone(value);
let rows = new Map(), messages = new Map(), failArchiveWrite = false;
const runtimeMaps = new Map();
function runtimeTable(name) {
  if (!runtimeMaps.has(name)) runtimeMaps.set(name,new Map());
  const map=runtimeMaps.get(name);
  return {toArray:async()=>[...map.values()].map(clone),get:async id=>map.has(id)?clone(map.get(id)):undefined,
    where:field=>({above:value=>({toArray:async()=>[...map.values()].filter(row=>row[field]>value).map(clone)})}),
    put:async row=>map.set(row.id,clone(row)),clear:async()=>map.clear()};
}
const db = {
  table: runtimeTable,
  memoryCorrections: runtimeTable('memoryCorrections'),
  runtimeRequestAttempts: runtimeTable('runtimeRequestAttempts'),
  keyval: {
    get: async key => rows.has(key) ? {key, value: clone(rows.get(key))} : undefined,
    put: async ({key, value}) => { if (failArchiveWrite && key.startsWith('kumiko_turn_archive_v1:')) throw Error('injected archive write failure'); rows.set(key, clone(value)); },
    bulkPut: async items => { for (const {key,value} of items) rows.set(key, clone(value)); },
    bulkDelete: async keys => { for (const key of keys) rows.delete(key); },
    filter: predicate => ({
      toArray: async () => [...rows].map(([key,value]) => ({key,value:clone(value)})).filter(predicate),
      primaryKeys: async () => [...rows].filter(([key,value]) => predicate({key,value})).map(([key]) => key),
    }),
    where: () => ({
      startsWith: prefix => ({ primaryKeys: async () => [...rows.keys()].filter(key => key.startsWith(prefix)),
        toArray:async()=>[...rows].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,value:clone(value)})) }),
      between: (start,end,includeStart,includeEnd) => {
        const selected = () => [...rows].filter(([key]) => (includeStart ? key >= start : key > start) && (includeEnd ? key <= end : key < end))
          .sort(([a],[b]) => a.localeCompare(b)).map(([key,value]) => ({key,value:clone(value)}));
        return { filter: predicate => ({ limit: n => ({ toArray: async () => selected().filter(predicate).slice(0,n) }) }) };
      },
    }),
  },
  messages: { get: async id => clone(messages.get(id)) },
  async transaction(mode, _tables, work) {
    const before = mode === 'rw' ? clone(rows) : null;
    try { return await work(); } catch (error) { if (before) rows = before; throw error; }
  },
};
function load(file, deps) {
  const module = {exports:{}};
  const code = ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code, {module,exports:module.exports, crypto, TextEncoder, TextDecoderStream, Blob, Response,
    CompressionStream, DecompressionStream, btoa, atob, Date, console, require(id) { if (id in deps) return deps[id]; throw Error(id); }}, {filename:file});
  return module.exports;
}
const gate = {assertDataWritesAllowed(){}, getDataRestoreVersion:()=>'fixture', isDataRestoreBlocked:()=>false};
const memory={getMemoryGeneration:()=> 'initial',isMemoryMaintenanceBlocked:()=>false,assertMemoryAvailable(){},assertMemoryGenerationCurrent:async()=>{}};
const archive = load('services/executionArchive.ts', {'./db':{db}, './dataRestoreGate':gate, './memoryMaintenanceGate':memory});
const jobs = load('services/backgroundJobs.ts', {'./db':{db}, './dataRestoreGate':gate, './memoryMaintenanceGate':memory});
const effects = load('services/responseEffectCommit.ts', {'./db':{db}, './dataRestoreGate':gate, './memoryMaintenanceGate':memory,
  './taskRuntime':{assertTaskModelRevisionsCurrent:async()=>{}}, './artifactIndexService':{assertSourceRefsCurrent:async()=>{}}});
const runtime = load('services/runtimeStateBackup.ts', {'./db':{db}});
const backup = load('services/turnStateBackup.ts', {'./voiceWriteRecord':load('services/voiceWriteRecord.ts', {}), './db':{db}, './dataRestoreGate':gate,
  './executionArchive':archive, './backgroundJobs':jobs, './responseEffectCommit':effects,
  './runtimeStateBackup':runtime, './memoryMaintenanceGate':memory});
const coordinator = load('services/turnCoordinator.ts', {'./db':{db}, './llmCore':{}, './taskModelRouter':{},
  './reminderTime':{}, './userKnownLocation':{}, './turnUnderstanding':{}, './dataRestoreGate':gate, './memoryMaintenanceGate':memory,
  './taskRuntime':{beginForegroundActivity:async()=>{},endForegroundActivity:async()=>{}}});
const now = Date.parse('2026-11-01T08:00:00Z');
function makeTurn(id, changes = {}) {
  const source = {id:'user-'+id,role:'user',text:'input '+id,timestamp:1};
  const turn = {id,epoch:'fixture-epoch',sequence:1,createdAt:1,privateTimeZone:'UTC',sources:[source],
    receipts:[{actionId:id+':a',kind:'create',status:'saved',reminderId:'past-'+id}],
    response:{textParts:['answer '+id]}, understanding:{padding:'A'.repeat(8000)}, ...changes};
  rows.set('kumiko_turn_v1:'+id,clone(turn)); rows.set('kumiko_turn_source_v1:'+source.id,{turnId:id});
  messages.set(source.id,source); messages.set(`turn-reply:${turn.epoch}:${id}:0`,{role:'model',text:'answer '+id});
  return turn;
}
async function main() {
  const valid=makeTurn('a-valid');
  const active=makeTurn('b-active',{owner:'active',leaseUntil:now+1000});
  const unread=makeTurn('c-not-shown',{response:{textParts:['answer c-not-shown','second']}});
  const pending=makeTurn('d-pending'); rows.set('kumiko_turn_pending_v1',{turnId:pending.id, source:pending.sources[0],
    candidate:{kind:'create',sourceMessageId:pending.sources[0].id,sourceQuote:pending.sources[0].text}});
  const unstable=makeTurn('e-unfinished',{receipts:[{status:'needs_clarification'}]});
  const protectedTurn=makeTurn('f-reminder-active'); rows.set('kumiko_daily_reminders',[{id:'past-f-reminder-active'}]);
  assert.equal(await archive.archiveCompletedTurns(20,now),1);
  const hot=rows.get('kumiko_turn_v1:a-valid');
  assert.ok(hot.archived); assert.deepEqual(hot.sources,valid.sources); assert.deepEqual(hot.receipts,valid.receipts);
  assert.equal(JSON.stringify(await archive.readExecutionArchive(rows.get(hot.archived.key))),JSON.stringify(valid));
  await assert.rejects(coordinator.readTurnSources(valid.sources[0].id),/归档/);
  await assert.rejects(coordinator.createTurnCoordinator({sources:valid.sources,recentMessages:[],language:'zh',
    privateTimeZone:'UTC',reminders:{},isCancelled:()=>false}),/归档/);
  for (const r of [active,unread,pending,unstable,protectedTurn]) assert.deepEqual(rows.get('kumiko_turn_v1:'+r.id),r,`${r.id} must stay hot and unchanged`);
  const failed=makeTurn('z-write-fails'); failArchiveWrite=true;
  await assert.rejects(archive.archiveCompletedTurns(20,now),/injected archive write failure/);
  assert.deepEqual(rows.get('kumiko_turn_v1:'+failed.id),failed,'failed write keeps full hot record'); failArchiveWrite=false;
  const saved=await backup.exportTurnExecutionState();
  const old=clone(rows.get(hot.archived.key)); rows.set(hot.archived.key,{...old,digest:'0'.repeat(64)});
  await assert.rejects(backup.exportTurnExecutionState(),/integrity|archive/i,'damaged archive blocks export');
  rows.set(hot.archived.key,old);
  const altered=clone(saved); const archivedEntry=altered.chunks.flatMap(chunk=>chunk.entries).find(e=>e.key===hot.archived.key); archivedEntry.value.payload='AAAA';
  await assert.rejects(backup.validateExecutionStateIntegrity(altered));
  // Fresh 201001 source identities exceed the v1 entry limit. Verify every key
  // through export, integrity validation and replacement, then corrupt a page.
  rows=new Map(); messages=new Map();
  for(let i=0;i<201001;i++) rows.set('kumiko_turn_source_v1:'+i,{turnId:'t'+i});
  const paged=await backup.exportTurnExecutionState();
  assert.equal(paged.version,3); assert.equal(paged.entryCount,201001); assert.equal(paged.chunks.length,202);
  assert.equal(backup.executionStateEntries(await backup.validateExecutionStateIntegrity(paged)).length,201001);
  const corrupt=clone(paged); corrupt.chunks[0].entries[0].value.turnId='tampered';
  await assert.rejects(backup.validateExecutionStateIntegrity(corrupt),/integrity/i);
  rows=new Map(); await db.transaction('rw',db.keyval,()=>backup.replaceTurnExecutionState(paged));
  assert.equal([...rows.keys()].filter(key=>key.startsWith('kumiko_turn_source_v1:')).length,201001);
  assert.equal(rows.get('kumiko_turn_source_v1:200999').turnId,'t200999');
  assert.equal(backup.parseTurnExecutionState({version:1,entries:[]}).version,1);
  console.log('Execution archive passed: eligibility, source/receipt preservation, write failures, integrity and 201001-entry paging/restore.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
