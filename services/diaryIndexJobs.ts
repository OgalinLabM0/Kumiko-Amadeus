import { db, type KumikoDiaryEntity } from './db';
import { assertDataWritesAllowed, getDataRestoreVersion, isDataRestoreBlocked } from './dataRestoreGate';
import { assertMemoryGenerationCurrent, getMemoryGeneration } from './memoryMaintenanceGate';
import { isCapacitorNative } from './environment';
import { BACKGROUND_JOBS_META_KEY, assertBackgroundJobClaim,
  claimBackgroundJob, deferBackgroundJob, enqueueBackgroundJob, finishBackgroundJob, renewBackgroundJobClaim,
  type BackgroundJobClaim, type BackgroundJobsMeta } from './backgroundJobs';

const KIND = 'diary-index';
const EPOCH_KEY = 'kumiko_turn_epoch_v1';
const body = (diary: KumikoDiaryEntity) => `[久美子的日记 - ${diary.date}]\n${diary.content}`;
const currentEpoch = async (): Promise<string> => (await db.keyval.get(EPOCH_KEY))?.value ?? 'initial';
const sameSource = (a: KumikoDiaryEntity | undefined, b: KumikoDiaryEntity) => !!a
  && a.id === b.id && a.date === b.date && a.content === b.content && a.timestamp === b.timestamp;

export async function diaryIndexVersion(diary: KumikoDiaryEntity): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([diary.id, diary.date, diary.timestamp, diary.content]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}
const identity = (diary: KumikoDiaryEntity, version: string) => ({ id: `diary:${diary.id}:${version}${getMemoryGeneration() === 'initial' ? '' : `:g:${getMemoryGeneration()}`}`,
  kind: KIND, sourceId: diary.id, sourceVersion: version });

/** The authoritative text and its durable obligation are one commit. Fragment
 * deletion is limited to fragments actually included by this settlement. */
export async function saveDiaryWithIndexJob(diary: KumikoDiaryEntity, options: {
  restoreVersion?: string; settledFragmentIds?: string[];
  memoryGeneration?: string;
  jobContext?: { assertCurrent(): Promise<void>; assertClaim?(): Promise<void>; complete?(): Promise<void> };
  commitReflection?: () => Promise<void>;
  afterDiaryWrite?: () => Promise<void>;
  draft?: boolean;
} = {}): Promise<KumikoDiaryEntity> {
  if (options.draft) throw new Error('Diary drafts must remain in the job checkpoint.');
  const restoreVersion = options.restoreVersion ?? getDataRestoreVersion();
  const memoryGeneration = options.memoryGeneration ?? getMemoryGeneration();
  const version = await diaryIndexVersion(diary);
  const desktop = typeof window !== 'undefined' ? window.electronAPI : undefined;
  const mutation = { id: `diary-${diary.date}`, token: crypto.randomUUID(), mutation: true };
  let mutationLocked = false;
  if (desktop) {
    try {
      const result = await desktop.invoke('rag:diary-lease', mutation);
      if (!result?.success) throw new Error(result?.error || 'Could not protect diary update.');
      mutationLocked = true;
    } catch (error) {
      // If RAG never initialized, there is no native writer to fence. Keep
      // saving the diary and its durable obligation for a later restart.
      if (!(error instanceof Error) || !error.message.includes("No handler registered for 'rag:diary-lease'")) throw error;
    }
  }
  const tables: Array<import('dexie').Table<any, any>> = [db.kumikoDiary, db.dailyFragments, db.keyval, db.table('runtimeJobs')];
  if (options.jobContext || options.commitReflection || options.afterDiaryWrite) {
    tables.push(db.messages, db.psycheState, db.table('stateCommits'), db.table('memoryDependencies'), db.table('memoryCorrections'));
  }
  try { return await db.transaction('rw', tables, async () => {
    assertDataWritesAllowed();
    if (restoreVersion !== getDataRestoreVersion()) throw new Error('Diary generation belongs to data before restoration.');
    await assertMemoryGenerationCurrent(memoryGeneration);
    await options.jobContext?.assertCurrent();
    const prior = await db.kumikoDiary.get(diary.id);
    if (prior && prior.date !== diary.date) throw new Error('Changing a diary date is not supported.');
    const sameDate = await db.kumikoDiary.where('date').equals(diary.date).first();
    if (sameDate && sameDate.id !== diary.id) return sameDate;
    await options.commitReflection?.();
    await db.kumikoDiary.put(diary);
    await options.afterDiaryWrite?.();
    await enqueueBackgroundJob(identity(diary, version));
    if (options.settledFragmentIds?.length) await db.dailyFragments.bulkDelete(options.settledFragmentIds);
    await options.jobContext?.assertClaim?.();
    await assertMemoryGenerationCurrent(memoryGeneration);
    await options.jobContext?.complete?.();
    return diary;
  }); } finally {
    if (desktop && mutationLocked) await desktop.invoke('rag:diary-lease', { ...mutation, release: true });
  }
}

async function invoker(): Promise<((channel: string, payload?: any, context?: import('./taskRuntime').TaskContext) => Promise<any>) | null> {
  if (typeof window !== 'undefined' && window.electronAPI) return (channel, payload) => window.electronAPI!.invoke(channel, payload);
  if (isCapacitorNative()) return (await import('./androidRagService')).invokeAndroidRag;
  return null;
}

/** Once per dataset, create missing legacy obligations. Each worker retry reads
 * the existing vector first, so a crash after native success costs no embedding. */
export async function reconcileDiaryIndexJobs(): Promise<void> {
  assertDataWritesAllowed();
  const restoreVersion = getDataRestoreVersion();
  const epoch = await currentEpoch();
  const meta = (await db.keyval.get(BACKGROUND_JOBS_META_KEY))?.value as BackgroundJobsMeta | undefined;
  const memoryGeneration = getMemoryGeneration();
  if (meta?.epoch === epoch && meta.diaryReconciled && meta.memoryGeneration === memoryGeneration) return;
  const diaries = await db.kumikoDiary.toArray();
  for (const diary of diaries) {
    const version = await diaryIndexVersion(diary);
    await db.transaction('rw', [db.kumikoDiary, db.keyval, db.table('runtimeJobs')], async () => {
      assertDataWritesAllowed();
      if (restoreVersion !== getDataRestoreVersion() || epoch !== await currentEpoch()) throw new Error('Diary reconciliation expired.');
      if (sameSource(await db.kumikoDiary.get(diary.id), diary)) await enqueueBackgroundJob(identity(diary, version));
    });
  }
  await db.transaction('rw', db.keyval, async () => {
    assertDataWritesAllowed();
    if (restoreVersion !== getDataRestoreVersion() || epoch !== await currentEpoch()) throw new Error('Diary reconciliation expired.');
    const latest = (await db.keyval.get(BACKGROUND_JOBS_META_KEY))?.value as BackgroundJobsMeta | undefined;
    await db.keyval.put({ key: BACKGROUND_JOBS_META_KEY, value: { ...(latest?.epoch === epoch ? latest
      : { version: 1, epoch, windowStart: Date.now(), used: 0 }), diaryReconciled: true, memoryGeneration } });
  });
}

async function checkSource(claim: BackgroundJobClaim, diary: KumikoDiaryEntity): Promise<void> {
  await db.transaction('r', [db.keyval, db.kumikoDiary, db.table('runtimeJobs')], async () => {
    await assertBackgroundJobClaim(claim);
    if (!sameSource(await db.kumikoDiary.get(diary.id), diary)) throw new Error('Diary source changed while indexing.');
  });
}

/** A claimed retry only indexes persisted text; it never generates a diary or
 * modifies life fragments. Native writes use the same expiring fencing token. */
export async function runDiaryIndexJob(owner = crypto.randomUUID(), jobId?: string): Promise<boolean> {
  const invoke = await invoker();
  if (!invoke || isDataRestoreBlocked()) return false;
  const claim = await claimBackgroundJob(KIND, owner, jobId);
  if (!claim) return false;
  const controller = new AbortController();
  const taskContext = { taskId: claim.job.id, rootId: claim.job.id, role: 'diary-index', lane: 'background' as const,
    deadlineAt: claim.job.deadlineAt!, signal: controller.signal, epoch: claim.restoreVersion,
    memoryGeneration: claim.job.memoryGeneration ?? 'initial', modelRevisions: {}, consultedSources: [] };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewal: ReturnType<typeof setInterval> | undefined;
  const indexId = (date: string) => `diary-${date}`;
  let fencePayload: any;
  try {
    const diary = await db.kumikoDiary.get(claim.job.sourceId);
    if (!diary || await diaryIndexVersion(diary) !== claim.job.sourceVersion) {
      await finishBackgroundJob(claim, 'superseded'); return true;
    }
    await checkSource(claim, diary);
    fencePayload = { id: indexId(diary.date), token: claim.job.token, leaseUntil: claim.job.leaseUntil,
      claim, sourceId: diary.id };
    const lease = await invoke('rag:diary-lease', fencePayload);
    if (!lease?.success) throw new Error(lease?.error || 'Could not reserve diary index write.');
    // The source may have changed between the first check and native lease.
    await checkSource(claim, diary);
    const work = async () => {
      const lookup = { id: indexId(diary.date), canonicalKey: `diary:${diary.date}` };
      const existing = await invoke('rag:get-by-id', lookup);
      if (!existing?.success) throw new Error(existing?.error || 'Could not verify diary index.');
      if (existing.row?.text !== body(diary) || existing.row?.canonicalKey !== `diary:${diary.date}`
        || existing.row?.timestamp !== diary.timestamp) {
        await checkSource(claim, diary);
        const saved = await invoke('rag:save', { id: existing.row?.id || indexId(diary.date), text: body(diary), timestamp: diary.timestamp,
          tier: 'core', source: 'diary', canonicalKey: `diary:${diary.date}`, role: 'system', backgroundJob: fencePayload }, taskContext);
        if (!saved?.success || saved.skipped) throw new Error(saved?.error || 'Diary index was not written.');
      }
      await checkSource(claim, diary);
      const verified = await invoke('rag:get-by-id', lookup);
      if (!verified?.success || verified.row?.text !== body(diary) || verified.row?.canonicalKey !== `diary:${diary.date}`
        || verified.row?.timestamp !== diary.timestamp) {
        throw new Error(verified?.error || 'Diary index verification did not match saved text.');
      }
      await db.transaction('rw', [db.keyval, db.kumikoDiary, db.table('runtimeJobs')], async () => {
        await assertBackgroundJobClaim(claim);
        if (!sameSource(await db.kumikoDiary.get(diary.id), diary)) throw new Error('Diary changed before index receipt.');
        await finishBackgroundJob(claim, 'completed');
      });
    };
    await Promise.race([work(), new Promise<never>((_, reject) => {
      renewal = setInterval(() => {
        void (async () => {
          const leaseUntil = await renewBackgroundJobClaim(claim);
          const result = await invoke('rag:diary-lease', { ...fencePayload, leaseUntil, renew: true });
          if (!result?.success) throw new Error(result?.error || 'Native diary lease renewal failed.');
          fencePayload.leaseUntil = leaseUntil;
        })().catch(reject);
      }, 20_000);
      timer = setTimeout(() => reject(new Error('Diary index attempt timed out.')), Math.max(1, (claim.job.deadlineAt || 0) - Date.now() - 1000));
    })]);
  } catch (error) {
    try {
      const capacity = error as { kind?: string; nextEligibleAt?: number };
      if (['budget', 'busy', 'paused'].includes(capacity?.kind || '')) await deferBackgroundJob(claim, capacity.nextEligibleAt ?? Date.now() + 15_000);
      else await finishBackgroundJob(claim, 'retrying', error);
    } catch { /* Restored/superseded claims must not change the new dataset. */ }
  } finally {
    controller.abort();
    if (timer) clearTimeout(timer);
    if (renewal) clearInterval(renewal);
    // Revoke before a timed-out embedding can commit. Token-conditional release
    // cannot revoke a newer window's claim.
    if (fencePayload) try { await invoke('rag:diary-lease', { ...fencePayload, release: true }); } catch { /* Expiry still fences native commit. */ }
  }
  return true;
}

export async function indexSavedDiary(diary: KumikoDiaryEntity): Promise<{ ok: boolean; reason?: 'skipped' | 'failed'; error?: string }> {
  const version = await diaryIndexVersion(diary);
  const input = identity(diary, version);
  await db.transaction('rw', [db.keyval, db.kumikoDiary, db.table('runtimeJobs')], async () => {
    if (!sameSource(await db.kumikoDiary.get(diary.id), diary)) throw new Error('Only the current saved diary can be indexed.');
    await enqueueBackgroundJob(input);
  });
  if (!await invoker()) return { ok: false, reason: 'skipped' };
  await runDiaryIndexJob(crypto.randomUUID(), input.id);
  const receipt = await db.table('runtimeJobs').get(input.id);
  return receipt?.status === 'completed' ? { ok: true }
    : { ok: false, reason: 'failed', error: receipt?.error || 'Diary indexing is durably queued.' };
}
