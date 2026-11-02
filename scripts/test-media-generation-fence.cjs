'use strict';
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), assert = require('node:assert/strict');
const code = ts.transpileModule(fs.readFileSync('services/mediaWriteFence.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
let memory = 'generation-a', restore = 'restore-a', deleted = 0;
const deps = { './dataRestoreGate': { assertDataWritesAllowed() {}, getDataRestoreVersion: () => restore },
  './memoryMaintenanceGate': { getMemoryGeneration: () => memory, assertMemoryAvailable: expected => { if (expected !== memory) throw Error('memory changed'); } } };
const moduleFixture = { exports: {} };
vm.runInNewContext(code, { module: moduleFixture, exports: moduleFixture.exports, navigator: { locks: { request: async (_name, fn) => fn() } }, require: id => deps[id] });
(async () => {
  const { withMediaWriteFence } = moduleFixture.exports;
  await assert.rejects(withMediaWriteFence('restore-a', async () => { memory = 'generation-b'; return 'written'; }, 'generation-a', async () => { deleted++; }), /memory changed/);
  assert.equal(deleted, 1, 'the newly written media is removed while holding the fence');
  await assert.rejects(withMediaWriteFence('restore-a', async () => { throw Error('must not write'); }, 'generation-a'), /memory changed/);
  memory = 'generation-a';
  assert.equal(await withMediaWriteFence('restore-a', async () => 'ok', 'generation-a'), 'ok');
  console.log('Media generation fence passed: stale generation rejects writes and compensates an invalidated new file.');
})().catch(error => { console.error(error); process.exitCode = 1; });
