import { db } from './db';
export const RUNTIME_TABLES = ['runtimeJobs', 'runtimeRequestAttempts', 'stateCommits', 'memoryDependencies', 'memoryCorrections', 'messageViews'] as const;
export type RuntimeTableName = typeof RUNTIME_TABLES[number];
const PREFIX = 'runtime13:';
export const RUNTIME_KEY_PREFIXES = ['kumiko_state_version_v1:', 'kumiko_block_outbox_v1:', 'kumiko_diary_draft_v1:', 'kumiko_summary_artifact_v1:', 'kumiko_memory_asset_v1:', 'kumiko_voice_write_v1:'];
export const RUNTIME_KEYS = ['kumiko_memory_generation_v1', 'kumiko_memory_maintenance_v1', 'kumiko_background_network_paused_v1'];
const object = (value: any): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: any): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1000;
const number = (value: any) => Number.isFinite(value) && value >= 0;
const strings = (value: any) => Array.isArray(value) && value.length <= 200000 && value.every(text);
export function runtimeEntryKey(table: RuntimeTableName, id: string): string { return PREFIX + JSON.stringify([table, id]); }
export function parseRuntimeEntryKey(key: string): { table: RuntimeTableName; id: string } | null {
  if (!key.startsWith(PREFIX)) return null;
  try {
    const pair = JSON.parse(key.slice(PREFIX.length));
    if (!Array.isArray(pair) || pair.length !== 2 || !RUNTIME_TABLES.includes(pair[0]) || !text(pair[1])) return null;
    return { table: pair[0], id: pair[1] };
  } catch { return null; }
}
export function validateRuntimeEntry(key: string, value: unknown): boolean {
  const info = parseRuntimeEntryKey(key);
  if (!info || !object(value) || value.id !== info.id) return false;
  switch (info.table) {
    case 'runtimeJobs': return text(value.kind) && text(value.status) && text(value.epoch) && text(value.sourceId)
      && text(value.sourceVersion) && number(value.attempt) && number(value.createdAt) && number(value.updatedAt) && number(value.retryAt);
    case 'runtimeRequestAttempts': return text(value.rootId) && text(value.taskId) && text(value.role)
      && ['foreground', 'background'].includes(value.lane) && text(value.status) && number(value.startedAt);
    case 'stateCommits': return text(value.signature) && text(value.kind) && text(value.epoch) && number(value.committedAt);
    case 'memoryDependencies': return text(value.artifactId) && text(value.artifactKind) && text(value.artifactVersion)
      && text(value.sourceId) && text(value.sourceVersion) && ['message','diary','fragment','receipt','artifact'].includes(value.sourceKind)
      && ['quoted','derived','basis','context'].includes(value.relation) && number(value.createdAt);
    case 'memoryCorrections': return value.version === 1 && ['prepared','purging','rebuilding','failed','completed'].includes(value.status)
      && text(value.generation) && number(value.createdAt) && number(value.updatedAt) && strings(value.messageIds)
      && strings(value.artifactIds) && object(value.sourceVersions) && typeof value.includeLegacyDerived === 'boolean' && text(value.phase)
      && [value.reminderIds, value.unknownReminderSourceIds, value.imageIds, value.voiceIds, value.retainedPrivateKeys,
        value.affectedPrivateKeys, value.unknownPrivateKeys, value.protectedArtifactIds, value.affectedStateCommitIds,
        value.unknownStateCommitIds, value.anchorIds, value.unknownAnchorIds].every(ids => ids === undefined || strings(ids))
      && (value.sharedVoicesRetained === undefined || (Array.isArray(value.sharedVoicesRetained)
        && value.sharedVoicesRetained.every((row: any) => object(row) && text(row.id) && strings(row.messageIds))))
      && (value.redactBlockReason === undefined || typeof value.redactBlockReason === 'boolean');
    case 'messageViews': return number(value.locallyDeletedAt) && number(value.updatedAt);
  }
}
export function isRuntimeKey(key: string): boolean {
  return key.startsWith(PREFIX) || RUNTIME_KEYS.includes(key) || RUNTIME_KEY_PREFIXES.some(prefix => key.startsWith(prefix));
}
/** Caller holds one transaction over keyval and all runtime tables. */
export async function runtimeBackupEntries(): Promise<Array<{ key: string; value: unknown }>> {
  const entries: Array<{ key: string; value: unknown }> = [];
  for (const name of RUNTIME_TABLES) for (const row of await db.table(name).toArray()) entries.push({ key: runtimeEntryKey(name, row.id), value: row });
  return entries;
}
/** Incoming leases are never resumed; completed checkpoints remain available. */
export async function replaceRuntimeTables(entries: Array<{ key: string; value: unknown }>): Promise<void> {
  const localCorrections = await db.memoryCorrections.toArray();
  const recentRequests = await db.runtimeRequestAttempts.where('startedAt').above(Date.now() - 3600000).toArray();
  for (const table of RUNTIME_TABLES) await db.table(table).clear();
  for (const entry of entries) {
    const info = parseRuntimeEntryKey(entry.key); if (!info) continue;
    if (!validateRuntimeEntry(entry.key, entry.value)) throw new Error('Invalid runtime backup row.');
    const row = { ...(entry.value as any) };
    if (info.table === 'runtimeJobs') {
      delete row.owner; delete row.token; delete row.leaseUntil;
      if (row.status === 'running') { row.status = 'retrying'; row.retryAt = Date.now(); }
    }
    if (info.table === 'runtimeRequestAttempts' && row.status === 'running') { row.status = 'unknown'; row.leaseUntil = 0; }
    await db.table(info.table).put(row);
  }
  // Restoring an older snapshot cannot remove a newer local erasure instruction.
  for (const rule of localCorrections) {
    const incoming = await db.memoryCorrections.get(rule.id);
    if (!incoming || incoming.updatedAt < rule.updatedAt) await db.memoryCorrections.put(rule);
  }
  // Data restoration is not permission to replenish this hour's remote budget.
  for (const row of recentRequests) if (!await db.runtimeRequestAttempts.get(row.id)) await db.runtimeRequestAttempts.put({ ...row, status: row.status === 'running' ? 'unknown' : row.status, leaseUntil: 0 });
}
