import { db } from './db';
import { getDataRestoreVersion } from './dataRestoreGate';
import { assertMemoryGenerationCurrent } from './memoryMaintenanceGate';
import { assertBackgroundJobClaim, enqueueBackgroundJob, renewBackgroundJobClaim, type BackgroundJobClaim } from './backgroundJobs';
import { isCapacitorNative } from './environment';
import { invokeAndroidRag } from './androidRagService';
import type { EvidenceRef } from './runtimeEntities';
import type { TaskContext } from './taskRuntime';

const PREFIX = 'kumiko_summary_artifact_v1:';
const MARKER = 'ka-artifact:';
interface Registry { id: string; version: string; state: 'staged' | 'active'; epoch: string; memoryGeneration: string; sourceRefs: EvidenceRef[]; chunkCount?: number; }
export interface IndexedArtifactInput {
  artifactId: string; sourceVersion: string; kind: 'summary'; textChunks: string[]; sourceRefs: EvidenceRef[];
  epoch: string; memoryGeneration: string; claimToken: string; leaseUntil: number; jobId: string; taskContext?: TaskContext;
}

async function currentSource(ref: EvidenceRef): Promise<boolean> {
  let row: any;
  if (ref.kind === 'message') row = await db.messages.get(ref.id);
  else if (ref.kind === 'diary') row = await db.kumikoDiary.get(ref.id);
  else if (ref.kind === 'fragment') row = await db.dailyFragments.get(ref.id);
  else return false;
  return !!row && (ref.kind === 'message' ? row.contentRevision ?? row.sourceRevision ?? 'legacy' : row.sourceRevision ?? 'legacy') === ref.version;
}

/** Caller includes messages, kumikoDiary, dailyFragments and memoryCorrections. */
export async function assertSourceRefsCurrent(refs: EvidenceRef[]): Promise<void> {
  const corrections = await db.memoryCorrections.toArray();
  for (const ref of refs) {
    if (corrections.some(rule => rule.messageIds?.includes(ref.id) || rule.artifactIds?.includes(ref.id)
      || Object.prototype.hasOwnProperty.call(rule.sourceVersions || {}, ref.id))) throw new Error('Consulted memory source was corrected.');
    if (!await currentSource(ref)) throw new Error('Consulted memory source changed.');
  }
}

async function validRegistry(registry: Registry | undefined): Promise<boolean> {
  if (!registry || registry.state !== 'active' || registry.epoch !== getDataRestoreVersion()) return false;
  try {
    await assertMemoryGenerationCurrent(registry.memoryGeneration);
    await assertSourceRefsCurrent(registry.sourceRefs);
    return registry.sourceRefs.length > 0;
  } catch { return false; }
}

/** Filter native results before formatting or constructing model context. */
export async function filterValidArtifactCandidates<T extends { canonicalKey?: string; artifactState?: string }>(candidates: T[]): Promise<T[]> {
  return db.transaction('r', [db.keyval, db.messages, db.kumikoDiary, db.dailyFragments, db.memoryCorrections], async () => {
    const kept: T[] = [];
    for (const candidate of candidates) {
      if (!candidate.canonicalKey?.startsWith(MARKER)) { kept.push(candidate); continue; }
      if (candidate.artifactState !== 'active') continue;
      const match = /^ka-artifact:(ka-[a-f0-9]{64}):\d+$/.exec(candidate.canonicalKey);
      if (!match) continue;
      const registry = (await db.keyval.get(PREFIX + match[1]))?.value as Registry | undefined;
      if (await validRegistry(registry)) kept.push(Object.assign({}, candidate, { sourceRefs: registry!.sourceRefs, artifactId: registry!.id }));
    }
    return kept;
  });
}

export async function saveIndexedArtifact(input: IndexedArtifactInput): Promise<{ success: boolean; digest: string; count: number; searchReady: boolean }> {
  if (!input.sourceRefs.length || !input.textChunks.length || input.textChunks.length > 100) throw new Error('Artifact requires bounded chunks and source evidence.');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.artifactId));
  const id = /^ka-[a-f0-9]{64}$/.test(input.artifactId) ? input.artifactId
    : 'ka-' + Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  const chunkIds = input.textChunks.map((_, i) => `${id}:${i}`), canonicalKeys = chunkIds.map(chunk => MARKER + chunk);
  const job = await db.runtimeJobs.get(input.jobId);
  if (!job || job.token !== input.claimToken) throw new Error('Artifact task claim is not current.');
  const claim: BackgroundJobClaim = { job: job as BackgroundJobClaim['job'], restoreVersion: input.epoch };
  const registry: Registry = { id, version: input.sourceVersion, state: 'staged', epoch: input.epoch,
    memoryGeneration: input.memoryGeneration, sourceRefs: input.sourceRefs, chunkCount: input.textChunks.length };
  const tables = [db.keyval, db.runtimeJobs, db.messages, db.kumikoDiary, db.dailyFragments, db.memoryDependencies, db.memoryCorrections];
  const check = async () => {
    await assertBackgroundJobClaim(claim); await assertMemoryGenerationCurrent(input.memoryGeneration);
    await assertSourceRefsCurrent(input.sourceRefs);
  };
  await db.transaction('rw', tables, async () => {
    await check(); await db.keyval.put({ key: PREFIX + id, value: registry });
    for (const [i, ref] of input.sourceRefs.entries()) await db.memoryDependencies.put({ id: `${id}:${i}`, artifactId: id,
      artifactKind: 'summary', artifactVersion: input.sourceVersion, sourceId: ref.id, sourceKind: ref.kind,
      sourceVersion: ref.version, relation: ref.relation || 'basis', createdAt: Date.now() });
  });
  const desktop = typeof window !== 'undefined' ? window.electronAPI : undefined;
  const android = !desktop && isCapacitorNative();
  if (!desktop && !android) throw new Error('Artifact indexing is unavailable.');
  const invoke = (channel: string, payload: any) => desktop ? desktop.invoke(channel, payload) : invokeAndroidRag<any>(channel, payload, input.taskContext);
  const nativePayload = { id, version: input.sourceVersion, token: input.claimToken, leaseUntil: input.leaseUntil, epoch:input.epoch, memoryGeneration:input.memoryGeneration,
    sourceRefs: input.sourceRefs, chunkIds, canonicalKeys, textChunks: input.textChunks };
  if (desktop) { const staged = await invoke('rag:artifact-stage', nativePayload); if (!staged?.success) throw new Error(staged?.error || 'Artifact staging failed.'); }
  let renewalError: unknown;
  let renewalBusy = false;
  let renewalPending: Promise<void> | undefined;
  const renewal = setInterval(() => {
    if (renewalBusy) return;
    renewalBusy = true;
    renewalPending = (async () => {
      const leaseUntil = await renewBackgroundJobClaim(claim);
      if (desktop) {
        const result = await invoke('rag:artifact-stage', { ...nativePayload, leaseUntil, renew: true });
        if (!result?.success) throw new Error(result?.error || 'Artifact lease renewal failed.');
      }
      nativePayload.leaseUntil = leaseUntil;
    })().catch(error => { renewalError = error; }).finally(() => { renewalBusy = false; });
  }, 20_000);
  try {
  for (let i = 0; i < input.textChunks.length; i++) {
    if (renewalError) throw renewalError;
    await db.transaction('r', tables, check);
    const read = desktop ? await invoke('rag:artifact-get', { id: chunkIds[i] })
      : { success: true, row: await db.vectors.get(chunkIds[i]) };
    if (!read?.success) throw new Error(read?.error || 'Artifact readback failed.');
    if (read.row?.text === input.textChunks[i] && read.row?.canonicalKey === canonicalKeys[i] && (!desktop || read.row.searchReady)) continue;
    const result = await invoke('rag:save', { id: chunkIds[i], text: input.textChunks[i], tier: 'core',
      source: 'memory_chunk', canonicalKey: canonicalKeys[i], role: 'system' });
    if (!result?.success || result.skipped) throw new Error(result?.error || 'Artifact chunk could not be indexed.');
  }
  clearInterval(renewal);
  if (renewalPending) await renewalPending;
  if (renewalError) throw renewalError;
  await db.transaction('r', tables, check);
  if (desktop) {
    const committed = await invoke('rag:artifact-commit', nativePayload);
    if (!committed?.success || committed.count !== chunkIds.length) throw new Error(committed?.error || 'Artifact verification failed.');
  } else {
    for (let i = 0; i < chunkIds.length; i++) {
      const row = await db.vectors.get(chunkIds[i]);
      if (!row || row.text !== input.textChunks[i] || row.canonicalKey !== canonicalKeys[i]) throw new Error('Artifact verification failed.');
    }
  }
  await db.transaction('rw', tables, async () => { await check(); await db.keyval.put({ key: PREFIX + id, value: { ...registry, state: 'active' } }); });
  return { success: true, digest: id.slice(3), count: chunkIds.length, searchReady: true };
  } finally { clearInterval(renewal); }
}

/** Rebuild only complete artifacts whose surviving registry and every source
 * still pass the correction journal. Missing registries are never recreated. */
export async function reconcileArtifactJobs(): Promise<void> {
  const { getMemoryGeneration } = await import('./memoryMaintenanceGate');
  const generation = getMemoryGeneration(), epoch = getDataRestoreVersion();
  const markerKey = 'kumiko_artifact_reconcile_v1';
  const marker = (await db.keyval.get(markerKey))?.value;
  if (marker?.generation === generation && marker?.epoch === epoch) return;
  const records = await db.keyval.where('key').startsWith(PREFIX).toArray();
  const registries = records.map(row => row.value as Registry).filter(row => row && (row.epoch !== epoch || row.memoryGeneration !== generation));
  if (registries.length) {
    const desktop = typeof window !== 'undefined' ? window.electronAPI : undefined;
    const android = !desktop && isCapacitorNative();
    if (!desktop && !android) return;
    const result: any = desktop ? await desktop.invoke('rag:artifact-list') : await invokeAndroidRag('rag:get-all');
    if (!result?.success || !Array.isArray(result.vectors)) throw new Error('Artifact reconciliation could not inspect the index.');
    for (const registry of registries) {
      const chunks = result.vectors.filter((row: any) => typeof row.canonicalKey === 'string'
        && row.canonicalKey.startsWith(`${MARKER}${registry.id}:`));
      if (!chunks.length) continue;
      if (android && (typeof registry.chunkCount !== 'number' || chunks.length !== registry.chunkCount)) continue;
      if (desktop && (chunks.some((row: any) => row.artifactId !== registry.id || row.artifactVersion !== registry.version
        || JSON.stringify(row.sourceRefs) !== JSON.stringify(registry.sourceRefs))
        || chunks.some((row: any) => row.artifactChunkCount !== chunks.length))) continue;
      chunks.sort((a: any, b: any) => Number(a.id.split(':').at(-1)) - Number(b.id.split(':').at(-1)));
      await db.transaction('rw', [db.keyval, db.runtimeJobs, db.messages, db.kumikoDiary, db.dailyFragments, db.memoryCorrections], async () => {
        await assertMemoryGenerationCurrent(generation);
        const current = (await db.keyval.get(PREFIX + registry.id))?.value as Registry | undefined;
        if (JSON.stringify(current) !== JSON.stringify(registry)) return;
        try { await assertSourceRefsCurrent(registry.sourceRefs); } catch { return; }
        await enqueueBackgroundJob({ id: `artifact-rebuild:${registry.id}:${registry.version}:g:${generation}`, kind: 'summary-index',
          sourceId: registry.id, sourceVersion: registry.version,
          payload: { artifactId: registry.id, chunks: chunks.map((row: any) => row.text), refs: registry.sourceRefs } });
      });
    }
  }
  await db.transaction('rw', db.keyval, async () => {
    await assertMemoryGenerationCurrent(generation);
    if (getDataRestoreVersion() !== epoch) throw new Error('Artifact reconciliation expired.');
    await db.keyval.put({ key: markerKey, value: { generation, epoch } });
  });
}
