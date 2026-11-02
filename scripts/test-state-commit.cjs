const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { webcrypto } = require('node:crypto');
let rows = { keyval: {}, messages: {}, kumikoMood: {}, kumikoAffection: {}, stateCommits: {} };
let active = rows, fail = false;
const db = {};
for (const name of Object.keys(rows)) db[name] = {
  async get(id) { return structuredClone(active[name][id]); },
  async put(row) { if (fail && name === 'stateCommits') throw Error('injected'); active[name][row.id ?? row.key] = structuredClone(row); },
};
db.transaction = async (...args) => { const before = rows; active = structuredClone(rows); try { const result = await args.at(-1)(); rows = active; return result; } catch (e) { rows = before; throw e; } finally { active = rows; } };
const mood = { async getMoodState() { return await db.kumikoMood.get('current') || { mood: 0 }; }, async applyMoodDelta(n) { await db.kumikoMood.put({ id: 'current', mood: (await this.getMoodState()).mood + n }); } };
const affection = { async getAffectionState() { return await db.kumikoAffection.get('current') || { score: 55 }; }, async applyAffectionDelta(n) { await db.kumikoAffection.put({ id: 'current', score: (await this.getAffectionState()).score + n }); } };
// Methods in the production module are independent functions; bind mocks likewise.
mood.applyMoodDelta = async n => db.kumikoMood.put({ id:'current', mood: (await mood.getMoodState()).mood+n });
affection.applyAffectionDelta = async n => db.kumikoAffection.put({ id:'current', score: (await affection.getAffectionState()).score+n });
const deps = { './db': {db}, './responseEffectCommit': { RESPONSE_EFFECT_PREFIX: 'effect:' }, './moodService': mood, './affectionService': affection,
 './blockRuntimeService': { blockOutboxKey: id => 'outbox:'+id, createBlockRuntime: v => ({ ...v, startedAt: 1 }), resumeCommittedBlock: async () => {} },
 './memoryMaintenanceGate': {getMemoryGeneration: () => 'initial', assertMemoryGenerationCurrent: async () => {}}, './stateProvenance': {recordStateProvenance: async () => {}},
 '../store': { useAppStore: { getState: () => ({ setMood() {}, setAffection() {} }) } } };
const moduleObj = { exports: {} };
const code = ts.transpileModule(fs.readFileSync('services/stateCommit.ts','utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(code, { module: moduleObj, exports: moduleObj.exports, require: id => { if (!deps[id]) throw Error(id); return deps[id]; }, crypto: webcrypto, TextEncoder, Uint8Array, Date, JSON, Number, Error });
const guard = { epoch:'initial', eventId:'one', sourceRefs:[], isActive: () => true, check: async () => {} };
(async () => {
 const commit = moduleObj.exports.commitReactiveCandidate;
 fail = true; await assert.rejects(commit(guard, { mood: 5, affection: 2, block: {minutes:1,reason:'x'} }));
 assert.deepEqual(rows.kumikoMood, {}); assert.deepEqual(rows.kumikoAffection, {}); assert.deepEqual(rows.keyval, {});
 fail = false; await commit(guard, { mood:5, affection:2, block:{minutes:1,reason:'x'} });
 assert.equal(rows.kumikoMood.current.mood,5); assert.equal(rows.kumikoAffection.current.score,57); assert.ok(rows.keyval['outbox:reaction:one']);
 await commit(guard, { mood:5, affection:2, block:{minutes:1,reason:'x'} }); assert.equal(rows.kumikoMood.current.mood,5);
 await assert.rejects(commit(guard, { mood:6, affection:2, block:{minutes:1,reason:'x'} }), /different payload/);
 await assert.rejects(commit({...guard,eventId:'two'}, {mood:1}, {mood:'stale', affection:'stale'}), /changed after audit/);
 console.log('state reaction atomicity, idempotency, conflict and stale audit checks passed');
})().catch(e => { console.error(e); process.exitCode=1; });
