#!/usr/bin/env node
'use strict';

// F06 regression coverage. The production TypeScript function is transpiled
// and its model/RAG boundaries are mocked; no network or database is used.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const serviceFile = path.join(root, 'services', 'diaryValidatorService.ts');

function transpile(filename) {
  return ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
}

function loadRoutingModule(file) {
  const module = { exports: {} };
  vm.runInNewContext(transpile(path.join(root, 'services', file)), {
    module, exports: module.exports,
    require(id) {
      if (id === './roleProfiles') return { resolveModelSessionCredential: x => x };
      assert.equal(id, './appConfig');
      return loadRoutingModule('appConfig.ts');
    },
  });
  return module.exports;
}
const taskModelRouter = loadRoutingModule('taskModelRouter.ts');

function loadValidator(responses, calls) {
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    console: { log() {}, warn() {}, error() {} },
    DOMException,
    require(id) {
      if (id === './taskModelRouter') return taskModelRouter;
      if (id === './geminiService') {
        return {
          getCurrentAIConfig: () => ({ model_summary: 'test-summary', model_main: 'test-main' }),
          callLLMRaw: async (_system, _prompt, model, options) => {
            assert.equal(model, undefined);
            assert.ok(['understanding', 'verification'].includes(options.role), 'Validator uses explicit role routing');
            calls.push('llm');
            return responses.shift();
          },
        };
      }
      if (id === './localRagService') {
        return { searchLocalRagMemory: async () => { calls.push('rag'); return []; } };
      }
      throw new Error(`unexpected dependency: ${id}`);
    },
  };
  vm.runInNewContext(transpile(serviceFile), sandbox, { filename: serviceFile });
  return module.exports.verifyAgainstHistory;
}

async function runCase(name, responses, expectedIssues, expectedLlmCalls) {
  const calls = [];
  const verifyAgainstHistory = loadValidator([...responses], calls);
  const issues = await verifyAgainstHistory('今天写了一件足够具体的事情。', '聊天记录', '历史日记');
  if (typeof expectedIssues === 'function') {
    assert.ok(expectedIssues(issues), `${name}: unexpected issues`);
  } else {
    assert.equal(JSON.stringify(issues), JSON.stringify(expectedIssues), `${name}: unexpected issues`);
  }
  assert.equal(calls.filter(call => call === 'llm').length, expectedLlmCalls, `${name}: unexpected verify calls`);
}

async function main() {
  await runCase('direct PASS', ['- claim', '  「pAsS。」  '], [], 2);
  await runCase('empty then PASS', ['- claim', '', 'PASS'], [], 3);
  await runCase('empty then empty', ['- claim', '', ''], issues => issues.length === 1 && /验证器无响应/.test(issues[0]), 3);
  await runCase('NOT PASS fails', ['- claim', 'NOT PASS'], ['NOT PASS'], 2);
  await runCase('PASS with conflict fails', ['- claim', 'PASS\n冲突'], ['PASS', '冲突'], 2);
  await runCase('normal issue line', ['- claim', '逻辑矛盾：聊天记录与日记不一致，请修改。'], ['逻辑矛盾：聊天记录与日记不一致，请修改。'], 2);
  console.log('diary validator F06 tests passed');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
