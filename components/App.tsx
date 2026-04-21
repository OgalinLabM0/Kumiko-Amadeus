
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useAppStore } from '../store';
import { SystemToast } from './SystemToast';
import { AppFlowScreens } from './app/AppFlowScreens';
import { AppMainView } from './app/AppMainView';
import { DiaryBackfillDialog as DiaryBackfillDialogLazy } from './DiaryBackfillDialog';
import { buildAppMainViewProps } from './app/buildAppMainViewProps';
import { getAppShellStyles } from './app/appShellStyles';
import {
  appendRecentSummarySegment,
  buildSummarySegmentId,
  buildRecentSummaryBuffer,
  evaluateSummaryBoundary,
  getArchivedSummaryProgressText,
  getSummaryContinuationCarryoverState,
  getSummaryContinuationPayload,
  getSummarySegmentMessages,
  getSummarySemanticWindowPayload,
  getTurnsInActiveSummarySegment,
  SUMMARY_SOFT_THRESHOLD,
  SummarySemanticSignal,
} from './app/summaryCycle';
import { ExtendedSyncStatus } from './SyncStatus'; 
import { useAutoSave } from '../hooks/useAutoSave'; 
import { useAppViewport } from '../hooks/useAppViewport';
import { useKumikoStatusLine } from '../hooks/useKumikoStatusLine';
import { useInitialLoadBootstrap } from '../hooks/useInitialLoadBootstrap';
import { useVoicePipeline } from '../hooks/useVoicePipeline';
import { useProactiveLifeCycle } from '../hooks/useProactiveLifeCycle';
import { useBackupWorkflow } from '../hooks/useBackupWorkflow';
import { useMobileApiProxy } from './app/useMobileApiProxy';
import { useMobileBroadcaster } from './app/useMobileBroadcaster';
import { useMobileMessageSync } from './app/useMobileMessageSync';
import { sendChatFromMobile } from './app/mobileChatSend';
import { ensurePushSubscription } from '../services/pushSubscriptionService';
import { useUnreadAlertsChrome } from '../hooks/useUnreadAlertsChrome';
import { usePreferencesPersistence } from '../hooks/usePreferencesPersistence';
import { useWorldBookLocalization } from '../hooks/useWorldBookLocalization';
import { useDevLogs } from '../hooks/useDevLogs';
import { RAG_HISTORY_DIRTY_STORAGE_KEY } from '../store/slices/ragSlice';
import { LoadingDataScreen } from './app/AppStatusOverlays';
import { Message, AppState, EmotionType, WorldBookEntry, Language, LocationConfig, BackupConfig, AnchorEntry, AIConfig, ChatResponse, SummaryArchiveState, SummaryBoundaryReason, MemoryQuerySession, TemporalQueryPrecision, TemporalQuerySource, TemporalQueryDiagnosticsStatus, TemporalQueryConfidence, SummarySegmentMetadata, TtsConfig, VoiceMode } from '../types';
import { sendMessageToGemini, startChat, summarizeConversation, searchRagMemory, saveRagMemory, uploadImageToBackend, analyzeTemporalQueryDetailed, getTemporalSearchRoleFromQuery, rewriteHistoricalRecallQueryDetailed, type HistoricalQueryRewrite, type HistoricalSearchStrategy, type TemporalQueryAnalysis, type TemporalQueryDiagnostics } from '../services/geminiService';
import { UI_TRANSLATIONS, DEFAULT_LOCATION_CONFIG } from '../constants';
import { VoiceCallOverlay } from './VoiceCallOverlay';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { compressAndSaveImage, getImageBase64 } from '../services/imageService';
import { evaluateRagMemoryCandidate, hasRecentRagDuplicate } from '../services/ragMemoryFilter';

import {
  db,
  INITIAL_WORLD_CHARACTER_STATUS,
  type DailyFragmentEntity,
  type EpisodeEntity,
  type KumikoDiaryEntity,
  type MessageEntity,
  type PsycheStateEntity,
  type WorldCharacterStatusMap
} from '../services/db';
import { normalizeBackupConfig } from '../services/appConfig';
import { loadTemporalEpisodesForRange, syncTemporalEpisodes } from '../services/temporalEpisodeService';
import {
  isDesktopElectron,
  setDesktopBackgroundThrottling,
  refocusDesktopWebContents,
} from '../services/desktopBackupService';
import { isMobilePwa } from '../services/environment';
import { subscribeEvents as subscribeMobileEvents } from '../services/httpApi';
import {
  MEMORY_QUERY_SESSION_STORAGE_KEY,
  SUMMARY_SEMANTIC_CACHE_LIMIT,
} from './app/appConstants';
import {
  normalizeImportedBackupMessages,
} from './app/messageMappers';
import {
  syncRawHistoryMessages,
  buildHistoryEvidenceMessages,
} from './app/rawHistorySync';
import {
  parseRelativeReminderRequest,
  parseDailyReminderRequest,
  sanitizeWorldCharacterStatusRecord,
  sanitizeKumikoDiaryRecord,
  sanitizeDailyFragmentRecord,
  sanitizePsycheStateRecord,
  sanitizeEpisodeRecord,
  summarizeBackupPayloadForLog,
} from './app/backupHelpers';
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
} from './app/ragRecallHelpers';
import {
  handleExportBackup as handleExportBackupAction,
  handleImportBackup as handleImportBackupAction,
} from './app/backupActions';
import {
  triggerAutoSummary as triggerAutoSummaryAction,
  handleRebuildRag as handleRebuildRagAction,
} from './app/summaryActions';
import {
  addMessageToStore,
  executeSend as executeSendAction,
  handleSendAction,
  type ChatActionRefs,
  type ExecuteSendHelpers,
} from './app/chatActions';
import { registerChatPipeline, unregisterChatPipeline } from './app/chatPipelineRegistry';
import { useAppUpdater } from './app/useAppUpdater';
import { useLocalFileBackup } from './app/useLocalFileBackup';
import { useAppPreferencesSync } from './app/useAppPreferencesSync';
import { useScheduledReminders } from './app/useScheduledReminders';
import { useMessageHistoryOperations } from './app/useMessageHistoryOperations';


export const App = () => {
  // Mount the Phase 1 mobile remote-access IPC listener before any other
  // state hook so the desktop renderer immediately handles phone HTTP
  // requests once the Fastify server comes up. Safe no-op in non-Electron
  // contexts (web / PWA). See docs/mobile-remote-access.md.
  useMobileApiProxy();
  // Phase 2 Part C: broadcast store state changes to connected phones.
  // Must run after useMobileApiProxy so both hooks share the same
  // electronAPI-not-available early exit pattern.
  useMobileBroadcaster();
  // Phase 4 Part E: consume the broadcaster's events on the mobile side.
  // On the PC (electronAPI present) this is a no-op; on mobile PWA it
  // subscribes to /ws and applies message/status events to the local
  // Zustand store so <App /> re-renders in real time.
  useMobileMessageSync();
  const { devLogs, setDevLogs } = useDevLogs();
  const isBulkRestoreInProgressRef = useRef(false);
  const rawHistorySyncedIdsRef = useRef<Set<string>>(new Set());
  const forceRawHistoryResyncRef = useRef(false);
  const skipNextRawHistorySyncRef = useRef(false);
  const memoryQuerySessionRef = useRef<MemoryQuerySession | null>(null);
  const updateMemoryQuerySession = useCallback((nextSession: MemoryQuerySession | null) => {
    const normalizedSession = normalizeMemoryQuerySession(nextSession);
    memoryQuerySessionRef.current = normalizedSession;
    void db.setVal(MEMORY_QUERY_SESSION_STORAGE_KEY, normalizedSession);
  }, []);

  // --- PERSISTENCE LOGIC START ---
  const isDataLoaded = useAppStore(s => s.isDataLoaded);
  const setIsDataLoaded = useAppStore(s => s.setIsDataLoaded);
  const dataLoadError = useAppStore(s => s.dataLoadError);
  const setDataLoadError = useAppStore(s => s.setDataLoadError);
  const messages = useAppStore(s => s.messages);
  const setMessages = useAppStore(s => s.setMessages);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    if (skipNextRawHistorySyncRef.current) {
      skipNextRawHistorySyncRef.current = false;
      return;
    }

    const currentIds = new Set(messages.map(message => message.id));
    const previousIds = rawHistorySyncedIdsRef.current;
    const hasRemovedIds = previousIds.size > 0 && [...previousIds].some((id: string) => !currentIds.has(id));
    const shouldForceFull = forceRawHistoryResyncRef.current || hasRemovedIds;

    syncRawHistoryMessages(messages, { forceFull: shouldForceFull })
      .then(async () => {
        await syncTemporalEpisodes(messages);
        rawHistorySyncedIdsRef.current = currentIds;
        forceRawHistoryResyncRef.current = false;
      })
      .catch(e => console.warn("DB Save Failed:", e));
  }, [messages, isDataLoaded]);
  // --- PERSISTENCE LOGIC END ---

  // UPDATED: Added 'CONFIG' to flow state
  const flowState = useAppStore(s => s.flowState);
  const setFlowState = useAppStore(s => s.setFlowState);
  const inputValue = useAppStore(s => s.inputValue);
  const setInputValue = useAppStore(s => s.setInputValue);
  const selectedImage = useAppStore(s => s.selectedImage);
  const setSelectedImage = useAppStore(s => s.setSelectedImage);
  const selectedImageId = useAppStore(s => s.selectedImageId);
  const setSelectedImageId = useAppStore(s => s.setSelectedImageId);
  const appState = useAppStore(s => s.appState);
  const setAppState = useAppStore(s => s.setAppState);
  const isDarkMode = useAppStore(s => s.isDarkMode);
  const setIsDarkMode = useAppStore(s => s.setIsDarkMode);
  const isFullscreen = useAppStore(s => s.isFullscreen);
  const setIsFullscreen = useAppStore(s => s.setIsFullscreen);

  const { appShellRef, isIOS, toggleFullscreen } = useAppViewport({
    flowState,
    isDarkMode,
    setIsFullscreen,
  });

  const replyingToMsg = useAppStore(s => s.replyingToMsg);
  const setReplyingToMsg = useAppStore(s => s.setReplyingToMsg);
  const highlightedMessageId = useAppStore(s => s.highlightedMessageId);
  const setHighlightedMessageId = useAppStore(s => s.setHighlightedMessageId);
  const systemNotice = useAppStore(s => s.systemNotice);
  const setSystemNotice = useAppStore(s => s.setSystemNotice);

  const language = useAppStore(s => s.language);
  const setLanguage = useAppStore(s => s.setLanguage);

  const t = UI_TRANSLATIONS[language];

  const locationConfig = useAppStore(s => s.locationConfig);
  const setLocationConfig = useAppStore(s => s.setLocationConfig);

  const coreMemory = useAppStore(s => s.coreMemory);
  const setCoreMemory = useAppStore(s => s.setCoreMemory);

  const kumikoNotebook = useAppStore(s => s.kumikoNotebook);
  const setKumikoNotebook = useAppStore(s => s.setKumikoNotebook);

  const contextLimit = useAppStore(s => s.contextLimit);
  const setContextLimit = useAppStore(s => s.setContextLimit);

  const diaryLayerPreset = useAppStore(s => s.diaryLayerPreset);
  const setDiaryLayerPreset = useAppStore(s => s.setDiaryLayerPreset);

  const imageQualityPreset = useAppStore(s => s.imageQualityPreset);
  const setImageQualityPreset = useAppStore(s => s.setImageQualityPreset);

  const worldBook = useAppStore(s => s.worldBook);
  const setWorldBook = useAppStore(s => s.setWorldBook);

  useWorldBookLocalization({ language, isDataLoaded, setWorldBook });

  const turnCount = useAppStore(s => s.turnCount);
  const setTurnCount = useAppStore(s => s.setTurnCount);

  const summaryArchiveState = useAppStore(s => s.summaryArchiveState);
  const setSummaryArchiveState = useAppStore(s => s.setSummaryArchiveState);

  const isMemoryPanelOpen = useAppStore(s => s.isMemoryPanelOpen);
  const setIsMemoryPanelOpen = useAppStore(s => s.setIsMemoryPanelOpen);
  const isProfileOpen = useAppStore(s => s.isProfileOpen);
  const setIsProfileOpen = useAppStore(s => s.setIsProfileOpen);
  const isSettingsOpen = useAppStore(s => s.isSettingsOpen);
  const setIsSettingsOpen = useAppStore(s => s.setIsSettingsOpen);
  const isMessageCenterOpen = useAppStore(s => s.isMessageCenterOpen);
  const setIsMessageCenterOpen = useAppStore(s => s.setIsMessageCenterOpen);
  const isTaskPanelOpen = useAppStore(s => s.isTaskPanelOpen);
  const setIsTaskPanelOpen = useAppStore(s => s.setIsTaskPanelOpen);
  const isDiaryOpen = useAppStore(s => s.isDiaryOpen);
  const setIsDiaryOpen = useAppStore(s => s.setIsDiaryOpen);
  const diaryRewritingDate = useAppStore(s => s.diaryRewritingDate);
  const setDiaryRewritingDate = useAppStore(s => s.setDiaryRewritingDate);
  const diaryBfProgress = useAppStore(s => s.diaryBfProgress);
  const setDiaryBfProgress = useAppStore(s => s.setDiaryBfProgress);
  const diaryBfComplete = useAppStore(s => s.diaryBfComplete);
  const setDiaryBfComplete = useAppStore(s => s.setDiaryBfComplete);
  const diaryBfCount = useAppStore(s => s.diaryBfCount);
  const setDiaryBfCount = useAppStore(s => s.setDiaryBfCount);
  const backfillGapInfo = useAppStore(s => s.backfillGapInfo);
  const setBackfillGapInfo = useAppStore(s => s.setBackfillGapInfo);
  const backfillProgress = useAppStore(s => s.backfillProgress);
  const backfillComplete = useAppStore(s => s.backfillComplete);
  const backfillGeneratedCount = useAppStore(s => s.backfillGeneratedCount);
  const runDiaryBackfill = useAppStore(s => s.runDiaryBackfill);
  const isAutoDiaryBackfillEnabled = useAppStore(s => s.isAutoDiaryBackfillEnabled);
  const runAutoDiaryBackfill = useAppStore(s => s.runAutoDiaryBackfill);
  const handleBackfillAll = useAppStore(s => s.handleBackfillAll);
  const handleBackfillOne = useAppStore(s => s.handleBackfillOne);
  const dismissBackfill = useAppStore(s => s.dismissBackfill);
  const pendingSendRef = useRef<(() => void) | null>(null);
  const handleBackfillDismiss = useCallback(() => {
    dismissBackfill();
    if (pendingSendRef.current) {
      const resume = pendingSendRef.current;
      pendingSendRef.current = null;
      resume();
    }
  }, [dismissBackfill]);

  useEffect(() => {
    if (flowState !== 'APP' || !isDataLoaded) return;
    void runAutoDiaryBackfill();
  }, [flowState, isDataLoaded, runAutoDiaryBackfill]);

  // Phase 4 Part E: mobile PWA skips the desktop onboarding wizard.
  // INTRO/AUTH/CONFIG configure the *desktop's* local-file backup and
  // AI provider settings — on a phone those are already handled by the
  // PC backend we paired with via MobilePairingGate, so forcing INTRO
  // → APP here keeps mobile users from staring at a blank
  // "Connect / Pair with desktop" wizard that doesn't apply to them.
  // Desktop Electron keeps the normal INTRO → AUTH → CONFIG → APP flow
  // because the guard is gated on `isMobilePwa()`.
  useEffect(() => {
    if (!isMobilePwa()) return;
    if (flowState !== 'INTRO') return;
    setFlowState('APP');
  }, [flowState, setFlowState]);

  // Phase 5 Part A: opportunistic Web Push refresh on mobile.
  // MobilePairingGate fires `ensurePushSubscription` the first time the
  // user taps "Pair phone" (while the iOS user-gesture window is still
  // open for requestPermission). For every *subsequent* launch — where
  // notification permission is already 'granted' and no prompt is
  // needed — this effect rehydrates the subscription so:
  //   - if the service worker updated and the browser invalidated the
  //     old push subscription, we rebuild it,
  //   - if the desktop's VAPID key rotated (e.g. userData wiped and
  //     regenerated), we re-register against the new key,
  //   - if the server lost our row (subscriptions.json corruption),
  //     the first chat push won't be silently dropped — the next boot
  //     restores it.
  // Denied / default permissions short-circuit inside the helper so we
  // never spam the permission prompt outside the pair flow.
  useEffect(() => {
    if (!isMobilePwa()) return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    void ensurePushSubscription();
  }, []);

  const summaryRunningRef = useRef(false);

  const isSelectionMode = useAppStore(s => s.isSelectionMode);
  const setIsSelectionMode = useAppStore(s => s.setIsSelectionMode);
  const selectedIds = useAppStore(s => s.selectedIds);
  const setSelectedIds = useAppStore(s => s.setSelectedIds);
  const showDeleteConfirm = useAppStore(s => s.showDeleteConfirm);
  const setShowDeleteConfirm = useAppStore(s => s.setShowDeleteConfirm);
  const showClearFlow = useAppStore(s => s.showClearFlow);
  const setShowClearFlow = useAppStore(s => s.setShowClearFlow);
  const showDoubleClearFlow = useAppStore(s => s.showDoubleClearFlow);
  const setShowDoubleClearFlow = useAppStore(s => s.setShowDoubleClearFlow);

  const isTalking = useAppStore(s => s.isTalking);
  const setIsTalking = useAppStore(s => s.setIsTalking);
  const isThinking = useAppStore(s => s.isThinking);
  const setIsThinking = useAppStore(s => s.setIsThinking);
  const isListening = useAppStore(s => s.isListening);
  const setIsListening = useAppStore(s => s.setIsListening);
  const timeLeft = useAppStore(s => s.timeLeft);
  const setTimeLeft = useAppStore(s => s.setTimeLeft);
  
  const viewingImage = useAppStore(s => s.viewingImage);
  const setViewingImage = useAppStore(s => s.setViewingImage);
  
  const anchors = useAppStore(s => s.anchors);
  const setAnchors = useAppStore(s => s.setAnchors);
  const relativeReminders = useAppStore(s => s.relativeReminders);
  const setRelativeReminders = useAppStore(s => s.setRelativeReminders);
  const dailyReminders = useAppStore(s => s.dailyReminders);
  const setDailyReminders = useAppStore(s => s.setDailyReminders);
  const getRelativeReminders = useAppStore(s => s.getRelativeReminders);
  const saveRelativeReminder = useAppStore(s => s.saveRelativeReminder);
  const markRelativeReminderRetry = useAppStore(s => s.markRelativeReminderRetry);
  const removeRelativeReminder = useAppStore(s => s.removeRelativeReminder);
  const getDailyReminders = useAppStore(s => s.getDailyReminders);
  const saveDailyReminder = useAppStore(s => s.saveDailyReminder);
  const removeDailyReminder = useAppStore(s => s.removeDailyReminder);
  const toggleDailyReminderPaused = useAppStore(s => s.toggleDailyReminderPaused);
  const markDailyReminderTriggered = useAppStore(s => s.markDailyReminderTriggered);
  const markDailyReminderRetry = useAppStore(s => s.markDailyReminderRetry);

  const messageAlerts = useAppStore(s => s.messageAlerts);
  const setMessageAlerts = useAppStore(s => s.setMessageAlerts);

  usePreferencesPersistence({
    isDataLoaded,
    isBulkRestoreInProgressRef,
    language,
    locationConfig,
    coreMemory,
    kumikoNotebook,
    contextLimit,
    diaryLayerPreset,
    imageQualityPreset,
    worldBook,
    turnCount,
    summaryArchiveState,
    relativeReminders,
    dailyReminders,
    anchors,
    messageAlerts,
  });

  const [worldCharacterStatus, setWorldCharacterStatus] = useState<WorldCharacterStatusMap>(INITIAL_WORLD_CHARACTER_STATUS);
  const [autoSavedKumikoDiary, setAutoSavedKumikoDiary] = useState<KumikoDiaryEntity[]>([]);
  const [autoSavedDailyFragments, setAutoSavedDailyFragments] = useState<DailyFragmentEntity[]>([]);
  const [autoSavedPsycheState, setAutoSavedPsycheState] = useState<PsycheStateEntity | null>(null);

  const liveWorldCharacterStatus = useLiveQuery(
    async () => sanitizeWorldCharacterStatusRecord(await db.getVal('world_character_status', INITIAL_WORLD_CHARACTER_STATUS)),
    []
  );
  const liveKumikoDiary = useLiveQuery(
    async () => (await db.kumikoDiary.orderBy('date').toArray()).map(sanitizeKumikoDiaryRecord).filter(Boolean) as KumikoDiaryEntity[],
    []
  );
  const liveDailyFragments = useLiveQuery(
    async () => (await db.dailyFragments.orderBy('timestamp').toArray()).map(sanitizeDailyFragmentRecord).filter(Boolean) as DailyFragmentEntity[],
    []
  );
  const livePsycheState = useLiveQuery(
    async () => sanitizePsycheStateRecord(await db.psycheState.get('current')),
    []
  );

  useEffect(() => {
    if (liveWorldCharacterStatus) {
      setWorldCharacterStatus(liveWorldCharacterStatus);
    }
  }, [liveWorldCharacterStatus]);

  useEffect(() => {
    if (liveKumikoDiary) {
      setAutoSavedKumikoDiary(liveKumikoDiary);
    }
  }, [liveKumikoDiary]);

  useEffect(() => {
    if (liveDailyFragments) {
      setAutoSavedDailyFragments(liveDailyFragments);
    }
  }, [liveDailyFragments]);

  useEffect(() => {
    if (livePsycheState !== undefined) {
      setAutoSavedPsycheState(livePsycheState);
    }
  }, [livePsycheState]);
  
  const appUpdateState = useAppStore(s => s.appUpdateState);
  const setAppUpdateState = useAppStore(s => s.setAppUpdateState);
  const showAppUpdateModal = useAppStore(s => s.showAppUpdateModal);
  const setShowAppUpdateModal = useAppStore(s => s.setShowAppUpdateModal);
  const handleCheckForAppUpdates = useAppStore(s => s.handleCheckForAppUpdates);
  const handleDownloadAppUpdate = useAppStore(s => s.handleDownloadAppUpdate);
  const handleInstallAppUpdate = useAppStore(s => s.handleInstallAppUpdate);

  useAppUpdater({
    appUpdateState,
    setAppUpdateState,
    setShowAppUpdateModal,
    setSystemNotice,
    language,
  });

  const currentEmotion = useAppStore(s => s.currentEmotion);
  const setCurrentEmotion = useAppStore(s => s.setCurrentEmotion);

  const backupConfig = useAppStore(s => s.backupConfig);
  const setBackupConfig = useAppStore(s => s.setBackupConfig);
  const autoZipEnabled = useAppStore(s => s.autoZipEnabled);
  const setAutoZipEnabled = useAppStore(s => s.setAutoZipEnabled);

  const handleBackupConfigChange = useCallback((nextConfig: BackupConfig) => {
    setBackupConfig(normalizeBackupConfig(nextConfig));
  }, []);

  const ttsConfig = useAppStore(s => s.ttsConfig);
  const setTtsConfig = useAppStore(s => s.setTtsConfig);

  const ragStatus = useAppStore(s => s.ragStatus);
  const setRagStatus = useAppStore(s => s.setRagStatus);
  const ragProgressLabel = useAppStore(s => s.ragProgressLabel);
  const setRagProgressLabel = useAppStore(s => s.setRagProgressLabel);
  const isRagHistoryDirty = useAppStore(s => s.isRagHistoryDirty);
  const setIsRagHistoryDirty = useAppStore(s => s.setIsRagHistoryDirty);
  const ragDirtyNoticeShown = useAppStore(s => s.ragDirtyNoticeShown);
  const setRagDirtyNoticeShown = useAppStore(s => s.setRagDirtyNoticeShown);

  const autoBackupInterval = useAppStore(s => s.autoBackupInterval);
  const setAutoBackupInterval = useAppStore(s => s.setAutoBackupInterval);
  const connectedFileName = useAppStore(s => s.connectedFileName);
  const setConnectedFileName = useAppStore(s => s.setConnectedFileName);
  const lastBackupTime = useAppStore(s => s.lastBackupTime);
  const setLastBackupTime = useAppStore(s => s.setLastBackupTime);

  const syncErrorMessage = useAppStore(s => s.syncErrorMessage);
  const setSyncErrorMessage = useAppStore(s => s.setSyncErrorMessage);
  const showSyncErrorModal = useAppStore(s => s.showSyncErrorModal);
  const setShowSyncErrorModal = useAppStore(s => s.setShowSyncErrorModal);
  const statusText = useAppStore(s => s.statusText);
  const setStatusText = useAppStore(s => s.setStatusText);

  const isDisconnected = useAppStore(s => s.isDisconnected);
  const setIsDisconnected = useAppStore(s => s.setIsDisconnected);

  const {
    handleTtsConfigChange,
    handleToggleAutoZip,
    ttsConfigRef,
  } = useAppPreferencesSync({
    isDataLoaded,
    isBulkRestoreInProgressRef,
    currentEmotion,
    autoZipEnabled,
    setAutoZipEnabled,
    ttsConfig,
    setTtsConfig,
    backupConfig,
    ragStatus,
    setRagStatus,
    setRagProgressLabel,
    isRagHistoryDirty,
    language,
    setStatusText,
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef(messages);

  const summarySemanticEmbeddingCacheRef = useRef<Map<string, Float32Array>>(new Map());
  const recentRagDedupeKeysRef = useRef<string[]>([]);
  
  const fileHandleRef = useRef<any>(null); 
  
  const pendingTextRef = useRef<string>("");
  const pendingImageRef = useRef<string | null>(null);
  const pendingImageMessageIdRef = useRef<string | null>(null);
  
  const pendingMessageIdsRef = useRef<Set<string>>(new Set());
  const generationIdRef = useRef<number>(0);

  // hasPerformedInitialPull was used by the removed cloud sync initial-pull flow.

  // FIX: Restore truncated ragBufferRef logic with try-catch
  const ragBufferRef = useRef<string[]>([]);

  const unreadAlertCount = useMemo(() => messageAlerts.filter(alert => !alert.isRead).length, [messageAlerts]);
  const summaryProgressText = useMemo(
    () => getArchivedSummaryProgressText(summaryArchiveState, turnCount, language),
    [summaryArchiveState, turnCount, language]
  );

  const deriveSummaryTopicLabel = useCallback((
    chunks: string[],
    segmentMessages: Message[],
    summaryText: string
  ) => {
    const candidates = [
      ...(Array.isArray(chunks) ? chunks : []),
      ...segmentMessages
        .filter(message => message.role === 'user' && !message.isHidden)
        .map(message => message.text),
      summaryText,
    ];

    for (const rawCandidate of candidates) {
      if (typeof rawCandidate !== 'string') continue;
      const normalized = rawCandidate
        .replace(/\[[^\]]+\]/g, ' ')
        .replace(/^【[^】]+】/u, '')
        .replace(/^[\s\-:：]+/u, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!normalized) continue;

      return normalized.length > 28 ? `${normalized.slice(0, 28).trim()}…` : normalized;
    }

    return language === 'zh' ? '近期片段' : 'Recent Segment';
  }, [language]);

  // Semantic signal helpers moved to chatActions.ts

  const { markAllAlertsRead, showBackgroundMessageNotification } = useUnreadAlertsChrome({
    flowState,
    unreadAlertCount,
    setMessageAlerts,
  });

  useInitialLoadBootstrap({
    rawHistorySyncedIdsRef,
    forceRawHistoryResyncRef,
    ragBufferRef,
    updateMemoryQuerySession,
    setMessages,
    setIsDisconnected,
    setLanguage,
    setLocationConfig,
    setCoreMemory,
    setKumikoNotebook,
    setContextLimit,
    setDiaryLayerPreset,
    setImageQualityPreset,
    setWorldBook,
    setTurnCount,
    setSummaryArchiveState,
    setAnchors,
    setCurrentEmotion,
    setRelativeReminders,
    setDailyReminders,
    setMessageAlerts,
    setWorldCharacterStatus,
    setAutoSavedKumikoDiary,
    setAutoSavedDailyFragments,
    setAutoSavedPsycheState,
    setBackupConfig,
    setIsRagHistoryDirty,
    setIsDataLoaded,
    setDataLoadError,
    setSystemNotice,
  });

  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const preValidationActiveRef = useRef(false);

  const {
    backupData,
    validateSaveData,
    clearLocalFileConnection,
    performFileSave,
    restoreBackupData,
    restoreParsedBackupPayload,
  } = useBackupWorkflow({
    rawHistorySyncedIdsRef,
    forceRawHistoryResyncRef,
    isBulkRestoreInProgressRef,
    fileHandleRef,
    isDataLoaded,
    updateMemoryQuerySession,
    setConnectedFileName,
    setWorldCharacterStatus,
    setAutoSavedKumikoDiary,
    setAutoSavedDailyFragments,
    setAutoSavedPsycheState,
    worldCharacterStatus,
    autoSavedKumikoDiary,
    autoSavedDailyFragments,
    autoSavedPsycheState,
    messages,
    coreMemory,
    worldBook,
    contextLimit,
    turnCount,
    summaryArchiveState,
    currentEmotion,
    locationConfig,
    language,
    anchors,
    kumikoNotebook,
    relativeReminders,
    dailyReminders,
  });

  const { syncStatus, manualRetry, updateBaseline, triggerManualSave, flushIfDirty } = useAutoSave({
    data: backupData,
    config: backupConfig,
    fileHandle: fileHandleRef.current,
    // dataLoadError blocks saves: if IndexedDB load failed we must NOT overwrite
    // the user's real backup with the empty default state (P0 #3).
    isBlocked: isTalking || isThinking || !!dataLoadError,
    onSaveError: (msg) => {
        console.error("AutoSave Error:", msg);
        setSyncErrorMessage(msg);
    },
    validate: validateSaveData // Pass validation function
  });

  useEffect(() => {
    if (syncStatus === 'SAVED') {
      setLastBackupTime(Date.now());
    }
  }, [syncStatus]);
  
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (!highlightedMessageId) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]); 

  useEffect(() => {
    if (flowState === 'APP') {
        setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
        }, 100);
        setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }, 500);
    }
  }, [flowState]);

  // --- LIVE STATUS UPDATE LOGIC (schedule-aware) ---
  useKumikoStatusLine({ flowState, locationConfig, language, setStatusText });

  const addMessage = addMessageToStore;

  const { translateToJapaneseWithEmotion, translateForGenie, runVoicePipeline } = useVoicePipeline({ ttsConfigRef });

  const voiceCallOverlayData = useAppStore(s => s.voiceCallOverlayData);
  const setVoiceCallOverlayData = useAppStore(s => s.setVoiceCallOverlayData);

  const isAutoZipping = useAppStore(s => s.isAutoZipping);
  const setIsAutoZipping = useAppStore(s => s.setIsAutoZipping);

  useEffect(() => {
    if (isDesktopElectron() && window.electronAPI?.on) {
      const handler = (_event: any, payload: any) => {
        if (payload?.status === 'start') setIsAutoZipping(true);
      };
      window.electronAPI.on('app:auto-zip-progress', handler);
      return () => { window.electronAPI?.removeListener?.('app:auto-zip-progress', handler); };
    }

    // Mobile PWA: auto-zip progress is bridged by useMobileBroadcaster
    // (Phase 3 Part D) as `backup:auto-zip`. The phone only needs the
    // "start" edge for the same UI indicator the desktop shows.
    if (isMobilePwa()) {
      const unsubscribe = subscribeMobileEvents((event) => {
        if (event?.type !== 'backup:auto-zip') return;
        const status = (event as { status?: { status?: string } }).status;
        if (status?.status === 'start') setIsAutoZipping(true);
      });
      return unsubscribe;
    }

    return undefined;
  }, []);

  // Cloud sync removed from the product. `performCloudSync`, `handleCloudRestore`,
  // `handleCloudPush`, `handleCloudConnect` used to live here and POST/GET /api/sync.
  // They are intentionally deleted — see P0 #6 notes in the audit plan.

  const {
    handleCreateNewLocalFile,
    handleOpenLocalFile,
    handleDisconnectLocalFile,
    handleManualLocalReload,
  } = useLocalFileBackup({
    fileHandleRef,
    backupData,
    language,
    setConnectedFileName,
    setBackupConfig,
    setLastBackupTime,
    updateBaseline,
    performFileSave,
    restoreBackupData,
  });

  useEffect(() => {
    const init = async () => {
      try {
        await startChat();
        setAppState(AppState.CONNECTED);
      } catch (error) {
        console.error("Failed to connect:", error);
        setAppState(AppState.ERROR);
      }
    };
    if (flowState === 'APP') {
        init();
    }
  }, [flowState]); 


  const {
    welcomeTriggeredRef,
    hasGoneToSleepRef,
    sleepWarningTimestampRef,
    sleepFarewellSentRef,
    lateNightWakeRolledRef,
    lateNightWakeResultRef,
    lateNightWakeTimestampRef,
  } = useProactiveLifeCycle({
    flowState,
    messages,
    isTalking,
    isThinking,
    language,
    locationConfig,
    coreMemory,
    worldBook,
    contextLimit,
    anchors,
    kumikoNotebook,
    backupConfig,
    setCurrentEmotion,
    addMessage,
    showBackgroundMessageNotification,
  });

  useScheduledReminders({
    flowState,
    isTalking,
    isThinking,
    messagesRef,
    ttsConfigRef,
    runVoicePipeline,
    getRelativeReminders,
    getDailyReminders,
    removeRelativeReminder,
    markRelativeReminderRetry,
    markDailyReminderTriggered,
    markDailyReminderRetry,
    language,
    contextLimit,
    coreMemory,
    worldBook,
    locationConfig,
    anchors,
    kumikoNotebook,
    addMessage,
    showBackgroundMessageNotification,
  });

  // WRAPPED IN USECALLBACK
  const handleSaveMemory = useCallback((newCoreMemory: string, newWorldBook: WorldBookEntry[], newContextLimit: number) => {
    setCoreMemory(newCoreMemory);
    setWorldBook(newWorldBook);
    setContextLimit(newContextLimit);
  }, []);

  // Cloud-related handlers removed. See P0 #6: the cloud-sync product feature was
  // dropped entirely, and all of `handleCloudRestore`, `handleCloudPush`, the
  // `showCloudRestorePrompt` bootstrap effect, and `handleCloudConnect` have been
  // deleted. Business surfaces that previously consumed them now either ignore the
  // prop (if still present as optional) or were updated to no longer request it.

  // FIX: Add missing callback handlers for various UI actions.
  const handleDeleteAnchor = useCallback((id: string) => {
    setAnchors(prev => prev.filter(anchor => anchor.id !== id));
  }, []);

  const handleRebuildRag = useCallback(async () => {
    return handleRebuildRagAction();
  }, [messages, language]);

  const handleExportBackup = useCallback(async () => {
    return handleExportBackupAction(backupData);
  }, [backupData, language]);

  const handleImportBackup = useCallback(async (file: File): Promise<boolean> => {
    return handleImportBackupAction(file, { restoreParsedBackupPayload, updateBaseline });
  }, [restoreParsedBackupPayload, updateBaseline, flowState, backupConfig.ragEnabled]);

  // handleCloudConnect removed with cloud sync (P0 #6).

  // ... (Rest of event handlers like selection, etc) ...
  const toggleSelectionMode = () => { setIsSelectionMode(!isSelectionMode); setSelectedIds(new Set()); };
  const handleSelectMessage = (id: string) => { setSelectedIds(prev => { const newSet = new Set(prev); if (newSet.has(id)) { newSet.delete(id); } else { newSet.add(id); } return newSet; }); };
  const initiateDeleteSelected = () => { if (selectedIds.size === 0) return; setShowDeleteConfirm(true); };
  const initiateClearAll = () => { setShowClearFlow(true); };

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        const imageId = await compressAndSaveImage(file);
        const base64 = await getImageBase64(imageId);
        if (base64) {
          setSelectedImage(base64);
          setSelectedImageId(imageId);
        }
      } catch (err) {
        console.error("Failed to process image locally", err);
        alert("图片处理失败 / Image processing failed");
      }
    }
  };

  const triggerAutoSummary = useCallback(async (params: Parameters<typeof triggerAutoSummaryAction>[2]) => {
    return triggerAutoSummaryAction(
      { messagesRef, summaryRunningRef },
      { deriveSummaryTopicLabel },
      params,
    );
  }, [backupConfig, kumikoNotebook, locationConfig, language, deriveSummaryTopicLabel]);

  const handleManualSummary = useCallback(async () => {
    const turnsInSegment = getTurnsInActiveSummarySegment(turnCount, summaryArchiveState);
    if (turnsInSegment < 1) {
      setSystemNotice(language === 'zh' ? '当前没有需要整理的对话' : 'No conversations to archive right now.');
      return;
    }
    setSystemNotice(language === 'zh' ? '正在手动整理记忆……' : 'Manually archiving memories...');
    await triggerAutoSummary({
      currentCount: turnCount,
      currentMemory: coreMemory,
      archiveState: summaryArchiveState,
      reason: 'manual',
      isComplete: true,
      turnsInSegment,
      nextSegmentStartTurn: turnCount,
      nextSegmentStartMessageId: null,
    });
  }, [turnCount, summaryArchiveState, coreMemory, triggerAutoSummary, language]);

  const chatRefs = useMemo((): ChatActionRefs => ({
    messagesRef, generationIdRef, pendingTextRef, pendingImageRef, pendingImageMessageIdRef,
    pendingMessageIdsRef, ttsConfigRef, memoryQuerySessionRef, recentRagDedupeKeysRef,
    countdownIntervalRef, sendTimerRef, preValidationActiveRef, pendingSendRef,
    welcomeTriggeredRef, hasGoneToSleepRef, sleepWarningTimestampRef, sleepFarewellSentRef,
    lateNightWakeRolledRef, lateNightWakeResultRef, lateNightWakeTimestampRef,
    summaryRunningRef, summarySemanticEmbeddingCacheRef, inputRef,
  }), []);
  const executeSendHelpers = useMemo((): ExecuteSendHelpers => ({
    runVoicePipeline, deriveSummaryTopicLabel,
  }), [runVoicePipeline, deriveSummaryTopicLabel]);
  (chatRefs as any).__executeSendHelpers = executeSendHelpers;

  // Phase 3 Part A: register the chat pipeline so mobile-originated
  // turns (executed inside `sendUserMessageFromMobile` via useMobileApiProxy)
  // can reach the desktop refs + voice/summary helpers without prop drilling.
  useEffect(() => {
    registerChatPipeline({
      messagesRef,
      ttsConfigRef,
      generationIdRef,
      pendingMessageIdsRef,
      pendingImageMessageIdRef,
      pendingImageRef,
      pendingTextRef,
      memoryQuerySessionRef,
      recentRagDedupeKeysRef,
      hasGoneToSleepRef,
      sleepWarningTimestampRef,
      sleepFarewellSentRef,
      lateNightWakeRolledRef,
      lateNightWakeResultRef,
      lateNightWakeTimestampRef,
      welcomeTriggeredRef,
      summaryRunningRef,
      summarySemanticEmbeddingCacheRef,
      countdownIntervalRef,
      sendTimerRef,
      preValidationActiveRef,
      pendingSendRef,
      inputRef,
      runVoicePipeline,
      deriveSummaryTopicLabel,
    });
    return () => { unregisterChatPipeline(); };
  }, [runVoicePipeline, deriveSummaryTopicLabel]);

  const executeSend = useCallback(async () => {
    return executeSendAction(chatRefs, executeSendHelpers);
  }, [chatRefs, executeSendHelpers]);

  const regeneratingVoiceIds = useAppStore(s => s.regeneratingVoiceIds);
  const setRegeneratingVoiceIds = useAppStore(s => s.setRegeneratingVoiceIds);

  const {
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
  } = useMessageHistoryOperations({
    messagesRef, ttsConfigRef, inputRef,
    pendingMessageIdsRef, pendingTextRef, pendingImageRef, pendingImageMessageIdRef,
    sendTimerRef, countdownIntervalRef, generationIdRef, skipNextRawHistorySyncRef,
    setMessages, setTurnCount, setSummaryArchiveState,
    setIsRagHistoryDirty, setRagDirtyNoticeShown,
    setReplyingToMsg, setHighlightedMessageId, setInputValue,
    setIsDisconnected, setIsListening, setTimeLeft, setSystemNotice,
    setRegeneratingVoiceIds,
    setIsMemoryPanelOpen, setIsProfileOpen, setIsSettingsOpen,
    setIsTaskPanelOpen, setIsMessageCenterOpen,
    executeSend, updateMemoryQuerySession,
    backupConfig, isRagHistoryDirty, ragDirtyNoticeShown, language,
  });

  const confirmDeleteSelected = () => {
    const nextMessages = messagesRef.current.filter(msg => !selectedIds.has(msg.id));
    applyManualHistoryMutation(nextMessages, 'batch_hard_delete');
    setShowDeleteConfirm(false);
    setIsSelectionMode(false);
    setSelectedIds(new Set());
  };
  const handleClearAll = () => {
      const nextMessages = messagesRef.current.map(msg => ({ ...msg, isHidden: true }));
      applyVisualHistoryMutation(nextMessages);
      setShowClearFlow(false);
      setIsSelectionMode(false);
      pendingTextRef.current = "";
      pendingImageRef.current = null;
      pendingMessageIdsRef.current.clear();
      pendingImageMessageIdRef.current = null;
  };

  const handleSend = useCallback(() => {
    // Phase 4 Part E: on mobile PWA the full desktop pipeline cannot
    // run locally (no API keys, no main-process file access, no Dexie
    // authority). We route chat sends to the PC via /api/ipc/chat; the
    // PC's useMobileApiProxy calls sendUserMessageFromMobile which runs
    // the same executeSendCore() desktop does. New messages arrive back
    // via the WebSocket broadcaster → useMobileMessageSync fold.
    if (isMobilePwa()) {
      const state = useAppStore.getState();
      const text = state.inputValue;
      const image = state.selectedImage;
      const imageId = state.selectedImageId;
      if ((!text || !text.trim()) && !image) return;
      if (state.isThinking) return;
      // Clear input immediately so the user sees the send "went through"
      // even if the PC takes a few seconds to produce the model reply.
      state.setInputValue('');
      state.setSelectedImage(null);
      state.setSelectedImageId(null);
      state.setReplyingToMsg(null);
      // The input-listening indicator is managed on PC now (the phone
      // shows activity via broadcaster events). We still clear any
      // stale countdown timer on the phone side so the UI doesn't flash
      // a ghost "9s" badge after send.
      state.setIsListening(false);
      state.setTimeLeft(0);
      void sendChatFromMobile({
        text: (text || '').trim(),
        imageId: imageId || undefined,
      }).then((result) => {
        if (result.unauthenticated) {
          // Cookie expired — bounce back to MobilePairingGate which will
          // re-pair. We also clear the hydration flag so next mount
          // re-pulls PC state.
          try { sessionStorage.removeItem('kumiko_mobile_hydrated'); } catch { /* ignore */ }
          window.location.reload();
          return;
        }
        if (!result.ok) {
          useAppStore.getState().setSystemNotice(result.error || 'Failed to send message');
          // Restore the text so the user can retry without retyping.
          if (text) useAppStore.getState().setInputValue(text);
          if (image) useAppStore.getState().setSelectedImage(image);
          if (imageId) useAppStore.getState().setSelectedImageId(imageId);
        }
      });
      return;
    }
    handleSendAction(chatRefs);
  }, [inputValue, selectedImage, isThinking, isTalking, executeSend, replyingToMsg, locationConfig, language, messages, t.autoReplyText]);

  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Enter') handleSend(); };
  const toggleTheme = (e?: React.MouseEvent) => {
    const x = e?.clientX ?? window.innerWidth / 2;
    const y = e?.clientY ?? window.innerHeight / 2;
    const endRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));

    if (typeof document.startViewTransition === 'function') {
      const transition = document.startViewTransition(() => {
        setIsDarkMode(prev => !prev);
      });
      transition.ready.then(() => {
        document.documentElement.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`] },
          { duration: 400, easing: 'cubic-bezier(0.33, 1, 0.68, 1)', pseudoElement: '::view-transition-new(root)' }
        );
      }).catch(() => {});
    } else {
      setIsDarkMode(prev => !prev);
    }
  };

  const {
    containerBg,
    overlayClass,
    sidebarBg,
    headerBg,
    textColor,
    mutedTextColor,
    inputAreaBg,
    inputBoxBg,
    chatContainerShadow,
    headerShadow,
    inputShadow,
    avatarPanelBg,
    avatarGradient,
    statusTextColor
  } = getAppShellStyles(isDarkMode);

  const displayRagStatus: 'IDLE' | 'RECALLING' | 'INDEXING' | 'ERROR' | 'OFF' | 'STALE' = !backupConfig.ragEnabled
    ? 'OFF'
    : (ragStatus === 'RECALLING' || ragStatus === 'INDEXING' || ragStatus === 'ERROR')
      ? ragStatus
      : isRagHistoryDirty
        ? 'STALE'
        : 'IDLE';

  const appMainViewProps = buildAppMainViewProps({
    isMemoryPanelOpen,
    setIsMemoryPanelOpen,
    isProfileOpen,
    setIsProfileOpen,
    isSettingsOpen,
    setIsSettingsOpen,
    isMessageCenterOpen,
    setIsMessageCenterOpen,
    isTaskPanelOpen,
    setIsTaskPanelOpen,
    isDiaryOpen,
    setIsDiaryOpen,
    diaryRewritingDate,
    setDiaryRewritingDate,
    diaryBfProgress,
    setDiaryBfProgress,
    diaryBfComplete,
    setDiaryBfComplete,
    diaryBfCount,
    setDiaryBfCount,
    flushIfDirty,
    coreMemory,
    contextLimit,
    messages,
    worldBook,
    handleSaveMemory,
    isDarkMode,
    turnCount,
    summaryProgressText,
    handleManualSummary,
    language,
    handleUpdateMessage,
    handleDeleteMessage,
    handleInsertMessage,
    handleReorderMessages,
    handleToggleHidden,
    handleTogglePin,
    handleJumpToMessage,
    anchors,
    handleDeleteAnchor,
    setViewingImage,
    kumikoNotebook,
    currentEmotion,
    unreadMessageCount: unreadAlertCount,
    messageAlerts,
    relativeReminders,
    dailyReminders,
    handleOpenMessageFromAlert: (messageId: string) => {
      setIsMessageCenterOpen(false);
      handleJumpToMessage(messageId);
      markAllAlertsRead();
    },
    handleDismissMessageAlert: (id: string) => {
      setMessageAlerts(prev => prev.filter(alert => alert.id !== id));
    },
    handleClearMessageAlerts: () => {
      setMessageAlerts([]);
    },
    handleDeleteRelativeReminder: removeRelativeReminder,
    handleDeleteDailyReminder: removeDailyReminder,
    handleToggleDailyReminderPaused: toggleDailyReminderPaused,
    handleExportBackup,
    handleImportBackup,
    handleRebuildRag,
    setLanguage,
    setLocationConfig,
    setAutoBackupInterval,
    handleCreateNewLocalFile,
    handleOpenLocalFile,
    triggerManualSave,
    handleManualLocalReload,
    backupConfig,
    handleToggleAutoZip,
    handleBackupConfigChange,
    handleRegenerateVoice,
    regeneratingVoiceIds,
    handleDisconnectLocalFile,
    devLogs,
    setDevLogs,
    handleTtsConfigChange,
    appUpdateState,
    handleCheckForAppUpdates,
    handleDownloadAppUpdate,
    handleInstallAppUpdate,
    showAppUpdateModal,
    setShowAppUpdateModal,
    showDeleteConfirm,
    setShowDeleteConfirm,
    t,
    confirmDeleteSelected,
    showClearFlow,
    setShowClearFlow,
    setShowDoubleClearFlow,
    showDoubleClearFlow,
    handleClearAll,
    syncStatus,
    showSyncErrorModal,
    setShowSyncErrorModal,
    syncErrorMessage,
    isIOS,
    viewingImage,
    isTalking,
    statusText,
    avatarPanelBg,
    overlayClass,
    avatarGradient,
    statusTextColor,
    isSelectionMode,
    ragStatus: displayRagStatus,
    headerBg,
    headerShadow,
    textColor,
    mutedTextColor,
    fileHandleRef,
    toggleFullscreen,
    toggleSelectionMode,
    toggleTheme,
    manualRetry,
    initiateClearAll,
    selectedIds,
    pendingMessageIdsRef,
    highlightedMessageId,
    isListening,
    isThinking,
    timeLeft,
    messagesEndRef,
    inputRef,
    handleSelectMessage,
    handleRecall,
    handleReply,
    inputAreaBg,
    inputShadow,
    inputBoxBg,
    fileInputRef,
    handleKeyDown,
    handleImageSelect,
    handleSend,
    messagesRef,
    initiateDeleteSelected,
    sidebarBg,
    chatContainerShadow,
    handleResendMessage,
    handleWithdrawMessage,
    isDisconnected
  });

  if (!isDataLoaded) {
    return <LoadingDataScreen />;
  }

  return (
  <div
    id="ka-app-root"
    ref={appShellRef}
    className={`fixed inset-0 w-screen overflow-hidden transition-colors duration-500 ${
      flowState === 'APP' ? containerBg : 'bg-[#f9f7f2]'
    }`}
    style={{
      height: 'var(--app-height)',
      minHeight: 'var(--app-height)',
      maxHeight: 'var(--app-height)',
    }}
  >
    {flowState === 'APP' && ( <div className={`absolute inset-0 z-0 amadeus-bg-grid ${isDarkMode ? 'opacity-100' : 'opacity-30'}`}></div> )}
    {flowState === 'APP' && (
      <AppMainView {...appMainViewProps} />
    )}
    {backfillGapInfo && backfillGapInfo.totalMissing > 0 && (
      <DiaryBackfillDialogLazy
        gapInfo={backfillGapInfo}
        language={language}
        isDarkMode={isDarkMode}
        onConfirmAll={handleBackfillAll}
        onConfirmOne={handleBackfillOne}
        onDismiss={handleBackfillDismiss}
        progress={backfillProgress}
        isComplete={backfillComplete}
        generatedCount={backfillGeneratedCount}
      />
    )}
      <AppFlowScreens
          flowState={flowState}
          appState={appState}
          language={language}
          backupConfig={backupConfig}
          connectedFileName={connectedFileName}
          onLanguageChange={setLanguage}
          onBackupConfigChange={handleBackupConfigChange}
          onSelectLocalFile={handleOpenLocalFile}
          onImportBackup={handleImportBackup}
          onDisconnectLocalFile={handleDisconnectLocalFile}
          onShowAuth={() => setFlowState('AUTH')}
          onShowConfig={() => setFlowState('CONFIG')}
          onShowApp={() => setFlowState('APP')}
          onReconfigure={() => {
              setAppState(AppState.CONNECTING);
              setFlowState('CONFIG');
          }}
      />
      {voiceCallOverlayData && (
        <VoiceCallOverlay
          reminderEvent={voiceCallOverlayData.reminderEvent}
          reminderText={voiceCallOverlayData.reminderText}
          ringtoneFileId={ttsConfig.ringtoneFileId}
          isDarkMode={isDarkMode}
          language={language}
          onAccept={voiceCallOverlayData.onAccept}
          onReject={voiceCallOverlayData.onReject}
          onClose={voiceCallOverlayData.onClose || (() => setVoiceCallOverlayData(null))}
          isConnecting={voiceCallOverlayData.isConnecting}
          isPlayingVoice={voiceCallOverlayData.isPlayingVoice}
          isEnded={voiceCallOverlayData.isEnded}
          voiceFileId={voiceCallOverlayData.voiceFileId}
        />
      )}
      <SystemToast message={systemNotice} onClose={() => setSystemNotice(null)} isDarkMode={isDarkMode} />
      {isAutoZipping && (
        <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 text-white">
            <div className="w-10 h-10 border-4 border-white/30 border-t-white rounded-full animate-spin" />
            <p className="text-sm font-bold">{language === 'zh' ? '正在备份数据，请稍候...' : 'Backing up data, please wait...'}</p>
          </div>
        </div>
      )}
    </div>
  );
};
