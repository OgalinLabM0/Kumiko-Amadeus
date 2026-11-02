import { db } from './db';
import { getDataRestoreVersion, isDataRestoreBlocked } from './dataRestoreGate';
import { assertBackgroundJobClaim, claimBackgroundJob, deferBackgroundJob, enqueueBackgroundJob, finishBackgroundJob } from './backgroundJobs';
import { getUserKnownLocation, resolveKnownUserLocation, type UserKnownLocation } from './userKnownLocation';
import { getMemoryGeneration } from './memoryMaintenanceGate';

const KIND = 'disclosed-location-resolution';
// A resolved coordinate is derived data. The user's disclosure and clarification
// remain authoritative, including when the public geocoder is offline.
function sourceVersion(known: UserKnownLocation): string {
  return JSON.stringify([known.sourceMessage.id, known.revision || 0, known.updatedAt,
    known.clarification?.sourceMessage.id || null]);
}

export async function reconcileLocationResolutionJob(): Promise<void> {
  if (isDataRestoreBlocked()) return;
  const generation = getDataRestoreVersion();
  const known = await getUserKnownLocation();
  if (!known || known.status !== 'unresolved') return;
  const version = sourceVersion(known);
  await db.transaction('rw', [db.keyval, db.table('runtimeJobs')], async () => {
    const current = await getUserKnownLocation();
    if (isDataRestoreBlocked() || generation !== getDataRestoreVersion() || !current
      || current.status !== 'unresolved' || sourceVersion(current) !== version) return;
    const memoryGeneration = getMemoryGeneration();
    await enqueueBackgroundJob({ id: `location:${version}${memoryGeneration === 'initial' ? '' : `:g:${memoryGeneration}`}`, kind: KIND,
      sourceId: known.sourceMessage.id, sourceVersion: version });
  });
}

export async function runLocationResolutionJob(owner: string): Promise<boolean> {
  if (isDataRestoreBlocked()) return false;
  const claim = await claimBackgroundJob(KIND, owner);
  if (!claim) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    await assertBackgroundJobClaim(claim);
    const known = await getUserKnownLocation();
    if (!known || sourceVersion(known) !== claim.job.sourceVersion) {
      await finishBackgroundJob(claim, 'superseded'); return true;
    }
    if (known.status === 'unresolved') await resolveKnownUserLocation(controller.signal, {
      taskId: claim.job.id, rootId: claim.job.id, role: 'location-resolution', lane: 'background',
      deadlineAt: claim.job.deadlineAt!, signal: controller.signal, epoch: claim.restoreVersion,
      memoryGeneration: claim.job.memoryGeneration ?? 'initial',
    }, async () => { await assertBackgroundJobClaim(claim); });
    await db.transaction('rw', [db.keyval, db.table('runtimeJobs')], async () => {
      await assertBackgroundJobClaim(claim);
      const current = await getUserKnownLocation();
      if (!current || sourceVersion(current) !== claim.job.sourceVersion) {
        await finishBackgroundJob(claim, 'superseded');
      } else if (current.status === 'unresolved') {
        await finishBackgroundJob(claim, 'retrying', 'Disclosed place is not resolved yet. The original disclosure is retained.');
      } else {
        // Ambiguity needs a user clarification; repeating a successful query
        // cannot decide which same-named town the user meant.
        await finishBackgroundJob(claim, 'completed');
      }
    });
  } catch (error) {
    try {
      const capacity = error as { kind?: string; nextEligibleAt?: number };
      if (capacity?.kind === 'budget' || capacity?.kind === 'busy' || capacity?.kind === 'paused') {
        await deferBackgroundJob(claim, capacity.nextEligibleAt ?? Date.now() + 15_000);
      } else await finishBackgroundJob(claim, 'retrying', 'Location resolution could not complete; it will be retried within the background budget.');
    }
    catch { /* A reset/restored dataset or expired claim owns the next decision. */ }
  } finally { clearTimeout(timer); }
  return true;
}
