import { db, INITIAL_WORLD_CHARACTER_STATUS } from './db';
import { assertMemoryAvailable, getMemoryGeneration, MEMORY_GENERATION_KEY, MEMORY_MAINTENANCE_KEY } from './memoryMaintenanceGate';
import { getBackupExecutionState, executionStateEntries, validateExecutionStateIntegrity, packExecutionState } from './turnStateBackup';
import { parseRuntimeEntryKey, runtimeEntryKey } from './runtimeStateBackup';
import { hasSource, ruleMatchesRow, scrubExecutionEntry, PRIVATE_DERIVED_PREFIXES } from './memoryCorrectionPolicy';
import type { MemoryCorrection } from './runtimeEntities';
import { readExecutionArchive, TURN_ARCHIVE_PREFIX } from './executionArchive';
import { VOICE_WRITE_PREFIX, isVoiceWriteRecord } from './voiceWriteRecord';

const FILTERED_MEDIA = Symbol('memory-correction-filtered-media');
type MediaRemoval = { images: Set<string>; voices: Set<string> };
const ASSETS = [
  { field: 'coreMemory', key: 'kumiko_core_memory', empty: '' },
  { field: 'kumikoNotebook', key: 'kumiko_notebook', empty: '' },
  { field: 'summaryArchiveState', key: 'kumiko_summary_archive_state', empty: null },
  { field: 'worldCharacterStatus', key: 'world_character_status', empty: INITIAL_WORLD_CHARACTER_STATUS },
] as const;

export interface UnverifiedBackupAsset { field: string; reason: string }

function unverifiedAnchorIds(entries: Array<{ key: string; value: any }>, body: any, rules: MemoryCorrection[]): Set<string> {
  const result = new Set<string>(), cleared = new Set(rules.flatMap(rule => rule.messageIds));
  const edges = entries.filter(entry => parseRuntimeEntryKey(entry.key)?.table === 'memoryDependencies').map(entry => entry.value);
  for (const anchor of Array.isArray(body?.anchors) ? body.anchors : []) {
    if (!anchor || typeof anchor.id !== 'string') continue;
    if (rules.some(rule => rule.anchorIds?.includes(anchor.id) || rule.unknownAnchorIds?.includes(anchor.id) || rule.artifactIds.includes(`anchor:${anchor.id}`))) continue;
    const refs = edges.filter(edge => edge.artifactKind === 'anchor' && edge.artifactId === anchor.id);
    const valid = refs.length > 0 && refs.every(ref => {
      if (cleared.has(ref.sourceId) || rules.some(rule => rule.artifactIds.includes(`${ref.sourceKind}:${ref.sourceId}`))) return false;
      const rows = ref.sourceKind === 'message' ? body.messages : ref.sourceKind === 'diary' ? body.kumikoDiary : ref.sourceKind === 'fragment' ? body.dailyFragments : undefined;
      const row = Array.isArray(rows) ? rows.find((item: any) => item.id === ref.sourceId) : undefined;
      const version = ref.sourceKind === 'message' ? row?.contentRevision ?? row?.sourceRevision ?? 'legacy' : row?.sourceRevision ?? 'legacy';
      return !!row && version === ref.sourceVersion;
    });
    if (!valid) result.add(anchor.id);
  }
  return result;
}

async function backupReminderLinks(entries: Array<{ key: string; value: any }>, body: any, rules: MemoryCorrection[]): Promise<{ affected: Set<string>; unknown: Set<string> }> {
  const cleared = new Set(rules.flatMap(rule => rule.messageIds));
  const affected = new Set(rules.flatMap(rule => rule.reminderIds ?? []));
  const known = new Set<string>();
  const matchingTurns = new Set<string>();
  for (const entry of entries) {
    const turn = entry.key.startsWith(TURN_ARCHIVE_PREFIX) ? await readExecutionArchive(entry.value)
      : entry.key.startsWith('kumiko_turn_v1:') ? entry.value : null;
    if (!turn) continue;
    const match = hasSource(turn, cleared);
    if (match && typeof turn.id === 'string') matchingTurns.add(turn.id);
    for (const receipt of turn.receipts ?? []) if (typeof receipt.reminderId === 'string') {
      known.add(receipt.reminderId); if (match) affected.add(receipt.reminderId);
    }
  }
  for (const entry of entries) if (entry.key.startsWith('kumiko_reminder_action:') && typeof entry.value?.reminderId === 'string') {
    known.add(entry.value.reminderId);
    const action = entry.key.slice('kumiko_reminder_action:'.length);
    if ([...matchingTurns].some(id => action.startsWith(id + ':reminder:'))) affected.add(entry.value.reminderId);
  }
  const reminders = [...(Array.isArray(body?.relativeReminders) ? body.relativeReminders : []), ...(Array.isArray(body?.dailyReminders) ? body.dailyReminders : [])];
  for (const reminder of reminders) if (hasSource(reminder, cleared) && typeof reminder.id === 'string') affected.add(reminder.id);
  return { affected, unknown: new Set(reminders.filter(r => typeof r?.id === 'string' && typeof r.sourceText === 'string'
    && !!r.sourceText && !known.has(r.id) && !affected.has(r.id)).map(r => r.id)) };
}

/** Preview unproven private assets before an import is allowed to remove them. */
export async function inspectBackupMemoryAssets(input: any): Promise<UnverifiedBackupAsset[]> {
  assertMemoryAvailable();
  const state = await validateExecutionStateIntegrity(getBackupExecutionState(input));
  const entries = executionStateEntries(state);
  const local = await db.memoryCorrections.toArray();
  const incoming = entries.filter(e => parseRuntimeEntryKey(e.key)?.table === 'memoryCorrections').map(e => e.value as MemoryCorrection);
  const rules = [...incoming, ...local];
  if (!rules.length) return [];
  if (rules.some(rule => rule.status !== 'completed')) throw new Error('Finish memory maintenance before restoring this backup.');
  const bodies = input?.data && typeof input.data === 'object' ? [input, input.data] : [input];
  const cleared = new Set(rules.flatMap(rule => rule.messageIds));
  const latest = [...rules].sort((a, b) => b.createdAt - a.createdAt)[0];
  const result: UnverifiedBackupAsset[] = [];
  for (const body of bodies) for (const asset of ASSETS) {
    const value = body?.[asset.field];
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    if (JSON.stringify(value) === JSON.stringify(asset.empty)) continue;
    const meta = entries.find(e => e.key === `kumiko_memory_asset_v1:${asset.key}`)?.value as any;
    const revision = body?.memoryAssetRevisions?.[asset.key];
    const matching = meta && meta.artifactId === asset.key && typeof meta.sourceRevision === 'string'
      && revision === meta.sourceRevision && Array.isArray(meta.sourceRefs) && typeof meta.memoryGeneration === 'string';
    const safeRefs = matching && meta.sourceRefs.every((ref: any) => {
      if (cleared.has(ref.id) || rules.some(rule => rule.artifactIds.includes(`${ref.kind}:${ref.id}`))) return false;
      const rows = ref.kind === 'message' ? body.messages : ref.kind === 'diary' ? body.kumikoDiary : ref.kind === 'fragment' ? body.dailyFragments : undefined;
      const row = Array.isArray(rows) ? rows.find((item: any) => item.id === ref.id) : undefined;
      const version = ref.kind === 'message' ? row?.contentRevision ?? row?.sourceRevision ?? 'legacy' : row?.sourceRevision ?? 'legacy';
      return !!row && version === ref.version;
    });
    const afterLatest = matching && meta.memoryGeneration === latest.generation;
    if (!matching || !safeRefs || (!afterLatest && meta.sourceRefs.length === 0)) {
      if (!result.some(item => item.field === asset.field)) result.push({ field: asset.field, reason: '该内容缺少可核对的来源或版本，可能包含已清理的信息。' });
    }
  }
  for (const body of bodies) {
    if (unverifiedAnchorIds(entries, body, rules).size && !result.some(item => item.field === 'anchors')) result.push({ field: 'anchors',
      reason: '部分锚点缺少可核对来源；确认后只移除无法核对的锚点。' });
    if ((await backupReminderLinks(entries, body, rules)).unknown.size && !result.some(item => item.field === 'reminderSourceText')) result.push({ field: 'reminderSourceText',
      reason: '部分提醒的来源文字无法追溯；确认后仅移除这些来源文字，保留无法证明相关的提醒。' });
    const block = body?.blockRuntime ?? body?.kumikoBlockRuntime;
    if (block?.reason && !cleared.has(block.triggerMessageId) && (!block.triggerMessageId || !Array.isArray(body.messages)
      || !body.messages.some((message: any) => message.id === block.triggerMessageId)) && !result.some(item => item.field === 'blockReason')) result.push({ field: 'blockReason',
      reason: '拉黑原因缺少可追溯来源；确认后只移除原因文字，保留拉黑状态。' });
  }
  return result;
}

/** Pure payload filtering precedes filesystem/media staging and any restore
 * write. A newer local erasure rule can never be overwritten by an old export. */
export async function applyMemoryCorrectionsToBackup(input: any, options: { allowUnverifiedAssetRemoval?: boolean } = {}): Promise<any> {
  assertMemoryAvailable();
  const unverified = await inspectBackupMemoryAssets(input);
  if (unverified.length && !options.allowUnverifiedAssetRemoval) throw new Error(`Backup memory assets require confirmation: ${unverified.map(item => item.field).join(', ')}`);
  const state = await validateExecutionStateIntegrity(getBackupExecutionState(input));
  const entries = executionStateEntries(state);
  const local = await db.memoryCorrections.toArray();
  const incoming = entries.filter(e => parseRuntimeEntryKey(e.key)?.table === 'memoryCorrections').map(e => e.value as MemoryCorrection);
  if ([...local, ...incoming].some(rule => rule.status !== 'completed')) throw new Error('Finish memory maintenance before restoring this backup.');
  const rules = new Map<string, MemoryCorrection>();
  for (const rule of [...incoming, ...local]) { const old = rules.get(rule.id); if (!old || rule.updatedAt >= old.updatedAt) rules.set(rule.id, rule); }
  if (!rules.size) return input;
  const inputBodies = input?.data && typeof input.data === 'object' ? [input, input.data] : [input];
  const reminderAnalyses = await Promise.all(inputBodies.map(body => backupReminderLinks(entries, body, [...rules.values()])));
  const reminderAnalysis = { affected: new Set(reminderAnalyses.flatMap(value => [...value.affected])),
    unknown: new Set(reminderAnalyses.flatMap(value => [...value.unknown])) };
  const unknownAnchors = new Set(inputBodies.flatMap(body => [...unverifiedAnchorIds(entries, body, [...rules.values()])]));
  const copy = structuredClone(input);
  const containers = copy.data && typeof copy.data === 'object' ? [copy, copy.data] : [copy];
  const cleared = new Set<string>();
  const mediaRemoval: MediaRemoval = { images: new Set(), voices: new Set() };
  for (const rule of rules.values()) {
    const ids = new Set(rule.messageIds); rule.messageIds.forEach(id => cleared.add(id));
    // An export carrying this rule was made after the correction. Its newer
    // unversioned memory fields must not be blanked just because they exist.
    const legacy = rule.includeLegacyDerived && !incoming.some(r => r.id === rule.id);
    for (const id of rule.imageIds ?? []) mediaRemoval.images.add(id);
    for (const id of rule.voiceIds ?? []) mediaRemoval.voices.add(id);
    for (const body of containers) {
      if (Array.isArray(body.messages)) {
        const remove = (row: any) => ids.has(row.id)
          || (legacy && row.role === 'model' && !row.sourceRefs?.length && row.timestamp <= (rule.legacyCutoff ?? rule.createdAt));
        for (const row of body.messages.filter(remove)) {
          if (row.imageId) mediaRemoval.images.add(row.imageId);
          if (row.voiceFileId) mediaRemoval.voices.add(row.voiceFileId);
          if (row.id) mediaRemoval.voices.add(row.id);
        }
        body.messages = body.messages.filter((row: any) => !remove(row))
          .map((row: any) => row.quote && ids.has(row.quote.id) ? { ...row, quote: undefined } : row);
      }
      for (const table of ['vectors','episodes','kumikoDiary','dailyFragments']) if (Array.isArray(body[table]))
        body[table] = body[table].filter((row: any) => !ruleMatchesRow(row, table, { ...rule, includeLegacyDerived: legacy }));
      if (hasSource(body.userKnownLocation, ids)) body.userKnownLocation = null;
      for (const field of ['relativeReminders','dailyReminders']) if (Array.isArray(body[field])) body[field] = body[field]
        .filter((row: any) => !hasSource(row, ids) && !reminderAnalysis.affected.has(row.id))
        .map((row: any) => {
          if (!unverified.some(item => item.field === 'reminderSourceText') || !reminderAnalysis.unknown.has(row.id)) return row;
          const { sourceText: _sourceText, ...retained } = row; return retained;
        });
      for (const field of ['blockRuntime', 'kumikoBlockRuntime']) if (body[field]) {
        const block = { ...body[field], capturedUnreadIds: Array.isArray(body[field].capturedUnreadIds)
          ? body[field].capturedUnreadIds.filter((id: string) => !ids.has(id)) : [] };
        if (ids.has(block.triggerMessageId) || unverified.some(item => item.field === 'blockReason')) { block.reason = ''; delete block.triggerMessageId; }
        body[field] = block;
      }
      if (Array.isArray(body.anchors)) body.anchors = body.anchors.filter((anchor: any) =>
        !rule.anchorIds?.includes(anchor?.id) && !rule.unknownAnchorIds?.includes(anchor?.id) && !rule.artifactIds.includes(`anchor:${anchor?.id}`)
        && !(unverified.some(item => item.field === 'anchors') && unknownAnchors.has(anchor?.id)));
      for (const asset of ASSETS) if (unverified.some(item => item.field === asset.field)) body[asset.field] = asset.empty;
    }
  }
  const legacy = [...rules.values()].some(rule => rule.includeLegacyDerived && !incoming.some(r => r.id === rule.id));
  const unverifiedKeys = new Set<string>(ASSETS.filter(asset => unverified.some(item => item.field === asset.field)).map(asset => asset.key));
  const kept: Array<{ key: string; value: any }> = [];
  const removedArchives = new Set<string>();
  const expandedTurns = new Map<string, any>();
  for (const entry of entries) if (entry.key.startsWith(TURN_ARCHIVE_PREFIX)) {
    const original = await readExecutionArchive(entry.value);
    if (legacy || hasSource(original, cleared)) { removedArchives.add(entry.key); expandedTurns.set('kumiko_turn_v1:' + original.id, original); }
  }
  for (const entry of entries) {
    if (removedArchives.has(entry.key)) continue;
    if (entry.key.startsWith(VOICE_WRITE_PREFIX)) {
      if (!isVoiceWriteRecord(entry.key, entry.value)) throw new Error('Invalid voice write backup record.');
      if (mediaRemoval.voices.has(entry.value.id) || entry.value.sourceIds.some(id => cleared.has(id))) {
        mediaRemoval.voices.add(entry.value.id); continue;
      }
    }
    if (entry.key.startsWith('kumiko_memory_asset_v1:') && (unverifiedKeys.has(entry.key.slice('kumiko_memory_asset_v1:'.length)) || hasSource(entry.value, cleared))) continue;
    const info = parseRuntimeEntryKey(entry.key);
    if (info?.table === 'memoryCorrections' || entry.key === MEMORY_GENERATION_KEY || entry.key === MEMORY_MAINTENANCE_KEY) continue;
    if (info?.table === 'messageViews' && cleared.has(info.id)) continue;
    if (info?.table === 'memoryDependencies' && (cleared.has((entry.value as any).sourceId) || cleared.has((entry.value as any).artifactId))) continue;
    if (info?.table === 'runtimeJobs' && (legacy || hasSource(entry.value, cleared))) {
      const { payload: _payload, checkpoint: _checkpoint, error: _error, owner: _owner, token: _token, leaseUntil: _lease, ...identity } = entry.value as any;
      kept.push({ key: entry.key, value: { ...identity, status: 'superseded' } }); continue;
    }
    if (info?.table === 'stateCommits' && (legacy || hasSource(entry.value, cleared))) {
      kept.push({ key: entry.key, value: { ...entry.value as any, result: { redacted: true } } }); continue;
    }
    if (PRIVATE_DERIVED_PREFIXES.some(prefix => entry.key.startsWith(prefix)) && (legacy || hasSource(entry.value, cleared))) continue;
    const value = scrubExecutionEntry(entry.key, expandedTurns.get(entry.key) || entry.value, cleared, legacy);
    if (value !== undefined) kept.push({ key: entry.key, value });
  }
  for (const rule of rules.values()) {
    const { managedBackups: _backups, syncPath: _syncPath, ...portable } = rule;
    // Optional IndexedDB fields can be undefined; backup rows must be JSON.
    kept.push({ key: runtimeEntryKey('memoryCorrections', rule.id), value: JSON.parse(JSON.stringify(portable)) });
  }
  kept.push({ key: MEMORY_GENERATION_KEY, value: getMemoryGeneration() });
  kept.push({ key: MEMORY_MAINTENANCE_KEY, value: '' });
  const cleaned = await packExecutionState(kept);
  copy.executionState = cleaned;
  if (copy.data) copy.data.executionState = cleaned;
  Object.defineProperty(copy, FILTERED_MEDIA, { value: mediaRemoval });
  return copy;
}

/** Orphaned media in an old export cannot be proved clean from message text.
 * Return exact IDs for a separate, explicit import confirmation. */
export async function inspectUnreferencedBackupMedia(backup: any, images: Array<{id: string}>, media: any): Promise<{ images: string[]; voices: string[] }> {
  assertMemoryAvailable();
  const entries = executionStateEntries(getBackupExecutionState(backup));
  const rules = [...await db.memoryCorrections.toArray(), ...entries.filter(entry => parseRuntimeEntryKey(entry.key)?.table === 'memoryCorrections').map(entry => entry.value as MemoryCorrection)];
  if (!rules.length) return { images: [], voices: [] };
  if (rules.some(rule => rule.status !== 'completed')) throw new Error('Finish memory maintenance before restoring this backup.');
  const messages: any[] = (backup.data ?? backup).messages || [];
  const messageIds = new Set(messages.map(row => row.id));
  const imageIds = new Set(messages.map(row => row.imageId).filter(Boolean));
  const voiceIds = new Set(messages.flatMap(row => [row.voiceFileId, row.id]).filter(Boolean));
  const cleared = new Set(rules.flatMap(rule => rule.messageIds));
  for (const entry of entries) if (isVoiceWriteRecord(entry.key, entry.value) && entry.value.sourceIds.length
    && entry.value.sourceIds.every(id => messageIds.has(id) && !cleared.has(id))) voiceIds.add(entry.value.id);
  return { images: images.filter(row => !imageIds.has(row.id)).map(row => row.id),
    voices: (media.voices || []).filter((row: any) => !voiceIds.has(row.id)).map((row: any) => row.id) };
}

export function filterCorrectedBackupMedia(backup: any, images: Array<{id: string; dataUrl: string}>, media: any,
  confirmedOrphans: { images: string[]; voices: string[] } = { images: [], voices: [] }) {
  const removed = backup[FILTERED_MEDIA] as MediaRemoval | undefined;
  if (!removed && !confirmedOrphans.images.length && !confirmedOrphans.voices.length) return { images, media };
  const body = backup.data ?? backup;
  const messages: any[] = body.messages || [];
  const imageIds = new Set(messages.map(row => row.imageId).filter(Boolean));
  const voiceIds = new Set(messages.flatMap(row => [row.voiceFileId, row.id]).filter(Boolean));
  return { images: images.filter(row => !confirmedOrphans.images.includes(row.id) && (!removed?.images.has(row.id) || imageIds.has(row.id))),
    media: { ...media, voices: media.voices?.filter((row: any) => !confirmedOrphans.voices.includes(row.id)
      && (!removed?.voices.has(row.id) || voiceIds.has(row.id))) } };
}
