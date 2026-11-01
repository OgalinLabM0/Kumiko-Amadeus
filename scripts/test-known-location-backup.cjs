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
  getVal: async (key, fallback) => rows.has(key) ? rows.get(key) : fallback,
  keyval: { bulkPut: async values => { assert.ok(inTransaction); values.forEach(row => rows.set(row.key, structuredClone(row.value))); } },
  transaction: async (...args) => { inTransaction = true; try { return await args.at(-1)(); } finally { inTransaction = false; } },
};
function load(file, deps = {}, unusedImports = false) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: file,
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console: { log() {}, warn() {} }, Intl, Date,
    require(id) { if (id in deps) return deps[id]; if (unusedImports) return {}; throw new Error(`Missing ${id}`); },
  }, { filename: file });
  return module.exports;
}
const location = load('services/userKnownLocation.ts', { './db': { db } });
const backup = load('components/app/backupData.ts');
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
  './messageMappers': { normalizeImportedBackupMessages: messages => ({ messages, stats: {} }) },
  './backupHelpers': helpers,
  './summaryCycle': { normalizeSummaryArchiveState: value => value, resolveCoreMemoryFromSummaryArchive: (_s, memory) => memory },
  './rawHistorySync': { syncRawHistoryMessages: async () => {} },
  '../../services/temporalEpisodeService': { syncTemporalEpisodes: async () => {} },
  './appUtils': { yieldToMainThread: async () => {} },
  './appConstants': { SUMMARY_ARCHIVE_STATE_STORAGE_KEY: 'summary' },
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
