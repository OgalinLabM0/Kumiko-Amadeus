'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto').webcrypto;
const compile = file => ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const configModule = { exports: {} };
vm.runInNewContext(compile('services/appConfig.ts'), { module: configModule, exports: configModule.exports });
const appConfig = configModule.exports;
const code = compile('services/llmCore.ts');

function fixture(native, previous) {
  const rows = new Map([['kumiko_ai_config', JSON.stringify(previous)]]);
  const requests = [];
  const storage = { getItem: k => rows.get(k) ?? null, setItem: (k, v) => rows.set(k, v) };
  const dependencies = {
    '@google/genai': {}, './llmProviderService': {}, './appConfig': appConfig,
    './dataRestoreGate': { assertDataWritesAllowed() {}, getDataRestoreVersion: () => 1 },
    './preferencesSync': { queueLocalStoragePreferenceSync: (k, v) => storage.setItem(k, v) },
    './nativeCredentials': { hasNativeCredentials: () => native, invokeCredential: async (op, args) => {
      requests.push({ op, args }); return { success: true, handle: 'a'.repeat(64) };
    } },
  };
  dependencies['./taskRuntime'] = { TaskCapacityError: class extends Error {} };
  dependencies['./taskGateway'] = {};
  dependencies['./db'] = { db: { keyval: { async put() {} }, async transaction(_mode, _table, work) { return work(); } } };
  dependencies['./memoryMaintenanceGate'] = { getMemoryGeneration: () => 'initial' };
  dependencies['./roleProfiles'] = { clearModelSessionCredentials() {} };
  dependencies['./taskModelRouter'] = { configurableModelRoles: ['subject'], roleConfigurationIdentity: c => JSON.stringify(c) };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, localStorage: storage, crypto, console, require: id => {
    if (!(id in dependencies)) throw Error(id); return dependencies[id];
  } });
  return { api: module.exports, storage, requests };
}

(async () => {
  const old = { ...appConfig.DEFAULT_AI_CONFIG, apiKey_primary: 'old-key', apiKey_backup: 'old-backup',
    visionApiKey: 'old-vision', useCustomEndpoint: true, customEndpoint: 'https://old.test/' };
  for (const native of [false, true]) {
    for (const change of [
      { customEndpoint: 'https://new.test/' },
      { provider: 'anthropic' },
      { useVisionCustomEndpoint: true, visionCustomEndpoint: 'https://other.test/' },
      { customEndpoint: 'https://new.test/', apiKey_primary: 'old-backup', apiKey_backup: '' },
    ]) {
      const test = fixture(native, old);
      assert.equal((await test.api.setAIConfig({ ...old, ...change })).ok, false);
      assert.equal(test.requests.length, 0, 'reject before storing or sending old key to new service');
      assert.equal(test.storage.getItem('kumiko_ai_config'), JSON.stringify(old));
    }
    const normal = fixture(native, old);
    assert.equal((await normal.api.setAIConfig({ ...old, model_main: 'new-model' })).ok, true, 'model changes retain service binding');
    const replacement = fixture(native, old);
    assert.equal((await replacement.api.setAIConfig({ ...old, customEndpoint: 'https://new.test/',
      apiKey_primary: 'replacement', apiKey_backup: '', visionApiKey: '' })).ok, true, 'explicit replacement can use new service');
    const legacy = { provider: 'gemini', apiKey: 'legacy-alias' };
    const alias = fixture(native, legacy);
    assert.equal((await alias.api.setAIConfig({ ...alias.api.getCurrentAIConfig(), useCustomEndpoint: true, customEndpoint: 'https://new.test/' })).ok, false);
    assert.equal(alias.storage.getItem('kumiko_ai_config'), JSON.stringify(legacy));
  }
  console.log('Model credential rebinding passed: legacy/native/browser, provider/vision/slot changes, explicit replacement and migration preservation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
