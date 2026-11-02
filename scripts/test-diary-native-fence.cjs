'use strict';

// Reuse the isolated production-IPC fixture; it never opens a user profile.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
let source = fs.readFileSync(path.join(__dirname, 'test-rag-restore-fence.cjs'), 'utf8');
source = source.slice(0, source.lastIndexOf('(async () => {'));
source = source.replace('const sender = {};', 'const sender = new EventEmitter();')
  .replace('const stranger = {};', 'const stranger = new EventEmitter();')
  .replace("['isDataRestoreActive', 'assertRagGeneration'", "['isDataRestoreActive', 'isDataResetOwner', 'assertRagGeneration'")
  .replace('writes: () => writes, clears:', 'sender, writes: () => writes, clears:');
source += `
(async () => {
  const wait = deferred();
  const h = load({ embeddings: [wait] });
  const id = 'diary-2026-11-01';
  const lease = { id, token: 'old', leaseUntil: Date.now() + 60000 };
  const mutation = { id, token: 'edit', mutation: true };
  assert.equal((await h.invoke('rag:diary-lease', lease)).success, true);
  const pending = h.invoke('rag:save', { id, text: 'old diary', source: 'diary',
    canonicalKey: 'diary:2026-11-01', tier: 'core', backgroundJob: lease });
  assert.equal(h.embeddingCalls(), 1);
  assert.equal((await h.invoke('rag:diary-lease', mutation)).success, true);
  assert.equal((await h.invoke('rag:diary-lease', { ...lease, token: 'new' })).success, false);
  assert.equal((await h.invoke('rag:diary-lease', { ...mutation, release: true }, h.stranger)).success, true);
  assert.equal((await h.invoke('rag:diary-lease', { ...lease, token: 'new' })).success, false);
  wait.resolve(new Float32Array(dimension).fill(0.5));
  assert.equal((await pending).success, false);
  assert.equal(h.writes(), 0);
  assert.equal((await h.lock('begin')).success, true);
  assert.equal((await h.invoke('rag:diary-lease', { ...mutation, release: true })).success, true);
  assert.equal((await h.lock('end')).success, true);
  assert.equal((await h.invoke('rag:diary-lease', { ...lease, token: 'new', leaseUntil: lease.leaseUntil + 1 })).success, true);
  assert.equal((await h.lock('begin')).success, true);
  assert.equal(h.sandbox.isDataResetOwner({sender:h.sender}, 'session'), false);
  assert.equal((await h.lock('end')).success, true);
  assert.equal((await h.invoke('rag:restore-lock', {id:'purge', action:'begin', kind:'reset'})).success, true);
  assert.equal(h.sandbox.isDataResetOwner({sender:h.sender}, 'purge'), true);
  assert.equal(h.sandbox.isDataResetOwner({sender:h.sender}, 'wrong'), false);
  assert.equal(h.sandbox.isDataResetOwner({sender:h.stranger}, 'purge'), false);
  assert.equal((await h.invoke('rag:restore-lock', {id:'purge', action:'end'})).success, true);
  const wait2 = deferred(), h2 = load({ embeddings: [wait2] });
  const original = { id, token:'renewable', leaseUntil:Date.now()+45000, claim:{job:{deadlineAt:Date.now()+180000}} };
  assert.equal((await h2.invoke('rag:diary-lease',original)).success,true);
  const saving = h2.invoke('rag:save',{id,text:'fixture',source:'diary',canonicalKey:'diary:2026-11-01',tier:'core',backgroundJob:original});
  const renewed = {...original,renew:true,leaseUntil:Date.now()+110000};
  assert.equal((await h2.invoke('rag:diary-lease',renewed,h2.stranger)).success,false);
  assert.equal((await h2.invoke('rag:diary-lease',renewed)).success,true);
  wait2.resolve(new Float32Array(dimension).fill(0.5));
  assert.equal((await saving).success,true,'in-flight request remains valid after renewal');
  await h2.invoke('rag:diary-lease',{...original,release:true});
  assert.equal((await h2.invoke('rag:diary-lease',{...renewed,leaseUntil:renewed.leaseUntil+1})).success,false);
  console.log('Diary native fence: in-flight write, mutation exclusion, ownership, and restore release passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });`;
vm.runInThisContext(`(function(require, __dirname, EventEmitter) { ${source}\n})`, { filename: __filename })(require, __dirname, EventEmitter);
