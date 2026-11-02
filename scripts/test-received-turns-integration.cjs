'use strict';
// Exercise the production queue and coordinator with the existing isolated
// IndexedDB/model fixtures; no real user data, network, or paid models.
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const fixturePath = path.join(__dirname, 'test-turn-coordinator.cjs');
let code = fs.readFileSync(fixturePath, 'utf8');
code = code.replace("  const slice = load('store/slices/reminderSlice.ts', {", `  db.keyval.filter = fn => ({ toArray: async () => [...keyvals].map(([key,value]) => ({key,value:clone(value)})).filter(fn) });
  db.messages.update = async (id, patch) => messages.set(id, {...messages.get(id), ...patch});
  db.messages.where = () => ({ below: time => ({ reverse: () => ({ limit: n => ({ toArray: async () => [...messages.values()].filter(m => m.timestamp < time).sort((a,b) => b.timestamp-a.timestamp).slice(0,n).map(clone) }) }) }) });
  const slice = load('store/slices/reminderSlice.ts', {`);
code = code.replace('    db, calls, events, source, start, window, location, understanding,', '    db, coordinator, calls, events, source, start, window, location, understanding,');
code = code.replace(/main\(\)\.catch\(error => \{ console\.error\(error\); process\.exitCode = 1; \}\);\s*$/, `
(async () => {
  const h = harness();
  try {
    const queue = load('services/receivedTurns.ts', { './db': { db: h.db }, './turnCoordinator': h.coordinator });
    const old = h.source('我现在在武汉', 'user', now - 2000000);
    await h.location.commitUserLocationFact({ locationText: '武汉', sourceQuote: old.text }, old, { isActualUserTurn: true });
    const items = [];
    for (let i = 0; i < 9; i++) items.push(h.source(i === 3 ? '我现在在巴黎' : i === 7 ? '我现在在圣保罗' : '普通消息' + i, 'user', now - 10000 + i));
    for (const source of items) await queue.receiveUnreadTurn([source]);
    assert.equal((await h.location.getUserKnownLocation()).locationText, '武汉');
    h.respond(payload => { const source = payload.messages[0];
      const place = source.text.includes('巴黎') ? '巴黎' : source.text.includes('圣保罗') ? '圣保罗' : null;
      return JSON.stringify({ locations: place ? [{ sourceMessageId: source.id, kind: 'assert', locationText: place, sourceQuote: source.text }] : [], reminders: [] }); });
    const input = { language: 'zh', privateTimeZone: 'Asia/Shanghai', reminders: h.window(), isCancelled: () => false };
    await queue.readReceivedTurns(input);
    assert.equal((await h.location.getUserKnownLocation()).locationText, '圣保罗');
    assert.equal(h.calls.filter(c => c.type === 'understanding').length, 9);
    await queue.readReceivedTurns(input);
    assert.equal(h.calls.filter(c => c.type === 'understanding').length, 9);
    const timer = h.source('十分钟后提醒我喝水', 'user', now - 1200000);
    await queue.receiveUnreadTurn([timer]);
    h.respond({ locations: [], reminders: [{ kind: 'create', sourceMessageId: timer.id,
      sourceQuote: timer.text, event: '喝水', delaySeconds: 600 }] });
    const context = await queue.readReceivedTurns(input);
    assert.equal(h.reminderRows().length, 0, 'elapsed timer is not restarted when read');
    assert.ok(context.join(' ').includes('这个时间已经过去'));
    const restored = h.source('我现在在巴黎，十分钟后提醒我喝水', 'user', now - 1000);
    await queue.receiveUnreadTurn([restored]);
    const original = await h.start([restored], input.reminders);
    await original.dispose();
    await h.setEpoch('restored-epoch');
    const key = queue.RECEIVED_TURN_PREFIX + restored.id;
    const saved = await h.db.keyval.get(key);
    await h.db.keyval.put({ key, value: { ...saved.value, restored: true } });
    h.respond({ locations: [{ sourceMessageId: restored.id, kind: 'assert', locationText: '巴黎', sourceQuote: '我现在在巴黎' }],
      reminders: [{ kind: 'create', sourceMessageId: restored.id, sourceQuote: restored.text, event: '喝水', delaySeconds: 600 }] });
    await queue.readReceivedTurns(input);
    assert.equal((await h.location.getUserKnownLocation()).locationText, '巴黎');
    assert.equal(h.reminderRows().length, 0, 'restored unread facts cannot resurrect old reminders');
    console.log('Real coordinator and received queue: nine unread, location corrections, restart, elapsed and restored reminders passed.');
  } finally { await h.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });`);
const mod = new Module(fixturePath, module);
mod.filename = fixturePath;
mod.paths = Module._nodeModulePaths(path.dirname(fixturePath));
mod._compile(code, fixturePath);
