#!/usr/bin/env node
'use strict';

// Real coordinator, understanding parser/gates, location service and reminder
// slice. Only transport, DB and clocks are replaced; no live user data/network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const now = Date.parse('2026-11-01T08:00:00Z');
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const clone = value => structuredClone(value);
function load(file, dependencies = {}, globals = {}) {
  const module = { exports: {} };
  const result = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: file,
  });
  vm.runInNewContext(result.outputText, {
    module, exports: module.exports, Date: Clock, Intl, URL, crypto,
    AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval,
    console: { log() {}, warn() {}, error() {} },
    require(id) { assert.ok(Object.hasOwn(dependencies, id), `Unexpected dependency ${id} in ${file}`); return dependencies[id]; },
    fetch() { throw new Error('Network is forbidden'); },
    localStorage: { getItem() { throw new Error('Hidden preferences are forbidden'); } },
    ...globals,
  }, { filename: file });
  return module.exports;
}

function harness() {
  let keyvals = new Map();
  let messages = new Map();
  let transactionQueue = Promise.resolve();
  let failureKey;
  let response = { locations: [], reminders: [] };
  let proposalsValid = true;
  const calls = [];
  const events = [];
  const runtimes = [];
  const db = {
    keyval: {
      get: async key => keyvals.has(key) ? { key, value: clone(keyvals.get(key)) } : undefined,
      put: async ({ key, value }) => {
        if (key === failureKey) throw new Error('simulated disk failure');
        keyvals.set(key, clone(value));
        events.push({ type: 'write', key, value: clone(value) });
      },
    },
    messages: { get: async id => clone(messages.get(id)) },
    getVal: async (key, fallback) => clone(keyvals.has(key) ? keyvals.get(key) : fallback),
    setVal: async (key, value) => db.keyval.put({ key, value }),
    transaction(mode, tables, work) {
      assert.ok(mode === 'r' || mode === 'rw');
      assert.ok((Array.isArray(tables) ? tables : [tables]).every(table => table === db.keyval || table === db.messages));
      const pending = transactionQueue.then(async () => {
        const previous = clone(keyvals); const previousMessages = clone(messages);
        try { return await work(); }
        catch (error) { keyvals = previous; messages = previousMessages; throw error; }
      });
      transactionQueue = pending.catch(() => {});
      return pending;
    },
  };
  const core = {
    getCurrentAIConfig: () => ({ provider: 'openai', model_main: 'fixture-main', model_summary: 'fixture-background' }),
    async callLLMRaw(system, user, model, options) {
      const type = system.startsWith('You extract proposals') ? 'understanding'
        : system.startsWith('Verify action proposals') ? 'action-verification'
        : system.startsWith('Verify whether the user answer') ? 'location-verification' : 'verification';
      assert.equal(model, undefined, 'critical role chooses its configured model at the gateway');
      assert.equal(options.maxRetries, 0);
      calls.push({ type, input: JSON.parse(user), system });
      if (type === 'action-verification') return JSON.stringify({ valid: proposalsValid });
      if (type === 'location-verification') return JSON.stringify({ valid: proposalsValid });
      if (type === 'verification') return '{"valid":false}';
      return typeof response === 'function' ? response(JSON.parse(user)) : JSON.stringify(response);
    },
  };
  async function fixtureFetch(url) {
    events.push({ type: 'fetch', url });
    const parsed = new URL(url);
    if (parsed.hostname === 'geocoding-api.open-meteo.com') {
      const city = parsed.searchParams.get('name');
      if (city === 'Springfield') return { ok: true, json: async () => ({ results: [
        { name: city, timezone: 'America/Chicago', latitude: 39.8, longitude: -89.6, feature_code: 'PPLA', admin1_id: 1 },
        { name: city, timezone: 'America/New_York', latitude: 42.1, longitude: -72.6, feature_code: 'PPLA', admin1_id: 2 },
      ] }) };
      if (city === '伊利诺伊') return { ok: true, json: async () => ({ results: [{ id: 1, name: city, feature_code: 'ADM1' }] }) };
      const places = {
        武汉: { name: '武汉', timezone: 'Asia/Shanghai', latitude: 30.58, longitude: 114.27 },
        巴黎: { name: '巴黎', timezone: 'Europe/Paris', latitude: 48.85, longitude: 2.35 },
        圣保罗: { name: '圣保罗', timezone: 'America/Sao_Paulo', latitude: -23.55, longitude: -46.63 },
      };
      if (city === '未知城') return { ok: true, json: async () => ({ results: [] }) };
      assert.ok(Object.hasOwn(places, city), `Unexpected location query ${city}`);
      return { ok: true, json: async () => ({ results: [{ ...places[city], feature_code: 'PPLA', country: 'fixture' }] }) };
    }
    assert.equal(parsed.hostname, 'api.open-meteo.com');
    return { ok: true, json: async () => ({ current: { time: '2026-11-01T09:00', temperature_2m: 12, weather_code: 1 } }) };
  }
  const router = load('services/taskModelRouter.ts', { './appConfig': { getDefaultMainModel: () => 'fixture-default' }, './roleProfiles': { resolveModelSessionCredential: x => x } });
  const location = load('services/userKnownLocation.ts', { './db': { db }, './taskGateway': {
    runTaskTransport: async (ctx, _target, work) => work(ctx.signal),
    runStandaloneTransport: async (_target, work, _assert, signal) => work(signal),
  } }, { fetch: fixtureFetch });
  const timing = load('services/reminderTime.ts');
  const understanding = load('services/turnUnderstanding.ts', {
    './llmCore': core, './taskModelRouter': router, './userKnownLocation': location,
    './taskRuntime': { TaskCapacityError: class TaskCapacityError extends Error {} },
  });
  const slice = load('store/slices/reminderSlice.ts', {
    '../../services/db': { db },
    '../../services/reminderNativeCancellation': { queueReminderNativeCancellation: async () => {}, drainReminderNativeCancellations: async () => {} }, '../../services/reminderTime': timing,
    '../../services/preferencesSync': { noteKeyvalPreferenceWrite() {} },
  });
  const coordinator = load('services/turnCoordinator.ts', {
    './db': { db }, './llmCore': core, './taskModelRouter': router,
    './reminderTime': timing, './userKnownLocation': location, './turnUnderstanding': understanding,
    './dataRestoreGate': { getDataRestoreVersion: () => 'initial' },
    './memoryMaintenanceGate': { getMemoryGeneration: () => 'initial' },
    './taskRuntime': { async beginForegroundActivity() {}, async endForegroundActivity() {} },
  });
  function window() {
    const state = { locationConfig: { modelTimezone: 'Asia/Tokyo', userTimezone: 'Asia/Shanghai' } };
    Object.assign(state, slice.createReminderSlice(value => Object.assign(state,
      typeof value === 'function' ? value(state) : value), () => state));
    return state;
  }
  let sourceCount = 0;
  function source(text, role = 'user', timestamp = now) {
    const value = { id: `source-${++sourceCount}`, text, role, timestamp };
    messages.set(value.id, clone(value));
    return value;
  }
  async function start(sources, state = window(), extra = {}) {
    const runtime = await coordinator.createTurnCoordinator({ sources, recentMessages: [],
      language: 'zh', privateTimeZone: 'Asia/Shanghai', reminders: state, isCancelled: () => false, ...extra });
    runtimes.push(runtime);
    return runtime;
  }
  return {
    db, calls, events, source, start, window, location, understanding,
    respond: value => { response = value; },
    verifyProposals: value => { proposalsValid = value; },
    failReminderWrites: () => { failureKey = slice.RELATIVE_REMINDER_STORAGE_KEY; },
    value: key => clone(keyvals.get(key)),
    reminderRows: () => clone(keyvals.get(slice.RELATIVE_REMINDER_STORAGE_KEY) || []),
    dailyRows: () => clone(keyvals.get(slice.DAILY_REMINDER_STORAGE_KEY) || []),
    setEpoch: value => db.transaction('rw', db.keyval, () => db.keyval.put({ key: 'kumiko_turn_epoch_v1', value })),
    close: async () => { await Promise.all(runtimes.map(runtime => runtime.dispose())); },
  };
}
const candidate = (source, fields = {}) => ({ kind: 'create', sourceMessageId: source.id,
  sourceQuote: source.text, event: '喝水', delaySeconds: 600, ...fields });
const proposals = (...reminders) => ({ locations: [], reminders });
const receipts = runtime => JSON.parse(runtime.publicContext().split('\n').at(-1)).receipts;
const understoodCalls = h => h.calls.filter(call => call.type === 'understanding');

async function ordinaryAndNegativeCases() {
  const h = harness();
  try {
    const source = h.source('今天听了一首很棒的曲子。');
    const runtime = await h.start([source]);
    await runtime.prepare();
    await runtime.finishResponse({ textParts: ['我也很想听听。'] });
    assert.equal(h.calls.length, 0, 'ordinary chat adds no understanding or verification call');
    for (const text of ['不要10分钟后提醒我喝水', '别再每天8点提醒我喝水了',
      '翻译这句话：10分钟后提醒我喝水', '如果我说“10分钟后提醒我喝水”，你会怎么做？',
      '他说“10分钟后提醒我喝水”', '昨天我让你10分钟后提醒我喝水',
      '不要10分钟后叫醒我', '翻译：10分钟后叫醒我', '如果10分钟后叫醒我会怎样']) {
      const message = h.source(text);
      h.respond(proposals(candidate(message)));
      const denied = await h.start([message]);
      await denied.prepare();
      assert.equal(h.reminderRows().length, 0, text);
      assert.equal(denied.createdReminder(), false, text);
      await denied.finishResponse({ textParts: ['好的，我会提醒你。'], scheduleTrigger: { event: '喝水', delaySeconds: 600 } });
      assert.ok(!denied.publicContext().includes('"status":"saved"'));
      assert.equal(h.reminderRows().length, 0, 'generated promise cannot authorize a reminder');
      await denied.dispose();
    }
  } finally { await h.close(); }
}

async function reminderTaskWords() {
  for (const [text, event] of [['10分钟后提醒我翻译文件', '翻译文件'], ['10分钟后叫醒我', '叫醒我']]) {
    const h = harness();
    try {
      const source = h.source(text);
      h.respond(proposals(candidate(source, { event })));
      const runtime = await h.start([source]);
      await runtime.prepare();
      assert.equal(runtime.createdReminder(), true, text);
      assert.equal(h.reminderRows()[0].event, event);
    } finally { await h.close(); }
  }
}

async function locationClarification() {
  const h = harness();
  try {
    const original = h.source('我在Springfield');
    h.respond({ locations: [{ sourceMessageId: original.id, locationText: 'Springfield', sourceQuote: original.text }], reminders: [] });
    const first = await h.start([original]); await first.prepare(); await first.dispose();
    assert.equal((await h.location.getUserKnownLocation()).status, 'ambiguous');
    assert.equal(h.value('kumiko_turn_location_pending_v1').source.id, original.id);
    const unrelated = h.source('今天天气怎么样');
    h.respond({ locations: [], reminders: [] });
    const other = await h.start([unrelated]); await other.prepare(); await other.dispose();
    assert.equal(h.value('kumiko_turn_location_pending_v1').source.id, original.id);
    const answer = h.source('伊利诺伊州');
    const completed = await h.start([answer]); await completed.prepare();
    const known = await h.location.getUserKnownLocation();
    assert.equal(known.status, 'resolved');
    assert.equal(known.sourceMessage.id, original.id);
    assert.equal(known.clarification.sourceMessage.id, answer.id);
    assert.equal(known.timeZone, 'America/Chicago');
    assert.equal(h.value('kumiko_turn_location_pending_v1'), null);
    await completed.dispose();
    const replay = await h.start([answer]); await replay.prepare();
    assert.equal((await h.location.getUserKnownLocation()).revision, known.revision, 'retry does not duplicate the fact');
  } finally { await h.close(); }
  for (const mode of ['expired', 'cancelled', 'new-place', 'restored', 'verification-failed']) {
    const x = harness();
    try {
      const original = x.source('我在Springfield');
      x.respond({ locations: [{ sourceMessageId: original.id, locationText: 'Springfield', sourceQuote: original.text }], reminders: [] });
      const first = await x.start([original]); await first.prepare(); await first.dispose();
      if (mode === 'expired') {
        const pending = x.value('kumiko_turn_location_pending_v1'); pending.expiresAt = now - 1;
        await x.db.setVal('kumiko_turn_location_pending_v1', pending);
      } else if (mode === 'restored') await x.setEpoch('restored');
      else if (mode !== 'verification-failed') {
        const next = x.source(mode === 'cancelled' ? '算了' : '我在巴黎');
        x.respond(mode === 'cancelled' ? { locations: [], reminders: [] } :
          { locations: [{ sourceMessageId: next.id, locationText: '巴黎', sourceQuote: next.text }], reminders: [] });
        const interrupted = await x.start([next]); await interrupted.prepare(); await interrupted.dispose();
      }
      const answer = x.source('伊利诺伊州');
      if (mode === 'verification-failed') x.verifyProposals(false);
      x.respond({ locations: [], reminders: [] });
      const later = await x.start([answer]); await later.prepare();
      assert.equal((await x.location.getUserKnownLocation())?.clarification, undefined, mode);
    } finally { await x.close(); }
  }
}

async function savedFailedAndRetries() {
  const h = harness();
  try {
    const source = h.source('别忘了10分钟后提醒我喝水');
    h.respond(proposals(candidate(source)));
    const state = h.window(); const runtime = await h.start([source], state);
    await runtime.prepare();
    assert.equal(runtime.createdReminder(), true);
    assert.equal(receipts(runtime)[0].status, 'saved');
    assert.match(await runtime.failureNotice(), /提醒操作已有完成记录/, 'failed reply must not hide a committed action');
    assert.equal(receipts(runtime)[0].scheduling, 'not_confirmed');
    assert.equal(h.reminderRows()[0].dueAt, now + 600_000);
    const reply = { textParts: ['我会提醒你。'], scheduleTrigger: { event: '喝水', delaySeconds: 600 } };
    await runtime.finishResponse(reply);
    assert.match(reply.textParts.join(''), /提醒记下了/);
    assert.equal(reply.scheduleTrigger, undefined);
    const actionId = receipts(runtime)[0].actionId;
    await runtime.dispose();
    await state.removeRelativeReminder(h.reminderRows()[0].id); // delivery/delete before retry.
    h.respond(proposals(candidate(source, { event: '吃药', delaySeconds: 1200 })));
    const beforeCalls = understoodCalls(h).length;
    const retry = await h.start([source], h.window());
    await retry.prepare();
    assert.equal(understoodCalls(h).length, beforeCalls, 'same input reuses frozen understanding');
    assert.equal(h.reminderRows().length, 0, 'retry cannot recreate a delivered task');
    assert.equal(receipts(retry)[0].actionId, actionId);
    assert.equal(receipts(retry)[0].event, '喝水');
  } finally { await h.close(); }

  const failed = harness();
  try {
    const source = failed.source('10分钟后提醒我喝水');
    failed.respond(proposals(candidate(source)));
    failed.failReminderWrites();
    const state = failed.window(); const runtime = await failed.start([source], state);
    await runtime.prepare();
    assert.equal(receipts(runtime)[0].status, 'failed');
    assert.equal(await runtime.failureNotice(), undefined, 'failed save cannot be reported as a committed action');
    assert.equal(runtime.createdReminder(), false);
    assert.equal(failed.reminderRows().length, 0); assert.equal(state.relativeReminders.length, 0);
    const reply = { textParts: ['提醒设置好了。'], scheduleTrigger: { event: '喝水', delaySeconds: 600 } };
    await runtime.finishResponse(reply);
    assert.match(reply.textParts.join(''), /没能保存成功/);
    assert.equal(reply.scheduleTrigger, undefined);
  } finally { await failed.close(); }
}

async function ownershipEpochAndSources() {
  const h = harness();
  try {
    const source = h.source('10分钟后提醒我喝水');
    h.respond(proposals(candidate(source)));
    const attempts = await Promise.allSettled([h.start([source], h.window()), h.start([source], h.window())]);
    assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter(item => item.status === 'rejected').length, 1);
    const first = attempts.find(item => item.status === 'fulfilled').value;
    await Promise.all([first.prepare(), first.prepare()]);
    assert.equal(h.reminderRows().length, 1); assert.equal(understoodCalls(h).length, 1);
    await h.setEpoch('restored:test');
    await assert.rejects(first.prepare(), /restored|cancelled|timed out/i);
    await assert.rejects(first.executeTool({ id: 'weather', name: 'query_known_user_weather', args: {} }, async () => {
      throw new Error('stale tool must not execute');
    }), /restored|cancelled|timed out/i);
    await first.dispose();
    await assert.rejects(h.start([source]), /restored/i);
    const absent = { id: 'not-in-db', role: 'user', text: '10分钟后提醒我喝水', timestamp: now };
    await assert.rejects(h.start([absent]), /not saved/i);
    const actual = h.source('你好');
    await assert.rejects(h.start([{ ...actual, text: '10分钟后提醒我喝水' }]), /not saved/i);
    await assert.rejects(h.start([{ ...actual, role: 'model' }]), /actual user sources/i);
    assert.equal(h.reminderRows().length, 1);
  } finally { await h.close(); }
}

async function pendingAnswers() {
  const h = harness();
  try {
    const initial = h.source('提醒我喝水');
    h.respond(proposals(candidate(initial, { delaySeconds: undefined })));
    const runtime = await h.start([initial]);
    await runtime.prepare();
    assert.equal(receipts(runtime)[0].status, 'needs_clarification');
    assert.equal(h.reminderRows().length, 0);
    await runtime.dispose();
    const answer = h.source('10分钟后');
    h.respond(input => {
      assert.equal(input.pending.source.id, initial.id);
      assert.equal(input.pending.candidate.event, '喝水');
      return JSON.stringify(proposals(candidate(answer, { event: undefined })));
    });
    const completed = await h.start([answer]);
    await completed.prepare();
    assert.equal(receipts(completed)[0].status, 'saved');
    assert.equal(h.reminderRows()[0].event, '喝水');
    assert.equal(h.value('kumiko_turn_pending_v1'), null);
  } finally { await h.close(); }

  const unassociated = harness();
  try {
    const old = unassociated.source('10分钟后提醒我喝水');
    const answer = unassociated.source('10分钟后');
    unassociated.respond(proposals(candidate(answer)));
    const runtime = await unassociated.start([answer], undefined, { recentMessages: [old] });
    await runtime.prepare(true);
    assert.equal(unassociated.reminderRows().length, 0, 'recent chat cannot replace an actual pending clarification');
    assert.equal(runtime.createdReminder(), false);
  } finally { await unassociated.close(); }
}

async function locationBeforeWeather() {
  const h = harness();
  try {
    const old = h.source('我在武汉');
    await h.location.commitUserLocationFact({ locationText: '武汉', sourceQuote: old.text }, old, { isActualUserTurn: true });
    await h.location.resolveUserKnownLocation();
    assert.equal((await h.location.getUserKnownLocation()).locationText, '武汉');
    const source = h.source('我现在在巴黎。看看我这里天气');
    h.respond({ locations: [{ sourceMessageId: source.id, kind: 'assert', locationText: '巴黎', sourceQuote: '我现在在巴黎' }], reminders: [] });
    const runtime = await h.start([source]);
    let toolExecutions = 0;
    const call = { id: 'weather:1', name: 'query_known_user_weather', args: {} };
    const execute = async () => {
      toolExecutions++;
      const known = await h.location.getUserKnownLocation();
      assert.equal(known.locationText, '巴黎', 'new location is committed before executor starts');
      assert.equal(known.timeZone, 'Europe/Paris');
      h.events.push({ type: 'executor', sourceId: known.sourceMessage.id });
      return { call, result: await h.location.queryKnownUserLocationWeather() };
    };
    const result = await runtime.executeTool(call, execute);
    assert.equal(result.result.success, true);
    assert.equal(result.result.location, '巴黎');
    const parisCommit = h.events.findIndex(event => event.type === 'write' && event.key === 'user_known_location_v1' && event.value.sourceMessage.id === source.id);
    const executor = h.events.findIndex(event => event.type === 'executor');
    assert.ok(parisCommit >= 0 && parisCommit < executor);
    const lastWeather = h.events.filter(event => event.type === 'fetch' && event.url.includes('/forecast')).at(-1);
    assert.equal(new URL(lastWeather.url).searchParams.get('latitude'), '48.85');
    await runtime.executeTool({ ...call, id: 'weather:2' }, execute);
    assert.equal(toolExecutions, 1, 'duplicate tool input reuses the same current-location result');
    assert.equal(understoodCalls(h).length, 1);
    await runtime.checkDelivery();
    const changed = h.source('我在武汉');
    await h.location.commitUserLocationFact({ locationText: '武汉', sourceQuote: changed.text }, changed,
      { isActualUserTurn: true, sourceSequence: 1000 });
    await assert.rejects(runtime.checkDelivery(), /Location changed before delivery/,
      'typing/TTS delay cannot expose a reply using superseded location facts');
  } finally { await h.close(); }
}

async function clockContractCases() {
  const h = harness();
  try {
    const disclosed = h.source('我在圣保罗');
    await h.location.commitUserLocationFact({ locationText: '圣保罗', sourceQuote: disclosed.text }, disclosed, { isActualUserTurn: true });
    await h.location.resolveUserKnownLocation();
    const state = h.window();
    state.locationConfig.userTimezone = 'Pacific/Honolulu';
    const source = h.source('每天晚上8点提醒我洗衣服');
    h.respond(proposals(candidate(source, { event: '洗衣服', delaySeconds: undefined, hour: 20, minute: 0, recurrence: 'daily' })));
    const daily = await h.start([source], state, { privateTimeZone: 'Pacific/Honolulu' });
    await daily.prepare();
    assert.equal(h.dailyRows().length, 1, 'understood action saves before any main-model Schedule_Trigger');
    assert.equal(h.dailyRows()[0].hour, 20);
    assert.equal(h.dailyRows()[0].timeZone, 'America/Sao_Paulo', 'disclosed location wins over hidden Honolulu');
    const wrongLegacyTag = { textParts: ['提醒你洗衣服。'], scheduleTrigger: { event: '洗衣服', recurrence: 'daily', hour: 8, minute: 0 } };
    await daily.finishResponse(wrongLegacyTag);
    assert.equal(h.dailyRows()[0].hour, 20, 'incorrect final Schedule_Trigger cannot re-execute or alter the committed action');
    assert.equal(h.dailyRows().length, 1); assert.equal(wrongLegacyTag.scheduleTrigger, undefined);

    const onceSource = h.source('晚上8点提醒我洗衣服');
    h.respond(proposals(candidate(onceSource, { event: '洗衣服', delaySeconds: undefined, hour: 20, minute: 0, recurrence: 'once' })));
    const once = await h.start([onceSource], state, { privateTimeZone: 'Pacific/Honolulu' });
    await once.prepare();
    assert.equal(h.reminderRows().at(-1).dueAt, Date.parse('2026-11-01T23:00:00Z'));
    assert.equal(h.reminderRows().at(-1).timeZone, 'America/Sao_Paulo');
    for (const call of h.calls.filter(item => item.type === 'understanding' || item.type === 'action-verification')) {
      assert.ok(!JSON.stringify(call.input).includes('Pacific/Honolulu'));
      assert.ok(!call.system.includes('Pacific/Honolulu'));
    }
  } finally { await h.close(); }

  for (const locationStatus of ['unresolved', 'retracted']) {
    const isolated = harness();
    try {
      const disclosure = isolated.source(locationStatus === 'unresolved' ? '我在未知城' : '我在圣保罗');
      await isolated.location.commitUserLocationFact({ locationText: locationStatus === 'unresolved' ? '未知城' : '圣保罗', sourceQuote: disclosure.text }, disclosure, { isActualUserTurn: true });
      await isolated.location.resolveUserKnownLocation();
      if (locationStatus === 'retracted') {
        const departure = isolated.source('我不在圣保罗了');
        await isolated.location.commitUserLocationFact({ kind: 'retract', locationText: '圣保罗', sourceQuote: departure.text }, departure, { isActualUserTurn: true });
      }
      assert.equal((await isolated.location.getUserKnownLocation()).status, locationStatus);
      const source = isolated.source('晚上8点提醒我洗衣服');
      isolated.respond(proposals(candidate(source, { event: '洗衣服', delaySeconds: undefined, hour: 20, minute: 0 })));
      const clock = await isolated.start([source], undefined, { privateTimeZone: 'Pacific/Honolulu' });
      await clock.prepare();
      assert.equal(isolated.reminderRows().length, 0, `${locationStatus} does not borrow a hidden clock`);
      assert.equal(receipts(clock)[0].status, 'needs_clarification');
      assert.equal(receipts(clock)[0].reason, 'unknown_clock');
      await clock.dispose();
      const relativeSource = isolated.source('10分钟后提醒我喝水');
      isolated.respond(proposals(candidate(relativeSource)));
      const relative = await isolated.start([relativeSource]);
      await relative.prepare();
      assert.equal(receipts(relative)[0].status, 'saved', `${locationStatus} does not block a relative duration`);
      assert.equal(isolated.reminderRows()[0].dueAt, now + 600_000);
    } finally { await isolated.close(); }
  }

  const rejected = harness();
  try {
    const source = rejected.source('10分钟后提醒我喝水');
    rejected.respond(proposals(candidate(source, { delaySeconds: 1200 })));
    rejected.verifyProposals(false);
    const runtime = await rejected.start([source]);
    await runtime.prepare();
    assert.equal(rejected.reminderRows().length, 0, 'failed semantic action check blocks a syntactically valid wrong duration');
    assert.equal(runtime.createdReminder(), false);
    assert.ok(rejected.calls.some(call => call.type === 'action-verification'));
  } finally { await rejected.close(); }
}

async function reviewRegressionCases() {
  const activity = harness();
  try {
    const old = activity.source('我在武汉');
    await activity.location.commitUserLocationFact({ locationText: '武汉', sourceQuote: old.text }, old, { isActualUserTurn: true });
    await activity.location.resolveUserKnownLocation();
    const eating = activity.source('我在吃饭');
    activity.respond(proposals());
    const ordinary = await activity.start([eating]);
    await ordinary.prepare();
    assert.equal((await activity.location.getUserKnownLocation()).sourceMessage.id, old.id,
      'local activity wording cannot override a semantic result with no location proposal');
    const call = { id: 'known-weather', name: 'query_known_user_weather', args: {} };
    const weather = await ordinary.executeTool(call, async () => ({ call, result: await activity.location.queryKnownUserLocationWeather() }));
    assert.equal(weather.result.success, true);
    assert.equal(weather.result.location, '武汉', 'an ordinary activity does not withdraw a previously disclosed location');
    await ordinary.dispose();
    const unknown = activity.source('我现在在未知城，看看我这里天气');
    activity.respond({ locations: [{ sourceMessageId: unknown.id, locationText: '未知城', sourceQuote: '我现在在未知城' }], reminders: [] });
    const changed = await activity.start([unknown]);
    await changed.prepare();
    const before = activity.events.filter(event => event.type === 'fetch' && event.url.includes('/forecast')).length;
    const unknownWeather = await changed.executeTool({ ...call, id: 'unknown-weather' }, async () => ({ call, result: await activity.location.queryKnownUserLocationWeather() }));
    assert.equal(unknownWeather.result.status, 'unknown');
    assert.equal((await activity.location.getUserKnownLocation()).locationText, '未知城');
    assert.equal(activity.events.filter(event => event.type === 'fetch' && event.url.includes('/forecast')).length, before,
      'a newly disclosed unresolved city cannot fall back to old Wuhan weather');
  } finally { await activity.close(); }

  const uncertain = harness();
  try {
    const old = uncertain.source('我在武汉');
    await uncertain.location.commitUserLocationFact({ locationText: '武汉', sourceQuote: old.text }, old, { isActualUserTurn: true });
    await uncertain.location.resolveUserKnownLocation();
    const moved = uncertain.source('我刚刚抵达巴黎，查下我这里天气');
    uncertain.respond({ locations: [{ sourceMessageId: moved.id, locationText: '巴黎', sourceQuote: '我刚刚抵达巴黎' }], reminders: [] });
    const runtime = await uncertain.start([moved]);
    await runtime.prepare();
    let executions = 0;
    const call = { id: 'uncertain-weather', name: 'query_known_user_weather', args: {} };
    const result = await runtime.executeTool(call, async () => {
      executions++;
      return { call, result: await uncertain.location.queryKnownUserLocationWeather() };
    });
    assert.equal(result.result.success, false, 'a rejected current-place proposal cannot authorize weather for the former city');
    assert.equal(executions, 0);
    assert.equal((await uncertain.location.getUserKnownLocation()).locationText, '武汉', 'unclear wording does not replace a sourced fact');
    assert.equal(uncertain.events.filter(event => event.type === 'fetch' && event.url.includes('/forecast')).length, 0);
  } finally { await uncertain.close(); }

  const cancellation = harness();
  try {
    const state = cancellation.window();
    await state.saveRelativeReminder('喝水', 600, '10分钟后提醒我喝水');
    await state.saveRelativeReminder('吃药', 1200, '20分钟后提醒我吃药');
    const waterId = cancellation.reminderRows().find(item => item.event === '喝水').id;
    const initial = cancellation.source('取消那个提醒');
    cancellation.respond(proposals(candidate(initial, { kind: 'cancel', event: undefined, delaySeconds: undefined })));
    const asked = await cancellation.start([initial], state);
    await asked.prepare();
    assert.equal(receipts(asked)[0].reason, 'ambiguous_target');
    await asked.dispose();
    const answer = cancellation.source('喝水');
    cancellation.respond(proposals(candidate(answer, { kind: 'cancel', delaySeconds: undefined, targetId: waterId })));
    const completed = await cancellation.start([answer], state);
    await completed.prepare();
    assert.equal(receipts(completed)[0].status, 'saved', 'a named object can answer the cancellation question');
    assert.deepEqual(cancellation.reminderRows().map(item => item.event), ['吃药']);
    assert.equal(cancellation.value('kumiko_turn_pending_v1'), null);
  } finally { await cancellation.close(); }

  for (const event of ['喝水', '看5分钟新闻']) {
    const missingEvent = harness();
    try {
      const initial = missingEvent.source('十分钟后提醒我');
      missingEvent.respond(proposals(candidate(initial, { event: undefined })));
      const asked = await missingEvent.start([initial]);
      await asked.prepare();
      assert.equal(receipts(asked)[0].reason, 'missing_event');
      await asked.dispose();
      const answer = missingEvent.source(event, 'user', now + 120_000);
      missingEvent.respond(proposals(candidate(answer, { event })));
      const completed = await missingEvent.start([answer]);
      await completed.prepare();
      assert.equal(receipts(completed)[0].status, 'saved', 'a named event can answer the missing-event question');
      assert.equal(missingEvent.reminderRows()[0].dueAt, now + 600_000,
        `clarifying event ${event} does not restart an inherited duration`);
    } finally { await missingEvent.close(); }
  }

  for (const localOverride of [false, true]) {
    const zone = harness();
    try {
      const disclosed = zone.source('我在巴黎');
      await zone.location.commitUserLocationFact({ locationText: '巴黎', sourceQuote: disclosed.text }, disclosed, { isActualUserTurn: true });
      await zone.location.resolveUserKnownLocation();
      const initial = zone.source('按日本时间提醒我喝水');
      zone.respond(proposals(candidate(initial, { delaySeconds: undefined, timeZone: 'Asia/Tokyo' })));
      const asked = await zone.start([initial], undefined, { privateTimeZone: 'Pacific/Honolulu' });
      await asked.prepare();
      assert.equal(receipts(asked)[0].reason, 'missing_or_conflicting_time');
      await asked.dispose();
      const answer = zone.source(localOverride ? '改为当地时间晚上8点' : '晚上8点');
      zone.respond(proposals(candidate(answer, { delaySeconds: undefined, hour: 20, minute: 0,
        ...(localOverride ? {} : { timeZone: 'Asia/Tokyo' }) })));
      const completed = await zone.start([answer], undefined, { privateTimeZone: 'Pacific/Honolulu' });
      await completed.prepare();
      assert.equal(receipts(completed)[0].status, 'saved');
      assert.equal(zone.reminderRows()[0].timeZone, localOverride ? 'Europe/Paris' : 'Asia/Tokyo',
        'pending clock basis persists unless the current user explicitly changes it');
      assert.equal(zone.reminderRows()[0].dueAt, Date.parse(localOverride ? '2026-11-01T19:00:00Z' : '2026-11-01T11:00:00Z'));
      for (const call of zone.calls) assert.ok(!JSON.stringify(call.input).includes('Pacific/Honolulu'));
    } finally { await zone.close(); }
  }

  const clockAnswer = harness();
  try {
    const disclosed = clockAnswer.source('我在未知城');
    await clockAnswer.location.commitUserLocationFact({ locationText: '未知城', sourceQuote: disclosed.text }, disclosed, { isActualUserTurn: true });
    await clockAnswer.location.resolveUserKnownLocation();
    const initial = clockAnswer.source('晚上8点提醒我喝水');
    clockAnswer.respond(proposals(candidate(initial, { delaySeconds: undefined, hour: 20, minute: 0 })));
    const asked = await clockAnswer.start([initial]);
    await asked.prepare();
    assert.equal(receipts(asked)[0].reason, 'unknown_clock');
    await asked.dispose();
    const answer = clockAnswer.source('日本时间');
    clockAnswer.respond(proposals(candidate(answer, { delaySeconds: undefined, hour: 20, minute: 0, timeZone: 'Asia/Tokyo' })));
    const completed = await clockAnswer.start([answer]);
    await completed.prepare();
    assert.equal(receipts(completed)[0].status, 'saved', 'a clock-basis short answer completes the pending request');
    assert.equal(clockAnswer.reminderRows()[0].timeZone, 'Asia/Tokyo');
    assert.equal((await clockAnswer.location.getUserKnownLocation()).locationText, '未知城', 'a clock-basis answer is not a new user-location disclosure');
  } finally { await clockAnswer.close(); }

  const midnight = harness();
  try {
    const initial = midnight.source('明天晚上8点提醒我', 'user', Date.parse('2026-11-01T14:59:00Z'));
    midnight.respond(proposals(candidate(initial, { event: undefined, delaySeconds: undefined, hour: 20, minute: 0, daysOffset: 1 })));
    const asked = await midnight.start([initial], undefined, { privateTimeZone: 'Asia/Tokyo' });
    await asked.prepare();
    assert.equal(receipts(asked)[0].reason, 'missing_event');
    await asked.dispose();
    const answer = midnight.source('喝水', 'user', Date.parse('2026-11-01T15:01:00Z'));
    midnight.respond(proposals(candidate(answer, { delaySeconds: undefined, hour: 20, minute: 0, daysOffset: 1 })));
    const completed = await midnight.start([answer], undefined, { privateTimeZone: 'Asia/Tokyo' });
    await completed.prepare();
    assert.equal(receipts(completed)[0].status, 'saved');
    assert.equal(midnight.reminderRows()[0].dueAt, Date.parse('2026-11-02T11:00:00Z'),
      'tomorrow remains relative to the original time-bearing message across midnight');
  } finally { await midnight.close(); }
}

async function main() {
  {
    const h = harness();
    try {
      const source = h.source('共享本轮请求预算');
      const abort = new AbortController();
      const refs = [];
      const taskContext = { taskId: 'environment', rootId: 'turn-source:shared', role: 'subject', lane: 'foreground',
        deadlineAt: Date.now() + 30000, epoch: 'initial', memoryGeneration: 'initial', signal: abort.signal,
        consultedSources: refs, modelRevisions: {} };
      const runtime = await h.start([source], undefined, { taskContext });
      assert.equal(runtime.taskContext.rootId, taskContext.rootId);
      assert.equal(runtime.taskContext.deadlineAt, taskContext.deadlineAt);
      assert.equal(runtime.taskContext.consultedSources, refs);
      abort.abort();
      await assert.rejects(runtime.prepare(), /cancelled|timed out/i);
    } finally { await h.close(); }
  }
  const groups = { intent: ordinaryAndNegativeCases, taskWords: reminderTaskWords, locationClarification, persistence: savedFailedAndRetries,
    ownership: ownershipEpochAndSources, pending: pendingAnswers, location: locationBeforeWeather, clocks: clockContractCases,
    regressions: reviewRegressionCases };
  const selected = process.argv[2];
  if (selected) assert.ok(Object.hasOwn(groups, selected), `Unknown group ${selected}`);
  for (const [name, work] of Object.entries(groups)) if (!selected || name === selected) await work();
  console.log(selected ? `Turn coordinator passed: ${selected} group.`
    : 'Turn coordinator passed: ordinary chat, intent gates, real saves/failures, frozen retries, window ownership, epoch/source guards, pending answers, location-before-weather and clock contracts.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
