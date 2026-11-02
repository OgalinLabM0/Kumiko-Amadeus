import type { MemoryCorrection, MemoryDependency } from './runtimeEntities';

export const PRIVATE_DERIVED_KEYS = new Set([
  'kumiko_core_memory', 'kumiko_notebook', 'kumiko_anchors', 'kumiko_summary_archive_state',
  'kumiko_memory_query_session', 'kumiko_busy_followup', 'kumiko_pending_apology',
  'kumiko_busy_slot_runtime', 'kumiko_message_alerts', 'kumiko_missed_reminders',
  'kumiko_before_restore_v1', 'kumiko_chat_history',
]);
export const PRIVATE_DERIVED_PREFIXES = ['kumiko_diary_draft_v1:', 'kumiko_summary_artifact_v1:'];
export function hasSource(value: any, ids: Set<string>, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 32) return false;
  if (Array.isArray(value)) return value.some(v => hasSource(v, ids, depth + 1));
  for (const key of ['sourceMessageId', 'messageId', 'sourceId', 'triggerMessageId']) if (typeof value[key] === 'string' && ids.has(value[key])) return true;
  for (const key of ['sourceMessage', 'quote']) if (typeof value[key]?.id === 'string' && ids.has(value[key].id)) return true;
  for (const key of ['sources', 'sourceRefs', 'inputSources', 'versionedSources', 'messages'])
    if (Array.isArray(value[key]) && value[key].some((v: any) => ids.has(v?.id))) return true;
  for (const key of ['sourceIds', 'messageIds', 'userMessageIds', 'capturedUnreadIds'])
    if (Array.isArray(value[key]) && value[key].some((v: any) => ids.has(v))) return true;
  return Object.values(value).some(v => v && typeof v === 'object' && hasSource(v, ids, depth + 1));
}
export function dependentArtifacts(ids: string[], edges: MemoryDependency[]): Set<string> {
  const affected = new Set(ids.map(id => `message:${id}`));
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (edge.relation === 'context' || !affected.has(`${edge.sourceKind}:${edge.sourceId}`)) continue;
      const key = `${edge.artifactKind}:${edge.artifactId}`;
      if (!affected.has(key)) { affected.add(key); changed = true; }
    }
  }
  return affected;
}
export function isOfficialVector(row: any): boolean {
  return row?.tier === 'lore' || row?.source === 'lore' || row?.source === 'official_lore' || row?.source === 'worldbook' || row?.source === 'official';
}
export function ruleMatchesRow(row: any, table: string, rule: MemoryCorrection): boolean {
  if (table === 'vectors' && isOfficialVector(row)) return false;
  const ids = new Set(rule.messageIds);
  if (table === 'messages') return ids.has(row.id);
  const aliases: Record<string,string> = { kumikoDiary: 'diary', dailyFragments: 'fragment', vectors: 'vector', episodes: 'episode' };
  if (rule.artifactIds.includes(`${table}:${row.id}`) || rule.artifactIds.includes(`${aliases[table] || table}:${row.id}`)) return true;
  if (hasSource(row, ids)) return true;
  if (rule.protectedArtifactIds?.includes(`${table}:${row.id}`) || rule.protectedArtifactIds?.includes(`${aliases[table] || table}:${row.id}`)) return false;
  if (table === 'vectors' && isOfficialVector(row)) return false;
  // Legacy private derived data is removed only within a scope the preview
  // explicitly included. Future valid material is not forbidden by its words.
  const cutoff = (rule as any).legacyCutoff ?? rule.createdAt;
  return rule.includeLegacyDerived && ['vectors','episodes','kumikoDiary','dailyFragments'].includes(table)
    && Number(row.timestamp ?? row.endTimestamp ?? 0) <= cutoff && !row.sourceRefs?.length;
}
export function scrubExecutionEntry(key: string, value: any, ids: Set<string>, legacy = false): any | undefined {
  if (key.startsWith('kumiko_turn_archive_v1:')) return legacy ? undefined : value;
  if (key.startsWith('kumiko_turn_v1:') && (legacy || hasSource(value, ids))) {
    return { id: value.id, epoch: value.epoch, createdAt: value.createdAt, sequence: value.sequence,
      privateTimeZone: 'Asia/Tokyo', redacted: true, receipts: [], factsReady: true, factsComplete: true,
      sources: (value.sources || []).map((s: any) => ({ id: s.id, role: 'user', text: '', timestamp: s.timestamp })) };
  }
  if (key.startsWith('kumiko_received_turn_v1:') && (legacy || hasSource(value, ids))) {
    return { id: value.id, sourceIds: value.sourceIds, receivedAt: value.receivedAt, order: value.order, status: 'completed' };
  }
  if (key.startsWith('kumiko_reminder_action:')) {
    // Older signatures embedded event text. Preserve an opaque, non-replayable
    // identity instead; callers reject any newly proposed differing payload.
    return { signature: `redacted:${key}`, reminderId: value.reminderId, redacted: true };
  }
  if ((key === 'kumiko_turn_pending_v1' || key === 'kumiko_turn_location_pending_v1' || key === 'kumiko_turn_location_uncertain_v1')
    && (legacy || hasSource(value, ids))) return null;
  return value;
}
