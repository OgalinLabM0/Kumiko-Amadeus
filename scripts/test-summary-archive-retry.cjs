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

function loadRoutingModule(file) {
  const module = { exports: {} };
  vm.runInNewContext(transpile(path.join(root, 'services', file)), {
    module, exports: module.exports,
    require(id) {
      if (id === './roleProfiles') return { resolveModelSessionCredential: x => x };
      assert.equal(id, './appConfig');
      return loadRoutingModule('appConfig.ts');
    },
  });
  return module.exports;
}
const taskModelRouter = loadRoutingModule('taskModelRouter.ts');

function loadConversationSummarizer() {
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    console: { log() {}, warn() {}, error() {} },
    Intl,
    Date,
    require(id) {
      if (id === './taskModelRouter') return taskModelRouter;
      if (id === './llmCore') return {
        callLLMRaw: async (_system, _prompt, _model, options) => {
          assert.equal(options.role, 'memory', 'Fact archiving must retain the memory model binding');
          summarizerCalls += 1;
          if (modelMode === '503') throw new Error('HTTP 503');
          if (modelMode === 'empty') return '';
          if (modelMode === 'malformedChunks') return '[DIARY_ENTRY]summary fact[/DIARY_ENTRY][NOTEBOOK_UPDATE]notebook fact[/NOTEBOOK_UPDATE][MEMORY_CHUNKS]not JSON[/MEMORY_CHUNKS]';
          if (modelMode === 'missingChunks') return '[DIARY_ENTRY]summary fact[/DIARY_ENTRY][NOTEBOOK_UPDATE]notebook fact[/NOTEBOOK_UPDATE]';
          if (modelMode === 'missingNotebook') return '[DIARY_ENTRY]summary fact[/DIARY_ENTRY][MEMORY_CHUNKS]["fact A"][/MEMORY_CHUNKS]';
          return '[DIARY_ENTRY]\nsummary fact\n[/DIARY_ENTRY]\n[NOTEBOOK_UPDATE]\nnotebook fact\n[/NOTEBOOK_UPDATE]\n[MEMORY_CHUNKS]\n["fact A", "fact B"]\n[/MEMORY_CHUNKS]';
        },
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

  const result = require('node:child_process').spawnSync(process.execPath, [require('node:path').join(__dirname, 'test-summary-jobs.cjs')], { encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.status, 0, 'durable summary jobs regression failed');
  console.log('summary model validation and durable retry regression tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
