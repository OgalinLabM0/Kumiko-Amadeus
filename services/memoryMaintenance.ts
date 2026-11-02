import { db, INITIAL_WORLD_CHARACTER_STATUS } from './db';
import type { MemoryCorrection } from './runtimeEntities';
import { assertDataWritesAllowed } from './dataRestoreGate';
import { assertMemoryAvailable, getMemoryGeneration, MEMORY_GENERATION_KEY, MEMORY_MAINTENANCE_KEY,
  publishMemoryMaintenance, ownMemoryMaintenance, permitMemoryMaintenanceTransaction, synchronizeMemoryMaintenanceGate } from './memoryMaintenanceGate';
import { dependentArtifacts, hasSource, isOfficialVector, PRIVATE_DERIVED_KEYS, PRIVATE_DERIVED_PREFIXES,
  ruleMatchesRow, scrubExecutionEntry } from './memoryCorrectionPolicy';
import { withMediaResetFence } from './mediaWriteFence';
import { queueReminderNativeCancellation, withReminderNativeAlarmLock, REMINDER_NATIVE_CANCEL_KEY } from './reminderNativeCancellation';
import { isCapacitorNative, getCapacitorPlatform } from './environment';
import { cancelAndroidAlarm } from './androidAlarmService';
import { cancelReminderNotification } from './capacitorNotifications';
import { readExecutionArchive, TURN_ARCHIVE_PREFIX } from './executionArchive';
import { mapEntityToMessage } from '../components/app/messageMappers';

const desktop = () => typeof window !== 'undefined' ? window.electronAPI : undefined;
const dataTables = ['messages','images','kumikoDiary','dailyFragments','episodes','vectors','keyval','memoryDependencies','runtimeJobs','stateCommits'] as const;
const VOICE_LEDGER_PREFIX = 'kumiko_voice_write_v1:';
function relatedLedgerVoices(data: Data, ids: Set<string>, artifactIds: string[]): string[] {
  const sources = new Set([...ids, ...artifactIds.map(value => value.slice(value.indexOf(':') + 1))]);
  return data.keyval.filter(row => row.key.startsWith(VOICE_LEDGER_PREFIX) && Array.isArray(row.value?.sourceIds)
    && row.value.sourceIds.some((id: string) => sources.has(id)) && typeof row.value.id === 'string')
    .map(row => row.value.id);
}
type Data = Record<typeof dataTables[number], any[]>;
const hasKnownImageSources = (row: any): boolean => Array.isArray(row.sourceIds) && row.sourceIds.length > 0
  && row.sourceIds.every((id: unknown) => typeof id === 'string' && id.length > 0);
export interface MemoryMaintenancePreview {
  messageIds: string[]; revision: string; generation: string; createdAt: number;
  affectedMessages: Array<{ id: string; role: string; text: string }>;
  artifacts: Record<string, number>; legacyDerivedCount: number;
  managedBackups: Array<{ path: string; size: number; digest: string }>;
  nativeRevision?: string;
  syncPath?: string;
  contextDerived: Array<{ kind: string; id: string; text?: string }>;
  sharedVoicesRetained: Array<{ id: string; messageIds: string[] }>;
  unknownUnreferencedImages: string[];
  unknownUnreferencedVoices: string[];
  mediaRevision: string;
}
async function digest(value: unknown): Promise<string> {
  const data = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(data), x => x.toString(16).padStart(2, '0')).join('');
}
async function snapshot(): Promise<Data> {
  return db.transaction('r', dataTables.map(name => db.table(name)), async () => {
    const result: any = {};
    for (const name of dataTables) result[name] = await db.table(name).toArray();
    return result;
  });
}
async function nativeInventory(restoreSessionId?: string): Promise<any[]> {
  if (!desktop()) return [];
  const result = await invoke('rag:get-all', restoreSessionId ? { restoreSessionId } : undefined);
  if (!Array.isArray(result.vectors)) throw new Error('Native vector inventory is unavailable.');
  return result.vectors.sort((a: any, b: any) => a.id.localeCompare(b.id));
}
type MediaInventory = { imageIds: string[]; voiceIds: string[] };
async function mediaInventory(syncPath?: string): Promise<MediaInventory> {
  if (desktop()) {
    const result = await invoke('memory:managed-backups', { syncPath });
    if (!Array.isArray(result.imageIds) || !Array.isArray(result.voiceIds)) throw new Error('Private media inventory is unavailable.');
    const valid = (id: unknown) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
    if (!result.imageIds.every(valid) || !result.voiceIds.every(valid)) throw new Error('Private media inventory is invalid.');
    return { imageIds: [...new Set<string>(result.imageIds)].sort(), voiceIds: [...new Set<string>(result.voiceIds)].sort() };
  }
  if (!isCapacitorNative()) return { imageIds: [], voiceIds: [] };
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const read = async (dir: string, pattern: RegExp): Promise<string[]> => {
    let listing;
    try { listing = await Filesystem.readdir({ path: dir, directory: Directory.Data }); }
    catch (error) { if (/not found|does not exist|ENOENT|OS-PLUG-FILE-0008/i.test(String(error))) return []; throw error; }
    return [...new Set<string>(listing.files.flatMap(file => { const match = pattern.exec(file.name); return match ? [match[1]] : []; }))].sort();
  };
  return { imageIds: await read('images', /^([A-Za-z0-9_-]{1,80})\.(?:jpg|jpeg|png|webp|gif)$/i), voiceIds: await read('voices', /^([A-Za-z0-9_-]{1,80})\.mp3$/i) };
}
function unreferencedMedia(data: Data, media: MediaInventory): { images: string[]; voices: string[] } {
  const referenced = new Set<string>();
  const collect = (value: any, seen = new Set<object>()) => {
    if (typeof value === 'string') { referenced.add(value); return; }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value); for (const child of Object.values(value)) collect(child, seen);
  };
  for (const row of [...data.messages, ...data.runtimeJobs, ...data.keyval]) collect(row);
  const knownImages = new Set(data.images.filter(hasKnownImageSources).map(row => row.id));
  const imageIds = new Set([...data.images.filter(row => !hasKnownImageSources(row)).map(row => row.id), ...media.imageIds.filter(id => !data.images.some(row => row.id === id))]);
  const ledgerIds = new Set(data.keyval.filter(row => row.key.startsWith(VOICE_LEDGER_PREFIX)).map(row => row.key.slice(VOICE_LEDGER_PREFIX.length)));
  return { images: [...imageIds].filter(id => !referenced.has(id) && !knownImages.has(id)).sort(),
    voices: media.voiceIds.filter(id => !ledgerIds.has(id) && !referenced.has(id)).sort() };
}
function knownSources(row: any): boolean { return Array.isArray(row.sourceRefs) && row.sourceRefs.length > 0; }
function blockAnalysis(data: Data, ids: Set<string>) {
  const block = data.keyval.find(row => row.key === 'kumiko_block_runtime')?.value;
  const hasReason = typeof block?.reason === 'string' && !!block.reason;
  const trigger = typeof block?.triggerMessageId === 'string' ? block.triggerMessageId : undefined;
  return { affected: hasReason && !!trigger && ids.has(trigger),
    unknown: hasReason && (!trigger || !data.messages.some(row => row.id === trigger)),
    unread: Array.isArray(block?.capturedUnreadIds) ? block.capturedUnreadIds.filter((id: string) => ids.has(id)).length : 0 };
}
function anchorAnalysis(data: Data, ids: Set<string>, dependency: Set<string>) {
  const anchors = data.keyval.find(row => row.key === 'kumiko_anchors')?.value;
  const affected: string[] = [], unknown: string[] = [];
  if (!Array.isArray(anchors)) return { affected, unknown };
  for (const anchor of anchors) {
    if (!anchor || typeof anchor.id !== 'string') continue;
    const edges = data.memoryDependencies.filter(edge => edge.artifactKind === 'anchor' && edge.artifactId === anchor.id);
    if (dependency.has(`anchor:${anchor.id}`) || hasSource(anchor, ids) || edges.some(edge => ids.has(edge.sourceId))) { affected.push(anchor.id); continue; }
    const valid = edges.length > 0 && edges.every(edge => {
      const table = edge.sourceKind === 'message' ? data.messages : edge.sourceKind === 'diary' ? data.kumikoDiary : edge.sourceKind === 'fragment' ? data.dailyFragments : [];
      const row = table.find(item => item.id === edge.sourceId);
      const version = edge.sourceKind === 'message' ? row?.contentRevision ?? row?.sourceRevision ?? 'legacy' : row?.sourceRevision ?? 'legacy';
      return !!row && version === edge.sourceVersion;
    });
    if (!valid) unknown.push(anchor.id);
  }
  return { affected, unknown };
}
/** Context edges identify suspects, not facts. Every reachable derived item
 * remains a separately displayed suspect and needs explicit confirmation. */
function contextCandidates(data: Data, requested: string[]): Array<{ kind: string; id: string; text?: string }> {
  const basis = dependentArtifacts(requested, data.memoryDependencies);
  const candidates = new Map<string, { kind: string; id: string; text?: string }>();
  const isCandidate = (kind: string, id: string) => candidates.has(`${kind}:${id}`)
    || (kind === 'summary' && candidates.has(`keyval:kumiko_summary_artifact_v1:${id}`));
  const add = (kind: string, id: string) => {
    if (kind === 'summary') return add('keyval', `kumiko_summary_artifact_v1:${id}`);
    const key = `${kind}:${id}`;
    if (basis.has(key) || candidates.has(key)) return false;
    const table = kind === 'message' ? data.messages : kind === 'diary' ? data.kumikoDiary : kind === 'fragment' ? data.dailyFragments
      : kind === 'vector' ? data.vectors : kind === 'episode' ? data.episodes : undefined;
    const row = table?.find(item => item.id === id);
    if (kind === 'message' && (!row || row.role !== 'model')) return false;
    if (kind === 'vector' && (!row || isOfficialVector(row))) return false;
    if (table && !row) return false;
    if (!table && !['anchor','keyval','stateCommit'].includes(kind)) return false;
    if (kind === 'keyval' && (id === 'kumiko_chat_history' || (!PRIVATE_DERIVED_KEYS.has(id) && !id.startsWith('kumiko_summary_artifact_v1:'))
      || !data.keyval.some(item => item.key === id))) return false;
    if (kind === 'stateCommit' && !data.stateCommits.some(item => item.id === id)) return false;
    if (kind === 'anchor' && !data.keyval.some(item => item.key === 'kumiko_anchors' && Array.isArray(item.value) && item.value.some((anchor: any) => anchor?.id === id))) return false;
    const keyValue = kind === 'keyval' ? data.keyval.find(item => item.key === id)?.value : undefined;
    const content = typeof row?.text === 'string' ? row.text : typeof row?.content === 'string' ? row.content
      : typeof keyValue === 'string' ? keyValue : undefined;
    candidates.set(key, { kind, id, ...(content ? { text: content.slice(0, 160) } : {}) }); return true;
  };
  for (const edge of data.memoryDependencies) if (edge.relation === 'context' && basis.has(`${edge.sourceKind}:${edge.sourceId}`)) add(edge.artifactKind, edge.artifactId);
  for (const row of data.keyval) {
    const meta = row.key.startsWith('kumiko_memory_asset_v1:') ? row.value : row.key.startsWith('kumiko_summary_artifact_v1:') ? row.value : null;
    if (meta?.sourceRefs?.some((ref: any) => ref?.relation === 'context' && basis.has(`${ref.kind}:${ref.id}`))) {
      add('keyval', row.key.startsWith('kumiko_memory_asset_v1:') ? meta.artifactId : row.key);
    }
  }
  // A generated voice carries the provenance of the text used to make it.
  // Any model message that references that voice is a suspect even if its
  // older message record did not itself retain a dependency edge.
  const addVoiceOwners = () => {
    let added = false;
    for (const entry of data.keyval) {
      const voice = entry.value;
      if (!entry.key.startsWith(VOICE_LEDGER_PREFIX) || !Array.isArray(voice?.sourceIds) || typeof voice.id !== 'string') continue;
      const linked = voice.sourceIds.some((id: string) => [...basis].some(key => key.endsWith(`:${id}`))
        || [...candidates.values()].some(candidate => candidate.id === id));
      if (!linked) continue;
      for (const message of data.messages) if (message.voiceFileId === voice.id && message.role === 'model')
        added = add('message', message.id) || added;
    }
    return added;
  };
  addVoiceOwners();
  let changed = true;
  while (changed) {
    changed = addVoiceOwners();
    for (const edge of data.memoryDependencies) if (isCandidate(edge.sourceKind, edge.sourceId)) changed = add(edge.artifactKind, edge.artifactId) || changed;
    for (const row of data.keyval) {
      const meta = row.key.startsWith('kumiko_memory_asset_v1:') ? row.value : row.key.startsWith('kumiko_summary_artifact_v1:') ? row.value : null;
      if (meta?.sourceRefs?.some((ref: any) => isCandidate(ref.kind, ref.id))) {
        changed = add('keyval', row.key.startsWith('kumiko_memory_asset_v1:') ? meta.artifactId : row.key) || changed;
      }
    }
  }
  return [...candidates.values()];
}
type PrivateClassification = { retained: string[]; affected: string[]; unknown: string[]; protectedArtifacts: string[]; affectedArtifacts: string[]; unknownArtifacts: string[]; affectedStates: string[]; unknownStates: string[] };
function classifyPrivateAssets(data: Data, ids: Set<string>, dependency: Set<string>): PrivateClassification {
  const retained: string[] = [], affected: string[] = [], unknown: string[] = [], protectedArtifacts: string[] = [], affectedArtifacts: string[] = [], unknownArtifacts: string[] = [], affectedStates: string[] = [], unknownStates: string[] = [];
  const rows = new Map(data.keyval.map(row => [row.key, row]));
  const generation = rows.get(MEMORY_GENERATION_KEY)?.value || 'initial';
  const isEmpty = (value: any) => value == null || value === '' || (Array.isArray(value) && value.length === 0);
  const refsStatus = (refs: any): 'retain' | 'affected' | 'unknown' => {
    if (!Array.isArray(refs) || !refs.length) return 'unknown';
    for (const ref of refs) {
      if (!ref || typeof ref.id !== 'string' || typeof ref.version !== 'string') return 'unknown';
      if (ids.has(ref.id) || dependency.has(`${ref.kind}:${ref.id}`)) return 'affected';
      const table = ref.kind === 'message' ? data.messages : ref.kind === 'diary' ? data.kumikoDiary : ref.kind === 'fragment' ? data.dailyFragments : [];
      const row = table.find(item => item.id === ref.id);
      if (ref.kind === 'message' && row?.quote && ids.has(row.quote.id)) return 'affected';
      const version = ref.kind === 'message' ? row?.contentRevision ?? row?.sourceRevision ?? 'legacy' : row?.sourceRevision ?? 'legacy';
      if (!row || version !== ref.version) return 'unknown';
    }
    return 'retain';
  };
  for (const row of data.keyval) {
    if (row.key === 'kumiko_chat_history' || row.key === 'kumiko_anchors' || row.key.startsWith('kumiko_memory_asset_v1:') || isEmpty(row.value)) continue;
    const privateKey = PRIVATE_DERIVED_KEYS.has(row.key) || PRIVATE_DERIVED_PREFIXES.some(prefix => row.key.startsWith(prefix)) || row.key === 'world_character_status';
    if (!privateKey) continue;
    if (row.key === 'world_character_status' && JSON.stringify(row.value) === JSON.stringify(INITIAL_WORLD_CHARACTER_STATUS)) continue;
    let status: 'retain' | 'affected' | 'unknown' = hasSource(row.value, ids) || dependency.has(`keyval:${row.key}`) ? 'affected' : 'unknown';
    if (row.key.startsWith('kumiko_summary_artifact_v1:')) {
      const registry = row.value;
      const validRegistry = registry?.state === 'active' && registry?.memoryGeneration === generation && /^ka-[a-f0-9]{64}$/.test(registry?.id ?? '')
        && Number.isSafeInteger(registry?.chunkCount) && registry.chunkCount > 0 && registry.chunkCount <= 100;
      if (status !== 'affected') status = validRegistry ? refsStatus(registry.sourceRefs) : 'unknown';
      if (validRegistry && (status === 'retain' || status === 'affected')) for (const vector of data.vectors) {
        for (let index = 0; index < registry.chunkCount; index++) {
          if (vector.id === `${registry.id}:${index}` && vector.canonicalKey === `ka-artifact:${registry.id}:${index}`) {
            (status === 'retain' ? protectedArtifacts : affectedArtifacts).push(`vectors:${vector.id}`);
          }
        }
      }
    } else if (status !== 'affected') {
      const meta = rows.get(`kumiko_memory_asset_v1:${row.key}`)?.value;
      if (meta?.artifactId === row.key && meta.sourceRevision === row.sourceRevision && meta.memoryGeneration === generation) status = refsStatus(meta.sourceRefs);
    }
    (status === 'retain' ? retained : status === 'affected' ? affected : unknown).push(row.key);
  }
  const groups = new Map<string, any[]>();
  for (const edge of data.memoryDependencies) {
    const key = `${edge.artifactKind}:${edge.artifactId}`;
    groups.set(key, [...(groups.get(key) ?? []), edge]);
  }
  for (const [key, edges] of groups) {
    if (dependency.has(key) || !['diary','fragment','vector','episode'].some(kind => key.startsWith(kind + ':'))) continue;
    if (refsStatus(edges.map(edge => ({ kind: edge.sourceKind, id: edge.sourceId, version: edge.sourceVersion }))) === 'retain') protectedArtifacts.push(key);
  }
  for (const [table, kind] of [['kumikoDiary','diary'], ['dailyFragments','fragment'], ['episodes','episode'], ['vectors','vector']] as const) {
    for (const row of data[table]) {
      if (!knownSources(row) || (table === 'vectors' && isOfficialVector(row))) continue;
      const key = `${kind}:${row.id}`;
      const status = refsStatus(row.sourceRefs);
      if (status === 'retain') protectedArtifacts.push(key);
      else if (status === 'affected') affectedArtifacts.push(key);
      else unknownArtifacts.push(key);
    }
  }
  for (const row of data.stateCommits) {
    if (row.result == null || row.result?.redacted === true) continue;
    const contextAffected = data.memoryDependencies.some(edge => edge.artifactKind === 'stateCommit' && edge.artifactId === row.id && ids.has(edge.sourceId));
    const status = hasSource(row, ids) || contextAffected || dependency.has(`stateCommit:${row.id}`) ? 'affected' : refsStatus(row.sourceRefs);
    if (status === 'affected') affectedStates.push(row.id);
    else if (status === 'unknown') unknownStates.push(row.id);
  }
  return { retained, affected, unknown, protectedArtifacts: [...new Set(protectedArtifacts)],
    affectedArtifacts: [...new Set(affectedArtifacts)], unknownArtifacts: [...new Set(unknownArtifacts)], affectedStates, unknownStates };
}
async function reminderLinks(data: Data, ids: Set<string>): Promise<{ affected: string[]; unknownSourceText: string[] }> {
  const affected = new Set<string>(), known = new Set<string>(), matchingTurns = new Set<string>();
  const turns: any[] = [];
  for (const row of data.keyval) {
    if (row.key.startsWith('kumiko_turn_v1:')) turns.push(row.value);
    else if (row.key.startsWith(TURN_ARCHIVE_PREFIX)) turns.push(await readExecutionArchive(row.value));
  }
  for (const turn of turns) {
    const matched = hasSource(turn, ids);
    if (matched && typeof turn?.id === 'string') matchingTurns.add(turn.id);
    for (const receipt of turn?.receipts ?? []) if (typeof receipt.reminderId === 'string') {
      known.add(receipt.reminderId); if (matched) affected.add(receipt.reminderId);
    }
  }
  for (const row of data.keyval) if (row.key.startsWith('kumiko_reminder_action:') && typeof row.value?.reminderId === 'string') {
    known.add(row.value.reminderId);
    const actionId = row.key.slice('kumiko_reminder_action:'.length);
    if ([...matchingTurns].some(id => actionId.startsWith(id + ':reminder:'))) affected.add(row.value.reminderId);
  }
  const reminders = data.keyval.filter(row => ['kumiko_relative_reminders', 'kumiko_daily_reminders'].includes(row.key))
    .flatMap(row => Array.isArray(row.value) ? row.value : []);
  for (const reminder of reminders) if (hasSource(reminder, ids) && typeof reminder.id === 'string') affected.add(reminder.id);
  return { affected: [...affected], unknownSourceText: reminders.filter(r => typeof r?.id === 'string' && typeof r.sourceText === 'string'
    && !!r.sourceText && !known.has(r.id) && !affected.has(r.id)).map(r => r.id) };
}
type JobDisposition = 'affected' | 'retain' | 'unknown';
async function classifyJobs(data: Data, ids: Set<string>, artifacts: string[]): Promise<Map<string, JobDisposition>> {
  const result = new Map<string, JobDisposition>();
  const removedArtifacts = new Set(artifacts);
  const privateAssets = classifyPrivateAssets(data, ids, removedArtifacts);
  const removedId = (id: string) => ['message','diary','kumikoDiary','fragment','dailyFragments','episode','episodes','vector','vectors','anchor','stateCommit']
    .some(kind => removedArtifacts.has(`${kind}:${id}`));
  for (const job of data.runtimeJobs) {
    if (ids.has(job.sourceId) || hasSource(job, ids) || removedId(job.sourceId)) {
      result.set(job.id, 'affected'); continue;
    }
    if ((job.kind === 'execution-archive' || ['completed','superseded'].includes(job.status)) && !job.payload && !job.checkpoint && !job.error) { result.set(job.id, 'retain'); continue; }
    if (job.kind === 'diary-index') {
      const diary = data.kumikoDiary.find(row => row.id === job.sourceId);
      const version = diary && await digest([diary.id, diary.date, diary.timestamp, diary.content]);
      result.set(job.id, diary && version === job.sourceVersion && !removedArtifacts.has(`diary:${diary.id}`) && !removedArtifacts.has(`kumikoDiary:${diary.id}`) ? 'retain' : 'affected');
      continue;
    }
    if (job.kind === 'disclosed-location-resolution') {
      const known = data.keyval.find(row => row.key === 'user_known_location_v1')?.value;
      const version = known && JSON.stringify([known.sourceMessage?.id, known.revision || 0, known.updatedAt, known.clarification?.sourceMessage?.id || null]);
      result.set(job.id, known && version === job.sourceVersion && !hasSource(known, ids) ? 'retain' : 'affected');
      continue;
    }
    if (job.kind === 'diary-generate' && Array.isArray(job.payload?.messages) && Array.isArray(job.payload?.fragments)
      && Array.isArray(job.payload?.recentDiaries)) {
      // The worker snapshots the entire day and all diary rows. A removed
      // member or reset world state makes that exact snapshot unusable.
      const snapshotRows = [...job.payload.messages, ...job.payload.fragments, ...job.payload.recentDiaries];
      const valid = snapshotRows.every((row: any) => {
        const current = [...data.messages, ...data.dailyFragments, ...data.kumikoDiary].find(item => item.id === row.id);
        return current && JSON.stringify(current) === JSON.stringify(row)
          && !ids.has(row.id) && !removedId(row.id);
      });
      const versionMatches = await digest(job.payload) === job.sourceVersion;
      const world = data.keyval.find(row => row.key === 'world_character_status');
      const worldUnchanged = JSON.stringify(world) === JSON.stringify(job.payload.worldStatusRow)
        && (!world || privateAssets.retained.includes('world_character_status') || JSON.stringify(world.value) === JSON.stringify(INITIAL_WORLD_CHARACTER_STATUS));
      result.set(job.id, valid && versionMatches && worldUnchanged ? 'retain' : 'affected');
      continue;
    }
    const refs = job.payload?.refs ?? job.payload?.sourceRefs ?? job.sourceRefs;
    if (Array.isArray(refs) && refs.length) {
      const current = refs.every((ref: any) => {
        const table = ref.kind === 'message' ? data.messages : ref.kind === 'diary' ? data.kumikoDiary : ref.kind === 'fragment' ? data.dailyFragments : [];
        const row = table.find(item => item.id === ref.id);
        const version = ref.kind === 'message' ? row?.contentRevision ?? row?.sourceRevision ?? 'legacy' : row?.sourceRevision ?? 'legacy';
        return !!row && !ids.has(ref.id) && !removedArtifacts.has(`${ref.kind}:${ref.id}`) && version === ref.version;
      });
      const contextKeys: Array<[string, string]> = [['memoryRow','kumiko_core_memory'], ['notebookRow','kumiko_notebook'], ['archiveRow','kumiko_summary_archive_state']];
      const resetContext = job.kind === 'summary-generate' && contextKeys.some(([field, key]) => {
        const saved = job.payload?.[field], current = data.keyval.find(row => row.key === key);
        return JSON.stringify(saved) !== JSON.stringify(current) || (!!saved?.value && !privateAssets.retained.includes(key));
      });
      const versionMatches = job.kind !== 'summary-generate' || await digest({ refs: job.payload.refs, archiveRow: job.payload.archiveRow,
        memoryRow: job.payload.memoryRow, notebookRow: job.payload.notebookRow }) === job.sourceVersion;
      result.set(job.id, current && !resetContext && versionMatches ? 'retain' : 'affected'); continue;
    }
    result.set(job.id, 'unknown');
  }
  return result;
}
function selection(data: Data, requested: string[], legacy: boolean, cutoff: number, context: Array<{ kind: string; id: string }> = []) {
  const dependency = dependentArtifacts(requested, data.memoryDependencies);
  for (const item of context) dependency.add(`${item.kind}:${item.id}`);
  const ids = new Set(requested);
  const legacyIds = data.messages.filter(row => row.role === 'model' && !knownSources(row)
    && !data.memoryDependencies.some(e => e.artifactId === row.id) && row.timestamp <= cutoff).map(row => row.id);
  if (legacy) legacyIds.forEach(id => ids.add(id));
  for (const row of data.messages) if (row.role === 'model' && dependency.has(`message:${row.id}`)) ids.add(row.id);
  const privateAssets = classifyPrivateAssets(data, ids, dependency);
  const anchors = anchorAnalysis(data, ids, dependency);
  const rule: MemoryCorrection = { id: 'preview', version: 1, status: 'prepared', generation: 'preview', createdAt: cutoff, updatedAt: cutoff,
    messageIds: [...ids], artifactIds: [...dependency, ...privateAssets.affectedArtifacts, ...(legacy ? privateAssets.unknownArtifacts : [])], sourceVersions: {}, includeLegacyDerived: legacy, legacyCutoff: cutoff, phase: 'preview',
    protectedArtifactIds: privateAssets.protectedArtifacts };
  const artifacts: Record<string, number> = {};
  artifacts.stateCommitsAffected = privateAssets.affectedStates.length;
  artifacts.stateCommitsUnknown = privateAssets.unknownStates.length;
  artifacts.privateKeysAffected = privateAssets.affected.length;
  artifacts.privateKeysUnknown = privateAssets.unknown.length;
  artifacts.privateKeysRetained = privateAssets.retained.length;
  artifacts.anchorsAffected = anchors.affected.length;
  artifacts.anchorsUnknown = anchors.unknown.length;
  const artifactIds: string[] = [...rule.artifactIds];
  for (const name of ['kumikoDiary','dailyFragments','episodes','vectors'] as const) {
    const matches = [...new Map(data[name].filter(row => ruleMatchesRow(row, name, rule)).map(row => [row.id, row])).values()];
    artifacts[name] = matches.length;
    artifactIds.push(...matches.map(row => `${name}:${row.id}`));
  }
  const aliases: Record<string, string> = { kumikoDiary: 'diary', dailyFragments: 'fragment', episodes: 'episode', vectors: 'vector' };
  const unknownArtifacts = ['kumikoDiary','dailyFragments','episodes','vectors'].reduce((sum, name) =>
    sum + new Set(data[name as keyof Data].filter(row => !knownSources(row) && !(name === 'vectors' && isOfficialVector(row))
      && !privateAssets.protectedArtifacts.includes(`${name}:${row.id}`) && !privateAssets.protectedArtifacts.includes(`${aliases[name]}:${row.id}`)
      && !privateAssets.affectedArtifacts.includes(`${name}:${row.id}`) && !privateAssets.affectedArtifacts.includes(`${aliases[name]}:${row.id}`)).map(row => row.id)).size, 0);
  return { ids, artifacts, artifactIds: [...new Set(artifactIds)], privateAssets, anchors,
    legacyCount: legacyIds.length + unknownArtifacts + privateAssets.unknown.length + privateAssets.unknownArtifacts.length + privateAssets.unknownStates.length + anchors.unknown.length };
}
function snapshotRevision(data: Data): Promise<string> {
  // Exclude queue lease/heartbeat bookkeeping, which never changes the source
  // scope. Include every authoritative content row and the captured job input.
  return digest({ ...data, runtimeJobs: data.runtimeJobs.map(j => ({ id: j.id, sourceId: j.sourceId, sourceVersion: j.sourceVersion, payload: j.payload })) });
}
async function invoke(channel: string, payload?: unknown): Promise<any> {
  const result = await desktop()!.invoke(channel, payload);
  if (!result?.success) throw new Error(result?.error || 'Memory storage operation failed.');
  return result;
}
export async function previewMemoryMaintenance(messageIds: string[]): Promise<MemoryMaintenancePreview> {
  assertDataWritesAllowed(); assertMemoryAvailable();
  const ids = [...new Set(messageIds)]; if (!ids.length) throw new Error('Choose the incorrect source messages first.');
  const generation = getMemoryGeneration(); const data = await snapshot(); const createdAt = Date.now();
  if (ids.some(id => !data.messages.some(row => row.id === id))) throw new Error('A selected message no longer exists.');
  const native = await nativeInventory();
  const contextDerived = contextCandidates({ ...data, vectors: [...data.vectors, ...native] }, ids);
  const range = selection({ ...data, vectors: [...data.vectors, ...native] }, ids, true, createdAt);
  const jobs = await classifyJobs(data, range.ids, range.artifactIds);
  const reminders = await reminderLinks(data, range.ids);
  const block = blockAnalysis(data, range.ids);
  range.artifacts.remindersAffected = reminders.affected.length;
  range.artifacts.remindersSourceTextUnknown = reminders.unknownSourceText.length;
  range.artifacts.blockReasonAffected = Number(block.affected);
  range.artifacts.blockReasonUnknown = Number(block.unknown);
  range.artifacts.blockUnreadRemoved = block.unread;
  range.artifacts.runtimeJobsAffected = [...jobs.values()].filter(value => value === 'affected').length;
  range.artifacts.runtimeJobsRetained = [...jobs.values()].filter(value => value === 'retain').length;
  range.artifacts.runtimeJobsUnknown = [...jobs.values()].filter(value => value === 'unknown').length;
  const withContext = selection({ ...data, vectors: [...data.vectors, ...native] }, ids, true, createdAt, contextDerived);
  const syncPath = typeof localStorage !== 'undefined' ? localStorage.getItem('kumiko_local_backup_path') || undefined : data.keyval.find(row => row.key === 'kumiko_local_backup_path')?.value;
  const media = await mediaInventory(syncPath);
  const unknownMedia = unreferencedMedia(data, media);
  const unknownUnreferencedImages = unknownMedia.images;
  const unknownUnreferencedVoices = unknownMedia.voices;
  range.artifacts.registeredImagesAffected = data.images.filter(row => Array.isArray(row.sourceIds)
    && row.sourceIds.some((id: string) => withContext.ids.has(id))).length;
  range.artifacts.unknownUnreferencedImages = unknownUnreferencedImages.length;
  range.artifacts.unknownUnreferencedVoices = unknownUnreferencedVoices.length;
  range.artifacts.registeredVoicesAffected = new Set(relatedLedgerVoices(data, withContext.ids, withContext.artifactIds)).size;
  const previewVoiceIds = [...relatedLedgerVoices(data, withContext.ids, withContext.artifactIds),
    ...data.messages.filter(row => withContext.ids.has(row.id)).flatMap(row => [row.voiceFileId, row.id]).filter(Boolean)];
  const sharedVoicesRetained = [...new Set(previewVoiceIds)].map(id => ({ id,
    messageIds: data.messages.filter(row => !withContext.ids.has(row.id) && (row.voiceFileId === id || row.id === id)).map(row => row.id) }))
    .filter(item => item.messageIds.length > 0);
  range.artifacts.sharedVoicesRetained = sharedVoicesRetained.length;
  const managedBackups = desktop() ? (await invoke('memory:managed-backups', { syncPath })).files : [];
  assertMemoryAvailable(generation);
  return { messageIds: ids, revision: await snapshotRevision(data), nativeRevision: await digest(native), generation, createdAt, artifacts: range.artifacts,
    affectedMessages: data.messages.filter(row => range.ids.has(row.id)).map(({ id, role, text }) => ({ id, role, text })),
    legacyDerivedCount: range.legacyCount + range.artifacts.runtimeJobsUnknown + reminders.unknownSourceText.length + Number(block.unknown), managedBackups, syncPath, contextDerived, sharedVoicesRetained, unknownUnreferencedImages, unknownUnreferencedVoices, mediaRevision: await digest(media) };
}
async function exclusive<T>(work: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request('kumiko-data-restore-v1', { mode: 'exclusive' }, work);
  if (typeof window !== 'undefined') throw new Error('Safe memory maintenance locking is unavailable.');
  return work();
}
async function updateRule(rule: MemoryCorrection, patch: Partial<MemoryCorrection>): Promise<MemoryCorrection> {
  const updated = { ...rule, ...patch, updatedAt: Date.now() };
  await db.transaction('rw', db.memoryCorrections, async tx => {
    permitMemoryMaintenanceTransaction(tx, rule.id); await db.memoryCorrections.put(updated);
  });
  return updated;
}
/** Explicit software operation only. The preview is not an authorization token
 * for a model tool; callers require the user's separate destructive confirmation. */
export async function runMemoryMaintenance(preview: MemoryMaintenancePreview, includeLegacyDerived: boolean, includeContextDerived = false, includeUnknownImages = false, includeUnknownVoices = false): Promise<void> {
  return exclusive(() => withMediaResetFence(async () => {
    assertDataWritesAllowed(); assertMemoryAvailable(preview.generation);
    const data = await snapshot();
    if (await snapshotRevision(data) !== preview.revision) throw new Error('Data changed since the preview. Please preview again.');
    const native = await nativeInventory();
    if (await digest(native) !== preview.nativeRevision) throw new Error('Memory indexes changed since the preview. Please preview again.');
    const context = contextCandidates({ ...data, vectors: [...data.vectors, ...native] }, preview.messageIds);
    if (JSON.stringify(context) !== JSON.stringify(preview.contextDerived ?? [])) throw new Error('Potentially related materials changed; preview again.');
    if (context.length && !includeContextDerived) throw new Error('Potentially related derived materials require separate confirmation. No data was changed.');
    const media = await mediaInventory(preview.syncPath);
    if (await digest(media) !== preview.mediaRevision) throw new Error('Private media changed since the preview. Please preview again.');
    const { images: unknownImages, voices: unknownVoices } = unreferencedMedia(data, media);
    if (unknownImages.length && !includeUnknownImages) throw new Error('Untraceable unreferenced images require separate confirmation. No data was changed.');
    if (unknownVoices.length && !includeUnknownVoices) throw new Error('Untraceable unreferenced voices require separate confirmation. No data was changed.');
    const selected = selection({ ...data, vectors: [...data.vectors, ...native] }, preview.messageIds, includeLegacyDerived, preview.createdAt, includeContextDerived ? context : []);
    const jobs = await classifyJobs(data, selected.ids, selected.artifactIds);
    const reminders = await reminderLinks(data, selected.ids);
    const block = blockAnalysis(data, selected.ids);
    if ((selected.legacyCount || [...jobs.values()].includes('unknown') || reminders.unknownSourceText.length || block.unknown) && !includeLegacyDerived) throw new Error('Untraceable private derivatives require a broader confirmed scope. No data was changed.');
    const id = crypto.randomUUID();
    const removed = data.messages.filter(row => selected.ids.has(row.id));
    const retained = data.messages.filter(row => !selected.ids.has(row.id));
    const registeredImages = data.images.filter(row => Array.isArray(row.sourceIds) && row.sourceIds.some((id: string) => selected.ids.has(id))).map(row => row.id);
    const imageIds = [...new Set([...removed.map(row => row.imageId).filter(Boolean), ...registeredImages, ...(includeUnknownImages ? unknownImages : [])])].filter(imageId => !retained.some(row => row.imageId === imageId));
    const relatedVoices = [...new Set([...removed.flatMap(row => [row.voiceFileId, row.id]).filter(Boolean), ...relatedLedgerVoices(data, selected.ids, selected.artifactIds), ...(includeUnknownVoices ? unknownVoices : [])])];
    const voiceIds = relatedVoices.filter(voiceId => !retained.some(row => row.voiceFileId === voiceId || row.id === voiceId));
    const rule: MemoryCorrection = { id, generation: id, version: 1, status: 'prepared', createdAt: Date.now(), updatedAt: Date.now(),
      messageIds: [...selected.ids], artifactIds: selected.artifactIds,
      sourceVersions: Object.fromEntries(removed.map(row => [row.id, row.contentRevision || row.sourceRevision || 'unknown'])),
      includeLegacyDerived, legacyCutoff: preview.createdAt, phase: 'prepared', imageIds, voiceIds,
      sharedVoicesRetained: relatedVoices.map(id => ({ id, messageIds: retained.filter(row => row.voiceFileId === id || row.id === id).map(row => row.id) })).filter(item => item.messageIds.length > 0),
      reminderIds: reminders.affected, unknownReminderSourceIds: includeLegacyDerived ? reminders.unknownSourceText : [],
      retainedPrivateKeys: selected.privateAssets.retained, affectedPrivateKeys: selected.privateAssets.affected,
      unknownPrivateKeys: selected.privateAssets.unknown, protectedArtifactIds: selected.privateAssets.protectedArtifacts,
      affectedStateCommitIds: selected.privateAssets.affectedStates, unknownStateCommitIds: selected.privateAssets.unknownStates,
      anchorIds: selected.anchors.affected, unknownAnchorIds: includeLegacyDerived ? selected.anchors.unknown : [],
      redactBlockReason: block.affected || (includeLegacyDerived && block.unknown),
      managedBackups: preview.managedBackups, syncPath: preview.syncPath };
    if (desktop()) await invoke('rag:restore-lock', { id, action: 'begin', kind: 'memory' });
    try {
      if (await digest(await nativeInventory(id)) !== preview.nativeRevision) throw new Error('Memory indexes changed before maintenance could start.');
      await db.transaction('rw', db.tables, async () => {
      // Catch mutations that occurred between snapshot and this short commit.
      const current = await snapshot();
      if (JSON.stringify(current) !== JSON.stringify(data)) throw new Error('Data changed before memory maintenance could start.');
      await db.memoryCorrections.put(rule);
      await db.keyval.bulkPut([{ key: MEMORY_GENERATION_KEY, value: id }, { key: MEMORY_MAINTENANCE_KEY, value: id }]);
      });
    } catch (error) {
      if (desktop()) await invoke('rag:restore-lock', { id, action: 'end', kind: 'memory', aborted: true });
      throw error;
    }
    publishMemoryMaintenance(id, id); ownMemoryMaintenance(id);
    await resumeOwned(rule);
  }));
}
async function purgeTables(rule: MemoryCorrection): Promise<void> {
  const ids = new Set(rule.messageIds);
  const jobData = await snapshot();
  const jobDisposition = await classifyJobs(jobData, ids, rule.artifactIds);
  const newEpoch = crypto.randomUUID();
  const removedArchives = new Set<string>();
  const expandedTurns = new Map<string, any>();
  for (const entry of await db.keyval.where('key').startsWith(TURN_ARCHIVE_PREFIX).toArray()) {
    const original = await readExecutionArchive(entry.value);
    if (rule.includeLegacyDerived || hasSource(original, ids)) {
      removedArchives.add(entry.key); expandedTurns.set('kumiko_turn_v1:' + original.id, original);
    }
  }
  await db.transaction('rw', db.tables, async tx => {
    permitMemoryMaintenanceTransaction(tx, rule.id);
    for (const name of ['messages','kumikoDiary','dailyFragments','episodes','vectors'] as const) {
      const rows = await db.table(name).toArray();
      const removed = rows.filter(row => ruleMatchesRow(row, name, rule));
      await db.table(name).bulkDelete(removed.map(row => row.id));
    }
    for (const row of await db.messages.toArray()) if (row.quote && ids.has(row.quote.id)) await db.messages.update(row.id, { quote: undefined });
    await db.messageViews.bulkDelete(rule.messageIds);
    for (const row of await db.keyval.toArray()) {
      if (removedArchives.has(row.key)) { await db.keyval.delete(row.key); continue; }
      if (row.key === MEMORY_GENERATION_KEY || row.key === MEMORY_MAINTENANCE_KEY) continue;
      if (row.key.startsWith(VOICE_LEDGER_PREFIX)) {
        if (rule.voiceIds?.includes(row.value?.id)) await db.keyval.delete(row.key);
        continue;
      }
      if (row.key === 'kumiko_restore_journal_v1') throw new Error('A restore journal must be recovered before memory correction.');
      if (row.key === 'kumiko_chat_history') {
        const canonical = (await db.messages.orderBy('timestamp').toArray()).map(mapEntityToMessage);
        await db.keyval.put({ key: row.key, value: canonical }); continue;
      }
      if (row.key === 'kumiko_anchors' && Array.isArray(row.value)) {
        const removed = new Set([...(rule.anchorIds ?? []), ...(rule.unknownAnchorIds ?? [])]);
        const remaining = row.value.filter((anchor: any) => !removed.has(anchor?.id));
        if (remaining.length !== row.value.length) {
          await db.keyval.put({ key: row.key, value: remaining });
          await db.keyval.delete('kumiko_memory_asset_v1:kumiko_anchors');
        }
        continue;
      }
      if (row.key.startsWith('kumiko_memory_asset_v1:')) {
        const assetKey = row.key.slice('kumiko_memory_asset_v1:'.length);
        if (rule.retainedPrivateKeys?.includes(assetKey)) await db.keyval.put({ ...row, value: { ...row.value, memoryGeneration: rule.generation } });
        else if (rule.affectedPrivateKeys?.includes(assetKey) || rule.unknownPrivateKeys?.includes(assetKey)) await db.keyval.delete(row.key);
        continue;
      }
      if (PRIVATE_DERIVED_KEYS.has(row.key) || PRIVATE_DERIVED_PREFIXES.some(prefix => row.key.startsWith(prefix))) {
        if (rule.retainedPrivateKeys?.includes(row.key)) {
          if (row.key.startsWith('kumiko_summary_artifact_v1:')) await db.keyval.put({ ...row, value: { ...row.value, memoryGeneration: rule.generation } });
        } else if (rule.affectedPrivateKeys?.includes(row.key) || (rule.includeLegacyDerived && rule.unknownPrivateKeys?.includes(row.key))
          || (!rule.retainedPrivateKeys && (rule.includeLegacyDerived || hasSource(row.value, ids)))) await db.keyval.delete(row.key);
        continue;
      }
      if (row.key === 'user_known_location_v1' && hasSource(row.value, ids)) { await db.keyval.put({ key: row.key, value: null }); continue; }
      if (row.key === 'kumiko_block_runtime' && row.value) {
        const block = { ...row.value, capturedUnreadIds: Array.isArray(row.value.capturedUnreadIds) ? row.value.capturedUnreadIds.filter((id: string) => !ids.has(id)) : [] };
        if (rule.redactBlockReason || ids.has(block.triggerMessageId)) { block.reason = ''; delete block.triggerMessageId; }
        await db.keyval.put({ key: row.key, value: block }); continue;
      }
      if (row.key === 'world_character_status' && (rule.affectedPrivateKeys?.includes(row.key) || (rule.includeLegacyDerived && rule.unknownPrivateKeys?.includes(row.key))
        || (!rule.retainedPrivateKeys && rule.includeLegacyDerived))) { await db.keyval.put({ key: row.key, value: INITIAL_WORLD_CHARACTER_STATUS }); continue; }
      if (row.key === 'kumiko_relative_reminders' || row.key === 'kumiko_daily_reminders') {
        const affected = (row.value || []).filter((r: any) => hasSource(r, ids) || rule.reminderIds?.includes(r.id));
        for (const r of affected) await queueReminderNativeCancellation(r.id);
        await db.keyval.put({ key: row.key, value: (row.value || []).filter((r: any) => !affected.includes(r)).map((r: any) => {
          if (!rule.unknownReminderSourceIds?.includes(r.id)) return r;
          const { sourceText: _sourceText, ...retained } = r; return retained;
        }) }); continue;
      }
      const value = scrubExecutionEntry(row.key, expandedTurns.get(row.key) || row.value, ids, rule.includeLegacyDerived);
      if (value === undefined) await db.keyval.delete(row.key);
      else if (value !== row.value) await db.keyval.put({ key: row.key, value });
    }
    // Numeric feelings are not mechanically reversed. Clear only copied text
    // and retain minimal event identities so actions cannot be replayed.
    for (const row of await db.stateCommits.toArray()) if (rule.affectedStateCommitIds?.includes(row.id)
      || (rule.includeLegacyDerived && rule.unknownStateCommitIds?.includes(row.id))
      || (!rule.affectedStateCommitIds && (rule.includeLegacyDerived || hasSource(row, ids)))) {
      const { result: _result, ...identity } = row;
      await db.stateCommits.put({ ...identity, result: { redacted: true } });
    }
    for (const job of await db.runtimeJobs.toArray()) {
      const disposition = jobDisposition.get(job.id) ?? 'unknown';
      const { owner: _owner, token: _token, leaseUntil: _lease, ...withoutLease } = job;
      if (disposition === 'retain') {
        await db.runtimeJobs.put({ ...withoutLease, epoch: newEpoch, memoryGeneration: rule.generation,
          status: job.status === 'running' ? 'retrying' : job.status, retryAt: job.status === 'running' ? Date.now() : job.retryAt, updatedAt: Date.now() });
      } else {
        const { payload: _payload, checkpoint: _checkpoint, error: _error, ...identity } = withoutLease;
        await db.runtimeJobs.put({ ...identity, epoch: newEpoch, status: 'superseded', memoryGeneration: rule.generation, updatedAt: Date.now() });
      }
    }
    for (const edge of await db.memoryDependencies.toArray()) if (ids.has(edge.sourceId) || rule.artifactIds.includes(`${edge.artifactKind}:${edge.artifactId}`)) await db.memoryDependencies.delete(edge.id);
    for (const id of rule.imageIds || []) await db.images.delete(id);
    await db.keyval.bulkPut([{ key: 'kumiko_turn_epoch_v1', value: newEpoch },
      { key: 'kumiko_rag_history_dirty', value: true }, { key: 'kumiko_turn_archive_status_v1', value: null }]);
  });
}
async function purgeNative(rule: MemoryCorrection): Promise<void> {
  if (!desktop()) return;
  const vectors = await invoke('rag:get-all', { restoreSessionId: rule.id });
  if (!Array.isArray(vectors.vectors)) throw new Error('Native vector inventory is invalid.');
  const retained = vectors.vectors.filter((row: any) => !ruleMatchesRow(row, 'vectors', rule));
  const written = await invoke('rag:restore', { vectors: retained, restoreSessionId: rule.id, purpose: 'memory-maintenance' });
  if (written.count !== retained.length) throw new Error('Native vector cleanup was incomplete.');
  const messages = await db.messages.toArray();
  await invoke('rag:sync-messages', { messages, replaceAll: true, restoreSessionId: rule.id });
  const checked = await invoke('rag:get-all', { restoreSessionId: rule.id });
  const raw = await invoke('rag:get-messages', { restoreSessionId: rule.id });
  if (!Array.isArray(checked.vectors) || checked.vectors.some((row: any) => ruleMatchesRow(row, 'vectors', rule))) throw new Error('Native vectors still contain affected material.');
  if (!Array.isArray(raw.messages) || raw.messages.length !== messages.length || raw.messages.some((row: any) => rule.messageIds.includes(row.id))) throw new Error('Native history verification failed.');
}
async function purgeMedia(rule: MemoryCorrection): Promise<void> {
  if (desktop()) { await invoke('memory:purge-files', { id: rule.id, imageIds: rule.imageIds || [], voiceIds: rule.voiceIds || [], backups: rule.managedBackups || [], syncPath: rule.syncPath }); return; }
  if (!isCapacitorNative()) return;
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  for (const dir of ['images', 'voices']) {
    let listing;
    try { listing = await Filesystem.readdir({ path: dir, directory: Directory.Data }); }
    catch (error) { if (/not found|does not exist|ENOENT|OS-PLUG-FILE-0008/i.test(String(error))) continue; throw error; }
    const ids = new Set(dir === 'images' ? rule.imageIds : rule.voiceIds);
    for (const file of listing.files) if (ids.has(file.name.replace(/\.[^.]+$/, ''))) await Filesystem.deleteFile({ path: `${dir}/${file.name}`, directory: Directory.Data });
    const remaining = await Filesystem.readdir({ path: dir, directory: Directory.Data });
    if (remaining.files.some(file => ids.has(file.name.replace(/\.[^.]+$/, '')))) throw new Error('Media removal was incomplete.');
  }
}
async function confirmNativeReminderCancellations(rule: MemoryCorrection): Promise<void> {
  if (!isCapacitorNative() || getCapacitorPlatform() !== 'android') return;
  await withReminderNativeAlarmLock(async () => {
    const jobs = (await db.keyval.get(REMINDER_NATIVE_CANCEL_KEY))?.value ?? [];
    if (!Array.isArray(jobs)) throw new Error('Native reminder cancellation queue is invalid.');
    for (const job of jobs) {
      if (!job || typeof job.id !== 'string' || typeof job.token !== 'string' || !Array.isArray(job.notificationIds)) throw new Error('Native reminder cancellation is invalid.');
      const results = await Promise.all([
        ...[job.id, `${job.id}__prewarm`, `daily-${job.id}`].map(cancelAndroidAlarm),
        ...job.notificationIds.map(cancelReminderNotification),
      ]);
      if (!results.every(Boolean)) throw new Error('Native reminder cancellation remains unconfirmed.');
      await db.transaction('rw', db.keyval, async tx => {
        permitMemoryMaintenanceTransaction(tx, rule.id);
        const current = (await db.keyval.get(REMINDER_NATIVE_CANCEL_KEY))?.value ?? [];
        await db.keyval.put({ key: REMINDER_NATIVE_CANCEL_KEY, value: current.filter((item: any) => item.token !== job.token) });
      });
    }
  });
}
async function resumeOwned(initial: MemoryCorrection): Promise<void> {
  let rule = initial;
  try {
    if (desktop()) await invoke('rag:restore-lock', { id: rule.id, action: 'begin', kind: 'memory' });
    rule = await updateRule(rule, { status: 'purging', phase: 'application' });
    await purgeTables(rule);
    rule = await updateRule(rule, { phase: 'reminder-cancellation' });
    await confirmNativeReminderCancellations(rule);
    rule = await updateRule(rule, { phase: 'native' }); await purgeNative(rule);
    rule = await updateRule(rule, { phase: 'files' }); await purgeMedia(rule);
    rule = await updateRule(rule, { status: 'rebuilding', phase: 'verification' });
    const data = await snapshot();
    if (data.messages.some(row => rule.messageIds.includes(row.id)) || ['vectors','episodes','kumikoDiary','dailyFragments'].some(name => data[name as keyof Data].some(row => ruleMatchesRow(row, name, rule)))) throw new Error('Application memory verification did not pass.');
    if (desktop()) await invoke('rag:restore-lock', { id: rule.id, action: 'end', kind: 'memory', committed: true });
    await db.transaction('rw', [db.memoryCorrections, db.keyval], async tx => {
      permitMemoryMaintenanceTransaction(tx, rule.id);
      await db.memoryCorrections.put({ ...rule, status: 'completed', phase: 'verified', updatedAt: Date.now(), rebuildRequired: true, error: undefined });
      await db.keyval.put({ key: MEMORY_MAINTENANCE_KEY, value: '' });
    });
    // Existing windows must reload before their stale in-memory stores can write.
    await synchronizeMemoryMaintenanceGate();
  } catch (error) {
    await updateRule(rule, { status: 'failed', error: 'Memory maintenance did not finish. Resume is required.', phase: rule.phase });
    throw error;
  }
}
export async function recoverMemoryMaintenance(): Promise<boolean> {
  await synchronizeMemoryMaintenanceGate(true);
  const id = (await db.keyval.get(MEMORY_MAINTENANCE_KEY))?.value;
  if (!id) return false;
  return exclusive(() => withMediaResetFence(async () => {
    const rule = await db.memoryCorrections.get(id);
    if (!rule) throw new Error('Memory maintenance journal is missing. Data remains protected.');
    ownMemoryMaintenance(id); await resumeOwned(rule); await synchronizeMemoryMaintenanceGate(true); return true;
  }));
}
