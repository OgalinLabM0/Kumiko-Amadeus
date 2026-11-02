import { db } from './db';
import { assertDataWritesAllowed, getDataRestoreVersion } from './dataRestoreGate';
import { getMemoryGeneration, assertMemoryGenerationCurrent } from './memoryMaintenanceGate';

export const BACKGROUND_JOB_PREFIX = 'kumiko_background_job_v1:';
export const BACKGROUND_JOBS_META_KEY = 'kumiko_background_jobs_meta_v1';
const EPOCH_KEY = 'kumiko_turn_epoch_v1';
export const BACKGROUND_JOB_LEASE_MS = 120_000;
const MAX_ATTEMPTS = 8;
// Execution-state backup validates each row below 2 MiB of JSON characters.
const MAX_JOB_JSON_CHARS = 1_900_000;
export interface BackgroundJob {
  version: 1; id: string; kind: string; sourceId: string; sourceVersion: string;
  epoch: string; memoryGeneration?: string; status: 'pending' | 'running' | 'retrying' | 'failed' | 'completed' | 'superseded' | 'deferred';
  attempt: number; retryAt: number; createdAt: number; updatedAt: number;
  owner?: string; token?: string; leaseUntil?: number; error?: string;
  previousAttempts?: number;
  startedAt?: number; deadlineAt?: number; payload?: unknown; checkpoint?: unknown;
}
export interface BackgroundJobsMeta { version: 1; epoch: string; windowStart: number; used: number; diaryReconciled?: boolean; memoryGeneration?: string; }
export interface BackgroundJobClaim { job: BackgroundJob; restoreVersion: string; }
const epoch = async (): Promise<string> => (await db.keyval.get(EPOCH_KEY))?.value ?? 'initial';
const key = (id: string) => BACKGROUND_JOB_PREFIX + id;
const jobs = () => db.table<BackgroundJob, string>('runtimeJobs');
function safeJson<T>(value: T): T {
  const serialized = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Background task contains an invalid number.');
    if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol') throw new Error('Background task contains unsupported data.');
    return item;
  });
  if (serialized === undefined) throw new Error('Background task data is not serializable.');
  return JSON.parse(serialized) as T;
}

export function isBackgroundJobBackupEntry(entryKey: string, value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const finite = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  const text = (x: unknown) => typeof x === 'string' && x.length > 0 && x.length <= 1000;
  if (entryKey === BACKGROUND_JOBS_META_KEY) return v.version === 1 && text(v.epoch)
    && finite(v.windowStart) && Number.isSafeInteger(v.used) && (v.used as number) >= 0
    && (v.memoryGeneration === undefined || text(v.memoryGeneration))
    && (v.diaryReconciled === undefined || typeof v.diaryReconciled === 'boolean');
  return entryKey.startsWith(BACKGROUND_JOB_PREFIX) && v.version === 1 && text(v.id)
    && entryKey === key(v.id as string) && text(v.kind) && text(v.sourceId) && text(v.sourceVersion)
    && text(v.epoch) && ['pending', 'running', 'retrying', 'failed', 'completed', 'superseded'].includes(String(v.status))
    && Number.isSafeInteger(v.attempt) && (v.attempt as number) >= 0
    && (v.previousAttempts === undefined || (Number.isSafeInteger(v.previousAttempts) && (v.previousAttempts as number) >= 0))
    && finite(v.retryAt) && finite(v.createdAt) && finite(v.updatedAt)
    && (v.owner === undefined || text(v.owner)) && (v.token === undefined || text(v.token))
    && (v.leaseUntil === undefined || finite(v.leaseUntil))
    && (v.error === undefined || (typeof v.error === 'string' && v.error.length <= 500));
}

/** Explicit user retry grants a new bounded automatic retry batch. It does not
 * reset the shared hourly budget or erase the last failure/total attempts. */
export async function retryFailedBackgroundJobs(): Promise<number> {
  assertDataWritesAllowed();
  return db.transaction('rw', [db.keyval, jobs()], async () => {
    const currentEpoch = await epoch();
    const rows = await jobs().toArray();
    let count = 0;
    for (const job of rows) {
      if (job.epoch !== currentEpoch || (job.memoryGeneration ?? 'initial') !== getMemoryGeneration() || job.status !== 'failed') continue;
      job.previousAttempts = (job.previousAttempts || 0) + job.attempt;
      job.attempt = 0; job.status = 'pending'; job.retryAt = Date.now(); job.updatedAt = Date.now();
      delete job.owner; delete job.token; delete job.leaseUntil;
      await jobs().put(job); count++;
    }
    return count;
  });
}

/** Caller may include this in a source-table transaction. Idempotent identities
 * retain successful receipts and exhausted retries instead of resetting budget. */
export async function enqueueBackgroundJob(input: Pick<BackgroundJob, 'id' | 'kind' | 'sourceId' | 'sourceVersion'> & Partial<Pick<BackgroundJob, 'payload' | 'checkpoint'>>): Promise<BackgroundJob> {
  return db.transaction('rw', [db.keyval, jobs()], async () => {
    assertDataWritesAllowed();
    const currentEpoch = await epoch();
    await assertMemoryGenerationCurrent(getMemoryGeneration());
    const existing = await jobs().get(input.id);
    if (existing?.epoch === currentEpoch) return existing;
    const now = Date.now();
    const job: BackgroundJob = { ...safeJson(input), version: 1, epoch: currentEpoch, memoryGeneration: getMemoryGeneration(), status: 'pending',
      attempt: 0, retryAt: now, createdAt: now, updatedAt: now };
    if (JSON.stringify(job).length > MAX_JOB_JSON_CHARS) throw new Error('Background task input exceeds the safe backup limit.');
    await jobs().put(job);
    return job;
  });
}

/** IndexedDB serializes claims across windows. Network capacity is reserved separately. */
export async function claimBackgroundJob(kind: string, owner: string, jobId?: string): Promise<BackgroundJobClaim | null> {
  assertDataWritesAllowed();
  const restoreVersion = getDataRestoreVersion();
  return db.transaction('rw', [db.keyval, jobs()], async () => {
    const currentEpoch = await epoch();
    await assertMemoryGenerationCurrent(getMemoryGeneration());
    const now = Date.now();
    const candidates = await jobs().toArray();
    const job = candidates.filter(j => (!jobId || j.id === jobId) && j.epoch === currentEpoch && j.kind === kind
      && (j.memoryGeneration ?? 'initial') === getMemoryGeneration()
      && ((['pending', 'retrying'].includes(j.status) && j.retryAt <= now)
        || (j.status === 'running' && (j.leaseUntil || 0) <= now)))
      .sort((a, b) => a.retryAt - b.retryAt || a.createdAt - b.createdAt)[0];
    if (!job) return null;
    if (job.attempt >= MAX_ATTEMPTS) {
      delete job.owner; delete job.token; delete job.leaseUntil;
      await jobs().put({ ...job, status: 'failed',
        updatedAt: now, error: job.error || 'Retry budget exhausted after an interrupted attempt.' });
      return null;
    }
    job.status = 'running'; job.attempt++; job.owner = owner; job.token = crypto.randomUUID();
    job.startedAt = now; job.deadlineAt = now + 180_000;
    job.leaseUntil = now + BACKGROUND_JOB_LEASE_MS; job.updatedAt = now;
    await jobs().put(job);
    return { job, restoreVersion };
  });
}

/** Call inside the transaction that commits the result and its source checks. */
export async function assertBackgroundJobClaim(claim: BackgroundJobClaim): Promise<BackgroundJob> {
  assertDataWritesAllowed();
  const current = await jobs().get(claim.job.id);
  if (claim.job.memoryGeneration !== undefined) await assertMemoryGenerationCurrent(claim.job.memoryGeneration);
  if (getDataRestoreVersion() !== claim.restoreVersion || await epoch() !== claim.job.epoch
    || !current || current.status !== 'running' || current.token !== claim.job.token
    || current.owner !== claim.job.owner || (current.leaseUntil || 0) <= Date.now()
    || (current.deadlineAt || Infinity) <= Date.now()) {
    throw new Error('Background job expired, was superseded, or belongs to restored data.');
  }
  return current;
}

/** A renewal never resurrects an expired claim and never extends its hard deadline. */
export async function renewBackgroundJobClaim(claim: BackgroundJobClaim): Promise<number> {
  return db.transaction('rw', [db.keyval, jobs()], async () => {
    const current = await assertBackgroundJobClaim(claim);
    current.leaseUntil = Math.min(Date.now() + BACKGROUND_JOB_LEASE_MS, current.deadlineAt || Date.now());
    current.updatedAt = Date.now();
    await jobs().put(current);
    claim.job.leaseUntil = current.leaseUntil;
    return current.leaseUntil;
  });
}

/** Capacity and user pause are waiting states, not unsuccessful attempts. */
export async function deferBackgroundJob(claim: BackgroundJobClaim, retryAt: number): Promise<void> {
  await db.transaction('rw', [db.keyval, jobs()], async () => {
    const current = await assertBackgroundJobClaim(claim);
    current.status = 'retrying'; current.attempt = Math.max(0, current.attempt - 1);
    current.retryAt = Math.max(Date.now() + 1000, retryAt); current.updatedAt = Date.now();
    delete current.owner; delete current.token; delete current.leaseUntil;
    await jobs().put(current);
  });
}

export async function checkpointBackgroundJob(claim: BackgroundJobClaim, checkpoint: unknown): Promise<void> {
  await db.transaction('rw', [db.keyval, jobs()], async () => {
    const current = await assertBackgroundJobClaim(claim);
    current.checkpoint = safeJson(checkpoint); current.updatedAt = Date.now();
    if (JSON.stringify(current).length > MAX_JOB_JSON_CHARS) throw new Error('Background task checkpoint exceeds the safe backup limit.');
    await jobs().put(current);
    claim.job.checkpoint = current.checkpoint;
  });
}

export async function parkBackgroundJob(claim: BackgroundJobClaim, reason: string, countAttempt = true): Promise<void> {
  await db.transaction('rw', [db.keyval, jobs()], async () => {
    const current = await assertBackgroundJobClaim(claim);
    current.status = 'deferred'; if (!countAttempt) current.attempt = Math.max(0, current.attempt - 1);
    current.error = reason.slice(0, 500); current.updatedAt = Date.now();
    delete current.owner; delete current.token; delete current.leaseUntil;
    await jobs().put(current);
  });
}

export async function finishBackgroundJob(claim: BackgroundJobClaim, status: 'completed' | 'superseded' | 'retrying', error?: unknown): Promise<void> {
  await db.transaction('rw', [db.keyval, jobs()], async () => {
    const current = await assertBackgroundJobClaim(claim);
    const now = Date.now();
    current.status = status === 'retrying' && current.attempt >= MAX_ATTEMPTS ? 'failed' : status;
    current.retryAt = now + Math.min(60 * 60_000, 5_000 * 2 ** Math.min(current.attempt - 1, 10));
    current.updatedAt = now;
    delete current.owner; delete current.token; delete current.leaseUntil;
    if (error !== undefined) current.error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    else delete current.error;
    await jobs().put(current);
  });
}

/** Called inside the restore transaction after the replacement dataset is staged.
 * Preserve generation work and receipts; never resurrect an imported lease. */
export async function rebaseBackgroundJobsAfterRestore(): Promise<void> {
  const legacy = await db.keyval.where('key').startsWith(BACKGROUND_JOB_PREFIX).toArray();
  for (const row of legacy) {
    if (!isBackgroundJobBackupEntry(row.key, row.value)) throw new Error('Invalid legacy background job in backup.');
    if (!await jobs().get(row.value.id)) await jobs().put(row.value);
  }
  const currentEpoch = await epoch();
  const restoredGeneration = (await db.keyval.get('kumiko_memory_generation_v1'))?.value || 'initial';
  const all = await jobs().toArray();
  for (const job of all) {
    const priorStatus = job.status;
    const reconstructible = job.kind === 'diary-index' || job.kind === 'disclosed-location-resolution' || job.kind === 'execution-archive';
    Object.assign(job, { epoch: currentEpoch, restoredStatus: priorStatus, updatedAt: Date.now() });
    delete job.owner; delete job.token; delete job.leaseUntil; delete job.startedAt; delete job.deadlineAt;
    if (reconstructible) {
      // These workers read current source text and check its version again.
      job.memoryGeneration = restoredGeneration;
      if (priorStatus === 'completed') job.status = 'pending';
      else if (priorStatus === 'running') job.status = 'retrying';
      if (job.status === 'pending' || job.status === 'retrying') job.retryAt = Date.now();
    } else if (priorStatus !== 'completed' && priorStatus !== 'superseded') {
      // A generated result or user intent cannot be reconstructed merely from
      // an index source; a later source/correction audit must release it.
      job.status = 'deferred';
    }
    await jobs().put(job);
  }
  await db.keyval.bulkDelete([...legacy.map(row => row.key), BACKGROUND_JOBS_META_KEY]);
}

export async function readBackgroundJobStatus(): Promise<{ pending: number; running: number; retrying: number; failed: number; completed: number; failures: Array<{ id: string; sourceId: string; error: string; attempt: number; retryAt: number }> }> {
  const currentEpoch = await epoch();
  const rows = await jobs().toArray();
  const result = { pending: 0, running: 0, retrying: 0, failed: 0, completed: 0,
    failures: [] as Array<{ id: string; sourceId: string; error: string; attempt: number; retryAt: number }> };
  for (const j of rows) if (j.epoch === currentEpoch) {
    if (j.status in result) (result as any)[j.status]++;
    if (j.status === 'failed' || j.status === 'retrying') result.failures.push({ id: j.id, sourceId: j.sourceId,
      error: j.error || 'Indexing is awaiting retry.', attempt: j.attempt, retryAt: j.retryAt });
  }
  return result;
}
