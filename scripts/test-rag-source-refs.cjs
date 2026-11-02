'use strict';
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), assert = require('node:assert/strict');
const messages = [{ id: 'one', role: 'user', text: 'first fixture', timestamp: 10, contentRevision: 'r1' }, { id: 'two', role: 'model', text: 'second fixture', timestamp: 20, contentRevision: 'r2' }];
const db = { messages: { async get(id) { return messages.find(row => row.id === id); }, orderBy: () => ({ toArray: async () => messages }) }, async getVal(_key, fallback) { return fallback; } };
const invoke = async channel => channel === 'rag:search' ? { success: true, results: [{ text: 'first fixture', messageId: 'one', source: 'rebuild_message', timestamp: 10 }] } : { success: true, messages };
const code = ts.transpileModule(fs.readFileSync('services/localRagService.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const moduleFixture = { exports: {} };
vm.runInNewContext(code, { module: moduleFixture, exports: moduleFixture.exports, window: { electronAPI: { invoke } }, Intl, Date, Float32Array, console,
  require(id) { if (id === './db') return { db }; if (id === './environment') return { isCapacitorNative: () => false }; if (id === './androidRagService') return {}; if (id === './taskRuntime') return { TaskCapacityError: class extends Error {} }; if (id === './memoryMaintenanceGate') return {getMemoryGeneration:()=> 'initial',assertMemoryAvailable(){}}; if (id === './artifactIndexService') return { filterValidArtifactCandidates: async rows => rows }; throw Error(id); } });
(async () => {
  const context = { consultedSources: [] };
  const result = await moduleFixture.exports.searchLocalRagMemoryDetailed('fixture', 1, undefined, 'default', undefined, { taskContext: context });
  assert.ok(result.blocks[0].includes('second fixture'));
  assert.deepEqual(JSON.parse(JSON.stringify(context.consultedSources.map(({ id, version }) => ({ id, version })).sort((a, b) => a.id.localeCompare(b.id)))), [{ id: 'one', version: 'r1' }, { id: 'two', version: 'r2' }]);
  assert.ok(!JSON.stringify(context.consultedSources).includes('fixture'));
  console.log('RAG source references passed: expanded neighboring messages record ids and revisions only.');
})().catch(error => { console.error(error); process.exitCode = 1; });
