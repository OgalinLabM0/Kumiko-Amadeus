#!/usr/bin/env node
// In-memory database and synthetic requests only; no network or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
const rows = new Map();
const table = {
  add: async row => { rows.set(row.id, row); },
  get: async id => rows.get(id),
  update: async (id, patch) => Object.assign(rows.get(id), patch),
  where(field) {
    const query = predicate => {
      let filter = predicate;
      return { filter(fn) { const old = filter; filter = row => old(row) && fn(row); return this; },
        async toArray() { return [...rows.values()].filter(filter); },
        async count() { return [...rows.values()].filter(filter).length; } };
    };
    return { equals: value => query(row => row[field] === value), above: value => query(row => row[field] > value) };
  },
};
let queue = Promise.resolve();
const values = new Map();
const db = { table: () => table, keyval: { async get(key) { return values.has(key) ? { key, value: values.get(key) } : undefined; }, async put(row) { values.set(row.key, row.value); } }, transaction(_mode, ...args) {
  const run = queue.then(args.at(-1)); queue = run.catch(() => {}); return run;
} };
const code = ts.transpileModule(fs.readFileSync('services/taskRuntime.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleFixture = { exports: {} };
vm.runInNewContext(code, { module: moduleFixture, exports: moduleFixture.exports, Date, crypto,
  require(id) { if (id === './db') return { db }; if (id === './memoryMaintenanceGate') return {
    assertMemoryAvailable() {}, async assertMemoryGenerationCurrent() {},
  }; throw Error(id); } });
const { reserveTaskRequest, finishTaskRequest, beginForegroundActivity, endForegroundActivity } = moduleFixture.exports;
const target = { provider: 'fixture', operation: 'text', configRevision: '1' };
const context = { taskId: 'a', rootId: 'turn', role: 'subject', lane: 'foreground', deadlineAt: Date.now() + 180000,
  epoch: 'initial', memoryGeneration: 'initial', inputSources: [{kind: 'message', id: 'current', version: 'v1', text: 'PRIVATE FIXTURE'}],
  consultedSources: [{kind: 'message', id: 'history', version: 'v2', relation: 'context'}] };
(async () => {
  const first = await reserveTaskRequest(context, target);
  assert.deepEqual(JSON.parse(JSON.stringify(rows.get(first).sourceRefs)), [
    {kind:'message', id:'current', version:'v1'}, {kind:'message', id:'history', version:'v2', relation:'context'}]);
  assert.ok(!JSON.stringify(rows.get(first)).includes('PRIVATE FIXTURE'));
  await assert.rejects(reserveTaskRequest({ ...context, taskId: 'b' }, target), e => e.kind === 'busy');
  await finishTaskRequest(first, 'succeeded');
  for (let i = 0; i < 7; i++) { const id = await reserveTaskRequest(context, target); await finishTaskRequest(id, 'failed'); }
  await assert.rejects(reserveTaskRequest(context, target), e => e.kind === 'budget');
  const bg = { ...context, rootId: 'bg', lane: 'background' };
  await beginForegroundActivity(context);
  await assert.rejects(reserveTaskRequest(bg, target), e => e.kind === 'busy');
  await endForegroundActivity(context);
  values.set('kumiko_background_network_paused_v1', true);
  await assert.rejects(reserveTaskRequest(bg, target), e => e.kind === 'paused');
  values.set('kumiko_background_network_paused_v1', false);
  values.set('kumiko_model_config_revisions_v1', { subject: 'new-revision' });
  await assert.rejects(reserveTaskRequest({ ...context, rootId: 'other', modelRevisions: { subject: 'old-revision' } }, target), /configuration changed/);
  for (let i = 0; i < 20; i++) { const id = await reserveTaskRequest(bg, target); await finishTaskRequest(id, 'succeeded'); }
  await assert.rejects(reserveTaskRequest(bg, target), e => e.kind === 'budget' && e.nextEligibleAt > Date.now());
  const localId = await reserveTaskRequest(bg, { ...target, operation: 'tts-local', remote: false });
  await finishTaskRequest(localId, 'succeeded');
  console.log('Task request reservation passed: cross-caller slot, foreground attempts and hourly background budget.');
})().catch(error => { console.error(error); process.exitCode = 1; });
