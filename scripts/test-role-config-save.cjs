'use strict';
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), assert = require('node:assert/strict');
const crypto = require('node:crypto').webcrypto;
const rows = new Map(), keyvals = new Map();
const storage = { getItem: key => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value), removeItem: key => rows.delete(key) };
const db = { keyval: { async put(row) { keyvals.set(row.key, row.value); } }, async transaction(_mode, _table, work) { return work(); } };
function load(file, deps = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, localStorage: storage, crypto, URL, console, require: id => { if (!(id in deps)) throw Error(id); return deps[id]; } });
  return module.exports;
}
const app = load('services/appConfig.ts');
const native = { hasNativeCredentials: () => false };
const profiles = load('services/roleProfiles.ts', { './appConfig': app, './nativeCredentials': native, './dataRestoreGate': { assertDataWritesAllowed() {}, getDataRestoreVersion: () => 'initial' } });
const router = load('services/taskModelRouter.ts', { './appConfig': app, './roleProfiles': profiles });
const core = load('services/llmCore.ts', { '@google/genai': {}, './llmProviderService': {}, './appConfig': app,
  './preferencesSync': { queueLocalStoragePreferenceSync: (key, value) => storage.setItem(key, value) },
  './dataRestoreGate': { assertDataWritesAllowed() {}, getDataRestoreVersion: () => 'initial' },
  './memoryMaintenanceGate': { getMemoryGeneration: () => 'initial' }, './nativeCredentials': native,
  './roleProfiles': profiles, './taskModelRouter': router, './taskRuntime': { MODEL_REVISIONS_KEY: 'revisions' }, './taskGateway': {}, './db': { db } });
(async () => {
  const ref = await profiles.storeModelConnectionCredential('openai', undefined, 'secret-fixture');
  let config = { ...app.DEFAULT_AI_CONFIG, modelConnections: [{ id: 'independent', provider: 'openai', credentialRefs: { primary: ref }, activeKey: 'primary', revision: 1 }], modelRoleBindings: { memory: { profileId: 'independent', model: 'm1', revision: 1 } } };
  assert.equal((await core.setAIConfig(config)).ok, true);
  assert.ok(!storage.getItem('kumiko_ai_config').includes('secret-fixture'));
  const saved = core.getCurrentAIConfig(), previous = saved.modelConfigRevisions;
  config = { ...saved, model_summary: 'new-summary' };
  assert.equal((await core.setAIConfig(config)).ok, true);
  const revised = core.getCurrentAIConfig().modelConfigRevisions;
  assert.equal(revised.subject, previous.subject);
  assert.equal(revised.memory, previous.memory, 'explicit profile does not inherit summary model');
  assert.notEqual(revised.diary, previous.diary);
  assert.deepEqual(JSON.parse(JSON.stringify(keyvals.get('revisions'))), JSON.parse(JSON.stringify(revised)));
  config = { ...core.getCurrentAIConfig(), modelConnections: [{ ...saved.modelConnections[0], baseUrl: 'https://other.example/v1/chat/completions' }] };
  assert.equal((await core.setAIConfig(config)).ok, false, 'existing reference cannot move to another endpoint');
  console.log('Role config save passed: protected references, affected-role revisions, durable versions and endpoint rebinding rejection.');
})().catch(error => { console.error(error); process.exitCode = 1; });
