import { db } from './db';
import { assertMemoryAvailable, assertMemoryGenerationCurrent } from './memoryMaintenanceGate';
import type { EvidenceRef } from './runtimeEntities';

export type TaskLane = 'foreground' | 'background';
export interface TaskContext {
  taskId: string;
  rootId: string;
  role: string;
  lane: TaskLane;
  deadlineAt: number;
  signal?: AbortSignal;
  epoch: string;
  memoryGeneration: string;
  modelRevisions?: Record<string, string>;
  consultedSources?: EvidenceRef[];
  inputSources?: EvidenceRef[];
}
export const MODEL_REVISIONS_KEY = 'kumiko_model_config_revisions_v1';
/** Invoke within an rw transaction that includes db.keyval. */
export async function assertTaskModelRevisionsCurrent(context: TaskContext): Promise<void> {
  const current: Record<string, string> = (await db.keyval.get(MODEL_REVISIONS_KEY))?.value || {};
  for (const [role, captured] of Object.entries(context.modelRevisions || {})) {
    if ((current[role] || 'legacy:0') !== captured) throw new Error('Model configuration changed during task.');
  }
}
export interface RequestTarget {
  provider: string;
  model?: string;
  operation: string;
  connectionId?: string;
  configRevision: string;
  remote?: boolean;
}
export class TaskCapacityError extends Error {
  constructor(readonly kind: 'budget' | 'busy' | 'expired' | 'paused', readonly nextEligibleAt?: number) {
    super(`Task request ${kind}`);
  }
}

const FOREGROUND_ACTIVITY_KEY = 'kumiko_foreground_model_activity_v1';
export async function beginForegroundActivity(context: TaskContext): Promise<void> {
  if (context.lane !== 'foreground') return;
  await db.transaction('rw', db.keyval, async () => {
    const now = Date.now();
    const current: Record<string, number> = (await db.keyval.get(FOREGROUND_ACTIVITY_KEY))?.value || {};
    const leases = Object.fromEntries(Object.entries(current).filter(([, expiry]) => typeof expiry === 'number' && expiry > now));
    leases[context.taskId] = context.deadlineAt;
    await db.keyval.put({ key: FOREGROUND_ACTIVITY_KEY, value: leases });
  });
}
export async function endForegroundActivity(context: TaskContext): Promise<void> {
  if (context.lane !== 'foreground') return;
  await db.transaction('rw', db.keyval, async () => {
    const leases: Record<string, number> = (await db.keyval.get(FOREGROUND_ACTIVITY_KEY))?.value || {};
    delete leases[context.taskId];
    await db.keyval.put({ key: FOREGROUND_ACTIVITY_KEY, value: leases });
  });
}

/** Every actual remote transmission reserves one row, including retries. */
export async function reserveTaskRequest(context: TaskContext, target: RequestTarget): Promise<string> {
  const now = Date.now();
  if (context.signal?.aborted || now >= context.deadlineAt) throw new TaskCapacityError('expired');
  assertMemoryAvailable(context.memoryGeneration);
  const table = db.table('runtimeRequestAttempts');
  const id = crypto.randomUUID();
  await db.transaction('rw', table, db.keyval, async () => {
    await assertMemoryGenerationCurrent(context.memoryGeneration);
    await assertTaskModelRevisionsCurrent(context);
    if (context.signal?.aborted || Date.now() >= context.deadlineAt) throw new TaskCapacityError('expired');
    if (context.lane === 'background' && target.remote !== false && (await db.keyval.get('kumiko_background_network_paused_v1'))?.value === true) throw new TaskCapacityError('paused');
    if (context.lane === 'background' && target.remote !== false) {
      const leases: Record<string, number> = (await db.keyval.get(FOREGROUND_ACTIVITY_KEY))?.value || {};
      if (Object.values(leases).some(expiry => typeof expiry === 'number' && expiry > now)) throw new TaskCapacityError('busy');
    }
    const activeRows: any[] = await table.where('status').equals('running').toArray();
    const active = activeRows.filter(row => row.leaseUntil > now);
    for (const expired of activeRows.filter(row => row.leaseUntil <= now)) {
      await table.update(expired.id, { status: 'expired', finishedAt: now });
    }
    // A background reservation waits for foreground work already in flight.
    if (active.some(row => row.lane === context.lane) || (context.lane === 'background' && target.remote !== false && active.some(row => row.lane === 'foreground'))) {
      throw new TaskCapacityError('busy');
    }
    if (context.lane === 'foreground' && (await table.where('rootId').equals(context.rootId).filter(row => row.lane === 'foreground').count()) >= 8) {
      throw new TaskCapacityError('budget');
    }
    if (context.lane === 'background' && target.remote !== false) {
      const recent: any[] = await table.where('startedAt').above(now - 3_600_000).filter(row => row.lane === 'background' && row.remote !== false).toArray();
      if (recent.length >= 20) throw new TaskCapacityError('budget', Math.min(...recent.map(row => row.startedAt)) + 3_600_000);
    }
    await table.add({ id, ...target, taskId: context.taskId, rootId: context.rootId, role: context.role,
      lane: context.lane, status: 'running', startedAt: now, deadlineAt: context.deadlineAt,
      leaseUntil: context.deadlineAt, owner: context.taskId, epoch: context.epoch, memoryGeneration: context.memoryGeneration,
      sourceRefs: [...(context.inputSources || []), ...(context.consultedSources || [])].map(({ kind, id, version, relation }) => ({ kind, id, version, ...(relation ? { relation } : {}) })) });
  });
  return id;
}

export async function finishTaskRequest(id: string, status: 'succeeded' | 'failed' | 'cancelled', errorKind?: string): Promise<void> {
  const table = db.table('runtimeRequestAttempts');
  await db.transaction('rw', table, async () => {
    const row = await table.get(id);
    if (row?.status === 'running') await table.update(id, { status, errorKind, finishedAt: Date.now() });
  });
}
