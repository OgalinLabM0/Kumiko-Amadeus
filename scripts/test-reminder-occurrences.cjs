'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const rows = new Map();
let queue = Promise.resolve();
const db = { keyval: {
  get: async key => rows.has(key) ? {key, value: structuredClone(rows.get(key))} : undefined,
  put: async ({key, value}) => { rows.set(key, structuredClone(value)); },
}, messages: { put: async value => { rows.set('message:' + value.id, structuredClone(value)); } }, transaction(_mode, ...args) {
  const fn = args[args.length - 1]; const next = queue.then(fn); queue = next.catch(() => {}); return next;
}};
const constants = { RELATIVE_REMINDER_STORAGE_KEY: 'relative', DAILY_REMINDER_STORAGE_KEY: 'daily', KUMIKO_MISSED_REMINDERS_STORAGE_KEY: 'missed' };
const source = ts.transpileModule(fs.readFileSync('services/reminderOccurrences.ts', 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
const moduleObj = {exports:{}};
vm.runInNewContext(source, {module:moduleObj, exports:moduleObj.exports, require(id) { if (id === './db') return {db}; if (id === '../store/slices/reminderSlice') return constants; throw Error(id); }, Date, Math, JSON, Error});
const api = moduleObj.exports;
(async () => {
 const due = Date.now() - 1000;
 const r = {id:'test', event:'喝水', dueAt:due, createdAt:due - 1000};
 rows.set('relative', [r]);
 const claims = await Promise.all([api.claimReminderOccurrence(r,due), api.claimReminderOccurrence(r,due)]);
 assert.equal(claims.filter(Boolean).length,1);
 const token = claims.find(Boolean);
 rows.set('relative',[{...r, version:1, event:'吃药'}]);
 assert.equal(await api.markReminderSending(r,due,token),false);
 assert.equal(await api.finishReminderOccurrence(r,due,token,'delivered'),false);
 assert.equal(rows.get('relative')[0].event,'吃药');
 const changed = rows.get('relative')[0];
 const token2 = await api.claimReminderOccurrence(changed,due);
 assert.ok(await api.markReminderSending(changed,due,token2));
 assert.ok(await api.commitReminderMessage(changed,due,token2,{ id:'stable', role:'model', text:'吃药', timestamp:due }));
 assert.equal(rows.get('message:stable').text,'吃药');
 assert.equal(await api.commitReminderMessage(changed,due,token2,{ id:'stable', role:'model', text:'重复', timestamp:due }),false);
 await api.abandonReminderOccurrence(changed,due,token2);
 assert.equal(await api.claimReminderOccurrence(changed,due,Date.now()+360000),null);
 assert.equal(api.reminderGraceMs({ ...r, sourceText:'明早叫醒我' }),600000);
 assert.equal(api.reminderGraceMs(r),1800000);
 assert.equal(api.reminderGraceMs({ ...r, lateGraceMinutes:0 }),60000, 'on-time only permits polling tolerance');
 assert.equal(api.reminderGraceMs({ ...r, lateGraceMinutes:60 }),3600000);
 const policy = {...r,id:'policy'}; rows.set('relative',[policy]);
 const pt = await api.claimReminderOccurrence(policy,due);
 rows.set('relative',[{...policy,version:1,lateGraceMinutes:60}]);
 assert.equal(await api.markReminderSending(policy,due,pt),false,'policy changes invalidate in-flight old version');
 const m = {...r,id:'miss'}; rows.set('relative',[m]);
 const mt = await api.claimReminderOccurrence(m,due);
 assert.ok(await api.finishReminderOccurrence(m,due,mt,'missed'));
 assert.equal(rows.get('relative').length,0); assert.equal(rows.get('missed').length,1);
 const e = {...r,id:'epoch'}; rows.set('relative',[e]);
 const et = await api.claimReminderOccurrence(e,due); rows.set('kumiko_turn_epoch_v1','new');
 assert.equal(await api.markReminderSending(e,due,et),false);
 rows.delete('kumiko_turn_epoch_v1');
 const race = {...r,id:'race'}; rows.set('relative',[race]);
 const rt = await api.claimReminderOccurrence(race,due); assert.ok(await api.markReminderSending(race,due,rt));
 await Promise.all([
   db.transaction('rw', db.keyval, async () => rows.set('relative',[{...race,version:1,event:'新任务'}])),
   api.commitReminderMessage(race,due,rt,{id:'stale',role:'model',text:'旧任务',timestamp:due}),
 ]);
 assert.equal(rows.has('message:stale'),false,'mutation winning the transaction suppresses the old message');
 console.log('Reminder occurrence isolation: passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
