#!/usr/bin/env node
'use strict';

// Pure production routing with the real app defaults; no storage, credentials
// or model calls. Legacy configurations need no new required model slots.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
function load(file, dependencies = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: file });
  return module.exports;
}
const defaults = load('services/appConfig.ts');
const { resolveTaskModel } = load('services/taskModelRouter.ts', { './appConfig': defaults, './roleProfiles': { resolveModelSessionCredential: x => x } });
const criticalRoles = ['subject', 'understanding', 'verification', 'recall'];
const backgroundRoles = ['memory', 'diary'];
const allRoles = [...criticalRoles, ...backgroundRoles, 'translation'];
let checks = 0;
function expect(config, role, expected) {
  const before = JSON.stringify(config);
  assert.equal(resolveTaskModel(config, role), expected, `${config.provider || 'legacy'} / ${role}`);
  assert.equal(JSON.stringify(config), before, 'Routing must not alter model/provider/credential configuration');
  checks++;
}
const config = Object.freeze({
  ...defaults.DEFAULT_AI_CONFIG,
  model_main: 'configured-main', model_summary: 'configured-summary', model_translator: 'configured-translator',
  useCustomEndpoint: true, customEndpoint: 'https://example.invalid/custom',
  apiKey_primary: 'fixture-primary', apiKey_backup: 'fixture-backup', activeKey: 'backup',
});
for (const role of criticalRoles) expect(config, role, 'configured-main');
for (const role of backgroundRoles) expect(config, role, 'configured-summary');
expect(config, 'translation', 'configured-translator');
// Old two-slot settings and main-only settings preserve their existing meaning.
const { model_translator, ...legacy } = config;
expect(legacy, 'translation', 'configured-main');
for (const missing of [undefined, '', '   ']) {
  for (const role of backgroundRoles) expect({ ...legacy, model_summary: missing }, role, 'configured-main');
  expect({ ...legacy, model_translator: missing }, 'translation', 'configured-main');
}
for (const role of allRoles) expect({ model_main: 'main-only' }, role, 'main-only');
// Missing main must not promote summary to subject, interpretation or validation.
for (const role of criticalRoles) {
  expect({ model_main: '', model_summary: 'summary-only' }, role, defaults.DEFAULT_AI_CONFIG.model_main);
}
// Reuse the application's provider defaults, including compatible endpoints;
// routing does not switch provider/keys to make a model available.
for (const provider of ['gemini', 'openai', 'anthropic', 'deepseek', 'grok', 'openrouter', 'dashscope', 'minimax']) {
  for (const role of allRoles) expect({ provider }, role, defaults.getDefaultMainModel(provider));
}
for (const role of allRoles) expect({}, role, defaults.DEFAULT_AI_CONFIG.model_main);
expect({ ...config, model_main: '  configured-main  ' }, 'subject', 'configured-main');
console.log(`Task model router: ${checks} routing cases passed (production defaults; no network or storage).`);
