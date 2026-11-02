#!/usr/bin/env node
'use strict';
// Production backup code with disposable transactional storage. No user DB,
// network, model calls or real backup files are read or written.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto').webcrypto;
const root = path.resolve(__dirname, '..');
let rows = new Map();
let inTransaction = false;
let failEpoch = false;
let rawWrites = 0;
let rejectExportFence = false;
const clone = value => structuredClone(value);
const emptyTable = { clear: async () => {}, bulkPut: async () => {}, get: async () => null,
  orderBy: () => ({ toArray: async () => [] }) };
const db = {
  tables: [], messages: { ...emptyTable, clear: async () => { assert.ok(inTransaction); rawWrites++; } }, vectors: emptyTable,
  kumikoDiary: emptyTable, dailyFragments: emptyTable, psycheState: emptyTable, episodes: emptyTable,
  keyval: {
    get: async key => rows.has(key) ? { key, value: clone(rows.get(key)) } : undefined,
    count: async () => rows.size,
    where: () => ({ startsWith: prefix => ({ primaryKeys: async () => [...rows.keys()].filter(key => key.startsWith(prefix)), toArray: async () => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key,value])=>({key,value:structuredClone(value)})) }) }),
    filter: predicate => ({
      toArray: async () => [...rows].map(([key, value]) => ({ key, value: clone(value) })).filter(predicate),
      primaryKeys: async () => [...rows].filter(([key, value]) => predicate({ key, value })).map(([key]) => key),
    }),
    bulkDelete: async keys => { assert.ok(inTransaction); keys.forEach(key => rows.delete(key)); },
    bulkPut: async entries => {
      assert.ok(inTransaction, 'restore writes must share the existing transaction');
      for (const { key, value } of entries) {
        if (failEpoch && key === 'kumiko_turn_epoch_v1') throw new Error('fixture disk failure');
        rows.set(key, clone(value));
      }
    },
  },
  transaction: async (...args) => {
    const snapshot = clone(rows);
    assert.equal(inTransaction, false, 'do not open a separate execution-state transaction');
    inTransaction = true;
    try { return await args.at(-1)(); } catch (error) { rows = snapshot; throw error; }
    finally { inTransaction = false; }
  },
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
function load(file, dependencies = {}, allowUnused = false) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: file,
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, crypto, TextEncoder, TextDecoderStream, Blob, Response, CompressionStream, DecompressionStream, btoa, atob,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    console: { log() {}, warn() {}, error() {} },
    require(id) {
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      if (allowUnused) return {};
      throw new Error(`Unexpected ${id} in ${file}`);
    },
  }, { filename: file });
  return module.exports;
}
const gate = { assertDataWritesAllowed() {}, getDataRestoreVersion: () => 'fixture', isDataRestoreBlocked: () => false };
const memoryGate = { assertMemoryAvailable() {}, getMemoryGeneration: () => 'initial', assertMemoryGenerationCurrent: async () => {} };
const taskGate = { assertTaskModelRevisionsCurrent: async () => {} };
const artifactGate = { assertSourceRefsCurrent: async () => {} };
const archive = load('services/executionArchive.ts', { './db': { db }, './dataRestoreGate': gate, './memoryMaintenanceGate': memoryGate, './taskRuntime': taskGate, './artifactIndexService': artifactGate });
const jobs = load('services/backgroundJobs.ts', { './db': { db }, './dataRestoreGate': gate, './memoryMaintenanceGate': memoryGate, './taskRuntime': taskGate, './artifactIndexService': artifactGate });
const effects = load('services/responseEffectCommit.ts', { './db': { db }, './dataRestoreGate': gate, './memoryMaintenanceGate': memoryGate, './taskRuntime': taskGate, './artifactIndexService': artifactGate });
const runtimeState = load('services/runtimeStateBackup.ts', { './db': { db } });
const voiceRecords = load('services/voiceWriteRecord.ts');
const execution = load('services/turnStateBackup.ts', { './voiceWriteRecord': voiceRecords, './runtimeStateBackup': runtimeState, './memoryMaintenanceGate': memoryGate, './db': { db }, './dataRestoreGate': gate,
  './executionArchive': archive, './backgroundJobs': jobs, './responseEffectCommit': effects });
const backupData = load('components/app/backupData.ts', { '../../services/turnStateBackup': execution });
const source = { id: 'u1', role: 'user', text: '10分钟后提醒我喝水', timestamp: 123 };
const turn = { id: 't1', sources: [source], epoch: 'old-epoch', createdAt: 123, sequence: 1, status: 'complete', optional: { safe: true } };
const pending = { turnId: 't1', source, candidate: { kind: 'create', sourceMessageId: 'u1', sourceQuote: source.text }, epoch: 'old-epoch', sequence: 1 };
const voiceWrite = { version: 1, id: 'voice-backup', sourceIds: ['u1'], memoryGeneration: 'initial',
  status: 'pending', createdAt: 1, updatedAt: 1, attempt: 0, retryAt: 0 };
const fixture = { version: 1, entries: [
  { key: 'kumiko_turn_v1:t1', value: turn },
  { key: 'kumiko_turn_source_v1:u1', value: { turnId: 't1', text: source.text } },
  { key: 'kumiko_reminder_action:a1', value: { signature: 'sig1', reminderId: 'r1' } },
  { key: 'kumiko_turn_sequence_v1', value: 1 },
  { key: 'kumiko_turn_pending_v1', value: pending },
  { key: 'kumiko_received_turn_v1:received', value: { id: 'received', sourceIds: ['u1'], sources: [source],
    receivedAt: 123, order: 1, status: 'received', context: 'old action receipt must not be replayed' } },
  { key: 'kumiko_reminder_occurrences_v1', value: ['generating', 'sending', 'delivered', 'missed', 'unknown']
    .map((status, i) => ({ id: JSON.stringify(['r1', 1, 123 + i]), token: `old-${i}`, epoch: 'old-epoch', status, claimedAt: 123 })) },
  { key: 'kumiko_reminder_native_cancel_v1', value: [{ id: 'r1', token: 'cancel-old', notificationIds: [12345] }] },
  { key: 'kumiko_turn_location_uncertain_v1', value: { epoch: 'old-epoch', sequence: 1, sources: [source] } },
  { key: 'kumiko_turn_location_pending_v1', value: { epoch: 'old-epoch', sequence: 1, turnId: 't1', source, expiresAt: 456 } },
  { key: 'kumiko_missed_reminders', value: [{ id: 'missed-1', event: '喝水', originalDueAt: 120, recordedAt: 123,
    count: 2, firstDueAt: 120, lastDueAt: 121 }] },
  { key: 'kumiko_background_job_v1:diary-1', value: { version: 1, id: 'diary-1', kind: 'diary-index', sourceId: 'd1',
    sourceVersion: 'v1', epoch: 'old-epoch', status: 'running', attempt: 1, retryAt: 1, createdAt: 1, updatedAt: 2,
    owner: 'old-owner', token: 'old-token', leaseUntil: 456 } },
  { key: 'kumiko_background_jobs_meta_v1', value: { version: 1, epoch: 'old-epoch', windowStart: 1, used: 1 } },
  { key: 'kumiko_response_effect_v1:' + JSON.stringify(['reply-1', 'affection']),
    value: { eventId: 'reply-1', effect: 'affection', epoch: 'old-epoch', committedAt: 123 } },
  { key: 'kumiko_voice_write_v1:voice-backup', value: voiceWrite },
] };
let exportedJson;
const constants = { DEFAULT_WORLD_BOOK: [], LOCALIZED_WORLD_BOOK: { zh: [] } };
const state = { language: 'zh', turnCount: 0, coreMemory: '', worldBook: [], messages: [], relativeReminders: [], dailyReminders: [],
  locationConfig: {}, anchors: [], kumikoNotebook: '', summaryArchiveState: {}, setSystemNotice() {} };
const actions = load('components/app/backupActions.ts', {
  '../../services/runtimeBackupSnapshot': { captureRuntimeBackupData: async data => ({ ...data, executionState: await execution.exportTurnExecutionState() }) },
  '../../services/turnStateBackup': execution,
  '../../services/dataRestoreGate': gate,
  '../../services/reminderNativeCancellation': { captureReminderNativeCancellationsForRestore: async () => [],
    mergeReminderNativeCancellationsAfterRestore: async () => {}, drainReminderNativeCancellations: async () => {} },
  '../../services/db': { db }, '../../store': { useAppStore: { getState: () => state } },
  '../../constants': constants,
  './messageMappers': { normalizeImportedBackupMessages: messages => ({ messages, stats: {} }), mapMessageToEntity: message => message },
  './summaryCycle': { normalizeSummaryArchiveState: value => value, resolveCoreMemoryFromSummaryArchive: (_s, memory) => memory },
  './backupHelpers': { recalculateTurnCountFromMessages: () => 0,
    sanitizeRelativeReminderRecord: value => value, sanitizeDailyReminderRecord: value => value, sanitizeMissedReminderRecord: value => value },
  './rawHistorySync': { syncRawHistoryMessages: async () => { rawWrites++; } },
  '../../services/temporalEpisodeService': { buildTemporalEpisodes: () => [], syncTemporalEpisodes: async () => {} },
  './appUtils': { yieldToMainThread: async () => {} },
  './backupImportValidation': { validateBackupImportPayload: () => ({ valid: true }) },
  './appConstants': { SUMMARY_ARCHIVE_STATE_STORAGE_KEY: 'summary', MEMORY_QUERY_SESSION_STORAGE_KEY: 'kumiko_memory_query_session' },
  '../../store/slices/ragSlice': { RAG_HISTORY_DIRTY_STORAGE_KEY: 'kumiko_rag_history_dirty' },
  '../../store/slices/reminderSlice': { RELATIVE_REMINDER_STORAGE_KEY: 'relative', DAILY_REMINDER_STORAGE_KEY: 'daily' },
  '../../services/userKnownLocation': { getUserKnownLocation: async () => null },
  '../../services/localRagService': { getAllVectors: async () => [] },
  '../../services/backupProtection': { protectionStatus: async () => false },
  '../../services/dialogService': { dialogService: { alert: async () => {} } },
  '../../services/mediaWriteFence': { withMediaWriteFence: async (_version, work) => {
    if (rejectExportFence) throw new Error('earlier dataset');
    return work();
  } },
  '../../services/desktopBackupService': {
    isDesktopElectron: () => true,
    buildDesktopBackupZip: async json => { exportedJson = JSON.parse(json); return { canceled: true }; },
  },
}, true);
const refs = { rawHistorySyncedIdsRef: { current: new Set() }, forceRawHistoryResyncRef: { current: false } };
async function persist(executionState) {
  const normalized = actions.normalizeBackupData({ data: { ...state, executionState } });
  await actions.persistNormalizedBackupData(normalized, refs);
}
async function main() {
  assert.deepEqual(JSON.parse(JSON.stringify(execution.parseTurnExecutionState(fixture))), fixture);
  assert.equal(execution.parseTurnExecutionState(undefined), undefined);
  for (const bad of [null, {}, { version: 2, entries: [] }, { version: 1, entries: {} },
    { version: 1, entries: [fixture.entries[0], fixture.entries[0]] },
    ...[
      ['unrelated-secret', {}], ['kumiko_turn_epoch_v1', 'untrusted'], ['kumiko_turn_v1:', turn],
      ['kumiko_turn_v1:t', { ...turn, sources: [] }], ['kumiko_turn_v1:t', { ...turn, epoch: '' }],
      ['kumiko_turn_v1:t', { ...turn, sources: [{ ...source, role: 'model' }] }],
      ['kumiko_turn_v1:t', { ...turn, sequence: -1 }],
      ['kumiko_turn_source_v1:u', { turnId: 1 }],
      ['kumiko_voice_write_v1:voice-backup', { ...voiceWrite, id: '../outside' }],
      ['kumiko_voice_write_v1:voice-backup', { ...voiceWrite, sourceIds: [1] }],
      ['kumiko_voice_write_v1:voice-backup', { ...voiceWrite, status: 'bad' }],
      ['kumiko_reminder_action:a', { signature: 's' }],
      ['kumiko_turn_sequence_v1', 1.5], ['kumiko_turn_pending_v1', { candidate: {} }],
      ['kumiko_received_turn_v1:received', { id: 'received', sourceIds: [], receivedAt: 1, status: 'received' }],
      ['kumiko_received_turn_v1:received', { id: 'received', sourceIds: ['u1'], receivedAt: 1, status: 'unread' }],
      ['kumiko_reminder_occurrences_v1', [{ id: 'o', token: 't', epoch: 'e', status: 'sending', claimedAt: 'bad' }]],
      ['kumiko_reminder_native_cancel_v1', [{ id: 'r', token: 't', notificationIds: [-1] }]],
      ['kumiko_turn_location_uncertain_v1', { epoch: 'e', sequence: 1, sources: [{ ...source, role: 'model' }] }],
      ['kumiko_turn_v1:t', { ...turn, invalid: Infinity }],
      ['kumiko_turn_v1:t', { ...turn, invalid: undefined }],
      ['kumiko_turn_v1:t', { ...turn, excessive: 'x'.repeat(2 * 1024 * 1024) }],
    ].map(([key, value]) => ({ version: 1, entries: [{ key, value }] })),
  ]) assert.throws(() => execution.parseTurnExecutionState(bad));
  const circular = { ...turn }; circular.circular = circular;
  assert.throws(() => execution.parseTurnExecutionState({ version: 1, entries: [{ key: 'kumiko_turn_v1:t', value: circular }] }));
  rows.set('unrelated', { keep: true });
  rows.set('kumiko_turn_epoch_v1', 'before-restore');
  rows.set('kumiko_turn_v1:stale', turn);
  rows.set('kumiko_voice_write_v1:voice-local', { ...voiceWrite, id: 'voice-local', sourceIds: ['local-source'] });
  await persist(fixture);
  assert.deepEqual(rows.get('kumiko_voice_write_v1:voice-backup'), voiceWrite);
  assert.deepEqual(rows.get('kumiko_voice_write_v1:voice-local').sourceIds, ['local-source'], 'restore must retain local staged-file cleanup obligations');
  assert.equal(rows.has('kumiko_turn_v1:stale'), false);
  assert.deepEqual(rows.get('unrelated'), { keep: true });
  assert.deepEqual(rows.get('kumiko_turn_v1:t1'), turn, 'keep historical epoch and optional fields; do not resume old work');
  assert.deepEqual(rows.get('kumiko_reminder_action:a1'), fixture.entries[2].value, 'preserve receipt reconciliation');
  assert.equal(rows.get('kumiko_turn_pending_v1'), null, 'restored clarification cannot silently execute');
  assert.equal(rows.get('kumiko_turn_location_uncertain_v1'), null, 'old unresolved understanding cannot shadow restored facts');
  assert.equal(rows.get('kumiko_turn_location_pending_v1'), null, 'old location clarification must not resume after restore');
  assert.deepEqual(rows.get('kumiko_missed_reminders'), fixture.entries.find(e => e.key === 'kumiko_missed_reminders').value,
    'missed reminder summaries remain available after restore');
  assert.equal(rows.has('kumiko_background_job_v1:diary-1'), false, 'old leases are discarded for source reconciliation');
  assert.equal(rows.has('kumiko_background_jobs_meta_v1'), false, 'old job budget and epoch are discarded');
  const effectKey = 'kumiko_response_effect_v1:' + JSON.stringify(['reply-1', 'affection']);
  assert.deepEqual(rows.get(effectKey), fixture.entries.find(e => e.key === effectKey).value,
    'committed effect receipt survives restore to prevent duplicate effects');
  assert.equal(rows.get('kumiko_received_turn_v1:received').restored, true, 'restored unread turns may only catch up facts');
  assert.equal(rows.get('kumiko_received_turn_v1:received').context, undefined, 'do not replay old successful action wording');
  assert.deepEqual(rows.get('kumiko_received_turn_v1:received').sources, [source], 'original user evidence remains intact');
  const occurrences = rows.get('kumiko_reminder_occurrences_v1');
  assert.deepEqual(occurrences.map(row => row.status), ['unknown', 'unknown', 'delivered', 'missed', 'unknown']);
  assert.ok(occurrences.every(row => !row.token.startsWith('old-')), 'backup never reuses live send claims');
  assert.deepEqual(rows.get('kumiko_reminder_native_cancel_v1'), [{ id: 'r1', token: 'cancel-old', notificationIds: [12345] }],
    'failed platform cancellations stay recoverable');
  const epoch1 = rows.get('kumiko_turn_epoch_v1');
  assert.match(epoch1, /^[0-9a-f-]{36}$/i);
  await actions.handleExportBackup({ ...state, executionState: { version: 1, entries: [] } });
  assert.ok(execution.executionStateEntries(exportedJson.data.executionState).some(row => row.key === 'kumiko_turn_v1:t1'), 'manual ZIP export must read fresh DB state');
  assert.ok(!execution.executionStateEntries(exportedJson.data.executionState).some(row => row.key === 'kumiko_turn_epoch_v1' || row.key === 'unrelated'));
  rejectExportFence = true;
  exportedJson = null;
  await actions.handleExportBackup(state);
  assert.equal(exportedJson, null, 'stale queued manual export cannot reach desktop writer');
  rejectExportFence = false;
  const before = clone(rows);
  failEpoch = true;
  await assert.rejects(persist(fixture), /fixture disk failure/);
  assert.deepEqual(rows, before, 'execution state and existing keyval writes roll back together');
  failEpoch = false;
  const writesBefore = rawWrites;
  await assert.rejects(persist({ version: 1, entries: [{ key: 'invalid', value: {} }] }));
  assert.equal(rawWrites, writesBefore, 'invalid execution state rejected before raw-history changes');
  assert.equal(await actions.restoreBackupData({ ...state, executionState: null }, {}), null,
    'direct restore rejects invalid execution state before touching UI/dependency refs');
  await persist(undefined);
  assert.ok(rows.has('kumiko_voice_write_v1:voice-local'), 'legacy import cannot orphan locally staged files');
  assert.equal(rows.has('kumiko_turn_v1:t1'), false, 'legacy import clears live execution namespace');
  assert.equal(rows.has('kumiko_reminder_action:a1'), false);
  assert.equal(rows.has('kumiko_turn_sequence_v1'), false);
  assert.equal(rows.has('kumiko_received_turn_v1:received'), false, 'legacy restore clears unread turns from the replaced dataset');
  assert.equal(rows.has('kumiko_reminder_occurrences_v1'), false);
  assert.notEqual(rows.get('kumiko_turn_epoch_v1'), epoch1, 'each restore invalidates in-flight work');
  assert.deepEqual(rows.get('unrelated'), { keep: true });
  const snapshot = await execution.exportTurnExecutionState();
  let liveFunction;
  let saved;
  let mediaWrites = 0;
  const hook = load('hooks/useBackupWorkflow.ts', {
    react: { useMemo: fn => fn(), useCallback: fn => fn, useEffect() {} },
    'dexie-react-hooks': { useLiveQuery(fn) { if (fn !== execution.exportTurnExecutionState && !liveFunction && fn.name !== 'getUserKnownLocation') liveFunction = fn; return null; } },
    '../services/turnStateBackup': execution,
    '../services/runtimeBackupSnapshot': { captureRuntimeBackupData: async data => ({ ...data, executionState: await execution.exportTurnExecutionState() }) },
    '../services/dataRestoreGate': gate,
    '../services/mediaWriteFence': { withMediaWriteFence: async (_version, work) => work() },
    '../services/db': { db }, '../services/executionArchive': archive,
    '../services/userKnownLocation': { getUserKnownLocation: async () => null },
    '../components/app/backupData': backupData,
    '../components/app/backupActions': actions,
    '../components/app/backupImportValidation': { validateBackupImportPayload: () => ({ valid: true }) },
    '../services/imageService': { imageService: { saveImageWithId: async () => { mediaWrites++; } } },
    '../constants': constants,
    '../services/desktopBackupService': { isDesktopElectron: () => true,
      writeDesktopBackupFile: async (_path, json) => { saved = JSON.parse(json); return { success: true }; } },
  }, true).useBackupWorkflow({ ...state, ...refs });
  assert.notEqual(liveFunction, execution.exportTurnExecutionState, 'render never exports the full execution state');
  assert.equal(typeof liveFunction, 'function');
  assert.ok((await liveFunction()) > 0, 'lightweight revision query remains executable');
  assert.equal(await hook.restoreParsedBackupPayload({ ...state, executionState: null }, [{ id: 'img', dataUrl: 'fixture' }]), null);
  assert.equal(mediaWrites, 0, 'malformed execution state is rejected before imported media writes');
  assert.equal(hook.backupData.executionState, undefined, 'full state is prepared at save time');
  rows.set('kumiko_turn_sequence_v1', 9);
  assert.equal(await hook.performFileSave('fixture-backup', state), true);
  assert.ok(execution.executionStateEntries(saved.data.executionState).some(row => row.key === 'kumiko_turn_sequence_v1' && row.value === 9), 'file saves refresh beyond stale live snapshot');
  let attemptedExport = 0;
  const failingExecution = { ...execution, exportTurnExecutionState: async () => { attemptedExport++; throw new Error('injected capacity failure'); } };
  const failingHook = load('hooks/useBackupWorkflow.ts', {
    react: { useMemo: fn => fn(), useCallback: fn => fn, useEffect() {} },
    'dexie-react-hooks': { useLiveQuery(fn) { assert.notEqual(fn, failingExecution.exportTurnExecutionState); return null; } },
    '../services/turnStateBackup': failingExecution, '../services/db': { db }, '../services/executionArchive': archive,
    '../services/runtimeBackupSnapshot': { captureRuntimeBackupData: async data => ({ ...data, executionState: await failingExecution.exportTurnExecutionState() }) },
    '../services/dataRestoreGate': gate,
    '../services/userKnownLocation': { getUserKnownLocation: async () => null },
    '../components/app/backupData': backupData, '../components/app/backupActions': actions,
    '../services/desktopBackupService': { isDesktopElectron: () => true }, '../constants': constants,
  }, true).useBackupWorkflow({ ...state, ...refs });
  assert.equal(attemptedExport, 0, 'render does not eagerly export or throw');
  assert.equal(await failingHook.performFileSave('fixture-backup', state), false, 'save reports export failure');
  assert.equal(attemptedExport, 1);
  let autoSaved;
  let resolveWritten;
  const written = new Promise(resolve => { resolveWritten = resolve; });
  const autoSave = load('hooks/useAutoSave.ts', {
    react: { useState: value => [value, () => {}], useRef: value => ({ current: value }), useCallback: fn => fn, useEffect() {} },
    '../services/dataRestoreGate': gate, '../services/turnStateBackup': execution,
    '../services/runtimeBackupSnapshot': { captureRuntimeBackupData: async data => ({ ...data, executionState: await execution.exportTurnExecutionState() }) },
    '../services/mediaWriteFence': { withMediaWriteFence: async (_version, work) => work() },
    '../services/desktopBackupService': { isDesktopElectron: () => true, writeDesktopBackupFile: async (_path, json) => {
      autoSaved = JSON.parse(json); resolveWritten(); return { success: true };
    } }, '../services/environment': { isCapacitorNative: () => false },
  }, true).useAutoSave({ data: { ...state, executionState: { version: 1, entries: [] } },
    config: { localEnabled: true }, fileHandle: 'fixture-path', isBlocked: false });
  rows.set('kumiko_turn_sequence_v1', 10);
  autoSave.triggerManualSave(); await written;
  assert.ok(execution.executionStateEntries(autoSaved.data.executionState).some(row => row.key === 'kumiko_turn_sequence_v1' && row.value === 10),
    'autosave refreshes execution state when writing, independently of the last rendered snapshot');
  assert.equal(backupData.validateBackupData({ worldBook: [], executionState: null }, 'zh', { zh: [] }, []), false);
  console.log('Turn execution backup passed: schemas, fresh export/live/file snapshots, namespace replacement, legacy clearing, epoch rotation, pending reset and atomic rollback.');
}
const watchdog = setTimeout(() => { console.error('Backup fixture timed out before completion'); process.exitCode = 1; }, 15_000);
main().then(() => clearTimeout(watchdog)).catch(error => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; });
