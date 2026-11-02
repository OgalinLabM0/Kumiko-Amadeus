'use strict';
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), assert = require('node:assert/strict');
const code = ts.transpileModule(fs.readFileSync('services/taskGateway.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const listeners = new Map(), completed = [], attempts = [];
const windowFixture = { addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); }, removeEventListener(type, fn) { listeners.get(type)?.delete(fn); } };
const deps = {
  './dataRestoreGate': { assertDataWritesAllowed() {}, getDataRestoreVersion: () => 'initial', subscribeDataRestore: () => () => {} },
  './memoryMaintenanceGate': { assertMemoryAvailable() {}, getMemoryGeneration: () => 'initial', subscribeMemoryMaintenance: () => () => {} },
  './taskRuntime': { async beginForegroundActivity() {}, async endForegroundActivity() {}, async reserveTaskRequest(_context, target) { attempts.push(target); return 'attempt'; }, async finishTaskRequest(_id, status) { completed.push(status); } },
};
const m = { exports: {} };
vm.runInNewContext(code, { module: m, exports: m.exports, window: windowFixture, AbortController, DOMException, Date, setTimeout, clearTimeout, require: id => deps[id] });
const { runTaskTransport } = m.exports;
const context = { taskId: 'task', rootId: 'turn', role: 'subject', lane: 'foreground', deadlineAt: Date.now() + 30000, epoch: 'initial', memoryGeneration: 'initial', modelRevisions: {} };
(async () => {
  let valid = true, release;
  const target = { provider: 'fixture', model: 'fixture', operation: 'chat', configRevision: 'rev1' };
  const pending = runTaskTransport(context, target, signal => new Promise(resolve => { release = () => resolve(signal.aborted); }), () => { if (!valid) throw Error('changed'); });
  await new Promise(resolve => setImmediate(resolve));
  valid = false; for (const fn of listeners.get('kumiko:model-config-changed')) fn();
  release();
  await assert.rejects(pending, /cancelled|expired/);
  assert.equal(completed[0], 'cancelled'); assert.equal(context.modelRevisions.subject, 'rev1');
  assert.ok([...listeners.values()].every(set => set.size === 0));
  assert.equal(attempts.length, 1);
  console.log('Task gateway passed: captured revision, in-flight settings cancellation, late result rejection and listener cleanup.');
})().catch(error => { console.error(error); process.exitCode = 1; });
