#!/usr/bin/env node
'use strict';
// Execute the actual A9-A12 chat branch and queued persistence services. All
// model, UI, clock and storage boundaries are synthetic; no user data/network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { AsyncLocalStorage } = require('node:async_hooks');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const quiet = { log() {}, warn() {}, error() {} };
const text = file => fs.readFileSync(path.join(root, file), 'utf8');
const transpile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const chat = text('components/app/chatActions.ts');
const coreAt = chat.indexOf('async function executeSendCore(');
const helperAt = chat.indexOf('  const restoreVersion =', coreAt);
const helpers = chat.slice(helperAt, chat.indexOf('\n  const {', helperAt));
const branchAt = chat.indexOf('    if (catchUpContexts.length) modelRagContext.push', coreAt);
const branch = chat.slice(branchAt, chat.indexOf('  } catch (e: unknown) {', branchAt));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

function harness(options = {}) {
  let cancelled = false, version = 'before', blocked = false, target = options.target;
  const entered = deferred(), release = deferred();
  const effects = [], calls = [], timers = [];
  const source = { id: 'user', role: 'user', text: 'real input', timestamp: 1000 };
  let rows = { keyval: {}, messages: { user: structuredClone(source) }, kumikoMood: {}, kumikoAffection: {}, psycheState: {}, stateCommits: {}, memoryDependencies: {}, kumikoDiary: {}, dailyFragments: {} };
  const transactionContext = new AsyncLocalStorage(); let queue = Promise.resolve(), draftInFlight;
  const gate = async label => {
    calls.push(label);
    if (label === target) { target = null; entered.resolve(); await release.promise; }
  };
  const db = { transaction(...args) {
    const work = args.at(-1);
    if (transactionContext.getStore()) return work();
    const run = queue.then(async () => {
      const draft = structuredClone(rows); draftInFlight = draft;
      try {
        const value = await transactionContext.run(draft, work);
        rows = draft; return value;
      } finally { draftInFlight = undefined; }
    });
    queue = run.catch(() => {}); return run;
  } };
  for (const table of Object.keys(rows)) db[table] = {
    async get(id) { await gate(`read:${table}`); return structuredClone((transactionContext.getStore() || rows)[table][id]); },
    async put(value) { await gate(`write:${table}`); (transactionContext.getStore() || rows)[table][value.key || value.id] = structuredClone(value); },
    async delete(id) { delete (transactionContext.getStore() || rows)[table][id]; },
  };
  db.getVal = async (key, fallback) => (await db.keyval.get(key))?.value ?? fallback;
  const restore = { getDataRestoreVersion: () => version, isDataRestoreBlocked: () => blocked };
  const state = { messages: [], anchors: [], mood: null, affection: null, currentEmotion: 'neutral',
    setMood(value) { effects.push('mood-mirror'); this.mood = value; },
    setAffection(value) { effects.push('affection-mirror'); this.affection = value; },
    setBlockRuntime(value) { effects.push('block-mirror'); this.blockRuntime = value; },
    setAnchors(value) { effects.push('anchor'); this.anchors = typeof value === 'function' ? value(this.anchors) : value; },
    setMessages(fn) { effects.push('messages'); this.messages = fn(this.messages); },
    setCurrentEmotion(value) { effects.push('emotion'); this.currentEmotion = value; },
    setIsDisconnected() { effects.push('connected'); }, setSystemNotice() { effects.push('notice'); },
    setIsThinking() { effects.push('thinking'); }, setIsTalking() { effects.push('talking'); },
    setTurnCount() { effects.push('count'); }, setSummaryArchiveState() { effects.push('summary-state'); },
    setRagStatus() { effects.push('rag-status'); },
  };
  const store = { useAppStore: { getState: () => state } };
  const modules = {};
  function load(file, dependencies) {
    const module = { exports: {} };
    vm.runInNewContext(transpile(text(file)), { module, exports: module.exports, console: quiet, Date, crypto: webcrypto, TextEncoder, require(id) {
      if (Object.hasOwn(dependencies, id)) return dependencies[id]; throw new Error('Unexpected import: ' + id);
    } }); return module.exports;
  }
  const memoryGate = { getMemoryGeneration: () => 'initial', assertMemoryAvailable() {}, async assertMemoryGenerationCurrent() {} };
  const commit = load('services/responseEffectCommit.ts', { './db': { db }, './dataRestoreGate': restore, './memoryMaintenanceGate': memoryGate,
    './taskRuntime': { assertTaskModelRevisionsCurrent: async () => {} }, './artifactIndexService': { assertSourceRefsCurrent: async () => {} } });
  const provenance = load('services/stateProvenance.ts', { './db': { db } });
  for (const name of ['mood', 'affection']) modules[`../../services/${name}Service`] = load(`services/${name}Service.ts`, {
    './db': { db }, './responseEffectCommit': commit,
  });
  modules['../../services/blockRuntimeService'] = load('services/blockRuntimeService.ts', {
    '../store': store, './db': { db }, './responseEffectCommit': commit,
    './environment': { isCapacitorNative: () => true, getCapacitorPlatform: () => 'android' },
    './androidAlarmService': { scheduleAndroidAlarm: async () => { await gate('native-block'); effects.push('native-block'); } },
  });
  modules['../../services/stateCommit'] = load('services/stateCommit.ts', {
    './db': { db }, './responseEffectCommit': commit, './memoryMaintenanceGate': memoryGate,
    './moodService': modules['../../services/moodService'], './affectionService': modules['../../services/affectionService'],
    './blockRuntimeService': modules['../../services/blockRuntimeService'], '../store': store, './stateProvenance': provenance,
  });
  modules['../../services/affectionAuditService'] = { reviewAffectionDirective: async () => { await gate('audit'); return { approved: true }; } };
  modules['../../services/voiceWriteLedger'] = { finishVoiceWrite: async () => true };
  modules['../../services/preferencesSync'] = { noteKeyvalPreferenceWrite() {} };
  const psyche = load('services/psycheStateService.ts', { './db': { db }, './kumikoStateMachine': {} });
  const psycheCommit = load('services/responsePsycheCommit.ts', { './db': { db }, './psycheStateService': psyche, './responseEffectCommit': commit, './stateProvenance': provenance });
  const response = { responseEventId: 'same-response', textParts: ['reply one', 'reply two'], emotion: 'happy',
    moodDelta: 5, affectionDelta: 2, blockDirective: { minutes: 1, reason: 'pause' },
    anchorAction: { type: 'add', content: 'anchor' }, psycheDelta: { stress: 5, energy: 0, relaxation: 0 },
    activateSleepMode: true };
  let frozen;
  const runtime = {
    signal: new AbortController().signal,
    prepare: () => gate('prepare'), getResponse: () => frozen,
    finishResponse: () => gate('finish'), saveResponse: async value => { await gate('freeze'); frozen = structuredClone(value); },
    checkDelivery: () => gate('delivery'), createdReminder: () => false, responseMessageId: i => 'reply:' + i,
  };
  const ctx = { isCancelled: () => cancelled, ttsConfig: { voiceMode: options.voice ? 'full' : 'text', ttsBackend: 'sovits' },
    pendingMessageIds: new Set(['user']), getMessagesSnapshot: () => state.messages,
    markPendingRead: () => effects.push('read'),
    runVoicePipeline: async () => { await gate('voice'); effects.push('voice-result'); return { success: true, voiceFileId: 'voice' }; },
    setHasGoneToSleep: () => effects.push('sleep'),
    getRecentRagDedupeKeys: () => [], appendRagDedupeKey: () => effects.push('rag-dedupe'),
    setSummaryRunning() {}, summaryEmbeddingCache: new Map(), getSummaryRunning: () => false,
  };
  const sandbox = { console: quiet, Date, Intl, AbortController, ctx, db, ...restore, ...commit, ...provenance,
    createStandaloneContext: () => ({ consultedSources: [], modelRevisions: {} }),
    useAppStore: store.useAppStore, require: id => { if (modules[id]) return modules[id]; throw new Error('Unexpected branch import: ' + id); },
    Math: Object.assign(Object.create(Math), { random: () => 0.8 }),
    document: { hidden: false, hasFocus: () => true }, language: 'en', combinedText: 'real input', apiImage: undefined, catchUpContexts: [], modelRagContext: [],
    turnRuntime: runtime, source, responseForModel: response, scheduleSlot: {}, apologyInjectedThisTurn: false,
    currentTurnStartMessageId: 'user', userTextForRag: source.text, isImageMessage: false,
    isVoiceServiceAvailable: () => true,
    sendMessageToGemini: async () => { await gate('model'); return structuredClone(response); },
    addMessageToStore(role, value, image, mime, id) { effects.push('visible'); state.messages.push({ id, role, text: value, timestamp: 2000 }); return id; },
    commitAcceptedResponsePsyche: async (reply, id, guard) => psycheCommit.commitVisibleResponsePsyche(reply, state.messages.find(m => m.id === id), guard),
    showBackgroundNotification: () => effects.push('notification'),
    backupConfig: { ragEnabled: true }, evaluateRagMemoryCandidate: () => ({ shouldStore: true, dedupeKey: 'key', tier: 'short' }),
    hasRecentRagDuplicate: () => false, mapRagDecisionTierToStorageTier: () => 'short',
    saveLocalRagMemory: async () => { await gate('rag'); effects.push('rag'); },
    turnCount: 0, summaryArchiveState: { activeSegmentId: 'segment' }, coreMemory: '',
    buildSummarySegmentId: () => 'segment', getTurnsInActiveSummarySegment: () => 0,
    SUMMARY_SOFT_THRESHOLD: 20, gapSincePreviousTurnMinutes: 1,
    evaluateSummaryBoundary: () => ({ shouldSummarize: !!options.summary, reason: options.summary ? 'boundary' : null, turnsInSegment: 1 }),
    calculateSummaryContinuationSignalStandalone: async () => { await gate('summary-continuation'); return null; },
    triggerAutoSummary: async () => { await gate('summary-start'); effects.push('summary-start'); },
    setTimeout(fn, ms) { if (ms === 1000 || ms === 2000) timers.push(fn); else return gate('typing').then(fn); return 1; },
  };
  for (const name of ['modelCoreMemory','modelWorldBook','modelHistorySlice','locationConfig','mimeType','modelExactHistoryLookup','modelActiveReminders','modelAnchors','modelNotebook','modelMissedReminders','promptMood','promptAffection','promptLastEmotion','hybridVoicePrompt']) sandbox[name] = undefined;
  const run = () => vm.runInNewContext(transpile(`(async () => {
    let replyGuard = await createResponseEffectGuard({ eventId: 'user', isCancelled: ctx.isCancelled, sources: [source] });
    ${helpers}
    ${branch}
  })()`), sandbox);
  return { run, state, effects, calls, timers, rows: () => structuredClone(rows), entered: entered.promise, release: release.resolve,
    cancel(mode) {
      if (mode === 'restore') version = 'restored';
      else if (mode === 'source') {
        rows.messages.user.text = 'edited input';
        if (draftInFlight) draftInFlight.messages.user.text = 'edited input';
      }
      else if (mode === 'epoch') {
        const row = { key: 'kumiko_turn_epoch_v1', value: 'restored' };
        rows.keyval.kumiko_turn_epoch_v1 = row;
        // Expose a changed epoch at the precise guarded boundary. Real restore
        // transactions serialize; the version latch covers the time in queue.
        if (draftInFlight) draftInFlight.keyval.kumiko_turn_epoch_v1 = row;
      }
      else cancelled = true;
    }, reset() { cancelled = false; },
  };
}

(async () => {
  for (const voice of [false, true]) {
    const h = harness({ voice }); await h.run();
    assert.equal(h.state.anchors.length, 1);
    assert.equal(h.rows().kumikoMood.current.mood, 5);
    assert.equal(h.rows().kumikoAffection.current.score, 57);
    assert.equal(h.rows().psycheState.current.stress, 35);
    const visible = h.state.messages.length;
    await h.run(); // Frozen-response retry must retain all once-only outcomes.
    assert.equal(h.state.messages.length, visible);
    assert.equal(h.state.anchors.length, 1);
    assert.equal(h.rows().kumikoMood.current.mood, 5);
    assert.equal(h.rows().kumikoAffection.current.score, 57);
    assert.equal(h.rows().psycheState.current.stress, 35);
  }
  let cases = 0;
  for (const mode of ['cancel', 'restore', 'epoch']) for (const stage of ['prepare','model','finish','freeze','audit','write:kumikoMood','write:kumikoAffection','write:keyval','delivery','voice','typing','write:psycheState','summary-continuation']) {
    const h = harness({ target: stage, voice: stage === 'voice', summary: stage === 'summary-continuation' });
    const pending = h.run();
    await Promise.race([h.entered, pending.then(() => { throw new Error('Missing fault boundary: ' + stage); })]);
    h.cancel(mode); const effectCount = h.effects.length;
    h.release(); await assert.rejects(pending, /cancel|restor|epoch/i, `${mode} during ${stage}`);
    // A provider/TTS request already started can return; its result cannot
    // start a new UI/state operation in the old production continuation.
    const tail = h.effects.slice(effectCount).filter(effect => effect !== 'voice-result');
    assert.deepEqual(tail, [], `${mode} during ${stage}: ${tail}`);
    assert.equal(h.rows().messages.user.text, 'real input', 'cancellation preserves already read evidence');
    if (stage === 'write:kumikoMood') assert.equal(h.rows().kumikoMood.current, undefined, 'cancelled transaction rolled back');
    if (stage === 'write:kumikoAffection') {
      assert.equal(h.rows().kumikoMood.current, undefined, 'reaction group rolls back together');
      assert.equal(h.rows().kumikoAffection.current, undefined, 'later candidate rolls back');
    }
    cases++;
  }
  {
    const h = harness({ target: 'write:kumikoMood' });
    const pending = h.run(); await h.entered; h.cancel('source'); h.release();
    await assert.rejects(pending, /source/i);
    assert.equal(h.rows().kumikoMood.current, undefined, 'edited source aborts queued transaction');
  }
  for (const stage of ['write:kumikoMood', 'write:kumikoAffection', 'write:psycheState']) {
    const h = harness({ target: stage });
    const pending = h.run(); await h.entered; h.cancel('cancel'); h.release();
    await assert.rejects(pending, /cancel/i);
    h.reset(); await h.run();
    assert.equal(h.rows().kumikoMood.current.mood, 5, `${stage}: mood applied once`);
    assert.equal(h.rows().kumikoAffection.current.score, 57, `${stage}: affection applied once`);
    assert.equal(h.rows().psycheState.current.stress, 35, `${stage}: visible reply psyche recovered`);
    assert.equal(h.rows().keyval.kumiko_anchors.value.length, 1, `${stage}: anchor persisted once`);
  }
  const timer = harness({ summary: true }); await timer.run(); const before = timer.effects.length;
  timer.cancel('restore'); for (const fn of timer.timers) fn();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(timer.effects.length, before, 'old delayed summary/talking callbacks cannot write into restored UI');
  console.log(`Chat cancellation passed: ${cases} delayed production boundaries, text/voice success, frozen retries, committed-state retention, restore timers.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
