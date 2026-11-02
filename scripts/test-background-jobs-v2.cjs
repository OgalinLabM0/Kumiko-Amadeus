'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
let now = 1_000_000, generation = 'initial', restore = '';
const data = new Map(), values = new Map();
const copy = value => value === undefined ? undefined : structuredClone(value);
const table = {
  get: async id => copy(data.get(id)),
  put: async value => { data.set(value.id, copy(value)); },
  toArray: async () => [...data.values()].map(copy),
};
const db = {
  table: name => { assert.equal(name, 'runtimeJobs'); return table; },
  keyval: { get: async key => values.has(key) ? { key, value: copy(values.get(key)) } : undefined },
  transaction: async (...args) => args.at(-1)(),
};
class Clock extends Date { static now() { return now; } }
const deps = {
  './db': { db },
  './dataRestoreGate': { assertDataWritesAllowed() {}, getDataRestoreVersion: () => restore },
  './memoryMaintenanceGate': { getMemoryGeneration: () => generation, assertMemoryGenerationCurrent: async g => { if (g !== generation) throw Error('generation changed'); } },
};
const moduleBox = { exports: {} };
const source = ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../services/backgroundJobs.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(source, { module: moduleBox, exports: moduleBox.exports, Date: Clock, crypto,
  require(id) { assert.ok(deps[id], id); return deps[id]; }, console });
const jobs = moduleBox.exports;
(async () => {
  const input = { id: 'fixture', kind: 'test', sourceId: 'source', sourceVersion: 'v1' };
  await jobs.enqueueBackgroundJob(input);
  await jobs.enqueueBackgroundJob(input);
  assert.equal(data.size, 1);
  let claim = await jobs.claimBackgroundJob('test', 'window-a');
  assert.equal(await jobs.claimBackgroundJob('test', 'window-b'), null);
  await jobs.checkpointBackgroundJob(claim, { stage: 1 });
  now += 20_000;
  assert.equal(await jobs.renewBackgroundJobClaim(claim), now + 120_000);
  assert.equal(data.get('fixture').checkpoint.stage, 1);
  await jobs.deferBackgroundJob(claim, now + 5000);
  assert.equal(data.get('fixture').attempt, 0);
  now += 5000;
  claim = await jobs.claimBackgroundJob('test', 'window-b');
  restore = 'replacement';
  await assert.rejects(() => jobs.finishBackgroundJob(claim, 'completed'));
  restore = '';
  generation = 'new';
  await assert.rejects(() => jobs.renewBackgroundJobClaim(claim));
  generation = 'initial';
  now = claim.job.leaseUntil + 1;
  claim = await jobs.claimBackgroundJob('test', 'window-c');
  assert.equal(claim.job.attempt, 2, 'interrupted attempt counts');
  await jobs.finishBackgroundJob(claim, 'completed');
  assert.equal(data.get('fixture').status, 'completed');
  await jobs.enqueueBackgroundJob({...input,id:'json',payload:{missing:undefined,valid:'text'}});
  assert.equal(Object.hasOwn(data.get('json').payload,'missing'),false,'optional fields remain backup-safe');
  await assert.rejects(jobs.enqueueBackgroundJob({...input,id:'invalid',payload:{bad:NaN}}),/invalid number/);
  console.log('Background task checks passed: idempotency, claim, checkpoint, renewal, capacity wait, recovery and generation fences.');
})().catch(error => { console.error(error); process.exitCode = 1; });
