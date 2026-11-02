import { isDataRestoreBlocked } from './dataRestoreGate';
import { reconcileDiaryIndexJobs, runDiaryIndexJob } from './diaryIndexJobs';
import { reconcileLocationResolutionJob, runLocationResolutionJob } from './locationResolutionJobs';
import { archiveCompletedTurns, TURN_ARCHIVE_STATUS_KEY } from './executionArchive';
import { db } from './db';
import { getMemoryGeneration, isMemoryMaintenanceBlocked } from './memoryMaintenanceGate';
import { runDailyDiaryJob } from './diaryGenerationJobs';
import { runSummaryMaintenance } from './summaryJobs';
import { reconcileArtifactJobs } from './artifactIndexService';
import { assertBackgroundJobClaim, claimBackgroundJob, enqueueBackgroundJob, finishBackgroundJob } from './backgroundJobs';

/** One app-owned timer; both kinds share the persistent claim/retry budget.
 * Closing the UI stops polling, not the saved obligations. */
export function startBackgroundMaintenance(): () => void {
  let stopped = false;
  let busy = false;
  let nextArchiveAt = Date.now() + 30_000;
  let nextKind = 0;
  const owner = crypto.randomUUID();
  const tick = async () => {
    if (stopped || busy || isDataRestoreBlocked() || isMemoryMaintenanceBlocked()) return;
    busy = true;
    try {
      // A single failed subsystem must not suppress all other pending work.
      const location = async () => { try {
        await reconcileLocationResolutionJob();
        if (!stopped && !isMemoryMaintenanceBlocked()) await runLocationResolutionJob(owner);
      } catch { console.warn('[Background] Location resolution remains pending.'); } };
      const diary = async () => { try {
        await reconcileDiaryIndexJobs();
        if (!stopped && !isMemoryMaintenanceBlocked()) await runDiaryIndexJob(owner);
      } catch { console.warn('[Background] Diary indexing remains pending.'); } };
      const generation = async () => { try { await runDailyDiaryJob(owner); }
        catch { console.warn('[Background] Diary generation remains pending.'); } };
      const summary = async () => { try { await reconcileArtifactJobs(); await runSummaryMaintenance(owner); }
        catch { console.warn('[Background] Memory summary remains pending.'); } };
      const kinds = [location, diary, generation, summary];
      const ordered = [...kinds.slice(nextKind), ...kinds.slice(0, nextKind)];
      nextKind = (nextKind + 1) % kinds.length;
      for (const run of ordered) {
        if (stopped || isDataRestoreBlocked() || isMemoryMaintenanceBlocked()) break;
        await run();
      }
      if (!stopped && !isDataRestoreBlocked() && !isMemoryMaintenanceBlocked() && Date.now() >= nextArchiveAt) {
        nextArchiveAt = Date.now() + 10 * 60_000;
        try {
          const slot = String(Math.floor(Date.now() / (10 * 60_000)));
          await enqueueBackgroundJob({ id: `execution-archive:${slot}:g:${getMemoryGeneration()}`, kind: 'execution-archive', sourceId: 'execution-archive', sourceVersion: slot });
        }
        catch (error) {
          console.warn('[Execution archive] deferred maintenance failed', error);
          if (!isDataRestoreBlocked()) await db.setVal(TURN_ARCHIVE_STATUS_KEY,
            { error: String(error).slice(0, 200), at: Date.now() }).catch(() => {});
        }
      }
      if (!stopped && !isDataRestoreBlocked() && !isMemoryMaintenanceBlocked()) {
        const claim = await claimBackgroundJob('execution-archive', owner);
        if (claim) {
          try {
            await archiveCompletedTurns(20, Date.now(), async () => { await assertBackgroundJobClaim(claim); });
            await finishBackgroundJob(claim, 'completed');
          } catch (error) {
            try { await finishBackgroundJob(claim, 'retrying', error); } catch { /* An expired or restored claim is no longer ours. */ }
          }
        }
      }
    } finally { busy = false; }
  };
  void tick();
  const interval = setInterval(() => { void tick(); }, 15_000);
  return () => { stopped = true; clearInterval(interval); };
}
