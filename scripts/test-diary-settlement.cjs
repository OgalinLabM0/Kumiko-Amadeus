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
      if (id === './taskModelRouter') return taskModelRouter;
      if (id === './memoryMaintenanceGate') return { getMemoryGeneration: () => 'initial', assertMemoryAvailable() {}, async assertMemoryGenerationCurrent() {} };
      if (id === './taskRuntime') return { TaskCapacityError: class TaskCapacityError extends Error {} };
      if (id === './roleProfiles') return { resolveModelSessionCredential: value => value };
      if (id === '../services/dataRestoreGate') return { isDataRestoreBlocked: () => false };
      if (id === '../services/memoryMaintenanceGate') return { isMemoryMaintenanceBlocked: () => false };
      throw new Error(`Unexpected dependency ${id} in ${relativePath}`);
    },
    ...globals,
  }, { filename });
  return module.exports;
}

const taskModelRouter = load('services/taskModelRouter.ts', {
  './appConfig': load('services/appConfig.ts'),
});

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
    '../services/diaryGenerationJobs': { enqueueDailyDiary: async (...args) => { calls.push(args); await behavior(); } },
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
        deleted.push(diary.date); fragments.delete(diary.date);
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
      cleanup = effects[2]();
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
  const yesterday = { role: 'user', text: 'yesterday', timestamp: timestamp('2026-09-11T21:00:00') };
  const h = createHookHarness(); h.render([yesterday]); await h.tick();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], '2026-09-11');
  assert.equal(h.ambientCalls, 0, 'enqueue does not fetch weather on foreground');
  assert.deepEqual(h.deleted, []); assert.deepEqual(h.embedded, []);
  assert.ok(h.fragments.has('2026-09-11'), 'enqueue retains unsettled fragments');
  const race = createHookHarness(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  race.setBehavior(() => gate); race.render([yesterday]); const first = race.tick();
  for (let i = 0; i < 30 && !race.calls.length; i++) await Promise.resolve();
  await race.tick(); race.render([yesterday]); await race.tick();
  assert.equal(race.calls.length, 1, 'in-flight enqueue is not duplicated');
  release(); await first;
  const retry = createHookHarness(); retry.setBehavior(async () => { throw Error('queue unavailable'); });
  retry.render([yesterday]); await retry.tick(); retry.setBehavior(async () => {}); await retry.tick();
  assert.equal(retry.calls.length, 2, 'enqueue failure permits retry');
  assert.deepEqual(retry.deleted, []);
  const skip = createHookHarness(); skip.setTime('2026-09-12T03:00:00'); skip.render([yesterday]); await skip.tick();
  assert.equal(skip.calls.length, 0);
}

async function testHistoricalWeatherIntegration() {
  for (const weatherAvailable of [true, false]) {
    const weatherDates = [], prompts = [];
    const source = { id:'source', role:'user', text:'hello', timestamp:timestamp('2026-09-11T20:00:00'), isRead:true };
    const fragments = [{ id:'fragment', date:'2026-09-11', content:'YESTERDAY_FRAGMENT', timestamp:source.timestamp }];
    const db = {
      messages:{ where:()=>({between:()=>({toArray:async()=>[source]})}) },
      dailyFragments:{ where:()=>({equals:()=>({toArray:async()=>fragments})}) },
      kumikoDiary:{where:()=>({below:()=>({reverse:()=>({limit:()=>({toArray:async()=>[]})})}),equals:()=>({toArray:async()=>[]}),above:()=>({first:async()=>undefined})})}, keyval:{get:async()=>undefined},
      transaction:async (...args)=>args.at(-1)(),
    };
    const service = load('services/lifeStreamService.ts', {
      './db': {db, INITIAL_WORLD_CHARACTER_STATUS:{}},
      './geminiService': {getCurrentAIConfig:()=>({}), callLLMRaw:async prompt=>{
        prompts.push(prompt);
        return prompts.length===1 ? '<diary_content>今天聊了天。</diary_content><diary_summary>聊了天</diary_summary><diary_source_ids>["source"]</diary_source_ids>' : '{"approved":true,"sourceIds":["source"]}';
      }},
      './diaryValidatorService':{verifyAgainstHistory:async()=>[]},
      './diaryIndexJobs':{saveDiaryWithIndexJob:async diary=>diary,indexSavedDiary:async()=>({ok:true})},
      './diaryReflection':{createDiaryReflection:async()=>async()=>{}},
      './stateProvenance':{recordStateProvenance:async()=>{}}, './artifactIndexService':{assertSourceRefsCurrent:async()=>{}},
      './taskRuntime':{TaskCapacityError:class extends Error{},beginForegroundActivity:async()=>{},endForegroundActivity:async()=>{},assertTaskModelRevisionsCurrent:async()=>{}},
      './dataRestoreGate':{getDataRestoreVersion:()=> 'fixture',assertDataWritesAllowed(){}},
      './kumikoStateMachine':{getSchoolTermContext:()=>'',getSchoolPrepPhase:()=>null,getDayScheduleSummary:()=>''},
      './psycheStateService':{}, './environment':{isCapacitorNative:()=>false},
      './ambientWeatherDirect':{fetchHistoricalWeatherDirect:async date=>{weatherDates.push(date);return {success:weatherAvailable,weather:'YESTERDAY_WEATHER'}}},
    }, {crypto:{randomUUID:()=> 'fixture'}, window:{}, TextEncoder});
    const diary = await service.generateDailyDiary('2026-09-11', [], undefined, undefined, true, false);
    assert.ok(diary); assert.deepEqual(weatherDates,['2026-09-11']); assert.match(prompts[0],/YESTERDAY_FRAGMENT/);
    if(weatherAvailable) assert.match(prompts[0],/YESTERDAY_WEATHER/); else assert.match(prompts[0],/天气：天气不详/);
  }
}

(async () => {
  await testCalendar();
  await testHook();
  await testHistoricalWeatherIntegration();
  console.log('diary settlement F05 tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
