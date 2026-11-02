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

function harness(start, initialRelative = [], initialDaily = [], restoreRace = null) {
  let now = start, listener, queue = Promise.resolve();
  const effects = [], intervals = [], schedules = [], cancels = [], delivered = [], prewarmed = [];
  const rows = new Map();
  const relKey = 'kumiko_relative_reminders', dayKey = 'kumiko_daily_reminders';
  rows.set(relKey, structuredClone(initialRelative));
  rows.set(dayKey, structuredClone(initialDaily.map(r => r.createdAt === 1 ? {...r, createdAt: start - 3_600_000} : r)));
  const db = {
    keyval: {
      get: async key => rows.has(key) ? {key, value: structuredClone(rows.get(key))} : undefined,
      put: async ({key, value}) => rows.set(key, structuredClone(value)),
    },
    messages: { put: async message => rows.set('message:' + message.id, structuredClone(message)) },
    transaction(_mode, ...args) {
      const run = args.at(-1), result = queue.then(run);
      queue = result.catch(() => {}); return result;
    },
    getVal: async (key, fallback) => structuredClone(rows.get(key) ?? fallback),
  };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const sliceKeys = { RELATIVE_REMINDER_STORAGE_KEY: relKey, DAILY_REMINDER_STORAGE_KEY: dayKey,
    KUMIKO_MISSED_REMINDERS_STORAGE_KEY: 'kumiko_missed_reminders' };
  const occurrence = load('services/reminderOccurrences.ts', {
    './db': {db}, '../store/slices/reminderSlice': sliceKeys,
  }, { Date: Clock, Math, JSON });
  const state = {
    setRelativeReminders: value => rows.set(relKey, structuredClone(value)),
    setDailyReminders: value => rows.set(dayKey, structuredClone(value)),
    setMissedReminders: () => {}, setMessageAlerts: () => {}, setSystemNotice: () => {},
  };
  const hook = load('components/app/useScheduledReminders.ts', {
    react: { useRef: value => ({current: value}), useCallback: fn => fn, useEffect: fn => effects.push(fn) },
    './chatActions': {
      triggerTimedReminderMessage: async (_refs, _helpers, row, _id, guard) => {
        if (!await guard.begin()) return false;
        const ok = await guard.commit({id: guard.messageId, role: 'model', text: row.event, timestamp: now});
        if (ok) delivered.push(row.id); return ok;
      },
      prewarmTimedReminderMessage: async (_refs, _helpers, row) => { prewarmed.push(row.id); },
    },
    '../../services/reminderPrewarmService': { shouldKickReminderPrewarm: () => false, readReminderPrewarm: () => null, cancelReminderPrewarm: () => {} },
    './backupHelpers': backup, './reminderScheduling': timing,
    '../../services/environment': { isCapacitorNative: () => true, getCapacitorPlatform: () => 'android' },
    '../../services/androidAlarmService': {
      scheduleAndroidAlarm: async input => { schedules.push({...input}); return {scheduled:true, exact:true}; },
      cancelAndroidAlarm: async id => { cancels.push(id); return true; },
      listScheduledAndroidAlarms: async () => [],
      addAlarmFiredListener: async fn => { listener = fn; return () => {}; },
    },
    '../../services/voiceFileService': { ensureNativeRingtoneForAlarm: async () => {} },
    '../../store': { useAppStore: { getState: () => state } },
    '../../services/db': {db}, '../../store/slices/reminderSlice': sliceKeys,
    '../../services/dataRestoreGate': { isDataRestoreBlocked: () => !!restoreRace?.blocked, getDataRestoreVersion: () => restoreRace?.version || '' },
    '../../services/reminderOccurrences': occurrence,
    '../../services/reminderNativeCancellation': { drainReminderNativeCancellationsLocked: async () => {}, withReminderNativeAlarmLock: async fn => fn(), REMINDER_NATIVE_CANCEL_KEY: 'native_cancel' },
  }, {
    Date: Clock, document: {visibilityState:'hidden', addEventListener(){}, removeEventListener(){}},
    setInterval: (fn, period) => { intervals.push({fn,period}); return intervals.length; },
    clearInterval(){}, setTimeout: () => 1, clearTimeout(){},
  });
  hook.useScheduledReminders({
    flowState:'APP', isTalking:false, isThinking:false, messagesRef:{current:[]}, ttsConfigRef:{current:{voiceMode:'text'}},
    runVoicePipeline:async()=>{}, getRelativeReminders:()=>rows.get(relKey), getDailyReminders:()=>{
      if (restoreRace?.changeOnRead) { restoreRace.version = 'restored'; restoreRace.changeOnRead = false; }
      return rows.get(dayKey);
    },
    removeRelativeReminder:async()=>{}, markRelativeReminderRetry:async()=>{}, markDailyReminderTriggered:async()=>{},
    markDailyReminderRetry:async()=>{}, language:'en', locationConfig:{}, addMessage:()=>'', showBackgroundMessageNotification(){},
  });
  const settle = async () => { for (let i=0;i<4;i++) await new Promise(resolve=>setImmediate(resolve)); };
  return {
    schedules,cancels,delivered,prewarmed,rows,
    mount:async()=>{ effects.forEach(fn=>fn()); await settle(); },
    sync:async()=>{ intervals.find(x=>x.period===30_000).fn(); await settle(); },
    wake:async id=>{ await listener({reminderId:id}); await settle(); },
    setNow:value=>{now=value;}, setRelative:value=>rows.set(relKey,structuredClone(value)),
    setDaily:value=>rows.set(dayKey,structuredClone(value)), getDaily:()=>rows.get(dayKey),
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
  assert.ok(!h.schedules.some(row => row.reminderId.endsWith('__prewarm')), 'versionless prewarm is disabled');
  await h.wake('relative__prewarm');
  assert.deepEqual(h.prewarmed, []);
  h.setNow(due); await h.wake('relative'); await h.wake('daily-daily');
  assert.deepEqual(h.delivered, ['relative', 'daily']);
  assert.equal(h.getDaily()[0].lastTriggeredDate, '2026-10-03');
  await h.wake('daily-daily'); assert.equal(h.delivered.length, 2, 'occurrence delivered only once');
  await h.sync();
  assert.ok(h.cancels.includes('relative'));
  assert.equal(h.schedules.filter(row => row.reminderId === 'daily-daily').at(-1).at, at('2026-10-04T07:00:00Z'));
  h.setDaily([daily({paused:true})]); await h.sync(); assert.ok(h.cancels.includes('daily-daily'));

  const late = harness(start, [relative(start - 29*60_000)]); await late.mount(); await late.wake('relative');
  assert.deepEqual(late.delivered, ['relative'], 'ordinary reminder within 30 minutes is delivered');
  const missed = harness(start, [relative(start - 31*60_000)]); await missed.mount(); await missed.wake('relative');
  assert.deepEqual(missed.delivered, []); assert.equal(missed.rows.get('kumiko_missed_reminders').length, 1);
  const wakeMissed = harness(start, [relative(start - 11*60_000, {sourceText:'叫醒我'})]); await wakeMissed.mount(); await wakeMissed.wake('relative');
  assert.deepEqual(wakeMissed.delivered, []); assert.equal(wakeMissed.rows.get('kumiko_missed_reminders').length, 1);
  const dailyLate = harness(at('2026-10-03T07:06:00Z'), [], [daily({createdAt:at('2026-10-03T06:00:00Z')})]);
  await dailyLate.mount(); await dailyLate.wake('daily-daily'); assert.deepEqual(dailyLate.delivered, ['daily']);
  const oldDaily = harness(at('2026-10-03T07:06:00Z'), [], [daily({createdAt:at('2025-01-01T00:00:00Z')})]);
  await oldDaily.mount(); await oldDaily.wake('daily-daily'); await oldDaily.wake('daily-daily');
  assert.deepEqual(oldDaily.delivered, ['daily'], 'only the latest due daily occurrence is handled');
  const history = oldDaily.rows.get('kumiko_missed_reminders');
  assert.equal(history.length, 1, 'older missed occurrences are summarized once');
  assert.equal(history[0].count, 640);
  assert.equal(history[0].timeZone, 'Asia/Tokyo');
  assert.equal(history[0].firstDueAt, at('2025-01-01T07:00:00Z'));
  assert.equal(history[0].lastDueAt, at('2026-10-02T07:00:00Z'));
  const dstRange = timing.getDueDailyReminderRange(daily({ timeZone:'America/New_York', hour:2, minute:30,
    createdAt: at('2026-03-07T00:00:00Z') }), at('2026-03-09T12:00:00Z'));
  assert.equal(dstRange.count, 2, 'the nonexistent spring-forward minute does not create an occurrence');
  const fallRange = timing.getDueDailyReminderRange(daily({ timeZone:'America/New_York', hour:1, minute:30,
    createdAt: at('2026-10-31T00:00:00Z') }), at('2026-11-02T12:00:00Z'));
  assert.equal(fallRange.count, 3, 'a repeated wall minute counts once on the fall-back day');
  const resumed = harness(at('2026-10-03T07:06:00Z'), [], [daily({createdAt:at('2025-01-01T00:00:00Z'), activeSince:at('2026-10-03T07:05:00Z')})]);
  await resumed.mount(); await resumed.wake('daily-daily');
  assert.deepEqual(resumed.delivered, [], 'paused dates are not replayed after resuming');
  assert.equal(resumed.rows.get('kumiko_missed_reminders'), undefined);
  const paused = harness(start, [relative(due, {paused:true})]); await paused.mount();
  assert.ok(!paused.schedules.some(row => row.reminderId === 'relative'));
  const restoreRace = { version:'before', changeOnRead:true };
  const racing = harness(start, [relative(due)], [daily()], restoreRace); await racing.mount();
  assert.deepEqual(racing.schedules, [], 'restore generation change stops stale native scheduling even after gate clears');
  console.log(`reminder production helper + occurrence + hook regressions passed (${process.env.TZ})`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
