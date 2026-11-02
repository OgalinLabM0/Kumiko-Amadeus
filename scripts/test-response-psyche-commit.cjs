#!/usr/bin/env node
'use strict';

// F09: execute production candidate parsing, response post-processing, delivery
// branches and transactional commit with isolated model/storage/UI boundaries.
// No private data, real databases, network or paid model calls are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { AsyncLocalStorage } = require('node:async_hooks');
const { webcrypto } = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const quiet = { log() {}, warn() {}, error() {} };
const now = 1_800_000_000_000;
class Clock extends Date { static now() { return now; } }
function transpile(source, filename) {
  return ts.transpileModule(source, { fileName: filename, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
}
function load(file, deps = {}, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(transpile(fs.readFileSync(path.join(root, file), 'utf8'), file), {
    module, exports: module.exports, console: quiet, Date: Clock, crypto: webcrypto, TextEncoder,
    require(id) {
      if (Object.hasOwn(deps, id)) return deps[id];
      if (id === './memoryMaintenanceGate') return { getMemoryGeneration: () => 'initial', assertMemoryAvailable() {}, async assertMemoryGenerationCurrent() {} };
      if (id === './taskRuntime') return { assertTaskModelRevisionsCurrent: async () => {} };
      if (id === './artifactIndexService') return { assertSourceRefsCurrent: async () => {} };
      if (id === './stateProvenance') return { recordStateProvenance: async () => {} };
      if (id === '../services/dataRestoreGate') return { isDataRestoreBlocked: () => false, getDataRestoreVersion: () => 'test' };
      if (id === '../services/memoryMaintenanceGate') return { isMemoryMaintenanceBlocked: () => false, getMemoryGeneration: () => 'initial' };
      throw new Error(`Unexpected dependency ${id} in ${file}`);
    }, ...globals,
  }, { filename: file });
  return module.exports;
}
function portion(file, start, end) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `production section ${start}`);
  return source.slice(from, to);
}
function storage() {
  let rows = { psyche: { id: 'current', stress: 30, energy: 80, relaxation: 50, lastUpdated: now }, messages: {}, keyval: {} };
  const context = new AsyncLocalStorage();
  let queue = Promise.resolve();
  let failMarker = false;
  const active = () => context.getStore() ?? rows;
  const db = {
    psycheState: {
      get: async () => structuredClone(active().psyche),
      put: async value => {
        if (failMarker && value.committedResponseEvents) throw new Error('marker disk failure');
        active().psyche = structuredClone(value);
      },
    },
    keyval: { get: async key => structuredClone(active().keyval[key]), put: async row => { active().keyval[row.key] = structuredClone(row); } },
    messages: { get: async id => structuredClone(active().messages[id]), put: async value => { active().messages[value.id] = structuredClone(value); },
      add: async value => { if (active().messages[value.id]) throw new Error('duplicate message'); active().messages[value.id] = structuredClone(value); } },
    transaction: (...args) => {
      const run = args.at(-1);
      if (context.getStore()) return run();
      const task = queue.then(async () => {
        const staged = structuredClone(rows);
        const value = await context.run(staged, run);
        rows = staged;
        return value;
      });
      queue = task.catch(() => {});
      return task;
    },
  };
  const psyche = load('services/psycheStateService.ts', { './db': { db }, './kumikoStateMachine': {} });
  const effect = load('services/responseEffectCommit.ts', { './db': { db }, './dataRestoreGate': { getDataRestoreVersion: () => 'test', isDataRestoreBlocked: () => false } });
  const reload = () => load('services/responsePsycheCommit.ts', { './db': { db }, './psycheStateService': psyche, './responseEffectCommit': effect });
  return { db, reload, effect, get: () => structuredClone(rows), fail: value => { failMarker = value; } };
}
const candidate = load('services/responsePsycheCandidate.ts');
const response = (id = 'response-test') => ({ responseEventId: id, psycheDelta: { stress: 5, energy: 0, relaxation: 0 }, textParts: ['one', 'two'], emotion: 'neutral', groundingSources: [] });
const message = id => ({ id, role: 'model', text: 'visible', timestamp: now });

async function testCommit() {
  const h = storage();
  let api = h.reload();
  assert.equal(await api.commitVisibleResponsePsyche(response(), message('m1')), true);
  assert.equal(h.get().psyche.stress, 35);
  assert.equal(h.get().psyche.committedResponseEvents['response-test'].messageId, 'm1');
  assert.ok(h.get().messages.m1);
  assert.equal(await api.commitVisibleResponsePsyche(response(), message('m2')), false);
  api = h.reload(); // Simulate renderer restart: no WeakSet/closure survives.
  assert.equal(await api.commitVisibleResponsePsyche(JSON.parse(JSON.stringify(response())), message('m3')), false);
  assert.equal(h.get().psyche.stress, 35);
  const results = await Promise.all([
    api.commitVisibleResponsePsyche(response('response-concurrent'), message('m4')),
    api.commitVisibleResponsePsyche(response('response-concurrent'), message('m5')),
  ]);
  assert.deepEqual(results, [true, false]);
  assert.equal(h.get().psyche.stress, 39, 'actual damping runs only for a new event');
  for (const bad of [
    { ...response(), responseEventId: undefined },
    { ...response(), psycheDelta: { stress: Infinity, energy: 0, relaxation: 0 } },
  ]) assert.equal(await api.commitVisibleResponsePsyche(bad, message('bad')), false);
  assert.equal(await api.commitVisibleResponsePsyche(response('user'), { ...message('user'), role: 'user' }), false);
  assert.equal(await api.commitVisibleResponsePsyche(response('hidden'), { ...message('hidden'), isHidden: true }), false);
  const before = h.get(); h.fail(true);
  await assert.rejects(api.commitVisibleResponsePsyche(response('retry'), message('retry')), /marker disk failure/);
  assert.deepEqual(h.get(), before, 'message, state and marker all roll back');
  h.fail(false);
  assert.equal(await api.commitVisibleResponsePsyche(response('retry'), message('retry')), true);
}

async function testParserRewrite() {
  assert.equal(candidate.parseResponsePsycheDelta('Psyche_Delta: stress 0, energy 0, relaxation 0'), undefined);
  assert.equal(candidate.parseResponsePsycheDelta('Psyche_Delta: stress 5, energy 0, relaxation 3.4]'), undefined);
  assert.equal(candidate.parseResponsePsycheDelta(`Psyche_Delta: stress ${'9'.repeat(400)}, energy 0, relaxation 0]`), undefined);
  assert.equal(JSON.stringify(candidate.parseResponsePsycheDelta('Psyche_Delta: stress +99, energy -40, relaxation 3]')), JSON.stringify({ stress: 5, energy: -5, relaxation: 3 }));
  // Execute the actual post-generation body, including its recursive rewrite
  // guard. The provider/tool section is excluded to avoid model/network calls.
  const body = portion('services/geminiService.ts', '    const locationExtraction =', '  } catch (error: any) {');
  const context = {
    console: quiet, ...candidate, ...load('services/userKnownLocation.ts', { './db': {} }), isSystemDrivenTurn: false, result: {}, historyMessages: [], textMessage: 'hello',
    coreMemory: '', worldBook: [], locationConfig: {}, imageBase64: undefined, mimeType: '',
    previousContextLog: undefined, ragContext: [], exactHistoryLookup: undefined,
    activeReminders: [], anchors: [], kumikoNotebook: '', modelOverride: undefined,
    language: 'en', extraSystemPrompt: undefined, missedReminders: [], mood: undefined,
    affection: undefined, lastEmotion: undefined, currentModel: 'isolated', retryCount: 0,
    KUMIKO_EMOTION_IMAGES: { neutral: 'image' }, EMOTION_MAPPING: {},
    getUnsupportedKumikoThoughtLiteralIssue: () => null,
    activateSleepModeAfterResponse: false, isStrictMemoryLookupTurn: false,
    isMemoryPlannedTurn: false, applyMemoryResponsePlanToTextParts: value => value,
    tavilyGroundingSources: [], turnRuntime: undefined, standaloneTaskContext: undefined, activeTaskContext: undefined,
  };
  const parser = vm.runInNewContext(transpile(`(async () => { ${body} })`, 'production-response-parser.ts'), context);
  context.sendMessageToGemini = async (...args) => {
    context.retryCount = args[7];
    context.result = { text: '[[System_Log: [Emotion: neutral] [Psyche_Delta: stress +5, energy 0, relaxation 0]]]second' };
    return parser();
  };
  context.result = { text: '[[System_Log: [Emotion: neutral] [Psyche_Delta: stress +5, energy 0, relaxation 0]]]first，rewrite' };
  const final = await parser();
  assert.equal(final.textParts[0], 'second');
  assert.equal(final.psycheDelta.stress, 5);
  const h = storage();
  assert.equal(h.get().psyche.stress, 30, 'both generation passes are pure');
  await h.reload().commitVisibleResponsePsyche(final, message('rewritten'));
  assert.equal(h.get().psyche.stress, 35, 'only visible rewritten response applies');
}

function chatHarness() {
  const h = storage();
  const state = {
    language: 'en', contextLimit: 10, coreMemory: '', worldBook: [], anchors: [], kumikoNotebook: '',
    locationConfig: { modelTimezone: 'Asia/Tokyo', userTimezone: 'Asia/Shanghai' }, messages: [], missedReminders: [],
    isTalking: false, isThinking: false, busyFollowUp: null,
    setMessages(value) { this.messages = typeof value === 'function' ? value(this.messages) : value; },
    setIsThinking(value) { this.isThinking = value; }, setIsTalking(value) { this.isTalking = value; },
    setCurrentEmotion() {}, setSystemNotice() {},
    setMessageAlerts(value) { this.messageAlerts = value(this.messageAlerts ?? []); },
    setVoiceCallOverlayData(value) { this.voiceCallOverlayData = typeof value === 'function' ? value(this.voiceCallOverlayData) : value; },
    consumePendingCallAction() { return this.callAction ?? null; },
  };
  let modelResponse = response();
  let timerAction = () => {};
  const deps = {
    '../../store': { useAppStore: { getState: () => state } },
    '../../constants': { KUMIKO_LOCAL_RAG_EN: [], KUMIKO_LOCAL_RAG_ZH: [] },
    '../../services/geminiService': { sendMessageToGemini: async () => structuredClone(modelResponse) },
    '../../services/voiceFileService': { isVoiceServiceAvailable: () => true, loadVoiceFile: async () => null },
    '../../services/desktopBackupService': { isDesktopElectron: () => false },
    '../../services/db': { db: h.db },
    '../../services/dataRestoreGate': { isDataRestoreBlocked: () => false, getDataRestoreVersion: () => 'test' },
    '../../services/memoryMaintenanceGate': { getMemoryGeneration: () => 'initial', assertMemoryGenerationCurrent: async () => {} },
    '../../services/taskRuntime': { beginForegroundActivity: async () => {}, endForegroundActivity: async () => {}, assertTaskModelRevisionsCurrent: async () => {} },
    '../../services/artifactIndexService': { assertSourceRefsCurrent: async () => {} },
    '../../services/responseEffectCommit': h.effect,
    '../../services/receivedTurns': { seedReceivedTurns: async () => {}, readReceivedTurns: async () => [], hasUnreadReceivedTurns: async () => false },
    '../../services/responsePsycheCommit': h.reload(),
    '../../services/reminderVoiceCommit': load('services/reminderVoiceCommit.ts', { './db': { db: h.db }, '../components/app/messageMappers': load('components/app/messageMappers.ts') }),
    '../../services/reminderPrewarmService': load('services/reminderPrewarmService.ts', {}, { AbortController }),
    '../../services/reminderPrompt': load('services/reminderPrompt.ts', { './reminderTime': load('services/reminderTime.ts') }),
    './messageMappers': load('components/app/messageMappers.ts'),
  };
  const filename = 'components/app/chatActions.ts';
  const module = { exports: {} };
  const document = { hidden: false, hasFocus: () => true };
  const globals = { module, exports: module.exports, console: quiet, Date: Clock, Intl, AbortController, crypto: webcrypto, TextEncoder,
    document, window: {}, setTimeout(fn, ms) { if (ms < 20_000) { timerAction(ms); fn(); } return 1; },
    require(id) { return deps[id] ?? {}; },
  };
  vm.runInNewContext(transpile(fs.readFileSync(path.join(root, filename), 'utf8'), filename), globals);
  return { ...h, api: module.exports, state, deps, globals, document,
    setResponse(value) { modelResponse = value; }, onTimer(value) { timerAction = value; },
  };
}

async function testDeliveryRoutes() {
  const h = chatHarness();
  const refs = { messagesRef: { current: [] }, ttsConfigRef: { current: { voiceMode: 'text' } }, welcomeTriggeredRef: { current: false } };
  const helpers = { runVoicePipeline: async () => ({ success: false }) };
  assert.equal(await h.api.triggerNativeProactiveMessage(refs, 1, 'after work'), true);
  assert.equal(h.get().psyche.stress, 35);
  assert.equal(Object.keys(h.get().psyche.committedResponseEvents).length, 1);

  h.setResponse(response('response-busy')); h.state.isTalking = false; h.state.isThinking = false;
  const followUp = { id: 'busy-task', slotDescription: 'class', unreadUserMessageIds: [] };
  const prepared = await h.api.prepareBusyFollowUpResponse(followUp);
  assert.equal(h.get().psyche.stress, 35, 'busy draft generation stays silent');
  Object.assign(followUp, { preparedTextParts: prepared.textParts, preparedEmotion: prepared.emotion, preparedResponseEventId: prepared.responseEventId, preparedPsycheDelta: prepared.psycheDelta, preparedMemoryGeneration: prepared.memoryGeneration, preparedRestoreVersion: prepared.restoreVersion, preparedSourceRevisions: prepared.sourceVersions });
  h.state.busyFollowUp = followUp;
  assert.equal(await h.api.displayPreparedProactiveMessage(followUp), true);
  assert.equal(h.get().psyche.stress, 39);
  h.state.isTalking = false;
  await h.api.displayPreparedProactiveMessage(JSON.parse(JSON.stringify(followUp)));
  assert.equal(h.get().psyche.stress, 39, 'persisted busy payload cannot apply twice');
  h.state.isTalking = false; h.onTimer(() => { h.state.busyFollowUp = null; });
  assert.equal(await h.api.displayPreparedProactiveMessage(followUp), false);
  assert.equal(h.get().psyche.stress, 39, 'preempted draft is discarded'); h.onTimer(() => {});

  const prewarm = chatHarness();
  const prewarmRefs = { messagesRef: { current: [] }, ttsConfigRef: { current: { voiceMode: 'text' } } };
  await prewarm.api.prewarmTimedReminderMessage(prewarmRefs, helpers, { id: 'reminder', event: 'medicine', dueAt: now + 60_000 });
  assert.equal(prewarm.get().psyche.stress, 30);
  assert.equal(await prewarm.api.triggerTimedReminderMessage(prewarmRefs, helpers, { event: 'medicine' }, 'reminder'), true);
  assert.equal(prewarm.get().psyche.stress, 35, 'prewarm applies when delivered');
  prewarm.setResponse(response('cancelled-prewarm'));
  await prewarm.api.prewarmTimedReminderMessage(prewarmRefs, helpers, { id: 'cancelled', event: 'medicine', dueAt: now + 60_000 });
  prewarm.deps['../../services/reminderPrewarmService'].cancelReminderPrewarm('cancelled');
  assert.equal(prewarm.get().psyche.stress, 35, 'cancelled prewarm does not apply');

  for (const action of ['accept', 'accept-voice', 'double-accept', 'reject', 'close', 'decline', 'accept-then-close', 'foreground', 'foreground-voice']) {
    const reminder = chatHarness();
    reminder.document.hidden = !action.startsWith('foreground');
    if (action === 'decline') reminder.state.callAction = 'decline';
    const voiceRefs = { messagesRef: { current: [] }, ttsConfigRef: { current: { voiceMode: 'full', ttsBackend: 'sovits' } } };
    let release;
    const voice = action === 'accept-then-close' ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ success: action.endsWith('-voice'), voiceFileId: 'voice-file' });
    const pending = reminder.api.triggerTimedReminderMessage(voiceRefs, { runVoicePipeline: () => voice }, { event: 'medicine' });
    for (let i = 0; i < 100 && !reminder.state.voiceCallOverlayData; i++) await new Promise(resolve => setImmediate(resolve));
    if (action === 'accept' || action === 'accept-voice') await reminder.state.voiceCallOverlayData.onAccept();
    if (action === 'double-accept') {
      const overlay = reminder.state.voiceCallOverlayData;
      await Promise.all([overlay.onAccept(), overlay.onAccept()]);
      assert.equal(reminder.state.messages.length, 1, 'duplicate accepts insert once');
    }
    if (action === 'reject') reminder.state.voiceCallOverlayData.onReject();
    if (action === 'close') reminder.state.voiceCallOverlayData.onClose();
    if (action === 'accept-then-close') {
      const overlay = reminder.state.voiceCallOverlayData;
      const accepting = overlay.onAccept(); overlay.onClose(); release({ success: false }); await accepting;
    }
    assert.equal(await pending, true);
    assert.equal(reminder.get().psyche.stress, ['accept', 'accept-voice', 'double-accept', 'foreground', 'foreground-voice'].includes(action) ? 35 : 30, action);
    assert.equal(reminder.state.isTalking, false, `${action}: cancelled or settled overlay clears activity`);
  }
}

async function testNormalChatBranches() {
  // Exercise the actual delivery section while excluding upstream retrieval,
  // reminders and model calls unrelated to F09.
  const section = portion('components/app/chatActions.ts', '// --- A-11 VOICE / TEXT DELIVERY ---', '    if (response.activateSleepMode) {');
  const body = section.slice(section.indexOf('ctx.markPendingRead();'));
  for (const mode of ['text', 'voice-success', 'voice-failed', 'cancel-text', 'cancel-voice', 'cancel-typo']) {
    const h = chatHarness(); let cancelled = false;
    const ctx = { ttsConfig: { voiceMode: mode.includes('voice') ? 'full' : 'text', ttsBackend: 'sovits' }, getMessagesSnapshot: () => h.state.messages,
      markPendingRead() {}, isCancelled: () => cancelled,
      runVoicePipeline: async () => {
        if (mode === 'cancel-voice') cancelled = true;
        return { success: mode === 'voice-success', voiceFileId: 'voice-file' };
      },
    };
    h.onTimer(ms => { if (mode === 'cancel-text' || (mode === 'cancel-typo' && ms === 600)) cancelled = true; });
    // A fixed random value avoids cosmetic temporary typo/recall bubbles.
    const sandbox = { ...h.globals, ctx, response: { ...response(mode), textParts: ['first real response', 'two'], emotion: mode === 'cancel-typo' ? 'angry' : 'neutral' }, language: 'en',
      useAppStore: h.deps['../../store'].useAppStore, isVoiceServiceAvailable: () => true,
      turnRuntime: { checkDelivery: async () => {}, responseMessageId: index => mode + ':reply:' + index, signal: new AbortController().signal },
      replyStep: async promise => { const value = await promise; if (cancelled) throw new Error('cancelled'); return value; },
      replyGuard: { check: async () => {} }, isReplyActive: () => !cancelled,
      Math: Object.assign(Object.create(Math), { random: () => mode === 'cancel-typo' ? 0.1 : 0.8 }),
      addMessageToStore: h.api.addMessageToStore, showBackgroundNotification() {},
      commitAcceptedResponsePsyche: async (reply, id) => {
        const row = h.deps['./messageMappers'].mapMessageToEntity(h.state.messages.find(m => m.id === id));
        return h.reload().commitVisibleResponsePsyche(reply, row);
      },
    };
    try { await vm.runInNewContext(transpile(`(async () => { ${body} })()`, 'production-delivery.ts'), sandbox); }
    catch (error) { if (!mode.startsWith('cancel') || !/cancelled/.test(error.message)) throw error; }
    assert.equal(h.get().psyche.stress, mode.startsWith('cancel') ? 30 : 35, mode);
    if (!mode.startsWith('cancel')) assert.equal(Object.keys(h.get().psyche.committedResponseEvents).length, 1);
  }
}

async function testBusyHookMetadata() {
  for (const obsolete of [false, true]) {
    const effects = [];
    const followUp = { id: 'followup', prepareAt: now - 1, displayAt: now + 60_000, failureCount: 0 };
    const state = { busySlotRuntime: null, busyFollowUp: followUp, locationConfig: { modelTimezone: 'Asia/Tokyo' } };
    let patchCount = 0;
    state.patchBusyFollowUp = async partial => { patchCount++; state.busyFollowUp = { ...state.busyFollowUp, ...partial }; };
    const store = selector => selector(state); store.getState = () => state;
    let finish;
    const draft = new Promise(resolve => { finish = resolve; });
    const hook = load('hooks/useBusyRegulator.ts', {
      react: { useRef: value => ({ current: value }), useEffect: callback => effects.push(callback) },
      '../store': { useAppStore: store },
      '../components/app/ambientContext': { getAmbientEnvironmentContext: async () => '' },
      '../services/kumikoStateMachine': { getDetailedScheduleSlot: () => ({ slotKey: 'slot' }) },
      '../components/app/chatActions': { prepareBusyFollowUpResponse: () => draft },
    }, {
      window: { setInterval: () => 1, clearInterval() {} },
      document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    });
    hook.useBusyRegulator(true);
    const cleanup = effects[0]();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    if (obsolete) state.busyFollowUp = { ...followUp, id: 'replacement' };
    finish(response('response-hook'));
    for (let i = 0; i < 8; i++) await Promise.resolve();
    if (obsolete) assert.equal(patchCount, 0, 'old draft cannot patch a replacement task');
    else {
      assert.equal(patchCount, 1);
      assert.equal(state.busyFollowUp.preparedResponseEventId, 'response-hook');
      assert.equal(state.busyFollowUp.preparedPsycheDelta.stress, 5);
    }
    cleanup();
  }
}

(async () => {
  await testCommit(); await testParserRewrite(); await testDeliveryRoutes(); await testNormalChatBranches(); await testBusyHookMetadata();
  console.log('F09 response psyche regressions passed: rewrite, prewarm, cancellation, busy, reminders, chat, restart, concurrency, rollback.');
})().catch(error => { console.error(error); process.exitCode = 1; });
