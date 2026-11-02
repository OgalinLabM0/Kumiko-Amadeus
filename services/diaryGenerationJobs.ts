import { db } from './db';
import { isDataRestoreBlocked } from './dataRestoreGate';
import { getMemoryGeneration } from './memoryMaintenanceGate';
import { assertBackgroundJobClaim, claimBackgroundJob, checkpointBackgroundJob, deferBackgroundJob,
  enqueueBackgroundJob, finishBackgroundJob, parkBackgroundJob, renewBackgroundJobClaim } from './backgroundJobs';
import type { DiaryGenerationSnapshot } from './lifeStreamService';

const KIND = 'diary-generate';
type Inputs = Omit<DiaryGenerationSnapshot, 'weather' | 'isHoliday' | 'afterContext'>;
const sorted = <T extends { id: string }>(rows: T[]): T[] => rows.sort((a, b) => a.id.localeCompare(b.id));

async function readInputs(date: string): Promise<Inputs> {
  const start = Date.parse(`${date}T00:00:00+09:00`);
  if (!Number.isFinite(start)) throw new Error('Invalid diary date.');
  const [messages, fragments, previous, sameDay, next, worldStatusRow] = await Promise.all([
    db.messages.where('timestamp').between(start, start + 86_400_000, true, false).toArray(),
    db.dailyFragments.where('date').equals(date).toArray(), db.kumikoDiary.where('date').below(date).reverse().limit(7).toArray(),
    db.kumikoDiary.where('date').equals(date).toArray(), db.kumikoDiary.where('date').above(date).first(), db.keyval.get('world_character_status'),
  ]);
  const recentDiaries = [...previous, ...sameDay, ...(next ? [next] : [])];
  return { messages: sorted(messages), fragments: sorted(fragments), recentDiaries: sorted(recentDiaries), worldStatusRow };
}

function inputsOf(snapshot: DiaryGenerationSnapshot): Inputs {
  return { messages: snapshot.messages, fragments: snapshot.fragments, recentDiaries: snapshot.recentDiaries,
    worldStatusRow: snapshot.worldStatusRow };
}

export async function enqueueDailyDiary(date: string, options: { weather?: string; isHoliday?: boolean; afterContext?: string } = {}): Promise<void> {
  if (isDataRestoreBlocked()) return;
  const inputs = await db.transaction('r', [db.messages, db.dailyFragments, db.kumikoDiary, db.keyval], () => readInputs(date));
  if (inputs.recentDiaries.some(row => row.date === date)) return;
  const snapshot: DiaryGenerationSnapshot = { ...inputs, ...options };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(snapshot)));
  const version = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  await db.transaction('rw', [db.messages, db.dailyFragments, db.kumikoDiary, db.keyval, db.table('runtimeJobs')], async () => {
    if (JSON.stringify(await readInputs(date)) !== JSON.stringify(inputs)) throw new Error('Diary source changed during enqueue.');
    const generation = getMemoryGeneration();
    await enqueueBackgroundJob({ id: `diary-generation:${date}:${version}${generation === 'initial' ? '' : `:g:${generation}`}`, kind: KIND, sourceId: date, sourceVersion: version, payload: snapshot });
  });
}

export async function runDailyDiaryJob(owner: string): Promise<boolean> {
  if (isDataRestoreBlocked()) return false;
  const claim = await claimBackgroundJob(KIND, owner);
  if (!claim) return false;
  let snapshot = claim.job.payload as DiaryGenerationSnapshot;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, claim.job.deadlineAt! - Date.now()));
  let renewalBusy = false;
  const renewal = setInterval(() => {
    if (renewalBusy) return;
    renewalBusy = true;
    void renewBackgroundJobClaim(claim).catch(() => controller.abort()).finally(() => { renewalBusy = false; });
  }, 20_000);
  const assertClaim = async () => { if (controller.signal.aborted) throw new Error('Diary task cancelled.'); await assertBackgroundJobClaim(claim); };
  const assertCurrent = async () => {
    await assertClaim();
    if (JSON.stringify(await readInputs(claim.job.sourceId)) !== JSON.stringify(inputsOf(snapshot))) throw new Error('Diary input snapshot changed.');
  };
  try {
    await db.transaction('r', [db.keyval, db.messages, db.dailyFragments, db.kumikoDiary, db.table('runtimeJobs')], assertCurrent);
    const taskContext = { taskId: claim.job.id, rootId: claim.job.id, role: 'diary', lane: 'background' as const,
      deadlineAt: claim.job.deadlineAt!, signal: controller.signal, epoch: claim.restoreVersion,
      memoryGeneration: claim.job.memoryGeneration ?? getMemoryGeneration(), modelRevisions: {}, consultedSources: [] };
    let checkpoint = (claim.job.checkpoint || {}) as { weatherResolved?: boolean; weather?: string; holidayResolved?: boolean; isHoliday?: boolean; draft?: unknown };
    if (!snapshot.weather && !checkpoint.weatherResolved) {
      const { fetchHistoricalWeatherDirect } = await import('./ambientWeatherDirect');
      const weather = await fetchHistoricalWeatherDirect(claim.job.sourceId, taskContext);
      checkpoint = { ...checkpoint, weatherResolved: true, weather: weather.success ? weather.weather : undefined };
      await checkpointBackgroundJob(claim, checkpoint);
    }
    if (!snapshot.weather && checkpoint.weatherResolved) snapshot = { ...snapshot, weather: checkpoint.weather };
    if (snapshot.isHoliday === undefined && !checkpoint.holidayResolved) {
      const { fetchJapanHolidaysDirect } = await import('./ambientWeatherDirect');
      const calendar = await fetchJapanHolidaysDirect(taskContext);
      checkpoint = { ...checkpoint, holidayResolved: true,
        isHoliday: calendar.success && calendar.holidays ? Boolean(calendar.holidays[claim.job.sourceId]) : undefined };
      await checkpointBackgroundJob(claim, checkpoint);
    }
    if (snapshot.isHoliday === undefined && checkpoint.holidayResolved) snapshot = { ...snapshot, isHoliday: checkpoint.isHoliday };
    const { generateDailyDiary } = await import('./lifeStreamService');
    const diary = await generateDailyDiary(claim.job.sourceId, snapshot.messages, snapshot.afterContext, snapshot.weather, snapshot.isHoliday,
      false, undefined, { snapshot, assertCurrent, assertClaim, complete: async () => finishBackgroundJob(claim, 'completed'),
        saveDraft: async draft => checkpointBackgroundJob(claim, { ...checkpoint, draft }), taskContext });
    if (!diary) await parkBackgroundJob(claim, 'Diary draft needs review before it can be saved.');
  } catch (error) {
    try {
      const capacity = error as { kind?: string; nextEligibleAt?: number; message?: string };
      if (['paused', 'budget', 'busy'].includes(capacity?.kind || '')) await deferBackgroundJob(claim, capacity.nextEligibleAt ?? Date.now() + 15_000);
      else if (capacity?.message?.includes('input snapshot changed')) await finishBackgroundJob(claim, 'superseded');
      else await finishBackgroundJob(claim, 'retrying', error);
    } catch { /* Restore, cancellation or expiry owns the next decision. */ }
  } finally { clearTimeout(timer); clearInterval(renewal); }
  return true;
}
