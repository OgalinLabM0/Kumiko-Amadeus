import { useCallback, useRef, type MutableRefObject } from 'react';
import { hideMessagesLocally } from '../../services/messageViews';
import type { Message, Language, BackupConfig, TtsConfig, MemoryQuerySession, SummaryArchiveState } from '../../types';
import { recalculateTurnCountFromMessages } from './backupHelpers';
import { normalizeSummaryArchiveState } from './summaryCycle';
import { getCurrentAIConfig } from '../../services/geminiService';
import { getImageBase64 } from '../../services/imageService';
import { synthesizeSpeech } from '../../services/fishAudioService';
import { deleteVoiceFile, saveVoiceFile } from '../../services/voiceFileService';
import { withMediaWriteFence } from '../../services/mediaWriteFence';
import { beginVoiceWrite, finishVoiceWrite } from '../../services/voiceWriteLedger';
import { dialogService } from '../../services/dialogService';
import { useAppStore } from '../../store';
import { readTurnSources } from '../../services/turnCoordinator';
import { withdrawUnprocessedSource } from '../../services/receivedTurns';
import { getDataRestoreVersion, isDataRestoreBlocked } from '../../services/dataRestoreGate';
import { assertMemoryAvailable, assertMemoryGenerationCurrent, getMemoryGeneration } from '../../services/memoryMaintenanceGate';
import { assertTaskModelRevisionsCurrent, beginForegroundActivity, endForegroundActivity, type TaskContext } from '../../services/taskRuntime';
import { db } from '../../services/db';

export interface UseMessageHistoryOperationsParams {
  // Refs
  messagesRef: MutableRefObject<Message[]>;
  ttsConfigRef: MutableRefObject<TtsConfig>;
  inputRef: MutableRefObject<HTMLInputElement | null>;
  pendingMessageIdsRef: MutableRefObject<Set<string>>;
  pendingTextRef: MutableRefObject<string>;
  pendingImageRef: MutableRefObject<string | null>;
  pendingImageMessageIdRef: MutableRefObject<string | null>;
  sendTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  countdownIntervalRef: MutableRefObject<ReturnType<typeof setInterval> | null>;
  generationIdRef: MutableRefObject<number>;
  skipNextRawHistorySyncRef: MutableRefObject<boolean>;

  // Store setters (Zustand — stable identity)
  setMessages: (v: Message[] | ((prev: Message[]) => Message[])) => void;
  setTurnCount: (v: number) => void;
  setSummaryArchiveState: (v: SummaryArchiveState | ((prev: SummaryArchiveState) => SummaryArchiveState)) => void;
  setIsRagHistoryDirty: (v: boolean) => void;
  setRagDirtyNoticeShown: (v: boolean) => void;
  setReplyingToMsg: (v: Message | null) => void;
  setHighlightedMessageId: (v: string | null) => void;
  setInputValue: (v: string | ((prev: string) => string)) => void;
  setIsDisconnected: (v: boolean) => void;
  setIsListening: (v: boolean) => void;
  setTimeLeft: (v: number) => void;
  setSystemNotice: (v: string | null) => void;
  setRegeneratingVoiceIds: (v: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  setIsMemoryPanelOpen: (v: boolean) => void;
  setIsProfileOpen: (v: boolean) => void;
  setIsSettingsOpen: (v: boolean) => void;
  setIsTaskPanelOpen: (v: boolean) => void;
  setIsMessageCenterOpen: (v: boolean) => void;

  // Upstream callbacks / state
  executeSend: () => Promise<void> | void;
  updateMemoryQuerySession: (v: MemoryQuerySession | null) => void;
  backupConfig: BackupConfig;
  isRagHistoryDirty: boolean;
  ragDirtyNoticeShown: boolean;
  language: Language;
}

export interface UseMessageHistoryOperationsResult {
  // 4 appliers
  applyMessagesWithDerivedState: (nextMessages: Message[]) => void;
  applyVisualHistoryMutation: (nextMessages: Message[]) => void;
  markRagHistoryDirty: (reason: string) => void;
  applyManualHistoryMutation: (nextMessages: Message[], reason: string) => void;

  // 11 message CRUD handlers
  handleInsertMessage: (afterId: string | null, role: 'user' | 'model') => void;
  handleReorderMessages: (dragIndex: number, hoverIndex: number) => void;
  handleUpdateMessage: (id: string, update: string | Partial<Message>) => void;
  handleDeleteMessage: (id: string) => void;
  handleToggleHidden: (id: string) => void;
  handleTogglePin: (id: string) => void;
  handleJumpToMessage: (id: string) => void;
  handleResendMessage: (messageId: string) => Promise<void>;
  handleWithdrawMessage: (messageId: string) => void;
  handleRecall: (id: string) => void;
  handleRegenerateVoice: (msg: Message) => Promise<void>;

  // 2 reply controls
  handleReply: (msg: Message) => void;
  handleCancelReply: () => void;
}

/**
 * Consolidates the 17 message-history useCallback handlers that used to
 * live inline in App.tsx. All dependency arrays and closure semantics
 * are preserved 1:1 with the pre-extraction source; the observable
 * behaviour is unchanged.
 *
 * The hook does not own any state: every ref, every setter, every
 * upstream callback is passed in. This keeps App.tsx's lifecycle the
 * single source of truth and makes the hook trivially testable.
 *
 * `handleResendMessage` still depends on the pre-extraction
 * `executeSend` (not part of Plan 11) via the `executeSend` param; its
 * dep array is `[executeSend, language]` exactly as before.
 */
export const useMessageHistoryOperations = (
  params: UseMessageHistoryOperationsParams,
): UseMessageHistoryOperationsResult => {
  const resendInFlightRef = useRef(false);
  const {
    messagesRef,
    ttsConfigRef,
    inputRef,
    pendingMessageIdsRef,
    pendingTextRef,
    pendingImageRef,
    pendingImageMessageIdRef,
    sendTimerRef,
    countdownIntervalRef,
    generationIdRef,
    skipNextRawHistorySyncRef,
    setMessages,
    setTurnCount,
    setSummaryArchiveState,
    setIsRagHistoryDirty,
    setRagDirtyNoticeShown,
    setReplyingToMsg,
    setHighlightedMessageId,
    setInputValue,
    setIsDisconnected,
    setIsListening,
    setTimeLeft,
    setSystemNotice,
    setRegeneratingVoiceIds,
    setIsMemoryPanelOpen,
    setIsProfileOpen,
    setIsSettingsOpen,
    setIsTaskPanelOpen,
    setIsMessageCenterOpen,
    executeSend,
    updateMemoryQuerySession,
    backupConfig,
    isRagHistoryDirty,
    ragDirtyNoticeShown,
    language,
  } = params;

  const applyMessagesWithDerivedState = useCallback((nextMessages: Message[]) => {
    setMessages(nextMessages);
    const recalculatedTurnCount = recalculateTurnCountFromMessages(nextMessages);
    setTurnCount(recalculatedTurnCount);
    setSummaryArchiveState(prev => normalizeSummaryArchiveState(prev, recalculatedTurnCount));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- preserve original empty deps (setters are stable Zustand refs)
  }, []);

  const applyVisualHistoryMutation = useCallback((nextMessages: Message[]) => {
    skipNextRawHistorySyncRef.current = true;
    setMessages(nextMessages);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- preserve original empty deps
  }, []);

  const markRagHistoryDirty = useCallback((reason: string) => {
    if (!backupConfig.ragEnabled) return;
    const shouldNotify = !isRagHistoryDirty && !ragDirtyNoticeShown;
    setIsRagHistoryDirty(true);
    if (shouldNotify) {
      setRagDirtyNoticeShown(true);
      void dialogService.alert({
        message: language === 'zh'
          ? '你刚刚修改了真实历史内容，本地 RAG 记忆索引建议重建。'
          : 'You just changed real message history. Rebuilding the local RAG index is recommended.',
        icon: 'warning',
      });
    }
    console.warn(`[LOCAL RAG] Manual history edit marked the current message-linked recall index as stale. Rebuild recommended. reason=${reason}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- preserve original deps (ragDirtyNoticeShown intentionally omitted; matches pre-extraction behaviour)
  }, [backupConfig.ragEnabled, isRagHistoryDirty, language]);

  const applyManualHistoryMutation = useCallback((nextMessages: Message[], reason: string) => {
    applyMessagesWithDerivedState(nextMessages);
    updateMemoryQuerySession(null);
    markRagHistoryDirty(reason);
  }, [applyMessagesWithDerivedState, markRagHistoryDirty, updateMemoryQuerySession]);

  const handleInsertMessage = useCallback((afterId: string | null, role: 'user' | 'model') => {
    const newMessages = [...messagesRef.current].sort((a, b) => a.timestamp - b.timestamp);
    let newTimestamp = Date.now();
    if (afterId) {
      const index = newMessages.findIndex(m => m.id === afterId);
      if (index !== -1) {
        const currentMsg = newMessages[index];
        newTimestamp = currentMsg.timestamp + 1;
      }
    } else if (newMessages.length > 0) {
      newTimestamp = newMessages[newMessages.length - 1].timestamp + 1;
    }

    const newMessage: Message = {
      id: Date.now().toString() + Math.random().toString(),
      role,
      text: "...",
      timestamp: newTimestamp,
      isRead: true
    };

    const nextMessages = [...messagesRef.current, newMessage];
    applyManualHistoryMutation(nextMessages, 'insert_message');
  }, [applyManualHistoryMutation]);

  const handleReorderMessages = useCallback((dragIndex: number, hoverIndex: number) => {
    const newMessages = [...messagesRef.current].sort((a, b) => a.timestamp - b.timestamp);
    const draggedMessage = newMessages[dragIndex];
    newMessages.splice(dragIndex, 1);
    newMessages.splice(hoverIndex, 0, draggedMessage);
    const startIdx = Math.min(dragIndex, hoverIndex);
    let baseTime = startIdx > 0 ? newMessages[startIdx - 1].timestamp : newMessages[0].timestamp - 1000;
    for (let i = startIdx; i < newMessages.length; i++) {
      if (newMessages[i].timestamp <= baseTime) {
        newMessages[i] = { ...newMessages[i], timestamp: baseTime + 1 };
      }
      baseTime = newMessages[i].timestamp;
    }
    applyManualHistoryMutation(newMessages, 'reorder_messages');
  }, [applyManualHistoryMutation]);

  const handleUpdateMessage = useCallback((id: string, update: string | Partial<Message>) => {
    if (typeof update === 'string' || ['text', 'role', 'timestamp', 'imageId', 'imageCaption', 'quote'].some(key => key in update)) {
      setIsSettingsOpen(true);
      setSystemNotice(language === 'zh' ? '修改已收到的原话请使用“数据管理 → 记忆维护”：先预览并清除错误来源，再在聊天里告知正确内容。' : 'Use Data Management → Memory maintenance to preview and remove the incorrect source, then share the correction in chat.');
      return;
    }
    const nextMessages = messagesRef.current.map(msg => {
      if (msg.id === id) {
        if (typeof update === 'string') return { ...msg, text: update };
        return { ...msg, ...update };
      }
      if (typeof update === 'string' && msg.quote && msg.quote.id === id) {
        return { ...msg, quote: { ...msg.quote, text: update } };
      }
      return msg;
    });
    applyManualHistoryMutation(nextMessages, 'update_message');
  }, [applyManualHistoryMutation]);

  const handleDeleteMessage = useCallback((id: string) => {
    void hideMessagesLocally([id]).catch(() => {
      void dialogService.alert(language === 'en' ? 'Could not hide this message. Nothing was deleted.' : '暂时无法从你的聊天中删除这条消息，请稍后重试。');
    });
  }, [language]);

  const handleToggleHidden = useCallback((id: string) => {
    const nextMessages = messagesRef.current.map(msg => msg.id === id ? { ...msg, isHidden: !msg.isHidden } : msg);
    applyVisualHistoryMutation(nextMessages);
  }, [applyVisualHistoryMutation]);

  const handleTogglePin = useCallback((id: string) => {
    setMessages(prev => prev.map(msg => msg.id === id ? { ...msg, isPinned: !msg.isPinned } : msg));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- preserve original empty deps (setMessages is stable)
  }, []);

  const handleJumpToMessage = useCallback((id: string) => {
    setIsMemoryPanelOpen(false);
    setIsProfileOpen(false);
    setIsSettingsOpen(false);
    setIsTaskPanelOpen(false);
    setIsMessageCenterOpen(false);
    setHighlightedMessageId(id);
    setTimeout(() => {
      const element = document.getElementById(`message-${id}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      setTimeout(() => {
        setHighlightedMessageId(null);
      }, 2000);
    }, 300);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- preserve original empty deps (all setters are stable Zustand refs)
  }, []);

  const handleResendMessage = useCallback(async (messageId: string) => {
    const msg = messagesRef.current.find(m => m.id === messageId);
    if (!msg || msg.sendStatus !== 'failed') return;
    if (resendInFlightRef.current) return;

    if (isDataRestoreBlocked()) {
      setSystemNotice(language === 'zh' ? '正在恢复数据，完成后再重试回复。' : 'Data is being restored. Retry the reply after it finishes.');
      return;
    }
    if (pendingMessageIdsRef.current.size || useAppStore.getState().isThinking || useAppStore.getState().isTalking) {
      setSystemNotice(language === 'zh' ? '请等当前消息处理完成后再重试。' : 'Wait for the current message before retrying.');
      return;
    }
    let retryIds = new Set<string>([messageId]);
    let preparedRetry = false;
    resendInFlightRef.current = true;
    try {
      const original = await readTurnSources(messageId);
      retryIds = new Set(original.sources.map(source => source.id));
      // Compare the live view as well: persistence may still be flushing an edit.
      for (const source of original.messages) {
        const live = messagesRef.current.find(item => item.id === source.id);
        if (!live || live.role !== 'user' || live.text !== source.text || live.timestamp !== source.timestamp
          || live.imageId !== source.imageId || live.isHidden) throw new Error('User source changed or was removed');
      }
      const imageMessage = original.messages.filter(item => item.imageId).at(-1);
      const image = imageMessage?.imageId ? await getImageBase64(imageMessage.imageId) : null;
      if (imageMessage && !image) throw new Error('Original image is unavailable');
      // Async image hydration cannot absorb newly queued input into the old turn.
      if (isDataRestoreBlocked() || pendingMessageIdsRef.current.size) throw new Error('Another input or restore started');
      const verified = await readTurnSources(messageId);
      if (verified.epoch !== original.epoch || verified.turnId !== original.turnId) throw new Error('Data changed while retrying');
      for (const source of verified.messages) {
        const live = messagesRef.current.find(item => item.id === source.id);
        if (!live || live.role !== 'user' || live.text !== source.text || live.timestamp !== source.timestamp
          || live.imageId !== source.imageId || live.isHidden) throw new Error('User source changed or was removed');
      }
      setIsDisconnected(false);
      setMessages(prev => prev.map(item => retryIds.has(item.id)
        ? { ...item, sendStatus: 'sending' as const, failReason: undefined } : item));
      setSystemNotice(language === 'zh' ? '正在重试回复...' : 'Retrying the reply...');
      pendingTextRef.current = original.sources.map(source => source.text).join('\n');
      pendingImageRef.current = image;
      pendingImageMessageIdRef.current = imageMessage?.id || null;
      pendingMessageIdsRef.current = new Set(retryIds);
      preparedRetry = true;
      generationIdRef.current += 1;
      await executeSend();
    } catch (err) {
      console.warn('[handleResend] Original turn retry failed:', err);
      setMessages(prev => prev.map(item => retryIds.has(item.id)
        ? { ...item, sendStatus: 'failed' as const, failReason: item.failReason || msg.failReason || '重试回复失败' } : item));
      setSystemNotice(language === 'zh'
        ? '没能重试原来的回复。若原消息已修改、删除或数据已恢复，请确认当前提醒状态后重新发送。'
        : 'The original reply could not be retried. If messages changed or data was restored, check current reminders before sending a new request.');
      if (preparedRetry) {
        for (const id of retryIds) pendingMessageIdsRef.current.delete(id);
        if (pendingImageMessageIdRef.current && retryIds.has(pendingImageMessageIdRef.current)) {
          pendingImageRef.current = null; pendingImageMessageIdRef.current = null;
        }
        pendingTextRef.current = messagesRef.current.filter(item => pendingMessageIdsRef.current.has(item.id)).map(item => item.text).join('\n');
      }
    } finally {
      resendInFlightRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- preserve original deps [executeSend, language]
  }, [executeSend, language]);

  const handleWithdrawMessage = useCallback(async (messageId: string) => {
    const msg = messagesRef.current.find(m => m.id === messageId);
    if (!msg || msg.role !== 'user') return;

    // v2.14.26: also allow withdraw when the bubble is stuck in 'sending'.
    // v2.14.28 H5 (post-H18 reframe): after the H18 read-state rework,
    // sendStatus is no longer written to 'sending' — instead the user bubble
    // sits in the "未读" state (sendStatus undefined + isRead false) for the
    // entire LLM round-trip. Stuck-flaky-network case from v2.14.26 now
    // manifests as "未读 forever". Permit withdraw on:
    //   - sendStatus === 'failed'  (real failure)
    //   - sendStatus === 'sending' (legacy state, kept for safety)
    //   - isRead === false        (post-H18 stuck 未读)
    // i.e. anything except a fully-acknowledged ("已读") user message.
    const isStuckUnread = msg.sendStatus === undefined && msg.isRead === false;
    if (msg.sendStatus !== 'failed' && msg.sendStatus !== 'sending' && !isStuckUnread) return;
    if (!await withdrawUnprocessedSource({ id: msg.id, text: msg.text, timestamp: msg.timestamp })) {
      setSystemNotice(language === 'zh' ? '这条消息已开始处理，无法撤回。' : 'This message is already being processed and cannot be withdrawn.');
      return;
    }

    // v2.14.28 H5: if the turn is currently in flight (stuck 未读), bump the
    // generation id so executeSendCore's isCancelled() guard fires on the
    // next checkpoint. This prevents a Kumiko reply from landing for a
    // user message that has just been withdrawn.
    if (isStuckUnread) {
      try { generationIdRef.current = (generationIdRef.current ?? 0) + 1; } catch { /* noop */ }
    }

    setMessages(prev => prev.filter(m => m.id !== messageId));
    setInputValue(prev => prev ? prev + '\n' + msg.text : msg.text);
    if (pendingMessageIdsRef.current.has(messageId)) {
      pendingMessageIdsRef.current.delete(messageId);
    }
    if (pendingImageMessageIdRef.current === messageId) {
      pendingImageRef.current = null;
      pendingImageMessageIdRef.current = null;
    }

    const remaining = messagesRef.current.filter(m =>
      m.id !== messageId && m.sendStatus === 'failed'
    );
    if (remaining.length === 0) setIsDisconnected(false);

    // v2.14.26: surface the system notice IMMEDIATELY so the user
    // knows the tap registered, even if the subsequent `inputRef.focus`
    // silently fails (common on Android WebView when the soft keyboard
    // wasn't already open or the input is in a closed Collapse). The
    // 0ms setTimeout below is then "best-effort focus" — its outcome
    // doesn't gate the user's confirmation feedback.
    setSystemNotice(language === 'zh' ? '已撤回到输入框，可编辑后重发' : 'Restored to the input box, edit and resend');

    // v2.14.23: focus + caret-at-end + scroll-into-view best-effort.
    // The setTimeout 0 lets React commit setInputValue before we read
    // the DOM; without it, the input still shows the old (empty) value
    // and the caret position is wrong.
    setTimeout(() => {
      const input = inputRef.current;
      if (input) {
        try { input.focus({ preventScroll: false }); } catch { input.focus(); }
        try {
          const len = input.value?.length ?? 0;
          if (typeof input.setSelectionRange === 'function') input.setSelectionRange(len, len);
        } catch {
          // Some hybrid input wrappers (e.g. with contenteditable) don't
          // support setSelectionRange; safe to ignore.
        }
        try { input.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
      }
    }, 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- preserve original empty deps
  }, [language]);

  // FIX: Clear pendingImageMessageIdRef on Recall if the recalled message was the one with the image
  const handleRecall = useCallback(async (id: string) => {
      const msgToRecall = messagesRef.current.find(m => m.id === id);
      if (!msgToRecall) return;
      if (msgToRecall.role !== 'user' || !await withdrawUnprocessedSource({ id: msgToRecall.id, text: msgToRecall.text, timestamp: msgToRecall.timestamp })) {
          setSystemNotice(language === 'zh' ? '这条消息已开始处理，无法撤回。' : 'This message is already being processed and cannot be withdrawn.');
          return;
      }

      setMessages(prev => prev.filter(m => m.id !== id));

      if (pendingMessageIdsRef.current.has(id)) pendingMessageIdsRef.current.delete(id);

      // CRITICAL FIX: If we recall the image message, clear the tracking ref
      if (id === pendingImageMessageIdRef.current) {
          pendingImageRef.current = null;
          pendingImageMessageIdRef.current = null;
      }

      setInputValue(prev => prev ? prev + '\n' + msgToRecall.text : msgToRecall.text);
      const remainingPendingMessages = messagesRef.current.filter(m => pendingMessageIdsRef.current.has(m.id) && m.id !== id);
      pendingTextRef.current = remainingPendingMessages.map(m => m.text).join('\n');
      if (remainingPendingMessages.length === 0) {
          if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
          if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
          setTimeLeft(0);
          setIsListening(false);
      }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- preserve original empty deps
  }, []);

  const handleReply = useCallback((msg: Message) => {
    setReplyingToMsg(msg);
    inputRef.current?.focus();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- preserve original empty deps
  }, []);

  const handleCancelReply = useCallback(() => {
    setReplyingToMsg(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- preserve original empty deps
  }, []);

  const handleRegenerateVoice = useCallback(async (msg: Message) => {
    if (!msg.isVoiceMessage || !msg.id) return;
    const version = getDataRestoreVersion();

    setRegeneratingVoiceIds(prev => {
      const next = new Set(prev);
      next.add(msg.id);
      return next;
    });

    try {
      const emotion = msg.storedEmotion || 'neutral';
      const ttsConfigToUse = { ...ttsConfigRef.current };
      const current = await db.messages.get(msg.id);
      if (!current || current.text !== msg.text || current.timestamp !== msg.timestamp) throw new Error('The source message changed.');
      const sourceRevision = current.contentRevision ?? (current as any).sourceRevision ?? 'legacy';
      const taskId = crypto.randomUUID();
      const taskContext: TaskContext = { taskId, rootId: taskId, role: 'translation', lane: 'foreground', deadlineAt: Date.now() + 180_000,
        epoch: version, memoryGeneration: getMemoryGeneration(), modelRevisions: {},
        consultedSources: [{ kind: 'message', id: msg.id, version: sourceRevision, relation: 'context' }] };
      const assertCurrent = () => {
        assertMemoryAvailable(taskContext.memoryGeneration);
        if (getDataRestoreVersion() !== version || JSON.stringify(ttsConfigRef.current) !== JSON.stringify(ttsConfigToUse)) throw new Error('Voice settings changed.');
      };
      const backend = ttsConfigToUse.ttsBackend || 'fish';

      // Fish keeps inline [emotion] tags for expressiveness; SoVITS / Vocu expect
      // clean Japanese, so strip bracketed tokens before handing the text off.
      const rawText = msg.japaneseText || msg.text;
      const textToSpeak = backend === 'fish'
        ? rawText
        : rawText.replace(/\[.*?\]/g, '').trim();

      let result;
      await beginForegroundActivity(taskContext);
      try {
      if (backend === 'sovits') {
        if (!ttsConfigToUse.sovitsDir) throw new Error('No SoVITS directory');
        const { genieTtsWithEmotion } = await import('../../services/genieAudioService');
        result = await genieTtsWithEmotion(textToSpeak, emotion, ttsConfigToUse, undefined, undefined, taskContext, assertCurrent);
      } else if (backend === 'vocu') {
        if (!ttsConfigToUse.vocuApiKey || !ttsConfigToUse.vocuVoiceId) {
          throw new Error('Missing Vocu credentials');
        }
        const { synthesizeWithVocu } = await import('../../services/vocuAudioService');
        result = await synthesizeWithVocu(textToSpeak, ttsConfigToUse, emotion, undefined, taskContext, assertCurrent);
      } else {
        if (!ttsConfigToUse.fishAudioApiKey) throw new Error('No API key');
        result = await synthesizeSpeech(textToSpeak, ttsConfigToUse, undefined, taskContext, assertCurrent);
      }
      assertCurrent();
      const latest = await db.messages.get(msg.id);
      if (!latest || (latest.contentRevision ?? (latest as any).sourceRevision ?? 'legacy') !== sourceRevision || latest.text !== current.text) throw new Error('The source message changed.');

      if (result.audio) {
        const fileId = 'voice-' + crypto.randomUUID();
        let committed = false;
        await withMediaWriteFence(version, async () => {
          await beginVoiceWrite({ id: fileId, sourceIds: [msg.id], memoryGeneration: taskContext.memoryGeneration, taskId: taskContext.taskId });
          try {
            assertCurrent();
            if (!await saveVoiceFile(fileId, result.audio)) throw new Error('Could not save regenerated voice.');
            await db.transaction('rw', [db.keyval, db.messages], async () => {
              await assertMemoryGenerationCurrent(taskContext.memoryGeneration);
              await assertTaskModelRevisionsCurrent(taskContext);
              assertCurrent();
              const stored = await db.messages.get(msg.id);
              if (!stored || (stored.contentRevision ?? (stored as any).sourceRevision ?? 'legacy') !== sourceRevision || stored.text !== current.text || stored.timestamp !== current.timestamp) throw new Error('The source message changed.');
              await db.messages.update(msg.id, { voiceFileId: fileId, voiceDuration: result.durationEstimate });
            });
            committed = true;
          } catch (error) {
            if (!committed && !await deleteVoiceFile(fileId)) console.warn('[TTS] Could not remove uncommitted regenerated voice.');
            throw error;
          } finally {
            await finishVoiceWrite(fileId);
          }
        }, taskContext.memoryGeneration);
        if (committed) setMessages(previous => previous.map(message => message.id === msg.id ? { ...message, voiceFileId: fileId, voiceDuration: result.durationEstimate } : message));
      }
      } finally { await endForegroundActivity(taskContext); }
    } catch (e) {
      console.error('[TTS] Failed to regenerate voice:', e);
    } finally {
      setRegeneratingVoiceIds(prev => {
        const next = new Set(prev);
        next.delete(msg.id);
        return next;
      });
    }
  }, [handleUpdateMessage]);

  return {
    applyMessagesWithDerivedState,
    applyVisualHistoryMutation,
    markRagHistoryDirty,
    applyManualHistoryMutation,
    handleInsertMessage,
    handleReorderMessages,
    handleUpdateMessage,
    handleDeleteMessage,
    handleToggleHidden,
    handleTogglePin,
    handleJumpToMessage,
    handleResendMessage,
    handleWithdrawMessage,
    handleRecall,
    handleRegenerateVoice,
    handleReply,
    handleCancelReply,
  };
};
