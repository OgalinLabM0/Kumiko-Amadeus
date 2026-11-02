#!/usr/bin/env node
'use strict';
// Production model wrapper with a deferred fake provider and real restore gate.
// No network, credentials, user database or model usage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const storage = new Map();
const listeners = new Map();
const window = {
  addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
  removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  dispatchEvent(event) { for (const listener of listeners.get(event.type) || []) listener(event); },
};
const localStorage = { getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
function load(file, dependencies) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: file,
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, window, localStorage, Event, AbortController, crypto: require('node:crypto').webcrypto,
    setTimeout, clearTimeout, console, require(id) {
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      throw new Error(`Unexpected dependency: ${id}`);
    } }, { filename: file });
  return module.exports;
}
const gate = load('services/dataRestoreGate.ts', {});
let calls = 0;
let respond;
let providerSignal;
const fakeProvider = async (...args) => {
  calls++;
  providerSignal = args.at(-1).signal;
  return new Promise(resolve => { respond = resolve; });
};
const core = load('services/llmCore.ts', {
  '@google/genai': {}, './dataRestoreGate': gate, './preferencesSync': {}, './environment': { isElectron: () => false, isCapacitorNative: () => false },
  './nativeCredentials': { hasNativeCredentials: () => false },
  './taskRuntime': { TaskCapacityError: class TaskCapacityError extends Error {}, async beginForegroundActivity() {}, async endForegroundActivity() {} },
  './taskGateway': { runTaskTransport: async (ctx, _target, work) => work(ctx.signal) },
  './memoryMaintenanceGate': { getMemoryGeneration: () => 'initial' },
  './db': { db: {} },
  './roleProfiles': { clearModelSessionCredentials() {} },
  './taskModelRouter': { resolveRoleConnection: config => ({ config, model: config.model_main, revision: 'fixture' }), roleConnectionFingerprint: r => JSON.stringify(r) },
  './appConfig': { DEFAULT_AI_CONFIG: { provider: 'openai', model_main: 'fixture' }, resolveTransportProvider: p => p },
  './llmProviderService': { callOpenAI: fakeProvider, callAnthropic: fakeProvider },
});
const flush = () => new Promise(resolve => setImmediate(resolve));
function noListeners() {
  assert.ok([...listeners.values()].every(set => set.size === 0), 'model completion releases restore listeners');
}
async function main() {
  gate.beginDataRestore('restore-before-call');
  await assert.rejects(core.callLLMRaw('s', 'u'), /restoration/);
  assert.equal(calls, 0, 'do not call provider while restoring');
  gate.finishDataRestore('restore-before-call');

  const first = core.callLLMRaw('s', 'u');
  const rejected = assert.rejects(first, /cancelled|restored/);
  await flush();
  gate.beginDataRestore('restore-during-call');
  gate.finishDataRestore('restore-during-call');
  await rejected;
  assert.equal(providerSignal.aborted, true);
  respond({ text: 'late old answer' });
  await flush();
  assert.equal(calls, 1, 'restoration cancellation never retries old work');
  noListeners();

  const second = core.callLLMRaw('s', 'u');
  const changed = assert.rejects(second, /restored/);
  await flush();
  // A delayed/missed cross-window storage event must not permit the old result.
  localStorage.setItem('kumiko_data_restore_generation_v1', 'another-window');
  respond({ text: 'outdated model result' });
  await changed;
  noListeners();
  assert.equal(gate.isDataRestoreBlocked(), true, 'old window cannot write after another window finished restoring');
  assert.equal(gate.readDataRestoreGate(), null, 'reload marker is not a persisted restore journal');

  const freshGate = load('services/dataRestoreGate.ts', {});
  assert.equal(freshGate.isDataRestoreBlocked(), false, 'a freshly loaded window accepts the new generation');
  console.log('Model restore fence passed: blocked start, in-flight abort, no stale retry, late-result rejection, listener cleanup and stale-window fence.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
