import { db } from './db';
import { assertDataWritesAllowed, getDataRestoreVersion, isDataRestoreBlocked } from './dataRestoreGate';
import { assertMemoryAvailable, assertMemoryGenerationCurrent, isMemoryMaintenanceBlocked } from './memoryMaintenanceGate';
import { withMediaResetFence } from './mediaWriteFence';
import { deleteVoiceFile } from './voiceFileService';
import { VOICE_WRITE_PREFIX, isVoiceWriteRecord, validVoiceId as validId, validVoiceSource as validSource, type VoiceWriteRecord } from './voiceWriteRecord';
export { VOICE_WRITE_PREFIX, isVoiceWriteRecord, type VoiceWriteRecord } from './voiceWriteRecord';
type HeldLease = { release(): void; completion: Promise<void> };
const held = new Map<string, HeldLease>();
const key = (id: string) => VOICE_WRITE_PREFIX + id;
const lockName = (id: string) => `kumiko-voice-file-v1:${id}`;

/** Acquire before saving, while the caller already owns the media-write lock.
 * The per-file lease remains held until the message/retained task is durable
 * or the caller explicitly abandons it. Process death releases it automatically. */
export async function beginVoiceWrite(input: { id: string; sourceIds: string[]; memoryGeneration: string; taskId?: string }): Promise<void> {
  if (!validId(input.id) || !Array.isArray(input.sourceIds) || input.sourceIds.length > 10000
    || !input.sourceIds.every(validSource) || !validSource(input.memoryGeneration)
    || (input.taskId !== undefined && !validSource(input.taskId))) throw new Error('Invalid voice write identity.');
  if (held.has(input.id)) throw new Error('Voice write is already active.');
  if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('Safe voice write locking is unavailable.');
  let release!: () => void;
  let resolveAcquired!: (acquired: boolean) => void;
  let rejectAcquired!: (error: unknown) => void;
  const acquired = new Promise<boolean>((resolve, reject) => { resolveAcquired = resolve; rejectAcquired = reject; });
  const completion = navigator.locks.request(lockName(input.id), { ifAvailable: true }, async lock => {
    if (!lock) { resolveAcquired(false); return; }
    const released = new Promise<void>(resolve => { release = resolve; });
    resolveAcquired(true);
    await released;
  }).catch(error => { rejectAcquired(error); throw error; });
  // Observe rejection even if registration itself fails before completion is awaited.
  void completion.catch(() => {});
  if (!await acquired) throw new Error('Voice write is owned by another window.');
  try {
    const sourceIds = [...new Set(input.sourceIds)];
    await db.transaction('rw', [db.keyval, db.messages], async () => {
      assertDataWritesAllowed(); await assertMemoryGenerationCurrent(input.memoryGeneration);
      if (await db.keyval.get(key(input.id))) throw new Error('Voice write identity already exists.');
      if ((await db.messages.toArray()).some(message => message.id === input.id || message.voiceFileId === input.id))
        throw new Error('Voice write identity is already referenced.');
      const now = Date.now();
      const row: VoiceWriteRecord = { version: 1, id: input.id, sourceIds, memoryGeneration: input.memoryGeneration,
        ...(input.taskId ? { taskId: input.taskId } : {}), status: 'reserved', createdAt: now, updatedAt: now, attempt: 0, retryAt: now };
      await db.keyval.put({ key: key(row.id), value: row });
    });
    held.set(input.id, { release, completion });
  } catch (error) { release(); await completion.catch(() => {}); throw error; }
}

/** Finish after the durable reference is committed, or after abandoning it. */
export async function finishVoiceWrite(id: string): Promise<boolean> {
  const lease = held.get(id);
  if (!lease) return false;
  try {
    await db.transaction('rw', db.keyval, async () => {
      assertDataWritesAllowed();
      const row = (await db.keyval.get(key(id)))?.value as VoiceWriteRecord | undefined;
      if (!row || !isVoiceWriteRecord(key(id), row)) return;
      await assertMemoryGenerationCurrent(row.memoryGeneration);
      await db.keyval.put({ key: key(id), value: { ...row, status: 'pending', updatedAt: Date.now(), retryAt: Date.now() } });
    });
    return true;
  } finally {
    held.delete(id); lease.release(); await lease.completion.catch(() => {});
  }
}

function containsReference(value: unknown, id: string, seen = new Set<object>(), depth = 0): boolean {
  if (typeof value === 'string') return value === id;
  if (!value || typeof value !== 'object') return false;
  // An unusually deep/cyclic object is conservatively protected.
  if (depth > 64 || seen.has(value)) return true;
  seen.add(value);
  const found = Object.values(value).some(item => containsReference(item, id, seen, depth + 1));
  seen.delete(value);
  return found;
}

async function hasRetainedReference(id: string): Promise<boolean> {
  return db.transaction('r', [db.messages, db.runtimeJobs, db.keyval], async () => {
    if ((await db.messages.toArray()).some(message => message.id === id || message.voiceFileId === id)) return true;
    if ((await db.runtimeJobs.toArray()).some(job => containsReference(job, id))) return true;
    let referenced = false;
    await db.keyval.toCollection().each(row => {
      if (!referenced && !row.key.startsWith(VOICE_WRITE_PREFIX) && containsReference(row.value, id)) referenced = true;
    });
    return referenced;
  });
}

/** Explicit discard is safe even when another window owns the voice or when
 * the caller restarted. A legacy file receives a durable cleanup obligation
 * before deletion; it never bypasses the per-ID lock or reference checks. */
export async function discardVoiceSafely(id: string): Promise<void> {
  if (!validId(id)) throw new Error('Invalid voice write identity.');
  await finishVoiceWrite(id);
  if (isDataRestoreBlocked() || isMemoryMaintenanceBlocked()) return;
  if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('Safe voice cleanup locking is unavailable.');
  await withMediaResetFence(async () => {
    assertDataWritesAllowed(); assertMemoryAvailable();
    const restoreVersion = getDataRestoreVersion();
    await navigator.locks.request(lockName(id), { ifAvailable: true }, async lock => {
      if (!lock) return;
      const existing = (await db.keyval.get(key(id)))?.value as VoiceWriteRecord | undefined;
      if (existing && !isVoiceWriteRecord(key(id), existing)) throw new Error('Voice cleanup record is invalid.');
      if (await hasRetainedReference(id)) {
        if (existing) await db.keyval.put({ key: key(id), value: { ...existing, status: 'referenced', updatedAt: Date.now(), retryAt: Date.now() + 60_000 } });
        return;
      }
      let row = existing;
      if (!row) {
        const memoryGeneration = (await db.keyval.get('kumiko_memory_generation_v1'))?.value || 'initial';
        await assertMemoryGenerationCurrent(memoryGeneration);
        const now = Date.now();
        row = { version: 1, id, sourceIds: [], memoryGeneration, status: 'pending', createdAt: now, updatedAt: now, attempt: 0, retryAt: now };
        await db.keyval.put({ key: key(id), value: row });
      }
      assertDataWritesAllowed(); assertMemoryAvailable();
      if (getDataRestoreVersion() !== restoreVersion) throw new Error('Voice cleanup belongs to an earlier dataset.');
      let deleted = false;
      try { deleted = await deleteVoiceFile(id); } catch { /* Keep obligation below. */ }
      assertDataWritesAllowed(); assertMemoryAvailable();
      if (getDataRestoreVersion() !== restoreVersion) throw new Error('Voice cleanup belongs to an earlier dataset.');
      if (deleted) await db.keyval.delete(key(id));
      else {
        const attempt = row.attempt + 1;
        await db.keyval.put({ key: key(id), value: { ...row, status: 'pending', attempt, updatedAt: Date.now(),
          retryAt: Date.now() + Math.min(3_600_000, 5_000 * 2 ** Math.min(attempt - 1, 10)) } });
      }
    });
  });
}

/** Run at startup and periodically. Only an unlocked ID with no retained
 * reference is deleted. Failure remains durable and retries with backoff. */
export async function reconcileVoiceLedger(limit = 4): Promise<{ checked: number; removed: number; retained: number; failed: number }> {
  const result = { checked: 0, removed: 0, retained: 0, failed: 0 };
  if (isDataRestoreBlocked() || isMemoryMaintenanceBlocked()) return result;
  if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('Safe voice cleanup locking is unavailable.');
  return withMediaResetFence(async () => {
    assertDataWritesAllowed(); assertMemoryAvailable();
    const restoreVersion = getDataRestoreVersion();
    const bound = Math.max(1, Math.min(32, limit));
    const due = (row: { key: string; value: any }) => isVoiceWriteRecord(row.key, row.value) && row.value.retryAt <= Date.now();
    const pending = await db.keyval.where('key').startsWith(VOICE_WRITE_PREFIX)
      .filter(row => due(row) && row.value.status !== 'referenced').limit(bound).toArray();
    const referenced = await db.keyval.where('key').startsWith(VOICE_WRITE_PREFIX)
      .filter(row => due(row) && row.value.status === 'referenced').limit(1).toArray();
    const entries = referenced.length && bound > 1 ? [...pending.slice(0, bound - 1), ...referenced] : pending.slice(0, bound);
    if (!entries.length && referenced.length) entries.push(referenced[0]);
    for (const entry of entries) {
      if (isDataRestoreBlocked() || isMemoryMaintenanceBlocked() || getDataRestoreVersion() !== restoreVersion) break;
      const original = entry.value as VoiceWriteRecord;
      await navigator.locks.request(lockName(original.id), { ifAvailable: true }, async lock => {
        if (!lock) return;
        result.checked++;
        const current = (await db.keyval.get(entry.key))?.value as VoiceWriteRecord | undefined;
        if (!current || !isVoiceWriteRecord(entry.key, current) || current.updatedAt !== original.updatedAt) return;
        if (await hasRetainedReference(current.id)) {
          await db.keyval.put({ key: entry.key, value: { ...current, status: 'referenced', updatedAt: Date.now(), retryAt: Date.now() + 60_000 } });
          result.retained++; return;
        }
        assertDataWritesAllowed(); assertMemoryAvailable();
        if (getDataRestoreVersion() !== restoreVersion) throw new Error('Voice cleanup belongs to an earlier dataset.');
        let deleted = false;
        try { deleted = await deleteVoiceFile(current.id); } catch { /* Preserve obligation below. */ }
        assertDataWritesAllowed(); assertMemoryAvailable();
        if (getDataRestoreVersion() !== restoreVersion) throw new Error('Voice cleanup belongs to an earlier dataset.');
        if (deleted) { await db.keyval.delete(entry.key); result.removed++; }
        else {
          const attempt = current.attempt + 1;
          await db.keyval.put({ key: entry.key, value: { ...current, status: 'pending', attempt, updatedAt: Date.now(),
            retryAt: Date.now() + Math.min(3_600_000, 5_000 * 2 ** Math.min(attempt - 1, 10)) } });
          result.failed++;
        }
      });
    }
    return result;
  });
}
