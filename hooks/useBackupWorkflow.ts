import { useCallback, useEffect, useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import {
  buildBackupData,
  validateBackupData,
} from '../components/app/backupData';
import {
  normalizeBackupData as normalizeBackupDataAction,
  persistNormalizedBackupData as persistNormalizedBackupDataAction,
  restoreBackupData as restoreBackupDataAction,
} from '../components/app/backupActions';
import { yieldToMainThread } from '../components/app/appUtils';
import { LOCAL_BACKUP_PATH_STORAGE_KEY } from '../components/app/appConstants';
import { DEFAULT_WORLD_BOOK, LOCALIZED_WORLD_BOOK } from '../constants';
import { imageService } from '../services/imageService';
import {
  getDesktopBackupFileInfo,
  isDesktopElectron,
  writeDesktopBackupFile,
} from '../services/desktopBackupService';
import { isMobilePwa } from '../services/environment';
import { httpInvoke } from '../services/httpApi';
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
  updateMemoryQuerySession: (next: MemoryQuerySession | null) => void;
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
  restoreBackupData: (backup: any) => Promise<any>;
  restoreParsedBackupPayload: (
    backupJson: any,
    importedImages?: Array<{ id: string; dataUrl: string }>,
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

  // Phase 6 Part C4: mobile PWA counterpart of the desktop auto-reconnect
  // above. Mobile cannot call `backup:get-file-info` (not on the HTTP
  // allowlist), so we re-validate the previously selected desktop path via
  // the sandboxed `fs:check-path-exists` channel. The LOCAL_BACKUP_PATH_STORAGE_KEY
  // here is the PHONE's localStorage (each device remembers its own last
  // target); the PC renderer remembers its own handle independently.
  useEffect(() => {
    if (!isDataLoaded || !isMobilePwa()) return;

    let isCancelled = false;

    const restoreMobileBackupConnection = async () => {
      try {
        const savedPath = localStorage.getItem(LOCAL_BACKUP_PATH_STORAGE_KEY);
        if (!savedPath) return;

        const res: any = await httpInvoke('fs:check-path-exists', { path: savedPath });
        if (isCancelled) return;

        if (res && res.ok && res.exists && res.isFile) {
          fileHandleRef.current = savedPath;
          setConnectedFileName(savedPath.split(/[\\/]/).pop() || savedPath);
          return;
        }

        clearLocalFileConnection();
      } catch (error) {
        console.warn('[LOCAL BACKUP] Failed to restore mobile backup connection:', error);
        if (!isCancelled) {
          clearLocalFileConnection();
        }
      }
    };

    restoreMobileBackupConnection();

    return () => {
      isCancelled = true;
    };
  }, [clearLocalFileConnection, isDataLoaded]);

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
      const backupContent = { timestamp: Date.now(), version: "1.3", data };
      const serializedContent = JSON.stringify(backupContent, null, 2);

      if (isMobilePwa() && typeof handle === 'string') {
        // Phase 6 Part C4: mobile PWAs never touch the PC filesystem
        // directly. They call `backup:write-desktop-file`, which
        // resolves the path through mobileBrowseRoot (electron/mobile-fs.cjs)
        // and writes on the desktop. Any path escaping the sandbox is
        // rejected with E_OUT_OF_ROOT on the PC side.
        const res: any = await httpInvoke('backup:write-desktop-file', {
          path: handle,
          contentText: serializedContent,
        });
        if (!res || !res.ok) {
          throw new Error(res?.error || 'Failed to write desktop backup file from mobile.');
        }
      } else if (isDesktopElectron() && typeof handle === 'string') {
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

  return {
    backupData,
    validateSaveData,
    clearLocalFileConnection,
    performFileSave,
    restoreBackupData,
    restoreParsedBackupPayload,
  };
}
