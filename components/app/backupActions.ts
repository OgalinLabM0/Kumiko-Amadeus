import React from 'react';
import { runBackupRestoreSession } from '../../services/backupRestoreSession';
import { getDataRestoreVersion, isDataRestoreBlocked, permitDataRestoreTransaction } from '../../services/dataRestoreGate';
import type { PreparedBackupMediaHooks } from '../../services/backupMediaStaging';
import { captureReminderNativeCancellationsForRestore, mergeReminderNativeCancellationsAfterRestore,
  drainReminderNativeCancellations } from '../../services/reminderNativeCancellation';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { useAppStore } from '../../store';
import type {
  Message,
  WorldBookEntry,
  SummaryArchiveState,
  BackupConfig,
  Language,
  MissedMessageAlert,
} from '../../types';
import {
  DEFAULT_WORLD_BOOK,
  UI_TRANSLATIONS,
  DEFAULT_LOCATION_CONFIG,
  LOCALIZED_WORLD_BOOK,
} from '../../constants';
import {
  normalizeImportedBackupMessages,
  mapMessageToEntity,
} from './messageMappers';
import {
  recalculateTurnCountFromMessages,
  sanitizeRelativeReminderRecord,
  sanitizeDailyReminderRecord,
  sanitizeMissedReminderRecord,
  sanitizeWorldCharacterStatusRecord,
  sanitizeKumikoDiaryRecord,
  sanitizeDailyFragmentRecord,
  sanitizePsycheStateRecord,
  sanitizeEpisodeRecord,
  summarizeBackupPayloadForLog,
} from './backupHelpers';
import {
  normalizeSummaryArchiveState,
  resolveCoreMemoryFromSummaryArchive,
} from './summaryCycle';
import { syncRawHistoryMessages } from './rawHistorySync';
import { yieldToMainThread } from './appUtils';
import { buildBackupData, validateBackupData, type AutoZipMeta } from './backupData';
import { validateBackupImportPayload } from './backupImportValidation';
import {
  db,
  INITIAL_WORLD_CHARACTER_STATUS,
  type DailyFragmentEntity,
  type EpisodeEntity,
  type KumikoDiaryEntity,
  type PsycheStateEntity,
  type WorldCharacterStatusMap,
} from '../../services/db';
import {
  normalizeBackupConfig,
} from '../../services/appConfig';
import {
  parseDesktopBackupImportFile,
  isDesktopElectron,
  writeDesktopBackupFile,
  buildDesktopBackupZip,
} from '../../services/desktopBackupService';
import { isCapacitorNative } from '../../services/environment';
// F2B.3: dropped `isMobilePwa` + `httpApi` imports. Mobile PWA used to
// export through `/api/backup/export` and import via `/api/backup/import`
// on the PC; both endpoints are gone with the rest of the bridge.
import { exportBackupZipNative } from '../../services/capacitorBackupNative';
import { dialogService } from '../../services/dialogService';
import { getSessionBackupPassword, protectionStatus } from '../../services/backupProtection';
import { encryptPortableBackup, decryptPortableBackup, isEncryptedBackup } from '../../services/portableBackupCrypto.mjs';
import { createBackupArchiveReader, validateBackupArchive } from '../../services/backupArchiveValidation.mjs';
import { withMediaWriteFence } from '../../services/mediaWriteFence';
import { syncTemporalEpisodes, buildTemporalEpisodes } from '../../services/temporalEpisodeService';
import { imageService } from '../../services/imageService';
import type { BackupMedia } from '../../services/backupMediaStaging';
import {
  isVoiceServiceAvailable,
} from '../../services/voiceFileService';
import {
  getAllVectors,
} from '../../services/localRagService';
import { RAG_HISTORY_DIRTY_STORAGE_KEY } from '../../store/slices/ragSlice';
import type { RelativeReminder, DailyReminder } from '../../store/slices/reminderSlice';
import { RELATIVE_REMINDER_STORAGE_KEY, DAILY_REMINDER_STORAGE_KEY } from '../../store/slices/reminderSlice';
import { getUserKnownLocation, sanitizeUserKnownLocation, USER_KNOWN_LOCATION_KEY } from '../../services/userKnownLocation';
import { exportTurnExecutionState, getBackupExecutionState, replaceTurnExecutionState, validateExecutionStateIntegrity, executionStateEntries } from '../../services/turnStateBackup';
import {
  SUMMARY_ARCHIVE_STATE_STORAGE_KEY,
  MEMORY_QUERY_SESSION_STORAGE_KEY,
} from './appConstants';

// ---------------------------------------------------------------------------
// Shared dep interfaces
// ---------------------------------------------------------------------------

export interface PersistBackupRefs {
  rawHistorySyncedIdsRef: React.MutableRefObject<Set<string>>;
  forceRawHistoryResyncRef: React.MutableRefObject<boolean>;
}

export interface RestoreBackupDeps {
  mediaHooks?: PreparedBackupMediaHooks;
  expectedVersion?: string;
  isBulkRestoreInProgressRef: React.MutableRefObject<boolean>;
  rawHistorySyncedIdsRef: React.MutableRefObject<Set<string>>;
  forceRawHistoryResyncRef: React.MutableRefObject<boolean>;
  updateMemoryQuerySession: (next: unknown, options?: { persist?: boolean }) => void;
  setWorldCharacterStatus: React.Dispatch<React.SetStateAction<WorldCharacterStatusMap>>;
  setAutoSavedKumikoDiary: React.Dispatch<React.SetStateAction<KumikoDiaryEntity[]>>;
  setAutoSavedDailyFragments: React.Dispatch<React.SetStateAction<DailyFragmentEntity[]>>;
  setAutoSavedPsycheState: React.Dispatch<React.SetStateAction<PsycheStateEntity | null>>;
  worldCharacterStatus: WorldCharacterStatusMap;
  autoSavedKumikoDiary: KumikoDiaryEntity[];
  autoSavedDailyFragments: DailyFragmentEntity[];
  autoSavedPsycheState: PsycheStateEntity | null;
}

// CloudRestoreDeps removed with cloud sync feature.

export interface ImportBackupDeps {
  restoreParsedBackupPayload: (
    json: any,
    importedImages?: Array<{ id: string; dataUrl: string }>,
    media?: BackupMedia,
    expectedVersion?: string,
  ) => Promise<any>;
  updateBaseline: (ts: number, data?: any) => void;
}

// ---------------------------------------------------------------------------
// normalizeBackupData
// ---------------------------------------------------------------------------

export function normalizeBackupData(source: any) {
  const state = useAppStore.getState();
  const language = state.language;

  const root = source.data ?? source;
  const executionState = getBackupExecutionState(source);
  const targetMessages = root.messages;
  const normalizedBackupMessages = normalizeImportedBackupMessages(
    Array.isArray(targetMessages) ? targetMessages : []
  );
  if (
    normalizedBackupMessages.stats.coercedTimestampCount > 0
    || normalizedBackupMessages.stats.droppedCount > 0
  ) {
    console.warn('[RESTORE] Backup message normalization adjusted imported history.', normalizedBackupMessages.stats);
  }

  const currentLang = typeof root.language === 'string' ? root.language : language;

  const baselineLore = LOCALIZED_WORLD_BOOK[currentLang] || DEFAULT_WORLD_BOOK;
  let finalWorldBook: WorldBookEntry[] = baselineLore;

  const backupEntries = (root.worldBook && Array.isArray(root.worldBook))
    ? root.worldBook
    : [];

  const backupMap = new Map(backupEntries.map((e: any) => [e.id, e]));
  const officialIds = new Set(baselineLore.map(e => e.id));

  const mergedOfficial = baselineLore.map(officialEntry => {
    const saved = backupMap.get(officialEntry.id);
    if (saved) {
      return {
        ...officialEntry,
        isActive: (saved as any).isActive ?? officialEntry.isActive,
        isHighPriority: (saved as any).isHighPriority ?? officialEntry.isHighPriority,
      };
    }
    return officialEntry;
  });

  const customEntries = backupEntries.filter((e: any) => e.id && !officialIds.has(e.id) && e.content);
  const sanitizedCustom = customEntries.map((e: any) => ({
    id: e.id,
    title: e.title || 'Custom Entry',
    content: e.content,
    isActive: e.isActive ?? true,
    isHighPriority: !!e.isHighPriority,
  }));

  finalWorldBook = [...mergedOfficial, ...sanitizedCustom];

  const normalizedTurnCount = typeof root.turnCount === 'number' ? root.turnCount : state.turnCount;
  const normalizedSummaryArchiveState = normalizeSummaryArchiveState(
    root.summaryArchiveState ?? state.summaryArchiveState,
    normalizedTurnCount,
  );
  const normalizedCoreMemory = resolveCoreMemoryFromSummaryArchive(
    normalizedSummaryArchiveState,
    typeof root.coreMemory === 'string' ? root.coreMemory : state.coreMemory,
  );
  const hasWorldCharacterStatus = root.worldCharacterStatus !== undefined || source.worldCharacterStatus !== undefined;
  const hasKumikoDiary = root.kumikoDiary !== undefined || source.kumikoDiary !== undefined;
  const hasDailyFragments = root.dailyFragments !== undefined || source.dailyFragments !== undefined;
  const hasPsycheState = root.psycheState !== undefined || source.psycheState !== undefined;
  const hasEpisodes = root.episodes !== undefined || source.episodes !== undefined;
  const hasKnownLocation = root.userKnownLocation !== undefined || source.userKnownLocation !== undefined;

  return {
    executionState,
    memoryAssetRevisions: root.memoryAssetRevisions && typeof root.memoryAssetRevisions === 'object' ? root.memoryAssetRevisions : {},
    missedReminders: ((executionStateEntries(executionState).find(row => row.key === 'kumiko_missed_reminders')?.value as any[]) || [])
      .map(sanitizeMissedReminderRecord).filter(Boolean),
    vectors: Array.isArray(root.vectors) ? root.vectors : Array.isArray(source.vectors) ? source.vectors : undefined,
    userKnownLocation: hasKnownLocation
      ? sanitizeUserKnownLocation(root.userKnownLocation !== undefined ? root.userKnownLocation : source.userKnownLocation)
      : undefined,
    messages: normalizedBackupMessages.messages,
    coreMemory: normalizedCoreMemory,
    worldBook: finalWorldBook,
    contextLimit: typeof root.contextLimit === 'number' ? root.contextLimit : state.contextLimit,
    turnCount: normalizedTurnCount,
    summaryArchiveState: normalizedSummaryArchiveState,
    currentEmotion: typeof root.currentEmotion === 'string' ? root.currentEmotion : state.currentEmotion,
    locationConfig: root.locationConfig ?? state.locationConfig ?? DEFAULT_LOCATION_CONFIG,
    language: currentLang,
    anchors: Array.isArray(root.anchors) ? root.anchors : state.anchors,
    kumikoNotebook: typeof root.kumikoNotebook === 'string' ? root.kumikoNotebook : state.kumikoNotebook,
    relativeReminders: Array.isArray(root.relativeReminders)
      ? root.relativeReminders.map(sanitizeRelativeReminderRecord).filter(Boolean).map(r => ({ ...r, paused: true }))
      : (state.relativeReminders || []).map(r => ({ ...r, paused: true })),
    dailyReminders: Array.isArray(root.dailyReminders)
      ? root.dailyReminders.map(sanitizeDailyReminderRecord).filter(Boolean).map(r => ({ ...r, paused: true }))
      : (state.dailyReminders || []).map(r => ({ ...r, paused: true })),
    worldCharacterStatus: hasWorldCharacterStatus
      ? sanitizeWorldCharacterStatusRecord(root.worldCharacterStatus ?? source.worldCharacterStatus)
      : undefined,
    kumikoDiary: hasKumikoDiary
      ? (Array.isArray(root.kumikoDiary) ? root.kumikoDiary : source.kumikoDiary)
          .map(sanitizeKumikoDiaryRecord)
          .filter(Boolean)
      : undefined,
    dailyFragments: hasDailyFragments
      ? (Array.isArray(root.dailyFragments) ? root.dailyFragments : source.dailyFragments)
          .map(sanitizeDailyFragmentRecord)
          .filter(Boolean)
      : undefined,
    psycheState: hasPsycheState
      ? sanitizePsycheStateRecord(root.psycheState ?? source.psycheState)
      : undefined,
    episodes: hasEpisodes
      ? (Array.isArray(root.episodes) ? root.episodes : source.episodes)
          .map(sanitizeEpisodeRecord)
          .filter(Boolean)
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// persistNormalizedBackupData
// ---------------------------------------------------------------------------

export async function persistNormalizedBackupData(
  normalizedData: any,
  refs: PersistBackupRefs,
  restoreId?: string,
) {
  // Reject malformed execution state before changing raw history or tables.
  const executionState = await validateExecutionStateIntegrity(normalizedData.executionState);
  const normalizedMessages: Message[] = Array.isArray(normalizedData.messages) ? normalizedData.messages : [];
  const recalculatedTurnCount = recalculateTurnCountFromMessages(normalizedMessages);
  const normalizedSummaryState = normalizeSummaryArchiveState(
    normalizedData.summaryArchiveState,
    recalculatedTurnCount,
  );
  const normalizedCoreMemory = resolveCoreMemoryFromSummaryArchive(
    normalizedSummaryState,
    normalizedData.coreMemory,
  );

  const episodes = normalizedData.episodes ?? buildTemporalEpisodes(normalizedMessages);
  // No network, filesystem or UI work belongs in this transaction. Raw
  // history and its legacy key must commit with the rest of the dataset.
  await db.transaction('rw', db.tables, async tx => {
    if (restoreId) permitDataRestoreTransaction(tx, restoreId);
    const nativeCancelBeforeRestore = await captureReminderNativeCancellationsForRestore();
    await db.messages.clear();
    if (normalizedMessages.length) await db.messages.bulkPut(normalizedMessages.map(mapMessageToEntity));
    await db.episodes.clear();
    if (episodes.length) await db.episodes.bulkPut(episodes);
    if (!isDesktopElectron()) {
      const vectors = normalizedData.vectors || [];
      await db.vectors.clear();
      if (vectors.length) await db.vectors.bulkPut(vectors.map(v => ({ ...v, vector: new Float32Array(v.vector) })));
    }
    if (normalizedData.kumikoDiary !== undefined) {
      await db.kumikoDiary.clear();
      if (normalizedData.kumikoDiary.length > 0) {
        await db.kumikoDiary.bulkPut(normalizedData.kumikoDiary);
      }
    }

    if (normalizedData.dailyFragments !== undefined) {
      await db.dailyFragments.clear();
      if (normalizedData.dailyFragments.length > 0) {
        await db.dailyFragments.bulkPut(normalizedData.dailyFragments);
      }
    }

    if (normalizedData.psycheState !== undefined) {
      await db.psycheState.clear();
      if (normalizedData.psycheState) {
        await db.psycheState.put(normalizedData.psycheState);
      }
    }

    // Keyval writes inside the same transaction. We use db.keyval.put
    // directly (instead of db.setVal which itself opens a tiny rw
    // transaction) so Dexie merges everything into a single commit.
    const keyvalRows: Array<{ key: string; value: any }> = [
      { key: 'kumiko_chat_history', value: normalizedMessages },
      { key: 'kumiko_core_memory', value: normalizedCoreMemory },
      { key: 'kumiko_world_book', value: normalizedData.worldBook },
      { key: 'kumiko_context_limit', value: normalizedData.contextLimit },
      { key: 'kumiko_turn_count', value: recalculatedTurnCount },
      { key: SUMMARY_ARCHIVE_STATE_STORAGE_KEY, value: normalizedSummaryState },
      { key: 'kumiko_current_emotion', value: normalizedData.currentEmotion },
      { key: 'kumiko_location_config', value: normalizedData.locationConfig },
      { key: 'kumiko_language', value: normalizedData.language },
      { key: 'kumiko_anchors', value: normalizedData.anchors },
      { key: 'kumiko_notebook', value: normalizedData.kumikoNotebook },
      { key: RELATIVE_REMINDER_STORAGE_KEY, value: normalizedData.relativeReminders || [] },
      { key: DAILY_REMINDER_STORAGE_KEY, value: normalizedData.dailyReminders || [] },
      // In-flight drafts/unread ledgers from the live dataset cannot be
      // carried across a restore. Explicit received-turn records are restored
      // by replaceTurnExecutionState under the new facts-only policy.
      { key: 'kumiko_busy_followup', value: null },
      { key: 'kumiko_pending_apology', value: null },
      { key: 'kumiko_busy_slot_runtime', value: null },
      { key: MEMORY_QUERY_SESSION_STORAGE_KEY, value: null },
      { key: RAG_HISTORY_DIRTY_STORAGE_KEY, value: !normalizedData.vectors },
      { key: 'kumiko_turn_archive_status_v1', value: null },
    ];

    if (normalizedData.worldCharacterStatus !== undefined) {
      keyvalRows.push({ key: 'world_character_status', value: normalizedData.worldCharacterStatus });
    }
    if (normalizedData.userKnownLocation !== undefined) {
      keyvalRows.push({ key: USER_KNOWN_LOCATION_KEY, value: normalizedData.userKnownLocation });
    }

    await db.keyval.bulkPut(keyvalRows.map(row => ({ ...row, ...(typeof normalizedData.memoryAssetRevisions?.[row.key] === 'string' ? { sourceRevision: normalizedData.memoryAssetRevisions[row.key] } : {}) })));
    await replaceTurnExecutionState(executionState);
    await mergeReminderNativeCancellationsAfterRestore(nativeCancelBeforeRestore);
  });
  refs.rawHistorySyncedIdsRef.current = new Set(normalizedMessages.map(message => message.id));
  refs.forceRawHistoryResyncRef.current = false;
}

// ---------------------------------------------------------------------------
// restoreBackupData
// ---------------------------------------------------------------------------

export async function restoreBackupData(
  backup: any,
  deps: RestoreBackupDeps,
) {
  const validation = validateBackupImportPayload(backup);
  if (!validation.valid) {
    console.warn('[RESTORE] Backup rejected before state writes:', validation.reason);
    return null;
  }
  try { getBackupExecutionState(backup); } catch {
    console.warn('[RESTORE] Backup rejected before state writes: invalid execution state.');
    return null;
  }

  const {
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
  } = deps;

  const s = useAppStore.getState();
  const previousSyncedIds = new Set(rawHistorySyncedIdsRef.current);
  const previousForceSync = forceRawHistoryResyncRef.current;

  console.log('[RESTORE] Normalizing backup data summary:', summarizeBackupPayloadForLog(backup));
  const { applyMemoryCorrectionsToBackup } = await import('../../services/memoryCorrectionBackup');
  const normalizedData = normalizeBackupData(await applyMemoryCorrectionsToBackup(backup));
  console.log('[RESTORE] Normalized Data Messages count:', normalizedData.messages.length);

  const restoredTurnCount = recalculateTurnCountFromMessages(
    Array.isArray(normalizedData.messages) ? normalizedData.messages : [],
  );
  const restoredSummaryArchiveState = normalizeSummaryArchiveState(
    normalizedData.summaryArchiveState,
    restoredTurnCount,
  );
  const resolvedData = {
    ...normalizedData,
    worldCharacterStatus: normalizedData.worldCharacterStatus ?? worldCharacterStatus,
    kumikoDiary: normalizedData.kumikoDiary ?? autoSavedKumikoDiary,
    dailyFragments: normalizedData.dailyFragments ?? autoSavedDailyFragments,
    psycheState: normalizedData.psycheState === undefined ? autoSavedPsycheState : normalizedData.psycheState,
  };

  isBulkRestoreInProgressRef.current = true;

  try {
    await runBackupRestoreSession(normalizedData,
      id => persistNormalizedBackupData(normalizedData, { rawHistorySyncedIdsRef, forceRawHistoryResyncRef }, id),
      () => {
      if (Array.isArray(normalizedData.messages)) {
        updateMemoryQuerySession(null, { persist: false });
        s.setMessages(normalizedData.messages);
      }
      s.setCoreMemory(normalizedData.coreMemory);
      s.setWorldBook(normalizedData.worldBook);
      s.setContextLimit(normalizedData.contextLimit);
      s.setTurnCount(restoredTurnCount);
      s.setSummaryArchiveState(restoredSummaryArchiveState);
      s.setCurrentEmotion(normalizedData.currentEmotion);
      s.setLocationConfig(normalizedData.locationConfig);
      s.setLanguage(normalizedData.language);
      s.setAnchors(normalizedData.anchors);
      s.setKumikoNotebook(normalizedData.kumikoNotebook);
      s.setRelativeReminders(normalizedData.relativeReminders || []);
      s.setDailyReminders(normalizedData.dailyReminders || []);
      s.setMissedReminders(normalizedData.missedReminders || []);
      s.setBusyFollowUp(null);
      s.setPendingApology(null);
      s.setBusySlotRuntime(null);
      if (normalizedData.worldCharacterStatus !== undefined) {
        setWorldCharacterStatus(normalizedData.worldCharacterStatus);
      }
      if (normalizedData.kumikoDiary !== undefined) {
        setAutoSavedKumikoDiary(normalizedData.kumikoDiary);
      }
      if (normalizedData.dailyFragments !== undefined) {
        setAutoSavedDailyFragments(normalizedData.dailyFragments);
      }
      if (normalizedData.psycheState !== undefined) {
        setAutoSavedPsycheState(normalizedData.psycheState);
      }
      s.setDataLoadError(null);
      s.setIsRagHistoryDirty(!normalizedData.vectors);
    }, deps.mediaHooks, deps.expectedVersion);
    const { synchronizeMemoryMaintenanceGate } = await import('../../services/memoryMaintenanceGate');
    await synchronizeMemoryMaintenanceGate(true);
    // Platform acknowledgements must not hold a completed restore open. Pending
    // cancellations remain visible in TaskPanel and retry after restart.
    void drainReminderNativeCancellations().catch(error => {
      console.warn('[RESTORE] System reminder cancellation remains pending', error);
    });
    return resolvedData;
  } catch (error) {
    if (isDataRestoreBlocked()) {
      s.setDataLoadError('恢复尚未完成，写入已暂停保护数据。请重新启动以继续恢复。');
    } else {
      rawHistorySyncedIdsRef.current = previousSyncedIds;
      forceRawHistoryResyncRef.current = previousForceSync;
    }
    throw error;
  } finally {
    isBulkRestoreInProgressRef.current = isDataRestoreBlocked();
  }
}

// ---------------------------------------------------------------------------
// handleExportBackup
// ---------------------------------------------------------------------------

// Plan 14 Phase B: renderer-side ZIP assembly kept as the web fallback. On
// Electron desktop the main-process builder is authoritative (it scans
// userData directly) and this path only runs on a browser / PWA deployment
// where no main process exists. Kept strictly behind `isDesktopElectron()`
// so the two paths don't drift; every field / folder here must match what
// electron/backup-zip-builder.cjs attaches on the desktop path.
async function buildWebBackupZipBlob(dataJsonString: string): Promise<Blob> {
  const zip = new JSZip();
  zip.file('data.json', new TextEncoder().encode(dataJsonString));

  const imagesFolder = zip.folder('images');
  if (imagesFolder) {
    const allImages = await imageService.getAllImages();
    for (const img of allImages) {
      const match = img.data.match(/^data:(.*);base64,(.*)$/);
      if (match) {
        const base64Data = match[2];
        const ext = match[1].includes('png') ? 'png' : 'jpg';
        imagesFolder.file(`${img.id}.${ext}`, base64Data, { base64: true });
      }
    }
  }

  if (isVoiceServiceAvailable()) {
    try {
      const { listVoiceFiles, loadVoiceFile: loadVF } = await import('../../services/voiceFileService');
      const voiceFiles = await listVoiceFiles();
      if (voiceFiles.length > 0) {
        const voiceFolder = zip.folder('voice');
        if (voiceFolder) {
          for (const vf of voiceFiles) {
            const buf = await loadVF(vf.id);
            if (buf) voiceFolder.file(`${vf.id}.mp3`, buf);
          }
        }
      }
      const { loadRingtoneFileWithName } = await import('../../services/voiceFileService');
      const rtResult = await loadRingtoneFileWithName();
      if (rtResult) {
        const ringtoneFolder = zip.folder('ringtone');
        if (ringtoneFolder) {
          ringtoneFolder.file(rtResult.fileName, rtResult.buffer);
          if (rtResult.displayName && rtResult.displayName !== rtResult.fileName) {
            ringtoneFolder.file('custom.meta.json', new TextEncoder().encode(JSON.stringify({ originalName: rtResult.displayName }, null, 2)));
          }
        }
      }
    } catch (e) {
      console.warn('[EXPORT] Failed to include voice files:', e);
    }
  }

  const result = await zip.generateAsync({ type: 'blob' });
  validateBackupArchive(await JSZip.loadAsync(await result.arrayBuffer()));
  return result;
}

// F2A.5: removed `buildAndroidAutoBackupBlob` (was the consumer of
// `services/androidAutoBackup.ts`). The 4h Android auto-zip mechanism
// had no restore UI and lived inside the app sandbox, so it could not
// protect against uninstall — the only data path it actually saved
// against was an IndexedDB corruption that nobody ever hit. The
// manual `handleExportBackup` flow (above) remains the supported
// "save before uninstall" path on Android, plus the cloud-save hint
// surfaced in BackupSection (F2A.4). PC's electron/auto-zip-backup.cjs
// is unrelated to this helper and remains in place.

export async function handleExportBackup(backupData: any) {
  const version = getDataRestoreVersion();
  try { await withMediaWriteFence(version, () => handleExportBackupOwned(backupData)); }
  catch (error) {
    console.warn('[EXPORT] Backup cancelled because data changed or safe locking is unavailable.', error);
    const language = useAppStore.getState().language;
    void dialogService.alert({ message: language === 'zh' ? '备份已取消：数据正在变化或安全锁不可用。请重试。' : 'Backup cancelled because data changed or safe locking is unavailable. Please retry.', icon: 'error' });
  }
}
async function handleExportBackupOwned(backupData: any) {
  const { captureRuntimeBackupData } = await import('../../services/runtimeBackupSnapshot');
  backupData = await captureRuntimeBackupData(backupData);
  const state = useAppStore.getState();
  const language = state.language;

  try {
    const [vectors, kumikoDiaryExport, dailyFragmentsExport, psycheStateExport, episodesExport, userKnownLocationExport, executionStateExport] = await Promise.all([
      getAllVectors(),
      Promise.resolve(backupData.kumikoDiary),
      Promise.resolve(backupData.dailyFragments),
      Promise.resolve(backupData.psycheState),
      Promise.resolve(backupData.episodes),
      Promise.resolve(backupData.userKnownLocation),
      Promise.resolve(backupData.executionState),
    ]);
    const lightweightBackupData = {
      ...backupData,
      executionState: executionStateExport,
      userKnownLocation: userKnownLocationExport,
      kumikoDiary: undefined,
      dailyFragments: undefined,
      psycheState: undefined,
    };

    const fullBackup = {
      timestamp: Date.now(),
      version: '1.3',
      data: lightweightBackupData,
      vectors,
      kumikoDiary: kumikoDiaryExport,
      dailyFragments: dailyFragmentsExport,
      psycheState: psycheStateExport,
      episodes: episodesExport,
    };
    const jsonString = JSON.stringify(fullBackup, null, 2);
    const protectedBackup = await protectionStatus();
    const defaultFileName = `kumiko_backup_${new Date().toISOString().slice(0, 10)}.${protectedBackup ? 'kab' : 'zip'}`;

    // Desktop: hand off to the main-process shared zip builder via IPC.
    // Main drives the native save dialog + userData media snapshot; we
    // just feed it the serialized JSON string. The renderer-side Dexie
    // images path no longer runs on desktop (userData filesystem is the
    // source of truth there — see backup-zip-builder.cjs header).
    if (isDesktopElectron()) {
      const result = await buildDesktopBackupZip(jsonString, defaultFileName);
      if (result.canceled) {
        // User dismissed the save dialog — silent no-op matches the UX of
        // backup:pick-save-file on every other backup flow.
        return;
      }
      if (!result.success) {
        const detail = result.error ? ` (${result.error})` : '';
        console.error('[EXPORT] Desktop backup zip build failed:', result);
        void dialogService.alert({
          message: (language === 'zh' ? '备份导出失败。' : 'Failed to export backup.') + detail,
          icon: 'error',
        });
        return;
      }
      state.setSystemNotice(language === 'zh' ? '备份导出成功！' : 'Backup exported successfully!');
      return;
    }

    // Capacitor native (Android APK / iOS .ipa): build the zip locally
    // (same buildWebBackupZipBlob helper the dev-server fallback uses —
    // images come from Dexie, voice/ringtone from Dexie via voiceFileService),
    // then write to Capacitor `Directory.Cache` and pop the OS share sheet
    // so the user picks the destination (Files app / Drive / email / etc).
    // No PC dependency — A4 cuts the third bridge to PC. PWA path below
    // is bit-identical to before because PWAs are still PC-companion.
    if (isCapacitorNative()) {
      let blob = await buildWebBackupZipBlob(jsonString);
      if (protectedBackup) {
        const password = getSessionBackupPassword();
        if (!password) throw new Error('Backup password unavailable');
        blob = new Blob([await encryptPortableBackup(new Uint8Array(await blob.arrayBuffer()), password, 'zip')], { type: 'application/octet-stream' });
      }
      const result = await exportBackupZipNative(blob, defaultFileName);
      if (!result.ok) {
        const detail = result.error ? ` (${result.error})` : '';
        console.error('[EXPORT] Capacitor native backup export failed:', result);
        void dialogService.alert({
          message: (language === 'zh' ? '备份导出失败。' : 'Failed to export backup.') + detail,
          icon: 'error',
        });
        return;
      }
      // Cancel from the share sheet still leaves the file in cache → treat
      // as success silently. A normal "shared to <X>" outcome surfaces a
      // toast so the user knows it landed.
      if (result.canceled) {
        state.setSystemNotice(language === 'zh' ? '备份已就绪，可在「文件」中找到。' : 'Backup ready in Files app.');
      } else {
        state.setSystemNotice(language === 'zh' ? '备份导出成功！' : 'Backup exported successfully!');
      }
      return;
    }

    // F2B.3: removed the PWA `httpBackupExport` branch. PWA proxied
    // through PC's /api/backup/export so the phone could pick up
    // userData/images|voice|ringtone server-side. With the bridge gone,
    // any non-Electron / non-Capacitor caller falls through to the
    // renderer-side ZIP build below.

    // Web fallback (no electron, no Capacitor): renderer-side JSZip
    // + file-saver download. Rare — just dev-server previews.
    let content = await buildWebBackupZipBlob(jsonString);
    if (protectedBackup) {
      const password = getSessionBackupPassword();
      if (!password) throw new Error('Backup password unavailable');
      content = new Blob([await encryptPortableBackup(new Uint8Array(await content.arrayBuffer()), password, 'zip')], { type: 'application/octet-stream' });
    }
    saveAs(content, defaultFileName);
    state.setSystemNotice(language === 'zh' ? '备份导出成功！' : 'Backup exported successfully!');
  } catch (e) {
    console.error('Failed to export backup', e);
    void dialogService.alert({
      message: language === 'zh' ? '备份导出失败。' : 'Failed to export backup.',
      icon: 'error',
    });
  }
}

// ---------------------------------------------------------------------------
// handleImportBackup
// ---------------------------------------------------------------------------

export async function handleImportBackup(
  file: File,
  deps: ImportBackupDeps,
): Promise<boolean> {
  if (!file) return false;
  if (isDataRestoreBlocked()) return false;
  const expectedVersion = getDataRestoreVersion();

  const state = useAppStore.getState();
  const language = state.language;
  const flowState = state.flowState;
  const backupConfig = state.backupConfig;

  // v2.14.28 M15: confirm with the user before overwriting live data.
  // Previously the file picker fed straight into the parser and a single
  // mistaken click could replace the entire conversation history. The
  // confirm dialog is suppressed in INTRO/CONFIG screens (true first-run
  // import) where there's no live data at risk yet.
  if (flowState === 'APP') {
    const confirmCopy = language === 'zh'
      ? {
          title: '导入备份会覆盖当前所有数据',
          body: `将从 \"${file.name}\" 导入消息、图片、记忆与世界书等本地状态。这会**完全替换**目前的对话与笔记本，无法恢复。\n\n继续吗？`,
          confirmLabel: '导入并覆盖',
          cancelLabel: '取消',
        }
      : {
          title: 'Importing a backup will replace all current data',
          body: `This will import messages, images, memory and world-book state from "${file.name}", **completely replacing** your current chat history and notebook. The change cannot be undone.\n\nContinue?`,
          confirmLabel: 'Import & replace',
          cancelLabel: 'Cancel',
        };
    let confirmed = false;
    try {
      confirmed = await dialogService.confirm({
        title: confirmCopy.title,
        message: confirmCopy.body,
        confirmText: confirmCopy.confirmLabel,
        cancelText: confirmCopy.cancelLabel,
      });
    } catch (e) {
      console.warn('[IMPORT] confirm dialog rejected unexpectedly:', e);
      return false;
    }
    if (!confirmed) return false;
  }

  try {
    if (file.size > 720 * 1024 * 1024) throw new Error('Backup is too large');
    let jsonStr = '';
    let parsedJson: any = null;
    let importedImages: Array<{ id: string; dataUrl: string }> = [];
    let media: BackupMedia = {};
    const desktopFilePath = isDesktopElectron() ? (file as File & { path?: string }).path : undefined;
    const encrypted = isEncryptedBackup(await file.slice(0, 16).text());
    const password = encrypted ? await dialogService.prompt({ message: language === 'zh' ? '输入该备份的密码。' : 'Enter the password for this backup.', secret: true }) : undefined;
    if (encrypted && !password) return false;
    let importFile: Blob = file;
    let importKind = file.name.toLowerCase().endsWith('.zip') ? 'zip' : 'json';
    if (encrypted && !desktopFilePath) {
      const decoded = await decryptPortableBackup(await file.text(), password!);
      importKind = decoded.kind;
      importFile = new Blob([decoded.bytes as BlobPart]);
    }

    if (desktopFilePath) {
      const parsedResult = await parseDesktopBackupImportFile(desktopFilePath, password || undefined);
      if (!parsedResult.success || !parsedResult.json) {
        throw new Error(parsedResult.error || 'Failed to parse desktop backup import file.');
      }
      parsedJson = parsedResult.json;
      importedImages = parsedResult.images || [];
      media = { voices: parsedResult.voices, ringtone: parsedResult.ringtone };
    } else if (importKind === 'zip') {
      // F2B.3: removed the PWA `httpBackupImport` upload branch. The PC
      // /api/backup/import endpoint is gone; Capacitor + plain web both
      // parse the ZIP locally with JSZip below.
      const zip = await JSZip.loadAsync(importFile);
      const reader = createBackupArchiveReader(zip);
      let dataFile = zip.file('data.json');
      if (!dataFile) {
        dataFile = zip.file('kumiko_backup.json');
        if (dataFile) {
          console.warn('[IMPORT] Legacy auto-backup filename kumiko_backup.json detected; please re-export after loading to migrate.');
        }
      }
      if (!dataFile) {
        throw new Error('data.json not found in ZIP');
      }
      jsonStr = await reader.read(dataFile, 'string');
      parsedJson = JSON.parse(jsonStr);
      getBackupExecutionState(parsedJson);
      const validation = validateBackupImportPayload(parsedJson);
      if (!validation.valid) {
        throw new Error(`Invalid backup payload: ${validation.reason || 'unrecognized structure'}`);
      }

      const imagesFolder = zip.folder('images');
      if (imagesFolder) {
        for (const name of Object.keys(imagesFolder.files).filter(n => n.startsWith('images/') && !imagesFolder.files[n].dir)) {
          const id = name.split('/').pop()?.split('.')[0];
          if (!id) continue;
          const ext = name.split('.').pop()?.toLowerCase();
          const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
          importedImages.push({ id, dataUrl: `data:${mime};base64,${await reader.read(imagesFolder.files[name], 'base64')}` });
        }
      }
      const voiceFolder = zip.folder('voice');
      if (voiceFolder) {
        media.voices = [];
        for (const name of Object.keys(voiceFolder.files).filter(n => n.startsWith('voice/') && !voiceFolder.files[n].dir && /\.mp3$/i.test(n))) {
          const id = name.split('/').pop()?.replace(/\.mp3$/i, '');
          if (id) media.voices.push({ id, base64: await reader.read(voiceFolder.files[name], 'base64') });
        }
      }
      const ringtoneFolder = zip.folder('ringtone');
      if (ringtoneFolder) {
        const audio = Object.keys(ringtoneFolder.files).filter(n => n.startsWith('ringtone/') && !ringtoneFolder.files[n].dir && /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(n));
        if (audio.length > 1) throw new Error('Backup has multiple custom ringtones');
        if (audio.length) {
          const meta = ringtoneFolder.file('custom.meta.json');
          const parsed = meta ? JSON.parse(await reader.read(meta, 'string')) : null;
          media.ringtone = { base64: await reader.read(ringtoneFolder.files[audio[0]], 'base64'), ext: audio[0].split('.').pop()!, originalName: parsed?.originalName || audio[0].split('/').pop() };
        }
      }
    } else {
      jsonStr = await importFile.text();
    }

    await yieldToMainThread();
    const json = parsedJson ?? JSON.parse(jsonStr);
    getBackupExecutionState(json);
    const validation = validateBackupImportPayload(json);
    if (!validation.valid) {
      throw new Error(`Invalid backup payload: ${validation.reason || 'unrecognized structure'}`);
    }

    // P0 #2 (Plan 2): detect degraded auto-backups. _autoZipMeta is stamped at
    // the root of data.json by electron-main's before-quit handler. Manual
    // exports and pre-Plan-2 auto-backups do not include it; absence is treated
    // as "assume fully complete" to stay backward-compatible.
    const autoZipMeta = json?._autoZipMeta as AutoZipMeta | undefined;
    let autoZipDegradedMessage: string | null = null;
    if (autoZipMeta && typeof autoZipMeta === 'object') {
      const {
        hasImages,
        imagesIncludedCount,
        imagesTotalCount,
        imagesErrorReason,
      } = autoZipMeta;
      const isPartial =
        typeof imagesIncludedCount === 'number' &&
        typeof imagesTotalCount === 'number' &&
        imagesIncludedCount < imagesTotalCount;
      if (hasImages === false || isPartial) {
        const reasonSuffix = imagesErrorReason ? `（${imagesErrorReason}）` : '';
        const reasonSuffixEn = imagesErrorReason ? ` (${imagesErrorReason})` : '';
        autoZipDegradedMessage = language === 'zh'
          ? `已导入降级自动备份：图片不完整${reasonSuffix}，其余数据已恢复。`
          : `Imported a degraded auto-backup: images are incomplete${reasonSuffixEn}; other data was restored.`;
        console.warn('[IMPORT] Auto-backup ZIP is degraded:', autoZipMeta);
      }
    }


    if (isDataRestoreBlocked() || getDataRestoreVersion() !== expectedVersion) throw new Error('Data changed while the backup was being prepared.');
    const restoredData = await deps.restoreParsedBackupPayload(json, importedImages, media, expectedVersion);
    if (restoredData) {
      deps.updateBaseline(json.timestamp || Date.now(), restoredData);
      if (flowState === 'APP') {
        state.setSystemNotice(language === 'zh' ? '备份恢复成功！' : 'Backup restored successfully!');
      }
      if (restoredData.__missingMediaCount > 0) {
        const count = restoredData.__missingMediaCount;
        state.setSystemNotice(language === 'zh'
          ? `备份已恢复，但有 ${count} 个图片或语音附件缺失，相关记录无法显示或播放附件。`
          : `Backup restored, but ${count} image or voice attachments are missing.`);
      } else if (autoZipDegradedMessage) {
        state.setSystemNotice(autoZipDegradedMessage);
      }
      return true;
    } else {
      if (flowState === 'APP') {
        void dialogService.alert({
          message: language === 'zh' ? '恢复备份失败：文件格式无效。' : 'Failed to restore backup: Invalid file format.',
          icon: 'error',
        });
      }
      return false;
    }
  } catch (e) {
    console.error('Failed to import backup', e);
    void dialogService.alert({
      message: e instanceof Error && /Wrong backup password or corrupted backup/i.test(e.message)
        ? (language === 'zh' ? '密码错误或备份已损坏，当前数据没有更改。' : 'Wrong password or corrupted backup. Current data was not changed.')
        : (language === 'zh' ? '导入备份失败，请检查备份文件和存储空间后重试。' : 'Backup import failed. Check the backup file and available storage, then retry.'),
      icon: 'error',
    });
    return false;
  }
}

// handleCloudRestore removed — cloud sync feature was deprecated and removed (P0 #6).
