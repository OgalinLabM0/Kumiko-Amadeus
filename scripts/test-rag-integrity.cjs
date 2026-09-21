'use strict';

// Execute the real renderer service with synthetic data and isolated stores.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const filename = path.join(__dirname, '../services/localRagService.ts');
const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function load(options = {}) {
  const calls = { ipc: [], clears: 0, adds: 0, transactions: 0 };
  let rows = [{ id: 'original', text: 'Existing memory', vector: new Float32Array([1]), timestamp: 1 }];
  let inTransaction = false;
  const db = {
    messages: { orderBy: () => ({ toArray: async () => options.messages || [] }) },
    getVal: async (_key, fallback) => fallback,
    vectors: {
      clear: async () => { assert.ok(inTransaction); calls.clears++; rows = []; },
      bulkAdd: async (data) => {
        assert.ok(inTransaction); calls.adds++;
        if (options.failAdd) throw new Error('simulated write failure');
        rows.push(...data);
      },
    },
    transaction: async (mode, table, callback) => {
      assert.equal(mode, 'rw'); assert.equal(table, db.vectors);
      calls.transactions++; const before = rows.slice(); inTransaction = true;
      try { return await callback(); } catch (error) { rows = before; throw error; }
      finally { inTransaction = false; }
    },
  };
  const invoke = async (channel, payload) => {
    calls.ipc.push({ channel, payload });
    if (channel === 'rag:search') return { success: true, results: options.candidates || [] };
    if (channel === 'rag:get-messages') return { success: true, messages: options.messages || [] };
    if (channel === 'rag:restore') {
      if (options.rejectRestore) throw new Error('native store unavailable');
      return options.restoreResult ?? { success: true, count: payload.length };
    }
    throw new Error(`Unexpected IPC call: ${channel}`);
  };
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, Float32Array,
    console: { log() {}, warn() {}, error() {} },
    window: options.web || options.android ? {} : { electronAPI: { invoke } },
    require(id) {
      if (id === './db') return { db };
      if (id === './environment') return { isCapacitorNative: () => !!options.android };
      if (id === './androidRagService') return { invokeAndroidRag: invoke };
      throw new Error(`Unexpected import: ${id}`);
    },
  };
  vm.runInNewContext(source, sandbox, { filename });
  return { service: module.exports, calls, rows: () => rows };
}

async function testRecall() {
  const fact = 'The user moved to Osaka.';
  const unrelated = { id: 'new-chat', role: 'user', text: 'Unrelated current weather.', timestamp: 200000 };
  const candidate = { text: fact, source: 'memory_chunk', timestamp: unrelated.timestamp, score: 1 };
  const h = load({ candidates: [candidate], messages: [unrelated] });
  const result = await h.service.searchLocalRagMemoryDetailed('Osaka', 1, undefined, 'semantic_recall');
  assert.equal(result.blocks[0], fact);
  assert.equal(result.groupedBlocks[0].blocks[0], fact);
  assert.equal(result.groupedBlocks[0].quoteSafe, false);
  assert.equal(h.calls.ipc.filter(call => call.channel === 'rag:expand-context').length, 0);

  const original = { id: 'source', role: 'user', text: 'I moved to Osaka last spring.', timestamp: 1000 };
  const linked = load({ candidates: [{ ...candidate, messageId: 'source' }], messages: [original] });
  const linkedResult = await linked.service.searchLocalRagMemoryDetailed('Osaka', 1);
  assert.ok(linkedResult.blocks[0].includes(fact));
  assert.ok(linkedResult.blocks[0].includes(original.text));

  const rawHit = load({ candidates: [{ ...candidate, source: 'rebuild_message', text: original.text, messageId: 'source' }], messages: [original] });
  assert.ok((await rawHit.service.searchLocalRagMemoryDetailed('Osaka', 1)).blocks[0].includes('User: ' + original.text));
  const missing = load({ candidates: [{ ...candidate, messageId: 'missing' }], messages: [unrelated] });
  assert.equal((await missing.service.searchLocalRagMemoryDetailed('Osaka', 1)).blocks[0], fact);
}

async function testRestore() {
  const data = [{ id: 'new', text: 'Restored fact', timestamp: 2, vector: [0.1, 0.2] }];
  for (const options of [
    { restoreResult: { success: false, error: 'SQLite is unavailable' } },
    { rejectRestore: true },
    { restoreResult: { success: true } },
    { restoreResult: { success: true, count: 2 } },
    { restoreResult: { success: true, count: 0 } },
  ]) {
    const h = load(options); const result = await h.service.restoreVectors(data);
    assert.equal(result.ok, false); assert.equal(result.backend, 'sqlite');
    assert.equal(h.calls.clears, 0); assert.equal(h.calls.adds, 0);
    assert.equal(h.rows()[0].id, 'original');
  }
  const normal = load();
  assert.equal((await normal.service.restoreVectors(data)).ok, true);
  assert.equal(normal.calls.clears, 0);
  const empty = load();
  assert.equal((await empty.service.restoreVectors([])).ok, true);
  assert.equal(empty.calls.ipc[0].channel, 'rag:restore');
  assert.equal(empty.calls.ipc[0].payload.length, 0);
  const invalid = load();
  assert.equal((await invalid.service.restoreVectors({})).ok, false);
  assert.equal(invalid.calls.ipc.length, 0);
  const android = load({ android: true, restoreResult: { success: false, error: 'Channel not available on Android: rag:restore' } });
  assert.equal((await android.service.restoreVectors(data)).backend, 'indexeddb');
  assert.equal(android.calls.transactions, 1); assert.equal(android.rows()[0].id, 'new');
  const failedWeb = load({ web: true, failAdd: true });
  assert.equal((await failedWeb.service.restoreVectors(data)).ok, false);
  assert.equal(failedWeb.calls.transactions, 1); assert.equal(failedWeb.rows()[0].id, 'original');
}

async function testNativeRestoreHandler() {
  const nativeSource = fs.readFileSync(path.join(__dirname, '../electron-rag.cjs'), 'utf8');
  const start = nativeSource.indexOf("ipcMain.handle('rag:restore'");
  const end = nativeSource.indexOf("ipcMain.handle('rag:clear-all'", start);
  const handlerSource = nativeSource.slice(start, end);
  const dimension = Number(nativeSource.match(/const EMBEDDING_DIM = (\d+)/)[1]);
  const vector = { id: 'restored', text: 'A remembered event.', vector: Array(dimension).fill(0.1), timestamp: 1 };
  async function run(payload, options = {}) {
    let handler;
    let rows = new Map([['original', {}]]);
    let clears = 0;
    const db = {
      prepare(sql) {
        if (sql.startsWith('INSERT')) return { run: id => rows.set(id, {}) };
        if (sql.startsWith('SELECT COUNT')) return { get: () => ({ count: options.badCount ? rows.size + 1 : rows.size }) };
        throw new Error('Unexpected SQL in restore test');
      },
      exec(sql) { assert.equal(sql, 'DELETE FROM vectors'); clears++; rows.clear(); },
      transaction(fn) { return items => { const before = new Map(rows); try { return fn(items); } catch (e) { rows = before; throw e; } }; },
    };
    vm.runInNewContext(handlerSource, {
      ipcMain: { handle: (channel, fn) => { assert.equal(channel, 'rag:restore'); handler = fn; } },
      db, EMBEDDING_DIM: dimension, Buffer, Float32Array,
      normalizeTier: tier => tier || 'core',
      rebuildHnswFromSqlite: async () => ({ total: rows.size, indexed: options.badIndex ? 0 : rows.size }),
      console: { log() {}, error() {} },
    });
    const result = await handler({}, payload);
    return { result, rows, clears };
  }
  for (const data of [
    [vector, vector],
    [{ ...vector, vector: [0.1] }],
    [{ ...vector, vector: Array(dimension).fill(Infinity) }],
    [{ ...vector, vector: Array(dimension).fill(1e100) }],
    [{ ...vector, timestamp: NaN }],
  ]) {
    const h = await run(data); assert.equal(h.result.success, false);
    assert.equal(h.clears, 0); assert.ok(h.rows.has('original'));
  }
  const valid = await run([vector]);
  assert.equal(valid.result.success, true); assert.equal(valid.result.count, 1);
  const empty = await run([]); assert.equal(empty.result.success, true); assert.equal(empty.rows.size, 0);
  const mismatch = await run([vector], { badCount: true });
  assert.equal(mismatch.result.success, false); assert.ok(mismatch.rows.has('original'));
  const badIndex = await run([vector], { badIndex: true });
  assert.equal(badIndex.result.success, false); assert.equal(badIndex.result.count, 1);
}

function testNativeSearchRouting() {
  const nativeSource = fs.readFileSync(path.join(__dirname, '../electron-rag.cjs'), 'utf8');
  const parsed = ts.createSourceFile('electron-rag.cjs', nativeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'searchTierVectors');
  assert.ok(declaration, 'test must execute the production search function');
  for (const [filters, expectedCalls] of [
    [{}, 1],
    [{ startTime: undefined, endTime: undefined, role: undefined }, 1],
    [{ startTime: null, endTime: null, role: 'any' }, 1],
    [{ role: '' }, 1],
    [{ startTime: 0 }, 0],
    [{ endTime: 0 }, 0],
    [{ role: 'user' }, 0],
  ]) {
    let calls = 0;
    const sandbox = {
      normalizeTier: tier => tier,
      getHnswState: () => ({ index: {
        getCurrentCount: () => 1,
        searchKnn: () => { calls++; return { neighbors: [], distances: [] }; },
      }, idMap: new Map() }),
      getTierSearchRows: (_tier, actualFilters) => { assert.equal(actualFilters, filters); return []; },
      console: { log() {}, warn() {} },
    };
    vm.runInNewContext(declaration.getText(parsed), sandbox);
    sandbox.searchTierVectors(new Float32Array([1]), [], 'core', 3, filters);
    assert.equal(calls, expectedCalls, `HNSW selection for ${JSON.stringify(filters)}`);
  }
}

(async () => {
  await testRecall(); await testRestore(); await testNativeRestoreHandler(); testNativeSearchRouting();
  console.log('RAG evidence preservation and restore integrity scenarios passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
