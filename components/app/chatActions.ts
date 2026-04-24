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
import { setAIConfig } from '../../services/llmCore';
import { dialogService } from '../../services/dialogService';
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
import { mapMessageToEntity } from './messageMappers';
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
import type {
  BusyFollowUp,
  BusySlotContext,
  PendingApologySource,
} from '../../store/slices/busySlice';
import type { DeriveSummaryTopicLabelFn } from './chatPipelineRegistry';
import { tryGetChatPipelineRegistration } from './chatPipelineRegistry';
import type { RunVoicePipelineFn } from '../../hooks/useVoicePipeline';

// ---------------------------------------------------------------------------
// Mobile-path note:
//   Phone turns hit `sendUserMessageFromMobile` below (search for the
//   big banner comment). The "What this DOES NOT do" section used to
//   list 'memory query session threading' — that's stale as of this
//   plan; mobile now reuses `registration.memoryQuerySessionRef` when
//   a chat pipeline is registered so consecutive phone turns continue
//   the same temporal/topic recall thread desktop would.
// ---------------------------------------------------------------------------

// Module-level fallback for the memory query session on phone turns
// that arrive BEFORE a chat pipeline is registered (i.e. the App
// component tree has not mounted useChatPipelineRegistration yet).
// Normally we read/write through `registration.memoryQuerySessionRef`
// which is the same ref App.tsx owns; this singleton just bridges the
// first couple of HTTP turns until that ref is attached, so the session
// doesn't reset to null on every mobile request.
let mobileMemoryQuerySessionFallback: MemoryQuerySession | null = null;

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
  runVoicePipeline: RunVoicePipelineFn;
  deriveSummaryTopicLabel: DeriveSummaryTopicLabelFn;
}

// ---------------------------------------------------------------------------
// executeSendCore context — shared by desktop executeSend and mobile
// sendUserMessageFromMobile
// ---------------------------------------------------------------------------
//
// Phase 3 Part A unifies the desktop and mobile chat pipelines into a
// single `executeSendCore` function. Both entry points build a
// `ExecuteSendCoreContext` describing the same 12 segments of behavior
// (ambient context / retroactive life stream / busy state / memory
// resolution / session management / state machine / psyche / voice
// policy / reminders / voice delivery / RAG indexing / summary
// boundary) but differ in how they collect inputs and expose UI-coupled
// callbacks.
//
// Design rules:
//   1. The core never reads from React refs directly. It reads through
//      callback getters so the caller can plug in ref-backed or
//      zustand-backed storage interchangeably.
//   2. Any desktop-only UI side effect (modal, countdown, pending-ref
//      bookkeeping) is exposed as a callback whose mobile implementation
//      is either a no-op or a broadcast-friendly substitute (e.g.
//      auto-running backfill instead of showing a modal gate).
//   3. Cancellation is a getter — desktop checks the generation ref,
//      mobile always returns false (HTTP turns are not cancellable from
//      the phone side yet).
//   4. The retry-on-rate-limit loop recurses via `onRetry`, letting
//      desktop re-enter the same executeSend(refs, helpers) path and
//      mobile re-enter sendUserMessageFromMobile(text, options).

export type ChatPipelineOrigin = 'desktop' | 'mobile';

export interface ExecuteSendCoreContext {
  origin: ChatPipelineOrigin;

  // --- Inputs (per-turn) ---
  combinedText: string;
  userTextForRag: string;
  finalImage: string | null;
  pendingImageMessageId: string | null;
  pendingMessageIds: Set<string>;
  currentTurnStartMessageId: string | null;
  generationId: number;

  // --- Cancellation ---
  isCancelled: () => boolean;

  // --- Memory query session handle ---
  getMemoryQuerySession: () => MemoryQuerySession | null;
  setMemoryQuerySession: (s: MemoryQuerySession | null) => void;

  // --- RAG dedup keys ---
  getRecentRagDedupeKeys: () => string[];
  appendRagDedupeKey: (k: string) => void;

  // --- Summary infra ---
  getMessagesSnapshot: () => Message[];
  getSummaryRunning: () => boolean;
  setSummaryRunning: (v: boolean) => void;
  summaryEmbeddingCache: Map<string, Float32Array>;

  // --- Sleep lock (only set on topic-ending replies) ---
  setHasGoneToSleep: (v: boolean) => void;

  // --- Voice/summary helpers ---
  runVoicePipeline: RunVoicePipelineFn;
  deriveSummaryTopicLabel: DeriveSummaryTopicLabelFn;

  // --- TTS snapshot for this turn ---
  ttsConfig: TtsConfig;

  // --- Desktop-only UI hooks (mobile passes no-ops or broadcast shims) ---
  clearPendingBuffers: () => void;
  markPendingSending: () => void;
  markPendingRead: () => void;
  markPendingFailed: (reason: string) => void;
  waitForBackfillGate?: () => Promise<void>;

  // --- Busy-state follow-up (desktop reuses triggerNativeProactiveMessage via
  //     refs; mobile skips until phone has proactive support) ---
  triggerBusyFollowUp?: (event: string) => void;

  // --- Retry after rate-limit (re-enters the caller's own entry point) ---
  onRetry: () => void | Promise<void>;
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
    } else if (typeof (window as any).Capacitor?.isNativePlatform === 'function' && (window as any).Capacitor.isNativePlatform()) {
      // A6.2: Capacitor Android — route through the native local-notifications
      // channel + haptics. Lazy-import the wrapper so PC / PWA pay zero
      // bundle cost. The wrapper itself short-circuits if isCapacitorNative()
      // is false (defensive double-check), so a misdetection here can't
      // dispatch into a no-op plugin shim.
      void import('../../services/capacitorNotifications')
        .then(({ postKumikoNotification, vibrateForKind }) => {
          void postKumikoNotification({
            title,
            body: trimmedBody,
            // Map the existing MessageAlertKind ('reply' | 'reminder' |
            // 'proactive') onto the notification module's enum. Reminder
            // text notifications STILL use the 'kumiko_messages' channel
            // here — the FullScreenIntent / 'incoming-call' channel is
            // ONLY entered from triggerTimedReminderMessage's overlay
            // path (plan A6 routing: calls only from reminder-triggered
            // VoiceCallOverlay). This text path is what fires when the
            // reminder has no voice or app is in foreground.
            kind: kind === 'reminder' ? 'reminder' : (kind === 'proactive' ? 'proactive' : 'reply'),
            messageId,
          });
          void vibrateForKind(kind === 'reminder' ? 'reminder' : (kind === 'proactive' ? 'proactive' : 'reply'));
        })
        .catch((err) => {
          console.warn('[notif] Capacitor notification dispatch failed:', err);
        });
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
// prepareBusyFollowUpResponse
// ---------------------------------------------------------------------------
// Silently drafts a reply for a pending `BusyFollowUp` without touching any
// UI state (no isThinking / isTalking / message insertion). The caller
// (useBusyRegulator) is expected to store the returned `preparedTextParts`
// + `preparedEmotion` into the follow-up record and only play them back via
// `displayPreparedProactiveMessage` once the `displayAt` moment arrives.
// Returns null on API failure so the regulator can track retry count.
export async function prepareBusyFollowUpResponse(
  followUp: BusyFollowUp,
): Promise<{ textParts: string[]; emotion: EmotionType } | null> {
  const state = useAppStore.getState();
  const { coreMemory, worldBook, contextLimit, locationConfig, anchors, kumikoNotebook, language, messages } = state;

  const unreadIds = new Set(followUp.unreadUserMessageIds);
  const unreadMessages = messages.filter(m => unreadIds.has(m.id));
  const recentMessages = messages.slice(-contextLimit);

  const now = new Date();
  const hoursSinceEnd = followUp.slotEndAtMs
    ? Math.max(0, (now.getTime() - followUp.slotEndAtMs) / 3_600_000)
    : 0;

  const freshnessHint = language === 'zh'
    ? (hoursSinceEnd < 0.1
      ? '刚下课，话题还没凉'
      : hoursSinceEnd < 1
        ? '下课没多久，正好能回一下'
        : '已经过了一段时间，不必逐条复盘')
    : (hoursSinceEnd < 0.1
      ? 'just finished, the thread is still warm'
      : hoursSinceEnd < 1
        ? 'shortly after class, a natural moment to reply'
        : 'some time has passed, no need for a full replay');

  const unreadBullets = unreadMessages.length > 0
    ? unreadMessages.slice(-6).map((m, i) => {
        const snippet = (m.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        return `${i + 1}. ${snippet}`;
      }).join('\n')
    : (language === 'zh'
      ? '（没有明确未读，就作为忙完之后随手接上之前的节奏）'
      : '(no concrete unread — just casually picking back up)');

  const systemPrompt = language === 'zh'
    ? `[SYSTEM_ACTIVATION_PROTOCOL: 忙完之后的继续对话]
      之前你在「${followUp.slotDescription}」没空回复，现在忙完了，给用户接上话。
      时机感：${freshnessHint}。

      用户在你忙的期间留下的未读（按时间顺序）：
      ${unreadBullets}

      【强制纪律】
      1. 像真人忙完之后拿起手机自然回一句，不要机械道歉。
      2. 不要用"抱歉刚刚没空"这种模板开头；可以淡淡提一句"刚下课"或直接切入最想回的那条。
      3. 未读不必每条都回完，挑 1-2 条最想继续的接上，其余让对话自然推进。
      4. 控制长度：1-3 句话，不要写小作文，不要条列。
      5. 不要出现"系统"、"未读队列"、"自动回复"、"定时"、"消息记录"这种让人出戏的字眼。
      6. 如果未读里有明显情绪（担心、生气、撒娇），可以简短回应情绪本身。`
    : `[SYSTEM_ACTIVATION_PROTOCOL: Post-busy follow-up]
      Earlier you were at "${followUp.slotDescription}" and couldn't reply. Now you're free and picking the thread back up.
      Timing feel: ${freshnessHint}.

      Unread messages the user left while you were busy (chronological):
      ${unreadBullets}

      [STRICT DISCIPLINE]
      1. Sound like you just finished and casually picked up your phone — no mechanical apologies.
      2. Don't open with "Sorry I couldn't reply earlier"; a light "just got out of class" or diving straight into the most compelling line is better.
      3. You don't have to address every unread message. Pick the 1-2 you most want to respond to and let the rest flow naturally.
      4. Keep it short — 1-3 sentences. No essays. No bullet lists.
      5. Do NOT say "system", "queue", "auto-reply", "timer", "message log", or anything that breaks immersion.
      6. If an unread message carries clear emotion (worry, irritation, affection), acknowledge it briefly.`;

  try {
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
    const cleanedParts = (response.textParts || [])
      .map(t => (t || '').trim())
      .filter(t => t.length > 0);
    if (cleanedParts.length === 0) return null;
    return { textParts: cleanedParts, emotion: response.emotion };
  } catch (e) {
    console.warn('[BUSY-PREPARE] Draft generation failed', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// displayPreparedProactiveMessage
// ---------------------------------------------------------------------------
// Called once the scheduled `displayAt` moment arrives AND
// `preparedTextParts` is non-empty. Fakes a realistic typing animation
// (isThinking for 2-8s proportional to length, then isTalking, then drip
// the parts in) so the playback feels like Kumiko just composed it.
export async function displayPreparedProactiveMessage(
  followUp: BusyFollowUp,
): Promise<boolean> {
  if (!followUp.preparedTextParts || followUp.preparedTextParts.length === 0) {
    return false;
  }
  const storeState = useAppStore.getState();
  if (storeState.isTalking || storeState.isThinking) {
    return false;
  }
  const combined = followUp.preparedTextParts.join(' ');
  const typingMs = Math.max(2000, Math.min(8000, 1500 + combined.length * 60));
  useAppStore.getState().setIsThinking(true);
  await new Promise(r => setTimeout(r, typingMs));
  useAppStore.getState().setIsThinking(false);
  useAppStore.getState().setIsTalking(true);

  const emotion = followUp.preparedEmotion || 'neutral';
  const firstText = followUp.preparedTextParts[0];
  const firstMsgId = addMessageToStore('model', firstText, undefined, undefined, undefined, undefined, undefined, emotion);
  showBackgroundNotification(firstText, 'proactive', firstMsgId);

  for (let i = 1; i < followUp.preparedTextParts.length; i++) {
    await new Promise(r => setTimeout(r, 900 + Math.random() * 1200));
    addMessageToStore('model', followUp.preparedTextParts[i], undefined, undefined, undefined, undefined, undefined, emotion);
  }

  setTimeout(() => useAppStore.getState().setIsTalking(false), 2000);
  return true;
}

// ---------------------------------------------------------------------------
// buildPendingApologyInjection
// ---------------------------------------------------------------------------
// Merges every `PendingApologySource` currently accumulated in
// `pendingApology` into a single inline system prompt block. This is
// threaded into the normal chat pipeline the next time the user sends a
// message so Kumiko can (a) apologise once, (b) reply primarily to the
// user's new message, and (c) surface 2-3 of the most relevant unread
// topics without overwhelming the reply.
export function buildPendingApologyInjection(
  sources: PendingApologySource[],
  allMessages: Message[],
  language: 'zh' | 'en',
): string {
  if (!sources || sources.length === 0) return '';
  const msgById = new Map<string, Message>();
  for (const m of allMessages) msgById.set(m.id, m);

  type AggregatedMsg = {
    id: string;
    text: string;
    timestamp: number;
    slotDescription: string;
  };
  const all: AggregatedMsg[] = [];
  for (const src of sources) {
    for (const mid of src.unreadUserMessageIds) {
      const m = msgById.get(mid);
      if (!m || !m.text) continue;
      all.push({
        id: mid,
        text: m.text.replace(/\s+/g, ' ').trim(),
        timestamp: typeof m.timestamp === 'number' ? m.timestamp : Date.parse(String(m.timestamp)) || 0,
        slotDescription: src.slotDescription,
      });
    }
  }
  all.sort((a, b) => a.timestamp - b.timestamp);
  const oldest = all[0];
  const newest = all[all.length - 1];
  const middle = all.length >= 3 ? all[Math.floor(all.length / 2)] : undefined;

  const highlights: AggregatedMsg[] = [];
  const pushed = new Set<string>();
  for (const cand of [oldest, newest, middle]) {
    if (!cand || pushed.has(cand.id)) continue;
    highlights.push(cand);
    pushed.add(cand.id);
    if (highlights.length >= 3) break;
  }

  const slotDescriptions = Array.from(new Set(sources.map(s => s.slotDescription)));
  const slotSummary = slotDescriptions.join(language === 'zh' ? '、' : ' / ');
  const totalUnread = all.length;
  const highlightLines = highlights.map((h, i) => {
    const snippet = h.text.length > 120 ? h.text.slice(0, 120) + '…' : h.text;
    return `${i + 1}. [${h.slotDescription}] ${snippet}`;
  }).join('\n');

  if (language === 'zh') {
    return `\n[SYSTEM_INJECTION: 积压未读消息追赶]
你之前几段忙碌期（${slotSummary}）没空回复，累计有 ${totalUnread} 条未读。现在用户又发来了新消息，你终于能一起处理。

从所有未读里挑出的几条关键内容（按时间：最早 / 中间 / 最新）：
${highlightLines}

【本轮必须遵守】
1. 只轻轻表达一次"这段时间没空回你"的意思，整段回复加起来只能有一次，不要每条都道歉一遍。
2. 先回应用户【当前这条新消息】，这是主轴。
3. 在回复中自然地带起上面 2-3 条里最契合话题或情绪最浓的那 1-2 条，不要逐条罗列，不要复述原话。
4. 其他没提到的未读不用担心，用户之后可能自己提起，你再聊。
5. 保持正常对话节奏：别写小作文，别开条列清单，不要出现"系统"、"未读队列"、"未读消息"、"追赶"、"补回复"这些破坏沉浸的词。`;
  }
  return `\n[SYSTEM_INJECTION: Accumulated unread catch-up]
You were unavailable during a few busy periods (${slotSummary}) and ${totalUnread} messages piled up unread. The user has just sent a new message, so you can finally respond.

Key unread items picked out (oldest / middle / newest):
${highlightLines}

[STRICT RULES FOR THIS TURN]
1. Acknowledge being away at most ONCE across the whole reply — no per-message apologies.
2. The user's CURRENT new message is the main thread. Respond to it first.
3. Naturally weave in 1-2 of the highlighted unread items (the ones most relevant or most emotionally charged). Do not list them, do not quote them literally.
4. Ignore the rest of the unread queue. If the user cares, they will resurface a topic later.
5. Keep a normal conversational rhythm. No essays, no bullet points. Never mention "system", "unread queue", "backlog", "catch-up", or anything that breaks immersion.`;
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

    if (currentTtsCfg.voiceMode !== 'text' && (currentTtsCfg.fishAudioApiKey || currentTtsCfg.ttsBackend === 'sovits' || (currentTtsCfg.ttsBackend === 'vocu' && !!currentTtsCfg.vocuApiKey && !!currentTtsCfg.vocuVoiceId)) && isVoiceServiceAvailable()) {
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
                // Phase 5 Part D: mirror voiceFileId into the overlay
                // so the phone's mirrored overlay can HTTP-stream the
                // clip in parallel with PC's local Blob playback. The
                // PC renderer itself keeps using the Blob URL path
                // below because the ArrayBuffer is already in hand
                // (cheaper than re-fetching /media/voices/ over HTTP
                // when we're the same process that just wrote it).
                useAppStore.getState().setVoiceCallOverlayData((prev: any) => prev ? {
                  ...prev,
                  isConnecting: false,
                  isPlayingVoice: true,
                  voiceFileId: voiceResult.voiceFileId,
                } : null);

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
  const combinedText = refs.pendingTextRef.current;
  const finalImage = refs.pendingImageRef.current;
  const pendingImgId = refs.pendingImageMessageIdRef.current;
  const currentPendingIds: Set<string> = new Set<string>(refs.pendingMessageIdsRef.current);
  const currentTurnStartMessageId = refs.messagesRef.current
    .filter(msg => currentPendingIds.has(msg.id))
    .sort((a, b) => a.timestamp - b.timestamp)[0]?.id ?? null;
  const userTextForRag = combinedText;

  refs.pendingTextRef.current = '';
  refs.pendingImageRef.current = null;
  refs.pendingMessageIdsRef.current.clear();
  refs.pendingImageMessageIdRef.current = null;

  if (refs.countdownIntervalRef.current) clearInterval(refs.countdownIntervalRef.current);
  const state = useAppStore.getState();
  state.setTimeLeft(0);
  state.setIsListening(false);

  state.setMessages((prev: Message[]) => prev.map(msg =>
    currentPendingIds.has(msg.id) ? { ...msg, sendStatus: 'sending' as const } : msg,
  ));

  const savedGenId = refs.generationIdRef.current;

  const ctx: ExecuteSendCoreContext = {
    origin: 'desktop',
    combinedText,
    userTextForRag,
    finalImage,
    pendingImageMessageId: pendingImgId,
    pendingMessageIds: currentPendingIds,
    currentTurnStartMessageId,
    generationId: savedGenId,
    isCancelled: () => refs.generationIdRef.current !== savedGenId,
    getMemoryQuerySession: () => refs.memoryQuerySessionRef.current,
    setMemoryQuerySession: (s) => updateMemoryQuerySessionRef(refs, s),
    getRecentRagDedupeKeys: () => refs.recentRagDedupeKeysRef.current,
    appendRagDedupeKey: (k) => rememberRecentRagDedupeKeyRef(refs, k),
    getMessagesSnapshot: () => refs.messagesRef.current,
    getSummaryRunning: () => refs.summaryRunningRef.current,
    setSummaryRunning: (v) => { refs.summaryRunningRef.current = v; },
    summaryEmbeddingCache: refs.summarySemanticEmbeddingCacheRef.current,
    setHasGoneToSleep: (v) => { refs.hasGoneToSleepRef.current = v; },
    runVoicePipeline: helpers.runVoicePipeline,
    deriveSummaryTopicLabel: helpers.deriveSummaryTopicLabel,
    ttsConfig: refs.ttsConfigRef.current,
    clearPendingBuffers: () => { /* desktop already cleared buffers above */ },
    markPendingSending: () => {
      useAppStore.getState().setMessages((prev: Message[]) => prev.map(msg =>
        currentPendingIds.has(msg.id) ? { ...msg, sendStatus: 'sending' as const } : msg,
      ));
    },
    markPendingRead: () => {
      useAppStore.getState().setMessages((prev: Message[]) => prev.map(msg =>
        currentPendingIds.has(msg.id) ? { ...msg, isRead: true, sendStatus: undefined, failReason: undefined } : msg,
      ));
    },
    markPendingFailed: (reason) => {
      useAppStore.getState().setMessages((prev: Message[]) => prev.map(msg => {
        if (currentPendingIds.has(msg.id) || msg.id === currentTurnStartMessageId) {
          return { ...msg, sendStatus: 'failed' as const, failReason: reason };
        }
        return msg;
      }));
    },
    waitForBackfillGate: () => new Promise<void>((resolve) => {
      refs.pendingSendRef.current = resolve;
    }),
    triggerBusyFollowUp: (event) => {
      triggerNativeProactiveMessage(refs, 0, event);
    },
    onRetry: () => { void executeSend(refs, helpers); },
  };

  await executeSendCore(ctx);
}

// ---------------------------------------------------------------------------
// executeSendCore — shared chat pipeline (Phase 3 Part A)
// ---------------------------------------------------------------------------
//
// Single source of truth for the 12 conversation side effects:
//   A-1  Ambient environment context
//   A-2  Retroactive life-stream generation on long gaps + backfill gate
//   A-3  Busy-state interception
//   A-4  Memory / RAG resolution (exact / temporal / semantic)
//   A-5  Session management for historical query sessions
//   A-6  State machine injection
//   A-7  Life stream & psyche state injection
//   A-8  Voice policy
//   A-9  sendMessageToGemini — model call with all context
//   A-10 Reminders + anchors extracted from model reply
//   A-11 Voice / text delivery
//   A-12 RAG indexing + summary boundary evaluation
//
// Both desktop `executeSend(refs, helpers)` and mobile
// `sendUserMessageFromMobile(text, options)` funnel here with
// context-object adapters.

async function executeSendCore(ctx: ExecuteSendCoreContext): Promise<void> {
  const state = useAppStore.getState();
  const { coreMemory, worldBook, contextLimit, locationConfig, backupConfig, anchors, kumikoNotebook, turnCount, language, summaryArchiveState } = state;

  const {
    combinedText,
    userTextForRag,
    finalImage,
    pendingImageMessageId: pendingImgId,
    pendingMessageIds: currentPendingIds,
    currentTurnStartMessageId,
  } = ctx;

  const isImageMessage = !!finalImage;

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

    const allMessages = ctx.getMessagesSnapshot().filter(msg => !currentPendingIds.has(msg.id));
    const recentMessages = allMessages.slice(-contextLimit);
    const pinnedMessages = allMessages.filter(msg => msg.isPinned);
    const gapSincePreviousTurnMinutes = allMessages.length > 0
      ? Math.max(0, (Date.now() - allMessages[allMessages.length - 1].timestamp) / 60000)
      : Number.POSITIVE_INFINITY;

    const historyMap = new Map<string, Message>();
    [...pinnedMessages, ...recentMessages].forEach(m => historyMap.set(m.id, m));
    const historySlice = Array.from(historyMap.values()).sort((a, b) => a.timestamp - b.timestamp);

    const ambientEnvironmentContext = await getAmbientEnvironmentContext();
    const isCurrentHoliday = ambientEnvironmentContext.includes('今日特殊历法：日本法定节假日');

    // --- A-2 RETROACTIVE LIFE STREAM GENERATION ---
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
        const latest = useAppStore.getState();
        if (latest.isAutoDiaryBackfillEnabled()) {
          void latest.runAutoDiaryBackfill(gapInfo);
        } else if (ctx.origin === 'desktop' && ctx.waitForBackfillGate) {
          latest.setBackfillGapInfo(gapInfo);
          await ctx.waitForBackfillGate();
        } else {
          // Mobile-originated turns never block on the confirm gate.
          // DiaryBackfillDialog is mounted globally in App.tsx, so the
          // phone still sees it as a progress banner — but we kick off
          // the auto-run here so the chat turn doesn't stall waiting
          // for a tap that may never come (e.g. screen locked, WS
          // dropped mid-turn).
          latest.setBackfillGapInfo(gapInfo);
          void latest.runAutoDiaryBackfill(gapInfo);
        }
      }
    }

    // --- A-3 BUSY STATE INTERCEPTOR ---
    // Slot-level one-time dice roll: once we enter a busy slot (teaching,
    // shr, school_prep, after_school) we roll once for the whole slot and
    // persist the decision. Subsequent user messages in the same slot
    // reuse the decision. Teaching slot additionally upgrades from
    // `allow` → `block` after Kumiko has replied 2 round-trips.
    const { getDetailedScheduleSlot, getBusyEndTimestamp } = await import('../../services/kumikoStateMachine');
    const scheduleSlot = getDetailedScheduleSlot(locationConfig.modelTimezone, isCurrentHoliday);
    const nowMs = Date.now();
    const slotEndMs = scheduleSlot.slotKey
      ? getBusyEndTimestamp(scheduleSlot, new Date(nowMs), locationConfig.modelTimezone)
      : null;

    // --- Stale runtime archive (regulator may not have ticked yet) ---
    // If the slot key we had in `busySlotRuntime` no longer matches the
    // current schedule (e.g. the class just ended within the last
    // second and the 1 s poller hasn't fired), archive the old runtime
    // inline so its unread-message tracking isn't lost when
    // `ensureBusySlot` overwrites the record below.
    {
      const staleRuntime = useAppStore.getState().busySlotRuntime;
      if (staleRuntime && staleRuntime.slotKey !== scheduleSlot.slotKey) {
        if (staleRuntime.unreadUserMessageIds.length > 0 || staleRuntime.mode === 'block') {
          const staleEndMs = staleRuntime.endAtMs ?? nowMs;
          const prepareAt = Math.max(staleEndMs - 2 * 60_000, nowMs);
          const displayAt = Math.max(staleEndMs, nowMs) + 25_000 + Math.floor(Math.random() * 15_000);
          await useAppStore.getState().archiveBusySlotToFollowUp({ prepareAt, displayAt });
        } else {
          await useAppStore.getState().clearBusySlot();
        }
      }
    }

    // --- User-interrupt preemption of a pending busyFollowUp ---
    // If the user sent a fresh message BEFORE the regulator's
    // `displayAt` moment fired, convert the still-queued follow-up into
    // a `pendingApologySource` so the apology-injection block below
    // surfaces it naturally in this turn instead of double-replying.
    const pendingFollowUp = useAppStore.getState().busyFollowUp;
    if (pendingFollowUp) {
      const { convertBusyFollowUpToApologyForPreemption } = await import('../../hooks/useBusyRegulator');
      await convertBusyFollowUpToApologyForPreemption();
    }

    const trackedUserMsgId = currentTurnStartMessageId
      || Array.from(ctx.pendingMessageIds || [])[0]
      || null;

    // Only buckets with a non-null slotKey participate in the busy
    // regulator; everything else (home / free / drowsy / lunch / sleeping
    // / commuting / cleaning) falls through to the normal pipeline.
    if (scheduleSlot.slotKey && scheduleSlot.interceptChance > 0) {
      const busyStore = useAppStore.getState();
      const slotCtx: BusySlotContext = {
        slotKey: scheduleSlot.slotKey,
        slotType: scheduleSlot.slotType,
        slotDescription: scheduleSlot.description,
        endAtMs: slotEndMs,
      };
      const decision = busyStore.ensureBusySlot(slotCtx, scheduleSlot.interceptChance, nowMs);

      if (decision !== 'allow') {
        const runtime = useAppStore.getState().busySlotRuntime;
        const upgradedByRound = runtime?.reason === 'round_limit';
        const pickBusyReply = (): string => {
          const isZh = language === 'zh';
          if (upgradedByRound && scheduleSlot.slotType === 'teaching') {
            const zhPool = [
              '先不聊了，下节还有新内容要讲，静音了',
              '真不能再说了，学生已经看我好几眼，下课再说',
              '这节课剩下部分要集中，等放学',
            ];
            const enPool = [
              "I really have to stop now, new material coming up. Back after class",
              "Kids are starting to notice — muting my phone. Talk later.",
              'Need to focus on the rest of this lesson, catch you after school.',
            ];
            const pool = isZh ? zhPool : enPool;
            return pool[Math.floor(Math.random() * pool.length)];
          }
          if (scheduleSlot.slotType === 'teaching') {
            const pNum = scheduleSlot.periodNumber || 0;
            const zhPool = [
              `在上课呢，第${pNum}节还没下课，等一下`,
              `${scheduleSlot.classGroup || ''}的课还没完，下课再说`,
              '现在不方便，课上呢',
              '等下课再回你',
            ];
            const enPool = [
              `In class right now, period ${pNum} isn't over yet. Give me a sec`,
              "Can't talk, I'm teaching. I'll reply after class",
              'Hold on, still in the middle of a lesson',
              'Busy with class, brb',
            ];
            const pool = isZh ? zhPool : enPool;
            return pool[Math.floor(Math.random() * pool.length)];
          }
          if (scheduleSlot.slotType === 'shr') {
            const zhPool = ['朝会中，马上回你', '在朝会，稍等', 'SHR 还没结束，一会儿说'];
            const enPool = ['In morning assembly, one sec', 'SHR right now, hold on', "Homeroom meeting, I'll reply shortly"];
            const pool = isZh ? zhPool : enPool;
            return pool[Math.floor(Math.random() * pool.length)];
          }
          if (scheduleSlot.slotType === 'after_school') {
            const zhPool = ['社团那边有点事，等下回你', '正在部活，稍后说', '放学后部活中，晚点回'];
            const enPool = ["Busy with club stuff, I'll get back to you", 'In club activities, talk soon', 'After-school duties, reply in a bit'];
            const pool = isZh ? zhPool : enPool;
            return pool[Math.floor(Math.random() * pool.length)];
          }
          // school_prep
          const zhPool = ['正在准备上学前的事，等下说', '忙着出门准备，马上', '出勤前有点手忙脚乱，晚点说'];
          const enPool = ['Getting ready for school, one sec', 'Busy with the morning rush', "Bit hectic before heading out, I'll reply in a moment"];
          const pool = isZh ? zhPool : enPool;
          return pool[Math.floor(Math.random() * pool.length)];
        };

        if (decision === 'block_first') {
          const replyText = pickBusyReply();
          // Tiny typing beat so it doesn't feel teleported.
          useAppStore.getState().setIsThinking(true);
          await new Promise(r => setTimeout(r, 1400 + Math.random() * 1800));
          useAppStore.getState().setIsThinking(false);
          const msgId = addMessageToStore('model', replyText, undefined, undefined, undefined, undefined, undefined, 'serious');
          showBackgroundNotification(replyText, 'reply', msgId);
          if (trackedUserMsgId) {
            await useAppStore.getState().appendBusyUnread(scheduleSlot.slotKey, trackedUserMsgId, {
              shortReplyText: replyText,
              markShortReplyIssued: true,
            });
          } else {
            // No pending msg id (rare edge case) — still mark the short
            // reply as issued so the next user message goes silent.
            await useAppStore.getState().appendBusyUnread(scheduleSlot.slotKey, `synthetic-${nowMs}`, {
              shortReplyText: replyText,
              markShortReplyIssued: true,
            });
          }
        } else {
          // decision === 'block_silent': no UI response at all. The
          // message is quietly tracked and will come back as part of the
          // burst compensation later.
          if (trackedUserMsgId) {
            await useAppStore.getState().appendBusyUnread(scheduleSlot.slotKey, trackedUserMsgId);
          }
        }

        ctx.markPendingRead();
        return;
      }
    }

    // --- A-4 MEMORY / RAG RESOLUTION ---
    const currentLooksHistoryLike = isLikelyHistoricalRecallQuery(userTextForRag)
      || isLikelyTemporalHistoryQuery(userTextForRag)
      || isLikelyHistoricalFollowUp(userTextForRag)
      || isLikelyHistoricalSessionCarry(userTextForRag)
      || isLikelySemanticRecallQuery(userTextForRag);
    {
      const s = ctx.getMemoryQuerySession();
      if (!currentLooksHistoryLike
        && !(s?.kind === 'topic_search' && isMemoryQuerySessionActive(s))) {
        ctx.setMemoryQuerySession(null);
      }
    }

    const historyQueryContextResolution = buildHistoricalRecallQueryContext(allMessages, userTextForRag, ctx.getMemoryQuerySession());
    const rawHistoryQueryContext = historyQueryContextResolution.queryText;
    let historyQueryContext = rawHistoryQueryContext;
    let historyQueryRewrite: HistoricalQueryRewrite | null = null;
    let historyQueryRewriteError: string | null = null;
    const shouldRewriteHistoricalQuery = currentLooksHistoryLike
      || historyQueryContextResolution.source !== 'self'
      || isMemoryQuerySessionActive(ctx.getMemoryQuerySession());
    if (shouldRewriteHistoricalQuery) {
      const rewriteResult = await rewriteHistoricalRecallQueryDetailed(rawHistoryQueryContext, locationConfig, {
        bypassGate: ctx.getMemoryQuerySession()?.kind === 'topic_search',
        recentMessages: allMessages.slice(-6),
      });
      historyQueryRewrite = rewriteResult.rewrite;
      historyQueryRewriteError = rewriteResult.errorMessage;
      if (historyQueryRewrite?.rewrittenQuery) {
        historyQueryContext = historyQueryRewrite.rewrittenQuery;
      }
    }
    const historicalQueryIntent = mapHistoricalRewriteIntent(historyQueryRewrite?.intent)
      ?? resolveHistoricalQueryIntent(userTextForRag, historyQueryContext, ctx.getMemoryQuerySession());
    const shouldLoadHistoryEvidence = historicalQueryIntent === 'exact'
      || historicalQueryIntent === 'temporal'
      || (isMemoryQuerySessionActive(ctx.getMemoryQuerySession()) && historyQueryContextResolution.source !== 'self');
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
        const sessionForLog = ctx.getMemoryQuerySession();
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
          activeQuerySession: sessionForLog ? {
            kind: sessionForLog.kind,
            lookupMode: sessionForLog.lookupMode,
            targetSpeaker: sessionForLog.targetSpeaker,
            reusable: isReusableHistoricalSession(sessionForLog),
            parserStatus: sessionForLog.parserStatus ?? null,
            parserSource: sessionForLog.parserSource ?? null,
            parserPrecision: sessionForLog.parserPrecision ?? null,
            parserConfidence: sessionForLog.parserConfidence ?? null,
            lastEvidenceSource: sessionForLog.lastEvidenceSource ?? 'none',
            confidenceLevel: sessionForLog.confidenceLevel ?? 'low',
          } : null,
        });
        const temporalAnalysisResult = shouldAnalyzeTemporal
          ? await analyzeTemporalQueryDetailed(historyQueryContext, locationConfig)
          : null;
        temporalIntent = temporalAnalysisResult?.analysis ?? null;
        temporalDiagnostics = temporalAnalysisResult?.diagnostics ?? null;
        const sessionForFallback = ctx.getMemoryQuerySession();
        if (!temporalIntent && shouldAnalyzeTemporal && isReusableHistoricalSession(sessionForFallback) && sessionForFallback?.kind === 'temporal_history') {
          temporalIntent = {
            isTemporalQuery: true,
            startTimestampJST: sessionForFallback.startTimestampJST ?? null,
            endTimestampJST: sessionForFallback.endTimestampJST ?? null,
            searchRole: sessionForFallback.searchRole ?? 'any',
            precision: sessionForFallback.parserPrecision ?? null,
            source: sessionForFallback.parserSource ?? 'local_heuristic',
            confidence: sessionForFallback.parserConfidence ?? 'low',
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
          ? (buildTemporalHistoryLookupBlock(historyEvidenceMessages, temporalIntent, temporalEpisodes, historyQueryContext) || buildTemporalNoEvidenceLookupBlock(historyQueryContext, temporalIntent, ctx.getMemoryQuerySession(), temporalDiagnostics))
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
          const sessionForKeywords = ctx.getMemoryQuerySession();
          const effectiveKeywords = historyQueryRewrite?.searchKeywords
            || (sessionForKeywords?.kind === 'topic_search'
                ? extractTopicFallbackKeywords(userTextForRag)
                : undefined);
          const semanticRecall = await searchLocalRagMemoryDetailed(
            semanticSearchQuery,
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

    // --- A-5 SESSION MANAGEMENT ---
    if (historyLookup?.strict) {
      const now = Date.now();
      const previousSession = ctx.getMemoryQuerySession();
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
      ctx.setMemoryQuerySession(canPersistTemporalSession ? nextSession : null);
    } else if (memoryRoute === 'fuzzy_rag' && historyQueryRewrite?.searchStrategy === 'topic_search') {
      const now = Date.now();
      const prev = ctx.getMemoryQuerySession();
      ctx.setMemoryQuerySession({
        kind: 'topic_search',
        sourceQuery: historyQueryRewrite?.topicQuery || historyQueryContext,
        lookupMode: 'temporal_window',
        targetSpeaker: null,
        searchRole: historyQueryRewrite?.searchRole ?? 'any',
        resultCount: ragContext.length,
        lastEvidenceSource: 'episodes',
        confidenceLevel: semanticConfidenceLevel ?? 'low',
        createdAt: prev?.createdAt ?? now,
        lastUsedAt: now,
      });
    } else if (!currentLooksHistoryLike && historyQueryContextResolution.source === 'self') {
      ctx.setMemoryQuerySession(null);
    } else {
      const existing = ctx.getMemoryQuerySession();
      if (existing) {
        ctx.setMemoryQuerySession({
          ...existing,
          sourceQuery: historyQueryContextResolution.source === 'self'
            ? existing.sourceQuery
            : historyQueryContext,
          parserStatus: temporalDiagnostics?.status ?? historyLookup?.parserStatus ?? existing.parserStatus ?? null,
          parserSource: temporalIntent?.source ?? existing.parserSource ?? null,
          parserPrecision: temporalIntent?.precision ?? existing.parserPrecision ?? null,
          parserConfidence: temporalIntent?.confidence ?? historyLookup?.parserConfidence ?? existing.parserConfidence ?? null,
          lastEvidenceSource: historyLookup?.evidenceMode ?? existing.lastEvidenceSource ?? 'none',
          confidenceLevel: historyLookup?.confidenceLevel ?? existing.confidenceLevel ?? 'low',
          lastUsedAt: Date.now(),
        });
      }
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

    // --- PENDING APOLOGY BURST COMPENSATION INJECTION ---
    // If one or more `busyFollowUp` records expired / failed / were
    // interrupted by the user, they were appended into `pendingApology`
    // as sources. When the user finally sends a normal message, inject a
    // merged catch-up block so Kumiko apologises ONCE and naturally
    // weaves 2-3 of the old topics back into her reply.
    const apologyAtInject = useAppStore.getState().pendingApology;
    const apologyInjectedThisTurn = !strictEvidenceTurn && !!apologyAtInject && apologyAtInject.sources.length > 0;
    if (apologyInjectedThisTurn) {
      const injection = buildPendingApologyInjection(
        apologyAtInject!.sources,
        ctx.getMessagesSnapshot(),
        language,
      );
      if (injection) modelRagContext.push(injection);
    }

    // --- A-8 VOICE POLICY ---
    const currentVoicePolicy = currentStateCtx.voicePolicy;
    let hybridVoicePrompt = '';

    if (ctx.ttsConfig.voiceMode === 'full') {
      hybridVoicePrompt = language === 'zh'
        ? `[语音模式：全语音]\n你的回复将被翻译成日语并朗读出来。请像真人发语音消息一样保持简短自然：\n- 用 1-3 句话表达核心意思，避免长篇大论和列举清单\n- 像发一条微信语音那样说话，不要写邮件式的长段落\n- 可以用 '$' 分隔不同的短句，但总量要简短`
        : `[Voice Mode: Full Voice]\nYour reply will be translated to Japanese and spoken aloud. Keep it short and natural, like a real voice message:\n- Express your point in 1-3 sentences. Avoid long paragraphs or bullet lists.\n- Talk like you're sending a voice message on LINE, not writing an email.\n- You may use '$' to separate short thoughts, but keep the total brief.`;
    } else if (ctx.ttsConfig.voiceMode === 'hybrid') {
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

    if (ctx.isCancelled()) {
      return;
    }

    const s2 = useAppStore.getState();
    ctx.markPendingRead();

    // --- Teaching-slot round counter bookkeeping ---
    // Each successful allow-mode AI reply in a teaching slot counts as
    // one round-trip. Once we hit 2 round-trips, the NEXT user message
    // in the same slot triggers the round-limit block (see
    // `ensureBusySlot`), regardless of the initial dice roll.
    if (scheduleSlot.slotKey && scheduleSlot.slotType === 'teaching') {
      const runtime = s2.busySlotRuntime;
      if (runtime && runtime.mode === 'allow' && runtime.slotKey === scheduleSlot.slotKey) {
        await s2.incrementBusySlotRound(scheduleSlot.slotKey);
      }
    }

    // --- Clear pending apology after successful burst compensation ---
    if (apologyInjectedThisTurn) {
      await s2.clearPendingApology();
    }

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

    // --- A-11 VOICE / TEXT DELIVERY ---
    const currentTtsCfg = ctx.ttsConfig;
    const isVoiceTurn = currentTtsCfg.voiceMode === 'full'
      || (currentTtsCfg.voiceMode === 'hybrid' && response.voiceMode === true);

    if (isVoiceTurn && (currentTtsCfg.fishAudioApiKey || currentTtsCfg.ttsBackend === 'sovits' || (currentTtsCfg.ttsBackend === 'vocu' && !!currentTtsCfg.vocuApiKey && !!currentTtsCfg.vocuVoiceId)) && isVoiceServiceAvailable()) {
      const combinedVoiceText = response.textParts.join(' ');
      useAppStore.getState().setIsThinking(true);

      const isDocumentHidden = typeof document !== 'undefined' ? (document.hidden || !document.hasFocus()) : false;
      if (isDocumentHidden && Math.random() < 0.4) {
        const asyncDelay = 15000 + Math.random() * 30000;
        await new Promise(r => setTimeout(r, asyncDelay));
      }

      const quoteData = response.quote ? {
        id: 'model-reply-' + Date.now(),
        text: response.quote.text,
        role: 'user' as const,
      } : undefined;

      const voiceResult = await ctx.runVoicePipeline('pending-' + Date.now(), combinedVoiceText, response.emotion, response.voiceVariant);
      if (ctx.isCancelled()) { useAppStore.getState().setIsThinking(false); return; }
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
        if (ctx.isCancelled()) break;

        const textContent = response.textParts[i];
        let delay = 0;

        if (i === 0) {
          useAppStore.getState().setIsThinking(true);

          const isDocumentHidden = typeof document !== 'undefined' ? (document.hidden || !document.hasFocus()) : false;
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
            if (ctx.isCancelled()) break;
            useAppStore.getState().setIsThinking(true);
          }

          delay = 1500 + (textContent.length * 60);
          delay = Math.max(3000, Math.min(12000, delay));
        } else {
          delay = 1500 + (textContent.length * 40) + (Math.random() * 1000);
          delay = Math.min(8000, delay);
        }

        await new Promise(r => setTimeout(r, delay));

        if (ctx.isCancelled()) break;

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

    if (!ctx.isCancelled()) {
      setTimeout(() => useAppStore.getState().setIsTalking(false), 2000);
    }

    if (response.activateSleepMode) {
      console.log('[SLEEP MODE] Activating after topic-ending reply.');
      ctx.setHasGoneToSleep(true);
      useAppStore.getState().setCurrentEmotion('sleepy');
    }

    // --- A-12 RAG INDEXING ---
    if (!ctx.isCancelled() && backupConfig.ragEnabled) {
      const fullModelResponse = response.textParts.join(' ');

      const d = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const parts = formatter.formatToParts(d);
      const p: Record<string, string> = {};
      parts.forEach(part => { p[part.type] = part.value; });
      const timeStr = `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute} (JST)`;

      const imageDesc = response.imageCaption ? `(Image Description: ${response.imageCaption})` : '';

      const ragEntry = `【Time: ${timeStr}】\nUser: ${userTextForRag} ${imageDesc}\nKumiko: ${fullModelResponse}`;
      const memoryDecision = evaluateRagMemoryCandidate(ragEntry, 'turn_pair');

      if (!memoryDecision.shouldStore) {
        console.log(`[RAG FILTER] Skipped turn pair archive (${memoryDecision.reason})`, memoryDecision.flags);
      } else if (hasRecentRagDuplicate(memoryDecision.dedupeKey, ctx.getRecentRagDedupeKeys())) {
        console.log('[RAG FILTER] Skipped duplicate turn pair archive.');
      } else {
        ctx.appendRagDedupeKey(memoryDecision.dedupeKey);

        useAppStore.getState().setRagStatus('INDEXING');
        saveLocalRagMemory(ragEntry, undefined, {
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

    // --- A-12 SUMMARY BOUNDARY EVALUATION ---
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

    const messagesSnapshotRef = {
      get current() { return ctx.getMessagesSnapshot(); },
      set current(_v: Message[]) { /* readonly snapshot for summary */ },
    } as React.MutableRefObject<Message[]>;
    const summaryRunningLiveRef = {
      get current() { return ctx.getSummaryRunning(); },
      set current(v: boolean) { ctx.setSummaryRunning(v); },
    } as React.MutableRefObject<boolean>;
    const summaryEmbedCacheRef: React.MutableRefObject<Map<string, Float32Array>> = {
      current: ctx.summaryEmbeddingCache,
    };

    if (!boundaryDecision.shouldSummarize && boundaryDecision.turnsInSegment >= SUMMARY_SOFT_THRESHOLD) {
      const semanticSignal = await calculateSummarySemanticSignalStandalone(messagesSnapshotRef, summaryEmbedCacheRef, workingSummaryState);
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
      const continuationSignal = await calculateSummaryContinuationSignalStandalone(messagesSnapshotRef, summaryEmbedCacheRef, workingSummaryState);
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
        messagesRef: messagesSnapshotRef,
        summaryRunningRef: summaryRunningLiveRef,
      };
      const summaryHelpers: TriggerAutoSummaryHelpers = {
        deriveSummaryTopicLabel: ctx.deriveSummaryTopicLabel,
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

  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error('ExecuteSend Error:', err);
    if (err.message === 'RATE_LIMIT_EXCEEDED') {
      const config = getCurrentAIConfig();
      if (config.activeKey === 'primary' && config.apiKey_backup) {
        console.warn('[KEY_SWITCH] Primary key rate limited. Switching to backup key.');
        if (ctx.origin === 'desktop') {
          void dialogService.alert({
            message: '主 API Key 已达到当日请求上限，将自动切换至备用 Key 并重试...',
            icon: 'warning',
          });
        }
        const newConfig: AIConfig = {
          ...config,
          activeKey: 'backup',
          keySwitchTimestamp: Date.now(),
        };
        // Phase 6 Part B: route through setAIConfig so phones re-hydrate
        // the new activeKey + keySwitchTimestamp. Fire-and-forget is fine
        // here — the retry below doesn't depend on the broadcast landing.
        void setAIConfig(newConfig);
        ctx.onRetry();
        return;
      } else if (ctx.origin === 'desktop') {
        void dialogService.alert({
          message: 'API Key(s) have reached the daily request limit.',
          icon: 'error',
        });
      }
    }

    if (backupConfig.ragEnabled) useAppStore.getState().setRagStatus('ERROR');
    if (!ctx.isCancelled()) {
      const s4 = useAppStore.getState();
      s4.setIsThinking(false);
      s4.setIsTalking(false);
      const failMsg = err.message || 'Unknown error';
      ctx.markPendingFailed(failMsg);
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

// ---------------------------------------------------------------------------
// sendUserMessageFromMobile — Phase 2 Part D
// ---------------------------------------------------------------------------
//
// Phone-originated turns funnel through here. Unlike the desktop's
// executeSend() we don't own UI timers or pending-ref bookkeeping on
// the phone, but we DO run the same executeSendCore pipeline —
// including RAG recall, memory query session threading, summary
// cycle boundaries, voice delivery and anchor parsing. Anything that
// wants to diverge needs a dedicated `ctx.origin === 'mobile'` branch
// inside executeSendCore.
//
// What this DOES keep from executeSend:
//   - full sendMessageToGemini call with coreMemory, worldBook, history
//     slice (pinned + recent, capped at contextLimit), RAG context,
//     anchors, kumikoNotebook (psyche state), locationConfig, language
//   - anchor add/delete action from the model reply
//   - turnCount increment (so summary cycle keeps ticking)
//   - currentEmotion update (so the WS broadcaster pushes the right
//     mood dot to the phone)
//   - memory query session threading: we reuse the App.tsx
//     `memoryQuerySessionRef` when a chat pipeline registration is
//     present so consecutive phone turns continue the same temporal/
//     topic search thread desktop would; when no registration is
//     present we fall through to a module-level singleton so at least
//     the current page session stays consistent.
//
// What this DOES NOT do:
//   - UI timers (countdown, send timer) — there's no input box on PC
//     to animate for a phone-originated turn
//   - reminder parsing (kept desktop-only for now so scheduling stays
//     single-owner; the scheduler is still only watched by the desktop
//     renderer)
//   - optimistic pendingTextRef / pendingImageRef bookkeeping
//
// The caller (useMobileApiProxy's handleChat) awaits this and returns
// { userMessageId, modelMessageIds } so the phone can show a progress
// marker. The actual UI update for new messages arrives via the Phase
// 2 Part C WebSocket broadcaster picking up the Zustand mutations.

export interface SendUserMessageFromMobileOptions {
  imageId?: string;
  voiceFileId?: string;
}

export interface SendUserMessageFromMobileResult {
  userMessageId: string;
  modelMessageIds: string[];
  error?: string;
  code?: string;
}

export async function sendUserMessageFromMobile(
  text: string,
  options: SendUserMessageFromMobileOptions = {},
): Promise<SendUserMessageFromMobileResult> {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) {
    return { userMessageId: '', modelMessageIds: [], error: 'Empty message', code: 'E_EMPTY' };
  }

  // 1. Persist the user message. We go through addMessageToStore so the
  // Zustand store sees it immediately (and the WS broadcaster pushes a
  // message:added to the phone), then mirror into Dexie for durability.
  const nowUser = Date.now();
  const userMessageId = `m-${nowUser}-${Math.random().toString(36).slice(2, 8)}`;
  const userMessage: Message = {
    id: userMessageId,
    role: 'user',
    text: trimmed,
    timestamp: nowUser,
    imageId: options.imageId,
    voiceFileId: options.voiceFileId,
    isVoiceMessage: options.voiceFileId ? true : undefined,
  };
  try {
    await db.messages.put(mapMessageToEntity(userMessage));
  } catch (e) {
    return {
      userMessageId: '',
      modelMessageIds: [],
      error: `DB write failed: ${(e as Error).message}`,
      code: 'E_DB',
    };
  }
  useAppStore.getState().setMessages((prev) => [...prev, userMessage]);

  // 2. Snapshot the message list BEFORE the core runs so we can diff
  // after and return just the IDs the core added. The WS broadcaster
  // pushes the new messages to the phone independently, but the HTTP
  // response carries the IDs so the phone can highlight just-sent bubbles.
  const preCoreIds = new Set(useAppStore.getState().messages.map(m => m.id));

  // 3. Build an ExecuteSendCoreContext backed by (a) the chat pipeline
  // registration when available (for voice + summary helpers wired from
  // App.tsx), and (b) local fallbacks for mobile-only state (RAG dedup
  // keys, summary embedding cache).
  //
  // Memory query session: when a registration is present we route
  // through `registration.memoryQuerySessionRef` which is the same ref
  // App.tsx owns and useInitialLoadBootstrap pre-hydrates from Dexie
  // (`kumiko_memory_query_session`). That keeps consecutive phone turns
  // threaded through the same historical recall thread just like
  // desktop. Before the registration is attached (very early HTTP
  // calls right after boot) we fall back to the module-level
  // singleton so at least the current page session stays consistent.
  let mobileRagDedupeKeys: string[] = [];
  try {
    const stored = await db.getVal<string[]>('kumiko_rag_dedupe_keys', []);
    mobileRagDedupeKeys = Array.isArray(stored) ? stored : [];
  } catch {
    mobileRagDedupeKeys = [];
  }

  const registration = tryGetChatPipelineRegistration();

  const runVoicePipeline: RunVoicePipelineFn = registration
    ? registration.runVoicePipeline
    : async () => ({ success: false, voiceFileId: null, voiceDuration: null, japaneseText: null });

  const deriveSummaryTopicLabel: DeriveSummaryTopicLabelFn = registration
    ? registration.deriveSummaryTopicLabel
    : () => '';

  const mobileSummaryEmbeddingCache = registration
    ? registration.summarySemanticEmbeddingCacheRef.current
    : new Map<string, Float32Array>();

  let mobileSummaryRunning = registration
    ? registration.summaryRunningRef.current
    : false;

  const currentPendingIds = new Set<string>([userMessageId]);
  const ttsConfigSnapshot = useAppStore.getState().ttsConfig;

  const ctx: ExecuteSendCoreContext = {
    origin: 'mobile',
    combinedText: trimmed,
    userTextForRag: trimmed,
    finalImage: null,
    pendingImageMessageId: null,
    pendingMessageIds: currentPendingIds,
    currentTurnStartMessageId: userMessageId,
    generationId: 0,
    isCancelled: () => false,
    getMemoryQuerySession: () => registration
      ? registration.memoryQuerySessionRef.current
      : mobileMemoryQuerySessionFallback,
    setMemoryQuerySession: (s) => {
      if (registration) {
        // Same helper desktop uses: writes to the App.tsx ref AND
        // persists to Dexie via `kumiko_memory_query_session` so a
        // phone-triggered temporal-recall thread survives reload.
        updateMemoryQuerySessionRef(
          { memoryQuerySessionRef: registration.memoryQuerySessionRef },
          s,
        );
        return;
      }
      // No registration yet — normalize shape and persist to Dexie
      // directly so desktop bootstrap picks it up when it mounts.
      const normalized = normalizeMemoryQuerySession(s);
      mobileMemoryQuerySessionFallback = normalized;
      void db.setVal('kumiko_memory_query_session', normalized);
    },
    getRecentRagDedupeKeys: () => mobileRagDedupeKeys,
    appendRagDedupeKey: (k) => {
      if (!k) return;
      mobileRagDedupeKeys = [k, ...mobileRagDedupeKeys.filter(x => x !== k)].slice(0, 48);
      void db.setVal('kumiko_rag_dedupe_keys', mobileRagDedupeKeys);
    },
    getMessagesSnapshot: () => useAppStore.getState().messages,
    getSummaryRunning: () => registration ? registration.summaryRunningRef.current : mobileSummaryRunning,
    setSummaryRunning: (v) => {
      if (registration) registration.summaryRunningRef.current = v;
      else mobileSummaryRunning = v;
    },
    summaryEmbeddingCache: mobileSummaryEmbeddingCache,
    setHasGoneToSleep: (v) => {
      if (registration) registration.hasGoneToSleepRef.current = v;
    },
    runVoicePipeline,
    deriveSummaryTopicLabel,
    ttsConfig: ttsConfigSnapshot,
    clearPendingBuffers: () => { /* mobile has no pending buffers */ },
    markPendingSending: () => {
      useAppStore.getState().setMessages((prev) => prev.map(m =>
        m.id === userMessageId ? { ...m, sendStatus: 'sending' as const } : m,
      ));
    },
    markPendingRead: () => {
      useAppStore.getState().setMessages((prev) => prev.map(m =>
        m.id === userMessageId ? { ...m, isRead: true, sendStatus: undefined, failReason: undefined } : m,
      ));
    },
    markPendingFailed: (reason) => {
      useAppStore.getState().setMessages((prev) => prev.map(m =>
        m.id === userMessageId ? { ...m, sendStatus: 'failed' as const, failReason: reason } : m,
      ));
    },
    // Mobile-originated turns skip the confirm gate. The dialog itself
    // IS mounted on mobile (App.tsx renders DiaryBackfillDialogLazy from
    // `backfillGapInfo`), but we can't hand control over to it — the
    // phone's WS session may drop mid-turn, so `executeSend` would hang
    // forever waiting for a confirmation that will never fire. Instead
    // the mobile path in `maybeHandleDiaryGapInterception` kicks off
    // `runAutoDiaryBackfill` directly and lets the dialog follow along
    // as a progress banner.
    waitForBackfillGate: undefined,
    // The busy-state follow-up currently relies on
    // triggerNativeProactiveMessage which reads the desktop refs. When
    // a chat pipeline is registered we delegate to it so the follow-up
    // fires through the same desktop infrastructure (and the phone
    // hears it via WS broadcast). Otherwise we skip.
    triggerBusyFollowUp: registration
      ? (event) => {
          const fakeRefs: ChatActionRefs = {
            messagesRef: registration.messagesRef,
            generationIdRef: registration.generationIdRef,
            pendingTextRef: registration.pendingTextRef,
            pendingImageRef: registration.pendingImageRef,
            pendingImageMessageIdRef: registration.pendingImageMessageIdRef,
            pendingMessageIdsRef: registration.pendingMessageIdsRef,
            ttsConfigRef: registration.ttsConfigRef,
            memoryQuerySessionRef: registration.memoryQuerySessionRef,
            recentRagDedupeKeysRef: registration.recentRagDedupeKeysRef,
            countdownIntervalRef: registration.countdownIntervalRef,
            sendTimerRef: registration.sendTimerRef,
            preValidationActiveRef: registration.preValidationActiveRef,
            pendingSendRef: registration.pendingSendRef,
            welcomeTriggeredRef: registration.welcomeTriggeredRef,
            hasGoneToSleepRef: registration.hasGoneToSleepRef,
            sleepWarningTimestampRef: registration.sleepWarningTimestampRef,
            sleepFarewellSentRef: registration.sleepFarewellSentRef,
            lateNightWakeRolledRef: registration.lateNightWakeRolledRef,
            lateNightWakeResultRef: registration.lateNightWakeResultRef,
            lateNightWakeTimestampRef: registration.lateNightWakeTimestampRef,
            summaryRunningRef: registration.summaryRunningRef,
            summarySemanticEmbeddingCacheRef: {
              current: mobileSummaryEmbeddingCache,
            } as React.MutableRefObject<Map<string, Float32Array>>,
            inputRef: registration.inputRef,
          };
          triggerNativeProactiveMessage(fakeRefs, 0, event);
        }
      : undefined,
    onRetry: () => { void sendUserMessageFromMobile(text, options); },
  };

  // 4. Run the shared chat pipeline. Model replies, reminders, anchors,
  // RAG indexing, summary boundaries, voice delivery — everything that
  // the desktop path does is exercised here via ctx.
  try {
    await executeSendCore(ctx);
  } catch (e) {
    return {
      userMessageId,
      modelMessageIds: [],
      error: `Pipeline failed: ${(e as Error).message}`,
      code: 'E_PIPELINE',
    };
  }

  // 5. Diff the messages list to collect IDs the core added so the HTTP
  // response can return them. The WS broadcaster pushes the same
  // messages to the phone in real time — the IDs in the HTTP response
  // just give the phone a hint about which bubbles to highlight.
  const postCoreMessages = useAppStore.getState().messages;
  const modelMessageIds: string[] = [];
  for (const m of postCoreMessages) {
    if (!preCoreIds.has(m.id) && m.id !== userMessageId && m.role === 'model') {
      modelMessageIds.push(m.id);
    }
  }

  // 6. Persist any model messages the core added to Dexie. The desktop
  // autosave effect in App.tsx will eventually do this via
  // syncRawHistoryMessages, but we front-run it so the HTTP response
  // can't race ahead of durability.
  try {
    const writePromises: Promise<unknown>[] = [];
    for (const id of modelMessageIds) {
      const msg = postCoreMessages.find(m => m.id === id);
      if (msg) writePromises.push(db.messages.put(mapMessageToEntity(msg)));
    }
    await Promise.all(writePromises);
  } catch (e) {
    console.warn('[MOBILE-CHAT] Persist model reply to Dexie failed:', e);
  }

  return { userMessageId, modelMessageIds };
}
