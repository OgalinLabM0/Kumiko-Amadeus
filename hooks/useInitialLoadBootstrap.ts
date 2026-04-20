import { useEffect, type MutableRefObject } from 'react';
import { loadRawHistoryMessages } from '../components/app/rawHistorySync';
import { recalculateTurnCountFromMessages, sanitizeRelativeReminderRecord, sanitizeDailyReminderRecord, sanitizeMessageAlertRecord, sanitizeWorldCharacterStatusRecord, sanitizeKumikoDiaryRecord, sanitizeDailyFragmentRecord, sanitizePsycheStateRecord } from '../components/app/backupHelpers';
import { normalizeSummaryArchiveState, resolveCoreMemoryFromSummaryArchive } from '../components/app/summaryCycle';
import { normalizeMemoryQuerySession } from '../components/app/ragRecallHelpers';
import {
  SUMMARY_ARCHIVE_STATE_STORAGE_KEY,
  MEMORY_QUERY_SESSION_STORAGE_KEY,
  MESSAGE_ALERTS_STORAGE_KEY,
} from '../components/app/appConstants';
import {
  db,
  INITIAL_WORLD_CHARACTER_STATUS,
  type DailyFragmentEntity,
  type KumikoDiaryEntity,
  type PsycheStateEntity,
  type WorldCharacterStatusMap,
} from '../services/db';
import { DEFAULT_BACKUP_CONFIG, normalizeBackupConfig } from '../services/appConfig';
import { DEFAULT_LOCATION_CONFIG, LOCALIZED_WORLD_BOOK } from '../constants';
import { RELATIVE_REMINDER_STORAGE_KEY, DAILY_REMINDER_STORAGE_KEY, type RelativeReminder, type DailyReminder } from '../store/slices/reminderSlice';
import { RAG_HISTORY_DIRTY_STORAGE_KEY } from '../store/slices/ragSlice';
import type {
  Message,
  Language,
  LocationConfig,
  EmotionType,
  WorldBookEntry,
  AnchorEntry,
  BackupConfig,
  SummaryArchiveState,
  MemoryQuerySession,
  MissedMessageAlert,
} from '../types';

export interface UseInitialLoadBootstrapParams {
  // Refs that survive across renders, written during load.
  rawHistorySyncedIdsRef: MutableRefObject<Set<string>>;
  forceRawHistoryResyncRef: MutableRefObject<boolean>;
  ragBufferRef: MutableRefObject<string[]>;

  // Memory-query session is always written via updateMemoryQuerySession
  // (ref + IndexedDB mirror); deps must match the original effect 1:1.
  updateMemoryQuerySession: (next: MemoryQuerySession | null) => void;

  // Setters (store actions; stable Zustand refs)
  setMessages: (v: Message[]) => void;
  setIsDisconnected: (v: boolean) => void;
  setLanguage: (v: Language) => void;
  setLocationConfig: (v: LocationConfig) => void;
  setCoreMemory: (v: string) => void;
  setKumikoNotebook: (v: string) => void;
  setContextLimit: (v: number) => void;
  setDiaryLayerPreset: (v: 'economy' | 'balanced' | 'rich') => void;
  setImageQualityPreset: (v: 'original' | 'high' | 'standard' | 'compact') => void;
  setWorldBook: (v: WorldBookEntry[]) => void;
  setTurnCount: (v: number) => void;
  setSummaryArchiveState: (v: SummaryArchiveState | ((prev: SummaryArchiveState) => SummaryArchiveState)) => void;
  setAnchors: (v: AnchorEntry[]) => void;
  setCurrentEmotion: (v: EmotionType) => void;
  setRelativeReminders: (v: RelativeReminder[]) => void;
  setDailyReminders: (v: DailyReminder[]) => void;
  setMessageAlerts: (v: MissedMessageAlert[]) => void;
  setWorldCharacterStatus: (v: WorldCharacterStatusMap) => void;
  setAutoSavedKumikoDiary: (v: KumikoDiaryEntity[]) => void;
  setAutoSavedDailyFragments: (v: DailyFragmentEntity[]) => void;
  setAutoSavedPsycheState: (v: PsycheStateEntity | null) => void;
  setBackupConfig: (v: BackupConfig) => void;
  setIsRagHistoryDirty: (v: boolean) => void;
  setIsDataLoaded: (v: boolean) => void;
  setDataLoadError: (v: string | null) => void;
  setSystemNotice: (v: string | null) => void;
}

/**
 * Runs the one-shot data hydration that used to live inline at App.tsx L688.
 *
 * Flow:
 *   1. Loads messages via raw history sync; derives turn count + summary
 *      archive state + core memory; hydrates memory-query session.
 *   2. Pulls ~20 keys out of Dexie into the store, with defensive
 *      normalisation for rows that may legacy-corrupt.
 *   3. On failure, records `dataLoadError` so `useAutoSave` can block writes
 *      and surfaces a bilingual notice before still flipping `isDataLoaded`
 *      so the UI can render the error screen.
 *
 * Dep list is intentionally `[updateMemoryQuerySession]` only, matching the
 * pre-extraction effect exactly. Every other dependency is either a stable
 * setter (Zustand) or a mutable ref.
 */
export const useInitialLoadBootstrap = (params: UseInitialLoadBootstrapParams): void => {
  const {
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
  } = params;

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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- preserve original deps (all setters/refs are stable; only updateMemoryQuerySession triggers re-run)
  }, [updateMemoryQuerySession]);
};
