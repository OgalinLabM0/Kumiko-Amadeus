#!/usr/bin/env node
'use strict';

// Regression coverage for F03. The test transpiles the production TypeScript
// functions and replaces only model, store and RAG boundaries with in-memory
// mocks. It never opens a database or contacts an API.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const summarizerFile = path.join(root, 'services', 'conversationSummarizer.ts');
const summaryActionsFile = path.join(root, 'components', 'app', 'summaryActions.ts');

let modelMode = 'success';
let summarizerCalls = 0;

function transpile(filename) {
  return ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
}

function loadConversationSummarizer() {
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    console: { log() {}, warn() {}, error() {} },
    Intl,
    Date,
    require(id) {
      if (id === './llmCore') return {
        getCurrentAIConfig: () => ({ provider: 'openai', model_summary: 'test-summary' }),
        getGenAI: () => ({ models: { generateContent: async () => ({ text: '' }) } }),
      };
      if (id === './llmProviderService') return {
        callOpenAI: async () => {
          summarizerCalls += 1;
          if (modelMode === '503') throw new Error('HTTP 503');
          if (modelMode === 'empty') return { text: '' };
          if (modelMode === 'malformedChunks') return { text: '[DIARY_ENTRY]summary fact[/DIARY_ENTRY][NOTEBOOK_UPDATE]notebook fact[/NOTEBOOK_UPDATE][MEMORY_CHUNKS]not JSON[/MEMORY_CHUNKS]' };
          if (modelMode === 'missingChunks') return { text: '[DIARY_ENTRY]summary fact[/DIARY_ENTRY][NOTEBOOK_UPDATE]notebook fact[/NOTEBOOK_UPDATE]' };
          if (modelMode === 'missingNotebook') return { text: '[DIARY_ENTRY]summary fact[/DIARY_ENTRY][MEMORY_CHUNKS]["fact A"][/MEMORY_CHUNKS]' };
          return {
            text: '[DIARY_ENTRY]\nsummary fact\n[/DIARY_ENTRY]\n[NOTEBOOK_UPDATE]\nnotebook fact\n[/NOTEBOOK_UPDATE]\n[MEMORY_CHUNKS]\n["fact A", "fact B"]\n[/MEMORY_CHUNKS]',
          };
        },
        callAnthropic: async () => ({ text: '' }),
      };
      if (id === './appConfig') return { resolveTransportProvider: () => 'openai' };
      throw new Error(`unexpected summarizer dependency: ${id}`);
    },
  };
  vm.runInNewContext(transpile(summarizerFile), sandbox, { filename: summarizerFile });
  return module.exports.summarizeConversation;
}

function makeStore() {
  const store = {
    backupConfig: { ragEnabled: true },
    kumikoNotebook: 'old notebook',
    locationConfig: {},
    language: 'en',
    coreMemory: 'old summary',
    ragStatus: 'IDLE',
    summaryArchiveState: {
      segmentStartTurn: 0,
      segmentStartMessageId: 'm1',
      activeSegmentId: 'active',
      recentSummarySegments: [],
      pendingArchive: null,
    },
    setCoreMemory(value) { this.coreMemory = value; },
    setKumikoNotebook(value) { this.kumikoNotebook = value; },
    setRagStatus(value) { this.ragStatus = value; },
    setSystemNotice() {},
    setSummaryArchiveState(value) {
      this.summaryArchiveState = typeof value === 'function'
        ? value(this.summaryArchiveState)
        : value;
    },
  };
  return store;
}

function makeDbMock({ failKey = null } = {}) {
  const persisted = new Map();
  const put = async ({ key, value }, target = persisted) => {
    if (key === failKey) throw new Error(`simulated ${key} persistence failure`);
    target.set(key, value);
  };
  const db = {
    keyval: { put: record => put(record) },
    setVal: (key, value) => put({ key, value }),
    async transaction(_mode, _table, work) {
      const staged = new Map(persisted);
      const originalTable = this.keyval;
      this.keyval = { put: record => put(record, staged) };
      try {
        await work();
        persisted.clear();
        staged.forEach((value, key) => persisted.set(key, value));
      } finally {
        this.keyval = originalTable;
      }
    },
  };
  return { db, persisted };
}

function loadSummaryActions(summarizeConversation, store, saveLocalRagMemory, dbMock = makeDbMock().db) {
  const module = { exports: {} };
  const summaryCycle = {
    getSummarySegmentMessages(messages, archiveState, endBeforeMessageId) {
      const startIndex = archiveState.segmentStartMessageId
        ? messages.findIndex(message => message.id === archiveState.segmentStartMessageId)
        : 0;
      const source = messages.slice(Math.max(0, startIndex));
      const endIndex = endBeforeMessageId ? source.findIndex(message => message.id === endBeforeMessageId) : -1;
      return endIndex >= 0 ? source.slice(0, endIndex) : source;
    },
    buildSummarySegmentId(start, id, completed) { return `summary-${id}-${start}-${completed}`; },
    appendRecentSummarySegment(archiveState, segment) {
      return [...(archiveState.recentSummarySegments || []), segment];
    },
    buildRecentSummaryBuffer(segments, fallback) {
      return segments.length ? segments.map(segment => segment.summaryText).join('\n\n') : fallback;
    },
    getSummaryContinuationCarryoverState() {
      return { carryoverStartMessageId: null, carryoverEndMessageId: null };
    },
    normalizeSummaryArchiveState(raw) { return raw; },
  };
  const sandbox = {
    module,
    exports: module.exports,
    console: { log() {}, warn() {}, error() {} },
    Date,
    Intl,
    setTimeout: () => 0,
    clearTimeout() {},
    require(id) {
      if (id === 'react') return { __esModule: true, default: {} };
      if (id === '../../store') return { useAppStore: { getState: () => store } };
      if (id === '../../services/db') return { db: dbMock };
      if (id === './appConstants') return { SUMMARY_ARCHIVE_STATE_STORAGE_KEY: 'kumiko_summary_archive_state' };
      if (id === './summaryCycle') return summaryCycle;
      if (id === './rawHistorySync') return {};
      if (id === '../../services/ragMemoryFilter') return {
        evaluateRagMemoryCandidate: text => ({ tier: 'core', score: 1, canonicalKey: text }),
      };
      if (id === './ragRecallHelpers') return { mapRagDecisionTierToStorageTier: tier => tier };
      if (id === '../../services/temporalEpisodeService') return {};
      if (id === '../../services/geminiService') return { summarizeConversation, getCurrentAIConfig: () => ({}) };
      if (id === '../../services/localRagService') return { saveLocalRagMemory, startLocalRagRebuild: async () => ({}), subscribeLocalRagRebuild: () => () => {} };
      if (id === '../../services/desktopBackupService') return { isDesktopElectron: () => false, setDesktopBackgroundThrottling() {}, refocusDesktopWebContents() {} };
      throw new Error(`unexpected summary-actions dependency: ${id}`);
    },
  };
  vm.runInNewContext(transpile(summaryActionsFile), sandbox, { filename: summaryActionsFile });
  return module.exports.triggerAutoSummary;
}

const messages = [
  { id: 'm1', role: 'user', text: 'first fact', timestamp: 1 },
  { id: 'm2', role: 'model', text: 'reply', timestamp: 2 },
];

function params(store) {
  return {
    currentCount: 2,
    currentMemory: store.coreMemory,
    archiveState: store.summaryArchiveState,
    reason: 'manual',
    isComplete: true,
    turnsInSegment: 2,
    nextSegmentStartTurn: 2,
    nextSegmentStartMessageId: null,
    retryCount: 2,
  };
}

async function invoke(trigger, store, overrides = {}) {
  const refs = { messagesRef: { current: messages }, summaryRunningRef: { current: false }, ...(overrides.refs || {}) };
  const helpers = { deriveSummaryTopicLabel: () => 'facts' };
  await trigger(refs, helpers, { ...params(store), ...(overrides.params || {}) });
}

async function main() {
  const summarizeConversation = loadConversationSummarizer();

  modelMode = '503';
  await assert.rejects(
    () => summarizeConversation(messages, 'old summary', undefined, 'old notebook', {}, 'en'),
    /503/,
    '503 must be exposed to the archive caller',
  );
  modelMode = 'empty';
  await assert.rejects(
    () => summarizeConversation(messages, 'old summary', undefined, 'old notebook', {}, 'en'),
    /empty response/,
    'empty model output must be exposed to the archive caller',
  );

  for (const mode of ['503', 'empty', 'malformedChunks', 'missingChunks', 'missingNotebook']) {
    modelMode = mode;
    const store = makeStore();
    const trigger = loadSummaryActions(summarizeConversation, store, async () => {});
    await invoke(trigger, store);
    assert.equal(store.summaryArchiveState.segmentStartTurn, 0, `${mode} must not advance the archive cursor`);
    assert.equal(store.summaryArchiveState.pendingArchive, null, `${mode} must not stage unusable output`);
  }

  modelMode = 'success';
  summarizerCalls = 0;
  const store = makeStore();
  const attempts = [];
  let failSecondChunk = true;
  const trigger = loadSummaryActions(summarizeConversation, store, async payload => {
    attempts.push(payload);
    if (failSecondChunk && payload.endsWith('fact B')) throw new Error('simulated chunk write failure');
  });

  await invoke(trigger, store);
  assert.equal(store.summaryArchiveState.segmentStartTurn, 0, 'chunk failure must not advance the archive cursor');
  assert.ok(store.summaryArchiveState.pendingArchive, 'chunk failure must retain a retry record');
  assert.equal(store.summaryArchiveState.pendingArchive.savedChunkPayloads.length, 1, 'the first successful chunk is recorded');
  assert.equal(store.coreMemory, 'old summary', 'summary is not committed before chunks finish');

  failSecondChunk = false;
  const laterMessages = [...messages, { id: 'm3', role: 'user', text: 'new fact after failed archive', timestamp: 3 }];
  await invoke(trigger, store, {
    refs: { messagesRef: { current: laterMessages } },
    params: { nextSegmentStartTurn: 3, nextSegmentStartMessageId: 'm3' },
  });
  assert.equal(summarizerCalls, 1, 'retry reuses the staged summary instead of calling the model again');
  assert.equal(attempts.filter(payload => payload.endsWith('fact A')).length, 1, 'retry does not write an already-saved fact twice');
  assert.equal(attempts.filter(payload => payload.endsWith('fact B')).length, 2, 'only the failed fact is retried');
  assert.equal(store.summaryArchiveState.segmentStartTurn, 2, 'successful write advances the archive cursor');
  assert.equal(store.summaryArchiveState.segmentStartMessageId, null, 'retry keeps its original cursor instead of skipping newly added messages');
  assert.equal(store.summaryArchiveState.pendingArchive, null, 'successful archive clears its retry record');
  assert.equal(store.coreMemory, 'summary fact', 'successful archive commits the generated summary');

  const faultStore = makeStore();
  const failingDb = makeDbMock({ failKey: 'kumiko_notebook' });
  const faultTrigger = loadSummaryActions(summarizeConversation, faultStore, async () => {}, failingDb.db);
  await invoke(faultTrigger, faultStore);
  assert.equal(faultStore.summaryArchiveState.segmentStartTurn, 0, 'a preference transaction failure must not advance the archive cursor');
  assert.ok(faultStore.summaryArchiveState.pendingArchive, 'a preference transaction failure must retain the retry record');
  assert.equal(faultStore.coreMemory, 'old summary', 'a failed preference transaction must not commit core memory in runtime state');
  assert.equal(failingDb.persisted.get('kumiko_core_memory'), undefined, 'a failed transaction must not persist a partial core-memory write');
  assert.ok(failingDb.persisted.get('kumiko_summary_archive_state').pendingArchive, 'the durable pending record remains after final commit failure');

  const staleStore = makeStore();
  staleStore.summaryArchiveState = {
    ...staleStore.summaryArchiveState,
    segmentStartTurn: 2,
    segmentStartMessageId: null,
  };
  const staleTrigger = loadSummaryActions(summarizeConversation, staleStore, async () => {});
  summarizerCalls = 0;
  await invoke(staleTrigger, staleStore, {
    params: {
      archiveState: { segmentStartTurn: 0, segmentStartMessageId: 'm1', recentSummarySegments: [] },
      retryCount: 1,
    },
  });
  assert.equal(summarizerCalls, 0, 'a stale timer must not regenerate an already-advanced segment');
  assert.equal(staleStore.summaryArchiveState.segmentStartTurn, 2, 'a stale timer must not roll the cursor backward');

  const concurrentStore = makeStore();
  const concurrentTrigger = loadSummaryActions(summarizeConversation, concurrentStore, async () => {});
  summarizerCalls = 0;
  await invoke(concurrentTrigger, concurrentStore, { refs: { summaryRunningRef: { current: true } }, params: { retryCount: 1 } });
  assert.equal(summarizerCalls, 0, 'retry obeys the same concurrent-run guard as a new archive pass');

  console.log('summary archive retry regression tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
