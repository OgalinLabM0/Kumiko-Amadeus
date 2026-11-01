#!/usr/bin/env node
'use strict';

// F05: run production TypeScript with fake clocks, React effects, storage and
// platform/model boundaries. No private data, network or paid model calls.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const silentConsole = { log() {}, warn() {}, error() {} };
const timestamp = value => Date.parse(`${value}+09:00`);

function load(relativePath, dependencies = {}, globals = {}) {
  const filename = path.join(root, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module, exports: module.exports, console: silentConsole,
    require(id) {
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      throw new Error(`Unexpected dependency ${id} in ${relativePath}`);
    },
    ...globals,
  }, { filename });
  return module.exports;
}

function createHookHarness() {
  let now = timestamp('2026-09-12T00:10:00');
  const refs = [];
  let refIndex = 0;
  const effects = [];
  const intervals = new Map();
  const diaries = new Map();
  const fragments = new Map([
    ['2026-09-11', ['yesterday fragment']],
    ['2026-09-12', ['today fragment']],
  ]);
  const calls = [];
  const embedded = [];
  const deleted = [];
  let behavior = async () => true;
  let ambientBehavior = async () => 'TODAY_WEATHER_ONLY 今日特殊历法：日本法定节假日';
  let ambientCalls = 0;
  let intervalId = 0;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const holidayResult = { success: true, holidays: { '2026-09-11': 'Yesterday holiday' } };
  const diaryHelper = load('services/diarySettlement.ts', {}, {
    window: { electronAPI: { invoke: async channel => {
      assert.equal(channel, 'app:get-japan-holidays');
      return holidayResult;
    } } },
  });
  const hook = load('hooks/useProactiveLifeCycle.ts', {
    react: {
      useRef: initial => refs[refIndex++] ||= { current: initial },
      useCallback: callback => callback,
      useEffect: callback => effects.push(callback),
    },
    '../components/app/ambientContext': { getAmbientEnvironmentContext: async () => {
      ambientCalls++;
      return ambientBehavior();
    } },
    '../components/app/chatActions': { triggerNativeProactiveMessage: async () => {} },
    '../services/diarySettlement': diaryHelper,
    '../services/db': { db: {
      kumikoDiary: { where: () => ({ equals: date => ({ first: async () => diaries.get(date) }) }) },
      dailyFragments: { where: () => ({ equals: date => ({ delete: async () => {
        deleted.push(date); fragments.delete(date);
      } }) }) },
    } },
    '../services/lifeStreamService': {
      generateDailyDiary: async (...args) => {
        calls.push(args);
        if (!await behavior()) return null;
        const diary = { date: args[0], id: args[0], content: 'test diary' };
        diaries.set(diary.date, diary);
        return diary;
      },
      embedDiaryToRAG: async diary => { embedded.push(diary.date); return { ok: true }; },
    },
  }, {
    Date: ClockDate,
    localStorage: { getItem: () => 'false' },
    setInterval: callback => { intervals.set(++intervalId, callback); return intervalId; },
    clearInterval: id => intervals.delete(id),
    setTimeout: () => 1,
    clearTimeout() {},
  });
  let cleanup;
  return {
    calls, embedded, deleted, diaries, fragments, holidayResult,
    setTime(value) { now = timestamp(value); },
    setBehavior(value) { behavior = value; },
    setAmbientBehavior(value) { ambientBehavior = value; },
    get ambientCalls() { return ambientCalls; },
    render(messages = [], overrides = {}) {
      cleanup?.(); refIndex = 0; effects.length = 0;
      hook.useProactiveLifeCycle({
        flowState: 'APP', messages, isTalking: false, isThinking: false,
        language: 'zh', locationConfig: { modelTimezone: 'Asia/Tokyo' },
        setCurrentEmotion() {}, ...overrides,
      });
      // The mount-only sleep bootstrap is unrelated to diary settlement.
      cleanup = effects[1]();
    },
    async tick() {
      const callbacks = [...intervals.values()];
      assert.equal(callbacks.length, 1);
      await callbacks[0]();
    },
  };
}

async function testCalendar() {
  const helper = load('services/diarySettlement.ts');
  for (const [input, expected] of [
    ['2026-09-11T22:59:59', null],
    ['2026-09-11T23:00:00', '2026-09-11'],
    ['2026-09-12T00:00:00', '2026-09-11'],
    ['2026-09-12T02:59:59', '2026-09-11'],
    ['2026-09-12T03:00:00', null],
    ['2027-01-01T00:10:00', '2026-12-31'],
    ['2026-03-01T00:10:00', '2026-02-28'],
    ['2028-03-01T00:10:00', '2028-02-29'],
  ]) assert.equal(helper.getNightlyDiaryDate(timestamp(input)), expected, input);
  assert.equal(helper.getNightlyDiaryDate(NaN), null);
  const messages = [
    { timestamp: timestamp('2026-09-10T23:59:59') },
    { timestamp: timestamp('2026-09-11T00:00:00') },
    { timestamp: timestamp('2026-09-11T23:59:59') },
    { timestamp: timestamp('2026-09-12T00:00:00') },
    { timestamp: NaN },
  ];
  assert.equal(JSON.stringify(helper.selectDiaryMessages(messages, '2026-09-11')), JSON.stringify(messages.slice(1, 3)));
  const android = load('services/diarySettlement.ts', {
    './environment': { isCapacitorNative: () => true },
    './ambientWeatherDirect': { fetchJapanHolidaysDirect: async () => ({ success: true, holidays: { '2026-09-11': 'holiday' } }) },
  });
  assert.equal(await android.getDiaryHoliday('2026-09-11'), true);
  assert.equal(await android.getDiaryHoliday('2026-09-12'), false);
  const failure = load('services/diarySettlement.ts', {}, {
    window: { electronAPI: { invoke: async () => { throw new Error('offline'); } } },
  });
  assert.equal(await failure.getDiaryHoliday('2026-09-11'), undefined);
  const unsupported = load('services/diarySettlement.ts', {
    './environment': { isCapacitorNative: () => false },
  });
  assert.equal(await unsupported.getDiaryHoliday('2026-09-11'), undefined);
}

async function testHook() {
  const yesterday = { role: 'user', text: 'yesterday important chat', timestamp: timestamp('2026-09-11T21:00:00') };
  const afterMidnight = { role: 'model', text: 'new day chat', timestamp: timestamp('2026-09-12T00:01:00') };
  const tonight = { role: 'user', text: 'tonight important chat', timestamp: timestamp('2026-09-12T22:00:00') };
  const h = createHookHarness();
  h.render([yesterday, afterMidnight]); await h.tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], '2026-09-11');
  assert.equal(JSON.stringify(h.calls[0][1]), JSON.stringify([yesterday]));
  assert.equal(h.calls[0][3], undefined, 'yesterday weather must use historical fetch');
  assert.equal(h.calls[0][4], true, 'holiday must be keyed by target date');
  assert.equal(h.ambientCalls, 0);
  assert.ok(h.fragments.has('2026-09-12'), 'today fragments survive yesterday settlement');
  assert.deepEqual(h.deleted, ['2026-09-11']);
  assert.deepEqual(h.embedded, ['2026-09-11']);
  await h.tick(); assert.equal(h.calls.length, 1, 'existing diary must be retained');
  h.setTime('2026-09-12T23:10:00'); h.render([yesterday, afterMidnight, tonight]); await h.tick();
  assert.equal(h.calls.length, 2, 'midnight must not block tonight');
  assert.equal(h.calls[1][0], '2026-09-12');
  assert.equal(JSON.stringify(h.calls[1][1]), JSON.stringify([afterMidnight, tonight]));
  assert.match(h.calls[1][3], /TODAY_WEATHER_ONLY/);
  assert.equal(h.calls[1][4], false, 'ambient holiday text must not replace target calendar');

  const race = createHookHarness();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  race.setBehavior(() => gate); race.render([yesterday]);
  const first = race.tick();
  for (let i = 0; i < 20 && !race.calls.length; i++) await Promise.resolve();
  assert.equal(race.calls.length, 1);
  await race.tick();
  race.render([yesterday, afterMidnight]); await race.tick();
  assert.equal(race.calls.length, 1, 'pending generation survives interval and effect restarts');
  release(true); await first;
  await race.tick(); assert.equal(race.calls.length, 1);

  const retry = createHookHarness();
  retry.setBehavior(async () => { throw new Error('model failure'); });
  retry.render([yesterday]); await retry.tick();
  assert.equal(retry.deleted.length, 0, 'failed generation retains fragments');
  retry.setBehavior(async () => false); await retry.tick();
  assert.equal(retry.deleted.length, 0, 'null generation retains fragments');
  retry.setBehavior(async () => true); await retry.tick();
  assert.equal(retry.calls.length, 3, 'failure releases the settlement lock');
  assert.deepEqual(retry.deleted, ['2026-09-11']);

  const midnight = createHookHarness();
  let releaseAmbient;
  midnight.setAmbientBehavior(() => new Promise(resolve => { releaseAmbient = resolve; }));
  midnight.setTime('2026-09-12T23:59:59'); midnight.render([tonight]);
  const crossing = midnight.tick();
  for (let i = 0; i < 20 && !releaseAmbient; i++) await Promise.resolve();
  assert.ok(releaseAmbient);
  midnight.setTime('2026-09-13T00:01:00'); releaseAmbient('NEW_DAY_WEATHER');
  await crossing;
  assert.equal(midnight.calls[0][0], '2026-09-12');
  assert.equal(midnight.calls[0][3], undefined, 'ambient response after midnight cannot describe previous date');

  const skip = createHookHarness();
  skip.setTime('2026-09-12T03:00:00'); skip.render([yesterday]); await skip.tick();
  assert.equal(skip.calls.length, 0);
  skip.setTime('2026-09-12T23:00:00'); skip.render([tonight], { isThinking: true }); await skip.tick();
  assert.equal(skip.calls.length, 0);
}

async function testHistoricalWeatherIntegration() {
  for (const { native, weatherAvailable, holiday } of [
    { native: false, weatherAvailable: true, holiday: true },
    { native: true, weatherAvailable: true, holiday: true },
    { native: false, weatherAvailable: false, holiday: undefined },
  ]) {
    const weatherDates = [];
    const prompts = [];
    const fragments = ['YESTERDAY_FRAGMENT'];
    const emptyQuery = { reverse() { return this; }, limit() { return this; }, toArray: async () => [] };
    const service = load('services/lifeStreamService.ts', {
      './db': {
        db: {
          dailyFragments: { where: () => ({ equals: date => ({ sortBy: async () => {
            assert.equal(date, '2026-09-11');
            return fragments.map(content => ({ content, timestamp: timestamp('2026-09-11T20:00:00') }));
          } }) }) },
          kumikoDiary: { where: () => ({ below: () => emptyQuery }), put: async () => {} },
        },
        getWorldCharacterStatus: async () => ({}),
      },
      './geminiService': {
        getCurrentAIConfig: () => ({ model_main: 'test' }),
        callLLMRaw: async prompt => { prompts.push(prompt); return '<diary_content>今天安静地整理东西。</diary_content><diary_summary>安静的一天</diary_summary>'; },
      },
      './diaryValidatorService': { verifyAgainstHistory: async () => [] },
      './kumikoStateMachine': { getSchoolTermContext: () => '', getSchoolPrepPhase: () => null, getDayScheduleSummary: () => '' },
      './psycheStateService': {},
      './environment': { isCapacitorNative: () => native },
      './ambientWeatherDirect': { fetchHistoricalWeatherDirect: async date => { weatherDates.push(date); return { success: weatherAvailable, weather: 'YESTERDAY_WEATHER' }; } },
    }, {
      crypto: { randomUUID: () => 'test-diary-id' },
      window: native ? {} : { electronAPI: { invoke: async (channel, date) => {
        assert.equal(channel, 'app:get-historical-weather'); weatherDates.push(date);
        return { success: weatherAvailable, weather: 'YESTERDAY_WEATHER' };
      } } },
    });
    const diary = await service.generateDailyDiary('2026-09-11', [], undefined, undefined, holiday, false);
    assert.ok(diary, 'production diary service completes with isolated boundaries');
    assert.deepEqual(weatherDates, ['2026-09-11']);
    assert.match(prompts[0], /YESTERDAY_FRAGMENT/);
    if (weatherAvailable) {
      assert.match(prompts[0], /YESTERDAY_WEATHER/);
      assert.match(prompts[0], /是否节假日：是/);
      assert.match(prompts[0], /今天是日本法定节假日/);
    } else {
      assert.match(prompts[0], /天气：天气不详/);
      assert.match(prompts[0], /是否节假日：未知/);
      const dailyContext = prompts[0].split('【你今天的作息时间线】')[1].split('【今天记录到的生活切片')[0];
      assert.match(dailyContext, /节假日状态未知/);
      assert.doesNotMatch(dailyContext, /普通工作日|今日日程|今日详细课表|今日镜头重点/);
    }
  }
}

(async () => {
  await testCalendar();
  await testHook();
  await testHistoricalWeatherIntegration();
  console.log('diary settlement F05 tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
