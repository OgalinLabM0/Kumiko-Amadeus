import { useCallback, useEffect, useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getUserKnownLocation } from '../services/userKnownLocation';
import { exportTurnExecutionState, getBackupExecutionState } from '../services/turnStateBackup';
import { db } from '../services/db';
import { protectSessionJson } from '../services/backupProtection';
import { getDataRestoreVersion, isDataRestoreBlocked } from '../services/dataRestoreGate';
import { withMediaWriteFence } from '../services/mediaWriteFence';
import {
  buildBackupData,
  validateBackupData,
} from '../components/app/backupData';
import {
  normalizeBackupData as normalizeBackupDataAction,
  persistNormalizedBackupData as persistNormalizedBackupDataAction,
  restoreBackupData as restoreBackupDataAction,
} from '../components/app/backupActions';
import { validateBackupImportPayload } from '../components/app/backupImportValidation';
import { yieldToMainThread } from '../components/app/appUtils';
import { LOCAL_BACKUP_PATH_STORAGE_KEY } from '../components/app/appConstants';
import { DEFAULT_WORLD_BOOK, LOCALIZED_WORLD_BOOK } from '../constants';
import { prepareBackupMedia, type BackupMedia } from '../services/backupMediaStaging';
import {
  getDesktopBackupFileInfo,
  isDesktopElectron,
  writeDesktopBackupFile,
} from '../services/desktopBackupService';
// F2B.3: dropped `isMobilePwa` + `httpInvoke` imports. Mobile-PWA
// auto-reconnect path used `fs:check-path-exists` over the PC bridge
// (now gone), and `performFileSave`'s mobile branch wrote via
// `backup:write-desktop-file` (also gone). On Capacitor the LOCAL
// backup tab is hidden in F2A.4.
import type {
  DailyFragmentEntity,
  KumikoDiaryEntity,
  PsycheStateEntity,
  WorldCharacterStatusMap,
} from '../services/db';
import type {
  AnchorEntry,
  EmotionType,
  Language,
  LocationConfig,
  MemoryQuerySession,
  Message,
  SummaryArchiveState,
  WorldBookEntry,
} from '../types';
import type { RelativeReminder, DailyReminder } from '../store/slices/reminderSlice';

export interface UseBackupWorkflowParams {
  // Refs that span the restore / persist lifecycle.
  rawHistorySyncedIdsRef: MutableRefObject<Set<string>>;
  forceRawHistoryResyncRef: MutableRefObject<boolean>;
  isBulkRestoreInProgressRef: MutableRefObject<boolean>;
  fileHandleRef: MutableRefObject<any>;

  // Bootstrap gating.
  isDataLoaded: boolean;

  // State + setters for restore targets.
  updateMemoryQuerySession: (next: MemoryQuerySession | null, options?: { persist?: boolean }) => void;
  setConnectedFileName: (name: string | null) => void;
  setWorldCharacterStatus: Dispatch<SetStateAction<WorldCharacterStatusMap>>;
  setAutoSavedKumikoDiary: Dispatch<SetStateAction<KumikoDiaryEntity[]>>;
  setAutoSavedDailyFragments: Dispatch<SetStateAction<DailyFragmentEntity[]>>;
  setAutoSavedPsycheState: Dispatch<SetStateAction<PsycheStateEntity | null>>;

  // Current snapshots consumed by restoreBackupData deps.
  worldCharacterStatus: WorldCharacterStatusMap;
  autoSavedKumikoDiary: KumikoDiaryEntity[];
  autoSavedDailyFragments: DailyFragmentEntity[];
  autoSavedPsycheState: PsycheStateEntity | null;

  // Everything buildBackupData / validateBackupData depend on.
  messages: Message[];
  coreMemory: string;
  worldBook: WorldBookEntry[];
  contextLimit: number;
  turnCount: number;
  summaryArchiveState: SummaryArchiveState;
  currentEmotion: EmotionType;
  locationConfig: LocationConfig;
  language: Language;
  anchors: AnchorEntry[];
  kumikoNotebook: string;
  relativeReminders: RelativeReminder[];
  dailyReminders: DailyReminder[];
}

export interface UseBackupWorkflowReturn {
  backupData: ReturnType<typeof buildBackupData>;
  validateSaveData: (data: ReturnType<typeof buildBackupData>) => boolean;
  clearLocalFileConnection: () => void;
  performFileSave: (handle: any, data: any) => Promise<boolean>;
  restoreBackupData: (backup: any, mediaHooks?: Awaited<ReturnType<typeof prepareBackupMedia>>['hooks'], expectedVersion?: string) => Promise<any>;
  restoreParsedBackupPayload: (
    backupJson: any,
    importedImages?: Array<{ id: string; dataUrl: string }>,
    media?: BackupMedia,
    expectedVersion?: string,
  ) => Promise<any>;
}

export function useBackupWorkflow(params: UseBackupWorkflowParams): UseBackupWorkflowReturn {
  const {
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
  } = params;

  const userKnownLocation = useLiveQuery(getUserKnownLocation, []);
  // Observe invalidation cheaply. Large histories are exported only by the
  // save task, so an export failure cannot escape through React rendering.
  const executionRevision = useLiveQuery(async () => { await db.keyval.count(); return Date.now(); }, []);
  const backupData = useMemo(() => buildBackupData({
    executionRevision,
    userKnownLocation,
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
    executionRevision,
    userKnownLocation,
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

  // F2B.3: removed the Phase 6 mobile-PWA auto-reconnect effect. It used
  // `fs:check-path-exists` over the PC HTTP bridge to revalidate the
  // selected desktop path on phone boot. With the PWA bridge gone, this
  // path no longer exists; Capacitor APK has no LOCAL backup tab at all.

  // --- REFINED DATA NORMALIZATION (Business Logic for Restore) ---
  // Implements "Smart Merge" logic:
  // 1. Always fetches fresh official lore from code (Baseline).
  // 2. Merges user settings (Active/Priority) from backup if available.
  // 3. If backup is empty or missing an item, keeps the default official item intact.
  // 4. Preserves custom user entries.
  const normalizeBackupData = useCallback((source: any) => {
    return normalizeBackupDataAction(source);
  }, [language]);

  const performFileSave = async (handle: any, data: any) => {
    try {
      const version = getDataRestoreVersion();
      const { captureRuntimeBackupData } = await import('../services/runtimeBackupSnapshot');
      const freshData = await captureRuntimeBackupData(data);
      const backupContent = { timestamp: Date.now(), version: "1.3", data: freshData };
      const serializedContent = JSON.stringify(backupContent, null, 2);

      // F2B.3: removed the `isMobilePwa() && typeof handle === 'string'`
      // branch (was `backup:write-desktop-file` over the PC HTTP bridge).
      await withMediaWriteFence(version, async () => {
      if (isDesktopElectron() && typeof handle === 'string') {
        const result = await writeDesktopBackupFile(handle, serializedContent);
        if (!result.success) {
          throw new Error(result.error || 'Failed to write desktop backup file.');
        }
      } else {
        const protectedContent = await protectSessionJson(serializedContent, handle);
        const writable = await handle.createWritable();
        await writable.write(protectedContent);
        await writable.close();
      }
      });

      return true;
    } catch (e) {
      console.warn("Manual save write failed:", e);
      // Preparation/validation failure must preserve the known backup target
      // and its last good contents; the user can retry after fixing the cause.
      return false;
    }
  };

  const persistNormalizedBackupData = useCallback(async (normalizedData: any) => {
    return persistNormalizedBackupDataAction(normalizedData, { rawHistorySyncedIdsRef, forceRawHistoryResyncRef });
  }, []);

  const restoreBackupData = useCallback(async (backup: any, mediaHooks?: Awaited<ReturnType<typeof prepareBackupMedia>>['hooks'], expectedVersion?: string) => {
    return restoreBackupDataAction(backup, {
      mediaHooks,
      expectedVersion,
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
    importedImages: Array<{ id: string; dataUrl: string }> = [],
    media: BackupMedia = {},
    expectedVersion = getDataRestoreVersion(),
  ) => {
    try { getBackupExecutionState(backupJson); } catch {
      console.warn('[RESTORE] Parsed backup rejected: invalid execution state.');
      return null;
    }
    const validation = validateBackupImportPayload(backupJson);
    if (!validation.valid) {
      console.warn('[RESTORE] Parsed backup rejected before media writes:', validation.reason);
      return null;
    }

    const { applyMemoryCorrectionsToBackup, filterCorrectedBackupMedia, inspectBackupMemoryAssets, inspectUnreferencedBackupMedia } = await import('../services/memoryCorrectionBackup');
    const unverified = await inspectBackupMemoryAssets(backupJson);
    const orphans = await inspectUnreferencedBackupMedia(backupJson, importedImages, media);
    if (orphans.images.length || orphans.voices.length) {
      const { dialogService } = await import('../services/dialogService');
      const confirmed = await dialogService.confirm({
        title: language === 'zh' ? '备份中有无法追溯的媒体' : 'Untraceable backup media',
        message: language === 'zh' ? `有 ${orphans.images.length} 张图片和 ${orphans.voices.length} 段语音没有可核对的消息或来源，可能是导入中断或未发送草稿留下的副本。为防止旧内容恢复，需要排除这些文件后导入；现有有效消息引用的媒体保留。是否继续？` : `${orphans.images.length} images and ${orphans.voices.length} voice files have no verifiable message or source. They may include drafts or interrupted imports. Exclude these files to preserve memory corrections and continue? Media referenced by valid messages is retained.`,
        confirmText: language === 'zh' ? '排除这些文件并继续' : 'Exclude these files and continue',
        cancelText: language === 'zh' ? '取消导入' : 'Cancel import',
      });
      if (!confirmed) return null;
    }
    if (unverified.length) {
      const { dialogService } = await import('../services/dialogService');
      const confirmed = await dialogService.confirm({
        title: language === 'zh' ? '旧备份有无法核对来源的记忆' : 'This backup contains unverified memory',
        message: language === 'zh' ? `当前清理记录要求防止旧内容回来。以下项目缺少足够来源，需要在导入时清空：\n${unverified.map(item => item.field).join('、')}\n其余有效原始记录保留。是否按此范围导入？` : `To preserve existing corrections, these unverified memory fields must be removed during import:\n${unverified.map(item => item.field).join(', ')}\nOther valid originals are retained. Continue?`,
        confirmText: language === 'zh' ? '清除这些项目并导入' : 'Remove these fields and import',
        cancelText: language === 'zh' ? '取消' : 'Cancel',
      });
      if (!confirmed) return null;
    }
    const filtered = await applyMemoryCorrectionsToBackup(backupJson, { allowUnverifiedAssetRemoval: unverified.length > 0 });
    const safeMedia = filterCorrectedBackupMedia(filtered, importedImages, media, orphans);
    const prepared = await prepareBackupMedia(filtered, safeMedia.images, safeMedia.media);
    try {
      if (isDataRestoreBlocked() || getDataRestoreVersion() !== expectedVersion) throw new Error('Data changed while the backup was being prepared.');
      const restored = await restoreBackupData(prepared.json, prepared.hooks, expectedVersion);
      return restored ? { ...restored, __missingMediaCount: prepared.missingMediaCount } : restored;
    } finally { await prepared.releaseVoiceLeases(); }
  }, [restoreBackupData]);

  return {
    backupData,
    validateSaveData,
    clearLocalFileConnection,
    performFileSave,
    restoreBackupData,
    restoreParsedBackupPayload,
  };
}
