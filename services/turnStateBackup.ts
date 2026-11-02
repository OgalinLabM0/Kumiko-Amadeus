import { db } from './db';
import { assertDataWritesAllowed, getDataRestoreVersion } from './dataRestoreGate';
import { executionDigest, isExecutionArchive, readExecutionArchive, TURN_ARCHIVE_PREFIX } from './executionArchive';
import { BACKGROUND_JOB_PREFIX, BACKGROUND_JOBS_META_KEY, isBackgroundJobBackupEntry, rebaseBackgroundJobsAfterRestore } from './backgroundJobs';
import { RESPONSE_EFFECT_PREFIX, isResponseEffectReceipt } from './responseEffectCommit';
import { RUNTIME_TABLES, isRuntimeKey, parseRuntimeEntryKey, validateRuntimeEntry, runtimeBackupEntries, replaceRuntimeTables } from './runtimeStateBackup';
import { assertMemoryAvailable } from './memoryMaintenanceGate';
import { VOICE_WRITE_PREFIX, isVoiceWriteRecord } from './voiceWriteRecord';

type Entry = { key: string; value: unknown };
type ExecutionChunk = { index: number; entries: Entry[]; chars: number; digest: string };
export type TurnExecutionStateBackup = { version: 1; entries: Entry[] }
  | { version: 2 | 3; entryCount: number; chunks: ExecutionChunk[] };

const PREFIXES = ['kumiko_turn_v1:', 'kumiko_turn_source_v1:', 'kumiko_reminder_action:', 'kumiko_received_turn_v1:'];
const OCCURRENCES_KEY = 'kumiko_reminder_occurrences_v1';
const CANCELLATIONS_KEY = 'kumiko_reminder_native_cancel_v1';
const LOCATION_UNCERTAIN_KEY = 'kumiko_turn_location_uncertain_v1';
const LOCATION_PENDING_KEY = 'kumiko_turn_location_pending_v1';
const MISSED_REMINDERS_KEY = 'kumiko_missed_reminders';
const SEQUENCE_KEY = 'kumiko_turn_sequence_v1';
const PENDING_KEY = 'kumiko_turn_pending_v1';
const EPOCH_KEY = 'kumiko_turn_epoch_v1';
const MAX_ENTRY_CHARS = 2 * 1024 * 1024;
const MAX_TOTAL_CHARS = 64 * 1024 * 1024;
const CHUNK_ENTRIES = 1000;
const CHUNK_CHARS = 4 * 1024 * 1024;
const MAX_CHUNKS = 4096;
const MAX_PAGED_CHARS = 512 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.prototype.toString.call(value) === '[object Object]';
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const sequence = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;
const allowedKey = (key: string): boolean => isRuntimeKey(key) || key === SEQUENCE_KEY || key === PENDING_KEY
  || key === OCCURRENCES_KEY || key === CANCELLATIONS_KEY || key === LOCATION_UNCERTAIN_KEY || key === LOCATION_PENDING_KEY || key === MISSED_REMINDERS_KEY
  || key.startsWith(TURN_ARCHIVE_PREFIX) || key.startsWith(BACKGROUND_JOB_PREFIX) || key === BACKGROUND_JOBS_META_KEY
  || key.startsWith(RESPONSE_EFFECT_PREFIX)
  || PREFIXES.some(prefix => key.startsWith(prefix) && key.length > prefix.length);

function isJson(value: unknown, ancestors = new Set<unknown>(), depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!Array.isArray(value) && !record(value)) return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Object.values(value).every(item => isJson(item, ancestors, depth + 1));
  ancestors.delete(value);
  return valid;
}

function isSource(value: unknown): boolean {
  return record(value) && nonempty(value.id) && value.role === 'user'
    && typeof value.text === 'string' && finite(value.timestamp);
}

function hasSchema(key: string, value: unknown): boolean {
  if (key.startsWith(VOICE_WRITE_PREFIX)) return isVoiceWriteRecord(key, value);
  if (key.startsWith('runtime13:')) return validateRuntimeEntry(key, value);
  if (key === 'kumiko_memory_generation_v1') return nonempty(value);
  if (key === 'kumiko_memory_maintenance_v1') return value === null || value === '' || nonempty(value);
  if (key.startsWith('kumiko_state_version_v1:')) return sequence(value);
  if (key.startsWith('kumiko_block_outbox_v1:') || key.startsWith('kumiko_diary_draft_v1:')) return record(value);
  if (key.startsWith('kumiko_summary_artifact_v1:')) return record(value) && nonempty(value.id) && Array.isArray(value.sourceRefs);
  if (key.startsWith('kumiko_memory_asset_v1:')) return record(value) && nonempty(value.artifactId)
    && key === `kumiko_memory_asset_v1:${value.artifactId}` && nonempty(value.sourceRevision) && nonempty(value.memoryGeneration)
    && Array.isArray(value.sourceRefs) && value.sourceRefs.length > 0 && value.sourceRefs.length <= 10000
    && value.sourceRefs.every(ref => record(ref) && ['message','diary','fragment'].includes(String(ref.kind))
      && nonempty(ref.id) && ref.id.length <= 1000 && nonempty(ref.version) && ref.version.length <= 1000
      && (ref.relation === undefined || ['quoted','derived','basis','context'].includes(String(ref.relation))));
  if (key === 'kumiko_background_network_paused_v1') return typeof value === 'boolean';
  if (key === MISSED_REMINDERS_KEY) return Array.isArray(value) && value.every(item => record(item)
    && nonempty(item.id) && nonempty(item.event) && finite(item.originalDueAt) && finite(item.recordedAt)
    && (item.count === undefined || (Number.isSafeInteger(item.count) && Number(item.count) > 0
      && finite(item.firstDueAt) && finite(item.lastDueAt) && item.lastDueAt >= item.firstDueAt)));
  if (key.startsWith(TURN_ARCHIVE_PREFIX)) return isExecutionArchive(value);
  if (key.startsWith(BACKGROUND_JOB_PREFIX) || key === BACKGROUND_JOBS_META_KEY) return isBackgroundJobBackupEntry(key, value);
  if (key.startsWith(RESPONSE_EFFECT_PREFIX)) return isResponseEffectReceipt(value)
    && key === RESPONSE_EFFECT_PREFIX + JSON.stringify([value.eventId, value.effect]);
  if (key === LOCATION_PENDING_KEY) return value === null || (record(value) && nonempty(value.epoch)
    && sequence(value.sequence) && nonempty(value.turnId) && isSource(value.source) && finite(value.expiresAt));
  if (key === SEQUENCE_KEY) return sequence(value);
  if (key === OCCURRENCES_KEY) return Array.isArray(value) && value.every(item => record(item)
    && nonempty(item.id) && nonempty(item.token) && nonempty(item.epoch) && finite(item.claimedAt)
    && ['generating', 'sending', 'delivered', 'missed', 'unknown'].includes(String(item.status)));
  if (key === CANCELLATIONS_KEY) return Array.isArray(value) && value.every(item => record(item)
    && nonempty(item.id) && nonempty(item.token) && Array.isArray(item.notificationIds)
    && item.notificationIds.every(id => Number.isSafeInteger(id) && id > 0));
  if (key === LOCATION_UNCERTAIN_KEY) return value === null || (record(value)
    && nonempty(value.epoch) && sequence(value.sequence) && Array.isArray(value.sources) && value.sources.every(isSource));
  if (key.startsWith('kumiko_received_turn_v1:')) return record(value) && nonempty(value.id)
    && Array.isArray(value.sourceIds) && value.sourceIds.length > 0 && value.sourceIds.length <= 100
    && value.sourceIds.every(nonempty) && finite(value.receivedAt)
    && (value.order === undefined || sequence(value.order)) && ['received', 'completed'].includes(String(value.status))
    && (value.sources === undefined || (Array.isArray(value.sources) && value.sources.every(isSource)))
    && (value.context === undefined || typeof value.context === 'string');
  if (key === PENDING_KEY) {
    return value === null || (record(value) && nonempty(value.turnId) && isSource(value.source)
      && record(value.candidate) && ['create', 'cancel', 'update'].includes(String(value.candidate.kind))
      && nonempty(value.candidate.sourceMessageId) && nonempty(value.candidate.sourceQuote));
  }
  if (!record(value)) return false;
  if (key.startsWith('kumiko_turn_v1:')) {
    return nonempty(value.id) && Array.isArray(value.sources) && value.sources.length >= 1
      && value.sources.length <= 100 && value.sources.every(isSource)
      && nonempty(value.epoch) && finite(value.createdAt) && sequence(value.sequence);
  }
  if (key.startsWith('kumiko_turn_source_v1:')) return nonempty(value.turnId);
  return nonempty(value.signature) && nonempty(value.reminderId);
}

/** Missing means a legacy backup, not permission to retain live execution state. */
export function parseTurnExecutionState(value: unknown): TurnExecutionStateBackup | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || ![1, 2, 3].includes(value.version as number)) {
    throw new Error('Invalid executionState backup.');
  }
  if (value.version === 1 && (!Array.isArray(value.entries) || value.entries.length > 200000)) throw new Error('Invalid executionState backup.');
  if (value.version !== 1 && (!Array.isArray(value.chunks) || value.chunks.length > MAX_CHUNKS
    || !sequence(value.entryCount) || !value.chunks.every((chunk, index) => record(chunk) && chunk.index === index
      && Array.isArray(chunk.entries) && chunk.entries.length <= CHUNK_ENTRIES && finite(chunk.chars)
      && chunk.chars > 0 && chunk.chars <= CHUNK_CHARS && typeof chunk.digest === 'string'
      && /^[a-f0-9]{64}$/.test(chunk.digest)))) throw new Error('Invalid executionState chunks.');
  const entries: Entry[] = value.version === 1 ? value.entries as Entry[] : (value.chunks as ExecutionChunk[]).flatMap(chunk => chunk.entries);
  if (value.version !== 1 && entries.length !== value.entryCount) throw new Error('ExecutionState chunk count mismatch.');
  const keys = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    if (!record(entry) || typeof entry.key !== 'string' || entry.key.length > 1000
      || !allowedKey(entry.key) || keys.has(entry.key) || !isJson(entry.value) || !hasSchema(entry.key, entry.value)) {
      throw new Error('Invalid executionState entry.');
    }
    keys.add(entry.key);
    const size = JSON.stringify(entry.value).length + entry.key.length;
    total += size;
    if (size > MAX_ENTRY_CHARS || total > (value.version === 1 ? MAX_TOTAL_CHARS : MAX_PAGED_CHARS)) throw new Error('ExecutionState backup exceeds size limit.');
  }
  // Detach the validated data from the caller before asynchronous persistence.
  return JSON.parse(JSON.stringify(value)) as TurnExecutionStateBackup;
}

export function executionStateEntries(state: TurnExecutionStateBackup | undefined): Entry[] {
  return !state ? [] : state.version === 1 ? state.entries : state.chunks.flatMap(chunk => chunk.entries);
}

/** Called before entering the destructive restore transaction. Integrity work
 * (hashing/decompression) never holds an IndexedDB transaction open. */
export async function validateExecutionStateIntegrity(value: unknown): Promise<TurnExecutionStateBackup | undefined> {
  const state = parseTurnExecutionState(value);
  if (!state) return state;
  if (state.version !== 1) for (const chunk of state.chunks) {
    const serialized = JSON.stringify(chunk.entries);
    if (serialized.length !== chunk.chars || await executionDigest(serialized) !== chunk.digest) {
      throw new Error('ExecutionState chunk integrity check failed.');
    }
  }
  const entries = executionStateEntries(state);
  const restoredArchives = new Map<string, any>();
  for (const entry of entries) if (entry.key.startsWith(TURN_ARCHIVE_PREFIX)) {
    const original = await readExecutionArchive(entry.value);
    if (entry.key !== TURN_ARCHIVE_PREFIX + original?.id || !hasSchema('kumiko_turn_v1:' + original.id, original)) throw new Error('Invalid archived execution record.');
    restoredArchives.set(entry.key, { original, digest: (entry.value as any).digest });
  }
  for (const entry of entries) if (entry.key.startsWith('kumiko_turn_v1:') && (entry.value as any)?.archived) {
    const hot = entry.value as any;
    const archived = restoredArchives.get(hot.archived.key);
    if (!archived || archived.digest !== hot.archived.digest || archived.original.id !== hot.id
      || archived.original.epoch !== hot.epoch || JSON.stringify(archived.original.sources) !== JSON.stringify(hot.sources)
      || JSON.stringify(archived.original.receipts) !== JSON.stringify(hot.receipts)) {
      throw new Error('Execution archive is missing or inconsistent; backup is incomplete.');
    }
  }
  return state;
}

export function getBackupExecutionState(source: any): TurnExecutionStateBackup | undefined {
  const root = source?.data ?? source;
  return parseTurnExecutionState(root?.executionState !== undefined ? root.executionState : source?.executionState);
}

export async function exportTurnExecutionState(): Promise<TurnExecutionStateBackup> {
  assertDataWritesAllowed();
  assertMemoryAvailable();
  const generation = getDataRestoreVersion();
  const entries = await readTurnExecutionEntries();
  const valid = await packExecutionState(entries);
  assertDataWritesAllowed(); assertMemoryAvailable();
  if (getDataRestoreVersion() !== generation) throw new Error('Data changed during backup preparation.');
  return valid;
}
export async function readTurnExecutionEntries(): Promise<Entry[]> {
  return db.transaction('r', [db.keyval, ...RUNTIME_TABLES.map(name => db.table(name))], async () => [
    ...await db.keyval.filter(row => allowedKey(row.key) && !row.key.startsWith('runtime13:')).toArray(),
    ...await runtimeBackupEntries(),
  ]);
}

export async function packExecutionState(entries: Entry[]): Promise<TurnExecutionStateBackup> {
  entries = JSON.parse(JSON.stringify(entries));
  const chunks: ExecutionChunk[] = [];
  let page: Entry[] = []; let pageChars = 2; let total = 0;
  const flush = async () => {
    if (!page.length) return;
    const serialized = JSON.stringify(page);
    chunks.push({ index: chunks.length, entries: page, chars: serialized.length, digest: await executionDigest(serialized) });
    page = []; pageChars = 2;
  };
  for (const entry of entries) {
    const chars = JSON.stringify(entry).length + 1;
    if (page.length && (page.length >= CHUNK_ENTRIES || pageChars + chars > CHUNK_CHARS)) await flush();
    page.push(entry); pageChars += chars; total += chars;
  }
  await flush();
  const output: TurnExecutionStateBackup = { version: 3, entryCount: entries.length, chunks };
  const valid = await validateExecutionStateIntegrity(output);
  return valid!;
}

/** Must run inside the caller's keyval restore transaction. Never resume a
 * pending clarification from a backup: fresh user input must authorize it. */
export async function replaceTurnExecutionState(value: unknown): Promise<void> {
  const state = parseTurnExecutionState(value);
  await replaceRuntimeTables(executionStateEntries(state));
  // Files already staged on this device (including another window's live
  // write) remain cleanup obligations even when execution history is replaced.
  const localVoiceWrites = await db.keyval.filter(row => row.key.startsWith(VOICE_WRITE_PREFIX)
    && isVoiceWriteRecord(row.key, row.value)).toArray();
  const existing = await db.keyval.filter(row => allowedKey(row.key)).primaryKeys();
  await db.keyval.bulkDelete(existing);
  const restored = executionStateEntries(state).filter(entry => !parseRuntimeEntryKey(entry.key) && entry.key !== PENDING_KEY && entry.key !== LOCATION_UNCERTAIN_KEY && entry.key !== LOCATION_PENDING_KEY)
    .map(entry => {
      if (entry.key.startsWith('kumiko_received_turn_v1:')) {
        const { context: _oldReceipt, ...value } = entry.value as Record<string, unknown>;
        return { key: entry.key, value: { ...value, restored: true } };
      }
      if (entry.key === OCCURRENCES_KEY) return { key: entry.key, value: (entry.value as Array<any>).map(row => ({
        ...row, status: ['generating', 'sending'].includes(row.status) ? 'unknown' : row.status,
        token: crypto.randomUUID(),
      })) };
      return entry;
    });
  await db.keyval.bulkPut([
    ...restored,
    ...localVoiceWrites,
    { key: EPOCH_KEY, value: crypto.randomUUID() },
    { key: PENDING_KEY, value: null },
    { key: LOCATION_UNCERTAIN_KEY, value: null },
    { key: LOCATION_PENDING_KEY, value: null },
  ]);
  await rebaseBackgroundJobsAfterRestore();
}
