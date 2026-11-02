#!/usr/bin/env node
'use strict';

// Reuse the real-module coordinator harness without running its other groups.
// Everything remains in memory; no user DB, network, model or credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const ts = require('typescript');
const filename = path.join(__dirname, 'test-turn-coordinator.cjs');
const fixture = new Module(filename, module);
fixture.filename = filename;
fixture.paths = module.paths;
const fixtureCode = fs.readFileSync(filename, 'utf8').replace(/main\(\)\.catch\([\s\S]*$/, 'module.exports = { harness, candidate, proposals, receipts, now };');
fixture._compile(fixtureCode, filename);
const { harness, candidate, proposals, receipts, now } = fixture.exports;

// Access the same production coordinator export with the harness DB, leaving
// actual action/fact execution on the harness's normal runtime path.
function sourceReader(h) {
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../services/turnCoordinator.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require(id) { return id === './db' ? { db: h.db } : {}; } });
  return module.exports.readTurnSources;
}

async function frozenGroupRetry() {
  const h = harness();
  try {
    const a = h.source('10分钟后提醒我喝水', 'user', now - 1000);
    const b = h.source('我带了这张图片', 'user', now);
    // Harness message entries are immutable copies; replace only fixture DB reads.
    const originalGet = h.db.messages.get;
    h.db.messages.get = async id => { const message = await originalGet(id); return message && id === b.id ? { ...message, imageId: 'image-original' } : message; };
    h.respond(proposals(candidate(a)));
    const runtime = await h.start([a, b]);
    await runtime.prepare();
    const actionId = receipts(runtime)[0].actionId;
    const reply = { textParts: ['嗯，提醒记下了。', '这张照片很漂亮。'], emotion: 'neutral' };
    await runtime.saveResponse(reply);
    await runtime.dispose();
    // Reproduce the old UI contract: passing either clicked bubble alone fails.
    await assert.rejects(h.start([a]), /Input changed after its action identity was assigned/);
    await assert.rejects(h.start([b]), /Input changed after its action identity was assigned/);
    const read = sourceReader(h);
    for (const clicked of [a, b]) {
      const recovered = await read(clicked.id);
      assert.deepEqual(JSON.parse(JSON.stringify(recovered.sources)), [a, b]);
      assert.equal(recovered.messages[1].imageId, 'image-original');
      const retry = await h.start(recovered.sources);
      await retry.prepare();
      assert.equal(receipts(retry)[0].actionId, actionId);
      assert.equal(h.reminderRows().length, 1);
      assert.equal(retry.getResponse().textParts[1], reply.textParts[1]);
      assert.equal(retry.responseMessageId(0), runtime.responseMessageId(0));
      const copy = retry.getResponse(); copy.textParts[0] = 'changed';
      assert.equal(retry.getResponse().textParts[0], reply.textParts[0]);
      await assert.rejects(retry.saveResponse(copy), /already frozen/);
      await retry.dispose();
    }
    await h.window().removeRelativeReminder(h.reminderRows()[0].id);
    const afterCancellation = await h.start([a, b]);
    await afterCancellation.prepare();
    assert.throws(() => afterCancellation.getResponse(), /该提醒状态已改变/);
    assert.match(await afterCancellation.failureNotice(), /该提醒状态已改变/);
    assert.equal(h.reminderRows().length, 0, 'changed reminder state cannot recreate the action or replay an obsolete promise');
    await afterCancellation.dispose();
    const baseGet = h.db.messages.get;
    h.db.messages.get = async id => id === a.id ? undefined : baseGet(id);
    await assert.rejects(read(b.id), /source changed or was removed/);
    h.db.messages.get = async id => { const value = await baseGet(id); return id === a.id ? { ...value, text: '修改过的来源' } : value; };
    await assert.rejects(read(b.id), /source changed or was removed/);
    h.db.messages.get = async id => { const value = await baseGet(id); return id === b.id ? { ...value, imageId: 'image-replaced' } : value; };
    await assert.rejects(read(a.id), /source changed or was removed/);
    h.db.messages.get = baseGet;
    await h.setEpoch('restored-epoch');
    await assert.rejects(read(a.id), /restored data/);
    await assert.rejects(h.start([a, b]), /restored data/);
    assert.equal(h.reminderRows().length, 0, 'rejected retries cannot grant a new action identity');
    const unclaimed = h.source('新消息');
    assert.equal((await read(unclaimed.id)).turnId, null);
  } finally { await h.close(); }
}

async function factsOnlyRestore() {
  const h = harness();
  try {
    const old = h.source('我在武汉，10分钟后提醒我喝水', 'user', now - 2000);
    h.respond({ locations: [{ sourceMessageId: old.id, locationText: '武汉', sourceQuote: '我在武汉' }], reminders: [candidate(old)] });
    const original = await h.start([old]);
    await original.dispose(); // Received while blocked, not read or executed.
    await h.setEpoch('restored-facts');
    const newer = h.source('我在巴黎', 'user', now - 1000);
    h.respond({ locations: [{ sourceMessageId: newer.id, locationText: '巴黎', sourceQuote: newer.text }], reminders: [] });
    const current = await h.start([newer]);
    await current.prepare(true); await current.dispose();
    const read = sourceReader(h);
    await assert.rejects(read(old.id), /restored data/);
    const recovered = await read(old.id, { allowRestoredFactsOnly: true });
    h.respond({ locations: [{ sourceMessageId: old.id, locationText: '武汉', sourceQuote: '我在武汉' }], reminders: [candidate(old)] });
    const facts = await h.start(recovered.sources, undefined, { factsOnly: true });
    await facts.prepareFactsOnly();
    assert.equal(facts.catchUpResult().complete, true, 'superseded fact is safely settled');
    assert.equal((await h.location.getUserKnownLocation()).locationText, '巴黎', 'restored earlier evidence cannot overwrite a later disclosure');
    assert.equal(h.reminderRows().length, 0, 'restored facts cannot execute reminder proposals');
    assert.equal(h.value('kumiko_turn_source_v1:' + old.id).turnId, old.id, 'fact-only identity leaves original action mapping intact');
    assert.equal(h.value('kumiko_turn_pending_v1'), undefined, 'fact-only path cannot alter pending reminder authority');
    await assert.rejects(facts.executeTool({ name: 'search_internet', args: {} }, async () => { throw new Error('must not run'); }), /cannot execute tools/);
    await facts.dispose();
    await assert.rejects(h.start([old]), /restored data/);
  } finally { await h.close(); }

  const failed = harness();
  try {
    const source = failed.source('我在武汉');
    failed.respond({ locations: [{ sourceMessageId: source.id, locationText: '武汉', sourceQuote: source.text }], reminders: [] });
    const write = failed.db.setVal;
    failed.db.setVal = async (key, value) => { if (key === 'user_known_location_v1') throw new Error('fixture location disk failure'); return write(key, value); };
    const first = await failed.start([source]);
    await first.prepareFactsOnly();
    assert.equal(first.catchUpResult().complete, false, 'failed fact storage remains retryable');
    assert.equal(await failed.location.getUserKnownLocation(), null);
    await first.dispose();
    failed.db.setVal = write;
    const retry = await failed.start([source]);
    await retry.prepareFactsOnly();
    assert.equal(retry.catchUpResult().complete, true);
    assert.equal((await failed.location.getUserKnownLocation()).locationText, '武汉');
  } finally { await failed.close(); }
}

async function partialVisibleReply() {
  // Execute the production delivery block, including voice/text branching,
  // delays, stable IDs and checks. Only UI/voice/timers are replaced.
  const source = fs.readFileSync(path.join(__dirname, '../components/app/chatActions.ts'), 'utf8');
  const begin = source.indexOf('    const currentTtsCfg = ctx.ttsConfig;', source.indexOf('// --- A-11 VOICE / TEXT DELIVERY ---'));
  const end = source.indexOf('    if (response.activateSleepMode)', begin);
  assert.ok(begin > 0 && end > begin);
  const wrapped = 'export async function deliver() { ' + source.slice(begin, end) + ' }';
  const code = ts.transpileModule(wrapped, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const messages = []; const response = { textParts: ['第一句', '第二句', '第三句'], emotion: 'neutral' };
  let failAfterFirst = true;
  const ctx = { ttsConfig: { voiceMode: 'off' }, getMessagesSnapshot: () => messages, isCancelled: () => false };
  const module = { exports: {} };
  const stableMath = Object.create(Math); stableMath.random = () => 0.9;
  const globals = { module, exports: module.exports, ctx, response, language: 'zh', Math: stableMath, Date,
    replyStep: async promise => promise, replyGuard: { async check() {} }, isReplyActive: () => !ctx.isCancelled(),
    setTimeout(fn) { fn(); return 0; }, console: { log() {} },
    useAppStore: { getState: () => ({ setIsThinking() {}, setIsTalking() {}, setMessages() {} }) },
    turnRuntime: { responseMessageId: index => 'frozen-turn:reply:' + index, signal: new AbortController().signal,
      async checkDelivery() { if (failAfterFirst && messages.length) throw new Error('fixture interrupted after first visible part'); } },
    isVoiceServiceAvailable: () => true, async commitAcceptedResponsePsyche() {}, showBackgroundNotification() {},
    addMessageToStore(role, text, image, imageCaption, id) { messages.push({ role, text, id }); return id; },
  };
  vm.runInNewContext(code, globals);
  await assert.rejects(module.exports.deliver(), /interrupted after first visible part/);
  assert.equal(messages.length, 1);
  failAfterFirst = false;
  ctx.ttsConfig = { voiceMode: 'full', fishAudioApiKey: 'fixture-not-a-key' };
  await module.exports.deliver();
  assert.deepEqual(messages.map(message => message.text), response.textParts, 'even a voice-setting change cannot duplicate or lose the visible text prefix');
  await module.exports.deliver();
  assert.equal(messages.length, 3, 'multiple retries do not append visible parts again');
  messages.splice(0, messages.length, { id: 'frozen-turn:reply:0', role: 'model', text: response.textParts.join(' ') });
  ctx.ttsConfig = { voiceMode: 'off' };
  await module.exports.deliver();
  assert.equal(messages.length, 1, 'a prior combined voice/fallback bubble consumes all response parts');
}

async function uncertainLocationPersists() {
  const h = harness();
  try {
    const old = h.source('我在武汉');
    h.respond({ locations: [{ sourceMessageId: old.id, locationText: '武汉', sourceQuote: old.text }], reminders: [] });
    const original = await h.start([old]); await original.prepare(true); await original.dispose();
    const waitingSource = h.source('今天怎么样');
    const waiting = await h.start([waitingSource]);
    await waiting.saveResponse({ textParts: ['你那边武汉的天气真好。'], emotion: 'neutral' });
    const moved = h.source('我刚刚抵达巴黎');
    // Simulate a proposal whose quote cannot be verified. It must suspend
    // current-city use, while preserving the last real historical fact.
    h.respond({ locations: [{ sourceMessageId: moved.id, locationText: '巴黎', sourceQuote: '我在巴黎' }], reminders: [] });
    const uncertain = await h.start([moved]); await uncertain.prepare(true);
    assert.equal(uncertain.catchUpResult().complete, true, 'unconfirmed semantic evidence is settled with clarification');
    await uncertain.dispose();
    assert.equal((await h.location.getUserKnownLocation()).locationText, '武汉');
    assert.match(await h.location.buildUserKnownLocationContext('zh'), /当前时区、当地时间和天气未知/);
    const fetches = h.events.filter(item => item.type === 'fetch').length;
    assert.equal((await h.location.queryKnownUserLocationWeather()).success, false, 'proactive weather observes persistent uncertainty too');
    assert.equal(h.events.filter(item => item.type === 'fetch').length, fetches, 'unknown current location never queries old weather');
    await assert.rejects(waiting.checkDelivery(), /Location assessment changed/, 'in-flight old-city reply cannot pass an unchanged fact revision');
    const later = h.source('看看我这里的天气');
    h.respond({ locations: [], reminders: [] });
    const next = await h.start([later]); await next.prepare(true);
    let executed = false;
    const blocked = await next.executeTool({ name: 'query_known_user_weather', args: {} }, async () => { executed = true; return {}; });
    assert.equal(executed, false);
    assert.equal(blocked.result.success, false, 'a later round cannot fall back to the historical city');
    await next.dispose();
    const answer = h.source('我现在在巴黎');
    h.respond({ locations: [{ sourceMessageId: answer.id, locationText: '巴黎', sourceQuote: answer.text }], reminders: [] });
    const clarified = await h.start([answer]); await clarified.prepare(true);
    assert.equal(h.value('kumiko_turn_location_uncertain_v1'), null);
    assert.equal((await h.location.getUserKnownLocation()).locationText, '巴黎');
    assert.equal((await h.location.queryKnownUserLocationWeather()).success, true);
  } finally { await h.close(); }
}

function hookHarness({ replyError = false, restore = false, readError = false, hydrate } = {}) {
  const a = { id: 'A', role: 'user', text: '前半句', timestamp: now - 1000, sendStatus: 'failed', failReason: 'network' };
  const b = { id: 'B', role: 'user', text: '后半句', timestamp: now, imageId: 'image-B', sendStatus: 'failed', failReason: 'network' };
  const group = [a, b]; const notices = []; const sends = [];
  const params = { language: 'zh', backupConfig: {}, messagesRef: { current: structuredClone(group) }, pendingMessageIdsRef: { current: new Set() },
    pendingTextRef: { current: '' }, pendingImageRef: { current: null }, pendingImageMessageIdRef: { current: null }, generationIdRef: { current: 0 },
    setMessages(fn) { params.messagesRef.current = typeof fn === 'function' ? fn(params.messagesRef.current) : fn; }, setIsDisconnected() {}, setSystemNotice(value) { notices.push(value); },
    async executeSend() { sends.push({ ids: [...params.pendingMessageIdsRef.current], text: params.pendingTextRef.current, image: params.pendingImageRef.current,
      imageId: params.pendingImageMessageIdRef.current }); if (replyError) throw new Error('async reply failed'); },
  };
  const dependencies = {
    react: { useCallback: fn => fn, useRef: value => ({ current: value }) }, './backupHelpers': {}, './summaryCycle': {},
    '../../services/geminiService': {}, '../../services/fishAudioService': {}, '../../services/voiceFileService': {}, '../../services/dialogService': {},
    '../../services/messageViews': { hideMessagesLocally: async () => {} },
    '../../services/receivedTurns': { withdrawUnprocessedSource: async () => true },
    '../../services/voiceWriteLedger': { beginVoiceWrite: async () => {}, finishVoiceWrite: async () => true },
    '../../services/memoryMaintenanceGate': { getMemoryGeneration: () => 'initial', assertMemoryAvailable() {}, assertMemoryGenerationCurrent: async () => {} },
    '../../services/taskRuntime': { assertTaskModelRevisionsCurrent: async () => {} },
    '../../services/db': { db: {} },
    '../../services/mediaWriteFence': { withMediaWriteFence: async (_version, work) => work() },
    '../../services/dataRestoreGate': { isDataRestoreBlocked: () => restore },
    '../../services/imageService': { getImageBase64: hydrate || (async () => 'data:image/png;base64,fixture') },
    '../../services/turnCoordinator': { async readTurnSources() { if (readError) throw new Error('User source changed or was removed'); return { turnId: 'A', epoch: 'initial', sources: group.map(({ id, role, text, timestamp }) => ({ id, role, text, timestamp })), messages: structuredClone(group) }; } },
    '../../store': { useAppStore: { getState: () => ({ isThinking: false, isTalking: false }) } },
  };
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../components/app/useMessageHistoryOperations.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console: { warn() {} }, setTimeout, clearTimeout,
    require(id) { assert.ok(Object.hasOwn(dependencies, id), id); return dependencies[id]; } });
  return { params, sends, notices, api: module.exports.useMessageHistoryOperations(params) };
}

async function uiRetry() {
  for (const clicked of ['A', 'B']) {
    const h = hookHarness();
    await h.api.handleResendMessage(clicked);
    assert.deepEqual([...h.sends[0].ids], ['A', 'B']);
    assert.equal(h.sends[0].text, '前半句\n后半句');
    assert.equal(h.sends[0].imageId, 'B');
    assert.ok(h.params.messagesRef.current.every(item => item.sendStatus === 'sending'));
  }
  const failed = hookHarness({ replyError: true });
  await failed.api.handleResendMessage('B');
  assert.ok(failed.params.messagesRef.current.every(item => item.sendStatus === 'failed'));
  assert.equal(failed.params.pendingMessageIdsRef.current.size, 0);
  for (const options of [{ restore: true }, { readError: true }, { hydrate: async () => null }]) {
    const rejected = hookHarness(options);
    await rejected.api.handleResendMessage('B');
    assert.equal(rejected.sends.length, 0);
    assert.equal(rejected.params.generationIdRef.current, 0);
  }
  let release;
  const concurrent = hookHarness({ hydrate: () => new Promise(resolve => { release = resolve; }) });
  const first = concurrent.api.handleResendMessage('A');
  await new Promise(resolve => setImmediate(resolve));
  await concurrent.api.handleResendMessage('B');
  release('image'); await first;
  assert.equal(concurrent.sends.length, 1, 'double tap retries the entire group once');
  let releaseEdit;
  const edited = hookHarness({ hydrate: () => new Promise(resolve => { releaseEdit = resolve; }) });
  const pending = edited.api.handleResendMessage('A');
  await new Promise(resolve => setImmediate(resolve));
  edited.params.messagesRef.current[0].text = '异步加载图片时编辑了来源';
  releaseEdit('image'); await pending;
  assert.equal(edited.sends.length, 0, 'live source edit during hydration is rejected');
}

async function main() {
  await frozenGroupRetry(); await factsOnlyRestore(); await uiRetry(); await partialVisibleReply(); await uncertainLocationPersists();
  console.log('Message retry passed: merged source recovery, original action/response identity, edited/deleted/image/epoch rejection, facts-only restore and UI group/image/async/double-tap guards.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
