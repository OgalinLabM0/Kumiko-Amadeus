import React from 'react';
import { useAppStore } from '../../store';
import type {
  Message,
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

// ---------------------------------------------------------------------------
// triggerAutoSummary
// ---------------------------------------------------------------------------

export async function triggerAutoSummary(
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

  if (refs.summaryRunningRef.current && retryCount === 0) {
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

    const start = segmentMessages[0].timestamp;
    const summaryCompletedAt = Date.now();
    const segmentEndTime = segmentMessages[segmentMessages.length - 1].timestamp;
    const end = Math.max(segmentEndTime, summaryCompletedAt);

    const startDate = new Date(start);
    const endDate = new Date(end);

    const getJSTParts = (d: Date) => {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const parts = formatter.formatToParts(d);
      const p: any = {};
      parts.forEach(part => p[part.type] = part.value);
      return p;
    };

    const s = getJSTParts(startDate);
    const e = getJSTParts(endDate);

    let timeRangeStr = '';
    if (s.year === e.year && s.month === e.month && s.day === e.day) {
      timeRangeStr = `${s.year}/${s.month}/${s.day} ${s.hour}:${s.minute} - ${e.hour}:${e.minute} (JST)`;
    } else {
      timeRangeStr = `${s.year}/${s.month}/${s.day} ${s.hour}:${s.minute} - ${e.year}/${e.month}/${e.day} ${e.hour}:${e.minute} (JST)`;
    }

    const { diary: newSummary, notebook: newNotebook, chunks } = await summarizeConversation(
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

    console.log('[AUTO-SUMMARY] Generated New Core Memory:', newSummary);
    console.log('[AUTO-SUMMARY] Updated Notebook:', newNotebook);
    console.log('[AUTO-SUMMARY] Extracted Memory Chunks:', chunks);

    const summarySegmentMetadata: SummarySegmentMetadata = {
      segmentId: buildSummarySegmentId(
        start,
        archiveState.segmentStartMessageId || segmentMessages[0]?.id || null,
        summaryCompletedAt,
      ),
      segmentStartTime: start,
      segmentEndTime,
      summaryCompletedTime: summaryCompletedAt,
      isComplete,
      topicLabel: helpers.deriveSummaryTopicLabel(chunks, segmentMessages, newSummary),
      summaryText: newSummary,
    };
    const updatedRecentSummarySegments = appendRecentSummarySegment(archiveState, summarySegmentMetadata);
    const nextSummaryBuffer = buildRecentSummaryBuffer(updatedRecentSummarySegments, newSummary);

    if (nextSummaryBuffer !== currentMemory) {
      state.setCoreMemory(nextSummaryBuffer);
    }

    if (backupConfig.ragEnabled && chunks && chunks.length > 0) {
      state.setRagStatus('INDEXING');
      console.log(`[RAG] Archiving ${chunks.length} memory chunks to Local DB...`);

      try {
        for (const chunk of chunks) {
          if (typeof chunk === 'string' && chunk.trim().length > 0) {
            const ragPayload = `【MEMORY CHUNK (${timeRangeStr})】\n${chunk}`;
            const memoryDecision = evaluateRagMemoryCandidate(ragPayload, 'memory_chunk');
            await saveLocalRagMemory(ragPayload, undefined, {
              tier: mapRagDecisionTierToStorageTier(memoryDecision.tier),
              source: 'memory_chunk',
              score: memoryDecision.score,
              canonicalKey: memoryDecision.canonicalKey,
              role: 'system',
            });
          }
        }
        console.log('[RAG] Memory Chunks Archived Successfully.');
        state.setRagStatus('IDLE');
      } catch (ragErr) {
        console.warn('[RAG] Failed to archive memory chunks.', ragErr);
        state.setRagStatus('ERROR');
      }
    }

    if (newNotebook !== kumikoNotebook) {
      state.setKumikoNotebook(newNotebook);
    }

    const continuationCarryover = reason === 'hard_limit'
      ? getSummaryContinuationCarryoverState(segmentMessages)
      : {
          carryoverStartMessageId: null,
          carryoverEndMessageId: null,
        };

    state.setSummaryArchiveState(
      normalizeSummaryArchiveState({
        segmentStartTurn: nextSegmentStartTurn,
        segmentStartMessageId: nextSegmentStartMessageId,
        activeSegmentId: buildSummarySegmentId(
          segmentMessages[Math.max(0, segmentMessages.length - 1)]?.timestamp ?? Date.now(),
          nextSegmentStartMessageId,
          Date.now(),
        ),
        carryoverStartMessageId: continuationCarryover.carryoverStartMessageId,
        carryoverEndMessageId: continuationCarryover.carryoverEndMessageId,
        pendingSinceTurn: null,
        lastBoundaryReason: reason,
        lastBoundaryAt: Date.now(),
        recentSummarySegments: updatedRecentSummarySegments,
      }, nextSegmentStartTurn),
    );
  } catch (err) {
    console.error(`[AUTO-SUMMARY] Process Failed (attempt ${retryCount + 1}/3):`, err);
    if (backupConfig.ragEnabled) state.setRagStatus('ERROR');
    const MAX_RETRIES = 2;
    if (retryCount < MAX_RETRIES) {
      const delayMs = retryCount === 0 ? 15000 : 45000;
      console.log(`[AUTO-SUMMARY] Will retry in ${delayMs / 1000}s...`);
      state.setSystemNotice(language === 'zh' ? '记忆整理暂时失败，正在重试……' : 'Memory archival failed, retrying...');
      setTimeout(() => {
        void triggerAutoSummary(refs, helpers, {
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
    await syncRawHistoryMessages(fixedMessages, { forceFull: true });

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
