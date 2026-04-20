import React from 'react';
import { useAppStore } from '../../store';
import type {
  Message,
  EmotionType,
  AnchorEntry,
  AIConfig,
  ChatResponse,
  SummaryArchiveState,
  TtsConfig,
  MemoryQuerySession,
  MissedMessageAlert,
  MessageAlertKind,
  Language,
} from '../../types';
import {
  UI_TRANSLATIONS,
  KUMIKO_LOCAL_RAG_ZH,
  KUMIKO_LOCAL_RAG_EN,
  DEFAULT_TTS_CONFIG,
} from '../../constants';

// P1 #27: previously every call site hard-coded KUMIKO_LOCAL_RAG_ZH regardless of
// the UI language, which meant English-mode sessions had their world book injected
// entirely in Mandarin — Kumiko's replies sometimes leaked Chinese phrasing as a
// result. Centralize the language-aware selection here so every "core lore"
// consumer picks the right locale.
const getKumikoLocalRag = (language?: Language) =>
  language === 'en' ? KUMIKO_LOCAL_RAG_EN : KUMIKO_LOCAL_RAG_ZH;
import {
  sendMessageToGemini,
  getCurrentAIConfig,
  validateAIConnection,
  analyzeTemporalQueryDetailed,
  getTemporalSearchRoleFromQuery,
  rewriteHistoricalRecallQueryDetailed,
  type HistoricalQueryRewrite,
  type HistoricalSearchStrategy,
  type TemporalQueryAnalysis,
  type TemporalQueryDiagnostics,
} from '../../services/geminiService';
import {
  isVoiceServiceAvailable,
} from '../../services/voiceFileService';
import {
  isDesktopElectron,
} from '../../services/desktopBackupService';
import {
  saveLocalRagMemory,
  searchLocalRagMemoryDetailed,
  generateEmbedding,
  type LocalRagEntryKind,
} from '../../services/localRagService';
import { evaluateRagMemoryCandidate, hasRecentRagDuplicate } from '../../services/ragMemoryFilter';
import { loadTemporalEpisodesForRange } from '../../services/temporalEpisodeService';
import { db } from '../../services/db';
import { getAmbientEnvironmentContext } from './ambientContext';
import { yieldToMainThread } from './appUtils';
import {
  parseRelativeReminderRequest,
  parseDailyReminderRequest,
  recalculateTurnCountFromMessages,
} from './backupHelpers';
import {
  resolveHistoricalQueryIntent,
  mapHistoricalRewriteIntent,
  buildExactHistoryLookupBlock,
  buildTemporalHistoryLookupBlock,
  buildTemporalNoEvidenceLookupBlock,
  buildMemoryResponsePlanBlock,
  buildMemoryEvidenceContext,
  buildMemoryEvidenceResponseStrategy,
  buildSemanticRecallEvidenceDescriptors,
  formatSemanticEntryKindSummary,
  formatSemanticEvidenceStrengthSummary,
  formatSemanticQuoteSafeSummary,
  buildHistoricalRecallQueryContext,
  normalizeMemoryQuerySession,
  isMemoryQuerySessionActive,
  isLikelySemanticRecallQuery,
  isLikelyTemporalHistoryQuery,
  isLikelyHistoricalRecallQuery,
  isLikelyHistoricalFollowUp,
  isLikelyHistoricalSessionCarry,
  extractTopicFallbackKeywords,
  isReusableHistoricalSession,
  formatTemporalRangeJst,
  mapRagDecisionTierToStorageTier,
  dotSimilarity,
  hasRichSemanticText,
  type HistoricalQueryIntent,
  type MemoryEvidenceAnswerMode,
  type MemoryEvidenceResponseStrategy,
} from './ragRecallHelpers';
import { buildHistoryEvidenceMessages } from './rawHistorySync';
import {
  evaluateSummaryBoundary,
  getSummarySemanticWindowPayload,
  getSummaryContinuationPayload,
  getTurnsInActiveSummarySegment,
  buildSummarySegmentId,
  normalizeSummaryArchiveState,
  SUMMARY_SOFT_THRESHOLD,
  type SummarySemanticSignal,
} from './summaryCycle';
import {
  SUMMARY_SEMANTIC_CACHE_LIMIT,
} from './appConstants';
import {
  triggerAutoSummary,
  type TriggerAutoSummaryRefs,
  type TriggerAutoSummaryHelpers,
  type TriggerAutoSummaryParams,
} from './summaryActions';
import type { RelativeReminder, DailyReminder } from '../../store/slices/reminderSlice';

// ---------------------------------------------------------------------------
// Shared ref / dep types
// ---------------------------------------------------------------------------

export interface ChatActionRefs {
  messagesRef: React.MutableRefObject<Message[]>;
  generationIdRef: React.MutableRefObject<number>;
  pendingTextRef: React.MutableRefObject<string>;
  pendingImageRef: React.MutableRefObject<string | null>;
  pendingImageMessageIdRef: React.MutableRefObject<string | null>;
  pendingMessageIdsRef: React.MutableRefObject<Set<string>>;
  ttsConfigRef: React.MutableRefObject<TtsConfig>;
  memoryQuerySessionRef: React.MutableRefObject<MemoryQuerySession | null>;
  recentRagDedupeKeysRef: React.MutableRefObject<string[]>;
  countdownIntervalRef: React.MutableRefObject<ReturnType<typeof setInterval> | null>;
  sendTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  preValidationActiveRef: React.MutableRefObject<boolean>;
  pendingSendRef: React.MutableRefObject<(() => void) | null>;
  welcomeTriggeredRef: React.MutableRefObject<boolean>;
  hasGoneToSleepRef: React.MutableRefObject<boolean>;
  sleepWarningTimestampRef: React.MutableRefObject<number | null>;
  sleepFarewellSentRef: React.MutableRefObject<boolean>;
  lateNightWakeRolledRef: React.MutableRefObject<boolean>;
  lateNightWakeResultRef: React.MutableRefObject<boolean>;
  lateNightWakeTimestampRef: React.MutableRefObject<number | null>;
  summaryRunningRef: React.MutableRefObject<boolean>;
  summarySemanticEmbeddingCacheRef: React.MutableRefObject<Map<string, Float32Array>>;
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
}

export interface ExecuteSendHelpers {
  runVoicePipeline: (
    messageId: string,
    chineseText: string,
    emotion: EmotionType,
    voiceVariant?: string,
  ) => Promise<{ success: boolean; voiceFileId?: string; voiceDuration?: number; japaneseText?: string }>;
  deriveSummaryTopicLabel: (
    chunks: string[],
    segmentMessages: Message[],
    summaryText: string,
  ) => string;
}

// ---------------------------------------------------------------------------
// addMessageToStore — standalone helper
// ---------------------------------------------------------------------------

export function addMessageToStore(
  role: 'user' | 'model',
  text: string,
  image?: string,
  sources?: { title: string; uri: string }[],
  customId?: string,
  customTimestamp?: number,
  quoteContext?: { id: string; text: string; role: 'user' | 'model' },
  storedEmotion?: EmotionType,
  imageId?: string,
  voiceExtras?: Partial<Pick<Message, 'isVoiceMessage' | 'voiceFileId' | 'voiceDuration' | 'japaneseText'>>,
): string {
  const newMessage: Message = {
    id: customId || (Date.now().toString() + Math.random().toString()),
    role,
    text,
    timestamp: customTimestamp || Date.now(),
    image,
    imageId,
    groundingSources: sources,
    isRead: role === 'model' ? undefined : false,
    quote: quoteContext,
    storedEmotion,
    ...voiceExtras,
  };
  useAppStore.getState().setMessages((prev) => [...prev, newMessage]);
  return newMessage.id;
}

// ---------------------------------------------------------------------------
// showBackgroundNotification — standalone helper
// ---------------------------------------------------------------------------

export function showBackgroundNotification(
  body: string,
  kind: MessageAlertKind = 'reply',
  messageId?: string,
) {
  const trimmedBody = body.trim();
  if (!trimmedBody || (!document.hidden && document.hasFocus())) {
    return;
  }

  const state = useAppStore.getState();
  const language = state.language;

  if (messageId) {
    const trimmedPreview = trimmedBody;
    state.setMessageAlerts((prev: MissedMessageAlert[]) => {
      const nextAlert: MissedMessageAlert = {
        id: `${kind}-${messageId}`,
        messageId,
        preview: trimmedPreview,
        timestamp: Date.now(),
        kind,
        isRead: false,
      };
      return [nextAlert, ...prev.filter((alert: MissedMessageAlert) => alert.id !== nextAlert.id)].slice(0, 50);
    });
  }

  const title = language === 'zh'
    ? (kind === 'reminder'
        ? '黄前 久美子 · 提醒你一下'
        : '黄前 久美子 发来新消息')
    : (kind === 'reminder'
        ? 'Kumiko · Reminder'
        : 'New message from Kumiko');

  try {
    if (window.electronAPI) {
      window.electronAPI.send('app:send-notification', { title, body: trimmedBody });
    } else {
      const notif = new Notification(title, {
        body: trimmedBody,
        icon: './favicon-KA.ico',
        badge: './favicon-KA.ico',
        tag: kind === 'reminder' ? 'kumiko-reminder' : 'kumiko-message',
        requireInteraction: true,
        silent: false,
      });
      notif.onclick = () => window.focus();
    }
  } catch (e) {
    console.warn('Background message notification failed:', e);
  }
}

// ---------------------------------------------------------------------------
// triggerNativeProactiveMessage
// ---------------------------------------------------------------------------

export async function triggerNativeProactiveMessage(
  refs: Pick<ChatActionRefs, 'welcomeTriggeredRef' | 'hasGoneToSleepRef' | 'sleepWarningTimestampRef' | 'sleepFarewellSentRef' | 'lateNightWakeRolledRef' | 'lateNightWakeResultRef' | 'lateNightWakeTimestampRef'>,
  gapHours: number,
  eventDescription: string,
) {
  const state = useAppStore.getState();
  const { isTalking, isThinking, messages, coreMemory, worldBook, contextLimit, locationConfig, anchors, kumikoNotebook, language } = state;

  // Cloud-sync gate removed (cloud feature dropped).

  if (refs.welcomeTriggeredRef.current || isTalking || isThinking) {
    console.log('[Native Proactive] Blocked: Already triggered or currently active.');
    return;
  }

  refs.welcomeTriggeredRef.current = true;
  refs.hasGoneToSleepRef.current = false;
  refs.sleepWarningTimestampRef.current = null;
  refs.sleepFarewellSentRef.current = false;
  refs.lateNightWakeRolledRef.current = false;
  refs.lateNightWakeResultRef.current = false;
  refs.lateNightWakeTimestampRef.current = null;

  const timeOptions: Intl.DateTimeFormatOptions = {
    timeZone: locationConfig.modelTimezone,
    hour: '2-digit', minute: '2-digit', hour12: false,
  };
  const jstTimeStr = new Date().toLocaleString('en-US', timeOptions);

  const systemPrompt = language === 'zh' ? `[SYSTEM_ACTIVATION_PROTOCOL: 纯净生活挂机模拟]
      你现在要在手机 Line 上主动向用户发一条消息。
      【强制纪律】
      1. 您正在过您自己的生活，此时是日本时间 ${jstTimeStr}。
      2. 您正在经历的状态/事件是：${eventDescription}。
      3. 您【绝对不知道】用户现在在现实里在做什么，也【绝对不能猜测】用户睡没睡。
      4. 严禁使用"你还不睡吗"、"你在屏幕前干嘛"之类带有监控感的越界语句！绝对禁止！
      5. 就像在工作间隙、通勤路上或深夜改作业时突然想到对方，随口抱怨一句日常、分享当下状态、或聊聊秀一。保持极简短，1-2句话，不要显得太黏人。`
  : `[SYSTEM_ACTIVATION_PROTOCOL: Pure Life Simulation]
      You are initiating a message to the user on LINE.
      [STRICT DISCIPLINE]
      1. You are living your own life. It is currently Japan Time ${jstTimeStr}.
      2. Your current status/event: ${eventDescription}.
      3. You absolutely DO NOT KNOW what the user is doing physically, and CANNOT guess if they are awake or asleep.
      4. NEVER use surveillance-like sentences such as "Are you still awake?" or "What are you doing at the screen?".
      5. Keep it natural like you just thought of them during a work break, commute, or late-night grading. Share a quick complaint, current status, or mention Shuichi. Keep it very short (1-2 sentences) and not clingy.`;

  state.setIsThinking(true);

  try {
    const recentMessages = messages.slice(-contextLimit);

    const response = await sendMessageToGemini(
      systemPrompt,
      coreMemory,
      [...worldBook, ...getKumikoLocalRag(language)],
      recentMessages,
      locationConfig,
      undefined, undefined, 0, undefined, [], undefined, [], anchors, kumikoNotebook,
      undefined,
      language,
    );

    useAppStore.getState().setIsThinking(false);
    useAppStore.getState().setIsTalking(true);

    const msgText = response.textParts[0];
    const proactiveMessageId = addMessageToStore('model', msgText, undefined, undefined, undefined, undefined, undefined, response.emotion);
    showBackgroundNotification(msgText, 'proactive', proactiveMessageId);

    if (response.textParts.length > 1) {
      for (let i = 1; i < response.textParts.length; i++) {
        await new Promise(r => setTimeout(r, 1000));
        addMessageToStore('model', response.textParts[i], undefined, undefined, undefined, undefined, undefined, response.emotion);
      }
    }

    setTimeout(() => useAppStore.getState().setIsTalking(false), 2000);

    setTimeout(() => {
      refs.welcomeTriggeredRef.current = false;
      console.log('[Native Proactive] Session lock released. Ready for next proactive trigger.');
    }, 180000);

  } catch (e) {
    console.error('Native Proactive trigger failed', e);
    useAppStore.getState().setIsThinking(false);
    refs.welcomeTriggeredRef.current = false;
  }
}

// ---------------------------------------------------------------------------
// triggerTimedReminderMessage
// ---------------------------------------------------------------------------

export async function triggerTimedReminderMessage(
  refs: Pick<ChatActionRefs, 'messagesRef' | 'ttsConfigRef'>,
  helpers: Pick<ExecuteSendHelpers, 'runVoicePipeline'>,
  reminder: Pick<RelativeReminder, 'event' | 'sourceText'> | Pick<DailyReminder, 'event' | 'sourceText'>,
): Promise<boolean> {
  const state = useAppStore.getState();
  const { language, contextLimit, coreMemory, worldBook, locationConfig, anchors, kumikoNotebook } = state;

  const userTimeStr = new Date().toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
    timeZone: locationConfig.userTimezone,
    weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const systemPrompt = language === 'zh' ? `[SYSTEM_ACTIVATION_PROTOCOL: 约好时间的提醒]
      之前用户拜托过你到时间提醒这件事，现在已经到点了。
      要提醒的事：${reminder.event}
      ${reminder.sourceText ? `用户当时大意是：${reminder.sourceText}` : ''}
      【重要时区注意】：用户当前所在时区的本地时间是 ${userTimeStr}。请严格根据【用户的时间】来判断用户的作息状态。如果用户那边是晚上，绝对不要说"早上好"或让用户"别赖床"。
      规则：
      1. 像黄前久美子本人突然想起来后给对方发一条 Line 一样自然。
      2. 直接用祈使句催促，例如"快去洗衣服！""该吃饭了！""别忘了喝水！"，而不是"喊用户去xxx"这种描述式。
      3. 保持简短，1-2句话就够，可以轻轻催一下或顺手吐槽一句。
      4. 不要提系统、定时器、倒计时、自动触发、后台、模块。`
  : `[SYSTEM_ACTIVATION_PROTOCOL: PROMISED REMINDER]
      The user asked you earlier to remind them when the time came, and now it is due.
      Reminder topic: ${reminder.event}
      ${reminder.sourceText ? `Original request context: ${reminder.sourceText}` : ''}
      [CRITICAL TIMEZONE NOTE]: The user's current local time is ${userTimeStr}. Strictly base your greeting and context on the USER'S time. Do not say "good morning" or "wake up" if it's evening for the user.
      Rules:
      1. Sound like Kumiko herself suddenly remembering and sending a LINE message.
      2. Use direct imperative phrases like "Go do laundry!" "Time to eat!" rather than descriptive phrases like "remind user to do X".
      3. Keep it short, just 1-2 natural lines, with maybe a light nudge or tiny complaint.
      4. Do not mention systems, timers, countdowns, automation, background tasks, or modules.`;

  state.setIsThinking(true);

  try {
    const recentMessages = refs.messagesRef.current.slice(-contextLimit);
    const response = await sendMessageToGemini(
      systemPrompt,
      coreMemory,
      [...worldBook, ...getKumikoLocalRag(language)],
      recentMessages,
      locationConfig,
      undefined, undefined, 0, undefined, [], undefined, [], anchors, kumikoNotebook,
      undefined,
      language,
    );

    const s = useAppStore.getState();
    s.setCurrentEmotion(response.emotion);
    if (response.systemNotice) {
      s.setSystemNotice(response.systemNotice);
    }

    const firstText = response.textParts[0] || (language === 'zh' ? `喂$该去${reminder.event}了吧` : `Hey. Time to ${reminder.event}.`);
    const combinedReminderText = response.textParts.join(' ');
    const currentTtsCfg = refs.ttsConfigRef.current;

    if (currentTtsCfg.voiceMode !== 'text' && (currentTtsCfg.fishAudioApiKey || currentTtsCfg.ttsBackend === 'sovits') && isVoiceServiceAvailable()) {
      useAppStore.getState().setIsThinking(false);

      const isInForeground = !document.hidden && document.hasFocus();

      if (isInForeground) {
        useAppStore.getState().setIsTalking(true);
        const voiceResult = await helpers.runVoicePipeline('reminder-' + Date.now(), combinedReminderText, response.emotion);
        if (voiceResult.success) {
          addMessageToStore('model', combinedReminderText, undefined, undefined, undefined, undefined, undefined, response.emotion, undefined, {
            isVoiceMessage: true, voiceFileId: voiceResult.voiceFileId, voiceDuration: voiceResult.voiceDuration, japaneseText: voiceResult.japaneseText,
          });
        } else {
          addMessageToStore('model', combinedReminderText, undefined, undefined, undefined, undefined, undefined, response.emotion);
        }
        setTimeout(() => useAppStore.getState().setIsTalking(false), 2000);
        return true;
      }

      let voiceResultPromise = helpers.runVoicePipeline('reminder-' + Date.now(), combinedReminderText, response.emotion);

      const notifBody = combinedReminderText ? combinedReminderText.slice(0, 50) : reminder.event;
      if (isDesktopElectron()) {
        window.electronAPI?.send('app:send-call-notification', {
          title: language === 'zh' ? '黄前久美子 来电...' : 'Incoming Call: Kumiko Oumae',
          body: notifBody,
        });
      } else if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(language === 'zh' ? '黄前久美子 来电...' : 'Incoming Call: Kumiko Oumae', {
          body: notifBody,
        });
      }

      return new Promise<boolean>((resolve) => {
        useAppStore.getState().setVoiceCallOverlayData({
          reminderEvent: reminder.event,
          reminderText: combinedReminderText,
          emotion: response.emotion,
          onAccept: async () => {
            useAppStore.getState().setIsTalking(true);
            useAppStore.getState().setVoiceCallOverlayData((prev: any) => prev ? { ...prev, isConnecting: true } : null);
            if (isDesktopElectron()) window.electronAPI?.send('app:close-call-notification');

            const voiceResult = await voiceResultPromise;

            if (voiceResult.success) {
              const voiceMsgId = addMessageToStore('model', combinedReminderText, undefined, undefined, undefined, undefined, undefined, response.emotion, undefined, {
                isVoiceMessage: true, voiceFileId: voiceResult.voiceFileId, voiceDuration: voiceResult.voiceDuration, japaneseText: voiceResult.japaneseText,
              });
              showBackgroundNotification(combinedReminderText, 'reminder', voiceMsgId);
              const buf = await (await import('../../services/voiceFileService')).loadVoiceFile(voiceResult.voiceFileId!);
              if (buf) {
                useAppStore.getState().setVoiceCallOverlayData((prev: any) => prev ? { ...prev, isConnecting: false, isPlayingVoice: true } : null);

                const blob = new Blob([buf], { type: 'audio/mpeg' });
                const url = URL.createObjectURL(blob);
                const audio = new Audio(url);
                audio.onended = () => {
                  URL.revokeObjectURL(url);
                  useAppStore.getState().setVoiceCallOverlayData((prev: any) => prev ? { ...prev, isPlayingVoice: false, isEnded: true } : null);
                  useAppStore.getState().setIsTalking(false);
                };
                audio.play().catch(() => {
                  useAppStore.getState().setVoiceCallOverlayData(null);
                  useAppStore.getState().setIsTalking(false);
                  resolve(true);
                });
              } else {
                useAppStore.getState().setVoiceCallOverlayData(null);
                useAppStore.getState().setIsTalking(false);
                resolve(true);
              }
            } else {
              addMessageToStore('model', combinedReminderText, undefined, undefined, undefined, undefined, undefined, response.emotion);
              useAppStore.getState().setVoiceCallOverlayData(null);
              useAppStore.getState().setIsTalking(false);
              resolve(true);
            }
          },
          onReject: () => {
            if (isDesktopElectron()) window.electronAPI?.send('app:close-call-notification');
            useAppStore.getState().setVoiceCallOverlayData(null);
            resolve(true);
          },
          onClose: () => {
            useAppStore.getState().setVoiceCallOverlayData(null);
            resolve(true);
          },
        });
      });
    }

    useAppStore.getState().setIsThinking(false);
    useAppStore.getState().setIsTalking(true);

    const reminderMessageId = addMessageToStore('model', firstText, undefined, undefined, undefined, undefined, undefined, response.emotion);
    showBackgroundNotification(firstText, 'reminder', reminderMessageId);

    if (response.textParts.length > 1) {
      for (let i = 1; i < response.textParts.length; i++) {
        await new Promise(r => setTimeout(r, 1000));
        addMessageToStore('model', response.textParts[i], undefined, undefined, undefined, undefined, undefined, response.emotion);
      }
    }

    setTimeout(() => useAppStore.getState().setIsTalking(false), 2000);
    console.log(`[TIMED REMINDER] Delivered: ${reminder.event}`);
    return true;
  } catch (e) {
    console.error('[TIMED REMINDER] Delivery failed', e);
    useAppStore.getState().setIsThinking(false);
    useAppStore.getState().setIsTalking(false);
    return false;
  }
}

// ---------------------------------------------------------------------------
// executeSend
// ---------------------------------------------------------------------------

export async function executeSend(
  refs: ChatActionRefs,
  helpers: ExecuteSendHelpers,
) {
  const state = useAppStore.getState();
  const { coreMemory, worldBook, contextLimit, locationConfig, backupConfig, anchors, kumikoNotebook, turnCount, language, summaryArchiveState } = state;

  let combinedText = refs.pendingTextRef.current;
  const finalImage = refs.pendingImageRef.current;
  const pendingImgId = refs.pendingImageMessageIdRef.current;
  const currentPendingIds = new Set(refs.pendingMessageIdsRef.current);
  const currentTurnStartMessageId = refs.messagesRef.current
    .filter(msg => currentPendingIds.has(msg.id))
    .sort((a, b) => a.timestamp - b.timestamp)[0]?.id ?? null;
  const userTextForRag = combinedText;

  refs.pendingTextRef.current = '';
  refs.pendingImageRef.current = null;
  refs.pendingMessageIdsRef.current.clear();
  refs.pendingImageMessageIdRef.current = null;

  if (refs.countdownIntervalRef.current) clearInterval(refs.countdownIntervalRef.current);
  state.setTimeLeft(0);
  state.setIsListening(false);

  state.setMessages((prev: Message[]) => prev.map(msg =>
    currentPendingIds.has(msg.id) ? { ...msg, sendStatus: 'sending' as const } : msg,
  ));

  const currentGenId = refs.generationIdRef.current;

  let isImageMessage = !!finalImage;
  let savedImageUrl: string | null = null;

  try {
    let apiImage = undefined;
    let mimeType = 'image/jpeg';
    if (finalImage) {
      const match = finalImage.match(/^data:(.*);base64,(.*)$/);
      if (match) {
        mimeType = match[1];
        apiImage = match[2];
      }
    }

    const allMessages = refs.messagesRef.current.filter(msg => !currentPendingIds.has(msg.id));
    const recentMessages = allMessages.slice(-contextLimit);
    const pinnedMessages = allMessages.filter(msg => msg.isPinned);
    const gapSincePreviousTurnMinutes = allMessages.length > 0
      ? Math.max(0, (Date.now() - allMessages[allMessages.length - 1].timestamp) / 60000)
      : Number.POSITIVE_INFINITY;

    const historyMap = new Map();
    [...pinnedMessages, ...recentMessages].forEach(m => historyMap.set(m.id, m));
    const historySlice = Array.from(historyMap.values()).sort((a, b) => a.timestamp - b.timestamp);

    const ambientEnvironmentContext = await getAmbientEnvironmentContext();
    const isCurrentHoliday = ambientEnvironmentContext.includes('今日特殊历法：日本法定节假日');

    // --- RETROACTIVE LIFE STREAM GENERATION ---
    if (allMessages.length > 0 && gapSincePreviousTurnMinutes > 3 * 60) {
      useAppStore.getState().setIsThinking(true);
      const { handleRetroactiveGeneration, detectDiaryGaps } = await import('../../services/lifeStreamService');
      await handleRetroactiveGeneration(
        allMessages[allMessages.length - 1].timestamp,
        ambientEnvironmentContext,
        isCurrentHoliday,
        locationConfig.modelTimezone,
      );
      useAppStore.getState().setIsThinking(false);

      const gapInfo = await detectDiaryGaps();
      if (gapInfo.totalMissing > 0) {
        if (state.isAutoDiaryBackfillEnabled()) {
          void state.runAutoDiaryBackfill(gapInfo);
        } else {
          state.setBackfillGapInfo(gapInfo);
          await new Promise<void>(resolve => { refs.pendingSendRef.current = resolve; });
        }
      }
    }

    // --- DYNAMIC DELAY (BUSY STATE) INTERCEPTOR ---
    const { getDetailedScheduleSlot } = await import('../../services/kumikoStateMachine');
    const scheduleSlot = getDetailedScheduleSlot(locationConfig.modelTimezone, isCurrentHoliday);

    if (scheduleSlot.interceptChance > 0 && Math.random() < scheduleSlot.interceptChance) {
      useAppStore.getState().setIsThinking(true);
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
      useAppStore.getState().setIsThinking(false);

      const getBusyReply = (): string => {
        const isZh = language === 'zh';
        if (scheduleSlot.slotType === 'teaching') {
          const pNum = scheduleSlot.periodNumber || 0;
          const zhReplies = [
            `在上课呢，第${pNum}节还没下课，等一下`,
            `${scheduleSlot.classGroup || ''}的课还没完，下课再说`,
            '现在不方便，课上呢',
            '等下课再回你，马上',
          ];
          const enReplies = [
            `In class right now, period ${pNum} isn't over yet. Give me a sec`,
            "Can't talk, I'm teaching. I'll reply after class",
            'Hold on, still in the middle of a lesson',
            'Busy with class, brb',
          ];
          const pool = isZh ? zhReplies : enReplies;
          return pool[Math.floor(Math.random() * pool.length)];
        } else if (scheduleSlot.slotType === 'shr') {
          return isZh ? '朝会中，马上回你' : 'In morning assembly, one sec';
        } else {
          const zhReplies = ['社团那边有点事，等下回你', '抱歉，现在有点忙，晚点回你'];
          const enReplies = ["Busy with club stuff, I'll get back to you", 'Sorry, a bit busy right now'];
          const pool = isZh ? zhReplies : enReplies;
          return pool[Math.floor(Math.random() * pool.length)];
        }
      };

      const reply = getBusyReply();
      const msgId = addMessageToStore('model', reply, undefined, undefined, undefined, undefined, undefined, 'serious');
      showBackgroundNotification(reply, 'reply', msgId);

      const followUpDelay = scheduleSlot.slotType === 'teaching'
        ? 10 * 60000 + Math.random() * 20 * 60000
        : 5 * 60000 + Math.random() * 10 * 60000;
      setTimeout(() => {
        triggerNativeProactiveMessage(refs, 0, language === 'zh' ? '忙完了，继续刚才的话题' : 'Done with that, where were we?');
      }, followUpDelay);

      return;
    }

    // --- MEMORY / RAG RESOLUTION ---
    const currentLooksHistoryLike = isLikelyHistoricalRecallQuery(userTextForRag)
      || isLikelyTemporalHistoryQuery(userTextForRag)
      || isLikelyHistoricalFollowUp(userTextForRag)
      || isLikelyHistoricalSessionCarry(userTextForRag)
      || isLikelySemanticRecallQuery(userTextForRag);
    if (!currentLooksHistoryLike
      && !(refs.memoryQuerySessionRef.current?.kind === 'topic_search'
           && isMemoryQuerySessionActive(refs.memoryQuerySessionRef.current))) {
      updateMemoryQuerySessionRef(refs, null);
    }

    const historyQueryContextResolution = buildHistoricalRecallQueryContext(allMessages, userTextForRag, refs.memoryQuerySessionRef.current);
    const rawHistoryQueryContext = historyQueryContextResolution.queryText;
    let historyQueryContext = rawHistoryQueryContext;
    let historyQueryRewrite: HistoricalQueryRewrite | null = null;
    let historyQueryRewriteError: string | null = null;
    const shouldRewriteHistoricalQuery = currentLooksHistoryLike
      || historyQueryContextResolution.source !== 'self'
      || isMemoryQuerySessionActive(refs.memoryQuerySessionRef.current);
    if (shouldRewriteHistoricalQuery) {
      const rewriteResult = await rewriteHistoricalRecallQueryDetailed(rawHistoryQueryContext, locationConfig, {
        bypassGate: refs.memoryQuerySessionRef.current?.kind === 'topic_search',
        recentMessages: allMessages.slice(-6),
      });
      historyQueryRewrite = rewriteResult.rewrite;
      historyQueryRewriteError = rewriteResult.errorMessage;
      if (historyQueryRewrite?.rewrittenQuery) {
        historyQueryContext = historyQueryRewrite.rewrittenQuery;
      }
    }
    const historicalQueryIntent = mapHistoricalRewriteIntent(historyQueryRewrite?.intent)
      ?? resolveHistoricalQueryIntent(userTextForRag, historyQueryContext, refs.memoryQuerySessionRef.current);
    const shouldLoadHistoryEvidence = historicalQueryIntent === 'exact'
      || historicalQueryIntent === 'temporal'
      || (isMemoryQuerySessionActive(refs.memoryQuerySessionRef.current) && historyQueryContextResolution.source !== 'self');
    const historyEvidenceMessages = shouldLoadHistoryEvidence
      ? await buildHistoryEvidenceMessages(allMessages)
      : allMessages;
    const historyEvidenceSource = shouldLoadHistoryEvidence
      ? (historyEvidenceMessages.length > 0 ? 'db_messages_only' : 'live_state_only')
      : 'live_state_only';
    const exactHistoryLookup = buildExactHistoryLookupBlock(historyEvidenceMessages, historyQueryContext);
    let historyLookup = exactHistoryLookup;
    let memoryRoute: 'recent_only' | 'exact_history' | 'temporal_history' | 'fuzzy_rag' = exactHistoryLookup?.strict
      ? 'exact_history'
      : 'recent_only';
    let semanticRoleConstraint: 'user' | 'model' | 'any' | null = null;
    let semanticEntryKindSummary: Record<LocalRagEntryKind, number> | null = null;
    let semanticDominantEntryKind: LocalRagEntryKind | null = null;
    let semanticEvidenceSectionCount = 0;
    let semanticEvidenceStrengthSummary: string | null = null;
    let semanticQuoteSafeSummary: string | null = null;
    let semanticEnvelopeEntryMix: string | null = null;
    let semanticAnswerMode: MemoryEvidenceAnswerMode | null = null;
    let semanticResponseStrategy: MemoryEvidenceResponseStrategy | null = null;
    let semanticConfidenceLevel: 'high' | 'medium' | 'low' | null = null;
    let temporalEpisodeCount = 0;

    let ragContext: string[] = [];
    let temporalIntent: TemporalQueryAnalysis | null = null;
    let temporalDiagnostics: TemporalQueryDiagnostics | null = null;
    if (backupConfig.ragEnabled && !historyLookup?.strict) {
      useAppStore.getState().setRagStatus('RECALLING');
      try {
        const shouldAnalyzeTemporal = historicalQueryIntent === 'temporal';
        console.log('[TEMPORAL ROUTE CHECK]', {
          likelyTemporal: isLikelyTemporalHistoryQuery(userTextForRag),
          likelyHistoricalRecall: isLikelyHistoricalRecallQuery(historyQueryContext),
          historicalQueryIntent,
          augmentedQueryUsed: historyQueryContextResolution.source !== 'self',
          augmentationSource: historyQueryContextResolution.source,
          sessionReuseBlockedReason: historyQueryContextResolution.sessionReuseBlockedReason ?? null,
          augmentedQueryPreview: historyQueryContextResolution.source !== 'self' ? historyQueryContext.slice(0, 160) : null,
          rewrittenQueryApplied: !!historyQueryRewrite?.rewrittenQuery && historyQueryRewrite.rewrittenQuery !== rawHistoryQueryContext,
          rewrittenQueryPreview: historyQueryRewrite?.rewrittenQuery ? historyQueryRewrite.rewrittenQuery.slice(0, 160) : null,
          rewrittenIntent: historyQueryRewrite?.intent ?? null,
          rewrittenSearchStrategy: historyQueryRewrite?.searchStrategy ?? null,
          rewrittenSearchKeywords: historyQueryRewrite?.searchKeywords ?? null,
          rewrittenTopicQuery: historyQueryRewrite?.topicQuery ?? null,
          rewrittenConfidence: historyQueryRewrite?.confidence ?? null,
          rewrittenSearchRole: historyQueryRewrite?.searchRole ?? null,
          rewriteError: historyQueryRewriteError,
          previousQueryPreview: historyQueryContextResolution.previousQueryPreview,
          activeQuerySession: refs.memoryQuerySessionRef.current ? {
            kind: refs.memoryQuerySessionRef.current.kind,
            lookupMode: refs.memoryQuerySessionRef.current.lookupMode,
            targetSpeaker: refs.memoryQuerySessionRef.current.targetSpeaker,
            reusable: isReusableHistoricalSession(refs.memoryQuerySessionRef.current),
            parserStatus: refs.memoryQuerySessionRef.current.parserStatus ?? null,
            parserSource: refs.memoryQuerySessionRef.current.parserSource ?? null,
            parserPrecision: refs.memoryQuerySessionRef.current.parserPrecision ?? null,
            parserConfidence: refs.memoryQuerySessionRef.current.parserConfidence ?? null,
            lastEvidenceSource: refs.memoryQuerySessionRef.current.lastEvidenceSource ?? 'none',
            confidenceLevel: refs.memoryQuerySessionRef.current.confidenceLevel ?? 'low',
          } : null,
        });
        const temporalAnalysisResult = shouldAnalyzeTemporal
          ? await analyzeTemporalQueryDetailed(historyQueryContext, locationConfig)
          : null;
        temporalIntent = temporalAnalysisResult?.analysis ?? null;
        temporalDiagnostics = temporalAnalysisResult?.diagnostics ?? null;
        if (!temporalIntent && shouldAnalyzeTemporal && isReusableHistoricalSession(refs.memoryQuerySessionRef.current) && refs.memoryQuerySessionRef.current?.kind === 'temporal_history') {
          temporalIntent = {
            isTemporalQuery: true,
            startTimestampJST: refs.memoryQuerySessionRef.current.startTimestampJST ?? null,
            endTimestampJST: refs.memoryQuerySessionRef.current.endTimestampJST ?? null,
            searchRole: refs.memoryQuerySessionRef.current.searchRole ?? 'any',
            precision: refs.memoryQuerySessionRef.current.parserPrecision ?? null,
            source: refs.memoryQuerySessionRef.current.parserSource ?? 'local_heuristic',
            confidence: refs.memoryQuerySessionRef.current.parserConfidence ?? 'low',
          };
          temporalDiagnostics = {
            status: 'session_fallback',
            source: temporalIntent.source,
            precision: temporalIntent.precision,
            confidence: temporalIntent.confidence,
            errorMessage: temporalAnalysisResult?.diagnostics.errorMessage ?? null,
            outputPreview: temporalAnalysisResult?.diagnostics.outputPreview ?? null,
          };
        }
        const temporalEpisodes = shouldAnalyzeTemporal && temporalIntent?.isTemporalQuery
          ? await loadTemporalEpisodesForRange(temporalIntent.startTimestampJST, temporalIntent.endTimestampJST, { limit: 8 })
          : [];
        temporalEpisodeCount = temporalEpisodes.length;
        const temporalHistoryLookup = shouldAnalyzeTemporal
          ? (buildTemporalHistoryLookupBlock(historyEvidenceMessages, temporalIntent, temporalEpisodes, historyQueryContext) || buildTemporalNoEvidenceLookupBlock(historyQueryContext, temporalIntent, refs.memoryQuerySessionRef.current, temporalDiagnostics))
          : null;
        const llmSearchStrategy: HistoricalSearchStrategy | null = historyQueryRewrite?.searchStrategy ?? null;
        const shouldRunSemanticRag = historicalQueryIntent === 'semantic'
          || llmSearchStrategy === 'topic_search'
          || (llmSearchStrategy === 'temporal_range' && !temporalHistoryLookup?.strict);
        if (temporalHistoryLookup?.strict) {
          historyLookup = temporalHistoryLookup;
          memoryRoute = 'temporal_history';
          useAppStore.getState().setRagStatus('IDLE');
        } else if (shouldRunSemanticRag) {
          const semanticSearchQuery = historyQueryRewrite?.topicQuery || historyQueryContext;
          semanticRoleConstraint = historyQueryRewrite?.searchRole ?? getTemporalSearchRoleFromQuery(historyQueryContext);
          const effectiveKeywords = historyQueryRewrite?.searchKeywords
            || (refs.memoryQuerySessionRef.current?.kind === 'topic_search'
                ? extractTopicFallbackKeywords(userTextForRag)
                : undefined);
          const semanticRecall = await searchLocalRagMemoryDetailed(
            semanticSearchQuery,
            getCurrentAIConfig(),
            3,
            semanticRoleConstraint !== 'any' ? { role: semanticRoleConstraint } : undefined,
            'semantic_recall',
            effectiveKeywords,
          );
          semanticEntryKindSummary = semanticRecall.entryKindSummary;
          semanticDominantEntryKind = semanticRecall.dominantEntryKind;
          const semanticEvidenceSummary = formatSemanticEntryKindSummary(semanticRecall.entryKindSummary);
          const semanticEvidenceDescriptors = buildSemanticRecallEvidenceDescriptors(semanticRecall.groupedBlocks);
          semanticEvidenceSectionCount = semanticEvidenceDescriptors.length;
          semanticEvidenceStrengthSummary = formatSemanticEvidenceStrengthSummary(semanticRecall.groupedBlocks);
          semanticQuoteSafeSummary = formatSemanticQuoteSafeSummary(semanticRecall.groupedBlocks);
          semanticEnvelopeEntryMix = semanticEvidenceSummary || 'none';
          semanticConfidenceLevel = semanticEvidenceDescriptors.length > 0
            ? (semanticRecall.dominantEntryKind === 'message' ? 'high' : 'medium')
            : 'low';
          const semanticEvidenceContext = buildMemoryEvidenceContext({
            marker: '[SEMANTIC_RECALL_EVIDENCE]',
            intent: 'semantic_recall',
            answerMode: 'thematic_summary_with_support',
            confidenceLevel: semanticConfidenceLevel,
            primaryEvidence: semanticRecall.dominantEntryKind || 'unknown',
            entryMix: semanticEnvelopeEntryMix,
            evidenceStrengths: semanticEvidenceStrengthSummary || 'none',
            quoteSafeKinds: semanticQuoteSafeSummary || 'none',
            sections: semanticEvidenceDescriptors,
          });
          semanticAnswerMode = 'thematic_summary_with_support';
          semanticResponseStrategy = buildMemoryEvidenceResponseStrategy(
            'thematic_summary_with_support',
            semanticConfidenceLevel,
            semanticQuoteSafeSummary || 'none',
          );
          ragContext = semanticEvidenceDescriptors.length > 0
            ? semanticEvidenceContext
            : [];
          memoryRoute = ragContext.length > 0 ? 'fuzzy_rag' : 'recent_only';
          useAppStore.getState().setRagStatus('IDLE');
        } else {
          memoryRoute = 'recent_only';
          useAppStore.getState().setRagStatus('IDLE');
        }
      } catch (e) {
        console.warn('RAG Recall failed', e);
        useAppStore.getState().setRagStatus('ERROR');
      }
    } else if (historyLookup?.strict) {
      useAppStore.getState().setRagStatus(backupConfig.ragEnabled ? 'IDLE' : 'OFF');
    }

    // --- SESSION MANAGEMENT ---
    if (historyLookup?.strict) {
      const now = Date.now();
      const previousSession = refs.memoryQuerySessionRef.current;
      const nextSession: MemoryQuerySession = {
        kind: memoryRoute === 'temporal_history' ? 'temporal_history' : 'exact_history',
        sourceQuery: historyQueryContext,
        lookupMode: historyLookup.mode,
        targetSpeaker: historyLookup.targetSpeaker ?? null,
        searchRole: temporalIntent?.searchRole ?? previousSession?.searchRole ?? null,
        startTimestampJST: temporalIntent?.startTimestampJST ?? previousSession?.startTimestampJST ?? null,
        endTimestampJST: temporalIntent?.endTimestampJST ?? previousSession?.endTimestampJST ?? null,
        parserStatus: memoryRoute === 'temporal_history'
          ? (temporalDiagnostics?.status ?? historyLookup?.parserStatus ?? previousSession?.parserStatus ?? null) : null,
        parserSource: memoryRoute === 'temporal_history'
          ? (temporalIntent?.source ?? previousSession?.parserSource ?? null) : null,
        parserPrecision: memoryRoute === 'temporal_history'
          ? (temporalIntent?.precision ?? previousSession?.parserPrecision ?? null) : null,
        parserConfidence: memoryRoute === 'temporal_history'
          ? (temporalIntent?.confidence ?? previousSession?.parserConfidence ?? null) : null,
        resultCount: historyLookup.matchedCount,
        lastEvidenceSource: historyLookup.evidenceMode ?? 'none',
        confidenceLevel: historyLookup.confidenceLevel ?? 'low',
        createdAt: previousSession?.createdAt ?? now,
        lastUsedAt: now,
      };
      const canPersistTemporalSession = nextSession.kind !== 'temporal_history'
        || isReusableHistoricalSession(nextSession);
      updateMemoryQuerySessionRef(refs, canPersistTemporalSession ? nextSession : null);
    } else if (memoryRoute === 'fuzzy_rag' && historyQueryRewrite?.searchStrategy === 'topic_search') {
      const now = Date.now();
      updateMemoryQuerySessionRef(refs, {
        kind: 'topic_search',
        sourceQuery: historyQueryRewrite?.topicQuery || historyQueryContext,
        lookupMode: 'temporal_window',
        targetSpeaker: null,
        searchRole: historyQueryRewrite?.searchRole ?? 'any',
        resultCount: ragContext.length,
        lastEvidenceSource: 'episodes',
        confidenceLevel: semanticConfidenceLevel ?? 'low',
        createdAt: refs.memoryQuerySessionRef.current?.createdAt ?? now,
        lastUsedAt: now,
      });
    } else if (!currentLooksHistoryLike && historyQueryContextResolution.source === 'self') {
      updateMemoryQuerySessionRef(refs, null);
    } else if (refs.memoryQuerySessionRef.current) {
      updateMemoryQuerySessionRef(refs, {
        ...refs.memoryQuerySessionRef.current,
        sourceQuery: historyQueryContextResolution.source === 'self'
          ? refs.memoryQuerySessionRef.current.sourceQuery
          : historyQueryContext,
        parserStatus: temporalDiagnostics?.status ?? historyLookup?.parserStatus ?? refs.memoryQuerySessionRef.current.parserStatus ?? null,
        parserSource: temporalIntent?.source ?? refs.memoryQuerySessionRef.current.parserSource ?? null,
        parserPrecision: temporalIntent?.precision ?? refs.memoryQuerySessionRef.current.parserPrecision ?? null,
        parserConfidence: temporalIntent?.confidence ?? historyLookup?.parserConfidence ?? refs.memoryQuerySessionRef.current.parserConfidence ?? null,
        lastEvidenceSource: historyLookup?.evidenceMode ?? refs.memoryQuerySessionRef.current.lastEvidenceSource ?? 'none',
        confidenceLevel: historyLookup?.confidenceLevel ?? refs.memoryQuerySessionRef.current.confidenceLevel ?? 'low',
        lastUsedAt: Date.now(),
      });
    }

    const strictEvidenceTurn = !!historyLookup?.strict;
    const memoryResponsePlanBlock = strictEvidenceTurn
      ? buildMemoryResponsePlanBlock({
          route: memoryRoute === 'temporal_history' ? 'temporal_history' : 'exact_history',
          responseStrategy: historyLookup?.responseStrategy ?? null,
          answerMode: historyLookup?.answerMode ?? null,
          confidenceLevel: historyLookup?.confidenceLevel ?? null,
          primaryEvidenceKind: historyLookup?.primaryEvidenceKind ?? null,
          quoteSafeKinds: historyLookup?.quoteSafeKinds ?? null,
          entryMixSummary: historyLookup?.entryMixSummary ?? null,
          targetSpeaker: historyLookup?.targetSpeaker ?? null,
          parserPrecision: historyLookup?.parserPrecision ?? null,
        })
      : (memoryRoute === 'fuzzy_rag'
        ? buildMemoryResponsePlanBlock({
            route: 'fuzzy_rag',
            responseStrategy: semanticResponseStrategy,
            answerMode: semanticAnswerMode,
            confidenceLevel: semanticConfidenceLevel,
            primaryEvidenceKind: semanticDominantEntryKind,
            quoteSafeKinds: semanticQuoteSafeSummary,
            entryMixSummary: semanticEnvelopeEntryMix,
            targetSpeaker: semanticRoleConstraint === 'user'
              ? 'User'
              : semanticRoleConstraint === 'model'
                ? 'Kumiko'
                : 'Any',
            parserPrecision: null,
          })
        : null);

    console.log(`[MEMORY ROUTE] ${memoryRoute}`, {
      strictLookup: historyLookup?.strict ?? false,
      lookupFound: historyLookup?.found ?? false,
      lookupMode: historyLookup?.mode ?? null,
      historicalQueryIntent,
      historyEvidenceSource,
      memoryResponsePlanBuilt: !!memoryResponsePlanBlock,
      ragBlocks: ragContext.length,
    });

    const checkActiveReminders = async (): Promise<string[]> => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const existingEvents = await db.getVal('kumiko_schedule_events', []);
        return existingEvents.filter((e: any) => e.date === today).map((e: any) => e.event);
      } catch { return []; }
    };

    const activeReminders = await checkActiveReminders();
    const modelHistorySlice = strictEvidenceTurn ? historySlice.slice(-4) : historySlice;
    const modelCoreMemory = strictEvidenceTurn ? '' : coreMemory;
    const modelWorldBook = strictEvidenceTurn ? [] : [...worldBook, ...getKumikoLocalRag(language)];
    const modelRagContext = strictEvidenceTurn
      ? []
      : (memoryResponsePlanBlock ? [memoryResponsePlanBlock, ...ragContext] : ragContext);

    if (!strictEvidenceTurn && ambientEnvironmentContext) {
      modelRagContext.push(ambientEnvironmentContext);
    }

    const modelActiveReminders = strictEvidenceTurn ? [] : activeReminders;
    const modelAnchors = strictEvidenceTurn ? [] : anchors;
    const modelNotebook = strictEvidenceTurn ? '' : kumikoNotebook;
    const modelExactHistoryLookup = historyLookup?.promptBlock
      ? (strictEvidenceTurn && memoryResponsePlanBlock
        ? `${memoryResponsePlanBlock}\n${historyLookup.promptBlock}`
        : historyLookup.promptBlock)
      : undefined;

    // --- STATE MACHINE INJECTION ---
    const isCurrentHolidayState = ambientEnvironmentContext.includes('今日特殊历法：日本法定节假日');
    const { getCurrentKumikoState, getDetailedScheduleSlot: getScheduleForPrompt } = await import('../../services/kumikoStateMachine');
    const currentStateCtx = getCurrentKumikoState(locationConfig.modelTimezone, isCurrentHolidayState);
    const scheduleForPrompt = getScheduleForPrompt(locationConfig.modelTimezone, isCurrentHolidayState);

    let stateDetail = currentStateCtx.stateDescription;
    if (scheduleForPrompt.slotType === 'teaching' && scheduleForPrompt.classGroup) {
      stateDetail = scheduleForPrompt.description;
    } else if (scheduleForPrompt.slotType === 'free' && scheduleForPrompt.freeActivity) {
      stateDetail = scheduleForPrompt.description;
    } else if (scheduleForPrompt.slotType === 'school_prep') {
      stateDetail = scheduleForPrompt.description;
    }

    const statePrompt = language === 'zh'
      ? `\n[当前生活状态]\n你现在正处于：${stateDetail}。\n请在回复中自然地体现出这个状态（例如：如果在上课中途偷看手机，回复应该极短且匆忙；如果在空档备课，可以稍微聊几句但带着忙碌感；如果在午休或下班后在家，则可以正常聊天）。不要生硬地报告你的状态，而是通过语气和长度自然流露。`
      : `\n[Current Life State]\nYou are currently: ${stateDetail}.\nReflect this naturally in your reply (e.g., if you're sneaking a look at your phone during class, keep it extremely brief; if you're on a free period doing prep work, you can chat a bit but still sound busy; if you're at lunch or home after work, chat normally). Don't explicitly announce your state—let it show through tone and length.`;

    if (!strictEvidenceTurn) {
      modelRagContext.push(statePrompt);
    }

    // --- LIFE STREAM & PSYCHE STATE INJECTION ---
    if (!strictEvidenceTurn) {
      const { getPsycheState, getPsycheModePrompt } = await import('../../services/psycheStateService');
      const psycheState = await getPsycheState();
      const psychePrompt = getPsycheModePrompt(psycheState);
      modelRagContext.push(`\n${psychePrompt}`);

      const { getDailyFragments, getRecentDiaries } = await import('../../services/lifeStreamService');
      const now = Date.now();
      const jstDate = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
      const dateStr = `${jstDate.getFullYear()}-${String(jstDate.getMonth() + 1).padStart(2, '0')}-${String(jstDate.getDate()).padStart(2, '0')}`;

      const recentDiaries = await getRecentDiaries(2);
      const todayFragments = await getDailyFragments(dateStr);

      let lifeStreamPrompt = `\n[近期生活轨迹]\n`;
      if (recentDiaries.length > 0) {
        lifeStreamPrompt += `前几日日记摘要：\n${recentDiaries.map((d: any) => `- [${d.date}]: ${d.summary}`).join('\n')}\n`;
      }
      if (todayFragments.length > 0) {
        lifeStreamPrompt += `今日离线期间经历的事件切片：\n${todayFragments.map((f: any) => `- [${new Date(f.timestamp).toLocaleTimeString('en-US', { timeZone: 'Asia/Tokyo' })}]: ${f.content}`).join('\n')}\n`;
      }

      if (recentDiaries.length > 0 || todayFragments.length > 0) {
        lifeStreamPrompt += `请在回复中自然地表现出这些记忆的延续感（情绪余波、事件后续等）。`;
        modelRagContext.push(lifeStreamPrompt);
      }
    }

    // --- VOICE POLICY ---
    const currentVoicePolicy = currentStateCtx.voicePolicy;
    let hybridVoicePrompt = '';

    if (refs.ttsConfigRef.current.voiceMode === 'full') {
      hybridVoicePrompt = language === 'zh'
        ? `[语音模式：全语音]\n你的回复将被翻译成日语并朗读出来。请像真人发语音消息一样保持简短自然：\n- 用 1-3 句话表达核心意思，避免长篇大论和列举清单\n- 像发一条微信语音那样说话，不要写邮件式的长段落\n- 可以用 '$' 分隔不同的短句，但总量要简短`
        : `[Voice Mode: Full Voice]\nYour reply will be translated to Japanese and spoken aloud. Keep it short and natural, like a real voice message:\n- Express your point in 1-3 sentences. Avoid long paragraphs or bullet lists.\n- Talk like you're sending a voice message on LINE, not writing an email.\n- You may use '$' to separate short thoughts, but keep the total brief.`;
    } else if (refs.ttsConfigRef.current.voiceMode === 'hybrid') {
      if (currentVoicePolicy === 'forbid') {
        hybridVoicePrompt = language === 'zh'
          ? `[语音模式：受限]\n你当前的状态（${currentStateCtx.stateDescription}）不方便发送语音。请**强制使用文字**回复。在回复末尾加上 [Voice_Mode: false]。`
          : `[Voice Mode: Restricted]\nYour current state (${currentStateCtx.stateDescription}) does not allow voice messages. You MUST reply with text. Append [Voice_Mode: false] to your reply.`;
      } else if (currentVoicePolicy === 'discourage') {
        hybridVoicePrompt = language === 'zh'
          ? `[语音模式：混合（建议文字）]\n你当前的状态（${currentStateCtx.stateDescription}）通常不太方便发语音，所以系统建议本条优先使用文字回复。\n但这只是建议，不是强制。如果以久美子的真实反应来看，你此刻强烈想用声音表达，例如情绪明显、很想安抚对方、忍不住补一句、或者短短一句用语音更自然，你仍然可以选择发语音。\n如果你决定发语音，请尽量自然、简短、像在当前环境下顺手发出的一句；如果觉得会太突兀或不方便，就继续用文字。\n在回复末尾加上 [Voice_Mode: true] 表示语音，或 [Voice_Mode: false] 表示文字。`
          : `[Voice Mode: Hybrid (Text Recommended)]\nYour current state (${currentStateCtx.stateDescription}) usually makes voice a bit inconvenient, so text is recommended for this reply.\nHowever, this is only a recommendation, not a hard rule. If, as Kumiko, you genuinely feel a strong urge to use your voice for a short emotional reaction, reassurance, or a line that would sound more natural aloud, you may still choose voice.\nIf you choose voice, keep it natural and brief, like something you'd send in the current setting without making it feel forced. Otherwise, stay with text.\nAppend [Voice_Mode: true] for voice, or [Voice_Mode: false] for text at the end of your reply.`;
      } else {
        hybridVoicePrompt = language === 'zh'
          ? `[语音模式：混合]\n你可以选择本条回复是否用语音。在回复末尾加上 [Voice_Mode: true] 表示语音，或 [Voice_Mode: false] 表示文字。\n判断依据：短消息/即时反应/情绪强烈/紧急事务 → 语音；长篇解释/包含链接列表/需要阅读的内容 → 文字。\n模拟真人行为：请像久美子自己决定一样自然选择，不必机械地固定全文字或全语音。现在环境允许发语音，如果关系亲近或者想表达情绪，可以更积极地使用语音。\n重要：如果选择语音，请保持简短（1-3 句），像发微信语音一样自然。`
          : `[Voice Mode: Hybrid]\nYou can choose whether to use voice for this reply. Append [Voice_Mode: true] for voice, or [Voice_Mode: false] for text at the end of your reply.\nCriteria: Short messages/instant reactions/strong emotions → voice; Long explanations/lists/reading material → text.\nSimulate human behavior: decide as Kumiko would, not by a rigid template. Voice is allowed in the current setting, so feel free to use it more when closeness or emotion calls for it.\nImportant: If you choose voice, keep it brief (1-3 sentences), like sending a voice message on LINE.`;
      }
    }

    const response: ChatResponse = await sendMessageToGemini(
      combinedText,
      modelCoreMemory,
      modelWorldBook,
      modelHistorySlice,
      locationConfig,
      isImageMessage ? apiImage : undefined,
      mimeType,
      0,
      undefined,
      modelRagContext,
      modelExactHistoryLookup,
      modelActiveReminders,
      modelAnchors,
      modelNotebook,
      undefined,
      language,
      hybridVoicePrompt || undefined,
    );

    if (refs.generationIdRef.current !== currentGenId) {
      return;
    }

    const s2 = useAppStore.getState();
    s2.setMessages((prev: Message[]) => prev.map(msg =>
      currentPendingIds.has(msg.id) ? { ...msg, isRead: true, sendStatus: undefined, failReason: undefined } : msg,
    ));

    s2.setIsDisconnected(false);
    s2.setCurrentEmotion(response.emotion);

    if (response.systemNotice) {
      s2.setSystemNotice(response.systemNotice);
    }

    if (response.imageCaption && isImageMessage) {
      s2.setMessages((prev: Message[]) => prev.map(m => {
        if (m.id === pendingImgId) {
          return { ...m, imageCaption: response.imageCaption };
        }
        return m;
      }));
    }

    // --- REMINDERS & ANCHORS ---
    const parsedRelativeReminder = parseRelativeReminderRequest(userTextForRag);
    const parsedDailyReminder = parseDailyReminderRequest(userTextForRag);
    let createdReminderThisTurn = false;
    if (response.scheduleTrigger?.event) {
      const { event, days_offset, delay_seconds, recurrence, hour, minute } = response.scheduleTrigger;
      if (recurrence === 'daily' && typeof hour === 'number' && typeof minute === 'number') {
        await s2.saveDailyReminder(event, hour, minute, userTextForRag);
        createdReminderThisTurn = true;
      } else if (typeof delay_seconds === 'number' && delay_seconds > 0) {
        await s2.saveRelativeReminder(event, delay_seconds, userTextForRag);
        createdReminderThisTurn = true;
      } else if (typeof days_offset === 'number') {
        try {
          const targetDate = new Date();
          targetDate.setDate(targetDate.getDate() + days_offset);
          const dateKey = targetDate.toISOString().slice(0, 10);
          const existingEvents = await db.getVal('kumiko_schedule_events', []);
          existingEvents.push({ event, date: dateKey });
          await db.setVal('kumiko_schedule_events', existingEvents);
        } catch (schedErr) {
          console.error('[SCHEDULE] Failed to save event', schedErr);
        }
      }
    } else if (parsedDailyReminder) {
      await s2.saveDailyReminder(parsedDailyReminder.event, parsedDailyReminder.hour, parsedDailyReminder.minute, userTextForRag);
      createdReminderThisTurn = true;
    } else if (parsedRelativeReminder) {
      await s2.saveRelativeReminder(parsedRelativeReminder.event, parsedRelativeReminder.delaySeconds, userTextForRag);
      createdReminderThisTurn = true;
    }

    if (response.anchorAction) {
      const action = response.anchorAction;
      if (action.type === 'add') {
        const newAnchor: AnchorEntry = {
          id: Date.now().toString(),
          content: action.content,
          timestamp: Date.now(),
          emotion: response.emotion,
        };
        s2.setAnchors((prev: AnchorEntry[]) => [newAnchor, ...prev]);
      } else if (action.type === 'delete') {
        s2.setAnchors((prev: AnchorEntry[]) => prev.filter(a => !a.content.includes(action.content)));
      }
    }

    // --- VOICE / TEXT DELIVERY ---
    const currentTtsCfg = refs.ttsConfigRef.current;
    const isVoiceTurn = currentTtsCfg.voiceMode === 'full'
      || (currentTtsCfg.voiceMode === 'hybrid' && response.voiceMode === true);

    if (isVoiceTurn && (currentTtsCfg.fishAudioApiKey || currentTtsCfg.ttsBackend === 'sovits') && isVoiceServiceAvailable()) {
      const combinedVoiceText = response.textParts.join(' ');
      useAppStore.getState().setIsThinking(true);

      const isDocumentHidden = document.hidden || !document.hasFocus();
      if (isDocumentHidden && Math.random() < 0.4) {
        const asyncDelay = 15000 + Math.random() * 30000;
        await new Promise(r => setTimeout(r, asyncDelay));
      }

      const quoteData = response.quote ? {
        id: 'model-reply-' + Date.now(),
        text: response.quote.text,
        role: 'user' as const,
      } : undefined;

      const voiceResult = await helpers.runVoicePipeline('pending-' + Date.now(), combinedVoiceText, response.emotion, response.voiceVariant);
      if (refs.generationIdRef.current !== currentGenId) { useAppStore.getState().setIsThinking(false); return; }
      useAppStore.getState().setIsThinking(false);

      if (voiceResult.success) {
        const voiceMsgId = addMessageToStore(
          'model', combinedVoiceText, undefined, undefined, undefined, undefined,
          quoteData, response.emotion, undefined,
          { isVoiceMessage: true, voiceFileId: voiceResult.voiceFileId, voiceDuration: voiceResult.voiceDuration, japaneseText: voiceResult.japaneseText },
        );
        showBackgroundNotification(combinedVoiceText, 'reply', voiceMsgId);
      } else {
        const textMsgId = addMessageToStore(
          'model', combinedVoiceText, undefined, undefined, undefined, undefined,
          quoteData, response.emotion, undefined,
        );
        showBackgroundNotification(combinedVoiceText, 'reply', textMsgId);
      }
    } else {
      for (let i = 0; i < response.textParts.length; i++) {
        if (refs.generationIdRef.current !== currentGenId) break;

        const textContent = response.textParts[i];
        let delay = 0;

        if (i === 0) {
          useAppStore.getState().setIsThinking(true);

          const isDocumentHidden = document.hidden || !document.hasFocus();
          if (isDocumentHidden && Math.random() < 0.4) {
            const asyncDelay = 15000 + Math.random() * 30000;
            await new Promise(r => setTimeout(r, asyncDelay));
          }

          if (Math.random() < 0.05) {
            console.log('%c[BEHAVIOR] Hesitation Triggered (She is rewriting...)', 'color: pink; font-weight: bold;');
            await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
            useAppStore.getState().setIsThinking(false);

            const recallNotice = language === 'zh' ? '【黄前久美子撤回了一条消息】' : '[Kumiko recalled a message]';
            addMessageToStore('model', recallNotice, undefined, undefined, 'recall-' + Date.now());

            await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
            if (refs.generationIdRef.current !== currentGenId) break;
            useAppStore.getState().setIsThinking(true);
          }

          delay = 1500 + (textContent.length * 60);
          delay = Math.max(3000, Math.min(12000, delay));
        } else {
          delay = 1500 + (textContent.length * 40) + (Math.random() * 1000);
          delay = Math.min(8000, delay);
        }

        await new Promise(r => setTimeout(r, delay));

        if (refs.generationIdRef.current !== currentGenId) break;

        if (i === 0 && ['angry', 'confused', 'surprised', 'shy'].includes(response.emotion) && Math.random() < 0.25) {
          const originalText = textContent;
          const cutOffPoint = Math.floor(originalText.length * 0.6);
          if (cutOffPoint > 2) {
            const typoText = originalText.substring(0, cutOffPoint);

            useAppStore.getState().setIsThinking(false);
            useAppStore.getState().setIsTalking(true);
            const typoId = addMessageToStore('model', typoText, undefined, undefined, 'typo-' + Date.now());

            await new Promise(r => setTimeout(r, 600));

            useAppStore.getState().setMessages((prev: Message[]) => prev.filter(m => m.id !== typoId));
            useAppStore.getState().setIsTalking(false);
            useAppStore.getState().setIsThinking(true);

            await new Promise(r => setTimeout(r, 400));
          }
        }

        if (i === 0) {
          useAppStore.getState().setIsThinking(false);
          useAppStore.getState().setIsTalking(true);
        }

        const quoteData = (i === 0 && response.quote) ? {
          id: 'model-reply-' + Date.now(),
          text: response.quote.text,
          role: 'user' as const,
        } : undefined;

        const modelMessageId = addMessageToStore(
          'model',
          response.textParts[i],
          undefined,
          undefined,
          undefined,
          undefined,
          quoteData,
          response.emotion,
        );

        if (i === 0) {
          showBackgroundNotification(response.textParts[i], 'reply', modelMessageId);
        }
      }
    }

    if (refs.generationIdRef.current === currentGenId) {
      setTimeout(() => useAppStore.getState().setIsTalking(false), 2000);
    }

    if (response.activateSleepMode) {
      console.log('[SLEEP MODE] Activating after topic-ending reply.');
      refs.hasGoneToSleepRef.current = true;
      useAppStore.getState().setCurrentEmotion('sleepy');
    }

    // --- RAG INDEXING ---
    if (refs.generationIdRef.current === currentGenId && backupConfig.ragEnabled) {
      const fullModelResponse = response.textParts.join(' ');

      const d = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const parts = formatter.formatToParts(d);
      const p: any = {};
      parts.forEach(part => p[part.type] = part.value);
      const timeStr = `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute} (JST)`;

      const imageDesc = response.imageCaption ? `(Image Description: ${response.imageCaption})` : '';

      const ragEntry = `【Time: ${timeStr}】\nUser: ${userTextForRag} ${imageDesc}\nKumiko: ${fullModelResponse}`;
      const memoryDecision = evaluateRagMemoryCandidate(ragEntry, 'turn_pair');

      if (!memoryDecision.shouldStore) {
        console.log(`[RAG FILTER] Skipped turn pair archive (${memoryDecision.reason})`, memoryDecision.flags);
      } else if (hasRecentRagDuplicate(memoryDecision.dedupeKey, refs.recentRagDedupeKeysRef.current)) {
        console.log('[RAG FILTER] Skipped duplicate turn pair archive.');
      } else {
        rememberRecentRagDedupeKeyRef(refs, memoryDecision.dedupeKey);

        useAppStore.getState().setRagStatus('INDEXING');
        saveLocalRagMemory(ragEntry, getCurrentAIConfig(), undefined, {
          tier: mapRagDecisionTierToStorageTier(memoryDecision.tier),
          source: 'turn_pair',
          score: memoryDecision.score,
          canonicalKey: memoryDecision.canonicalKey,
          role: 'mixed',
        }).then(() => {
          useAppStore.getState().setRagStatus('IDLE');
        }).catch(ragErr => {
          console.warn('[RAG] Local Save Error', ragErr);
          useAppStore.getState().setRagStatus('ERROR');
        });
      }
    }

    // --- SUMMARY BOUNDARY EVALUATION ---
    const newCount = turnCount + 1;
    const workingSummaryState: SummaryArchiveState = {
      ...summaryArchiveState,
      activeSegmentId: summaryArchiveState.activeSegmentId || buildSummarySegmentId(
        Date.now(),
        currentTurnStartMessageId,
        Date.now(),
      ),
      segmentStartMessageId: summaryArchiveState.segmentStartMessageId || currentTurnStartMessageId,
      pendingSinceTurn: summaryArchiveState.pendingSinceTurn ?? (
        getTurnsInActiveSummarySegment(newCount, summaryArchiveState) >= SUMMARY_SOFT_THRESHOLD
          ? newCount
          : null
      ),
    };
    let boundaryDecision = evaluateSummaryBoundary({
      currentTurnCount: newCount,
      archiveState: workingSummaryState,
      userText: userTextForRag,
      gapMinutes: gapSincePreviousTurnMinutes,
      createdReminder: createdReminderThisTurn,
      activatedSleepMode: !!response.activateSleepMode,
    });
    console.log(`[SUMMARY-BOUNDARY] turn=${newCount} seg=${boundaryDecision.turnsInSegment} should=${boundaryDecision.shouldSummarize} reason=${boundaryDecision.reason} userText="${userTextForRag?.slice(0, 40)}"`);
    const s3 = useAppStore.getState();
    s3.setTurnCount(newCount);
    s3.setSummaryArchiveState(workingSummaryState);

    if (!boundaryDecision.shouldSummarize && boundaryDecision.turnsInSegment >= SUMMARY_SOFT_THRESHOLD) {
      const semanticSignal = await calculateSummarySemanticSignalStandalone(refs.messagesRef, refs.summarySemanticEmbeddingCacheRef, workingSummaryState);
      boundaryDecision = evaluateSummaryBoundary({
        currentTurnCount: newCount,
        archiveState: workingSummaryState,
        userText: userTextForRag,
        gapMinutes: gapSincePreviousTurnMinutes,
        createdReminder: createdReminderThisTurn,
        activatedSleepMode: !!response.activateSleepMode,
        semanticSignal,
      });
    }

    if (boundaryDecision.shouldSummarize && boundaryDecision.reason) {
      const continuationSignal = await calculateSummaryContinuationSignalStandalone(refs.messagesRef, refs.summarySemanticEmbeddingCacheRef, workingSummaryState);
      const effectiveArchiveState = continuationSignal?.shouldContinue && workingSummaryState.carryoverStartMessageId
        ? {
            ...workingSummaryState,
            segmentStartMessageId: workingSummaryState.carryoverStartMessageId,
          }
        : workingSummaryState;
      const endBeforeMessageId = boundaryDecision.placement === 'before-current-turn'
        ? currentTurnStartMessageId
        : null;
      const nextSegmentStartTurn = boundaryDecision.placement === 'before-current-turn'
        ? Math.max(0, newCount - 1)
        : newCount;
      const nextSegmentStartMessageId = boundaryDecision.placement === 'before-current-turn'
        ? currentTurnStartMessageId
        : null;

      const summaryRefs: TriggerAutoSummaryRefs = {
        messagesRef: refs.messagesRef,
        summaryRunningRef: refs.summaryRunningRef,
      };
      const summaryHelpers: TriggerAutoSummaryHelpers = {
        deriveSummaryTopicLabel: helpers.deriveSummaryTopicLabel,
      };

      setTimeout(() => {
        void triggerAutoSummary(summaryRefs, summaryHelpers, {
          currentCount: newCount,
          currentMemory: coreMemory,
          archiveState: effectiveArchiveState,
          reason: boundaryDecision.reason!,
          isComplete: boundaryDecision.isComplete,
          isContinuation: !!continuationSignal?.shouldContinue,
          turnsInSegment: boundaryDecision.turnsInSegment,
          endBeforeMessageId,
          nextSegmentStartTurn,
          nextSegmentStartMessageId,
        });
      }, 1000);
    }

  } catch (e: any) {
    console.error('ExecuteSend Error:', e);
    if (e.message === 'RATE_LIMIT_EXCEEDED') {
      const config = getCurrentAIConfig();
      if (config.activeKey === 'primary' && config.apiKey_backup) {
        console.warn('[KEY_SWITCH] Primary key rate limited. Switching to backup key.');
        alert('主 API Key 已达到当日请求上限，将自动切换至备用 Key 并重试...');
        const newConfig: AIConfig = {
          ...config,
          activeKey: 'backup',
          keySwitchTimestamp: Date.now(),
        };
        localStorage.setItem('kumiko_ai_config', JSON.stringify(newConfig));
        executeSend(refs, helpers);
        return;
      } else {
        alert('API Key(s) have reached the daily request limit.');
      }
    }

    if (backupConfig.ragEnabled) useAppStore.getState().setRagStatus('ERROR');
    if (refs.generationIdRef.current === currentGenId) {
      const s4 = useAppStore.getState();
      s4.setIsThinking(false);
      s4.setIsTalking(false);
      const failMsg = e.message || 'Unknown error';
      s4.setMessages((prev: Message[]) => prev.map(msg => {
        if (currentPendingIds.has(msg.id) || msg.id === currentTurnStartMessageId) {
          return { ...msg, sendStatus: 'failed' as const, failReason: failMsg };
        }
        return msg;
      }));
      s4.setIsDisconnected(true);
    }
  }
}

// ---------------------------------------------------------------------------
// handleSendAction
// ---------------------------------------------------------------------------

export function handleSendAction(refs: ChatActionRefs) {
  const state = useAppStore.getState();
  const { inputValue, selectedImage, selectedImageId, isThinking, isTalking, replyingToMsg, locationConfig, language, messages } = state;
  const t = UI_TRANSLATIONS[language];

  if ((!inputValue.trim() && !selectedImage) || isThinking) return;

  let modelHour = 12;
  let modelMinute = 0;
  try {
    const parts = new Date().toLocaleTimeString('en-GB', {
      timeZone: locationConfig.modelTimezone,
      hour: '2-digit', minute: '2-digit',
      hour12: false, hourCycle: 'h23',
    }).split(':');
    modelHour = parseInt(parts[0], 10);
    modelMinute = parseInt(parts[1], 10);
  } catch (e) { console.warn('Time check for sleep logic failed', e); }

  const isSleepWindow = (modelHour === 0 && modelMinute >= 30) || (modelHour >= 1 && modelHour < 6);

  if (modelHour >= 6) {
    if (refs.hasGoneToSleepRef.current) {
      console.log('[SLEEP] 6:00 reset — good morning');
      state.setCurrentEmotion('neutral');
    }
    refs.hasGoneToSleepRef.current = false;
    refs.sleepWarningTimestampRef.current = null;
    refs.sleepFarewellSentRef.current = false;
    refs.lateNightWakeRolledRef.current = false;
    refs.lateNightWakeResultRef.current = false;
    refs.lateNightWakeTimestampRef.current = null;
  }

  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const gapMinutes = lastMsg ? (Date.now() - lastMsg.timestamp) / 60000 : Infinity;
  if (!refs.hasGoneToSleepRef.current && isSleepWindow && gapMinutes > 30) {
    console.log('[SLEEP] Auto-sleep: long inactivity during sleep window');
    refs.hasGoneToSleepRef.current = true;
    state.setCurrentEmotion('sleepy');
  }

  if (refs.hasGoneToSleepRef.current && isSleepWindow) {
    if (!refs.lateNightWakeRolledRef.current) {
      refs.lateNightWakeRolledRef.current = true;
      const roll = Math.random();
      refs.lateNightWakeResultRef.current = roll < 0.15;
      console.log(`[SLEEP] Late-night dice roll: ${(roll * 100).toFixed(1)}% → ${refs.lateNightWakeResultRef.current ? 'AWAKE' : 'ASLEEP'}`);
    }

    if (refs.lateNightWakeResultRef.current && !refs.lateNightWakeTimestampRef.current) {
      console.log('[SLEEP] Late-night wake-up! Clearing sleep lock.');
      refs.hasGoneToSleepRef.current = false;
      refs.lateNightWakeTimestampRef.current = Date.now();
    } else {
      console.log('[SLEEP] User message while asleep. Auto-replying.');
      const userText = inputValue;
      addMessageToStore('user', userText, selectedImage || undefined, undefined, undefined, undefined, undefined, undefined, selectedImageId || undefined);
      setTimeout(() => {
        addMessageToStore('model', t.autoReplyText, undefined, undefined, undefined, undefined, undefined, 'sleepy');
      }, 800);
      db.setVal('kumiko_pending_wakeup_context', userText);
      state.setInputValue('');
      state.setSelectedImage(null);
      state.setSelectedImageId(null);
      state.setReplyingToMsg(null);
      return;
    }
  }

  if (isTalking) state.setIsTalking(false);
  refs.generationIdRef.current += 1;

  const userText = inputValue;
  const userImage = selectedImage;
  const userImageId = selectedImageId;
  const newMsgId = Date.now().toString() + Math.random().toString();

  let quoteContext = undefined;
  if (replyingToMsg) {
    quoteContext = { id: replyingToMsg.id, text: replyingToMsg.text, role: replyingToMsg.role };
  }

  state.setInputValue('');
  state.setSelectedImage(null);
  state.setSelectedImageId(null);
  state.setReplyingToMsg(null);

  addMessageToStore('user', userText, userImage || undefined, undefined, newMsgId, undefined, quoteContext, undefined, userImageId || undefined);
  refs.pendingMessageIdsRef.current.add(newMsgId);

  let textToSend = userText;
  if (quoteContext) {
    const who = quoteContext.role === 'model' ? 'Kumiko' : 'User';
    textToSend = `> [Replying to ${who}]: "${quoteContext.text}"\n\n${userText}`;
  }

  refs.pendingTextRef.current = refs.pendingTextRef.current ? `${refs.pendingTextRef.current}\n${textToSend}` : textToSend;

  if (userImage) {
    refs.pendingImageRef.current = userImage;
    refs.pendingImageMessageIdRef.current = newMsgId;
  }

  if (refs.sendTimerRef.current) clearTimeout(refs.sendTimerRef.current);
  if (refs.countdownIntervalRef.current) clearInterval(refs.countdownIntervalRef.current);
  state.setIsListening(true);
  state.setTimeLeft(9);
  refs.countdownIntervalRef.current = setInterval(() => { useAppStore.getState().setTimeLeft((prev: number) => Math.max(0, prev - 1)); }, 1000);
  refs.sendTimerRef.current = setTimeout(() => { executeSend(refs, (refs as any).__executeSendHelpers); }, 9000);
  setTimeout(() => { refs.inputRef.current?.focus(); }, 10);

  if (!refs.preValidationActiveRef.current) {
    refs.preValidationActiveRef.current = true;
    validateAIConnection(getCurrentAIConfig()).then(isValid => {
      refs.preValidationActiveRef.current = false;
      if (!isValid && refs.pendingMessageIdsRef.current.size > 0) {
        if (refs.sendTimerRef.current) clearTimeout(refs.sendTimerRef.current);
        if (refs.countdownIntervalRef.current) clearInterval(refs.countdownIntervalRef.current);
        useAppStore.getState().setTimeLeft(0);
        useAppStore.getState().setIsListening(false);
        const failedIds = new Set(refs.pendingMessageIdsRef.current);
        refs.pendingMessageIdsRef.current.clear();
        refs.pendingTextRef.current = '';
        refs.pendingImageRef.current = null;
        refs.pendingImageMessageIdRef.current = null;
        useAppStore.getState().setMessages((prev: Message[]) => prev.map(msg =>
          failedIds.has(msg.id)
            ? { ...msg, sendStatus: 'failed' as const, failReason: 'API 连接失败' }
            : msg,
        ));
        useAppStore.getState().setIsDisconnected(true);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function updateMemoryQuerySessionRef(
  refs: Pick<ChatActionRefs, 'memoryQuerySessionRef'>,
  nextSession: MemoryQuerySession | null,
) {
  const normalizedSession = normalizeMemoryQuerySession(nextSession);
  refs.memoryQuerySessionRef.current = normalizedSession;
  void db.setVal('kumiko_memory_query_session', normalizedSession);
}

function rememberRecentRagDedupeKeyRef(
  refs: Pick<ChatActionRefs, 'recentRagDedupeKeysRef'>,
  dedupeKey: string | null,
) {
  if (!dedupeKey) return;
  const nextKeys = [dedupeKey, ...refs.recentRagDedupeKeysRef.current.filter(key => key !== dedupeKey)];
  refs.recentRagDedupeKeysRef.current = nextKeys.slice(0, 48);
}

async function getCachedSummaryEmbeddingStandalone(
  cacheRef: React.MutableRefObject<Map<string, Float32Array>>,
  text: string,
) {
  const normalized = text.trim();
  if (!normalized) return null;

  const cache = cacheRef.current;
  const cached = cache.get(normalized);
  if (cached) return cached;

  const vector = await generateEmbedding(normalized, 0);
  cache.set(normalized, vector);

  if (cache.size > SUMMARY_SEMANTIC_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }

  return vector;
}

async function calculateSummarySemanticSignalStandalone(
  messagesRef: React.MutableRefObject<Message[]>,
  cacheRef: React.MutableRefObject<Map<string, Float32Array>>,
  archiveState: SummaryArchiveState,
): Promise<SummarySemanticSignal | null> {
  const semanticWindows = getSummarySemanticWindowPayload(messagesRef.current, archiveState);
  if (!semanticWindows) return null;

  try {
    const previousVector = await getCachedSummaryEmbeddingStandalone(cacheRef, semanticWindows.previousWindowText);
    const recentVector = await getCachedSummaryEmbeddingStandalone(cacheRef, semanticWindows.recentWindowText);

    if (!previousVector || !recentVector) return null;

    const recentSimilarity = dotSimilarity(previousVector, recentVector);
    let currentSimilarity: number | null = null;

    if (hasRichSemanticText(semanticWindows.currentUserText)) {
      const currentVector = await getCachedSummaryEmbeddingStandalone(cacheRef, semanticWindows.currentUserText);
      if (currentVector) {
        currentSimilarity = dotSimilarity(previousVector, currentVector);
      }
    }

    const weightedSimilarity = currentSimilarity === null
      ? recentSimilarity
      : (currentSimilarity * 0.6) + (recentSimilarity * 0.4);
    const driftScore = Math.max(0, 1 - weightedSimilarity);

    const shouldTrigger = currentSimilarity === null
      ? recentSimilarity <= 0.68
      : recentSimilarity <= 0.84 && currentSimilarity <= 0.74 && weightedSimilarity <= 0.78 && driftScore >= 0.22;

    console.log(
      `[AUTO-SUMMARY] Semantic drift check: recent=${recentSimilarity.toFixed(3)}, current=${currentSimilarity === null ? 'n/a' : currentSimilarity.toFixed(3)}, weighted=${weightedSimilarity.toFixed(3)}, trigger=${shouldTrigger}`,
    );

    return {
      shouldTrigger,
      recentSimilarity,
      currentSimilarity,
      weightedSimilarity,
      driftScore,
    };
  } catch (error) {
    console.warn('[AUTO-SUMMARY] Semantic drift check unavailable, falling back to rule-only boundary detection.', error);
    return null;
  }
}

async function calculateSummaryContinuationSignalStandalone(
  messagesRef: React.MutableRefObject<Message[]>,
  cacheRef: React.MutableRefObject<Map<string, Float32Array>>,
  archiveState: SummaryArchiveState,
) {
  const continuationPayload = getSummaryContinuationPayload(messagesRef.current, archiveState);
  if (!continuationPayload || !hasRichSemanticText(continuationPayload.currentText)) {
    return null;
  }

  try {
    const carryoverVector = await getCachedSummaryEmbeddingStandalone(cacheRef, continuationPayload.carryoverText);
    const currentVector = await getCachedSummaryEmbeddingStandalone(cacheRef, continuationPayload.currentText);
    if (!carryoverVector || !currentVector) return null;

    const similarity = dotSimilarity(carryoverVector, currentVector);
    const shouldContinue = continuationPayload.currentUserCount >= 2
      ? similarity >= 0.76
      : similarity >= 0.82;

    console.log(
      `[AUTO-SUMMARY] Continuation check: similarity=${similarity.toFixed(3)}, currentUsers=${continuationPayload.currentUserCount}, trigger=${shouldContinue}`,
    );

    return { shouldContinue, similarity };
  } catch (error) {
    console.warn('[AUTO-SUMMARY] Continuation check unavailable, skipping carryover stitching.', error);
    return null;
  }
}
