#!/usr/bin/env node
'use strict';

// Actual persistence, parsing, dispatch prompt and clock conversion. Isolated
// database/transport; never loads private app data or calls a paid model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
let now = Date.parse('2026-10-03T20:00:00Z');
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
function load(file, dependencies = {}) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: file,
  }).outputText;
  vm.runInNewContext(source, {
    module, exports: module.exports, Date: Clock, Intl, console: { log() {}, warn() {}, error() {} },
    require(id) { if (Object.hasOwn(dependencies, id)) return dependencies[id]; throw new Error(`Missing ${id} in ${file}`); },
  }, { filename: file });
  return module.exports;
}
const timing = load('services/reminderTime.ts');
const prompts = load('services/reminderPrompt.ts', { './reminderTime': timing });
const rows = new Map();
const slice = load('store/slices/reminderSlice.ts', {
  '../../services/db': { db: { setVal: async (key, value) => rows.set(key, structuredClone(value)) } },
  '../../services/reminderTime': timing,
});
const backup = load('components/app/backupHelpers.ts', {
  '../../services/db': {}, '../../store/slices/reminderSlice': slice,
  './appConstants': {}, '../../services/reminderTime': timing,
});
const scheduling = load('components/app/reminderScheduling.ts', { './backupHelpers': backup });
const state = { locationConfig: { modelTimezone: 'Asia/Tokyo', userTimezone: 'America/Sao_Paulo' } };
Object.assign(state, slice.createReminderSlice(value => Object.assign(state, typeof value === 'function' ? value(state) : value), () => state));

async function main() {
  for (const text of ['每天晚上8点提醒我洗衣服', '每晚8点提醒我洗衣服', '每天8:00pm提醒我洗衣服', '每天8点pm提醒我洗衣服', 'daily at 8pm remind me to do laundry']) {
    assert.equal(backup.parseDailyReminderRequest(text).hour, 20, text);
  }
  assert.equal(backup.parseDailyReminderRequest('每天晚上8点半提醒我洗衣服').minute, 30);
  assert.equal(backup.parseRelativeReminderRequest('晚上8点30分提醒我洗衣服'), null);
  assert.equal(timing.resolveReminderTimeZone('晚上8点提醒我洗衣服', 'America/Sao_Paulo', 'Asia/Tokyo'), 'America/Sao_Paulo', 'ignore a model-invented zone without an explicit clock basis');
  await state.saveDailyReminder('洗衣服', 20, 0, '每天晚上8点提醒我洗衣服');
  const daily = state.dailyReminders[0];
  assert.equal(daily.timeZone, 'America/Sao_Paulo', 'user clock, never implicitly JST');
  const expected = Date.parse('2026-10-03T23:00:00Z');
  assert.equal(scheduling.getNextDailyReminderAt(daily, now), expected);
  assert.match(timing.formatReminderJst(expected, 'zh'), /08:00.*JST/);
  state.locationConfig = { modelTimezone: 'Asia/Tokyo', userTimezone: 'Pacific/Honolulu' };
  assert.equal(scheduling.getNextDailyReminderAt(daily, now), expected, 'settings change does not move a saved promise');
  const restoredDaily = backup.sanitizeDailyReminderRecord(rows.get(slice.DAILY_REMINDER_STORAGE_KEY)[0]);
  assert.equal(scheduling.getNextDailyReminderAt(restoredDaily, now), expected, 'restart/backup retains original zone');
  await state.saveDailyReminder('practice', 8, 0, '每天日本时间8点提醒我练习');
  assert.equal(state.dailyReminders[1].timeZone, 'Asia/Tokyo', 'explicit Japan clock wins');
  assert.equal(timing.resolveReminderTimeZone('按照你那边的时间8点提醒我', 'America/Sao_Paulo'), 'Asia/Tokyo');

  const requestAt = now;
  now += 25_000;
  await state.saveRelativeReminder('water', 60, '一分钟后提醒我喝水', { referenceAt: requestAt, timeZone: 'America/Sao_Paulo' });
  assert.equal(state.relativeReminders[0].dueAt, requestAt + 60_000, 'generation latency does not restart a duration');
  assert.equal(backup.sanitizeRelativeReminderRecord(rows.get(slice.RELATIVE_REMINDER_STORAGE_KEY)[0]).timeZone, 'America/Sao_Paulo');
  const at = timing.getClockReminderAt(20, 0, 'America/Sao_Paulo', requestAt);
  assert.equal(at, expected, 'one-shot wall clock converted by program');
  await state.saveRelativeReminder('laundry', 1, '晚上8点提醒我洗衣服', { dueAt: at, timeZone: 'America/Sao_Paulo' });
  assert.equal(state.relativeReminders[1].dueAt, expected);
  assert.equal(timing.getClockReminderAt(0, 15, 'Asia/Tokyo', Date.parse('2026-12-31T14:59:00Z'), 1), Date.parse('2026-12-31T15:15:00Z'));
  assert.equal(timing.getClockReminderAt(2, 30, 'America/New_York', Date.parse('2026-03-08T05:00:00Z'), 0), null, 'missing DST minute must not silently move');
  assert.equal(timing.getClockReminderAt(1, 30, 'America/New_York', Date.parse('2026-11-01T05:45:00Z'), 0), Date.parse('2026-11-01T06:30:00Z'));
  assert.equal(timing.getClockReminderAt(8, 0, 'bad/zone', now), null);

  for (const lang of ['zh', 'en']) {
    const original = { event: 'laundry', sourceText: '晚上8点提醒我洗衣服', dueAt: expected, timeZone: 'America/Sao_Paulo' };
    const prompt = prompts.buildTimedReminderSystemPrompt(original, lang, expected);
    assert.match(prompt, /08:00.*JST/);
    assert.ok(prompt.includes(original.sourceText), 'explicit words survive as evidence');
    assert.ok(!prompt.includes('America/Sao_Paulo') && !prompt.includes('Honolulu'), 'private clock basis is not character knowledge');
    assert.equal(prompt, prompts.buildTimedReminderSystemPrompt({ ...original, timeZone: 'Pacific/Honolulu' }, lang, expected));
    assert.match(prompts.buildTimedReminderSystemPrompt({ ...original, originalDueAt: expected - 3600000 }, lang, expected), /迟到|LATE REMINDER/);
  }
  let modelPrompt = '';
  const retry = load('services/reminderIntentRetry.ts', { './geminiService': {
    getCurrentAIConfig: () => ({ model_main: 'mock' }),
    callLLMRaw: async (system) => { modelPrompt = system; return '{"isReminder":true,"event":"laundry","recurrence":"once","hour":20,"minute":0,"daysOffset":1}'; },
  } });
  const extracted = await retry.extractReminderIntentLLM('明晚8点提醒我洗衣服', 'zh');
  assert.equal(extracted.hour, 20); assert.equal(extracted.daysOffset, 1);
  assert.ok(!modelPrompt.includes('America/Sao_Paulo'));
  // Run the production creation path too, including the actual daily parser
  // and persisted store, so correct helpers cannot hide incorrect wiring.
  const chat = fs.readFileSync(path.join(root, 'components/app/chatActions.ts'), 'utf8');
  const start = chat.indexOf('    const hasReminderIntent =');
  const end = chat.indexOf('    if (shouldRetryReminderIntent && !createdReminderThisTurn)', start);
  assert.ok(start >= 0 && end > start);
  const creation = ts.transpileModule(`globalThis.create = async (response, userTextForRag, known) => {
    const resolveUserKnownLocation = async () => known;
    ${chat.slice(start, end)}
    return createdReminderThisTurn;
  };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = {
    ...timing, ...backup, s2: state, reminderRequestAt: requestAt,
    reminderUserZone: 'Pacific/Honolulu', language: 'zh', console: { log() {} },
    extractReminderIntentLLM: async () => null,
  };
  vm.runInNewContext(creation, context);
  await context.create({ textParts: [], scheduleTrigger: { event: '洗衣服', recurrence: 'daily', hour: 8, minute: 0 } },
    '每天晚上8点提醒我洗衣服', { timeZone: 'America/Sao_Paulo' });
  assert.equal(state.dailyReminders.at(-1).hour, 20, 'production path preserves explicit evening');
  assert.equal(state.dailyReminders.at(-1).timeZone, 'America/Sao_Paulo', 'known region wins over changed hidden settings for new promises');
  await context.create({ textParts: [], scheduleTrigger: { event: '洗衣服', hour: 20, minute: 0 } },
    '晚上8点提醒我洗衣服', { timeZone: 'America/Sao_Paulo' });
  assert.equal(state.relativeReminders.at(-1).dueAt, expected, 'production one-shot conversion');
  const count = state.dailyReminders.length;
  assert.equal(await context.create({ textParts: [], scheduleTrigger: { event: '洗衣服', recurrence: 'daily', hour: 20, minute: 0 } },
    '每天晚上8点提醒我洗衣服', { timeZone: null }), false);
  assert.equal(state.dailyReminders.length, count, 'unresolved disclosed region must not silently borrow settings');
  console.log('Reminder contract passed: creation clock, settings changes, persistence, explicit JST, one-shot/DST, private prompts and extraction.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
