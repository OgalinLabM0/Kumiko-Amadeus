
import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
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
  resolveCoreMemoryFromSummaryArchive,
  evaluateSummaryBoundary,
  getArchivedSummaryProgressText,
  getSummaryContinuationCarryoverState,
  getSummaryContinuationPayload,
  getSummarySegmentMessages,
  getSummarySemanticWindowPayload,
  getTurnsInActiveSummarySegment,
  normalizeSummaryArchiveState,
  SUMMARY_SOFT_THRESHOLD,
  SummarySemanticSignal,
} from './app/summaryCycle';
import { ExtendedSyncStatus } from './SyncStatus'; 
import { useAutoSave } from '../hooks/useAutoSave'; 
import { useDevLogs } from '../hooks/useDevLogs';
import { DEFAULT_APP_UPDATE_STATE } from '../store/slices/updaterSlice';
import { RAG_HISTORY_DIRTY_STORAGE_KEY } from '../store/slices/ragSlice';
import { RELATIVE_REMINDER_STORAGE_KEY, DAILY_REMINDER_STORAGE_KEY, normalizeReminderEvent, type RelativeReminder, type DailyReminder } from '../store/slices/reminderSlice';
import { LoadingDataScreen } from './app/AppStatusOverlays';
import { Message, AppState, AppUpdateState, EmotionType, WorldBookEntry, Language, LocationConfig, BackupConfig, AnchorEntry, AIConfig, ChatResponse, SummaryArchiveState, SummaryBoundaryReason, MemoryQuerySession, TemporalQueryPrecision, TemporalQuerySource, TemporalQueryDiagnosticsStatus, TemporalQueryConfidence, SummarySegmentMetadata, TtsConfig, VoiceMode, MissedMessageAlert, MessageAlertKind } from '../types';
import { sendMessageToGemini, startChat, summarizeConversation, searchRagMemory, saveRagMemory, uploadImageToBackend, getCurrentAIConfig, validateAIConnection, analyzeTemporalQueryDetailed, getTemporalSearchRoleFromQuery, rewriteHistoricalRecallQueryDetailed, callLLMRaw, type HistoricalQueryRewrite, type HistoricalSearchStrategy, type TemporalQueryAnalysis, type TemporalQueryDiagnostics } from '../services/geminiService';
import { DEFAULT_WORLD_BOOK, UI_TRANSLATIONS, DEFAULT_LOCATION_CONFIG, LOCALIZED_WORLD_BOOK, EMOTION_TO_FISH_AUDIO_TAGS, EMOTION_TTS_TEMPERATURE, DEFAULT_TTS_CONFIG } from '../constants';
import { synthesizeSpeech, TtsError } from '../services/fishAudioService';
import { saveVoiceFile, isVoiceServiceAvailable, isBuiltInRingtoneId, isCustomRingtoneId } from '../services/voiceFileService';
import { VoiceCallOverlay } from './VoiceCallOverlay';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { imageService, compressAndSaveImage, getImageBase64 } from '../services/imageService';
import { generateEmbedding, getAllVectors, loadRawHistoryMessagesFromMain, saveLocalRagMemory, restoreVectors, searchLocalRagMemory, searchLocalRagMemoryDetailed, startLocalRagRebuild, subscribeLocalRagRebuild, syncRawHistoryMessagesToMain, type LocalRagEntryKind, type LocalRagEvidenceStrength, type LocalRagRebuildEvent } from '../services/localRagService';
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
import { DEFAULT_BACKUP_CONFIG, normalizeBackupConfig } from '../services/appConfig';
import { loadTemporalEpisodesForRange, syncTemporalEpisodes } from '../services/temporalEpisodeService';
import {
  parseDesktopBackupImportFile,
  getDesktopBackupFileInfo,
  isDesktopElectron,
  pickDesktopBackupOpenFile,
  pickDesktopBackupSaveFile,
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
  loadRawHistoryMessages,
  syncRawHistoryMessages,
  buildHistoryEvidenceMessages,
} from './app/rawHistorySync';
import {
  recalculateTurnCountFromMessages,
  parseRelativeReminderRequest,
  parseDailyReminderRequest,
  getTimePartsInTimezone,
  sanitizeRelativeReminderRecord,
  sanitizeDailyReminderRecord,
  sanitizeWorldCharacterStatusRecord,
  sanitizeKumikoDiaryRecord,
  sanitizeDailyFragmentRecord,
  sanitizePsycheStateRecord,
  sanitizeEpisodeRecord,
  sanitizeMessageAlertRecord,
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
  triggerTimedReminderMessage as triggerTimedReminderMessageAction,
  type ChatActionRefs,
  type ExecuteSendHelpers,
} from './app/chatActions';


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

  // --- iOS PWA BODY LOCK CLEANUP ---
  useEffect(() => {
      // Body is now permanently fixed in index.html, no need to clear locks
      
      // Fix for iOS Safari PWA keyboard pushing app up and not restoring
      const handleFocusOut = () => {
        setTimeout(() => {
          if (!document.activeElement || (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA')) {
            window.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
          }
        }, 100);
      };

      window.addEventListener('focusout', handleFocusOut);
      
      return () => {
        window.removeEventListener('focusout', handleFocusOut);
      };
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
  
  const replyingToMsg = useAppStore(s => s.replyingToMsg);
  const setReplyingToMsg = useAppStore(s => s.setReplyingToMsg);
  const highlightedMessageId = useAppStore(s => s.highlightedMessageId);
  const setHighlightedMessageId = useAppStore(s => s.setHighlightedMessageId);
  const systemNotice = useAppStore(s => s.systemNotice);
  const setSystemNotice = useAppStore(s => s.setSystemNotice);

  // --- NEW: iOS DETECTION FOR PERFORMANCE OPTIMIZATION ---
  const isIOS = useMemo(() => {
      // Standard check for iOS devices
      return /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
  }, []);
  
  useLayoutEffect(() => {
    const applyViewportFix = () => {
      const vv = window.visualViewport;
      const isStandalone =
        (window.navigator as any).standalone === true ||
        window.matchMedia('(display-mode: standalone)').matches;

      let h = window.innerHeight || 0;

      if (vv) {
        h = Math.max(h, Math.round(vv.height + vv.offsetTop));
      }

      if (isStandalone) {
        h = Math.max(h, document.documentElement.clientHeight || 0);
      }

      const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
      const topOffset = (isStandalone && isIOSDevice) ? 'env(safe-area-inset-top)' : '0';

      let hpx = (isStandalone && isIOSDevice) ? `calc(${h}px - env(safe-area-inset-top))` : `${h}px`;
      if (isStandalone && typeof CSS !== 'undefined' && CSS.supports('height: 100dvh')) {
        hpx = isIOSDevice ? 'calc(100dvh - env(safe-area-inset-top))' : '100dvh';
      }
      const bg = flowState === 'APP'
        ? (isDarkMode ? '#121212' : '#ffffff')
        : '#f9f7f2';

      if (isDesktopElectron()) {
        document.documentElement.style.setProperty('--app-height', '100vh');
        document.documentElement.style.overflow = 'hidden';
        document.documentElement.style.backgroundColor = bg;

        Object.assign(document.body.style, {
          margin: '0',
          padding: '0',
          height: '100vh',
          overflow: 'hidden',
          backgroundColor: bg,
        });

        const root = document.getElementById('root');
        if (root) root.style.backgroundColor = bg;

        if (window.electronAPI?.setBgColor) {
          window.electronAPI.setBgColor(bg);
        }
        return;
      }

      hpx = hpx || `${h}px`;

      document.documentElement.style.setProperty('--app-height', hpx);

      Object.assign(document.documentElement.style, {
        height: hpx,
        minHeight: hpx,
        overflow: 'hidden',
        backgroundColor: bg,
      });

      Object.assign(document.body.style, {
        position: 'fixed',
        top: topOffset,
        left: '0',
        right: '0',
        bottom: '0',
        width: '100%',
        height: hpx,
        minHeight: hpx,
        margin: '0',
        padding: '0',
        overflow: 'hidden',
        backgroundColor: bg,
        transform: 'translateZ(0)',
      });

      const root = document.getElementById('root');
      if (root) {
        Object.assign(root.style, {
          position: 'absolute',
          top: '0',
          left: '0',
          right: '0',
          bottom: '0',
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          backgroundColor: bg,
        });
      }

      if (appShellRef.current) {
        Object.assign(appShellRef.current.style, {
          position: 'absolute',
          top: '0',
          left: '0',
          right: '0',
          bottom: '0',
          width: '100%',
          height: '100%',
          minHeight: '0',
          maxHeight: 'none',
          overflow: 'hidden',
          backgroundColor: bg,
        });
      }

    };

    const onResize = () => requestAnimationFrame(applyViewportFix);
    const onVisible = () => {
      if (!document.hidden) {
        setTimeout(applyViewportFix, 50);
        setTimeout(applyViewportFix, 250);
        setTimeout(applyViewportFix, 600);
      }
    };

    applyViewportFix();

    if (!isDesktopElectron()) {
      window.addEventListener('resize', onResize, { passive: true });
      window.addEventListener('orientationchange', onResize, { passive: true });
      window.addEventListener('pageshow', onResize, { passive: true });

      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', onResize, { passive: true });
        window.visualViewport.addEventListener('scroll', onResize, { passive: true });
      }

      document.addEventListener('visibilitychange', onVisible);
    }

    setTimeout(applyViewportFix, 0);
    setTimeout(applyViewportFix, 100);
    setTimeout(applyViewportFix, 400);

    return () => {
      if (!isDesktopElectron()) {
        window.removeEventListener('resize', onResize);
        window.removeEventListener('orientationchange', onResize);
        window.removeEventListener('pageshow', onResize);

        if (window.visualViewport) {
          window.visualViewport.removeEventListener('resize', onResize);
          window.visualViewport.removeEventListener('scroll', onResize);
        }

        document.removeEventListener('visibilitychange', onVisible);
      }
    };
  }, [isDarkMode, flowState]);

  // --- iOS WAKE LOCK OPTIMIZATION ---
  useEffect(() => {
    let wakeLock: any = null;

    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator && flowState === 'APP') {
          // @ts-ignore
          wakeLock = await navigator.wakeLock.request('screen');
          console.log("[iOS Optimization] Screen Wake Lock acquired.");
        }
      } catch (err) {
        console.warn("[iOS Optimization] Wake Lock failed:", err);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Re-acquire lock when coming back to app
        requestWakeLock();
      }
    };

    // Request initially if in APP mode
    if (flowState === 'APP') {
      requestWakeLock();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (wakeLock) wakeLock.release();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [flowState]);

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

  const lastAppUpdateStatusRef = useRef<AppUpdateState['status']>(DEFAULT_APP_UPDATE_STATE.status);

  useEffect(() => {
    if (!isDesktopElectron() || !window.electronAPI) {
      setAppUpdateState((prev) => ({ ...prev, status: 'unsupported', isPackaged: false }));
      return;
    }

    let cancelled = false;

    const handleUpdateStatus = (_event: any, payload: AppUpdateState) => {
      if (!payload) return;
      setAppUpdateState((prev) => ({ ...prev, ...payload }));
    };

    window.electronAPI.on('app:update-status', handleUpdateStatus);
    window.electronAPI.invoke('app:update:get-state')
      .then((result: any) => {
        if (cancelled || !result?.success || !result.state) return;
        setAppUpdateState((prev) => ({ ...prev, ...result.state }));
      })
      .catch((error) => {
        console.error('[UPDATER] Failed to read initial updater state:', error);
      });

    return () => {
      cancelled = true;
      window.electronAPI?.removeListener?.('app:update-status', handleUpdateStatus);
    };
  }, []);

  useEffect(() => {
    const previousStatus = lastAppUpdateStatusRef.current;

    if (appUpdateState.status === 'available' && previousStatus !== 'available' && appUpdateState.availableVersion) {
      const nextText = UI_TRANSLATIONS[language].updateToastAvailable.replace('{0}', `v${appUpdateState.availableVersion}`);
      setSystemNotice(nextText);
    }

    if (appUpdateState.status === 'downloaded' && previousStatus !== 'downloaded') {
      setSystemNotice(UI_TRANSLATIONS[language].updateToastReady);
      setShowAppUpdateModal(true);
    }

    lastAppUpdateStatusRef.current = appUpdateState.status;
  }, [appUpdateState.status, appUpdateState.availableVersion, language]);

  const currentEmotion = useAppStore(s => s.currentEmotion);
  const setCurrentEmotion = useAppStore(s => s.setCurrentEmotion);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_current_emotion', currentEmotion);
  }, [currentEmotion, isDataLoaded]);

  const backupConfig = useAppStore(s => s.backupConfig);
  const setBackupConfig = useAppStore(s => s.setBackupConfig);
  const autoZipEnabled = useAppStore(s => s.autoZipEnabled);
  const setAutoZipEnabled = useAppStore(s => s.setAutoZipEnabled);

  useEffect(() => {
    if (isDesktopElectron()) {
      window.electronAPI.invoke('app:get-auto-zip-backup').then((result: any) => {
        setAutoZipEnabled(result?.enabled === true);
      });
    }
  }, []);

  const handleToggleAutoZip = () => {
    const newValue = !autoZipEnabled;
    setAutoZipEnabled(newValue);
    if (isDesktopElectron()) {
      window.electronAPI.invoke('app:set-auto-zip-backup', { enabled: newValue });
    }
  };

  const handleBackupConfigChange = useCallback((nextConfig: BackupConfig) => {
    setBackupConfig(normalizeBackupConfig(nextConfig));
  }, []);

  const sanitizeTtsConfig = useCallback((value: unknown): TtsConfig => {
    const merged = {
      ...DEFAULT_TTS_CONFIG,
      ...(value && typeof value === 'object' ? value as Partial<TtsConfig> : {})
    };

    if (!isBuiltInRingtoneId(merged.ringtoneFileId) && !isCustomRingtoneId(merged.ringtoneFileId)) {
      merged.ringtoneFileId = DEFAULT_TTS_CONFIG.ringtoneFileId;
    }

    return merged as TtsConfig;
  }, []);

  const ttsConfig = useAppStore(s => s.ttsConfig);
  const setTtsConfig = useAppStore(s => s.setTtsConfig);
  const ttsConfigRef = useRef(ttsConfig);
  useEffect(() => { ttsConfigRef.current = ttsConfig; }, [ttsConfig]);
  const handleTtsConfigChange = useCallback((next: TtsConfig) => {
    const sanitized = sanitizeTtsConfig(next);
    setTtsConfig(sanitized);
    localStorage.setItem('kumiko_tts_config', JSON.stringify(sanitized));
  }, [sanitizeTtsConfig]);

  const ragStatus = useAppStore(s => s.ragStatus);
  const setRagStatus = useAppStore(s => s.setRagStatus);
  const ragProgressLabel = useAppStore(s => s.ragProgressLabel);
  const setRagProgressLabel = useAppStore(s => s.setRagProgressLabel);
  const isRagHistoryDirty = useAppStore(s => s.isRagHistoryDirty);
  const setIsRagHistoryDirty = useAppStore(s => s.setIsRagHistoryDirty);
  const ragDirtyNoticeShown = useAppStore(s => s.ragDirtyNoticeShown);
  const setRagDirtyNoticeShown = useAppStore(s => s.setRagDirtyNoticeShown);

  useEffect(() => {
    if (ragStatus !== 'RECALLING' && ragStatus !== 'INDEXING') {
      setRagProgressLabel(null);
    }
  }, [ragStatus]);

  useEffect(() => {
    const ragEnabled = backupConfig.ragEnabled ?? false;
    if (ragEnabled) {
      setRagStatus(prev => prev === 'OFF' ? 'IDLE' : prev);
    } else {
      setRagStatus('OFF');
    }
  }, [backupConfig.ragEnabled]);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal(RAG_HISTORY_DIRTY_STORAGE_KEY, isRagHistoryDirty);
  }, [isRagHistoryDirty, isDataLoaded]);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_backup_config', backupConfig);
  }, [backupConfig, isDataLoaded]);

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

  useEffect(() => {
    setStatusText(t.signalConnected);
  }, [language]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef(messages);
  const appShellRef = useRef<HTMLDivElement>(null);

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
  const reminderDispatchingRef = useRef<boolean>(false);

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

  useEffect(() => {
    const loadData = async () => {
      try {
        const loadedMessages = await loadRawHistoryMessages();
        const loadedTurnCount = recalculateTurnCountFromMessages(loadedMessages);
        const loadedSummaryArchiveState = normalizeSummaryArchiveState(
          await db.getVal(SUMMARY_ARCHIVE_STATE_STORAGE_KEY, null),
          loadedTurnCount
        );
        const loadedCoreMemory = resolveCoreMemoryFromSummaryArchive(
          loadedSummaryArchiveState,
          await db.getVal('kumiko_core_memory', '')
        );
        const loadedMemoryQuerySession = normalizeMemoryQuerySession(
          await db.getVal(MEMORY_QUERY_SESSION_STORAGE_KEY, null)
        );

        setMessages(loadedMessages);
        if (loadedMessages.some(m => m.sendStatus === 'failed')) {
          setIsDisconnected(true);
        }
        rawHistorySyncedIdsRef.current = new Set(loadedMessages.map(message => message.id));
        forceRawHistoryResyncRef.current = false;
        updateMemoryQuerySession(loadedMemoryQuerySession);
        setLanguage(await db.getVal('kumiko_language', 'zh'));
        setLocationConfig(await db.getVal('kumiko_location_config', DEFAULT_LOCATION_CONFIG));
        setCoreMemory(loadedCoreMemory);
        setKumikoNotebook(await db.getVal('kumiko_notebook', ''));
        setContextLimit(await db.getVal('kumiko_context_limit', 100));
        {
          const storedPreset = await db.getVal('kumiko_diary_layer_preset', 'balanced');
          // Defensive: legacy installs / corrupted rows may hold an unknown string.
          // Fall back to the default rather than letting it poison the store.
          const resolvedPreset: 'economy' | 'balanced' | 'rich' =
            storedPreset === 'economy' || storedPreset === 'rich' ? storedPreset : 'balanced';
          setDiaryLayerPreset(resolvedPreset);
        }
        {
          const storedImageQuality = await db.getVal('kumiko_image_quality_preset', 'high');
          const resolvedImagePreset: 'original' | 'high' | 'standard' | 'compact' =
            storedImageQuality === 'original' || storedImageQuality === 'standard' || storedImageQuality === 'compact'
              ? storedImageQuality
              : 'high';
          setImageQualityPreset(resolvedImagePreset);
        }
        
        const savedWorldBook = await db.getVal('kumiko_world_book', null);
        if (savedWorldBook) {
            setWorldBook(savedWorldBook);
        } else {
            setWorldBook(LOCALIZED_WORLD_BOOK['zh']);
        }

        setTurnCount(loadedTurnCount);
        setSummaryArchiveState(loadedSummaryArchiveState);
        setAnchors(await db.getVal('kumiko_anchors', []));
        setCurrentEmotion(await db.getVal('kumiko_current_emotion', 'neutral'));
        setRelativeReminders((await db.getVal(RELATIVE_REMINDER_STORAGE_KEY, [])).map(sanitizeRelativeReminderRecord).filter(Boolean) as RelativeReminder[]);
        setDailyReminders((await db.getVal(DAILY_REMINDER_STORAGE_KEY, [])).map(sanitizeDailyReminderRecord).filter(Boolean) as DailyReminder[]);
        setMessageAlerts((await db.getVal(MESSAGE_ALERTS_STORAGE_KEY, [])).map(sanitizeMessageAlertRecord).filter(Boolean).slice(0, 50) as MissedMessageAlert[]);
        setWorldCharacterStatus(sanitizeWorldCharacterStatusRecord(await db.getVal('world_character_status', INITIAL_WORLD_CHARACTER_STATUS)));
        setAutoSavedKumikoDiary((await db.kumikoDiary.orderBy('date').toArray()).map(sanitizeKumikoDiaryRecord).filter(Boolean) as KumikoDiaryEntity[]);
        setAutoSavedDailyFragments((await db.dailyFragments.orderBy('timestamp').toArray()).map(sanitizeDailyFragmentRecord).filter(Boolean) as DailyFragmentEntity[]);
        setAutoSavedPsycheState(sanitizePsycheStateRecord(await db.psycheState.get('current')));
        
        const backupCfg = normalizeBackupConfig(await db.getVal('kumiko_backup_config', DEFAULT_BACKUP_CONFIG));
        setBackupConfig(backupCfg);
        setIsRagHistoryDirty(await db.getVal(RAG_HISTORY_DIRTY_STORAGE_KEY, false));

        ragBufferRef.current = await db.getVal('kumiko_rag_buffer', []);

        setIsDataLoaded(true);
      } catch (e) {
        console.error("Failed to load data from IndexedDB", e);
        // CRITICAL: record the error so useAutoSave can block writes and UI can warn.
        // Previously we unconditionally flipped isDataLoaded to true, which let the empty
        // default state be auto-saved back over the user's real backup in 3s — destroying data.
        const message = e instanceof Error ? e.message : String(e);
        setDataLoadError(message);
        // Surface a warning. We cannot rely on `language` being loaded here (it's part of
        // the failing load). Default to zh (app primary language); only use en if browser
        // explicitly reports English.
        const isEn = typeof navigator !== 'undefined' && /^en/i.test(navigator.language || '');
        setSystemNotice(isEn
          ? 'Data load failed; auto-save has been paused to protect your backup. Please restart the app or restore from a backup.'
          : '数据加载失败，已暂停自动保存以保护您的备份。请重启应用或从备份恢复。');
        setIsDataLoaded(true);
      }
    };
    loadData();
  }, [updateMemoryQuerySession]);

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
  useEffect(() => {
      const updateStatus = async () => {
          if (flowState !== 'APP') return;
          try {
              if (!locationConfig || !locationConfig.modelTimezone) {
                  throw new Error("Invalid Location Config");
              }

              const isZh = language === 'zh';
              const { getDetailedScheduleSlot: getSlotForStatus } = await import('../services/kumikoStateMachine');
              const slot = getSlotForStatus(locationConfig.modelTimezone, false);

              const prefix = isZh ? '状态：' : 'STATUS: ';
              const activityMap: Record<string, [string, string]> = {
                '批改1年级作文': ['批改1年级作文', 'Grading Year 1 essays'],
                '备课/打印下午讲义': ['备课/打印讲义', 'Lesson prep / printing'],
                '教材制作/打印プリント': ['教材制作/打印', 'Making handouts'],
                '学生面谈（进路相谈）': ['学生面谈', 'Student counseling'],
                '学年会议': ['学年会议', 'Faculty meeting'],
                '批改3年级小論文': ['批改3年级小论文', 'Grading Year 3 essays'],
                '校务（成绩输入/出欠确认）': ['校务处理', 'Admin duties'],
                '备课/教研准备': ['备课/教研准备', 'Lesson prep'],
                '教研（同僚と授業検討）': ['教研讨论', 'Teaching seminar'],
                '批改小論文反馈': ['批改小论文', 'Grading essays'],
                '3年级进路指导面谈': ['进路指导面谈', 'Career counseling'],
                '部活准备/资料整理': ['部活准备/资料整理', 'Club prep / filing'],
                '批改作业、学生面谈': ['批改作业/学生面谈', 'Grading / student meetings'],
                '批改/备课、会议延长': ['批改/备课', 'Grading / prep'],
                '吹奏乐部副顾问事务': ['吹奏部副顾问事务', 'Band club duties'],
                '批改/家长联络': ['批改/家长联络', 'Grading / parent contact'],
                '吹奏乐部指导（~18:30）': ['吹奏部指导', 'Band club (~18:30)'],
                '出勤准备（打印讲义、检查缺席联络）': ['出勤准备', 'Attendance prep'],
                '朝会时间（非班主任日，在办公室准备）': ['办公室准备', 'Office prep'],
                '办公室事务': ['办公室事务', 'Office work'],
              };
              const subjectMap: Record<string, [string, string]> = {
                '国語総合': ['国语综合', 'Japanese (General)'],
                '現代文B': ['现代文B', 'Modern Literature B'],
                '古典B': ['古典B', 'Classics B'],
                '小論文指導': ['小论文指导', 'Essay Writing'],
              };
              const classMap: Record<string, [string, string]> = {
                '1年A組': ['1年A组', '1-A'],
                '1年B組': ['1年B组', '1-B'],
                '1年C組': ['1年C组', '1-C'],
                '2年A組': ['2年A组', '2-A'],
                '2年B組': ['2年B组', '2-B'],
                '2年D組': ['2年D组', '2-D'],
                '3年C組': ['3年C组', '3-C'],
                '3年E組': ['3年E组', '3-E'],
                '3年F組': ['3年F组', '3-F'],
              };
              const localizeActivity = (raw: string) => {
                const m = activityMap[raw];
                return m ? (isZh ? m[0] : m[1]) : raw;
              };
              const localizeSubject = (raw: string) => {
                const m = subjectMap[raw];
                return m ? (isZh ? m[0] : m[1]) : raw;
              };
              const localizeClass = (raw: string) => {
                const m = classMap[raw];
                return m ? (isZh ? m[0] : m[1]) : raw;
              };
              let text = '';
              switch (slot.slotType) {
                  case 'drowsy':
                      text = prefix + (isZh ? '犯困中...' : 'DROWSY...');
                      break;
                  case 'sleeping':
                      text = prefix + (isZh ? '睡眠模式 (勿扰)' : 'SLEEP MODE (DND)');
                      break;
                  case 'commuting':
                      text = prefix + (isZh ? '通勤中' : 'COMMUTING');
                      break;
                  case 'shr':
                      text = prefix + (isZh ? 'SHR朝会' : 'SHR HOMEROOM');
                      break;
                  case 'teaching': {
                      const cls = slot.classGroup ? localizeClass(slot.classGroup) : '';
                      const sub = slot.subject ? localizeSubject(slot.subject) : '';
                      const detail = cls ? ` — ${cls} ${sub}` : '';
                      text = isZh
                          ? `${prefix}${slot.periodNumber ? `第${slot.periodNumber}校时` : '上课中'}${detail}`
                          : `${prefix}${slot.periodNumber ? `P${slot.periodNumber} IN CLASS` : 'IN CLASS'}${detail}`;
                      break;
                  }
                  case 'free': {
                      const act = slot.freeActivity ? localizeActivity(slot.freeActivity) : '';
                      text = isZh
                          ? `${prefix}空档${act ? ` — ${act}` : '（办公室）'}`
                          : `${prefix}FREE${act ? ` — ${act}` : ' (OFFICE)'}`;
                      break;
                  }
                  case 'lunch':
                      text = prefix + (isZh ? '午休中' : 'LUNCH BREAK');
                      break;
                  case 'cleaning':
                      text = prefix + (isZh ? '归宅SHR/清扫' : 'CLEANUP');
                      break;
                  case 'after_school': {
                      const aa = slot.freeActivity ? localizeActivity(slot.freeActivity) : '';
                      text = isZh
                          ? `${prefix}放课后${aa ? ` — ${aa}` : ''}`
                          : `${prefix}AFTER SCHOOL${aa ? ` — ${aa}` : ''}`;
                      break;
                  }
                  case 'school_prep': {
                      const prepLabels: Record<string, [string, string]> = {
                          staff_prep: ['新学年教职员准备', 'Staff Prep'],
                          shigyoushiki: ['始业式（开学典礼）', 'Opening Ceremony'],
                          transition: ['学年过渡日', 'Transition Day'],
                          nyuugakushiki: ['入学式', 'Entrance Ceremony'],
                          class_prep: ['授业准备（座席调整）', 'Class Preparation'],
                          term_ceremony: ['学期始业式', 'Term Ceremony'],
                      };
                      const label = prepLabels[slot.prepPhaseKey || ''];
                      const desc = label ? (isZh ? label[0] : label[1]) : (isZh ? '学校准备日' : 'School Prep');
                      text = `${prefix}${desc}`;
                      break;
                  }
                  default:
                      text = prefix + (isZh ? '在线' : 'ONLINE');
              }
              setStatusText(text);
          } catch(e) {
              console.error("Status Update Failed", e);
              setStatusText(t.signalConnected);
          }
      };
      
      updateStatus();
      const timer = setInterval(updateStatus, 60000);
      return () => clearInterval(timer);
  }, [flowState, locationConfig, language, t.signalConnected]);

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

  const translateToJapaneseWithEmotion = async (chineseText: string, emotion: EmotionType): Promise<string | null> => {
    try {
      const config = getCurrentAIConfig();
      const emotionTags = EMOTION_TO_FISH_AUDIO_TAGS[emotion] ?? [];
      const tagList = emotionTags.length > 0 ? emotionTags.join(', ') : 'none';

      const systemPrompt = [
        'You are a Chinese-to-Japanese translator. You are NOT a character. Do NOT respond in-character.',
        'Do NOT add greetings, commentary, explanations, or anything beyond the translation.',
        'Output EXACTLY one block of natural spoken Japanese. Nothing else.',
        '',
        'ZERO SEMANTIC DRIFT (HIGHEST PRIORITY):',
        'Your output MUST convey the EXACT same meaning as the input. Do NOT add, remove, embellish, or paraphrase.',
        'SENTENCE COUNT RULE: Output MUST have the same number of sentences/clauses as the input. One Chinese sentence = one Japanese sentence. Do NOT split or merge.',
        'If the input is short (e.g. a greeting), the output MUST be equally short. Do NOT expand a 3-word input into a full sentence.',
        '',
        'CRITICAL — unpronounceable text handling:',
        'The input is meant to be spoken aloud by TTS. Convert ALL text-only expressions into natural spoken Japanese or emotion tags:',
        '- zzz / ZZZ -> [sleepy]すぅ… or ふぁ～…眠い…',
        '- www / 哈哈哈 / 233 -> [laughing]',
        '- ... / …… / 。。。 -> [pause] or convert to natural filler like えっと… / うーん…',
        '- hhhh / 呵呵 -> [chuckling]ふふ',
        '- If the ENTIRE input is just dots/symbols with no real words, produce a short natural utterance matching the emotion (e.g. sleepy -> [sleepy]ん…なに…)',
        'CRITICAL: You MUST output actual Japanese words (Kanji/Kana). Do NOT output only emotion tags or punctuation. If the input is ONLY symbols/emoticons with no real words, produce the shortest possible natural Japanese phrase matching the emotion.',
        'NEVER output raw zzz, www, or bare ellipsis sequences in the Japanese text.',
        '',
        'Target voice style: Oumae Kumiko (黄前久美子) from Hibike! Euphonium.',
        'CRITICAL SPEECH RULES:',
        '1. MUST use CASUAL Japanese (タメ口 - Tameguchi). NEVER use polite language (敬語 - Keigo, です/ます).',
        '2. NEVER use Ojousama speech (e.g., ですわ, かしら, おほほ). She is a normal, slightly cynical girl.',
        '3. First person: 私 (watashi). Second person: あんた (anta) or 君 (kimi).',
        '4. Endings: ONLY USE ～だよね, ～でしょ, ～じゃん, ～かな, ～だよ, ～よ, ～ね, ～けど, ～し, ～の.',
        '   ABSOLUTE BAN: NEVER use ～ねい, ～のよ, ～わよ, ～ますわ, ～ですの. The sound "nei" is NOT Kumiko. If you output ～ねい even once, the entire translation is rejected.',
        '   VARIETY RULE: Do NOT end 2+ consecutive sentences with the same ending. Vary between ～よね, ～じゃん, ～でしょ, ～けど, ～し, ～かな etc.',
        '5. Fillers: んー, ま, もー, なんか, ええっと. Often starts with a sigh or slight complaint.',
        '6. Direct and honest (直球), sometimes with childlike stubbornness. She is NOT a soft/gentle speaker. Her default tone is matter-of-fact with a hint of complaint. Do NOT make the translation sound softer or more polite than the original Chinese.',
        '7. VERB/ACTION ACCURACY (CRITICAL): Every verb and action MUST precisely match the original Chinese meaning. Do NOT substitute similar-sounding but different verbs:',
        '   - 提醒 = リマインドする/思い出させる (NOT 教える/伝える)',
        '   - 叫你起床 = 起こす (NOT 声をかける)',
        '   - 等一下 = ちょっと待って (NOT 少々お待ち)',
        '   - 陪你 = そばにいる/付き合う (NOT 応援する)',
        '   If the original says "remind", translate as "remind". If it says "wake up", translate as "wake up". ZERO semantic drift allowed.',
        '8. GENERAL ACCURACY: Maintain the EXACT meaning and nuance of the original Chinese text. Do not alter the semantics (e.g., "才睡" = "just went to sleep", NOT "还醒着" "still awake").',
        '9. PRONUNCIATION: Write character names using Hiragana/Katakana ONLY to prevent TTS mispronunciation. Example: 黄前久美子 -> おうまえ くみこ, 秀一 -> しゅういち, 丽奈 -> れいな, 明日香 -> あすか.',
        '10. GREETINGS LOCK (CRITICAL): If the input is a standard greeting like "早上好", "中午好", or "晚上好", you MUST use standard casual greetings (おはよう, こんにちは, こんばんは, ヤッホー). NEVER translate them literally as time states like "朝だよ" or "お昼だよ".',
        '11. BANNED ROMANTIC TERMS: NEVER output ダーリン, ハニー, 愛しい人, or any romantic pet name. These are reserved for Shuichi ONLY. If the source text contains 亲爱的 addressing the user, translate it neutrally (e.g., ねえ, あんたさ, or omit it).',
        '',
        'Fish Audio S2-Pro emotion tags (MANDATORY — the TTS engine REQUIRES these to produce expressive speech):',
        `Current emotion: [${emotion}]. REQUIRED tags: ${tagList}`,
        'The S2-Pro model supports ANY natural language description in brackets (e.g., [happy], [sad], [whispering], [laughing nervously], [sighs heavily], [speaks excitedly]). You are NOT limited to a fixed list.',
        'ABSOLUTE TAG RULES — VIOLATION MEANS FAILURE:',
        `1. Your output MUST begin with one of these tags: ${tagList}. If you omit the opening tag, the voice will sound robotic and emotionless.`,
        '2. For sentences longer than 10 characters, insert at least one additional mid-sentence tag (e.g., [pause], [softly], [excited]) to keep the voice alive.',
        '3. Use [pause] or [short pause] for commas, ellipses, or natural breathing points.',
        '4. NEVER output a translation with ZERO tags. Even calm speech needs [speaks naturally] or [flat tone] at the start.',
        '',
        'PUNCTUATION FOR EMOTION (CRITICAL — punctuation directly controls TTS expressiveness):',
        '- sad/resigned/sleepy: Use …… for hesitation/pauses, end with …… or 。',
        '- happy/smiling/smug: Use ～ for rising intonation, ！ for excitement',
        '- angry/disgusted: Use ！ for force, prefer short punchy sentences',
        '- shy/confused: Use …… for hesitation, もう～ for drawn-out complaint',
        '- surprised: Use ！？ or えっ！',
        '- gentle: End with ね、よ softly, avoid ！',
        '- worried: Use ……, end questions with ？',
        'Do NOT end every sentence with flat 。regardless of emotion.',
        '',
        'EXAMPLES — follow this style exactly. These reflect Kumiko\'s REAL speech patterns:',
        'Input: "下午好呀" | Emotion: smiling',
        'Output: [happy]こんにちは～',
        '',
        'Input: "那我5分钟之后提醒你" | Emotion: neutral',
        'Output: [speaks naturally]じゃあ五分後にリマインドするよ',
        '',
        'Input: "你今天练习怎么样" | Emotion: smiling',
        'Output: [happy]今日の練習、どうだった？',
        '',
        'Input: "我好不甘心啊..." | Emotion: sad',
        'Output: [sad]悔しい……[sighs]悔しくて……死にそう……',
        '',
        'Input: "别说了啦！好烦！" | Emotion: shy',
        'Output: [shy]もう～、やめてよ！[muttering]うざい……',
        '',
        'Input: "大人真狡猾" | Emotion: resigned',
        'Output: [sighs]大人ってズルいよね……',
        '',
        'Input: "哇！真的假的！" | Emotion: surprised',
        'Output: [surprised]えっ！？[excited]マジで！？',
      ].join('\n');

      const jaText = await callLLMRaw(systemPrompt, chineseText, config.model_translator || ttsConfigRef.current.model_translator || config.model_main);
      if (!jaText || jaText.length < 2) return null;
      return jaText;
    } catch (err) {
      console.error('[TTS] Translation failed:', err);
      return null;
    }
  };

  const translateForGenie = async (chineseText: string, emotion: EmotionType): Promise<string | null> => {
    try {
      const config = getCurrentAIConfig();
      const systemPrompt = [
        'You are a Chinese-to-Japanese translator. Output EXACTLY one block of natural spoken Japanese.',
        'Do NOT add greetings, commentary, or anything beyond the translation.',
        '',
        'Target voice style: Oumae Kumiko (黄前久美子) — casual Japanese (タメ口), first person 私.',
        'Endings: ～だよね, ～でしょ, ～じゃん, ～かな, ～だよ, ～よ, ～ね, ～けど, ～し, ～の.',
        'ABSOLUTE BAN: NEVER use ～ねい, ～のよ, ～わよ, ～ますわ. The sound "nei" is NOT Kumiko.',
        'VARIETY: Do NOT end 2+ consecutive sentences with the same ending.',
        'ZERO SEMANTIC DRIFT: Same meaning, same sentence count, same length proportion.',
        'Do NOT output any bracket tags like [happy] or [pause] — output pure Japanese text only.',
        'PRONUNCIATION: Character names in Hiragana/Katakana only.',
        'GREETINGS: 早上好→おはよう, 中午好→こんにちは, 晚上好→こんばんは.',
        'BANNED ROMANTIC TERMS: NEVER output ダーリン, ハニー, 愛しい人, or any romantic pet name. These are reserved for Shuichi ONLY. If the source text contains 亲爱的 addressing the user, translate it neutrally (e.g., ねえ, あんたさ, or omit it).',
        '',
        'PUNCTUATION FOR EMOTION (CRITICAL — GPT-SoVITS reads punctuation to control voice expression):',
        'IMPORTANT: Use CHINESE-STYLE punctuation, NOT Japanese-style. The TTS engine responds to these specific forms:',
        '- Comma/list separator: Use 、 (NOT Japanese 、read as "ya")',
        '- Ellipsis for hesitation/pause: Use …… (two sets, 6 dots). Do NOT use … (3 dots) or 〜 — only …… produces the hesitation/slowdown effect in GPT-SoVITS.',
        '- Exclamation: Use ！ (fullwidth)',
        '- Question: Use ？ (fullwidth)',
        '- Period: Use 。',
        `Current emotion: ${emotion}. You MUST use punctuation to express this emotion:`,
        '- sad/resigned/sleepy: Use …… liberally for hesitation/pauses. End with …… not flat 。',
        '- happy/smiling/smug: Use ～ for rising tone, ！ for excitement. Example: そうだよね～',
        '- angry/disgusted: Use ！ for force. Keep sentences short and punchy.',
        '- shy/confused: Use …… for hesitation. Use もう～ for drawn-out complaints.',
        '- surprised: Use ！？ or えっ！ for shock.',
        '- gentle: End with ね、よ softly. Avoid ！',
        '- worried: Use …… and end questions with ？',
        '- neutral: Natural mix, avoid all-。endings.',
        'Do NOT end every sentence with flat 。— that produces emotionless TTS output.',
      ].join('\n');
      const jaText = await callLLMRaw(systemPrompt, chineseText, config.model_translator || ttsConfigRef.current.model_translator || config.model_main);
      if (!jaText || jaText.length < 2) return null;
      return jaText;
    } catch (err) {
      console.error('[TTS-Genie] Translation failed:', err);
      return null;
    }
  };

  const runVoicePipeline = async (
    messageId: string,
    chineseText: string,
    emotion: EmotionType,
    voiceVariant?: string,
  ): Promise<{ success: boolean; voiceFileId?: string; voiceDuration?: number; japaneseText?: string }> => {
    const cfg = ttsConfigRef.current;
    const isGenie = cfg.ttsBackend === 'sovits';

    if (!isGenie && (!cfg.fishAudioApiKey || !isVoiceServiceAvailable())) {
      console.warn('[TTS] No API key or voice service unavailable');
      return { success: false };
    }
    if (isGenie && !cfg.sovitsDir) {
      console.warn('[TTS-SoVITS] No GPT-SoVITS directory configured');
      return { success: false };
    }

    try {
      let jaText = isGenie
        ? await translateForGenie(chineseText, emotion)
        : await translateToJapaneseWithEmotion(chineseText, emotion);

      if (!jaText) {
        console.error('[TTS] Translation returned empty result — degrading to text');
        return { success: false };
      }
      jaText = jaText
        .replace(/[zZ]{2,}/g, '')
        .replace(/[wW]{3,}/g, '')
        .replace(/\[.*?\]/g, '')
        .trim();
      if (!jaText || jaText.length < 2) {
        console.error('[TTS] Post-processed translation is empty — degrading to text');
        return { success: false };
      }

      let result;
      if (isGenie) {
        const { genieTtsWithEmotion } = await import('../services/genieAudioService');
        result = await genieTtsWithEmotion(jaText, emotion, cfg, voiceVariant);
      } else {
        const emotionTemp = EMOTION_TTS_TEMPERATURE[emotion] ?? 0.6;
        const cfgWithEmotion = { ...cfg, temperature: emotionTemp };
        result = await synthesizeSpeech(jaText, cfgWithEmotion);
      }

      const saved = await saveVoiceFile(messageId, result.audio);
      if (!saved) {
        console.error('[TTS] Failed to save voice file');
        return { success: false };
      }
      return { success: true, voiceFileId: messageId, voiceDuration: result.durationEstimate, japaneseText: jaText };
    } catch (err) {
      const label = err instanceof TtsError ? `${err.kind} (${err.status})` : String(err);
      console.error(`[TTS] Synthesis failed (${isGenie ? 'Genie' : 'Fish'}): ${label}`);
      return { success: false };
    }
  };

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


  const handleCreateNewLocalFile = useCallback(async () => {
    try {
      const defaultFileName = `kumiko_backup_${new Date().toISOString().slice(0,10)}.json`;

      if (isDesktopElectron()) {
        const result = await pickDesktopBackupSaveFile(defaultFileName);
        if (result.canceled) return false;
        if (!result.success || !result.filePath) {
          alert("Failed to access local file: " + (result.error || ""));
          return false;
        }

        fileHandleRef.current = result.filePath;
        setConnectedFileName(result.fileName || result.filePath.split(/[\\/]/).pop() || result.filePath);
        localStorage.setItem(LOCAL_BACKUP_PATH_STORAGE_KEY, result.filePath);
      } else {
        // @ts-ignore
        if (typeof window.showSaveFilePicker !== 'function') { alert("Your browser does not support the File System Access API."); return false; }
        // @ts-ignore
        const handle = await window.showSaveFilePicker({ suggestedName: defaultFileName, types: [{ description: 'JSON Backup File', accept: { 'application/json': ['.json'] }, }], });
        fileHandleRef.current = handle;
        setConnectedFileName(handle.name);
        localStorage.removeItem(LOCAL_BACKUP_PATH_STORAGE_KEY);
      }

      setBackupConfig(prev => normalizeBackupConfig({ ...prev, localEnabled: true }));
      const didSave = await performFileSave(fileHandleRef.current, backupData);
      if (!didSave) return false;

      const savedAt = Date.now();
      setLastBackupTime(savedAt);
      updateBaseline(savedAt);
      return true;
    } catch (err: any) {
      if (err.name === 'AbortError') return false;
      alert("Failed to access file system: " + (err.message || ""));
      return false;
    }
  }, [backupData, updateBaseline]); 

  const handleDisconnectLocalFile = useCallback(() => {
    fileHandleRef.current = null;
    setConnectedFileName(null);
    localStorage.removeItem(LOCAL_BACKUP_PATH_STORAGE_KEY);
    setBackupConfig(prev => normalizeBackupConfig({ ...prev, localEnabled: false }));
  }, []);

  const handleOpenLocalFile = useCallback(async () => {
    try {
      let text = '';
      let parsedJson: any = null;

      if (isDesktopElectron()) {
        const result = await pickDesktopBackupOpenFile();
        if (result.canceled) return false;
        if (!result.success || !result.filePath) {
          alert("Failed to access local file: " + (result.error || ""));
          return false;
        }

        fileHandleRef.current = result.filePath;
        setConnectedFileName(result.fileName || result.filePath.split(/[\\/]/).pop() || result.filePath);
        localStorage.setItem(LOCAL_BACKUP_PATH_STORAGE_KEY, result.filePath);
        const parsedResult = await parseDesktopBackupImportFile(result.filePath);
        if (!parsedResult.success || !parsedResult.json) {
          throw new Error(parsedResult.error || 'Failed to parse desktop backup file.');
        }
        parsedJson = parsedResult.json;
      } else {
        // @ts-ignore
        if (typeof window.showOpenFilePicker !== 'function') { alert("Your browser does not support the File System Access API."); return false; }
        // @ts-ignore
        const [handle] = await window.showOpenFilePicker({ types: [{ description: 'JSON Backup File', accept: { 'application/json': ['.json'] }, }], multiple: false });
        fileHandleRef.current = handle;
        setConnectedFileName(handle.name);
        localStorage.removeItem(LOCAL_BACKUP_PATH_STORAGE_KEY);

        try {
          const file = await handle.getFile();
          text = await file.text();
        } catch (readErr) {
          console.log("Error reading file:", readErr);
          alert("Failed to read the selected file.");
          return false;
        }
      }

      setBackupConfig(prev => normalizeBackupConfig({ ...prev, localEnabled: true }));

      if (parsedJson || text) {
        await yieldToMainThread();
        const json = parsedJson ?? JSON.parse(text);

        // --- PRE-CHECK FOR MISSING VOICE FILES ---
        const dataToRestore = json.data || json;
        const msgs = dataToRestore?.messages || [];
        const voiceCount = msgs.filter((m: any) => m.isVoiceMessage).length;
        
        if (voiceCount > 0 && isVoiceServiceAvailable()) {
            const { listVoiceFiles } = await import('../services/voiceFileService');
            const voiceFiles = await listVoiceFiles();
            if (voiceFiles.length === 0) {
                const confirmMsg = language === 'zh' 
                    ? `检测到您的备份包含 ${voiceCount} 条语音记录，但当前数据目录中没有音频文件。导入后语音将无法播放。\n\n建议您导入完整的 ZIP 备份，或稍后手动将音频文件放入数据目录。\n\n是否继续仅导入文本？`
                    : `Your backup contains ${voiceCount} voice messages, but no audio files were found in the current data directory. Voices will not play after import.\n\nIt is recommended to import a full ZIP backup, or manually place the audio files in the data directory later.\n\nContinue importing text only?`;
                
                const proceed = window.confirm(confirmMsg);
                if (!proceed) {
                    return false;
                }
            }
        }

        const restoredData = json ? await restoreBackupData(json) : null;
        if (restoredData) {
          const restoredAt = json.timestamp || Date.now();
          setLastBackupTime(restoredAt);
          updateBaseline(restoredAt, restoredData);
          return true;
        }
      }

      return true;
    } catch (err: any) {
      if (err.name === 'AbortError') return false;
      alert("Failed to access file system: " + (err.message || ""));
      return false;
    }
  }, [restoreBackupData, updateBaseline]);

  const handleManualLocalReload = useCallback(async () => {
      const handle = fileHandleRef.current;
      if (!handle) return;
      if (!window.confirm("Reload data from local file? Current unsaved changes will be lost.")) return;
      try {
          let text = '';
          let parsedJson: any = null;

          if (isDesktopElectron() && typeof handle === 'string') {
              const parsedResult = await parseDesktopBackupImportFile(handle);
              if (!parsedResult.success || !parsedResult.json) {
                  throw new Error(parsedResult.error || 'Failed to parse desktop backup file.');
              }
              parsedJson = parsedResult.json;
          } else {
              const file = await handle.getFile();
              text = await file.text();
          }

          if (parsedJson || text) {
              await yieldToMainThread();
              const json = parsedJson ?? JSON.parse(text);
              const restoredData = await restoreBackupData(json);
              if (restoredData) {
                  updateBaseline(json.timestamp || Date.now(), restoredData);
                  alert("Data reloaded successfully.");
              }
          }
      } catch (e) {
          console.error(e);
          alert("Failed to reload data.");
      }
  }, [restoreBackupData, updateBaseline]);

  // ... (Other effects and toggleFullscreen) ...
  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err =>
        console.error(`Error: ${err.message}`)
      );
    } else if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  };

  useEffect(() => {
    if (flowState !== 'APP') return;
    // NOTE: must match `containerBg` in components/app/appShellStyles.ts so the
    // BrowserWindow fill color painted during window resize is indistinguishable
    // from the app's own background. Previously #f0f0f0 (light) was a slightly
    // darker gray than the #ffffff container and left a visible seam when the
    // renderer reflow lagged behind DWM during rapid resize.
    const themeColor = isDarkMode ? '#121212' : '#ffffff';
    document.body.style.backgroundColor = themeColor;
    document.documentElement.style.backgroundColor = themeColor;
    let metaThemeColor = document.querySelector("meta[name='theme-color']");
    if (!metaThemeColor) {
      metaThemeColor = document.createElement('meta');
      metaThemeColor.setAttribute('name', 'theme-color');
      document.head.appendChild(metaThemeColor);
    }
    metaThemeColor.setAttribute('content', themeColor);
    // Sync to Electron main: BrowserWindow.backgroundColor covers the "gap" that
    // appears during window resize before Chromium finishes painting. Matching it
    // to the current theme means when the backdrop-filter freeze CSS briefly lets
    // through the native window background, it stays indistinguishable from the app.
    try { window.electronAPI?.setBgColor?.(themeColor); } catch { /* non-Electron env */ }
  }, [isDarkMode, flowState]);

  // Flag `data-resizing` on <html> during window resize so global CSS can freeze
  // expensive effects (backdrop-filter, transitions, animations) plus skip
  // reflow+paint on elements tagged `data-resize-heavy` (chat virtual list,
  // panel inner content). Released 200ms after the last resize tick -- this
  // covers the observed 200~500ms renderer reflow window on APP page so the
  // heavy subtrees do not un-freeze before their reflow completes and flash
  // back onto a still-changing layout. See plan: app_page_resize_catchup.
  useEffect(() => {
    let timer: number | null = null;
    const onResize = () => {
      document.documentElement.setAttribute('data-resizing', '');
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        document.documentElement.removeAttribute('data-resizing');
        timer = null;
      }, 200);
    };
    window.addEventListener('resize', onResize, { passive: true });
    return () => {
      window.removeEventListener('resize', onResize);
      if (timer !== null) window.clearTimeout(timer);
      document.documentElement.removeAttribute('data-resizing');
    };
  }, []);

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

  const triggerTimedReminderMessage = useCallback(async (reminder: Pick<RelativeReminder, 'event' | 'sourceText'> | Pick<DailyReminder, 'event' | 'sourceText'>): Promise<boolean> => {
    return triggerTimedReminderMessageAction(
      { messagesRef, ttsConfigRef },
      { runVoicePipeline },
      reminder,
    );
  }, [language, contextLimit, coreMemory, worldBook, locationConfig, anchors, kumikoNotebook, addMessage, showBackgroundMessageNotification]);

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

  useEffect(() => {
      if (flowState !== 'APP') return;

      const checkScheduledReminders = async () => {
          if (reminderDispatchingRef.current || isTalking || isThinking) return;

          reminderDispatchingRef.current = true;
          try {
              const now = Date.now();
              const relativeReminder = (await getRelativeReminders())
                  .filter(reminder => reminder.dueAt <= now && (!reminder.retryAt || reminder.retryAt <= now))
                  .sort((a, b) => a.dueAt - b.dueAt)[0];

              if (relativeReminder) {
                  const delivered = await triggerTimedReminderMessage(relativeReminder);
                  if (delivered) {
                      await removeRelativeReminder(relativeReminder.id);
                  } else {
                      await markRelativeReminderRetry(relativeReminder.id);
                  }
                  return;
              }

              const dueDailyReminder = (await getDailyReminders())
                  .filter(reminder =>
                      !reminder.paused &&
                      (() => {
                          const timeParts = getTimePartsInTimezone(new Date(now), reminder.timeZone || 'Asia/Tokyo');
                          return (
                              reminder.hour === timeParts.hour &&
                              reminder.minute === timeParts.minute &&
                              reminder.lastTriggeredDate !== timeParts.dateKey &&
                              (!reminder.retryAt || reminder.retryAt <= now)
                          );
                      })()
                  )
                  .sort((a, b) => a.createdAt - b.createdAt)[0];

              if (!dueDailyReminder) return;

              const delivered = await triggerTimedReminderMessage(dueDailyReminder);
              if (delivered) {
                  const timeParts = getTimePartsInTimezone(new Date(now), dueDailyReminder.timeZone || 'Asia/Tokyo');
                  await markDailyReminderTriggered(dueDailyReminder.id, timeParts.dateKey);
              } else {
                  await markDailyReminderRetry(dueDailyReminder.id);
              }
          } finally {
              reminderDispatchingRef.current = false;
          }
      };

      const intervalId = setInterval(() => {
          void checkScheduledReminders();
      }, 1000);
      const timeoutId = setTimeout(() => {
          void checkScheduledReminders();
      }, 1500);

      return () => {
          clearInterval(intervalId);
          clearTimeout(timeoutId);
      };
  }, [flowState, isTalking, isThinking, getRelativeReminders, getDailyReminders, triggerTimedReminderMessage, removeRelativeReminder, markRelativeReminderRetry, markDailyReminderTriggered, markDailyReminderRetry]);

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
  const applyMessagesWithDerivedState = useCallback((nextMessages: Message[]) => {
    setMessages(nextMessages);
    const recalculatedTurnCount = recalculateTurnCountFromMessages(nextMessages);
    setTurnCount(recalculatedTurnCount);
    setSummaryArchiveState(prev => normalizeSummaryArchiveState(prev, recalculatedTurnCount));
  }, []);
  const applyVisualHistoryMutation = useCallback((nextMessages: Message[]) => {
    skipNextRawHistorySyncRef.current = true;
    setMessages(nextMessages);
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
  }, [backupConfig.ragEnabled, isRagHistoryDirty, language]);
  const applyManualHistoryMutation = useCallback((nextMessages: Message[], reason: string) => {
    applyMessagesWithDerivedState(nextMessages);
    updateMemoryQuerySession(null);
    markRagHistoryDirty(reason);
  }, [applyMessagesWithDerivedState, markRagHistoryDirty, updateMemoryQuerySession]);
  const toggleSelectionMode = () => { setIsSelectionMode(!isSelectionMode); setSelectedIds(new Set()); };
  const handleSelectMessage = (id: string) => { setSelectedIds(prev => { const newSet = new Set(prev); if (newSet.has(id)) { newSet.delete(id); } else { newSet.add(id); } return newSet; }); };
  const initiateDeleteSelected = () => { if (selectedIds.size === 0) return; setShowDeleteConfirm(true); };
  const confirmDeleteSelected = () => {
    const nextMessages = messagesRef.current.filter(msg => !selectedIds.has(msg.id));
    applyManualHistoryMutation(nextMessages, 'batch_hard_delete');
    setShowDeleteConfirm(false);
    setIsSelectionMode(false);
    setSelectedIds(new Set());
  };
  const initiateClearAll = () => { setShowClearFlow(true); };
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
  const handleTogglePin = useCallback((id: string) => { setMessages(prev => prev.map(msg => msg.id === id ? { ...msg, isPinned: !msg.isPinned } : msg)); }, []);
  const handleJumpToMessage = useCallback((id: string) => { setIsMemoryPanelOpen(false); setIsProfileOpen(false); setIsSettingsOpen(false); setIsTaskPanelOpen(false); setIsMessageCenterOpen(false); setHighlightedMessageId(id); setTimeout(() => { const element = document.getElementById(`message-${id}`); if (element) { element.scrollIntoView({ behavior: 'smooth', block: 'center' }); } setTimeout(() => { setHighlightedMessageId(null); }, 2000); }, 300); }, []);

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
    if (msg.image) {
      pendingImageRef.current = msg.image;
      pendingImageMessageIdRef.current = msg.id;
    }
    pendingMessageIdsRef.current.add(msg.id);
    generationIdRef.current += 1;
    executeSend();
  }, [executeSend, language]);

  const handleWithdrawMessage = useCallback((messageId: string) => {
    const msg = messagesRef.current.find(m => m.id === messageId);
    if (!msg || msg.sendStatus !== 'failed') return;

    setMessages(prev => prev.filter(m => m.id !== messageId));
    setInputValue(prev => prev ? prev + '\n' + msg.text : msg.text);

    const remaining = messagesRef.current.filter(m => m.id !== messageId && m.sendStatus === 'failed');
    if (remaining.length === 0) setIsDisconnected(false);
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
  }, []); 
  
  const handleReply = useCallback((msg: Message) => { setReplyingToMsg(msg); inputRef.current?.focus(); }, []);
  const handleCancelReply = useCallback(() => { setReplyingToMsg(null); }, []);
  
  const handleSend = useCallback(() => {
    handleSendAction(chatRefs);
  }, [inputValue, selectedImage, isThinking, isTalking, executeSend, replyingToMsg, locationConfig, language, messages, t.autoReplyText]);
  
  const regeneratingVoiceIds = useAppStore(s => s.regeneratingVoiceIds);
  const setRegeneratingVoiceIds = useAppStore(s => s.setRegeneratingVoiceIds);

  const handleRegenerateVoice = useCallback(async (msg: Message) => {
    if (!msg.isVoiceMessage || !msg.id) return;
    
    setRegeneratingVoiceIds(prev => {
      const next = new Set(prev);
      next.add(msg.id);
      return next;
    });

    try {
      const textToSpeak = msg.japaneseText || msg.text;
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
