#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const rows = new Map();
let inTransaction = false;
const db = {
  tables: [],
  messages: { clear: async () => { assert.ok(inTransaction); }, bulkPut: async () => { assert.ok(inTransaction); } },
  episodes: { clear: async () => { assert.ok(inTransaction); }, bulkPut: async () => { assert.ok(inTransaction); } },
  vectors: { clear: async () => { assert.ok(inTransaction); }, bulkPut: async () => { assert.ok(inTransaction); } },
  getVal: async (key, fallback) => rows.has(key) ? rows.get(key) : fallback,
  keyval: {
    get: async key => rows.has(key) ? { key, value: structuredClone(rows.get(key)) } : undefined,
    where: () => ({ startsWith: prefix => ({ primaryKeys: async () => [...rows.keys()].filter(key => key.startsWith(prefix)), toArray: async () => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key,value])=>({key,value:structuredClone(value)})) }) }),
    bulkPut: async values => { assert.ok(inTransaction); values.forEach(row => rows.set(row.key, structuredClone(row.value))); },
    bulkDelete: async keys => { assert.ok(inTransaction); keys.forEach(key => rows.delete(key)); },
    filter: predicate => ({
      primaryKeys: async () => [...rows].filter(([key, value]) => predicate({ key, value })).map(([key]) => key),
      toArray: async () => [...rows].map(([key, value]) => ({ key, value })).filter(predicate),
    }),
  },
  transaction: async (...args) => { inTransaction = true; try { return await args.at(-1)(); } finally { inTransaction = false; } },
};
const runtimeRows = new Map();
const runtimeNames = ['runtimeJobs','runtimeRequestAttempts','stateCommits','memoryDependencies','memoryCorrections','messageViews'];
for (const name of runtimeNames) {
  const data = new Map(); runtimeRows.set(name, data);
  db[name] = { toArray: async () => [...data.values()].map(value => structuredClone(value)),
    get: async id => data.has(id) ? structuredClone(data.get(id)) : undefined,
    put: async value => { assert.ok(inTransaction); data.set(value.id, structuredClone(value)); },
    clear: async () => { assert.ok(inTransaction); data.clear(); },
    where: () => ({ above: () => ({ toArray: async () => [] }) }) };
}
db.table = name => db[name];
function load(file, deps = {}, unusedImports = false) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: file,
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console: { log() {}, warn() {} }, Intl, Date, crypto: require('node:crypto').webcrypto,
    TextEncoder, TextDecoderStream, Blob, Response, CompressionStream, DecompressionStream, btoa, atob,
    require(id) { if (id in deps) return deps[id]; if (unusedImports) return {}; throw new Error(`Missing ${id}`); },
  }, { filename: file });
  return module.exports;
}
const location = load('services/userKnownLocation.ts', { './db': { db } });
const gate = { assertDataWritesAllowed() {}, getDataRestoreVersion: () => 'fixture', isDataRestoreBlocked: () => false };
const memoryGate = { assertMemoryAvailable() {}, getMemoryGeneration: () => 'initial', assertMemoryGenerationCurrent: async () => {} };
const taskGate = { assertTaskModelRevisionsCurrent: async () => {} };
const artifactGate = { assertSourceRefsCurrent: async () => {} };
const archive = load('services/executionArchive.ts', { './db': { db }, './dataRestoreGate': gate, './memoryMaintenanceGate': memoryGate, './taskRuntime': taskGate, './artifactIndexService': artifactGate });
const jobs = load('services/backgroundJobs.ts', { './db': { db }, './dataRestoreGate': gate, './memoryMaintenanceGate': memoryGate, './taskRuntime': taskGate, './artifactIndexService': artifactGate });
const effects = load('services/responseEffectCommit.ts', { './db': { db }, './dataRestoreGate': gate, './memoryMaintenanceGate': memoryGate, './taskRuntime': taskGate, './artifactIndexService': artifactGate });
const runtimeState = load('services/runtimeStateBackup.ts', { './db': { db } });
const executionState = load('services/turnStateBackup.ts', { './voiceWriteRecord': load('services/voiceWriteRecord.ts'), './runtimeStateBackup': runtimeState, './memoryMaintenanceGate': memoryGate, './db': { db }, './dataRestoreGate': gate,
  './executionArchive': archive, './backgroundJobs': jobs, './responseEffectCommit': effects });
const backup = load('components/app/backupData.ts', { '../../services/turnStateBackup': executionState });
const fixture = {
  version: 1, locationText: '武汉', sourceQuote: '我在武汉',
  sourceMessage: { id: 'user-location-evidence', text: '我在武汉', timestamp: 1000, role: 'user' },
  status: 'resolved', resolvedName: '武汉, 湖北, 中国', timeZone: 'Asia/Shanghai',
  latitude: 30.58, longitude: 114.27, geocodingQuery: '武汉', updatedAt: 2000,
};
const state = { language: 'zh', turnCount: 0, coreMemory: '', worldBook: [], relativeReminders: [], dailyReminders: [],
  locationConfig: { modelTimezone: 'Asia/Tokyo', userTimezone: 'Pacific/Honolulu' }, anchors: [], kumikoNotebook: '' };
const helpers = load('components/app/backupHelpers.ts', {
  '../../services/db': {}, '../../services/reminderTime': load('services/reminderTime.ts'),
  '../../store/slices/reminderSlice': {}, './appConstants': {},
});
const actions = load('components/app/backupActions.ts', {
  '../../store': { useAppStore: { getState: () => state } },
  '../../constants': { LOCALIZED_WORLD_BOOK: { zh: [] }, DEFAULT_WORLD_BOOK: [] },
  '../../services/db': { db }, '../../services/userKnownLocation': location,
  '../../services/turnStateBackup': executionState,
  '../../services/reminderNativeCancellation': { captureReminderNativeCancellationsForRestore: async () => [],
    mergeReminderNativeCancellationsAfterRestore: async () => {}, drainReminderNativeCancellations: async () => {} },
  './messageMappers': { normalizeImportedBackupMessages: messages => ({ messages, stats: {} }), mapMessageToEntity: message => message },
  './backupHelpers': helpers,
  './summaryCycle': { normalizeSummaryArchiveState: value => value, resolveCoreMemoryFromSummaryArchive: (_s, memory) => memory },
  './rawHistorySync': { syncRawHistoryMessages: async () => {} },
  '../../services/temporalEpisodeService': { buildTemporalEpisodes: () => [], syncTemporalEpisodes: async () => {} },
  '../../services/desktopBackupService': { isDesktopElectron: () => false },
  './appUtils': { yieldToMainThread: async () => {} },
  './appConstants': { SUMMARY_ARCHIVE_STATE_STORAGE_KEY: 'summary', MEMORY_QUERY_SESSION_STORAGE_KEY: 'kumiko_memory_query_session' },
  '../../store/slices/ragSlice': { RAG_HISTORY_DIRTY_STORAGE_KEY: 'kumiko_rag_history_dirty' },
  '../../store/slices/reminderSlice': { RELATIVE_REMINDER_STORAGE_KEY: 'relative', DAILY_REMINDER_STORAGE_KEY: 'daily' },
}, true);
async function main() {
  const data = backup.buildBackupData({ ...state, messages: [fixture.sourceMessage], userKnownLocation: fixture,
    defaultWorldBook: [], localizedWorldBook: { zh: [] } });
  const serialized = JSON.parse(JSON.stringify({ data }));
  const normalized = actions.normalizeBackupData(serialized);
  assert.equal(normalized.userKnownLocation.sourceMessage.id, fixture.sourceMessage.id);
  const refs = { rawHistorySyncedIdsRef: { current: new Set() }, forceRawHistoryResyncRef: { current: true } };
  await actions.persistNormalizedBackupData(normalized, refs);
  const reloaded = load('services/userKnownLocation.ts', { './db': { db } });
  assert.equal((await reloaded.getUserKnownLocation()).timeZone, 'Asia/Shanghai', 'restore survives service reload without taking settings timezone');
  assert.equal((await reloaded.getUserKnownLocation()).sourceQuote, '我在武汉');
  const offline = { ...fixture, status: 'unresolved', resolutionIssue: 'network', resolvedName: null,
    timeZone: null, latitude: null, longitude: null };
  const offlineData = backup.buildBackupData({ ...state, messages: [fixture.sourceMessage], userKnownLocation: offline,
    defaultWorldBook: [], localizedWorldBook: { zh: [] } });
  const offlineNormalized = actions.normalizeBackupData(JSON.parse(JSON.stringify({ data: offlineData })));
  await actions.persistNormalizedBackupData(offlineNormalized, refs);
  assert.equal((await reloaded.getUserKnownLocation()).resolutionIssue, 'network', 'offline cause survives export and restore');
  await actions.persistNormalizedBackupData(normalized, refs);
  const legacy = actions.normalizeBackupData({ messages: [], worldBook: [] });
  assert.equal(legacy.userKnownLocation, undefined, 'old backups do not manufacture a location from settings');
  await actions.persistNormalizedBackupData(legacy, refs);
  assert.equal((await reloaded.getUserKnownLocation()).locationText, '武汉', 'legacy partial backup preserves existing evidenced record');
  const cleared = actions.normalizeBackupData({ messages: [], worldBook: [], userKnownLocation: null });
  await actions.persistNormalizedBackupData(cleared, refs);
  assert.equal(await reloaded.getUserKnownLocation(), null, 'explicit unknown remains unknown');
  const invalid = actions.normalizeBackupData({ messages: [], worldBook: [], userKnownLocation: { ...fixture, sourceQuote: '没有说过' } });
  assert.equal(invalid.userKnownLocation, null, 'unsourced imported facts rejected');
  console.log('Known-location backup passed: actual export/normalization/persistence, reload, legacy, clear and source validation.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
