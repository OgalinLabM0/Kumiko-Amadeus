
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useAppStore } from '../store';
import { SystemToast } from './SystemToast';
import { GlobalDialogHost } from './GlobalDialogHost';
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
import { useBusyRegulator } from '../hooks/useBusyRegulator';
import { useBackupWorkflow } from '../hooks/useBackupWorkflow';
// F2B.2: deleted useMobileApiProxy / useMobileBroadcaster /
// useMobileMessageSync. They were the PC↔phone bridge over the local
// Fastify HTTP+WebSocket server. Capacitor Android is fully standalone
// (Dexie + Capacitor Filesystem live in-process), and the PWA mode is
// being deprecated in F2B.4 — neither needs IPC fan-out anymore.
// F2B.3: dropped sendChatFromMobile (PWA route through PC's mobile-api-proxy)
// + ensurePushSubscription (PWA Web Push subscription against PC's VAPID).
// Capacitor runs the full pipeline locally and uses native FCM pushes.
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
// F2B.3: dropped `isMobilePwa` and the WS event subscriber. PWA bridge gone.
import { dialogService } from '../services/dialogService';
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
// F2B.1: useMobileRemoteFilePicker deleted — was the wrapper that mounted
// MobileRemoteFileBrowser as the phone-side picker for the LOCAL backup
// tab. The whole mobile-PC bridge (PWA pairing → remote fs:* IPC) is
// being removed; on Android we now just write into the app sandbox via
// Capacitor Filesystem and on PC the desktop dialog still owns the LOCAL tab.
import { useAppPreferencesSync } from './app/useAppPreferencesSync';
import { useScheduledReminders } from './app/useScheduledReminders';
import { useMessageHistoryOperations } from './app/useMessageHistoryOperations';
import { installGlobalAudioUnlock } from '../utils/audioUnlock';
import { startForegroundServiceIfNeeded } from '../services/foregroundServiceController';
import { isCapacitorNative } from '../services/environment';
import { useAndroidPendingActionsDrainer } from '../hooks/useAndroidPendingActionsDrainer';
import { shouldIgnoreEnterDuringImeGrace } from './common/imeGuards';
import { PermissionOnboardingWizard, isAndroidOnboardingCompleted } from './onboarding/PermissionOnboardingWizard';


export const App = () => {
  // F2B.2: removed `useMobileApiProxy()` / `useMobileBroadcaster()` /
  // `useMobileMessageSync()` calls. They were the bidirectional
  // Phase 1/2/4 PC↔phone HTTP+WebSocket bridge. With the PWA being
  // deprecated and the Android APK running standalone, there is no
  // remote renderer to fan out to and no remote phone to receive from.
  useEffect(() => {
    const cleanup = installGlobalAudioUnlock();
    return () => cleanup();
  }, []);

  // B.1 (A6.1): Android foreground service. On Capacitor we kick off
  // the persistent "Kumiko·Amadeus 运行中" status notification so the
  // process survives Doze and the proactive features (RNG / sleep / busy
  // / timed reminders / auto-backup) keep firing while the app is
  // backgrounded or the phone is locked. PWA / Electron skip this branch.
  // The controller is internally idempotent + checks isCapacitorNative()
  // and the user's explicit "disable FG service" toggle, so a no-op on
  // the wrong platforms / when disabled.
  useEffect(() => {
    if (!isCapacitorNative()) return;
    void startForegroundServiceIfNeeded({ language: useAppStore.getState().language });
    // F2A.5: removed the 4h rolling auto-backup boot call. The auto
    // backup wrote zips into the app's private sandbox, which is wiped
    // on uninstall AND had no restore UI — so it cost CPU + storage to
    // protect against ~zero realistic failure modes. The supported path
    // is now the manual export ZIP from BackupSection (with the
    // "save to cloud / SD" hint added in F2A.4).
    // F1.3 hotfix: tell the @capacitor/status-bar plugin to overlay the
    // WebView. Combined with MainActivity.setDecorFitsSystemWindows(false),
    // this is what makes the WebView draw edge-to-edge under the status
    // bar AND nav bar, killing the white strip at the bottom that v2.13.0
    // reports. The dynamic import keeps PC / PWA bundles unaffected.
    void (async () => {
      try {
        const { StatusBar, Style } = await import('@capacitor/status-bar');
        await StatusBar.setOverlaysWebView({ overlay: true });
        await StatusBar.setStyle({ style: Style.Light });
        await StatusBar.setBackgroundColor({ color: '#00000000' });
      } catch (e) {
        console.warn('[App] StatusBar overlay setup failed (non-fatal):', e);
      }
    })();
  }, []);

  // B.2 + B.3 + B.4 + v2.14.24 drainer: drain native-side action queue
  // (call open/accept/decline from MainActivity heads-up taps; Direct
  // Reply text from RemoteReplyReceiver) on app boot + on App.appResume.
  // Hook internally short-circuits on non-Capacitor platforms.
  useAndroidPendingActionsDrainer();
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

  // F2B.1: dropped the Phase 6 mobile-PC onboarding note — Capacitor
  // Android now walks the same INTRO → AUTH → CONFIG → APP flow as
  // desktop, just without the PC pairing step. The LOCAL backup tab is
  // hidden on Android (see F2A.4) so the only mobile-side backup surface
  // is the manual ZIP export/import.

  // F2B.3: dropped the PWA Web Push refresh effect. The PWA's
  // service worker + VAPID-keyed push pipeline is gone with the rest
  // of the bridge. Capacitor APK uses native FCM channels instead.

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

  const setBusySlotRuntime = useAppStore(s => s.setBusySlotRuntime);
  const setBusyFollowUp = useAppStore(s => s.setBusyFollowUp);
  const setPendingApology = useAppStore(s => s.setPendingApology);

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

  // v2.14.9 W.1.A: reverted v2.14.8 V.2.A. JSON.stringify on potentially
  // 100KB+ objects (liveDailyFragments / liveKumikoDiary) blocked the main
  // thread for 50–200ms on every Dexie keyval write, which interrupted
  // Android IME composition events and caused typed characters to be
  // dropped ("input flash + content gone"). Going back to the simple
  // setState; downstream React.memo / shallow checks on individual panels
  // already absorb the cost of a no-op re-render at this scope.
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
  const handleCancelAppUpdate = useAppStore(s => s.handleCancelAppUpdate);
  const handleInstallAppUpdate = useAppStore(s => s.handleInstallAppUpdate);
  const updaterCacheInfo = useAppStore(s => s.updaterCacheInfo);
  const refreshUpdaterCacheInfo = useAppStore(s => s.refreshUpdaterCacheInfo);
  const openUpdaterCacheFolder = useAppStore(s => s.openUpdaterCacheFolder);
  const clearUpdaterCache = useAppStore(s => s.clearUpdaterCache);

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
    setBusySlotRuntime,
    setBusyFollowUp,
    setPendingApology,
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

    // F2B.3: PWA `backup:auto-zip` WS subscriber removed. Capacitor's
    // backup is purely manual (export/import ZIP — see F2A.4); there's
    // no auto-zip status to fan out anymore.
    return undefined;
  }, []);

  // Cloud sync removed from the product. `performCloudSync`, `handleCloudRestore`,
  // `handleCloudPush`, `handleCloudConnect` used to live here and POST/GET /api/sync.
  // They are intentionally deleted — see P0 #6 notes in the audit plan.

  // F2B.1: removed `mobileFilePicker` (was useMobileRemoteFilePicker). The
  // PWA-only LOCAL-tab remote file browser path is gone — desktop Electron
  // hits its own File System Access API dialog (handled inside
  // useLocalFileBackup), and Capacitor Android hides the LOCAL/Advanced
  // backup buttons entirely (see F2A.4 in BackupSection).
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

  // v2.14.23: first-launch Android permission wizard. Mounts as a modal
  // overlay the first time the user hits APP state on a Capacitor build.
  // Subsequent launches read the localStorage flag and skip — wizard is
  // re-launchable from AndroidPermissionsSection's "重新打开授权引导"
  // button (which sets uiSlice.forcePermissionWizardOpen=true). Desktop +
  // PWA never show it because the permission model is different.
  const [showPermissionWizard, setShowPermissionWizard] = useState(false);
  const forcePermissionWizardOpen = useAppStore(s => s.forcePermissionWizardOpen);
  const setForcePermissionWizardOpen = useAppStore(s => s.setForcePermissionWizardOpen);
  useEffect(() => {
    if (flowState !== 'APP') return;
    if (!isCapacitorNative()) return;
    if (isAndroidOnboardingCompleted()) return;
    // Defer one tick so we don't race the AppMainView mount; users are
    // less alarmed by a wizard that appears AFTER they see the chat
    // shell than one that appears INSTEAD of it.
    const t = setTimeout(() => setShowPermissionWizard(true), 800);
    return () => clearTimeout(t);
  }, [flowState]);
  useEffect(() => {
    if (!forcePermissionWizardOpen) return;
    if (flowState !== 'APP') return;
    if (!isCapacitorNative()) return;
    setShowPermissionWizard(true);
  }, [forcePermissionWizardOpen, flowState]);

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

  useBusyRegulator(flowState === 'APP');

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
        void dialogService.alert({
          message: language === 'zh'
            ? '图片处理失败，请检查格式或重新选择。'
            : 'Image processing failed. Please verify the file and try again.',
          icon: 'error',
        });
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
    // F2B.3: removed the PWA `sendChatFromMobile` proxy branch. Both
    // Electron desktop and Capacitor Android run the full chat pipeline
    // in-process via `handleSendAction`.
    handleSendAction(chatRefs);
  }, [inputValue, selectedImage, isThinking, isTalking, executeSend, replyingToMsg, locationConfig, language, messages, t.autoReplyText]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    // v2.14.17 IME guard (replaces v2.14.12 brute-force keyCode 229 / key
    // 'Process' check). Now uses shouldIgnoreEnterDuringImeGrace which
    // blocks during active composition + a brief 80ms post-composition
    // window. The old check ate the real send Enter on some Chinese IMEs
    // that leave keyCode 229 set after the candidate is already committed,
    // forcing users to type a non-Chinese character before Send would fire.
    if (shouldIgnoreEnterDuringImeGrace(e)) return;
    handleSend();
  };
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

  // Stabilize the 3 inline alert-related lambdas via useCallback so they
  // don't allocate new function refs every App render. The original v2.14.8
  // V.2.B useMemo wrapper that consumed these is gone (W.1.C), but stable
  // identities still help any downstream React.memo'd consumers.
  const handleOpenMessageFromAlert = useCallback((messageId: string) => {
    setIsMessageCenterOpen(false);
    handleJumpToMessage(messageId);
    markAllAlertsRead();
  }, [setIsMessageCenterOpen, handleJumpToMessage, markAllAlertsRead]);
  const handleDismissMessageAlert = useCallback((id: string) => {
    setMessageAlerts(prev => prev.filter(alert => alert.id !== id));
  }, [setMessageAlerts]);
  const handleClearMessageAlerts = useCallback(() => {
    setMessageAlerts([]);
  }, [setMessageAlerts]);

  // v2.14.9 W.1.C: removed the v2.14.8 V.2.B `useMemo` wrapper. In current
  // code `handleKeyDown` and `toggleTheme` are recreated every render, so
  // the memo's deps array always changed and the memo recomputed every
  // render anyway — useless overhead + risk of stale handlers if anyone
  // later stabilizes those identities without auditing the (incomplete)
  // deps list. AppMainView is not React.memo'd, so the subtree reconciles
  // on parent re-render regardless. Keeping the 3 useCallbacks for the
  // alert handlers (above) since those are correct on their own merits.
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
    handleOpenMessageFromAlert,
    handleDismissMessageAlert,
    handleClearMessageAlerts,
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
    handleCancelAppUpdate,
    handleInstallAppUpdate,
    updaterCacheInfo,
    refreshUpdaterCacheInfo,
    openUpdaterCacheFolder,
    clearUpdaterCache,
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
    isDisconnected,
  });

  if (!isDataLoaded) {
    return <LoadingDataScreen language={language} />;
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
    {showPermissionWizard && flowState === 'APP' && (
      <PermissionOnboardingWizard
        language={language}
        ringtoneFileId={ttsConfig.ringtoneFileId}
        onClose={() => {
          setShowPermissionWizard(false);
          if (forcePermissionWizardOpen) setForcePermissionWizardOpen(false);
        }}
      />
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
          isDarkMode={isDarkMode}
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
      {/* F2B.1: removed {mobileFilePicker.browserElement} —
          MobileRemoteFileBrowser overlay is gone. */}
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
      <GlobalDialogHost />
      {isAutoZipping && (
        <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 text-white">
            <div className="w-10 h-10 border-4 border-white/30 border-t-white rounded-full animate-spin" />
            <p className="text-sm font-bold">{language === 'zh' ? '正在备份数据，请稍候...' : 'Backing up data, please wait...'}</p>
          </div>
        </div>
      )}
      {appUpdateState.status === 'installing' && (
        <div
          className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/80 backdrop-blur-md px-6"
          role="dialog"
          aria-live="assertive"
          aria-modal="true"
        >
          <div className={`w-full max-w-md rounded-2xl border-2 p-6 flex flex-col items-center gap-4 text-center shadow-[0_0_40px_rgba(34,211,238,0.25)] ${isDarkMode ? 'bg-[#140d09] border-cyan-500/50 text-[#f5ebdc]' : 'bg-white border-cyan-400 text-[#49301f]'}`}>
            <div className="w-12 h-12 border-4 border-cyan-500/30 border-t-cyan-400 rounded-full animate-spin" />
            <h3 className="font-mincho ka-floating-title tracking-[0.04em] text-cyan-400 font-semibold">
              {(t as any).updateInstalling}
            </h3>
            <p className={`ka-copy-sm leading-relaxed ${isDarkMode ? 'text-[#d9c4a8]' : 'text-[#6d5a47]'}`}>
              {(t as any).updateInstallingDesc}
            </p>
            <p className={`ka-copy-xs leading-snug ${isDarkMode ? 'text-[#a68b6b]' : 'text-[#9c7f62]'}`}>
              {(t as any).updateInstallingHint}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
