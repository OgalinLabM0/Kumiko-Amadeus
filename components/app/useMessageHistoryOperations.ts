import { useCallback, type MutableRefObject } from 'react';
import type { Message, Language, BackupConfig, TtsConfig, MemoryQuerySession, SummaryArchiveState } from '../../types';
import { recalculateTurnCountFromMessages } from './backupHelpers';
import { normalizeSummaryArchiveState } from './summaryCycle';
import { getCurrentAIConfig, validateAIConnection } from '../../services/geminiService';
import { getImageBase64 } from '../../services/imageService';
import { synthesizeSpeech } from '../../services/fishAudioService';
import { saveVoiceFile } from '../../services/voiceFileService';

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
      alert(language === 'zh'
        ? '你刚刚修改了真实历史内容，本地 RAG 记忆索引建议重建。'
        : 'You just changed real message history. Rebuilding the local RAG index is recommended.');
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
    const nextMessages = messagesRef.current.filter(msg => msg.id !== id);
    applyManualHistoryMutation(nextMessages, 'hard_delete_message');
  }, [applyManualHistoryMutation]);

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

    const config = getCurrentAIConfig();
    try {
      const isValid = await validateAIConnection(config);
      if (!isValid) {
        setSystemNotice(language === 'zh' ? '连接仍不可用，请检查 API 配置' : 'Connection still unavailable, check API config');
        return;
      }
    } catch {
      setSystemNotice(language === 'zh' ? '连接仍不可用，请检查 API 配置' : 'Connection still unavailable, check API config');
      return;
    }

    setIsDisconnected(false);
    setMessages(prev => prev.map(m =>
      m.id === messageId ? { ...m, sendStatus: 'sending' as const, failReason: undefined } : m
    ));

    pendingTextRef.current = msg.text;
    // Hydrate the resend payload from `imageId` via IPC. Inline `msg.image`
    // was retired in Plan 14 Phase A; messages only carry `imageId` now.
    if (msg.imageId) {
      try {
        const hydrated = await getImageBase64(msg.imageId);
        if (hydrated) {
          pendingImageRef.current = hydrated;
          pendingImageMessageIdRef.current = msg.id;
        }
      } catch (imgErr) {
        console.warn('[handleResend] Failed to hydrate image from imageId:', msg.imageId, imgErr);
      }
    }
    pendingMessageIdsRef.current.add(msg.id);
    generationIdRef.current += 1;
    executeSend();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- preserve original deps [executeSend, language]
  }, [executeSend, language]);

  const handleWithdrawMessage = useCallback((messageId: string) => {
    const msg = messagesRef.current.find(m => m.id === messageId);
    if (!msg || msg.sendStatus !== 'failed') return;

    setMessages(prev => prev.filter(m => m.id !== messageId));
    setInputValue(prev => prev ? prev + '\n' + msg.text : msg.text);

    const remaining = messagesRef.current.filter(m => m.id !== messageId && m.sendStatus === 'failed');
    if (remaining.length === 0) setIsDisconnected(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- preserve original empty deps
  }, []);

  // FIX: Clear pendingImageMessageIdRef on Recall if the recalled message was the one with the image
  const handleRecall = useCallback((id: string) => {
      const msgToRecall = messagesRef.current.find(m => m.id === id);
      if (!msgToRecall) return;

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

    setRegeneratingVoiceIds(prev => {
      const next = new Set(prev);
      next.add(msg.id);
      return next;
    });

    try {
      const textToSpeak = msg.japaneseText || msg.text;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const emotion = msg.storedEmotion || 'neutral';

      const ttsConfigToUse = { ...ttsConfigRef.current };
      if (!ttsConfigToUse.fishAudioApiKey) {
        throw new Error('No API key');
      }

      const result = await synthesizeSpeech(textToSpeak, ttsConfigToUse);

      if (result.audio) {
        const fileId = msg.voiceFileId || msg.id;
        const saveSuccess = await saveVoiceFile(fileId, result.audio);
        if (saveSuccess) {
          handleUpdateMessage(msg.id, {
            voiceFileId: fileId,
            voiceDuration: result.durationEstimate
          });
        }
      }
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
