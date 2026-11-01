#!/usr/bin/env node
'use strict';

// Exercise actual declarations and the tool driver from geminiService, actual
// provider adapters/executor/loop and the installed Gemini SDK Chat. Replace
// only transport/storage/model boundaries; no network or private data is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const silent = { log() {}, warn() {}, error() {} };
const source = fs.readFileSync(path.join(root, 'services/geminiService.ts'), 'utf8');

function sourceRange(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'main driver/declaration extraction must still resolve');
  return source.slice(from, to);
}

function compile(code, filename) {
  return ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
}

function load(file, dependencies = {}, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(compile(fs.readFileSync(path.join(root, file), 'utf8'), file), {
    module, exports: module.exports, console: silent, AbortController, setTimeout, clearTimeout,
    require(id) {
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      throw new Error(`Unexpected dependency ${id} in ${file}`);
    },
    ...globals,
  }, { filename: file });
  return module.exports;
}

const declarationCode = compile(sourceRange('    const viewHistoricalImageTool:', '    const enableInternetSearch =')
  + '\nglobalThis.toolDeclarations = [viewHistoricalImageTool, recallMemoryTool, searchInternetTool, knownUserWeatherTool];', 'main-tool-declarations.ts');
const driverCode = compile('globalThis.runDriver = async function () { let result; '
  + sourceRange('    const availableTools =', '    const locationExtraction =')
  + '\nreturn result; };', 'main-tool-driver.ts');
const img = { mimeType: 'image/png', data: 'SU1BR0VfRVZJREVOQ0U=' };
const firstCalls = [
  { id: 'memory-1', name: 'recall_memory', args: { query: 'yesterday' } },
  { id: 'image-1', name: 'view_historical_image', args: { imageId: 'image-123' } },
];
const followCalls = [{ id: 'memory-2', name: 'recall_memory', args: { query: 'followup' } }];
const plain = value => JSON.parse(JSON.stringify(value));

function assertJsonSchema(schema) {
  assert.equal(schema.type, 'object');
  for (const property of Object.values(schema.properties)) assert.equal(property.type, 'string');
}

async function run(kind, sdk, options = {}) {
  const requests = [];
  let step = 0;
  let searched = 0;
  const chooseCalls = () => options.disabledSearch
    ? (step === 1 ? [{ id: 'forbidden-search', name: 'search_internet', args: { query: 'must stay local' } }] : [])
    : (step === 1 ? firstCalls : step === 2 ? followCalls : []);
  const provider = load('services/llmProviderService.ts', { '@google/genai': sdk, './appConfig': {} }, {
    fetch: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      step++;
      const calls = chooseCalls();
      const answer = calls.length ? '' : 'final answer';
      const data = kind === 'anthropic' ? { content: [
        { type: 'text', text: answer },
        ...calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args })),
      ] } : { choices: [{ message: {
        role: 'assistant', content: answer, reasoning_content: 'PRIVATE_REASONING_SENTINEL',
        ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: {
          name: call.name, arguments: JSON.stringify(call.args),
        } })) } : {}),
      } }] };
      return { ok: true, json: async () => data };
    },
  });
  const ai = new sdk.GoogleGenAI({ apiKey: 'test-only' });
  ai.models.generateContent = async params => {
    requests.push(params);
    step++;
    const calls = chooseCalls();
    const response = new sdk.GenerateContentResponse();
    response.candidates = [{ content: { role: 'model', parts: calls.length
      ? calls.map((call, index) => ({ functionCall: call, ...(index === 0 ? { thoughtSignature: 'signature-1' } : {}) }))
      : [{ text: 'final answer' }],
    } }];
    return response;
  };
  const executor = load('services/chatToolExecution.ts', {
    './userKnownLocation': { queryKnownUserLocationWeather: async () => ({ success: false, status: 'unknown' }) },
    './llmProviderService': { callVisionHelper: async () => { throw new Error('vision unavailable'); } },
    './imageService': { imageService: { getImage: async () => `data:${img.mimeType};base64,${img.data}` } },
    './localRagService': { searchLocalRagMemoryDetailed: async () => ({ blocks: ['actual memory evidence'] }) },
  }, {
    localStorage: { getItem: () => 'test-only' },
    fetch: async () => { searched++; throw new Error('unexpected external search'); },
  });
  const context = {
    ...provider, ...executor, ...load('services/chatToolLoop.ts'),
    Type: sdk.Type, language: 'zh', transportProvider: kind,
    config: { provider: kind, activeKey: 'primary', apiKey_primary: 'test-only', useVisionHelper: !!options.visionFailure },
    currentModel: 'test', dynamicSystemInstruction: 'system',
    formattedHistory: [{ role: 'user', parts: [{ text: 'earlier user line' }] }, { role: 'model', parts: [{ text: 'earlier reply' }] }],
    promptToSend: [{ text: 'look and recall' }], tavilyGroundingSources: [], finalTemperature: .7,
    getGenAI: () => ai,
  };
  vm.runInNewContext(declarationCode, context);
  context.toolsConfig = [{ functionDeclarations: context.toolDeclarations.filter(tool => !options.disabledSearch || tool.name !== 'search_internet') }];
  vm.runInNewContext(driverCode, context);
  const final = await context.runDriver();
  assert.equal(final.text, 'final answer');
  assert.ok(!final.text.includes('PRIVATE_REASONING_SENTINEL'));
  assert.equal(requests.length, options.disabledSearch ? 2 : 3);
  assert.equal(searched, 0, 'disabled/unsolicited search must never reach its transport');

  if (kind !== 'gemini') {
    for (const request of requests) {
      assert.ok(request.tools?.length, 'follow-up retains enabled tools');
      for (const tool of request.tools) assertJsonSchema(kind === 'openai' ? tool.function.parameters : tool.input_schema);
    }
  }
  const follow = requests[1];
  if (options.disabledSearch) {
    const text = JSON.stringify(kind === 'gemini' ? follow.contents : follow.messages);
    assert.ok(text.includes('forbidden-search'));
    assert.ok(text.includes('Tool is not enabled: search_internet'));
    return;
  }
  if (kind === 'gemini') {
    const parts = requests[2].contents.flatMap(content => content.parts);
    assert.deepEqual(plain(parts.filter(part => part.functionResponse).map(part => part.functionResponse.id)), ['memory-1', 'image-1', 'memory-2']);
    assert.ok(parts.some(part => part.thoughtSignature === 'signature-1'), 'SDK retains provider thought signature');
    assert.ok(parts.some(part => part.text === 'earlier reply'), 'original chat history retained');
    assert.equal(parts.filter(part => part.inlineData).length, options.visionFailure ? 0 : 1);
    if (!options.visionFailure) assert.equal(parts.find(part => part.inlineData).inlineData.data, img.data);
  } else if (kind === 'openai') {
    const tools = requests[2].messages.filter(message => message.role === 'tool');
    assert.deepEqual(plain(tools.map(tool => tool.tool_call_id)), ['memory-1', 'image-1', 'memory-2']);
    const images = requests[2].messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'image_url');
    assert.equal(images.length, options.visionFailure ? 0 : 1);
    if (!options.visionFailure) assert.equal(images[0].image_url.url, `data:${img.mimeType};base64,${img.data}`);
    assert.ok(requests[2].messages.some(message => message.content === 'earlier reply'));
  } else {
    const results = requests[2].messages.flatMap(message => message.content).filter(part => part.type === 'tool_result');
    assert.deepEqual(plain(results.map(result => result.tool_use_id)), ['memory-1', 'image-1', 'memory-2']);
    const images = results.flatMap(result => result.content).filter(part => part.type === 'image');
    assert.equal(images.length, options.visionFailure ? 0 : 1);
    if (!options.visionFailure) assert.equal(images[0].source.data, img.data);
    assert.ok(requests[2].messages.some(message => message.content.some(part => part.text === 'earlier reply')));
  }
  if (options.visionFailure) {
    assert.ok(JSON.stringify(requests[2]).includes('vision unavailable'), 'helper failure remains explicit evidence failure');
  }
}

async function main() {
  const sdk = await import('@google/genai');
  for (const kind of ['openai', 'anthropic', 'gemini']) {
    await run(kind, sdk);
    await run(kind, sdk, { disabledSearch: true });
    await run(kind, sdk, { visionFailure: true });
  }
  console.log('actual chat tool driver regressions passed (3 transports, real declarations, real Gemini SDK, no external calls)');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
