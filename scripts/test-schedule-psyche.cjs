#!/usr/bin/env node
'use strict';

// Execute production TypeScript with an isolated clock and serial in-memory
// database. No model, private data, network, or application install is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const HOUR = 3_600_000;
const instant = value => Date.parse(`${value}+09:00`);

function load(file, deps = {}, DateClass = Date) {
  const filename = path.join(root, file);
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, Date: DateClass, Intl, console,
    require(id) {
      if (id in deps) return deps[id];
      throw new Error(`Unexpected dependency ${id}`);
    },
  }, { filename });
  return module.exports;
}

const schedule = load('services/kumikoStateMachine.ts');
const slot = (date, holiday = false) => schedule.getDetailedScheduleSlot('Asia/Tokyo', holiday, new Date(instant(date)));
const state = (date, holiday = false) => schedule.getCurrentKumikoState('Asia/Tokyo', holiday, new Date(instant(date)));

function harness(start, seed = {}) {
  let now = start;
  let row = { id: 'current', stress: 30, energy: 80, relaxation: 50, lastUpdated: start, ...seed };
  let transactionQueue = Promise.resolve();
  const db = {
    psycheState: {
      get: async () => row && structuredClone(row),
      put: async value => { row = structuredClone(value); },
    },
    transaction: (_mode, _table, fn) => {
      const task = transactionQueue.then(fn);
      transactionQueue = task.catch(() => {});
      return task;
    },
  };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const api = load('services/psycheStateService.ts', { './db': { db }, './kumikoStateMachine': schedule }, Clock);
  return { api, setTime: value => { now = value; }, get: () => row };
}

function close(actual, expected, label) {
  for (const key of ['stress', 'energy', 'relaxation']) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-8, `${label}: ${key} ${actual[key]} != ${expected[key]}`);
  }
}

async function main() {
  assert.equal(slot('2026-09-14T09:30:00').slotType, 'teaching');
  assert.equal(slot('2026-09-14T09:40:00').slotType, 'free');
  assert.equal(slot('2026-09-14T09:50:00').slotType, 'teaching');
  assert.equal(state('2026-09-14T09:40:00').currentState, 'TEACHING');
  assert.equal(state('2026-09-14T09:40:00').voicePolicy, 'discourage');
  // Every school minute, including all short gaps, remains at school.
  for (let minute = 7 * 60 + 50; minute < 18 * 60 + 30; minute++) {
    const at = new Date(instant('2026-09-14T00:00:00') + minute * 60_000);
    assert.ok(['TEACHING', 'CLUB_ACTIVITIES'].includes(schedule.getCurrentKumikoState('Asia/Tokyo', false, at).currentState));
  }
  for (const date of ['2026-04-01', '2026-04-06', '2026-04-08', '2026-04-09', '2026-09-01', '2027-01-11']) {
    assert.equal(slot(`${date}T09:00:00`).slotType, 'school_prep', date);
    assert.equal(state(`${date}T09:00:00`).currentState, 'TEACHING', date);
    assert.equal(state(`${date}T09:00:00`, true).currentState, 'OUTING', `${date} holiday overrides prep`);
  }
  assert.equal(state('2026-04-04T09:00:00').currentState, 'OUTING', 'weekend overrides prep');
  assert.equal(state('2026-09-14T00:30:00').currentState, 'SLEEPING');
  assert.equal(state('2026-09-14T06:00:00').currentState, 'COMMUTING');
  assert.equal(state('2026-09-14T18:30:00').currentState, 'COMMUTING');
  assert.equal(state('2026-09-14T19:30:00').currentState, 'RELAXING_HOME');
  // Historical input must win over the real clock and the host timezone.
  assert.equal(schedule.getScheduleClock('Asia/Tokyo', new Date('2026-09-13T15:00:00Z')).dateStr, '2026-09-14');
  for (const date of ['2025-09-15T09:00:00', '2026-01-13T09:00:00']) {
    assert.equal(slot(date).slotType, 'teaching', 'historical curricula before BASE_YEAR are safe');
    assert.ok(!slot(date).description.includes('undefined'));
  }

  const start = instant('2026-09-13T21:00:00');
  const end = instant('2026-09-14T09:00:00');
  const whole = harness(start);
  whole.setTime(end);
  const overnight = await whole.api.updatePsycheState(12 * HOUR, 'Asia/Tokyo', false, '');
  assert.ok(overnight.energy > 80 && overnight.stress < 20, 'sleep restores energy and lowers stress overnight');
  const repeated = await whole.api.updatePsycheState(12 * HOUR, 'Asia/Tokyo', false, '');
  close(repeated, overnight, 'same interval cannot settle twice');
  assert.equal(repeated.lastDriftAt, end);
  const shorterGap = harness(start, { lastDriftAt: start });
  shorterGap.setTime(end);
  close(await shorterGap.api.updatePsycheState(3 * HOUR, 'Asia/Tokyo', false, ''), overnight, 'saved drift cursor wins over a newer last-message gap');
  const legacyGap = harness(end);
  close(await legacyGap.api.updatePsycheState(12 * HOUR, 'Asia/Tokyo', false, ''), { stress: 30, energy: 80, relaxation: 50 }, 'valid legacy timestamp must not move backward to an earlier message gap');
  const missingCursor = harness(start, { lastUpdated: NaN }); missingCursor.setTime(end);
  close(await missingCursor.api.updatePsycheState(12 * HOUR, 'Asia/Tokyo', false, ''), overnight, 'message gap is used only when both saved cursors are unavailable');

  const incremental = harness(start);
  for (let time = start + 17 * 60_000; time < end; time += 17 * 60_000) {
    incremental.setTime(time);
    await incremental.api.updatePsycheState(time - start, 'Asia/Tokyo', false, '');
  }
  incremental.setTime(end);
  close(await incremental.api.updatePsycheState(12 * HOUR, 'Asia/Tokyo', false, ''), overnight, 'different polling intervals agree');

  const rainy = harness(start);
  rainy.setTime(end);
  close(await rainy.api.updatePsycheState(12 * HOUR, 'Asia/Tokyo', false, '- 久美子所在地 (日本宇治市) 当前天气: 雨, 温度 22°C'), overnight, 'current rain is not retroactive overnight weather');

  const crossDate = harness(instant('2026-09-14T08:45:00'));
  crossDate.setTime(instant('2026-09-15T00:00:00'));
  const holiday = await crossDate.api.updatePsycheState(15.25 * HOUR, 'Asia/Tokyo', true, '');
  const regular = harness(instant('2026-09-14T08:45:00'));
  regular.setTime(instant('2026-09-15T00:00:00'));
  close(holiday, await regular.api.updatePsycheState(15.25 * HOUR, 'Asia/Tokyo', false, ''), 'today holiday does not override yesterday');

  const concurrent = harness(start);
  concurrent.setTime(end);
  const [first, second] = await Promise.all([
    concurrent.api.updatePsycheState(12 * HOUR, 'Asia/Tokyo', false, ''),
    concurrent.api.updatePsycheState(12 * HOUR, 'Asia/Tokyo', false, ''),
  ]);
  close(first, second, 'concurrent settlement is serialized');
  concurrent.setTime(end + HOUR);
  await concurrent.api.applyPsycheDelta(5, 0, 0);
  assert.equal(concurrent.get().lastDriftAt, end + HOUR, 'chat settles physical time before adding its new delta');
  const direction = concurrent.get().lastChatDeltaDirection;
  await concurrent.api.updatePsycheState(HOUR, 'Asia/Tokyo', false, '');
  assert.deepEqual(concurrent.get().lastChatDeltaDirection, direction, 'drift preserves chat damping');
  for (const invalid of [0, -1, NaN, Infinity]) {
    const before = structuredClone(concurrent.get());
    await concurrent.api.updatePsycheState(invalid, 'Asia/Tokyo', false, '');
    assert.deepEqual(concurrent.get(), before, 'invalid elapsed time is inert');
  }

  const deltaFirst = harness(start, { lastDriftAt: start }); deltaFirst.setTime(end);
  const deltaLast = harness(start, { lastDriftAt: start }); deltaLast.setTime(end);
  await Promise.all([
    deltaFirst.api.applyPsycheDelta(5, 0, 0),
    deltaFirst.api.updatePsycheState(12 * HOUR, 'Asia/Tokyo', false, ''),
  ]);
  await Promise.all([
    deltaLast.api.updatePsycheState(12 * HOUR, 'Asia/Tokyo', false, ''),
    deltaLast.api.applyPsycheDelta(5, 0, 0),
  ]);
  close(deltaFirst.get(), deltaLast.get(), 'chat/drift concurrency never backdates a new emotional change');
  assert.ok(Math.abs(deltaFirst.get().stress - overnight.stress - 5) < 1e-8);

  const holidayStart = instant('2026-09-14T08:00:00');
  const holidayEnd = instant('2026-09-14T09:00:00');
  const knownHoliday = harness(holidayStart, {
    lastDriftAt: holidayStart,
    driftContext: { timezone: 'Asia/Tokyo', holidayDate: '2026-09-14', isHoliday: true },
  });
  knownHoliday.setTime(holidayEnd);
  await knownHoliday.api.applyPsycheDelta(5, 0, 0);
  const explicitHoliday = harness(holidayStart); explicitHoliday.setTime(holidayEnd);
  await explicitHoliday.api.updatePsycheState(HOUR, 'Asia/Tokyo', true, '');
  await explicitHoliday.api.applyPsycheDelta(5, 0, 0);
  close(knownHoliday.get(), explicitHoliday.get(), 'new emotions use the persisted date-bound holiday context');
  const oldHoliday = harness(holidayStart, {
    lastDriftAt: holidayStart,
    driftContext: { timezone: 'Asia/Tokyo', holidayDate: '2026-09-13', isHoliday: true },
  });
  oldHoliday.setTime(holidayEnd); await oldHoliday.api.applyPsycheDelta(5, 0, 0);
  const ordinary = harness(holidayStart); ordinary.setTime(holidayEnd);
  await ordinary.api.updatePsycheState(HOUR, 'Asia/Tokyo', false, '');
  await ordinary.api.applyPsycheDelta(5, 0, 0);
  close(oldHoliday.get(), ordinary.get(), 'previous date holiday cannot leak into a new day');

  const rainyStart = instant('2026-09-14T20:00:00');
  const rainText = '- 久美子所在地 (日本宇治市) 当前天气: 雨, 温度 22°C';
  const rainyWhole = harness(rainyStart); rainyWhole.setTime(rainyStart + 2 * HOUR);
  await rainyWhole.api.updatePsycheState(2 * HOUR, 'Asia/Tokyo', false, rainText);
  const rainySteps = harness(rainyStart);
  for (let time = rainyStart + HOUR; time <= rainyStart + 2 * HOUR; time += HOUR) {
    rainySteps.setTime(time); await rainySteps.api.updatePsycheState(HOUR, 'Asia/Tokyo', false, rainText);
  }
  close(rainyWhole.get(), rainySteps.get(), 'current weather does not make drift depend on polling frequency');

  // Equivalent zone names agree when advancing between schedule boundaries.
  const slow = harness(start); slow.setTime(end);
  close(await slow.api.updatePsycheState(12 * HOUR, 'Etc/GMT-9', false, ''), overnight, 'boundary optimization preserves drift');
  for (const day of ['2026-03-08', '2026-11-01']) {
    const zone = 'America/New_York';
    const dstStart = Date.parse(`${day}T00:00:00${day.includes('03-08') ? '-05:00' : '-04:00'}`);
    const dstEnd = dstStart + 12 * HOUR;
    const dstWhole = harness(dstStart); dstWhole.setTime(dstEnd);
    await dstWhole.api.updatePsycheState(12 * HOUR, zone, false, '');
    const dstSteps = harness(dstStart);
    for (let time = dstStart + 5 * 60_000; time <= dstEnd; time += 5 * 60_000) {
      dstSteps.setTime(time); await dstSteps.api.updatePsycheState(time - dstStart, zone, false, '');
    }
    close(dstWhole.get(), dstSteps.get(), `DST transition ${day} matches five-minute reference`);
  }
  for (const cursor of [NaN, Infinity, -1, end + HOUR, end - 101 * 366 * 24 * HOUR]) {
    const invalidCursor = harness(start, { lastDriftAt: cursor }); invalidCursor.setTime(end);
    const repaired = await invalidCursor.api.updatePsycheState(12 * HOUR, 'Asia/Tokyo', false, '');
    close(repaired, overnight, 'invalid drift cursor falls back to the valid legacy timestamp without walking centuries');
    assert.equal(repaired.lastDriftAt, end);
  }
  const longStart = instant('2025-09-13T21:00:00');
  const long = harness(longStart); long.setTime(end);
  const began = Date.now();
  const longResult = await long.api.updatePsycheState(end - longStart, 'Asia/Tokyo', false, '');
  assert.equal(longResult.lastDriftAt, end);
  assert.ok(Date.now() - began < 10_000, 'one year of history has bounded processing work');
  for (const key of ['stress', 'energy', 'relaxation']) assert.ok(Number.isFinite(longResult[key]));

  const backupHelpers = load('components/app/backupHelpers.ts', {
    '../../services/db': {},
    '../../services/reminderTime': load('services/reminderTime.ts'),
    '../../store/slices/reminderSlice': {},
    './appConstants': {},
  });
  const restored = backupHelpers.sanitizePsycheStateRecord({
    ...knownHoliday.get(),
    lastChatDeltaDirection: { stress: 5, energy: 0, relaxation: 0 },
    committedResponseEvents: {
      'response-valid': { messageId: 'message-valid', committedAt: end },
      empty: { messageId: '', committedAt: end },
      invalid: { messageId: 'message-invalid', committedAt: NaN },
    },
  });
  assert.equal(JSON.stringify(restored.driftContext), JSON.stringify(knownHoliday.get().driftContext));
  assert.equal(restored.lastDriftAt, holidayEnd);
  assert.equal(JSON.stringify(restored.lastChatDeltaDirection), JSON.stringify({ stress: 5, energy: 0, relaxation: 0 }));
  assert.equal(JSON.stringify(restored.committedResponseEvents), JSON.stringify({ 'response-valid': { messageId: 'message-valid', committedAt: end } }));
  const malformed = backupHelpers.sanitizePsycheStateRecord({
    id: 'current', stress: 30, energy: 80, relaxation: 50, lastUpdated: end,
    driftContext: { timezone: 'Asia/Tokyoo', holidayDate: '2026-09-14', isHoliday: true },
    lastDriftAt: Infinity, lastChatDeltaDirection: { stress: 5, energy: NaN, relaxation: 0 },
  });
  assert.equal(malformed.driftContext, undefined);
  assert.equal(malformed.lastDriftAt, undefined);
  assert.equal(malformed.lastChatDeltaDirection, undefined);
  console.log('schedule / psyche F07-F08 regressions passed; overnight:', JSON.stringify(overnight));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
