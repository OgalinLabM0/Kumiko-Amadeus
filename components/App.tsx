
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useAppStore } from '../store';
import { SystemToast } from './SystemToast';
import { AppFlowScreens } from './app/AppFlowScreens';
import { AppMainView } from './app/AppMainView';
import { DiaryBackfillDialog as DiaryBackfillDialogLazy } from './DiaryBackfillDialog';
import { buildAppMainViewProps } from './app/buildAppMainViewProps';
import { getAppShellStyles } from './app/appShellStyles';
import { buildBackupData, validateBackupData } from './app/backupData';
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
import { useDevLogs } from '../hooks/useDevLogs';
import { RAG_HISTORY_DIRTY_STORAGE_KEY } from '../store/slices/ragSlice';
import { RELATIVE_REMINDER_STORAGE_KEY, DAILY_REMINDER_STORAGE_KEY, normalizeReminderEvent, type RelativeReminder, type DailyReminder } from '../store/slices/reminderSlice';
import { LoadingDataScreen } from './app/AppStatusOverlays';
import { Message, AppState, EmotionType, WorldBookEntry, Language, LocationConfig, BackupConfig, AnchorEntry, AIConfig, ChatResponse, SummaryArchiveState, SummaryBoundaryReason, MemoryQuerySession, TemporalQueryPrecision, TemporalQuerySource, TemporalQueryDiagnosticsStatus, TemporalQueryConfidence, SummarySegmentMetadata, TtsConfig, VoiceMode, MissedMessageAlert, MessageAlertKind } from '../types';
import { sendMessageToGemini, startChat, summarizeConversation, searchRagMemory, saveRagMemory, uploadImageToBackend, analyzeTemporalQueryDetailed, getTemporalSearchRoleFromQuery, rewriteHistoricalRecallQueryDetailed, type HistoricalQueryRewrite, type HistoricalSearchStrategy, type TemporalQueryAnalysis, type TemporalQueryDiagnostics } from '../services/geminiService';
import { DEFAULT_WORLD_BOOK, UI_TRANSLATIONS, DEFAULT_LOCATION_CONFIG, LOCALIZED_WORLD_BOOK } from '../constants';
import { VoiceCallOverlay } from './VoiceCallOverlay';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { imageService, compressAndSaveImage, getImageBase64 } from '../services/imageService';
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
  getDesktopBackupFileInfo,
  isDesktopElectron,
  setDesktopBackgroundThrottling,
  refocusDesktopWebContents,
  writeDesktopBackupFile
} from '../services/desktopBackupService';
import {
  LOCAL_BACKUP_PATH_STORAGE_KEY,
  MESSAGE_ALERTS_STORAGE_KEY,
  SUMMARY_ARCHIVE_STATE_STORAGE_KEY,
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
import { getAmbientEnvironmentContext } from './app/ambientContext';
import { yieldToMainThread } from './app/appUtils';
import {
  normalizeBackupData as normalizeBackupDataAction,
  persistNormalizedBackupData as persistNormalizedBackupDataAction,
  restoreBackupData as restoreBackupDataAction,
  handleExportBackup as handleExportBackupAction,
  handleImportBackup as handleImportBackupAction,
} from './app/backupActions';
import {
  triggerAutoSummary as triggerAutoSummaryAction,
  handleRebuildRag as handleRebuildRagAction,
} from './app/summaryActions';
import {
  addMessageToStore,
  showBackgroundNotification,
  executeSend as executeSendAction,
  handleSendAction,
  triggerNativeProactiveMessage as triggerNativeProactiveMessageAction,
  type ChatActionRefs,
  type ExecuteSendHelpers,
} from './app/chatActions';
import { useAppUpdater } from './app/useAppUpdater';
import { useLocalFileBackup } from './app/useLocalFileBackup';
import { useAppPreferencesSync } from './app/useAppPreferencesSync';
import { useScheduledReminders } from './app/useScheduledReminders';
import { useMessageHistoryOperations } from './app/useMessageHistoryOperations';


export const App = () => {
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

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_language', language);
  }, [language, isDataLoaded]);

  const t = UI_TRANSLATIONS[language];

  const locationConfig = useAppStore(s => s.locationConfig);
  const setLocationConfig = useAppStore(s => s.setLocationConfig);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_location_config', locationConfig);
  }, [locationConfig, isDataLoaded]);

  const coreMemory = useAppStore(s => s.coreMemory);
  const setCoreMemory = useAppStore(s => s.setCoreMemory);
  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_core_memory', coreMemory);
  }, [coreMemory, isDataLoaded]);
  
  const kumikoNotebook = useAppStore(s => s.kumikoNotebook);
  const setKumikoNotebook = useAppStore(s => s.setKumikoNotebook);
  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_notebook', kumikoNotebook);
  }, [kumikoNotebook, isDataLoaded]);

  const contextLimit = useAppStore(s => s.contextLimit);
  const setContextLimit = useAppStore(s => s.setContextLimit);
  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_context_limit', contextLimit);
  }, [contextLimit, isDataLoaded]);

  const diaryLayerPreset = useAppStore(s => s.diaryLayerPreset);
  const setDiaryLayerPreset = useAppStore(s => s.setDiaryLayerPreset);
  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_diary_layer_preset', diaryLayerPreset);
  }, [diaryLayerPreset, isDataLoaded]);

  const imageQualityPreset = useAppStore(s => s.imageQualityPreset);
  const setImageQualityPreset = useAppStore(s => s.setImageQualityPreset);
  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_image_quality_preset', imageQualityPreset);
  }, [imageQualityPreset, isDataLoaded]);

  const worldBook = useAppStore(s => s.worldBook);
  const setWorldBook = useAppStore(s => s.setWorldBook);
  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_world_book', worldBook);
  }, [worldBook, isDataLoaded]);

  // This effect ensures the official lore content is always up-to-date with the code
  useEffect(() => {
      const officialLore = LOCALIZED_WORLD_BOOK[language] || DEFAULT_WORLD_BOOK;
      const officialLoreMap = new Map(officialLore.map(e => [e.id, e]));
      
      setWorldBook(prevBook => {
          let hasChanged = false;
          // Get only custom entries from the current state
          const customEntries = prevBook.filter(e => !officialLoreMap.has(e.id));
          
          // Rebuild official entries from code, preserving user settings from prev state
          const newOfficialEntries = officialLore.map(officialEntry => {
              const userSettings = prevBook.find(e => e.id === officialEntry.id);
              if (userSettings) {
                  // If content differs, it means code was updated. Mark change.
                  if (userSettings.content !== officialEntry.content || userSettings.title !== officialEntry.title) {
                      hasChanged = true;
                  }
                  // Preserve user settings, but take content from code
                  return {
                      ...officialEntry, // Fresh content from code
                      isActive: userSettings.isActive, // User setting
                      isHighPriority: userSettings.isHighPriority // User setting
                  };
              }
              return officialEntry; // This is a new entry from code
          });

          // FIX: Explicitly check if we are initializing from an empty state or missing entries
          const prevOfficialCount = prevBook.filter(e => officialLoreMap.has(e.id)).length;
          
          // If counts mismatch (e.g. 0 vs 15), we MUST update
          if (prevOfficialCount !== newOfficialEntries.length) {
              hasChanged = true;
          }

          // If no changes, return the original state to avoid re-render
          if (!hasChanged && customEntries.length === (prevBook.length - prevOfficialCount)) {
              return prevBook;
          }
          
          return [...newOfficialEntries, ...customEntries];
      });
  }, [language, isDataLoaded]);


  const turnCount = useAppStore(s => s.turnCount);
  const setTurnCount = useAppStore(s => s.setTurnCount);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_turn_count', turnCount);
  }, [turnCount, isDataLoaded]);

  const summaryArchiveState = useAppStore(s => s.summaryArchiveState);
  const setSummaryArchiveState = useAppStore(s => s.setSummaryArchiveState);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal(SUMMARY_ARCHIVE_STATE_STORAGE_KEY, summaryArchiveState);
  }, [summaryArchiveState, isDataLoaded]);

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

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal(RELATIVE_REMINDER_STORAGE_KEY, relativeReminders);
  }, [relativeReminders, isDataLoaded]);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal(DAILY_REMINDER_STORAGE_KEY, dailyReminders);
  }, [dailyReminders, isDataLoaded]);
  const messageAlerts = useAppStore(s => s.messageAlerts);
  const setMessageAlerts = useAppStore(s => s.setMessageAlerts);
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
      if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
      db.setVal('kumiko_anchors', anchors);
  }, [anchors, isDataLoaded]);

  useEffect(() => {
      if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
      db.setVal(MESSAGE_ALERTS_STORAGE_KEY, messageAlerts.slice(0, 50));
  }, [messageAlerts, isDataLoaded]);

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
  
  // Sleep protocol refs
  const hasGoneToSleepRef = useRef<boolean>(false);
  const sleepWarningTimestampRef = useRef<number | null>(null);
  const sleepFarewellSentRef = useRef<boolean>(false);
  const lateNightWakeRolledRef = useRef<boolean>(false);
  const lateNightWakeResultRef = useRef<boolean>(false);
  const lateNightWakeTimestampRef = useRef<number | null>(null);

  // hasPerformedInitialPull was used by the removed cloud sync initial-pull flow.

  // --- NEW: SESSION LOCK (ANTI-RACE CONDITION) ---
  const welcomeTriggeredRef = useRef<boolean>(false);

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

  const markAllAlertsRead = useCallback(() => {
    setMessageAlerts(prev => {
      let changed = false;
      const next = prev.map(alert => {
        if (alert.isRead) return alert;
        changed = true;
        return { ...alert, isRead: true };
      });
      return changed ? next : prev;
    });
  }, []);

  const registerBackgroundAlert = useCallback((messageId: string, preview: string, kind: MessageAlertKind) => {
    const trimmedPreview = preview.trim();
    if (!trimmedPreview || (!document.hidden && document.hasFocus())) {
      return;
    }

    setMessageAlerts(prev => {
      const nextAlert: MissedMessageAlert = {
        id: `${kind}-${messageId}`,
        messageId,
        preview: trimmedPreview,
        timestamp: Date.now(),
        kind,
        isRead: false
      };
      return [nextAlert, ...prev.filter(alert => alert.id !== nextAlert.id)].slice(0, 50);
    });
  }, []);

  const showBackgroundMessageNotification = useCallback((body: string, kind: MessageAlertKind = 'reply', messageId?: string) => {
    showBackgroundNotification(body, kind, messageId);
  }, [language, registerBackgroundAlert]);

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

  useEffect(() => {
    if (flowState !== 'APP') return;

    const markVisibleAlertsRead = () => {
      if (!document.hidden && document.hasFocus()) {
        markAllAlertsRead();
      }
    };

    markVisibleAlertsRead();
    window.addEventListener('focus', markVisibleAlertsRead);
    document.addEventListener('visibilitychange', markVisibleAlertsRead);

    return () => {
      window.removeEventListener('focus', markVisibleAlertsRead);
      document.removeEventListener('visibilitychange', markVisibleAlertsRead);
    };
  }, [flowState, markAllAlertsRead]);

  useEffect(() => {
    const baseTitle = 'Kumiko·Amadeus';
    document.title = unreadAlertCount > 0 ? `(${unreadAlertCount}) ${baseTitle}` : baseTitle;

    if (isDesktopElectron()) {
      try {
        const ipc = (window as any).electronAPI;
        ipc?.send('app:update-unread-state', { count: unreadAlertCount });
      } catch (error) {
        console.warn('[UNREAD] Failed to sync unread state to Electron shell:', error);
      }
    }
  }, [unreadAlertCount]);

  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const preValidationActiveRef = useRef(false);

  const backupData = useMemo(() => buildBackupData({
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
    worldCharacterStatus,
    kumikoDiary: autoSavedKumikoDiary,
    dailyFragments: autoSavedDailyFragments,
    psycheState: autoSavedPsycheState,
    defaultWorldBook: DEFAULT_WORLD_BOOK,
    localizedWorldBook: LOCALIZED_WORLD_BOOK,
  }), [
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
    worldCharacterStatus,
    autoSavedKumikoDiary,
    autoSavedDailyFragments,
    autoSavedPsycheState,
  ]);

  const validateSaveData = useCallback((data: typeof backupData): boolean => (
    validateBackupData(data, language, LOCALIZED_WORLD_BOOK, DEFAULT_WORLD_BOOK)
  ), [language]);

  const clearLocalFileConnection = useCallback(() => {
    setConnectedFileName(null);
    fileHandleRef.current = null;

    try {
      localStorage.removeItem(LOCAL_BACKUP_PATH_STORAGE_KEY);
    } catch {
      // Ignore storage cleanup failures.
    }
  }, []);

  useEffect(() => {
    if (!isDataLoaded || !isDesktopElectron()) return;

    let isCancelled = false;

    const restoreDesktopBackupConnection = async () => {
      try {
        const savedPath = localStorage.getItem(LOCAL_BACKUP_PATH_STORAGE_KEY);
        if (!savedPath) return;

        const result = await getDesktopBackupFileInfo(savedPath);
        if (isCancelled) return;

        if (result.success && result.exists && result.filePath) {
          fileHandleRef.current = result.filePath;
          setConnectedFileName(result.fileName || result.filePath.split(/[\\/]/).pop() || result.filePath);
          return;
        }

        clearLocalFileConnection();
      } catch (error) {
        console.warn('[LOCAL BACKUP] Failed to restore desktop backup connection:', error);
        if (!isCancelled) {
          clearLocalFileConnection();
        }
      }
    };

    restoreDesktopBackupConnection();

    return () => {
      isCancelled = true;
    };
  }, [clearLocalFileConnection, isDataLoaded]);

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

  // --- REFINED DATA NORMALIZATION (Business Logic for Restore) ---
  // Implements "Smart Merge" logic:
  // 1. Always fetches fresh official lore from code (Baseline).
  // 2. Merges user settings (Active/Priority) from backup if available.
  // 3. If backup is empty or missing an item, keeps the default official item intact.
  // 4. Preserves custom user entries.
  const normalizeBackupData = useCallback((source: any) => {
    return normalizeBackupDataAction(source);
  }, [language]);

  const saveScheduleEvent = useCallback(async (event: string, daysOffset: number) => {
      try {
          const targetDate = new Date();
          targetDate.setDate(targetDate.getDate() + daysOffset);
          const dateKey = targetDate.toISOString().slice(0, 10);
          const existingEvents = await db.getVal('kumiko_schedule_events', []);
          existingEvents.push({ event, date: dateKey });
          await db.setVal('kumiko_schedule_events', existingEvents);
          console.log(`[SCHEDULE] Saved event: ${event} for ${dateKey}`);
      } catch (e) {
          console.error("[SCHEDULE] Failed to save event", e);
      }
  }, []);

  const checkActiveReminders = useCallback(async (): Promise<string[]> => {
      try {
          const today = new Date().toISOString().slice(0, 10);
          const existingEvents = await db.getVal('kumiko_schedule_events', []);
          const active = existingEvents.filter((e: any) => e.date === today);
          if (active.length > 0) {
              console.log(`[SCHEDULE] Active reminders for today (${today}):`, active);
              return active.map((e: any) => e.event);
          }
          return [];
      } catch (e) {
          console.error("[SCHEDULE] Failed to check events", e);
          return [];
      }
  }, []);

  const addMessage = addMessageToStore;

  const { translateToJapaneseWithEmotion, translateForGenie, runVoicePipeline } = useVoicePipeline({ ttsConfigRef });

  const voiceCallOverlayData = useAppStore(s => s.voiceCallOverlayData);
  const setVoiceCallOverlayData = useAppStore(s => s.setVoiceCallOverlayData);

  const isAutoZipping = useAppStore(s => s.isAutoZipping);
  const setIsAutoZipping = useAppStore(s => s.setIsAutoZipping);

  useEffect(() => {
    if (!isDesktopElectron() || !window.electronAPI?.on) return;
    const handler = (_event: any, payload: any) => {
      if (payload?.status === 'start') setIsAutoZipping(true);
    };
    window.electronAPI.on('app:auto-zip-progress', handler);
    return () => { window.electronAPI?.removeListener?.('app:auto-zip-progress', handler); };
  }, []);

  const performFileSave = async (handle: any, data: any) => {
    try {
      const backupContent = { timestamp: Date.now(), version: "1.3", data };
      const serializedContent = JSON.stringify(backupContent, null, 2);

      if (isDesktopElectron() && typeof handle === 'string') {
        const result = await writeDesktopBackupFile(handle, serializedContent);
        if (!result.success) {
          throw new Error(result.error || 'Failed to write desktop backup file.');
        }
      } else {
        const writable = await handle.createWritable();
        await writable.write(serializedContent);
        await writable.close();
      }

      return true;
    } catch (e) {
      console.warn("Manual save write failed:", e);
      clearLocalFileConnection();
      return false;
    }
  };

  // Cloud sync removed from the product. `performCloudSync`, `handleCloudRestore`,
  // `handleCloudPush`, `handleCloudConnect` used to live here and POST/GET /api/sync.
  // They are intentionally deleted — see P0 #6 notes in the audit plan.

  const persistNormalizedBackupData = useCallback(async (normalizedData: any) => {
    return persistNormalizedBackupDataAction(normalizedData, { rawHistorySyncedIdsRef, forceRawHistoryResyncRef });
  }, []);

  const restoreBackupData = useCallback(async (backup: any) => {
    return restoreBackupDataAction(backup, {
      isBulkRestoreInProgressRef,
      rawHistorySyncedIdsRef,
      forceRawHistoryResyncRef,
      updateMemoryQuerySession,
      setWorldCharacterStatus,
      setAutoSavedKumikoDiary,
      setAutoSavedDailyFragments,
      setAutoSavedPsycheState,
      worldCharacterStatus,
      autoSavedKumikoDiary,
      autoSavedDailyFragments,
      autoSavedPsycheState,
    });
  }, [
    normalizeBackupData,
    persistNormalizedBackupData,
    worldCharacterStatus,
    autoSavedKumikoDiary,
    autoSavedDailyFragments,
    autoSavedPsycheState,
  ]);

  const restoreParsedBackupPayload = useCallback(async (
    backupJson: any,
    importedImages: Array<{ id: string; dataUrl: string }> = []
  ) => {
    if (!backupJson) return null;

    if (importedImages.length > 0) {
      for (let imageIndex = 0; imageIndex < importedImages.length; imageIndex += 1) {
        const image = importedImages[imageIndex];
        await imageService.saveImageWithId(image.id, image.dataUrl);

        if ((imageIndex + 1) % 8 === 0) {
          await yieldToMainThread();
        }
      }
    }

    return restoreBackupData(backupJson);
  }, [restoreBackupData]);


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


  const triggerNativeProactiveMessage = useCallback(async (gapHours: number, eventDescription: string) => {
    return triggerNativeProactiveMessageAction(
      { welcomeTriggeredRef, hasGoneToSleepRef, sleepWarningTimestampRef, sleepFarewellSentRef, lateNightWakeRolledRef, lateNightWakeResultRef, lateNightWakeTimestampRef },
      gapHours, eventDescription,
    );
  }, [messages, coreMemory, worldBook, contextLimit, locationConfig, anchors, kumikoNotebook, isTalking, isThinking, language, backupConfig, addMessage, showBackgroundMessageNotification]);

  useEffect(() => {
      // Cloud sync was removed from the product; proactive checks used to wait for the
      // initial cloud pull to finish first. Now we proceed directly.
      if (flowState !== 'APP') return;

      const checkProactiveLifeEvent = async () => {
          if (isTalking || isThinking) return;

          // --- DAILY DIARY SETTLEMENT ---
          const now = Date.now();
          const jstDate = new Date(new Date(now).toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
          const hourJST = jstDate.getHours();
          const dateStr = `${jstDate.getFullYear()}-${String(jstDate.getMonth() + 1).padStart(2, '0')}-${String(jstDate.getDate()).padStart(2, '0')}`;
          const ambientEnvironmentContext = await getAmbientEnvironmentContext();
          const isHoliday = ambientEnvironmentContext.includes('今日特殊历法：日本法定节假日');
          
          if (hourJST >= 23 || hourJST < 3) {
            const { db } = await import('../services/db');
            const existingDiary = await db.kumikoDiary.where('date').equals(dateStr).first();
            if (!existingDiary) {
              console.log(`[LifeStream] Triggering daily diary settlement for ${dateStr}`);
              const { generateDailyDiary } = await import('../services/lifeStreamService');
              const todayMessages = messages.filter(m => {
                const mDate = new Date(new Date(m.timestamp).toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
                return mDate.getFullYear() === jstDate.getFullYear() && 
                       mDate.getMonth() === jstDate.getMonth() && 
                       mDate.getDate() === jstDate.getDate();
              });
              const diary = await generateDailyDiary(
                dateStr,
                todayMessages.map(message => ({
                  role: message.role,
                  text: message.text,
                  timestamp: message.timestamp,
                })),
                undefined,
                ambientEnvironmentContext,
                isHoliday,
                false
              );
              if (diary) {
                // Clear today's fragments after settlement
                await db.dailyFragments.where('date').equals(dateStr).delete();
                
                // Embed diary into RAG
                const { embedDiaryToRAG } = await import('../services/lifeStreamService');
                await embedDiaryToRAG(diary);
              }
            }
          }
          // ------------------------------

          // --- GRADUAL SLEEP PROTOCOL (heartbeat) ---
          {
            let sleepHour = 12, sleepMin = 0;
            try {
              const tp = new Date().toLocaleTimeString('en-GB', {
                timeZone: locationConfig.modelTimezone,
                hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23'
              }).split(':');
              sleepHour = parseInt(tp[0], 10);
              sleepMin = parseInt(tp[1], 10);
            } catch (_) {}

            const sleepWindowNow = (sleepHour === 0 && sleepMin >= 30) || (sleepHour >= 1 && sleepHour < 6);
            const lastMsgTime = messages.length > 0 ? messages[messages.length - 1].timestamp : 0;
            const recentlyActive = lastMsgTime > 0 && (Date.now() - lastMsgTime) < 15 * 60000;

            // 6:00 daily reset
            if (sleepHour >= 6) {
              if (hasGoneToSleepRef.current) {
                console.log("[SLEEP-HB] 6:00 reset");
                setCurrentEmotion('neutral');
              }
              hasGoneToSleepRef.current = false;
              sleepWarningTimestampRef.current = null;
              sleepFarewellSentRef.current = false;
              lateNightWakeRolledRef.current = false;
              lateNightWakeResultRef.current = false;
              lateNightWakeTimestampRef.current = null;
            }

            // Scene A Phase 2: 0:30+ first warning
            if (sleepWindowNow && !hasGoneToSleepRef.current && !sleepWarningTimestampRef.current && recentlyActive && !isTalking && !isThinking) {
              console.log("[SLEEP-HB] Phase 2: Sending first warning");
              sleepWarningTimestampRef.current = Date.now();
              triggerNativeProactiveMessage(0, language === 'zh'
                ? '[系统指令]你现在已经非常困了，必须告诉用户你真的要睡了，不能再聊了。语气自然但坚定，明确表达「我真的要去睡了」。'
                : "[System] You are very sleepy now. Tell the user firmly but naturally that you really need to sleep and can't chat anymore.");
            }

            // Scene A Phase 3: warning + 10min → final goodnight
            if (sleepWarningTimestampRef.current && !sleepFarewellSentRef.current && !isTalking && !isThinking) {
              const sinceWarning = Date.now() - sleepWarningTimestampRef.current;
              const userRepliedAfterWarning = messages.length > 0 &&
                messages[messages.length - 1].role === 'user' &&
                messages[messages.length - 1].timestamp > sleepWarningTimestampRef.current;

              if (sinceWarning >= 10 * 60000 && userRepliedAfterWarning) {
                console.log("[SLEEP-HB] Phase 3: Sending final goodnight");
                sleepFarewellSentRef.current = true;
                triggerNativeProactiveMessage(0, language === 'zh'
                  ? '[系统指令]这是你今晚最后一条消息。自然地承接上文说晚安，明确告诉用户「再发也不会回了哦，晚安」。说完之后你将进入睡眠，不再回复任何消息。'
                  : "[System] This is your final message tonight. Say goodnight naturally, make it clear you won't reply anymore. After this, you will be fully asleep.");
                setTimeout(() => {
                  hasGoneToSleepRef.current = true;
                  setCurrentEmotion('sleepy');
                  console.log("[SLEEP-HB] Entered full sleep after farewell");
                }, 5000);
              }
            }

            // Scene B continuation: late-night wake warning after 10 min
            if (lateNightWakeTimestampRef.current && !sleepWarningTimestampRef.current && !isTalking && !isThinking) {
              const sinceWake = Date.now() - lateNightWakeTimestampRef.current;
              if (sinceWake >= 10 * 60000) {
                console.log("[SLEEP-HB] Late-night wake: 10 min elapsed, starting warning flow");
                sleepWarningTimestampRef.current = Date.now();
                triggerNativeProactiveMessage(0, language === 'zh'
                  ? '[系统指令]你深夜被吵醒已经聊了一会了，现在真的撑不住了，必须告诉用户你要睡了。语气自然但坚定。'
                  : "[System] You were woken up late at night and chatted for a bit. Now you really can't stay awake. Tell the user you need to sleep.");
              }
            }

            // Auto-sleep on long inactivity in sleep window (backup for handleSend)
            if (!hasGoneToSleepRef.current && sleepWindowNow && !recentlyActive && lastMsgTime > 0) {
              const inactiveMin = (Date.now() - lastMsgTime) / 60000;
              if (inactiveMin > 30) {
                console.log("[SLEEP-HB] Auto-sleep: 30+ min inactivity during sleep window");
                hasGoneToSleepRef.current = true;
                setCurrentEmotion('sleepy');
              }
            }
          }
          // --- END GRADUAL SLEEP PROTOCOL ---

          if (localStorage.getItem('enable_proactive_messaging') === 'false') {
              console.log("[Heartbeat] Proactive messaging disabled by user.");
              return;
          }

          const lastMsg = messages[messages.length - 1];
          if (!lastMsg) return;

          const currentTime = Date.now();
          const gapHours = (currentTime - lastMsg.timestamp) / (1000 * 60 * 60);
          
          // COOL DOWN: Require at least 3 hours of silence before proactively messaging
          if (gapHours < 3) return;

          // --- STATE MACHINE DRIVEN PROACTIVE ---
          const { getCurrentKumikoState } = await import('../services/kumikoStateMachine');
          const stateCtx = getCurrentKumikoState(locationConfig.modelTimezone, isHoliday);
          
          let triggerChance = stateCtx.proactiveProbability;
          let eventDescription = stateCtx.stateDescription;

          const recent7DayMessageCount = messages.filter(msg => currentTime - msg.timestamp <= 7 * 24 * 60 * 60 * 1000).length;
          const relationshipWarmthFactor = recent7DayMessageCount >= 120 ? 1.22 : recent7DayMessageCount >= 50 ? 1.12 : recent7DayMessageCount <= 12 ? 0.88 : 1;
          
          triggerChance = Math.min(0.35, triggerChance * relationshipWarmthFactor);

          if (Math.random() <= triggerChance) {
              console.log(`[Heartbeat] Triggering Proactive. State: ${stateCtx.currentState}, Chance: ${triggerChance}`);
              triggerNativeProactiveMessage(gapHours, eventDescription);
          } else {
              console.log(`[Heartbeat] Skipped by RNG. State: ${stateCtx.currentState}, Chance: ${triggerChance}`);
          }
      };

      // Poll every 10 minutes
      const intervalId = setInterval(checkProactiveLifeEvent, 600000);
      
      // Also check shortly after initial load
      const timeoutId = setTimeout(checkProactiveLifeEvent, 15000);

      return () => {
          clearInterval(intervalId);
          clearTimeout(timeoutId);
      };
  }, [messages, flowState, locationConfig, isTalking, isThinking, triggerNativeProactiveMessage]);

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
  }), []);
  (chatRefs as any).__executeSendHelpers = executeSendHelpers;

  const executeSend = useCallback(async () => {
    return executeSendAction(chatRefs, executeSendHelpers);
  }, [coreMemory, worldBook, contextLimit, triggerAutoSummary, locationConfig, backupConfig, anchors, kumikoNotebook, turnCount, language, showBackgroundMessageNotification, summaryArchiveState]);

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
