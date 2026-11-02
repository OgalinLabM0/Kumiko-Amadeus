import { db } from './db';
import { useAppStore } from '../store';
import { getDataRestoreVersion, isDataRestoreBlocked } from './dataRestoreGate';
import { getMemoryGeneration } from './memoryMaintenanceGate';
import { assertBackgroundJobClaim, claimBackgroundJob, checkpointBackgroundJob, deferBackgroundJob,
  enqueueBackgroundJob, finishBackgroundJob, parkBackgroundJob, renewBackgroundJobClaim } from './backgroundJobs';
import { summarizeConversation } from './conversationSummarizer';
import { saveIndexedArtifact, assertSourceRefsCurrent } from './artifactIndexService';
import { SUMMARY_ARCHIVE_STATE_STORAGE_KEY } from '../components/app/appConstants';
import { appendRecentSummarySegment, buildSummarySegmentId, buildRecentSummaryBuffer,
  getSummaryContinuationCarryoverState, getSummarySegmentMessages, normalizeSummaryArchiveState } from '../components/app/summaryCycle';
import type { TriggerAutoSummaryParams } from '../components/app/summaryActions';
import type { Message, PendingSummaryArchive, SummarySegmentMetadata } from '../types';
import type { EvidenceRef } from './runtimeEntities';
import { assertTaskModelRevisionsCurrent, type TaskContext } from './taskRuntime';

const GENERATE = 'summary-generate', INDEX = 'summary-index';
type Snapshot = { params: TriggerAutoSummaryParams; messages: Message[]; refs: EvidenceRef[];
  notebook: string; location: ReturnType<typeof useAppStore.getState>['locationConfig']; language: 'zh' | 'en';
  archiveRow: unknown; memoryRow: unknown; notebookRow: unknown; createdAt: number };
type Generated = { summaryText: string; notebook: string; chunks: string[]; timeRangeStr: string; modelRevisions?: Record<string, string>; consultedSources?: EvidenceRef[] };
// The summarizer reads only these fields. Never persist transient image data.
const ordered = (messages: Message[]): Message[] => messages.map(({ id, role, text, timestamp, isVoiceMessage, isHidden }) =>
  ({ id, role, text, timestamp, isVoiceMessage, isHidden }));
const digest = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(JSON.stringify(value)))), b => b.toString(16).padStart(2, '0')).join('');
const tables = () => [db.keyval, db.messages, db.kumikoDiary, db.dailyFragments, db.runtimeJobs, db.memoryDependencies, db.memoryCorrections];

async function sourceRows(messages: Message[]): Promise<EvidenceRef[]> {
  const refs: EvidenceRef[] = [];
  for (const message of messages) {
    const row = await db.messages.get(message.id);
    if (!row || row.role !== message.role || row.text !== message.text || row.timestamp !== message.timestamp)
      throw new Error('Summary source changed before enqueue.');
    refs.push({ kind: 'message', id: row.id, version: row.contentRevision ?? row.sourceRevision ?? 'legacy', relation: 'basis' });
  }
  return refs;
}

async function assertSnapshot(snapshot: Snapshot): Promise<void> {
  await assertSourceRefsCurrent(snapshot.refs);
  const [archiveRow, memoryRow, notebookRow] = await Promise.all([
    db.keyval.get(SUMMARY_ARCHIVE_STATE_STORAGE_KEY), db.keyval.get('kumiko_core_memory'), db.keyval.get('kumiko_notebook'),
  ]);
  if (JSON.stringify([archiveRow, memoryRow, notebookRow]) !== JSON.stringify([snapshot.archiveRow, snapshot.memoryRow, snapshot.notebookRow]))
    throw new Error('Summary source changed.');
}

export async function enqueueSummaryJob(messages: Message[], params: TriggerAutoSummaryParams): Promise<void> {
  const segment = ordered(getSummarySegmentMessages(messages, params.archiveState, params.endBeforeMessageId ?? null));
  if (!segment.length) return;
  const state = useAppStore.getState();
  const snapshot = await db.transaction('r', tables(), async (): Promise<Snapshot> => ({ params: { ...params, retryCount: 0 }, messages: segment,
    refs: await sourceRows(segment), notebook: state.kumikoNotebook, location: state.locationConfig, language: state.language,
    archiveRow: await db.keyval.get(SUMMARY_ARCHIVE_STATE_STORAGE_KEY), memoryRow: await db.keyval.get('kumiko_core_memory'),
    notebookRow: await db.keyval.get('kumiko_notebook'), createdAt: Date.now() }));
  const archiveValue = (snapshot.archiveRow as { value?: unknown } | undefined)?.value;
  const memoryValue = (snapshot.memoryRow as { value?: unknown } | undefined)?.value;
  const notebookValue = (snapshot.notebookRow as { value?: unknown } | undefined)?.value;
  if ((archiveValue !== undefined && JSON.stringify(archiveValue) !== JSON.stringify(params.archiveState))
    || (memoryValue !== undefined && memoryValue !== params.currentMemory)
    || (notebookValue !== undefined && notebookValue !== snapshot.notebook)) {
    throw new Error('Summary state is still being saved.');
  }
  const sourceVersion = await digest({ refs: snapshot.refs, archiveRow: snapshot.archiveRow, memoryRow: snapshot.memoryRow, notebookRow: snapshot.notebookRow });
  const sourceId = params.archiveState.activeSegmentId || segment[0].id;
  await db.transaction('rw', tables(), async () => {
    await assertSnapshot(snapshot);
    const generation = getMemoryGeneration();
    await enqueueBackgroundJob({ id: `summary-generation:${sourceId}:${sourceVersion}${generation === 'initial' ? '' : `:g:${generation}`}`, kind: GENERATE, sourceId, sourceVersion, payload: snapshot });
  });
}

function title(chunks: string[], messages: Message[], summary: string, language: 'zh' | 'en'): string {
  for (const raw of [...chunks, ...messages.filter(m => m.role === 'user' && !m.isHidden).map(m => m.text), summary]) {
    const text = raw.replace(/\[[^\]]+\]/g, ' ').replace(/^【[^】]+】/u, '').replace(/^[\s\-:：]+/u, '').replace(/\s+/g, ' ').trim();
    if (text) return text.length > 28 ? `${text.slice(0, 28).trim()}…` : text;
  }
  return language === 'zh' ? '近期片段' : 'Recent Segment';
}

function summaryTimeRange(messages: Message[], createdAt: number): string {
  const format = (timestamp: number) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(timestamp));
    return Object.fromEntries(parts.map(part => [part.type, part.value]));
  };
  const start = format(messages[0].timestamp), end = format(Math.max(messages.at(-1)!.timestamp, createdAt));
  return start.year === end.year && start.month === end.month && start.day === end.day
    ? `${start.year}/${start.month}/${start.day} ${start.hour}:${start.minute} - ${end.hour}:${end.minute} (JST)`
    : `${start.year}/${start.month}/${start.day} ${start.hour}:${start.minute} - ${end.year}/${end.month}/${end.day} ${end.hour}:${end.minute} (JST)`;
}

async function runGeneration(owner: string): Promise<boolean> {
  const claim = await claimBackgroundJob(GENERATE, owner); if (!claim) return false;
  const snapshot = claim.job.payload as Snapshot;
  const controller = new AbortController();
  const context: TaskContext = { taskId: claim.job.id, rootId: claim.job.id, role: 'memory', lane: 'background', deadlineAt: claim.job.deadlineAt!,
    signal: controller.signal, epoch: claim.restoreVersion, memoryGeneration: claim.job.memoryGeneration ?? getMemoryGeneration(),
    modelRevisions: {}, consultedSources: [] };
  const timeout = setTimeout(() => controller.abort(), Math.max(1, claim.job.deadlineAt! - Date.now()));
  const renewal = setInterval(() => { void renewBackgroundJobClaim(claim).catch(() => controller.abort()); }, 20_000);
  const check = async () => { if (controller.signal.aborted) throw new Error('Summary task cancelled.'); await assertBackgroundJobClaim(claim);
    await assertSnapshot(snapshot); await assertTaskModelRevisionsCurrent(context); await assertSourceRefsCurrent(context.consultedSources || []); };
  try {
    await db.transaction('r', tables(), check);
    let generated = claim.job.checkpoint as Generated | undefined;
    if (generated) { context.modelRevisions = generated.modelRevisions || {}; context.consultedSources = generated.consultedSources || []; }
    const pending = snapshot.params.archiveState.pendingArchive as PendingSummaryArchive | null | undefined;
    if (!generated && pending?.segmentEndMessageId && snapshot.messages.some(m => m.id === pending.segmentEndMessageId)) {
      generated = { summaryText: pending.summaryText, notebook: pending.notebook, chunks: pending.chunks, timeRangeStr: pending.timeRangeStr };
      await checkpointBackgroundJob(claim, generated);
    }
    if (!generated) {
      const timeRangeStr = summaryTimeRange(snapshot.messages, snapshot.createdAt);
      const result = await summarizeConversation(snapshot.messages, snapshot.params.currentMemory, timeRangeStr, snapshot.notebook,
        snapshot.location, snapshot.language, { reason: snapshot.params.reason, isComplete: snapshot.params.isComplete,
          isContinuation: snapshot.params.isContinuation, turnsInSegment: snapshot.params.turnsInSegment },
        context);
      generated = { summaryText: result.diary, notebook: result.notebook,
        chunks: Array.from(new Set(result.chunks.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()))), timeRangeStr,
        modelRevisions: { ...context.modelRevisions }, consultedSources: [...(context.consultedSources || [])] };
      await checkpointBackgroundJob(claim, generated);
    }
    const output = generated;
    const { params, messages } = snapshot;
    const allRefs = [...snapshot.refs];
    for (const ref of context.consultedSources || []) if (!allRefs.some(item => item.kind === ref.kind && item.id === ref.id && item.version === ref.version)) allRefs.push(ref);
    const meta: SummarySegmentMetadata = { segmentId: buildSummarySegmentId(messages[0].timestamp, messages[0].id, snapshot.createdAt),
      segmentStartTime: messages[0].timestamp, segmentEndTime: messages.at(-1)!.timestamp, summaryCompletedTime: snapshot.createdAt,
      isComplete: params.isComplete, topicLabel: title(output.chunks, messages, output.summaryText, snapshot.language), summaryText: output.summaryText };
    const recent = appendRecentSummarySegment(params.archiveState, meta);
    const buffer = buildRecentSummaryBuffer(recent, output.summaryText);
    const carry = params.reason === 'hard_limit' ? getSummaryContinuationCarryoverState(messages)
      : { carryoverStartMessageId: null, carryoverEndMessageId: null };
    const committed = normalizeSummaryArchiveState({ segmentStartTurn: params.nextSegmentStartTurn,
      segmentStartMessageId: params.nextSegmentStartMessageId,
      activeSegmentId: buildSummarySegmentId(messages.at(-1)!.timestamp, params.nextSegmentStartMessageId, snapshot.createdAt),
      ...carry, pendingSinceTurn: null, lastBoundaryReason: params.reason, lastBoundaryAt: snapshot.createdAt,
      recentSummarySegments: recent, pendingArchive: null }, params.nextSegmentStartTurn);
    await db.transaction('rw', tables(), async () => {
      await check();
      await db.keyval.put({ key: 'kumiko_core_memory', value: buffer });
      await db.keyval.put({ key: 'kumiko_notebook', value: output.notebook });
      await db.keyval.put({ key: SUMMARY_ARCHIVE_STATE_STORAGE_KEY, value: committed, sourceRevision: crypto.randomUUID() });
      for (const artifactId of ['kumiko_core_memory', 'kumiko_notebook', SUMMARY_ARCHIVE_STATE_STORAGE_KEY]) {
        const row = await db.keyval.get(artifactId);
        if (!row?.sourceRevision) throw new Error('Summary asset revision was not saved.');
        const prior = (await db.keyval.get(`kumiko_memory_asset_v1:${artifactId}`))?.value as { sourceRefs?: EvidenceRef[] } | undefined;
        const refs = [...(prior?.sourceRefs || [])];
        for (const ref of allRefs) if (!refs.some(item => item.kind === ref.kind && item.id === ref.id && item.version === ref.version)) refs.push(ref);
        if (refs.length > 10000 || JSON.stringify(refs).length > 1_800_000) throw new Error('Summary source record exceeds the safe backup limit.');
        await assertSourceRefsCurrent(refs);
        await db.keyval.put({ key: `kumiko_memory_asset_v1:${artifactId}`, value: { artifactId, sourceRevision: row.sourceRevision,
          memoryGeneration: claim.job.memoryGeneration ?? getMemoryGeneration(), sourceRefs: refs } });
        for (const [i, ref] of allRefs.entries()) {
          await db.memoryDependencies.put({ id: `${artifactId}:${claim.job.sourceVersion}:${i}`, artifactId,
            artifactKind: 'keyval', artifactVersion: claim.job.sourceVersion, sourceKind: ref.kind, sourceId: ref.id,
            sourceVersion: ref.version, relation: ref.relation || 'basis', createdAt: Date.now() });
        }
      }
      // A legacy pending archive may already have acknowledged some chunks.
      // Keep those receipts; re-indexing them under a new ID would duplicate memory.
      const chunksToIndex = output.chunks.map(chunk => `【MEMORY CHUNK (${output.timeRangeStr})】\n${chunk}`)
        .filter(chunk => !pending?.savedChunkPayloads?.includes(chunk));
      if (chunksToIndex.length) await enqueueBackgroundJob({ id: `summary-index:${claim.job.sourceId}:${claim.job.sourceVersion}${claim.job.memoryGeneration === 'initial' ? '' : `:g:${claim.job.memoryGeneration}`}`,
        kind: INDEX, sourceId: claim.job.sourceId, sourceVersion: claim.job.sourceVersion,
        payload: { chunks: chunksToIndex, refs: allRefs } });
      await finishBackgroundJob(claim, 'completed');
    });
    const state = useAppStore.getState();
    if (JSON.stringify(state.summaryArchiveState) === JSON.stringify(params.archiveState)) {
      state.setCoreMemory(buffer); state.setKumikoNotebook(output.notebook); state.setSummaryArchiveState(committed);
    }
  } catch (error) {
    try { const e = error as { kind?: string; nextEligibleAt?: number; message?: string };
      if (['paused','budget','busy'].includes(e?.kind || '')) await deferBackgroundJob(claim, e.nextEligibleAt ?? Date.now() + 15_000);
      else if (/source.*(changed|corrected)|configuration changed/i.test(e?.message || '')) await finishBackgroundJob(claim, 'superseded');
      else await finishBackgroundJob(claim, 'retrying', error);
    } catch { /* Restore or expiration revoked the claim. */ }
  } finally { clearTimeout(timeout); clearInterval(renewal); }
  return true;
}

async function runIndex(owner: string): Promise<boolean> {
  if (useAppStore.getState().backupConfig.ragEnabled) {
    await db.transaction('rw', [db.keyval, db.runtimeJobs], async () => {
      for (const job of await db.runtimeJobs.where('kind').equals(INDEX).toArray()) if (job.status === 'deferred' && job.error === 'RAG disabled')
        await db.runtimeJobs.put({ ...job, status: 'pending', retryAt: Date.now(), updatedAt: Date.now() });
    });
  }
  const claim = await claimBackgroundJob(INDEX, owner); if (!claim) return false;
  if (!useAppStore.getState().backupConfig.ragEnabled) { await parkBackgroundJob(claim, 'RAG disabled', false); return true; }
  const payload = claim.job.payload as { chunks: string[]; refs: EvidenceRef[]; artifactId?: string };
  try {
    await saveIndexedArtifact({ artifactId: payload.artifactId || claim.job.id, sourceVersion: claim.job.sourceVersion, kind: 'summary',
      textChunks: payload.chunks, sourceRefs: payload.refs, epoch: claim.restoreVersion,
      memoryGeneration: claim.job.memoryGeneration ?? getMemoryGeneration(), claimToken: claim.job.token!, leaseUntil: claim.job.leaseUntil!, jobId: claim.job.id,
      taskContext: { taskId: claim.job.id, rootId: claim.job.id, role: 'memory-index', lane: 'background', deadlineAt: claim.job.deadlineAt!,
        epoch: claim.restoreVersion, memoryGeneration: claim.job.memoryGeneration ?? getMemoryGeneration() } });
    await finishBackgroundJob(claim, 'completed');
  } catch (error) {
    try { const e = error as { kind?: string; nextEligibleAt?: number; message?: string };
      if (['paused','budget','busy'].includes(e?.kind || '')) await deferBackgroundJob(claim, e.nextEligibleAt ?? Date.now() + 15_000);
      else if (/source.*(changed|corrected)|configuration changed/i.test(e?.message || '')) await finishBackgroundJob(claim, 'superseded');
      else await finishBackgroundJob(claim, 'retrying', error);
    } catch { /* Expired or restored jobs cannot commit a receipt. */ }
  }
  return true;
}

export async function runSummaryMaintenance(owner: string): Promise<void> {
  if (isDataRestoreBlocked()) return;
  await runGeneration(owner);
  await runIndex(owner);
}
