import type { Table } from 'dexie';
import { db } from './db';
import { getDataRestoreVersion, isDataRestoreBlocked } from './dataRestoreGate';
import { getMemoryGeneration, assertMemoryAvailable, assertMemoryGenerationCurrent } from './memoryMaintenanceGate';
import { assertTaskModelRevisionsCurrent, type TaskContext } from './taskRuntime';
import { assertSourceRefsCurrent } from './artifactIndexService';
import type { EvidenceRef } from './runtimeEntities';

export const RESPONSE_EFFECT_PREFIX = 'kumiko_response_effect_v1:';
export interface ResponseEffectReceipt {
  eventId: string; effect: string; epoch: string; committedAt: number; signature?: string;
}
export async function responsePayloadSignature(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}
export const isResponseEffectReceipt = (value: unknown): value is ResponseEffectReceipt => {
  const row = value as ResponseEffectReceipt | null;
  return !!row && typeof row === 'object' && typeof row.eventId === 'string' && !!row.eventId
    && typeof row.effect === 'string' && !!row.effect && typeof row.epoch === 'string' && !!row.epoch
    && typeof row.committedAt === 'number' && Number.isFinite(row.committedAt)
    && (row.signature === undefined || (typeof row.signature === 'string' && /^[a-f0-9]{64}$/.test(row.signature)));
};
export interface ResponseEffectGuard {
  epoch: string;
  eventId: string;
  sourceRefs?: Array<{ kind: 'message'; id: string; version: string; relation: 'basis' }>;
  modelRevisions?: Record<string, string>;
  consultedSources?: EvidenceRef[];
  isActive(): boolean;
  check(): Promise<void>;
}

/** Capture a reply lifetime, not the lifetime of already committed facts or
 * actions. A restore that begins and finishes between two awaits still changes
 * version, including in the window that performed the restore itself. */
export async function createResponseEffectGuard(input: {
  eventId: string;
  isCancelled(): boolean;
  sources: Array<{ id: string; text: string; timestamp: number; imageId?: string }>;
  versionedSources?: Array<{ id: string; contentRevision?: string }>;
  expectedMemoryGeneration?: string;
  expectedRestoreVersion?: string;
}): Promise<ResponseEffectGuard> {
  const version = getDataRestoreVersion();
  const memoryGeneration = input.expectedMemoryGeneration ?? getMemoryGeneration();
  if (input.expectedRestoreVersion !== undefined && version !== input.expectedRestoreVersion) throw new Error('Reply data restored');
  const isActive = () => {
    try { assertMemoryAvailable(memoryGeneration); return !input.isCancelled() && !isDataRestoreBlocked() && getDataRestoreVersion() === version; }
    catch { return false; }
  };
  if (!isActive()) throw new Error('Reply cancelled or data restored');
  const epoch = (await db.keyval.get('kumiko_turn_epoch_v1'))?.value ?? 'initial';
  const revisions = new Map<string, string | undefined>();
  const provenanceVersions = new Map<string, string>();
  for (const source of input.sources) {
    const current = await db.messages.get(source.id);
    if (!current || current.role !== 'user' || current.text !== source.text || current.timestamp !== source.timestamp
      || (current.imageId || '') !== (source.imageId || '')) throw new Error('Reply source changed or was removed');
    revisions.set(source.id, current.contentRevision);
    provenanceVersions.set(source.id, current.contentRevision ?? current.sourceRevision ?? 'legacy');
  }
  const guard: ResponseEffectGuard = {
    epoch, eventId: input.eventId, sourceRefs: input.sources.map(source => ({ kind: 'message', id: source.id, version: provenanceVersions.get(source.id) ?? 'legacy', relation: 'basis' })), isActive,
    async check() {
      if (!isActive()) throw new Error('Reply cancelled or data restored');
      await assertMemoryGenerationCurrent(memoryGeneration);
      if (guard.modelRevisions) await assertTaskModelRevisionsCurrent({ modelRevisions: guard.modelRevisions } as TaskContext);
      if (guard.consultedSources?.length) await assertSourceRefsCurrent(guard.consultedSources);
      if (((await db.keyval.get('kumiko_turn_epoch_v1'))?.value ?? 'initial') !== epoch) throw new Error('Reply data epoch changed');
      for (const source of input.sources) {
        const current = await db.messages.get(source.id);
        if (!current || current.role !== 'user' || current.text !== source.text || current.timestamp !== source.timestamp
          || (current.imageId || '') !== (source.imageId || '') || current.contentRevision !== revisions.get(source.id)) throw new Error('Reply source changed or was removed');
      }
      for (const source of input.versionedSources ?? []) {
        const current = await db.messages.get(source.id);
        if (!current || (current.contentRevision ?? current.sourceRevision ?? 'legacy') !== source.contentRevision) throw new Error('Reply context source changed or was removed');
      }
      if (!isActive()) throw new Error('Reply cancelled or data restored');
    },
  };
  await guard.check();
  return guard;
}

/** The queued transaction owns both the change and its once-only receipt.
 * Cancellation while waiting for any read/write aborts this candidate; a
 * transaction that has already committed remains a historical event. */
export async function commitResponseEffect<T>(
  guard: ResponseEffectGuard, effect: string, tables: Table[], work: () => Promise<T>, signature?: string,
): Promise<{ committed: boolean; value?: T }> {
  return db.transaction('rw', [db.keyval, db.messages, db.kumikoDiary, db.dailyFragments, db.memoryDependencies, db.memoryCorrections, ...tables], async () => {
    await guard.check();
    const key = RESPONSE_EFFECT_PREFIX + JSON.stringify([guard.eventId, effect]);
    const previous = (await db.keyval.get(key))?.value;
    if (previous) {
      if (signature && previous.signature && signature !== previous.signature) throw new Error('Response effect identity reused with different payload');
      return { committed: false };
    }
    const value = await work();
    await guard.check();
    const receipt: ResponseEffectReceipt = { eventId: guard.eventId, effect, epoch: guard.epoch, committedAt: Date.now(), signature };
    await db.keyval.put({ key, value: receipt });
    if (!guard.isActive()) throw new Error('Reply cancelled before commit');
    return { committed: true, value };
  });
}
