#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const silent = { log() {}, warn() {}, error() {} };

function load(file, deps = {}, extras = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: file,
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, console: silent, AbortController, setTimeout, clearTimeout, ...extras,
    require(id) { if (id in deps) return deps[id]; throw new Error(`Unexpected dependency: ${id}`); },
  }, { filename: file });
  return module.exports;
}
const loop = load('services/chatToolLoop.ts');
const img = { mimeType: 'image/png', data: 'SU1BR0VfRVZJREVOQ0U=' };
const config = { provider: 'openai', activeKey: 'primary', apiKey_primary: 'test-only' };
const toolDefs = ['recall_memory', 'view_historical_image', 'search_internet'].map(name => ({ name, parameters: {
  type: 'OBJECT', properties: { query: { type: 'STRING', enum: ['UPPERCASE_VALUE'] } },
} }));
const calls = [
  { id: 'memory-1', name: 'recall_memory', args: { query: 'what happened' } },
  { id: 'image-1', name: 'view_historical_image', args: { imageId: 'image-123' } },
];
const openAIMessage = (content, functionCalls = [], reasoning = '') => ({ choices: [{ message: {
  role: 'assistant', content, reasoning_content: reasoning,
  ...(functionCalls.length ? { tool_calls: functionCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
} }] });
const anthropicMessage = (content, functionCalls = []) => ({ content: [
  { type: 'text', text: content }, ...functionCalls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args })),
] });

function provider(queue) {
  const payloads = [];
  const api = load('services/llmProviderService.ts', { '@google/genai': {}, './appConfig': {} }, {
    fetch: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      assert.ok(queue.length, 'unexpected API request');
      return { ok: true, json: async () => queue.shift() };
    },
  });
  return { api, payloads };
}

async function main() {
  // F11: standalone reasoning never becomes answer text, including an empty answer.
  const p = provider([openAIMessage('你好', [], 'SECRET_REASONING'), openAIMessage(null, [], 'SECRET_REASONING')]);
  assert.equal((await p.api.callOpenAI(config, 'test', '', [], 'hi')).text, '你好');
  assert.equal((await p.api.callOpenAI(config, 'test', '', [], 'hi')).text, '');

  for (const kind of ['openai', 'anthropic']) {
    const encode = kind === 'openai' ? openAIMessage : anthropicMessage;
    const p = provider([encode('', calls), encode('', [{ id: 'search-2', name: 'search_internet', args: { query: 'clarify' } }]), encode('final answer')]);
    const invoke = kind === 'openai' ? p.api.callOpenAI : p.api.callAnthropic;
    const prompt = [{ text: 'look and recall' }, { inlineData: img }];
    const initial = await invoke(config, 'test', 'system', [], prompt, toolDefs);
    const schema = kind === 'openai' ? p.payloads[0].tools[0].function.parameters : p.payloads[0].tools[0].input_schema;
    assert.equal(schema.type, 'object');
    assert.equal(schema.properties.query.type, 'string');
    assert.equal(schema.properties.query.enum[0], 'UPPERCASE_VALUE');
    assert.equal(initial.functionCalls.length, 2, `${kind}: expose all tool calls`);
    const executed = [];
    const final = await loop.runChatToolLoop(initial, async call => {
      executed.push(call.id);
      return { call, result: { success: true }, ...(call.name === 'view_historical_image' ? { image: img } : {}) };
    }, (rounds, allowTools, signal) => invoke(config, 'test', 'system', [], prompt, allowTools ? toolDefs : undefined, { rounds, signal }));
    assert.equal(final.text, 'final answer');
    assert.deepEqual(executed, ['memory-1', 'image-1', 'search-2']);
    assert.equal(p.payloads[2].tools.length, 3, `${kind}: tools survive follow-up turns`);
    const follow = p.payloads[1].messages;
    assert.ok(JSON.stringify(follow).includes(img.data), `${kind}: actual image bytes transmitted`);
    if (kind === 'openai') {
      assert.deepEqual(follow.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['memory-1', 'image-1']);
      assert.ok(follow[0].content === 'system');
      assert.equal(follow[1].content[1].type, 'image_url', 'direct image not flattened');
      assert.equal(follow.at(-1).content[1].image_url.url, `data:${img.mimeType};base64,${img.data}`);
      assert.equal(p.payloads[2].messages.filter(m => m.role === 'tool').length, 3, 'earlier tool results retained');
    } else {
      const results = follow.at(-1).content;
      assert.deepEqual(results.map(r => r.tool_use_id), ['memory-1', 'image-1']);
      assert.equal(results[1].content[1].source.data, img.data, 'image nested in matching tool_result');
      assert.equal(p.payloads[2].messages.filter(m => m.role === 'assistant').length, 2, 'earlier assistant turns retained');
    }
  }

  // Invalid arguments are still paired with their original call ID.
  const malformed = openAIMessage('', calls);
  malformed.choices[0].message.tool_calls[0].function.arguments = '{broken';
  const bad = provider([malformed]);
  const parsed = await bad.api.callOpenAI(config, 'test', '', [], 'test', toolDefs);
  assert.equal(parsed.functionCalls.length, 2);
  assert.ok(parsed.functionCalls[0].argumentError);

  let imageValue = `data:${img.mimeType};base64,${img.data}`;
  let helperValue = 'a described object';
  const searchSources = [];
  const execution = load('services/chatToolExecution.ts', {
    './userKnownLocation': { queryKnownUserLocationWeather: async () => ({ success: false, status: 'unknown' }) },
    './llmProviderService': { callVisionHelper: async () => helperValue },
    './imageService': { imageService: { getImage: async () => imageValue } },
    './localRagService': { searchLocalRagMemoryDetailed: async () => ({ blocks: ['memory evidence'] }) },
  }, {
    localStorage: { getItem: () => 'test-only' },
    fetch: async (_url, options) => {
      assert.ok(options.signal);
      return { ok: true, json: async () => ({ results: [{ url: 'https://example.test/source', title: 'source' }] }) };
    },
  });
  const signal = new AbortController().signal;
  const allowedTools = toolDefs.map(tool => tool.name);
  const execute = execution.createChatToolExecutor(config, 'zh', searchSources, allowedTools);
  assert.equal((await execute(calls[0], signal)).result.blocks[0], 'memory evidence');
  const imageResult = await execute(calls[1], signal);
  assert.equal(imageResult.image.data, img.data);
  const nativeParts = loop.toGeminiToolParts([{ call: calls[0], result: { success: true } }, imageResult]);
  assert.equal(nativeParts[0].functionResponse.id, 'memory-1');
  assert.equal(nativeParts[1].functionResponse.id, 'image-1');
  assert.equal(nativeParts[2].inlineData.data, img.data);
  assert.equal((await execute({ id: 'bad', name: 'unknown', args: {} }, signal)).result.success, false);
  assert.equal((await execute({ id: 'bad', name: 'recall_memory', args: { query: '' } }, signal)).result.success, false);
  await execute({ id: 'search', name: 'search_internet', args: { query: 'source' } }, signal);
  assert.equal(searchSources.length, 1);
  const disabled = execution.createChatToolExecutor(config, 'zh', [], []);
  assert.equal((await disabled({ id: 'search', name: 'search_internet', args: { query: 'must not run' } }, signal)).result.success, false);
  const withHelper = execution.createChatToolExecutor({ ...config, useVisionHelper: true }, 'zh', [], allowedTools);
  const described = await withHelper(calls[1], signal);
  assert.equal(described.result.description, helperValue);
  assert.equal(described.image, undefined, 'text-only main model does not receive raw image');
  helperValue = '';
  assert.equal((await withHelper(calls[1], signal)).result.success, false);
  imageValue = null;
  assert.equal((await execute(calls[1], signal)).result.success, false);

  let executed = 0;
  await assert.rejects(loop.runChatToolLoop({ text: '', functionCalls: calls }, async call => {
    executed++; return { call, result: { success: true } };
  }, async (rounds, allowTools) => {
    assert.equal(allowTools, false);
    assert.equal(rounds[0].outputs[1].result.success, false, 'over-budget call gets explicit result');
    return { text: '', functionCalls: calls };
  }, { maxCalls: 1 }), /budget/);
  assert.equal(executed, 1);
  let timeoutSignal;
  await assert.rejects(loop.runChatToolLoop({ text: '', functionCalls: calls }, (_call, signal) => {
    timeoutSignal = signal; return new Promise(() => {});
  }, async () => ({ text: 'never' }), { timeoutMs: 10 }), /timed out/);
  assert.equal(timeoutSignal.aborted, true);
  console.log('chat tools F10-F12 regressions passed (mock transports, no external calls)');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
