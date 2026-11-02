'use strict';

// Production IPC handlers in a fresh VM with an in-memory transactional SQLite
// substitute. No Electron window, user database, native model, or network is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../electron-rag.cjs'), 'utf8');
const parsed = ts.createSourceFile('electron-rag.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const dimension = Number(source.match(/const EMBEDDING_DIM = (\d+)/)[1]);
const declarations = ['isDataRestoreActive', 'isDataResetOwner', 'assertRagGeneration', 'assertRagOperationAllowed', 'normalizeRawMessageRecord', 'registerIpcHandlers']
  .map(name => {
    const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration, `Production declaration ${name} exists`);
    return declaration.getText(parsed);
  }).join('\n');
const vector = (id, extra = {}) => ({ id, text: 'Remembered event', vector: Array(dimension).fill(0.25), timestamp: 1, ...extra });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function load(options = {}) {
  const handlers = new Map();
  const sender = {};
  const stranger = {};
  let vectors = new Map();
  let messages = [];
  let embeddingCalls = 0;
  let writes = 0;
  let clears = 0;
  let backupMarker = options.backupMarker || null;
  const db = {
    prepare(sql) {
      if (sql.startsWith('SELECT id, tier')) return { get: id => vectors.get(id) };
      if (sql.startsWith('SELECT id, message_id')) return { all: () => Array.from(vectors.values()) };
      if (sql.startsWith('SELECT COUNT')) return { get: () => ({ count: vectors.size }) };
      if (sql.startsWith('INSERT OR REPLACE INTO vectors')) return { run(...args) {
        const [id, message_id, text, buffer, timestamp, tier, source, score, canonical_key, role] = args;
        if (id === options.failInsertId) throw new Error('Injected SQLite write failure');
        writes++;
        vectors.set(id, { id, message_id, text, vector: buffer, timestamp, tier, source, score, canonical_key, role });
      } };
      if (sql.includes('UPDATE vectors')) return { run(...args) {
        writes++;
        const [message_id, text, buffer, timestamp, tier, source, score, canonical_key, role, id] = args;
        vectors.set(id, { id, message_id, text, vector: buffer, timestamp, tier, source, score, canonical_key, role });
      } };
      throw new Error(`Unexpected SQLite query: ${sql}`);
    },
    exec(sql) { assert.equal(sql, 'DELETE FROM vectors'); clears++; vectors.clear(); },
    transaction(callback) { return (...args) => {
      const before = new Map(vectors);
      try { return callback(...args); } catch (error) { vectors = before; throw error; }
    }; },
  };
  const sandbox = {
    require: id => { if (id === './electron/artifact-index.cjs') return { registerArtifactIndex() {}, readArtifactProvenance:()=>options.provenance||new Map(), replaceArtifactProvenance() {} };
      if(id==='./electron/user-config.cjs')return {readConfigValue:()=>backupMarker,writeConfigValue:(_key,value)=>{backupMarker=value;},deleteConfigValue:()=>{backupMarker=null;}}; throw Error(id); },
    electronIpcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    restoreLock: null, ragGeneration: 0, lastMemoryGeneration: null, lastResetGeneration: null, activeRagIndexMutations: 0, activeRebuildJob: null,
    db, Buffer, Float32Array, EMBEDDING_DIM: dimension,
    RAG_TIER_EPISODIC: 'episodic',
    normalizeTier: tier => tier || 'core',
    inferRoleScopeFromText: (_text, role) => role || 'unknown',
    createRagVectorId: () => 'generated',
    shouldSkipCanonicalDuplicate: () => false,
    createCanonicalKeyFromRawText: text => text,
    findRecentEpisodicMergeTarget: () => options.mergeTarget || null,
    buildMergedEpisodicText: (a, b) => `${a}\n${b}`,
    generateEmbedding: async () => {
      embeddingCalls++;
      const delayed = options.embeddings?.[embeddingCalls - 1];
      return delayed ? delayed.promise : new Float32Array(dimension).fill(0.5);
    },
    addToHnswIndex() {}, replaceInHnswIndex() {}, removeFromHnswIndex() {},
    rebuildHnswFromSqlite: async () => {
      if (options.indexWait) await options.indexWait.promise;
      return { indexed: vectors.size, total: vectors.size };
    },
    clearAllVectors: () => { vectors.clear(); },
    clearMessageVectors: async () => 0,
    upsertRawMessages: (items, replaceAll) => { messages = replaceAll ? items.slice() : messages.concat(items); },
    getAllRawMessages: () => messages.slice(),
    getRawMessageContextWindow: () => messages.slice(),
    searchVectors: async () => [{ text: 'Normal recall' }],
    getVectorStats: () => ({ vectorCount: vectors.size, messageCount: messages.length }),
    getDbPath: () => 'memory-only',
    isModelLoaded: false, modelLoadPromise: null, activeModelBackend: 'none', modelLoadError: null,
    ragWorkerModelLoaded: false, ragWorkerLoadPromise: null,
    buildRebuildJobPayload: job => ({ id: job.id }),
    createRebuildJob: () => ({ id: 'job' }), safeSendRebuildEvent() {}, runRagRebuildJob() {},
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(declarations + '\nregisterIpcHandlers();', sandbox);
  const invoke = (channel, payload, owner = sender) => handlers.get(channel)({ sender: owner }, payload);
  const lock = (action, id = 'session', owner = sender) => invoke('rag:restore-lock', { action, id }, owner);
  return { invoke, lock, sandbox, vectors: () => vectors, messages: () => messages, backupMarker:()=>backupMarker,
    writes: () => writes, clears: () => clears, embeddingCalls: () => embeddingCalls, stranger };
}

async function testNormalCompatibility() {
  const h = load();
  assert.equal((await h.invoke('rag:save', { id: 'normal', text: 'Normal save' })).success, true);
  assert.equal((await h.invoke('rag:search', { query: 'event' })).success, true);
  assert.equal((await h.invoke('rag:restore', [vector('chunk', { source: 'memory_chunk' })])).success, true);
  const snapshot = await h.invoke('rag:get-all');
  assert.equal(snapshot.vectors.length, 1);
  assert.equal(snapshot.vectors[0].source, 'memory_chunk');
  assert.equal(snapshot.vectors[0].text, 'Remembered event');
  assert.equal((await h.invoke('rag:sync-messages', { messages: [{ id: 'message', role: 'user', text: 'Original', timestamp: 1 }, {}], replaceAll: true })).count, 1);
  assert.equal(h.messages()[0].text, 'Original');
  assert.equal((await h.invoke('rag:restore', [])).count, 0);
}

async function testMemoryPreparationAbort() {
  const h=load();
  assert.equal((await h.invoke('rag:restore-lock',{id:'prepared',action:'begin',kind:'memory'})).success,true);
  assert.equal(h.backupMarker(),'prepared','backup protection is durable before renderer journal');
  assert.equal(h.sandbox.lastMemoryGeneration,'prepared');
  assert.equal((await h.invoke('rag:restore-lock',{id:'prepared',action:'end',kind:'memory',aborted:true},h.stranger)).success,false);
  assert.equal(h.sandbox.lastMemoryGeneration,'prepared');
  assert.equal((await h.invoke('rag:restore-lock',{id:'prepared',action:'end',kind:'memory',aborted:true})).success,true);
  assert.equal(h.sandbox.lastMemoryGeneration,null,'failed preparation must preserve the prior generation');
  assert.equal(h.backupMarker(),null,'normal abort restores prior backup marker');
  assert.equal((await h.invoke('rag:restore-lock',{id:'committed',action:'begin',kind:'memory'})).success,true);
  assert.equal((await h.invoke('rag:restore-lock',{id:'committed',action:'end',kind:'memory',committed:true})).success,true);
  assert.equal(h.sandbox.lastMemoryGeneration,'committed');
  assert.equal(h.backupMarker(),'committed');
  assert.equal((await h.invoke('rag:save',{id:'late',text:'old private data',dataMemoryGeneration:'old'})).success,false,'old window cannot write after correction');
  assert.equal(h.vectors().has('late'),false);
  assert.equal((await h.invoke('rag:sync-messages',{messages:[{id:'old',role:'user',text:'old',timestamp:1}],dataMemoryGeneration:'old'})).success,false);
  assert.equal((await h.invoke('rag:save',{id:'fresh',text:'new data',dataMemoryGeneration:'committed'})).success,true);
}

async function testIsolationAndOwnership() {
  const h = load();
  assert.equal(h.sandbox.isDataRestoreActive(), false);
  assert.equal((await h.lock('begin')).success, true);
  const ownedLock = h.sandbox.restoreLock;
  assert.equal(h.sandbox.isDataRestoreActive(), true);
  assert.equal(h.sandbox.isDataResetOwner({ sender: ownedLock.sender }, 'session'), false, 'ordinary restore cannot clear credentials');
  assert.equal(h.sandbox.restoreLock, ownedLock, 'Shutdown probe never releases the restore fence');
  const generation = h.sandbox.ragGeneration;
  assert.equal((await h.lock('begin')).success, true);
  assert.equal(h.sandbox.ragGeneration, generation, 'Idempotent begin does not invalidate its own session');
  for (const [channel, payload] of [
    ['rag:save', { text: 'Blocked' }], ['rag:search', { query: 'Blocked' }],
    ['rag:embed', 'Blocked'], ['rag:expand-context', { timestamp: 1 }],
    ['rag:clear-all'], ['rag:clear-message-vectors'], ['rag:rebuild:start'],
    ['rag:restore', []], ['rag:sync-messages', { messages: [] }],
    ['rag:restore', { vectors: [], restoreSessionId: 'wrong' }],
  ]) assert.equal((await h.invoke(channel, payload)).success, false, channel);
  assert.equal(h.embeddingCalls(), 0);
  assert.equal((await h.lock('end', 'session', h.stranger)).success, false);
  assert.equal((await h.lock('begin', 'session', h.stranger)).success, false);
  assert.equal((await h.lock('end', 'wrong')).success, false);
  const restore = { vectors: [vector('restored')], restoreSessionId: 'session' };
  assert.equal((await h.invoke('rag:restore', restore, h.stranger)).success, false);
  assert.equal((await h.invoke('rag:restore', restore)).success, true);
  for (const channel of ['rag:get-all', 'rag:get-messages', 'rag:stats', 'rag:rebuild:status']) {
    assert.equal((await h.invoke(channel, undefined, h.stranger)).success, true, channel);
  }
  assert.equal((await h.invoke('rag:status')).restoreActive, true);
  const sync = { messages: [{ id: 'm', text: 'Restored', role: 'user', timestamp: 2 }], replaceAll: true, restoreSessionId: 'session' };
  assert.equal((await h.invoke('rag:sync-messages', sync, h.stranger)).success, false);
  assert.equal((await h.invoke('rag:sync-messages', sync)).success, true);
  assert.equal((await h.invoke('rag:sync-messages', { ...sync, messages: [{}, ...sync.messages] })).success, false);
  assert.equal((await h.invoke('rag:sync-messages', { ...sync, messages: [sync.messages[0], sync.messages[0]] })).success, false);
  assert.equal(h.messages().length, 1, 'Invalid snapshot cannot silently replace original messages');
  assert.equal((await h.lock('end')).success, true);
  assert.equal(h.sandbox.isDataRestoreActive(), false);
  assert.equal((await h.invoke('rag:restore', restore)).success, false, 'Expired tokens cannot write after unlock');
  assert.equal((await h.invoke('rag:search', { query: 'Allowed again' })).success, true);
}

async function testPendingEmbeddingInvalidation() {
  for (const merge of [false, true]) {
    const wait = deferred();
    const h = load({ embeddings: merge ? [null, wait] : [wait],
      mergeTarget: merge ? { id: 'merged', text: 'Earlier', score: 1 } : null });
    const pending = h.invoke('rag:save', { id: 'old', text: 'Old input', tier: merge ? 'episodic' : 'core' });
    if (merge) await new Promise(setImmediate);
    assert.equal(h.embeddingCalls(), merge ? 2 : 1);
    assert.equal((await h.lock('begin')).success, true);
    assert.equal((await h.invoke('rag:restore', { vectors: [vector('restored')], restoreSessionId: 'session' })).success, true);
    assert.equal((await h.lock('end')).success, true);
    const writes = h.writes();
    wait.resolve(new Float32Array(dimension));
    assert.equal((await pending).success, false);
    assert.equal(h.writes(), writes, 'Pre-restore embedding cannot write even after restore has ended');
    assert.deepEqual(Array.from(h.vectors().keys()), ['restored']);
  }
}

async function testBusyAndTransactionSafety() {
  const h = load();
  h.sandbox.activeRebuildJob = { id: 'running' };
  assert.equal((await h.lock('begin')).success, false);
  assert.equal(h.sandbox.ragGeneration, 0);
  assert.ok(h.sandbox.activeRebuildJob, 'Restore never cancels a running rebuild');
  h.sandbox.activeRebuildJob = null;
  for (const invalid of [null, { id: '', action: 'begin' }, { id: 's', action: 'cancel' }]) {
    assert.equal((await h.invoke('rag:restore-lock', invalid)).success, false);
  }
  const wait = deferred();
  const busy = load({ indexWait: wait });
  const restoring = busy.invoke('rag:restore', [vector('indexing')]);
  assert.equal((await busy.lock('begin')).success, false, 'Existing HNSW rebuilding blocks restore begin');
  wait.resolve();
  assert.equal((await restoring).success, true);
  const lockedWait = deferred();
  const locked = load({ indexWait: lockedWait });
  assert.equal((await locked.lock('begin')).success, true);
  const lockedRestore = locked.invoke('rag:restore', { vectors: [vector('indexing')], restoreSessionId: 'session' });
  assert.equal((await locked.lock('end')).success, false, 'Owner cannot unlock while its index replacement is pending');
  lockedWait.resolve();
  assert.equal((await lockedRestore).success, true);
  assert.equal((await locked.lock('end')).success, true);
  const fail = load({ failInsertId: 'broken' });
  assert.equal((await fail.invoke('rag:restore', [vector('original')])).success, true);
  await fail.lock('begin');
  assert.equal((await fail.invoke('rag:restore', { vectors: [vector('replacement'), vector('broken')], restoreSessionId: 'session' })).success, false);
  assert.deepEqual(Array.from(fail.vectors().keys()), ['original'], 'Failed SQLite insert rolls back all replacements');
  const clears = fail.clears();
  assert.equal((await fail.invoke('rag:restore', { vectors: [vector('bad', { vector: [NaN] })], restoreSessionId: 'session' })).success, false);
  assert.equal(fail.clears(), clears, 'Invalid vectors are rejected before deleting rows');
  assert.equal((await fail.invoke('rag:status')).restoreActive, true, 'Failed writes keep isolation for rollback');
}

(async () => {
  await testNormalCompatibility();
  await testIsolationAndOwnership();
  await testMemoryPreparationAbort();
  const reset = load();
  assert.equal((await reset.invoke('rag:restore-lock', { action: 'begin', id: 'reset-id', kind: 'reset' })).success, true);
  const owner = reset.sandbox.restoreLock.sender;
  assert.equal(reset.sandbox.isDataResetOwner({ sender: owner }, 'reset-id'), true);
  assert.equal(reset.sandbox.isDataResetOwner({ sender: owner }, 'wrong'), false);
  assert.equal(reset.sandbox.isDataResetOwner({ sender: reset.stranger }, 'reset-id'), false);
  assert.equal((await reset.invoke('rag:restore-lock', { action: 'begin', id: 'reset-id' })).success, false, 'lock kind cannot be changed');
  assert.equal((await reset.invoke('rag:restore-lock', { action: 'end', id: 'reset-id' })).success, true);
  await testPendingEmbeddingInvalidation();
  await testBusyAndTransactionSafety();
  const preload = fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8');
  assert.ok(preload.includes("'rag:restore-lock'"));
  console.log('Native RAG restore isolation: compatibility, ownership, snapshot reads, stale embeddings, and transaction rollback passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
