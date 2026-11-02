import { db } from './db';
import { beginDataRestore, finishDataRestore, getDataRestoreVersion, markDataRestoreCommitted,
  ownDataRestoreRecovery, permitDataRestoreTransaction, readDataRestoreGate } from './dataRestoreGate';
import { rollbackPreparedBackupMedia, type PreparedBackupMediaHooks } from './backupMediaStaging';
import type { Message } from '../types';
import { withMediaResetFence } from './mediaWriteFence';

export const RESTORE_JOURNAL_KEY = 'kumiko_restore_journal_v1';
export const LAST_RESTORE_SNAPSHOT_KEY = 'kumiko_before_restore_v1';
type Snapshot = { tables: Record<string, any[]>; nativeVectors?: any[]; nativeMessages?: Message[] };
type Journal = { id: string; phase: 'prepared' | 'applying' | 'committed'; snapshot: Snapshot;
  mediaSnapshot?: unknown; nativeChanged?: boolean; mediaChanged?: boolean };
const desktop = () => typeof window !== 'undefined' ? window.electronAPI : undefined;
async function exclusiveRestore<T>(work: () => Promise<T>, wait: boolean): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('kumiko-data-restore-v1', { mode: 'exclusive', ifAvailable: !wait }, lock => {
      if (!lock) throw new Error('Another window is restoring data. Please wait.');
      return work();
    });
  }
  // Fail closed in actual clients that cannot coordinate windows. Node-only
  // fault fixtures have no browser or real user data and need no Web Lock.
  if (typeof window !== 'undefined') throw new Error('This environment does not support safe restore locking.');
  return work();
}

async function nativeLock(id: string, action: 'begin' | 'end') {
  if (!desktop()) return;
  const result = await desktop()!.invoke('rag:restore-lock', { id, action });
  if (!result?.success) throw new Error(result?.error || 'Cannot protect the native memory store for restore.');
}
async function writeJournal(journal: Journal) {
  await db.transaction('rw', db.keyval, async tx => {
    permitDataRestoreTransaction(tx, journal.id);
    await db.keyval.put({ key: RESTORE_JOURNAL_KEY, value: journal });
  });
}
async function nativeReplace(id: string, messages: Message[], vectors: any[]) {
  const ipc = desktop();
  if (!ipc) return; // Mobile/web authoritative vectors live in the same Dexie transaction.
  const raw = await ipc.invoke('rag:sync-messages', { messages, replaceAll: true, restoreSessionId: id });
  if (!raw?.success) throw new Error(raw?.error || 'Raw history restore failed.');
  const memory = await ipc.invoke('rag:restore', { vectors, restoreSessionId: id });
  if (!memory?.success || memory.count !== vectors.length) throw new Error(memory?.error || 'Memory restore was incomplete.');
}
async function rollback(journal: Journal) {
  validateJournal(journal);
  if (journal.mediaChanged) await rollbackPreparedBackupMedia(journal.mediaSnapshot as any, journal.id);
  if (journal.nativeChanged) await nativeReplace(journal.id, journal.snapshot.nativeMessages || [], journal.snapshot.nativeVectors || []);
  await db.transaction('rw', db.tables, async tx => {
    permitDataRestoreTransaction(tx, journal.id);
    for (const table of db.tables) {
      await table.clear();
      const rows = journal.snapshot.tables[table.name];
      if (rows?.length) await table.bulkPut(rows);
    }
    // A rolled-back restore must still fence pre-restore asynchronous work.
    await db.keyval.put({ key: 'kumiko_turn_epoch_v1', value: crypto.randomUUID() });
    await db.keyval.put({ key: LAST_RESTORE_SNAPSHOT_KEY, value: journal.snapshot });
  });
}
function validateJournal(journal: Journal): void {
  if (!journal || typeof journal.id !== 'string' || !['prepared', 'applying', 'committed'].includes(journal.phase)
    || !journal.snapshot?.tables || !db.tables.every(table => Array.isArray(journal.snapshot.tables[table.name]))) {
    throw new Error('Restore snapshot is incomplete; refusing to replace any data.');
  }
  if (journal.nativeChanged && (!Array.isArray(journal.snapshot.nativeVectors) || !Array.isArray(journal.snapshot.nativeMessages))) {
    throw new Error('Native restore snapshot is incomplete; refusing compensation.');
  }
}

/** The gate remains set if compensation fails. Startup must resolve the journal
 * before it loads data or enables jobs; no mixture is presented as restored. */
export async function recoverInterruptedBackupRestore(): Promise<boolean> {
  const gate = readDataRestoreGate();
  if (!gate) return false;
  if (gate.kind === 'reset') throw new Error('Pending data reset must be recovered before backup recovery.');
  return exclusiveRestore(() => withMediaResetFence(recoverOwnedRestore), true);
}
async function recoverOwnedRestore(): Promise<boolean> {
  const gate = readDataRestoreGate();
  if (!gate) return false;
  ownDataRestoreRecovery(gate.id);
  await nativeLock(gate.id, 'begin');
  const journal = (await db.keyval.get(RESTORE_JOURNAL_KEY))?.value as Journal | undefined;
  if (journal) {
    if (journal.id !== gate.id) throw new Error('Restore journal identity mismatch; writes remain paused.');
    validateJournal(journal);
    if (journal.phase !== 'committed') await rollback(journal);
    else await db.transaction('rw', db.keyval, async tx => {
      permitDataRestoreTransaction(tx, gate.id);
      await db.keyval.delete(RESTORE_JOURNAL_KEY);
    });
  }
  await nativeLock(gate.id, 'end');
  finishDataRestore(gate.id);
  return true;
}

export async function runBackupRestoreSession(
  data: { messages: Message[]; vectors?: any[] },
  persist: (restoreId: string) => Promise<void>,
  publish: () => void,
  media?: PreparedBackupMediaHooks,
  expectedVersion = getDataRestoreVersion(),
): Promise<void> {
  return exclusiveRestore(() => withMediaResetFence(() => runOwnedRestore(data, persist, publish, media, expectedVersion)), false);
}
async function runOwnedRestore(
  data: { messages: Message[]; vectors?: any[] }, persist: (restoreId: string) => Promise<void>,
  publish: () => void, media: PreparedBackupMediaHooks | undefined, expectedVersion: string,
): Promise<void> {
  const id = crypto.randomUUID();
  let journal: Journal | undefined;
  let gateStarted = false;
  let lockedNative = false;
  // All-table barrier drains existing IDB writers. Other windows take this
  // same barrier; only one can install the durable latch.
  await db.transaction('rw', db.tables, async tx => {
    if (getDataRestoreVersion() !== expectedVersion) throw new Error('Backup import belongs to an earlier dataset.');
    beginDataRestore(id); gateStarted = true;
    permitDataRestoreTransaction(tx, id);
  });
  try {
    await nativeLock(id, 'begin'); lockedNative = true;
    const snapshot: Snapshot = { tables: {} };
    if (desktop()) {
      const vectors = await desktop()!.invoke('rag:get-all');
      const messages = await desktop()!.invoke('rag:get-messages');
      if (!vectors?.success || !Array.isArray(vectors.vectors) || !messages?.success || !Array.isArray(messages.messages)) {
        throw new Error('Cannot snapshot the original native memory and raw history.');
      }
      // Preserve every original record; permissive normal-load helpers may
      // filter or turn transport failures into [], which is unsafe for rollback.
      snapshot.nativeVectors = vectors.vectors;
      snapshot.nativeMessages = messages.messages;
    }
    const mediaSnapshot = media ? await media.snapshot() : undefined;
    await db.transaction('rw', db.tables, async tx => {
      permitDataRestoreTransaction(tx, id);
      for (const table of db.tables) {
        const rows = await table.toArray();
        snapshot.tables[table.name] = table.name === 'keyval'
          ? rows.filter(row => row.key !== RESTORE_JOURNAL_KEY && row.key !== LAST_RESTORE_SNAPSHOT_KEY) : rows;
      }
      journal = { id, phase: 'prepared', snapshot, mediaSnapshot };
      await db.keyval.put({ key: RESTORE_JOURNAL_KEY, value: journal });
      await db.keyval.put({ key: LAST_RESTORE_SNAPSHOT_KEY, value: snapshot });
    });
    journal!.phase = 'applying';
    if (media) {
      journal!.mediaChanged = true; await writeJournal(journal!);
      await media.commit(id);
    }
    await persist(id);
    if (desktop()) {
      journal!.nativeChanged = true; await writeJournal(journal!);
      // A legacy backup without vectors must not keep answering from a stale
      // memory bank. The original, including independent chunks, is archived.
      await nativeReplace(id, data.messages, data.vectors || []);
    }
    journal!.phase = 'committed'; await writeJournal(journal!);
    markDataRestoreCommitted(id);
    publish();
    await nativeLock(id, 'end'); lockedNative = false;
    await db.transaction('rw', db.keyval, async tx => {
      permitDataRestoreTransaction(tx, id);
      await db.keyval.delete(RESTORE_JOURNAL_KEY);
    });
    finishDataRestore(id);
  } catch (error) {
    if (journal?.phase === 'committed') {
      // The dataset is complete. Startup reloads it; do not mutate the UI
      // backwards after some setters may already have accepted the new state.
      throw error;
    }
    try {
      if (journal) await rollback(journal);
      if (lockedNative) await nativeLock(id, 'end');
      if (gateStarted) finishDataRestore(id);
    } catch (rollbackError) {
      throw new Error('Restore recovery is incomplete. Writes remain paused. ' + String(rollbackError), { cause: error });
    }
    throw error;
  }
}
