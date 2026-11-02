#!/usr/bin/env node
'use strict';

// Execute the production slice with isolated, serializable transactions. No
// real user database, native alarms, network or model calls are available.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
let now = Date.parse('2026-11-01T08:00:00Z');
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
function load(file, dependencies = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: file,
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, Date: Clock, Intl,
    console: { log() {}, warn() {}, error() {} },
    require(id) { assert.ok(Object.hasOwn(dependencies, id), `Unexpected dependency ${id}`); return dependencies[id]; },
  }, { filename: file });
  return module.exports;
}

function harness() {
  let records = new Map();
  let queue = Promise.resolve();
  let active = false;
  let puts = 0;
  let failureAt = Infinity;
  let failCommit = false;
  let beforeCommit;
  const notifications = [];
  const clone = value => structuredClone(value);
  const db = {
    keyval: {
      async get(key) {
        assert.ok(active, 'reads must stay in a transaction');
        return records.has(key) ? { key, value: clone(records.get(key)) } : undefined;
      },
      async put({ key, value }) {
        assert.ok(active, 'writes must stay in a transaction');
        if (++puts === failureAt) throw new Error('simulated write failure');
        records.set(key, clone(value));
      },
    },
    transaction(mode, table, work) {
      assert.equal(mode, 'rw'); assert.equal(table, db.keyval);
      const result = queue.then(async () => {
        const previous = clone(records);
        active = true;
        try {
          const value = await work();
          if (beforeCommit) await beforeCommit();
          if (failCommit) throw new Error('simulated commit failure');
          return value;
        } catch (error) {
          records = previous;
          throw error;
        } finally { active = false; }
      });
      queue = result.catch(() => {});
      return result;
    },
  };
  const slice = load('store/slices/reminderSlice.ts', {
    '../../services/db': { db },
    '../../services/reminderNativeCancellation': { queueReminderNativeCancellation: async () => {}, drainReminderNativeCancellations: async () => {} }, '../../services/reminderTime': load('services/reminderTime.ts'),
    '../../services/preferencesSync': { noteKeyvalPreferenceWrite: (key, value) => notifications.push({ key, value: clone(value) }) },
  });
  function window() {
    const state = { locationConfig: { modelTimezone: 'Asia/Tokyo', userTimezone: 'Asia/Shanghai' } };
    Object.assign(state, slice.createReminderSlice(value => {
      Object.assign(state, typeof value === 'function' ? value(state) : value);
    }, () => state));
    return state;
  }
  return {
    slice, window, notifications,
    rows: key => clone(records.get(key) || []),
    all: () => clone(records),
    failWrite: (offset = 1) => { failureAt = puts + offset; },
    failCommit: value => { failCommit = value; },
    beforeCommit: fn => { beforeCommit = fn; },
    setEpoch: epoch => db.transaction('rw', db.keyval, () => db.keyval.put({ key: 'kumiko_turn_epoch_v1', value: epoch })),
  };
}

async function mutationChecks() {
  const h = harness(); const a = h.window(); const b = h.window();
  const relativeKey = h.slice.RELATIVE_REMINDER_STORAGE_KEY;
  const dailyKey = h.slice.DAILY_REMINDER_STORAGE_KEY;
  const target = row => ({ id: row.id, kind: 'hour' in row ? 'daily' : 'once', expected: structuredClone(row) });
  await a.saveRelativeReminder('water', 60, '', { actionId: 'mutate:once', expectedEpoch: 'initial' });
  await a.saveDailyReminder('practice', 8, 0, '', 'Asia/Shanghai', { actionId: 'mutate:daily', expectedEpoch: 'initial' });
  const once = target(a.relativeReminders[0]);
  const daily = target(a.dailyReminders[0]);
  const replacement = { ...once.expected, event: 'tea', dueAt: now + 120_000 };
  for (const [id, t, next] of [
    ['', once, replacement], ['bad:kind', { ...once, kind: 'bad' }, replacement],
    ['bad:id', { ...once, id: 'other' }, replacement], ['bad:replacement', once, { ...replacement, id: 'other' }],
    ['bad:time', once, { ...replacement, dueAt: NaN }], ['bad:daily', once, { id: once.id, event: 'tea', createdAt: now, hour: 25, minute: 0, timeZone: 'Asia/Tokyo' }],
  ]) assert.equal((await a.applyReminderMutation(id, t, next)).status, 'rejected');
  assert.equal((await a.applyReminderMutation('missing', { ...once, id: 'missing', expected: { ...once.expected, id: 'missing' } })).reason, 'target_not_found');

  // A delayed retry marker is safe to ignore; a user pause/edit is not.
  await b.markRelativeReminderRetry(once.id);
  const notificationsBefore = h.notifications.length;
  h.beforeCommit(() => assert.equal(a.relativeReminders[0].event, 'water'));
  assert.equal((await a.applyReminderMutation('change:once', once, replacement)).status, 'saved');
  h.beforeCommit(null);
  assert.equal(a.relativeReminders[0].event, 'tea');
  assert.equal(a.relativeReminders[0].retryAt, undefined);
  assert.equal(h.notifications.length, notificationsBefore + 2, 'both reminder kinds broadcast after commit');
  assert.equal((await b.applyReminderMutation('change:once', once, replacement)).status, 'existing');
  assert.equal(b.relativeReminders[0].event, 'tea', 'existing receipt refreshes stale window');
  assert.equal((await b.applyReminderMutation('change:once', once, { ...replacement, event: 'coffee' })).reason, 'action_id_conflict');
  assert.equal((await b.applyReminderMutation('cancel:stale', once)).reason, 'target_changed');
  await b.toggleDailyReminderPaused(daily.id);
  assert.equal((await a.applyReminderMutation('cancel:daily-stale', daily)).reason, 'target_changed', 'pause is a user change');

  // Preserve the scheduler's latest daily delivery, even with an older snapshot.
  const latestDaily = target(h.rows(dailyKey)[0]);
  await b.markDailyReminderTriggered(daily.id, '2026-11-01');
  assert.equal((await a.applyReminderMutation('daily:hour', latestDaily, { ...latestDaily.expected, hour: 10 })).status, 'saved');
  assert.equal(h.rows(dailyKey)[0].lastTriggeredDate, '2026-11-01');

  // Conversion writes both lists and its receipt in one transaction.
  const beforeConversion = target(h.rows(relativeKey)[0]);
  const converted = { id: once.id, event: 'tea', createdAt: beforeConversion.expected.createdAt,
    hour: 9, minute: 30, timeZone: 'Asia/Tokyo', sourceText: beforeConversion.expected.sourceText };
  const beforeDisk = h.all(); const beforeMemory = structuredClone({ relative: a.relativeReminders, daily: a.dailyReminders });
  h.failWrite(2);
  assert.equal((await a.applyReminderMutation('convert:daily', beforeConversion, converted)).status, 'failed');
  assert.deepEqual(h.all(), beforeDisk, 'partial list writes and receipt roll back together');
  assert.deepEqual(structuredClone({ relative: a.relativeReminders, daily: a.dailyReminders }), beforeMemory);
  h.failCommit(true);
  assert.equal((await a.applyReminderMutation('convert:daily', beforeConversion, converted)).status, 'failed');
  assert.deepEqual(h.all(), beforeDisk);
  h.failCommit(false);
  assert.equal((await a.applyReminderMutation('convert:daily', beforeConversion, converted)).status, 'saved');
  assert.equal(h.rows(relativeKey).length, 0); assert.equal(h.rows(dailyKey).length, 2);
  assert.equal((await b.applyReminderMutation('convert:daily', beforeConversion, converted)).status, 'existing');
  const convertedTarget = target(h.rows(dailyKey).find(row => row.id === once.id));
  const back = { ...replacement, dueAt: now + 600_000 };
  assert.equal((await b.applyReminderMutation('convert:once', convertedTarget, back)).status, 'saved');
  assert.equal(h.rows(relativeKey).length, 1); assert.equal(h.rows(dailyKey).length, 1);

  // Concurrent edits cannot use the same old expectation to overwrite each other.
  const beforeEdits = target(h.rows(relativeKey)[0]);
  const edits = await Promise.all([
    a.applyReminderMutation('concurrent:a', beforeEdits, { ...back, event: 'first' }),
    b.applyReminderMutation('concurrent:b', beforeEdits, { ...back, event: 'second' }),
  ]);
  assert.deepEqual(edits.map(result => result.status), ['saved', 'rejected']);
  assert.equal(edits[1].reason, 'target_changed');
  assert.equal(h.rows(relativeKey)[0].event, 'first');
  const beforeCancel = target(h.rows(relativeKey)[0]);
  await Promise.all([
    a.applyReminderMutation('cancel:once', beforeCancel),
    b.saveRelativeReminder('other', 30, '', { actionId: 'unrelated:create' }),
  ]);
  assert.deepEqual(h.rows(relativeKey).map(row => row.id), ['unrelated:create']);
  assert.equal((await b.applyReminderMutation('cancel:once', beforeCancel)).status, 'existing');

  // Epoch comparison happens before recognizing old receipts, for all 3 APIs.
  await h.setEpoch('restored:2');
  assert.equal((await a.applyReminderMutation('cancel:once', beforeCancel, undefined, { expectedEpoch: 'initial' })).reason, 'stale_epoch');
  assert.equal((await a.saveRelativeReminder('water', 60, '', { actionId: 'mutate:once', expectedEpoch: 'initial' })).reason, 'stale_epoch');
  assert.equal((await a.saveDailyReminder('practice', 8, 0, '', 'Asia/Shanghai', { actionId: 'mutate:daily', expectedEpoch: 'initial' })).reason, 'stale_epoch');
  assert.equal((await a.saveRelativeReminder('epoch', 30, '', { actionId: 'epoch:relative', expectedEpoch: 'restored:2' })).status, 'saved');
  assert.equal((await a.saveDailyReminder('epoch', 12, 0, '', 'Asia/Shanghai', { actionId: 'epoch:daily', expectedEpoch: 'restored:2' })).status, 'saved');
  const epochTarget = target(h.rows(relativeKey).find(row => row.id === 'epoch:relative'));
  assert.equal((await a.applyReminderMutation('epoch:cancel', epochTarget, undefined, { expectedEpoch: 'restored:2' })).status, 'saved');
  assert.equal((await a.saveRelativeReminder('legacy', 30)).status, 'saved', 'old calls without epoch remain supported');
}

async function latePolicyChecks() {
  const h = harness(); const state = h.window();
  await state.saveDailyReminder('practice', 8, 0, '', 'Asia/Shanghai', { actionId: 'policy' });
  const original = structuredClone(state.dailyReminders[0]);
  h.failCommit(true);
  assert.equal((await state.setReminderLateGrace('daily', 'policy', 0, 60)).status, 'failed');
  assert.deepEqual(structuredClone(state.dailyReminders[0]), original, 'failed write is not shown as saved');
  h.failCommit(false);
  assert.equal((await state.setReminderLateGrace('daily', 'policy', 0, 60)).status, 'saved');
  assert.equal(state.dailyReminders[0].lateGraceMinutes, 60);
  assert.equal(state.dailyReminders[0].version, 1);
  assert.equal((await state.setReminderLateGrace('daily', 'policy', 0, 10)).reason, 'target_changed');
  assert.equal((await state.setReminderLateGrace('daily', 'policy', 1, 7)).reason, 'invalid_policy');
}

async function main() {
  const h = harness();
  const a = h.window(); const b = h.window();
  const relativeKey = h.slice.RELATIVE_REMINDER_STORAGE_KEY;
  const dailyKey = h.slice.DAILY_REMINDER_STORAGE_KEY;
  const missedKey = h.slice.KUMIKO_MISSED_REMINDERS_STORAGE_KEY;
  const relative = (state, id, event = 'water', timing = {}) => state.saveRelativeReminder(event, 60, '一分钟后提醒我喝水', { actionId: id, ...timing });
  const daily = (state, id, event = 'practice', hour = 8) => state.saveDailyReminder(event, hour, 0, '每天8点提醒我练习', 'Asia/Shanghai', { actionId: id });

  // Invalid input must never be clamped into a valid reminder.
  for (const delay of [NaN, Infinity, -Infinity, -1, -0.1, 0]) {
    assert.equal((await a.saveRelativeReminder('water', delay)).status, 'rejected');
  }
  for (const timing of [{ dueAt: NaN }, { dueAt: Infinity }, { dueAt: -1 }, { dueAt: 1e30 }, { referenceAt: NaN }, { referenceAt: -1 }, { actionId: '' }, { actionId: ' ' }]) {
    assert.equal((await a.saveRelativeReminder('water', 60, '', timing)).status, 'rejected');
  }
  for (const [hour, minute] of [[24, 0], [-1, 0], [8.5, 0], [NaN, 0], [8, 60], [8, -1], [8, NaN]]) {
    assert.equal((await a.saveDailyReminder('practice', hour, minute)).status, 'rejected');
  }
  assert.equal((await daily(a, '')).status, 'rejected');
  assert.equal(h.all().size, 0);

  // Failed writes and failed COMMIT both leave memory and disk unchanged.
  h.failWrite();
  assert.equal((await relative(a, 'turn:failure')).status, 'failed');
  assert.equal(a.relativeReminders.length, 0); assert.equal(h.all().size, 0);
  h.failWrite(2); // receipt succeeds, reminder write fails: receipt rolls back too.
  assert.equal((await relative(a, 'turn:failure')).status, 'failed');
  assert.equal(a.relativeReminders.length, 0); assert.equal(h.all().size, 0);
  h.failCommit(true);
  assert.equal((await daily(a, 'turn:daily-failure')).status, 'failed');
  assert.equal(a.dailyReminders.length, 0); assert.equal(h.all().size, 0);
  assert.equal(h.notifications.length, 0, 'failed commits do not broadcast task changes');
  h.failCommit(false);
  h.beforeCommit(() => {
    assert.equal(a.relativeReminders.length, 0, 'not visible before commit');
  });
  assert.equal((await relative(a, 'turn:relative')).status, 'saved');
  assert.equal(h.notifications.length, 1, 'successful commit retains window broadcasts');
  h.beforeCommit(null);

  // Stable IDs survive retries, another window, and removal after delivery.
  now += 10_000;
  assert.equal((await relative(b, 'turn:relative')).status, 'existing', 'relative delay is anchored to the first action, not retry clock');
  assert.equal(b.relativeReminders.length, 1);
  assert.equal((await relative(b, 'turn:relative', 'different')).status, 'rejected');
  assert.equal((await b.saveRelativeReminder('water', 120, '一分钟后提醒我喝水', { actionId: 'turn:relative' })).status, 'rejected');
  assert.equal((await relative(b, 'turn:relative', 'water', { timeZone: 'Asia/Tokyo' })).status, 'rejected');
  assert.equal((await daily(b, 'turn:relative')).status, 'rejected', 'same action cannot change recurrence');
  await b.removeRelativeReminder('turn:relative');
  assert.equal((await relative(a, 'turn:relative')).status, 'existing');
  assert.equal(a.relativeReminders.length, 0); assert.equal(h.rows(relativeKey).length, 0);
  assert.equal((await daily(a, 'turn:daily')).status, 'saved');
  assert.equal((await daily(b, 'turn:daily')).status, 'existing');
  assert.equal((await daily(b, 'turn:daily', 'practice', 9)).status, 'rejected');
  await b.removeDailyReminder('turn:daily');
  assert.equal((await daily(a, 'turn:daily')).status, 'existing');
  assert.equal(h.rows(dailyKey).length, 0);

  const sameAction = await Promise.all([relative(a, 'turn:same'), relative(b, 'turn:same')]);
  assert.deepEqual(sameAction.map(result => result.status).sort(), ['existing', 'saved']);
  assert.equal(h.rows(relativeKey).length, 1, 'concurrent claim creates exactly one task');
  await a.removeRelativeReminder('turn:same');

  // Two windows start stale. Every mutation must merge from committed rows.
  const made = await Promise.all([relative(a, 'turn:a'), relative(b, 'turn:b')]);
  assert.ok(made.every(result => result.status === 'saved'));
  assert.equal(h.rows(relativeKey).length, 2);
  await Promise.all([a.markRelativeReminderRetry('turn:a'), b.removeRelativeReminder('turn:b')]);
  assert.deepEqual(h.rows(relativeKey).map(row => row.id), ['turn:a']);
  assert.equal(h.rows(relativeKey)[0].retryAt, now + 30_000);
  await Promise.all([daily(a, 'daily:a'), daily(b, 'daily:b')]);
  await Promise.all([a.toggleDailyReminderPaused('daily:a'), b.markDailyReminderTriggered('daily:b', '2026-11-01')]);
  let stored = h.rows(dailyKey);
  assert.equal(stored.length, 2);
  assert.equal(stored.find(row => row.id === 'daily:a').paused, true);
  assert.equal(stored.find(row => row.id === 'daily:b').lastTriggeredDate, '2026-11-01');
  await Promise.all([a.markDailyReminderRetry('daily:a'), b.markDailyReminderRetry('daily:b')]);
  assert.ok(h.rows(dailyKey).every(row => row.retryAt === now + 30_000));
  await Promise.all([a.toggleDailyReminderPaused('daily:a'), b.markDailyReminderTriggered('daily:b', '2026-11-02')]);
  stored = h.rows(dailyKey);
  assert.ok(stored.every(row => row.retryAt === undefined));
  assert.equal(stored.find(row => row.id === 'daily:a').paused, false);
  assert.equal(stored.find(row => row.id === 'daily:a').activeSince, now, 'resuming starts a new active period');
  assert.equal(stored.find(row => row.id === 'daily:b').lastTriggeredDate, '2026-11-02');
  await Promise.all([relative(a, 'turn:c'), b.removeRelativeReminder('turn:a')]);
  assert.deepEqual(h.rows(relativeKey).map(row => row.id), ['turn:c']);
  await Promise.all([daily(a, 'daily:c'), b.removeDailyReminder('daily:a')]);
  assert.deepEqual(h.rows(dailyKey).map(row => row.id).sort(), ['daily:b', 'daily:c']);

  // Mutations and all full replacements retain memory on storage failure.
  const before = structuredClone(a.dailyReminders);
  h.failCommit(true);
  await assert.rejects(a.toggleDailyReminderPaused('daily:b'));
  assert.deepEqual(structuredClone(a.dailyReminders), before);
  for (const [method, field] of [['persistRelativeReminders', 'relativeReminders'], ['persistDailyReminders', 'dailyReminders'], ['persistMissedReminders', 'missedReminders']]) {
    const original = a[field];
    await assert.rejects(a[method]([]));
    assert.equal(a[field], original, `${method} keeps last committed memory`);
  }
  h.failCommit(false);
  await a.persistMissedReminders([{ id: 'missed:a' }, { id: 'missed:b' }]);
  await Promise.all([a.removeMissedReminder('missed:a'), b.removeMissedReminder('missed:b')]);
  assert.equal(h.rows(missedKey).length, 0);

  // Old manual callers need no action ID and retain empty-event fallback.
  const old = harness(); const state = old.window();
  assert.equal((await state.saveRelativeReminder('', 0.2, '提醒我')).status, 'saved');
  assert.equal(state.relativeReminders[0].event, '提醒你');
  assert.equal(state.relativeReminders[0].dueAt, now + 1000);
  assert.equal((await state.saveRelativeReminder('water', 60)).status, 'saved');
  assert.equal(state.relativeReminders.length, 2, 'separate old calls remain separate tasks');
  assert.equal((await state.saveDailyReminder('', 8, 0)).status, 'saved');
  assert.equal(state.dailyReminders[0].event, 'remind you');
  const fixedAt = now + 300_000;
  assert.equal((await state.saveRelativeReminder('clock', 1, '', { dueAt: fixedAt, actionId: 'restored:relative' })).status, 'saved');
  const restored = old.rows(old.slice.RELATIVE_REMINDER_STORAGE_KEY);
  const restoreHarness = harness(); const restoredState = restoreHarness.window();
  await restoredState.persistRelativeReminders(restored);
  assert.equal((await restoredState.saveRelativeReminder('clock', 1, '', { dueAt: fixedAt, actionId: 'restored:relative' })).status, 'existing', 'backup without receipts recognizes reminder ID');
  assert.equal(restoredState.relativeReminders.length, 3);
  await restoredState.persistDailyReminders([{ id: 'restored:daily', event: 'practice', hour: 8, minute: 0, timeZone: 'Asia/Shanghai', createdAt: now }]);
  assert.equal((await daily(restoredState, 'restored:daily')).status, 'existing');
  assert.equal((await daily(restoredState, 'restored:daily', 'practice', 10)).status, 'rejected');
  await mutationChecks();
  await latePolicyChecks();
  console.log('Reminder persistence passed: validation, commit failures, atomic receipts, concurrent windows, atomic edit/cancel/conversion, epoch guards and old callers.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
