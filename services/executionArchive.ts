import { db } from './db';
import { getDataRestoreVersion, isDataRestoreBlocked } from './dataRestoreGate';
import { assertMemoryGenerationCurrent, getMemoryGeneration, isMemoryMaintenanceBlocked } from './memoryMaintenanceGate';

export const TURN_ARCHIVE_PREFIX = 'kumiko_turn_archive_v1:';
export const TURN_ARCHIVE_STATUS_KEY = 'kumiko_turn_archive_status_v1';
const TURN_PREFIX = 'kumiko_turn_v1:';
const RETAIN_MS = 30 * 86400_000;
const MAX_RECORD_CHARS = 2 * 1024 * 1024;
export interface ExecutionArchive {
  version: 1; encoding: 'gzip-base64'; digest: string; originalChars: number; payload: string;
}
export async function executionDigest(text: string): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function isExecutionArchive(value: any): value is ExecutionArchive {
  return value?.version === 1 && value.encoding === 'gzip-base64'
    && /^[a-f0-9]{64}$/.test(value.digest) && Number.isSafeInteger(value.originalChars)
    && value.originalChars > 0 && value.originalChars <= MAX_RECORD_CHARS
    && typeof value.payload === 'string' && value.payload.length <= MAX_RECORD_CHARS * 2
    && value.payload.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.payload);
}
async function encodeRecord(text: string): Promise<ExecutionArchive> {
  if (text.length > MAX_RECORD_CHARS) throw new Error('Execution record is too large to archive safely.');
  const bytes = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { version: 1, encoding: 'gzip-base64', digest: await executionDigest(text), originalChars: text.length, payload: btoa(binary) };
}
export async function readExecutionArchive(value: unknown): Promise<any> {
  if (!isExecutionArchive(value)) throw new Error('Invalid execution archive.');
  const bytes = Uint8Array.from(atob(value.payload), char => char.charCodeAt(0));
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      text += part.value;
      if (text.length > value.originalChars) throw new Error('Execution archive exceeds declared size.');
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (text.length !== value.originalChars || await executionDigest(text) !== value.digest) throw new Error('Execution archive integrity check failed.');
  return JSON.parse(text);
}

async function eligible(record: any, cutoff: number): Promise<boolean> {
  if (!record || record.archived || record.owner || record.createdAt > cutoff
    || !Array.isArray(record.sources) || !record.sources.length
    || !Array.isArray(record.response?.textParts) || !record.response.textParts.length
    || !Array.isArray(record.receipts) || record.receipts.some((r: any) => !['saved', 'existing', 'rejected'].includes(r.status))) return false;
  for (const key of ['kumiko_turn_pending_v1', 'kumiko_turn_location_pending_v1']) {
    if ((await db.keyval.get(key))?.value?.turnId === record.id) return false;
  }
  const active = [...((await db.keyval.get('kumiko_relative_reminders'))?.value || []),
    ...((await db.keyval.get('kumiko_daily_reminders'))?.value || [])];
  if (record.receipts.some((r: any) => r.reminderId && active.some((task: any) => task.id === r.reminderId))) return false;
  for (const source of record.sources) {
    const message = await db.messages.get(source.id);
    if (!message || message.role !== 'user' || message.text !== source.text || message.timestamp !== source.timestamp) return false;
  }
  const id = (i: number) => `turn-reply:${record.epoch}:${record.id}:${i}`;
  const first = await db.messages.get(id(0));
  if (first?.role === 'model' && first.text === record.response.textParts.join(' ')) return true;
  for (let i = 0; i < record.response.textParts.length; i++) {
    const message = await db.messages.get(id(i));
    if (!message || message.role !== 'model' || message.text !== record.response.textParts[i]) return false;
  }
  return true;
}

/** Archive only old, fully displayed replies. User history, source ownership,
 * action receipts and incomplete work are retained. Compress outside IDB. */
export async function archiveCompletedTurns(limit = 20, now = Date.now(), assertClaim?: () => Promise<void>): Promise<number> {
  if (isDataRestoreBlocked() || isMemoryMaintenanceBlocked() || typeof CompressionStream === 'undefined') return 0;
  const generation = getDataRestoreVersion();
  const memoryGeneration = getMemoryGeneration();
  const cutoff = now - RETAIN_MS;
  const status = (await db.keyval.get(TURN_ARCHIVE_STATUS_KEY))?.value;
  const cursor = typeof status?.cursor === 'string' && status.cursor.startsWith(TURN_PREFIX) ? status.cursor : TURN_PREFIX;
  const scanLimit = Math.max(1, Math.min(100, limit * 4));
  const candidates = await db.keyval.where('key').between(cursor, TURN_PREFIX + '\uffff', false, true)
    .filter(row => !row.value?.archived && row.value?.createdAt < cutoff && !row.value?.owner).limit(scanLimit).toArray();
  let count = 0;
  for (const candidate of candidates) {
    if (isDataRestoreBlocked() || isMemoryMaintenanceBlocked() || getDataRestoreVersion() !== generation) break;
    if (!await db.transaction('r', [db.keyval, db.messages], () => eligible(candidate.value, cutoff))) continue;
    const original = JSON.stringify(candidate.value);
    const archive = await encodeRecord(original);
    const { id, sources, epoch, sequence, createdAt, privateTimeZone, receipts, sourceImageIds } = candidate.value;
    const compact = { id, sources, epoch, sequence, createdAt, privateTimeZone, receipts,
      ...(sourceImageIds ? { sourceImageIds } : {}), archived: { key: TURN_ARCHIVE_PREFIX + id, digest: archive.digest } };
    if (JSON.stringify(archive).length > MAX_RECORD_CHARS || JSON.stringify(compact).length + JSON.stringify(archive).length >= original.length) continue;
    if (JSON.stringify(await readExecutionArchive(archive)) !== original) throw new Error('Archive verification failed before replacement.');
    const tables: Array<import('dexie').Table<any, any>> = [db.keyval, db.messages];
    if (assertClaim) tables.push(db.table('runtimeJobs'));
    const archived = await db.transaction('rw', tables, async () => {
      if (isDataRestoreBlocked() || getDataRestoreVersion() !== generation) return false;
      await assertMemoryGenerationCurrent(memoryGeneration);
      await assertClaim?.();
      const current = (await db.keyval.get(candidate.key))?.value;
      if (JSON.stringify(current) !== original || !await eligible(current, cutoff)) return false;
      const key = TURN_ARCHIVE_PREFIX + current.id;
      await db.keyval.put({ key, value: archive });
      const verified = (await db.keyval.get(key))?.value;
      if (JSON.stringify(verified) !== JSON.stringify(archive)) throw new Error('Archive readback failed.');
      await db.keyval.put({ key: candidate.key, value: compact });
      await assertClaim?.();
      await assertMemoryGenerationCurrent(memoryGeneration);
      return true;
    });
    if (archived) count++;
  }
  if (!isDataRestoreBlocked() && !isMemoryMaintenanceBlocked() && getDataRestoreVersion() === generation) {
    const tables: Array<import('dexie').Table<any, any>> = [db.keyval];
    if (assertClaim) tables.push(db.table('runtimeJobs'));
    await db.transaction('rw', tables, async () => {
      await assertMemoryGenerationCurrent(memoryGeneration); await assertClaim?.();
      await db.keyval.put({ key: TURN_ARCHIVE_STATUS_KEY, value: { cursor: candidates.length < scanLimit ? '' : candidates.at(-1)!.key,
        archived: (Number(status?.archived) || 0) + count, at: Date.now() } });
    });
  }
  return count;
}
