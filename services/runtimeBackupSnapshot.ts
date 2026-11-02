import { db } from './db';
import { assertMemoryAvailable, getMemoryGeneration } from './memoryMaintenanceGate';
import { assertDataWritesAllowed, getDataRestoreVersion } from './dataRestoreGate';
import { readTurnExecutionEntries, packExecutionState } from './turnStateBackup';
import { mapEntityToMessage } from '../components/app/messageMappers';

/** Content and provenance are captured together; hashing happens afterwards,
 * outside the short IndexedDB transaction. UI mirrors are not evidence. */
export async function captureRuntimeBackupData(fallback: any): Promise<any> {
  assertDataWritesAllowed(); assertMemoryAvailable();
  const memoryGeneration = getMemoryGeneration(), restoreVersion = getDataRestoreVersion();
  const snapshot = await db.transaction('r', db.tables, async () => {
    const entries = await readTurnExecutionEntries();
    const fields: Record<string,string> = { coreMemory: 'kumiko_core_memory', kumikoNotebook: 'kumiko_notebook',
      summaryArchiveState: 'kumiko_summary_archive_state', anchors: 'kumiko_anchors', worldCharacterStatus: 'world_character_status' };
    const data = { ...fallback, memoryAssetRevisions: {} as Record<string,string> };
    for (const [field, key] of Object.entries(fields)) {
      const row = await db.keyval.get(key);
      if (row) { data[field] = row.value; if (row.sourceRevision) data.memoryAssetRevisions[key] = row.sourceRevision; }
    }
    data.messages = (await db.messages.orderBy('timestamp').toArray()).map(mapEntityToMessage);
    data.kumikoDiary = await db.kumikoDiary.orderBy('date').toArray();
    data.dailyFragments = await db.dailyFragments.orderBy('timestamp').toArray();
    data.psycheState = await db.psycheState.get('current') ?? null;
    data.episodes = await db.episodes.orderBy('startTimestamp').toArray();
    data.userKnownLocation = (await db.keyval.get('user_known_location_v1'))?.value ?? null;
    return { data, entries };
  });
  snapshot.data.executionState = await packExecutionState(snapshot.entries);
  assertDataWritesAllowed(); assertMemoryAvailable(memoryGeneration);
  if (getDataRestoreVersion() !== restoreVersion) throw new Error('Dataset changed during backup.');
  return snapshot.data;
}
