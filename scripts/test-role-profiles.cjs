'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), crypto = require('node:crypto').webcrypto;
function load(file, deps = {}) {
  const m = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { module: m, exports: m.exports, URL, crypto, require: id => { if (!(id in deps)) throw Error(id); return deps[id]; } });
  return m.exports;
}
const app = load('services/appConfig.ts');
const native = { hasNativeCredentials: () => false };
const profiles = load('services/roleProfiles.ts', { './appConfig': app, './nativeCredentials': native, './dataRestoreGate': { assertDataWritesAllowed() {}, getDataRestoreVersion: () => 'initial' } });
const router = load('services/taskModelRouter.ts', { './appConfig': app, './roleProfiles': profiles });
(async () => {
  const ref = await profiles.storeModelConnectionCredential('openai', 'https://fixture.test/v1/chat/completions', 'fixture-secret');
  assert.match(ref, /^session:/);
  assert.equal(profiles.resolveModelSessionCredential(ref, 'openai', 'https://fixture.test/v1/chat/completions'), 'fixture-secret');
  assert.throws(() => profiles.resolveModelSessionCredential(ref, 'openai', 'https://other.test/v1/chat/completions'), /bound/);
  const config = { ...app.DEFAULT_AI_CONFIG, model_main: 'main', model_summary: 'summary', apiKey_primary: 'legacy',
    modelConnections: [{ id: 'p', provider: 'openai', baseUrl: 'https://fixture.test/v1/chat/completions', credentialRefs: { primary: ref }, activeKey: 'primary', revision: 1 }],
    modelRoleBindings: { recall: { profileId: 'p', model: 'recall-model', revision: 1 } } };
  assert.equal(router.resolveRoleConnection(config, 'subject').model, 'main');
  const target = router.resolveRoleConnection(config, 'recall');
  assert.equal(target.model, 'recall-model'); assert.equal(target.config.apiKey_primary, 'fixture-secret');
  assert.throws(() => router.resolveRoleConnection({ ...config, modelRoleBindings: { recall: { profileId: 'missing', model: 'x', revision: 1 } } }, 'recall'), /unavailable/);
  assert.equal(router.roleConfigurationIdentity(config, 'subject'), router.roleConfigurationIdentity({ ...config, model_summary: 'changed' }, 'subject'));
  assert.notEqual(router.roleConfigurationIdentity(config, 'memory'), router.roleConfigurationIdentity({ ...config, model_summary: 'changed' }, 'memory'));
  profiles.clearModelSessionCredentials();
  assert.throws(() => router.resolveRoleConnection(config, 'recall'), /unavailable/);
  console.log('Role profiles passed: inherited roles, independent model, session isolation, endpoint binding and affected-role identity.');
})().catch(error => { console.error(error); process.exitCode = 1; });
