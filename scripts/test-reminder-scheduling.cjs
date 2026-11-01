#!/usr/bin/env node
'use strict';

// Run the production helper and React hook with isolated clock/store/native
// boundaries. Both device timezones run in separate Node processes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const quiet = { log() {}, warn() {}, error() {} };

if (!process.argv.includes('--zone')) {
  for (const TZ of ['Asia/Shanghai', 'America/New_York']) {
    const result = spawnSync(process.execPath, [__filename, '--zone'], {
      env: { ...process.env, TZ }, encoding: 'utf8',
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    assert.equal(result.status, 0, `${TZ} failed`);
  }
  process.exit(0);
}

function load(relativePath, dependencies = {}, globals = {}) {
  const filename = path.join(root, relativePath);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console: quiet, Date, Intl,
    require(id) {
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      throw new Error(`Unexpected dependency ${id} in ${relativePath}`);
    },
    ...globals,
  }, { filename });
  return module.exports;
}

// Use the existing production timezone reader, with only its unrelated
// backup/storage imports mocked. No timezone calculation is copied here.
const backup = load('components/app/backupHelpers.ts', {
  '../../services/db': {},
    '../../services/reminderTime': load('services/reminderTime.ts'),
  '../../store/slices/reminderSlice': {},
  './appConstants': {},
});
const timing = load('components/app/reminderScheduling.ts', { './backupHelpers': backup });
const daily = (overrides = {}) => ({
  id: 'daily', event: 'practice', hour: 16, minute: 0,
  timeZone: 'Asia/Tokyo', createdAt: 1, ...overrides,
});
const relative = (dueAt, overrides = {}) => ({ id: 'relative', event: 'water', createdAt: 1, dueAt, ...overrides });
const at = Date.parse;

function expectNext(now, expected, overrides = {}) {
  const actual = timing.getNextDailyReminderAt(daily(overrides), at(now));
  assert.equal(actual, at(expected), `${now}: ${JSON.stringify(overrides)}`);
}

function harness(start, initialRelative = [], initialDaily = []) {
  let now = start;
  let relatives = initialRelative;
  let dailies = initialDaily;
  let listener;
  let scheduledResult = () => true;
  const effects = [];
  const intervals = [];
  const schedules = [];
  const cancels = [];
  const delivered = [];
  const prewarmed = [];
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const hook = load('components/app/useScheduledReminders.ts', {
    react: {
      useRef: value => ({ current: value }),
      useCallback: fn => fn,
      useEffect: fn => effects.push(fn),
    },
    './chatActions': {
      triggerTimedReminderMessage: async (_refs, _helpers, row, id) => { delivered.push(id); return true; },
      prewarmTimedReminderMessage: async (_refs, _helpers, row) => { prewarmed.push(row.id); },
    },
    '../../services/reminderPrewarmService': {
      shouldKickReminderPrewarm: () => false,
      readReminderPrewarm: () => null,
      cancelReminderPrewarm: () => {},
    },
    './backupHelpers': backup,
    './reminderScheduling': timing,
    '../../services/environment': { isCapacitorNative: () => true, getCapacitorPlatform: () => 'android' },
    '../../services/androidAlarmService': {
      scheduleAndroidAlarm: async input => {
        schedules.push({ ...input });
        return { scheduled: scheduledResult(input), exact: true };
      },
      cancelAndroidAlarm: async id => { cancels.push(id); return true; },
      addAlarmFiredListener: async fn => { listener = fn; return () => {}; },
    },
    '../../services/voiceFileService': { ensureNativeRingtoneForAlarm: async () => {} },
    '../../store': {},
  }, {
    Date: Clock,
    document: { visibilityState: 'hidden', addEventListener() {}, removeEventListener() {} },
    setInterval: (fn, period) => { intervals.push({ fn, period }); return intervals.length; },
    clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
  });
  hook.useScheduledReminders({
    flowState: 'APP', isTalking: false, isThinking: false,
    messagesRef: { current: [] }, ttsConfigRef: { current: { voiceMode: 'text' } },
    runVoicePipeline: async () => {},
    getRelativeReminders: () => relatives, getDailyReminders: () => dailies,
    removeRelativeReminder: async id => { relatives = relatives.filter(row => row.id !== id); },
    markRelativeReminderRetry: async () => {},
    markDailyReminderTriggered: async (id, date) => {
      dailies = dailies.map(row => row.id === id ? { ...row, lastTriggeredDate: date } : row);
    },
    markDailyReminderRetry: async () => {}, language: 'en', locationConfig: {},
    addMessage: () => '', showBackgroundMessageNotification() {},
  });
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
  return {
    schedules, cancels, delivered, prewarmed,
    mount: async () => { effects.forEach(fn => fn()); await settle(); },
    sync: async () => { intervals.find(item => item.period === 30_000).fn(); await settle(); },
    wake: async id => { await listener({ reminderId: id }); await settle(); },
    setNow: value => { now = value; },
    setRelative: value => { relatives = value; },
    setDaily: value => { dailies = value; },
    setScheduleResult: fn => { scheduledResult = fn; },
    getDaily: () => dailies,
  };
}

async function main() {
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, process.env.TZ);
  expectNext('2026-10-03T06:00:00Z', '2026-10-03T07:00:00Z');
  expectNext('2026-10-03T07:00:00Z', '2026-10-04T07:00:00Z');
  expectNext('2026-10-03T14:59:59Z', '2026-10-03T15:00:00Z', { hour: 0 });
  expectNext('2026-12-31T15:00:00Z', '2027-01-01T15:00:00Z', { hour: 0 });
  expectNext('2026-10-03T06:00:00Z', '2026-10-04T07:00:00Z', { lastTriggeredDate: '2026-10-03' });
  expectNext('2026-10-03T06:00:00Z', '2026-10-03T10:15:00Z', { timeZone: 'Asia/Kathmandu' });
  // New York spring transition: the valid 03:30 minute changes offset;
  // nonexistent 02:30 has no native target until the next local day.
  expectNext('2026-03-08T05:00:00Z', '2026-03-08T07:30:00Z', { timeZone: 'America/New_York', hour: 3, minute: 30 });
  expectNext('2026-03-08T05:00:00Z', '2026-03-09T06:30:00Z', { timeZone: 'America/New_York', hour: 2, minute: 30 });
  expectNext('2026-03-07T09:00:00Z', '2026-03-08T07:30:00Z', { timeZone: 'America/New_York', hour: 3, minute: 30 });
  // Fall transition: choose the earliest future occurrence, but never a
  // second send on a local date already marked successful.
  expectNext('2026-11-01T04:00:00Z', '2026-11-01T05:30:00Z', { timeZone: 'America/New_York', hour: 1, minute: 30 });
  expectNext('2026-11-01T05:45:00Z', '2026-11-01T06:30:00Z', { timeZone: 'America/New_York', hour: 1, minute: 30 });
  expectNext('2026-11-01T05:45:00Z', '2026-11-02T06:30:00Z', {
    timeZone: 'America/New_York', hour: 1, minute: 30, lastTriggeredDate: '2026-11-01',
  });
  for (const invalid of [{ hour: 24 }, { minute: -1 }, { minute: NaN }, { hour: 1.5 }, { timeZone: 'Not/AZone' }]) {
    assert.equal(timing.getNextDailyReminderAt(daily(invalid), at('2026-10-03T06:00:00Z')), null);
  }

  const start = at('2026-10-03T06:58:25Z');
  const due = start + 95_000;
  const h = harness(start, [relative(due)], [daily()]);
  await h.mount();
  assert.equal(h.schedules.find(row => row.reminderId === 'daily-daily').at, at('2026-10-03T07:00:00Z'));
  assert.equal(h.schedules.find(row => row.reminderId === 'relative__prewarm').at, start + 35_000);
  h.setNow(start + 30_000);
  await h.sync();
  assert.ok(!h.cancels.includes('relative__prewarm'), 'T-5s existing prewarm is retained');
  h.setNow(start + 40_000);
  await h.sync();
  assert.ok(!h.cancels.includes('relative__prewarm'), 'delayed native prewarm remains valid before main due');
  assert.equal(h.schedules.filter(row => row.reminderId === 'relative__prewarm').length, 1, 'past prewarm is not rebuilt');
  await h.wake('relative__prewarm');
  assert.deepEqual(h.prewarmed, ['relative']);
  h.setNow(due);
  await h.wake('relative');
  await h.wake('daily-daily');
  assert.deepEqual(h.delivered, ['relative', 'daily']);
  assert.equal(h.getDaily()[0].lastTriggeredDate, '2026-10-03');
  await h.sync();
  assert.ok(h.cancels.includes('relative') && h.cancels.includes('relative__prewarm'), 'sent one-shot alarms are cancelled');
  assert.equal(h.schedules.filter(row => row.reminderId === 'daily-daily').at(-1).at, at('2026-10-04T07:00:00Z'));
  h.setDaily([daily({ paused: true })]);
  await h.sync();
  assert.ok(h.cancels.includes('daily-daily'), 'disabled daily alarm is cancelled');

  const deleted = harness(start, [relative(due)]);
  await deleted.mount();
  deleted.setRelative([]);
  await deleted.sync();
  assert.deepEqual(deleted.cancels.sort(), ['relative', 'relative__prewarm']);

  const changed = harness(start, [relative(due)]);
  await changed.mount();
  changed.setRelative([relative(start + 50_000)]);
  await changed.sync();
  assert.ok(changed.cancels.includes('relative__prewarm'), 'changed deadline does not retain old prewarm');
  assert.equal(changed.schedules.filter(row => row.reminderId === 'relative__prewarm').length, 1);

  const expired = harness(start, [relative(due)]);
  await expired.mount();
  expired.setNow(due + 1);
  await expired.sync();
  assert.deepEqual(expired.cancels.sort(), ['relative', 'relative__prewarm']);

  const invalid = harness(start, [relative(Infinity)], [daily({ id: 'invalid', timeZone: 'Invalid' }), daily()]);
  await invalid.mount();
  assert.deepEqual(invalid.schedules.map(row => row.reminderId), ['daily-daily'], 'invalid rows do not suppress valid rows');
  invalid.setDaily([daily({ minute: Infinity })]);
  await invalid.sync();
  assert.deepEqual(invalid.cancels, ['daily-daily']);

  const failed = harness(start, [relative(due)]);
  failed.setScheduleResult(input => !input.reminderId.endsWith('__prewarm'));
  await failed.mount();
  failed.setNow(start + 30_000);
  await failed.sync();
  assert.equal(failed.schedules.filter(row => row.reminderId === 'relative__prewarm').length, 1, 'failed prewarm is not recreated too late');
  assert.ok(!failed.cancels.includes('relative__prewarm'), 'unscheduled prewarm is not treated as native pending');
  console.log(`reminder F13/F14 production helper + hook regressions passed (${process.env.TZ})`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
