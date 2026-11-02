const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');
const entries = new Map(), messages = new Map(), processed = [];
let failId = '';
const factsOnly = [];
const clone = x => x === undefined ? x : structuredClone(x);
const db = {
  keyval: {
    get: async key => entries.has(key) ? { key, value: clone(entries.get(key)) } : undefined,
    put: async ({ key, value }) => entries.set(key, clone(value)),
    delete: async key => entries.delete(key),
    filter: fn => ({ toArray: async () => [...entries].map(([key, value]) => ({ key, value: clone(value) })).filter(fn) }),
  },
  messages: {
    get: async id => clone(messages.get(id)),
    delete: async id => messages.delete(id),
    update: async (id, patch) => messages.set(id, { ...messages.get(id), ...patch }),
    where: () => ({ below: time => ({ reverse: () => ({ limit: () => ({ toArray: async () => [...messages.values()].filter(m => m.timestamp < time).sort((a,b) => b.timestamp-a.timestamp).slice(0,6).map(clone) }) }) }) }),
  },
  transaction: async (_mode, _tables, fn) => fn(),
};
const coordinator = { async readTurnSources(id) { const msg = messages.get(id); if (!msg) throw Error('missing'); const sources = id === 'legacy2' || id === 'legacy1' ? [messages.get('legacy1'), messages.get('legacy2')] : [msg]; return { turnId: sources[0].id, sources }; }, async createTurnCoordinator({ sources }) {
  return { async prepare(force) { assert.equal(force, true); if (sources[0].id === failId) throw Error('failed'); processed.push(sources.map(s => s.id)); },
    async prepareFactsOnly() { factsOnly.push(sources[0].id); }, catchUpResult: () => ({ complete: true, context: 'Location assessment: completed' }), async dispose() {} };
} };
const moduleObj = { exports: {} };
const src = ts.transpileModule(fs.readFileSync('services/receivedTurns.ts','utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(src, { module: moduleObj, exports: moduleObj.exports, JSON, Error, Set, require: id => id === './db' ? { db } : id === './turnCoordinator' ? coordinator : assert.fail(id) });
const { receiveUnreadTurn, seedReceivedTurns, readReceivedTurns, withdrawUnprocessedSource } = moduleObj.exports;
const input = { language: 'zh', privateTimeZone: 'Asia/Tokyo', reminders: {}, isCancelled: () => false };
(async () => {
  for (let i=0; i<9; i++) {
    const source = { id:'id'+i, role:'user', text: i===3?'我到巴黎了':'消息'+i, timestamp:1000+i };
    messages.set(source.id, source);
    await receiveUnreadTurn([source]);
  }
  assert.equal(processed.length, 0, 'receipt does not cause reading');
  failId='id4';
  await assert.rejects(readReceivedTurns(input));
  assert.equal(entries.get('kumiko_received_turn_v1:id3').status, 'completed');
  assert.equal(entries.get('kumiko_received_turn_v1:id4').status, 'received');
  assert.equal(messages.get('id3').isRead, true);
  assert.equal(messages.get('id4').isRead, undefined);
  failId='';
  await readReceivedTurns(input);
  assert.deepEqual(processed.flat(), Array.from({length:9},(_,i)=>'id'+i));
  const replayContexts = await readReceivedTurns({ ...input, relevantIds: ['id3'] });
  assert.equal(replayContexts.length, 1, 'completed receipt remains available for a later reply');
  assert.equal(processed.length,9, 'restart does not replay completed turns');
  const restored = { id: 'restored', role: 'user', text: '我到巴黎了', timestamp: 2000 };
  messages.set(restored.id, restored);
  await receiveUnreadTurn([restored]);
  entries.get('kumiko_received_turn_v1:restored').restored = true;
  await readReceivedTurns(input);
  assert.deepEqual(factsOnly, ['restored']);
  assert.equal(processed.length, 9, 'restored turns do not run reminder actions');
  const first = { id: 'legacy1', role: 'user', text: 'a', timestamp: 3000 };
  const second = { id: 'legacy2', role: 'user', text: 'b', timestamp: 3001 };
  messages.set(first.id, first); messages.set(second.id, second);
  await seedReceivedTurns(['legacy2', 'legacy1']);
  assert.deepEqual(Array.from(entries.get('kumiko_received_turn_v1:legacy1').sourceIds), ['legacy1', 'legacy2']);
  await readReceivedTurns(input);
  assert.equal(processed.length, 10);
  assert.deepEqual(Array.from(processed[9]), ['legacy1', 'legacy2']);
  const tampered = { id: 'tampered', role: 'user', text: 'original', timestamp: 4000 };
  messages.set(tampered.id, tampered);
  await receiveUnreadTurn([tampered]);
  messages.set(tampered.id, { ...tampered, text: 'changed' });
  await assert.rejects(readReceivedTurns(input), /Unread source changed/);
  assert.equal(entries.get('kumiko_received_turn_v1:tampered').status, 'received');
  const pending = { id: 'pending', role: 'user', text: 'unsent', timestamp: 5000 };
  messages.set(pending.id, pending); await receiveUnreadTurn([pending]);
  assert.equal(await withdrawUnprocessedSource(pending), true);
  assert.equal(messages.has(pending.id), false);
  assert.equal(entries.has('kumiko_received_turn_v1:pending'), false);
  const claimed = { id: 'claimed', role: 'user', text: 'in progress', timestamp: 5001 };
  messages.set(claimed.id, claimed); entries.set('kumiko_turn_source_v1:claimed', { turnId: 'claimed' });
  assert.equal(await withdrawUnprocessedSource(claimed), false);
  assert.equal(messages.has(claimed.id), true);
  console.log('received turns: ordered nine, retry, durable completion, restored facts-only, legacy groups and source integrity passed');
})().catch(e => { console.error(e); process.exitCode=1; });
