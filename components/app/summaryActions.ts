import React from 'react';
import { useAppStore } from '../../store';
import { db } from '../../services/db';
import { SUMMARY_ARCHIVE_STATE_STORAGE_KEY } from './appConstants';
import type {
  Message,
  PendingSummaryArchive,
  SummaryArchiveState,
  SummaryBoundaryReason,
  SummarySegmentMetadata,
} from '../../types';
import { UI_TRANSLATIONS } from '../../constants';
import {
  appendRecentSummarySegment,
  buildSummarySegmentId,
  buildRecentSummaryBuffer,
  getSummaryContinuationCarryoverState,
  getSummarySegmentMessages,
  normalizeSummaryArchiveState,
} from './summaryCycle';
import { syncRawHistoryMessages } from './rawHistorySync';
import { evaluateRagMemoryCandidate } from '../../services/ragMemoryFilter';
import { mapRagDecisionTierToStorageTier } from './ragRecallHelpers';
import { syncTemporalEpisodes } from '../../services/temporalEpisodeService';
import {
  summarizeConversation,
  getCurrentAIConfig,
} from '../../services/geminiService';
import {
  saveLocalRagMemory,
  startLocalRagRebuild,
  subscribeLocalRagRebuild,
  type LocalRagRebuildEvent,
} from '../../services/localRagService';
import {
  isDesktopElectron,
  setDesktopBackgroundThrottling,
  refocusDesktopWebContents,
} from '../../services/desktopBackupService';

// ---------------------------------------------------------------------------
// Dep interfaces
// ---------------------------------------------------------------------------

export interface TriggerAutoSummaryRefs {
  messagesRef: React.MutableRefObject<Message[]>;
  summaryRunningRef: React.MutableRefObject<boolean>;
}

export interface TriggerAutoSummaryHelpers {
  deriveSummaryTopicLabel: (
    chunks: string[],
    segmentMessages: Message[],
    summaryText: string,
  ) => string;
}

export interface TriggerAutoSummaryParams {
  currentCount: number;
  currentMemory: string;
  archiveState: SummaryArchiveState;
  reason: SummaryBoundaryReason;
  isComplete: boolean;
  isContinuation?: boolean;
  turnsInSegment: number;
  endBeforeMessageId?: string | null;
  nextSegmentStartTurn: number;
  nextSegmentStartMessageId: string | null;
  retryCount?: number;
}

const buildPendingArchiveKey = (segmentMessages: Message[]) => {
  const first = segmentMessages[0];
  const last = segmentMessages[segmentMessages.length - 1];
  return `pending-summary-${first?.id || first?.timestamp || 'unknown'}-${last?.id || last?.timestamp || 'unknown'}`;
};

const isPendingArchiveForSegment = (
  pendingArchive: PendingSummaryArchive | null | undefined,
  segmentMessages: Message[],
) => {
  if (!pendingArchive || segmentMessages.length === 0) return false;
  // A hard-limit retry may include a carryover tail that starts before the
  // normal active segment. On restart, a manual retry begins at the normal
  // cursor, so match the original boundary end rather than requiring the
  // carryover message to be present in this fresh slice.
  return !!pendingArchive.segmentEndMessageId
    && segmentMessages.some(message => message.id === pendingArchive.segmentEndMessageId);
};

const persistPendingArchive = (
  state: ReturnType<typeof useAppStore.getState>,
  pendingArchive: PendingSummaryArchive,
  currentCount: number,
) => {
  const previous = useAppStore.getState().summaryArchiveState;
  const nextArchiveState = normalizeSummaryArchiveState({
    ...previous,
    pendingArchive,
  }, Math.max(currentCount, previous.segmentStartTurn));
  return db.setVal(SUMMARY_ARCHIVE_STATE_STORAGE_KEY, nextArchiveState).then(() => {
    state.setSummaryArchiveState(nextArchiveState);
    return nextArchiveState;
  });
};

// ---------------------------------------------------------------------------
// triggerAutoSummary
// ---------------------------------------------------------------------------

export async function triggerAutoSummary(
  refs: TriggerAutoSummaryRefs,
  _helpers: TriggerAutoSummaryHelpers,
  params: TriggerAutoSummaryParams,
) {
  try {
    const { enqueueSummaryJob } = await import('../../services/summaryJobs');
    await enqueueSummaryJob(refs.messagesRef.current, params);
  } catch (error) {
    console.warn('[Summary] Could not queue memory archival:', error);
    const state = useAppStore.getState();
    state.setSystemNotice(state.language === 'zh' ? '记忆整理未能排队，请稍后重试。' : 'Memory archival could not be queued. Please retry.');
  }
}

async function triggerAutoSummaryLegacy(
  refs: TriggerAutoSummaryRefs,
  helpers: TriggerAutoSummaryHelpers,
  params: TriggerAutoSummaryParams,
) {
  const {
    currentCount,
    currentMemory,
    archiveState,
    reason,
    isComplete,
    isContinuation = false,
    turnsInSegment,
    endBeforeMessageId = null,
    nextSegmentStartTurn,
    nextSegmentStartMessageId,
    retryCount = 0,
  } = params;

  const state = useAppStore.getState();
  const backupConfig = state.backupConfig;
  const kumikoNotebook = state.kumikoNotebook;
  const locationConfig = state.locationConfig;
  const language = state.language;

  if (refs.summaryRunningRef.current) {
    console.warn('[AUTO-SUMMARY] Already running, skipping concurrent trigger.');
    return;
  }
  refs.summaryRunningRef.current = true;
  console.log(`[AUTO-SUMMARY] Triggering archive pass at Turn ${currentCount} (${reason})${retryCount > 0 ? ` [retry ${retryCount}]` : ''}...`);

  try {
    const segmentMessages = getSummarySegmentMessages(refs.messagesRef.current, archiveState, endBeforeMessageId);
    if (segmentMessages.length === 0) {
      console.warn('[AUTO-SUMMARY] Segment is empty. Skip archive.');
      return;
    }

    const liveArchiveState = useAppStore.getState().summaryArchiveState;
    if (retryCount > 0 && !liveArchiveState.pendingArchive && (
      liveArchiveState.segmentStartTurn !== archiveState.segmentStartTurn ||
      liveArchiveState.segmentStartMessageId !== archiveState.segmentStartMessageId
    )) {
      console.info('[AUTO-SUMMARY] Discarding stale retry after archive state advanced.');
      return;
    }
    if (retryCount > 0 && liveArchiveState.pendingArchive && !isPendingArchiveForSegment(liveArchiveState.pendingArchive, segmentMessages)) {
      console.info('[AUTO-SUMMARY] Discarding stale retry for a different pending archive.');
      return;
    }

    let pendingArchive = isPendingArchiveForSegment(liveArchiveState.pendingArchive, segmentMessages)
      ? liveArchiveState.pendingArchive!
      : null;

    if (!pendingArchive) {
      const start = segmentMessages[0].timestamp;
      const summaryCompletedAt = Date.now();
      const segmentEndTime = segmentMessages[segmentMessages.length - 1].timestamp;
      const end = Math.max(segmentEndTime, summaryCompletedAt);

      const getJSTParts = (d: Date) => {
        const formatter = new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Tokyo',
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false,
        });
        const parts = formatter.formatToParts(d);
        const p: Record<string, string> = {};
        parts.forEach(part => p[part.type] = part.value);
        return p;
      };

      const s = getJSTParts(new Date(start));
      const e = getJSTParts(new Date(end));
      const timeRangeStr = s.year === e.year && s.month === e.month && s.day === e.day
        ? `${s.year}/${s.month}/${s.day} ${s.hour}:${s.minute} - ${e.hour}:${e.minute} (JST)`
        : `${s.year}/${s.month}/${s.day} ${s.hour}:${s.minute} - ${e.year}/${e.month}/${e.day} ${e.hour}:${e.minute} (JST)`;

      const { diary, notebook, chunks } = await summarizeConversation(
        segmentMessages,
        currentMemory,
        timeRangeStr,
        kumikoNotebook,
        locationConfig,
        language,
        {
          reason,
          isComplete,
          isContinuation,
          turnsInSegment,
        },
      );

      pendingArchive = {
        archiveKey: buildPendingArchiveKey(segmentMessages),
        segmentStartMessageId: segmentMessages[0]?.id || null,
        segmentEndMessageId: segmentMessages[segmentMessages.length - 1]?.id || null,
        segmentStartTime: start,
        segmentEndTime,
        summaryCompletedTime: summaryCompletedAt,
        timeRangeStr,
        summaryText: diary,
        notebook,
        chunks: Array.from(new Set(chunks.filter(chunk => typeof chunk === 'string' && chunk.trim()).map(chunk => chunk.trim()))),
        savedChunkPayloads: [],
        reason,
        isComplete,
        nextSegmentStartTurn,
        nextSegmentStartMessageId,
      };
      // Persist the retry record before touching RAG. This is not a
      // cross-database transaction, but it pins the generated facts and
      // original cursor for ordinary retries and restarts.
      await persistPendingArchive(state, pendingArchive, currentCount);
    }

    const { summaryText: newSummary, notebook: newNotebook, chunks, timeRangeStr } = pendingArchive;

    console.log('[AUTO-SUMMARY] Generated New Core Memory:', newSummary);
    console.log('[AUTO-SUMMARY] Updated Notebook:', newNotebook);
    console.log('[AUTO-SUMMARY] Extracted Memory Chunks:', chunks);

    const summarySegmentMetadata: SummarySegmentMetadata = {
      segmentId: buildSummarySegmentId(
        pendingArchive.segmentStartTime,
        pendingArchive.segmentStartMessageId || segmentMessages[0]?.id || null,
        pendingArchive.summaryCompletedTime,
      ),
      segmentStartTime: pendingArchive.segmentStartTime,
      segmentEndTime: pendingArchive.segmentEndTime,
      summaryCompletedTime: pendingArchive.summaryCompletedTime,
      isComplete: pendingArchive.isComplete,
      topicLabel: helpers.deriveSummaryTopicLabel(chunks, segmentMessages, newSummary),
      summaryText: newSummary,
    };
    const archiveStateForCommit = useAppStore.getState().summaryArchiveState;
    const updatedRecentSummarySegments = appendRecentSummarySegment(archiveStateForCommit, summarySegmentMetadata);
    const nextSummaryBuffer = buildRecentSummaryBuffer(updatedRecentSummarySegments, newSummary);

    if (backupConfig.ragEnabled && chunks && chunks.length > 0) {
      state.setRagStatus('INDEXING');
      console.log(`[RAG] Archiving ${chunks.length} memory chunks to Local DB...`);

      for (const chunk of chunks) {
        const ragPayload = `【MEMORY CHUNK (${timeRangeStr})】\n${chunk}`;
        if (pendingArchive.savedChunkPayloads.includes(ragPayload)) continue;

        const memoryDecision = evaluateRagMemoryCandidate(ragPayload, 'memory_chunk');
        try {
          await saveLocalRagMemory(ragPayload, undefined, {
            tier: mapRagDecisionTierToStorageTier(memoryDecision.tier),
            source: 'memory_chunk',
            score: memoryDecision.score,
            canonicalKey: memoryDecision.canonicalKey,
            role: 'system',
          });
        } catch (ragErr) {
          state.setRagStatus('ERROR');
          throw new Error(`Failed to archive memory chunk: ${ragErr instanceof Error ? ragErr.message : String(ragErr)}`);
        }

        pendingArchive = {
          ...pendingArchive,
          savedChunkPayloads: [...pendingArchive.savedChunkPayloads, ragPayload],
        };
        await persistPendingArchive(state, pendingArchive, currentCount);
      }
      console.log('[RAG] Memory Chunks Archived Successfully.');
      state.setRagStatus('IDLE');
    }

    const continuationCarryover = pendingArchive.reason === 'hard_limit'
      ? getSummaryContinuationCarryoverState(segmentMessages)
      : {
          carryoverStartMessageId: null,
          carryoverEndMessageId: null,
        };

    const committedArchiveState = normalizeSummaryArchiveState({
        segmentStartTurn: pendingArchive.nextSegmentStartTurn,
        segmentStartMessageId: pendingArchive.nextSegmentStartMessageId,
        activeSegmentId: buildSummarySegmentId(
          segmentMessages[Math.max(0, segmentMessages.length - 1)]?.timestamp ?? Date.now(),
          pendingArchive.nextSegmentStartMessageId,
          Date.now(),
        ),
        carryoverStartMessageId: continuationCarryover.carryoverStartMessageId,
        carryoverEndMessageId: continuationCarryover.carryoverEndMessageId,
        pendingSinceTurn: null,
        lastBoundaryReason: pendingArchive.reason,
        lastBoundaryAt: Date.now(),
        recentSummarySegments: updatedRecentSummarySegments,
        pendingArchive: null,
      }, pendingArchive.nextSegmentStartTurn);

    await db.transaction('rw', db.keyval, async () => {
      await db.keyval.put({ key: 'kumiko_core_memory', value: nextSummaryBuffer });
      await db.keyval.put({ key: 'kumiko_notebook', value: newNotebook });
      await db.keyval.put({ key: SUMMARY_ARCHIVE_STATE_STORAGE_KEY, value: committedArchiveState });
    });
    if (nextSummaryBuffer !== currentMemory) state.setCoreMemory(nextSummaryBuffer);
    if (newNotebook !== kumikoNotebook) state.setKumikoNotebook(newNotebook);
    state.setSummaryArchiveState(committedArchiveState);
  } catch (err) {
    console.error(`[AUTO-SUMMARY] Process Failed (attempt ${retryCount + 1}/3):`, err);
    if (backupConfig.ragEnabled) state.setRagStatus('ERROR');
    const MAX_RETRIES = 2;
    if (retryCount < MAX_RETRIES) {
      const delayMs = retryCount === 0 ? 15000 : 45000;
      console.log(`[AUTO-SUMMARY] Will retry in ${delayMs / 1000}s...`);
      state.setSystemNotice(language === 'zh' ? '记忆整理暂时失败，正在重试……' : 'Memory archival failed, retrying...');
      setTimeout(() => {
        void triggerAutoSummaryLegacy(refs, helpers, {
          ...params,
          retryCount: retryCount + 1,
        });
      }, delayMs);
    } else {
      state.setSystemNotice(language === 'zh' ? '记忆整理失败，可在记忆面板手动触发' : 'Memory archival failed. You can trigger it manually in the Memory panel.');
    }
  } finally {
    refs.summaryRunningRef.current = false;
  }
}

// ---------------------------------------------------------------------------
// handleRebuildRag
// ---------------------------------------------------------------------------

export async function handleRebuildRag() {
  const state = useAppStore.getState();
  const messages = state.messages;
  const language = state.language;

  let backgroundThrottlingDisabled = false;
  let unsubscribeRebuild: (() => void) | null = null;

  try {
    const rebuildStartedAt = Date.now();
    const formatRebuildElapsed = () => `${Date.now() - rebuildStartedAt}ms`;
    let activeJobId: string | null = null;

    const stageDefinitions = {
      loading_source_history: {
        status: 'RECALLING' as const,
        label: language === 'zh' ? '1/6 加载原始历史' : '1/6 Loading source history',
      },
      grouping_fragments: {
        status: 'RECALLING' as const,
        label: language === 'zh' ? '2/6 分组消息片段' : '2/6 Grouping fragments',
      },
      generating_embeddings: {
        status: 'RECALLING' as const,
        label: language === 'zh' ? '3/6 生成向量' : '3/6 Generating embeddings',
      },
      writing_sqlite_rows: {
        status: 'INDEXING' as const,
        label: language === 'zh' ? '4/6 写入 SQLite' : '4/6 Writing SQLite rows',
      },
      building_indexes: {
        status: 'INDEXING' as const,
        label: language === 'zh' ? '5/6 构建索引' : '5/6 Building indexes',
      },
      finalizing_statistics: {
        status: 'INDEXING' as const,
        label: language === 'zh' ? '6/6 汇总统计' : '6/6 Finalizing statistics',
      },
    };

    const setRebuildStage = (
      stage: keyof typeof stageDefinitions,
      progress?: { processed?: number | null; total?: number | null; extra?: string | null },
    ) => {
      const definition = stageDefinitions[stage];
      const processed = typeof progress?.processed === 'number' ? progress.processed : undefined;
      const total = typeof progress?.total === 'number' ? progress.total : undefined;
      const progressText = (
        typeof processed === 'number' && typeof total === 'number' && total > 0
          ? ` (${Math.min(processed, total)}/${total})`
          : ''
      );
      const extraText = progress?.extra ? ` - ${progress.extra}` : '';
      const detail = `${definition.label}${progressText}${extraText}`;
      state.setRagStatus(definition.status);
      state.setRagProgressLabel(detail);
      console.log(`[RAG REBUILD] stage=${stage} processed=${processed ?? '-'} total=${total ?? '-'} elapsed=${formatRebuildElapsed()}${progress?.extra ? ` extra=${progress.extra}` : ''}`);
    };

    const applyRebuildEvent = (event: LocalRagRebuildEvent) => {
      if (!activeJobId && event.jobId) {
        activeJobId = event.jobId;
      }
      if (activeJobId && event.jobId && event.jobId !== activeJobId) {
        return;
      }

      const stage = event.stage as keyof typeof stageDefinitions;
      if (stage && stageDefinitions[stage]) {
        setRebuildStage(stage, {
          processed: event.processed,
          total: event.total,
          extra: event.extra,
        });
      }
    };

    if (isDesktopElectron()) {
      const throttlingResult = await setDesktopBackgroundThrottling(false);
      if (throttlingResult.success) {
        backgroundThrottlingDisabled = true;
      } else {
        console.warn('[RAG REBUILD] Failed to disable background throttling.', throttlingResult.error);
      }
    }

    let needsFix = false;
    let lastValidTime = Date.now();
    for (const message of messages) {
      const parsedTime = new Date(message.timestamp);
      if (!isNaN(parsedTime.getTime())) {
        lastValidTime = parsedTime.getTime();
        break;
      }
    }

    const fixedMessages = messages.map(message => {
      const parsedTime = new Date(message.timestamp);
      if (isNaN(parsedTime.getTime())) {
        needsFix = true;
        const repairedTimestamp = lastValidTime + 1;
        lastValidTime = repairedTimestamp;
        return { ...message, timestamp: repairedTimestamp };
      }

      lastValidTime = parsedTime.getTime();
      if (typeof message.timestamp !== 'number') {
        needsFix = true;
        return { ...message, timestamp: parsedTime.getTime() };
      }

      return message;
    });

    if (needsFix) {
      useAppStore.getState().setMessages(fixedMessages);
      console.log('[RAG REBUILD] Fixed invalid timestamps in chat history before sync.');
    }

    setRebuildStage('loading_source_history', {
      processed: fixedMessages.length,
      total: fixedMessages.length,
      extra: language === 'zh' ? '同步原始消息到桌面 SQLite' : 'Syncing raw messages to desktop SQLite',
    });
    const syncStartedAt = Date.now();
    console.log(`[RAG REBUILD] sync start messages=${fixedMessages.length}`);
    try {
      await syncRawHistoryMessages(fixedMessages, { forceFull: true, throwOnSyncError: true });
    } catch (syncError) {
      const syncErrorMessage = syncError instanceof Error ? syncError.message : String(syncError);
      console.error(`[RAG REBUILD] sync FAILED elapsedMs=${Date.now() - syncStartedAt} error=${syncErrorMessage}`);
      // Short-circuit with a specific notice; the generic outer catch would
      // otherwise overwrite this with "重建记忆库失败。" and hide the real
      // cause (usually E_TIMEOUT from the HTTP/IPC bridge on large sync
      // payloads, which is exactly what stranded the mobile UI at 1/6).
      const s2 = useAppStore.getState();
      s2.setRagStatus('ERROR');
      s2.setRagProgressLabel(null);
      s2.setSystemNotice(language === 'zh'
        ? `原始消息同步失败，无法开始重建。${syncErrorMessage}`
        : `Raw message sync failed; rebuild aborted. ${syncErrorMessage}`);
      return;
    }
    console.log(`[RAG REBUILD] sync done elapsedMs=${Date.now() - syncStartedAt}`);

    const completion = new Promise<LocalRagRebuildEvent>((resolve, reject) => {
      unsubscribeRebuild = subscribeLocalRagRebuild((event) => {
        applyRebuildEvent(event);
        if (event.type === 'done') {
          resolve(event);
          return;
        }
        if (event.type === 'error') {
          reject(event);
        }
      });
    });

    const startResult = await startLocalRagRebuild();
    if (startResult.snapshot?.jobId) {
      activeJobId = startResult.snapshot.jobId;
      applyRebuildEvent({
        type: startResult.started ? 'started' : 'progress',
        ...startResult.snapshot,
      });
    }
    console.log(`[RAG REBUILD] job=${activeJobId ?? 'unknown'} started=${startResult.started} alreadyRunning=${startResult.alreadyRunning} elapsed=${formatRebuildElapsed()}`);

    const completedEvent = await completion;
    const finalStats = completedEvent.finalStats;
    console.log('[RAG FILTER] Rebuild summary:', {
      accepted: completedEvent.candidateCount,
      filtered: completedEvent.filteredCount,
      deduped: completedEvent.duplicateCount,
      inserted: completedEvent.storedCount,
      merged: completedEvent.mergedCount,
      skippedExisting: completedEvent.skippedExistingCount,
      cleared: completedEvent.clearedCount,
      final: finalStats?.vectorCount ?? 0,
      core: finalStats?.coreCount ?? 0,
      episodic: finalStats?.episodicCount ?? 0,
      background: finalStats?.backgroundCount ?? 0,
      grouped: completedEvent.groupedCount,
    });
    console.log(`[RAG REBUILD] completed elapsed=${formatRebuildElapsed()}`);

    const s2 = useAppStore.getState();
    s2.setRagDirtyNoticeShown(false);
    s2.setIsRagHistoryDirty(false);
    s2.setRagStatus('IDLE');
    s2.setRagProgressLabel(null);
    s2.setSystemNotice(language === 'zh' ? '记忆库重建完成！' : 'Memory bank rebuilt successfully!');
  } catch (e) {
    const rebuildMessage = typeof (e as any)?.error === 'string'
      ? (e as any).error
      : e instanceof Error
        ? e.message
        : String(e);
    console.error('Failed to rebuild RAG memory', rebuildMessage, e);
    const s2 = useAppStore.getState();
    s2.setRagStatus('ERROR');
    s2.setRagProgressLabel(null);
    s2.setSystemNotice(language === 'zh' ? '重建记忆库失败。' : 'Failed to rebuild memory bank.');
  } finally {
    unsubscribeRebuild?.();
    if (isDesktopElectron() && backgroundThrottlingDisabled) {
      const throttlingResult = await setDesktopBackgroundThrottling(true);
      if (!throttlingResult.success) {
        console.warn('[RAG REBUILD] Failed to restore background throttling.', throttlingResult.error);
      }
    }
    if (isDesktopElectron()) {
      refocusDesktopWebContents();
    }
  }
}
