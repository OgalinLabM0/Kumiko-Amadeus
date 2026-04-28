import React from 'react';
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
} from './messageMappers';
import {
  recalculateTurnCountFromMessages,
  sanitizeRelativeReminderRecord,
  sanitizeDailyReminderRecord,
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
import { syncTemporalEpisodes } from '../../services/temporalEpisodeService';
import { imageService } from '../../services/imageService';
import {
  isVoiceServiceAvailable,
} from '../../services/voiceFileService';
import {
  getAllVectors,
  restoreVectors,
} from '../../services/localRagService';
import { RAG_HISTORY_DIRTY_STORAGE_KEY } from '../../store/slices/ragSlice';
import type { RelativeReminder, DailyReminder } from '../../store/slices/reminderSlice';
import { RELATIVE_REMINDER_STORAGE_KEY, DAILY_REMINDER_STORAGE_KEY } from '../../store/slices/reminderSlice';
import {
  SUMMARY_ARCHIVE_STATE_STORAGE_KEY,
} from './appConstants';

// ---------------------------------------------------------------------------
// Shared dep interfaces
// ---------------------------------------------------------------------------

export interface PersistBackupRefs {
  rawHistorySyncedIdsRef: React.MutableRefObject<Set<string>>;
  forceRawHistoryResyncRef: React.MutableRefObject<boolean>;
}

export interface RestoreBackupDeps {
  isBulkRestoreInProgressRef: React.MutableRefObject<boolean>;
  rawHistorySyncedIdsRef: React.MutableRefObject<Set<string>>;
  forceRawHistoryResyncRef: React.MutableRefObject<boolean>;
  updateMemoryQuerySession: (next: unknown) => void;
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
  ) => Promise<any>;
  updateBaseline: (ts: number, data?: any) => void;
}

// ---------------------------------------------------------------------------
// normalizeBackupData
// ---------------------------------------------------------------------------

export function normalizeBackupData(source: any) {
  const state = useAppStore.getState();
  const language = state.language;

  const root = source.data || source;
  const targetMessages = root.messages || source.messages || (source.data && source.data.messages) || [];
  const normalizedBackupMessages = normalizeImportedBackupMessages(
    Array.isArray(targetMessages) ? targetMessages : []
  );
  if (
    normalizedBackupMessages.stats.coercedTimestampCount > 0
    || normalizedBackupMessages.stats.droppedCount > 0
  ) {
    console.warn('[RESTORE] Backup message normalization adjusted imported history.', normalizedBackupMessages.stats);
  }

  const currentLang = root.language || language;

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

  const normalizedTurnCount = typeof root.turnCount === 'number' ? root.turnCount : 0;
  const normalizedSummaryArchiveState = normalizeSummaryArchiveState(root.summaryArchiveState, normalizedTurnCount);
  const normalizedCoreMemory = resolveCoreMemoryFromSummaryArchive(
    normalizedSummaryArchiveState,
    root.coreMemory || '',
  );
  const hasWorldCharacterStatus = root.worldCharacterStatus !== undefined || source.worldCharacterStatus !== undefined;
  const hasKumikoDiary = root.kumikoDiary !== undefined || source.kumikoDiary !== undefined;
  const hasDailyFragments = root.dailyFragments !== undefined || source.dailyFragments !== undefined;
  const hasPsycheState = root.psycheState !== undefined || source.psycheState !== undefined;
  const hasEpisodes = root.episodes !== undefined || source.episodes !== undefined;

  return {
    messages: normalizedBackupMessages.messages,
    coreMemory: normalizedCoreMemory,
    worldBook: finalWorldBook,
    contextLimit: root.contextLimit || 100,
    turnCount: normalizedTurnCount,
    summaryArchiveState: normalizedSummaryArchiveState,
    currentEmotion: root.currentEmotion || 'neutral',
    locationConfig: root.locationConfig || DEFAULT_LOCATION_CONFIG,
    language: currentLang,
    anchors: root.anchors || [],
    kumikoNotebook: root.kumikoNotebook || '',
    relativeReminders: Array.isArray(root.relativeReminders)
      ? root.relativeReminders.map(sanitizeRelativeReminderRecord).filter(Boolean)
      : [],
    dailyReminders: Array.isArray(root.dailyReminders)
      ? root.dailyReminders.map(sanitizeDailyReminderRecord).filter(Boolean)
      : [],
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
) {
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

  await syncRawHistoryMessages(normalizedMessages, { forceFull: true });
  if (Array.isArray(normalizedData.episodes)) {
    await db.episodes.clear();
    if (normalizedData.episodes.length > 0) {
      await db.episodes.bulkPut(normalizedData.episodes);
    }
  } else {
    await syncTemporalEpisodes(normalizedMessages);
  }
  refs.rawHistorySyncedIdsRef.current = new Set(normalizedMessages.map((message: Message) => message.id));
  refs.forceRawHistoryResyncRef.current = false;
  await yieldToMainThread();

  // v2.14.28 M16: wrap the rest of the backup-restore writes in one
  // Dexie transaction so a partial failure (e.g. quota exhaustion mid-
  // bulkPut) rolls back instead of leaving the keyval row updated but
  // diary/psyche tables half-cleared. The earlier syncRawHistoryMessages
  // / syncTemporalEpisodes calls live outside this transaction because
  // they manage their own internal sync state and would deadlock if
  // nested.
  await db.transaction('rw', db.kumikoDiary, db.dailyFragments, db.psycheState, db.keyval, async () => {
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
    ];

    if (normalizedData.worldCharacterStatus !== undefined) {
      keyvalRows.push({ key: 'world_character_status', value: normalizedData.worldCharacterStatus });
    }

    await db.keyval.bulkPut(keyvalRows);
  });
}

// ---------------------------------------------------------------------------
// restoreBackupData
// ---------------------------------------------------------------------------

export async function restoreBackupData(
  backup: any,
  deps: RestoreBackupDeps,
) {
  if (!backup) return null;

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

  console.log('[RESTORE] Normalizing backup data summary:', summarizeBackupPayloadForLog(backup));
  const normalizedData = normalizeBackupData(backup);
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
    await yieldToMainThread();

    React.startTransition(() => {
      if (Array.isArray(normalizedData.messages)) {
        forceRawHistoryResyncRef.current = true;
        rawHistorySyncedIdsRef.current = new Set();
        updateMemoryQuerySession(null);
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
    });

    await yieldToMainThread(2);
    await persistNormalizedBackupData(normalizedData, { rawHistorySyncedIdsRef, forceRawHistoryResyncRef });
    return resolvedData;
  } finally {
    isBulkRestoreInProgressRef.current = false;
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
  zip.file('data.json', dataJsonString);

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
            ringtoneFolder.file('custom.meta.json', JSON.stringify({ originalName: rtResult.displayName }, null, 2));
          }
        }
      }
    } catch (e) {
      console.warn('[EXPORT] Failed to include voice files:', e);
    }
  }

  return zip.generateAsync({ type: 'blob' });
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
  const state = useAppStore.getState();
  const language = state.language;

  try {
    const [vectors, kumikoDiaryExport, dailyFragmentsExport, psycheStateExport, episodesExport] = await Promise.all([
      getAllVectors(),
      db.kumikoDiary.orderBy('date').toArray(),
      db.dailyFragments.orderBy('timestamp').toArray(),
      db.psycheState.get('current'),
      db.episodes.orderBy('startTimestamp').toArray(),
    ]);
    const lightweightBackupData = {
      ...backupData,
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
    const defaultFileName = `kumiko_backup_${new Date().toISOString().slice(0, 10)}.zip`;

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
      const blob = await buildWebBackupZipBlob(jsonString);
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
    const content = await buildWebBackupZipBlob(jsonString);
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
    let jsonStr = '';
    let parsedJson: any = null;
    let importedImages: Array<{ id: string; dataUrl: string }> = [];
    const desktopFilePath = isDesktopElectron() ? (file as File & { path?: string }).path : undefined;

    if (desktopFilePath) {
      const parsedResult = await parseDesktopBackupImportFile(desktopFilePath);
      if (!parsedResult.success || !parsedResult.json) {
        throw new Error(parsedResult.error || 'Failed to parse desktop backup import file.');
      }
      parsedJson = parsedResult.json;
      importedImages = parsedResult.images || [];
    } else if (file.name.endsWith('.zip')) {
      // F2B.3: removed the PWA `httpBackupImport` upload branch. The PC
      // /api/backup/import endpoint is gone; Capacitor + plain web both
      // parse the ZIP locally with JSZip below.
      const zip = await JSZip.loadAsync(file);
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
      jsonStr = await dataFile.async('string');

      const imagesFolder = zip.folder('images');
      if (imagesFolder) {
        const imageFiles = Object.keys(imagesFolder.files).filter(name => !imagesFolder.files[name].dir);
        for (let imageIndex = 0; imageIndex < imageFiles.length; imageIndex += 1) {
          const imgName = imageFiles[imageIndex];
          const imgFile = imagesFolder.files[imgName];
          const base64Data = await imgFile.async('base64');
          const ext = imgName.split('.').pop()?.toLowerCase();
          const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
          const dataUrl = `data:${mimeType};base64,${base64Data}`;

          const id = imgName.split('/').pop()?.split('.')[0];
          if (id) {
            await imageService.saveImageWithId(id, dataUrl);
          }

          if ((imageIndex + 1) % 8 === 0) {
            await yieldToMainThread();
          }
        }
      }

      if (isVoiceServiceAvailable()) {
        try {
          const { saveVoiceFile: saveVF, saveRingtoneFile: saveRT } = await import('../../services/voiceFileService');
          const voiceFolder = zip.folder('voice');
          if (voiceFolder) {
            const voiceFileKeys = Object.keys(voiceFolder.files).filter(n => !voiceFolder.files[n].dir && n.endsWith('.mp3'));
            for (const vfName of voiceFileKeys) {
              const buf = await voiceFolder.files[vfName].async('arraybuffer');
              const id = vfName.split('/').pop()?.replace(/\.mp3$/, '');
              if (id) await saveVF(id, buf);
            }
          }
          const ringtoneFolder = zip.folder('ringtone');
          if (ringtoneFolder) {
            const rtAudioKey = Object.keys(ringtoneFolder.files).find(n => {
              if (ringtoneFolder.files[n].dir) return false;
              return /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(n);
            });
            if (rtAudioKey) {
              const buf = await ringtoneFolder.files[rtAudioKey].async('arraybuffer');
              const ext = rtAudioKey.split('.').pop() || 'mp3';
              let originalName: string | undefined;
              const metaFile = ringtoneFolder.file('custom.meta.json');
              if (metaFile) {
                try {
                  const parsedMeta = JSON.parse(await metaFile.async('string'));
                  if (typeof parsedMeta?.originalName === 'string' && parsedMeta.originalName.trim()) {
                    originalName = parsedMeta.originalName.trim();
                  }
                } catch {
                  // Ignore malformed ringtone metadata in imported backups.
                }
              }
              await saveRT(buf, ext, originalName || rtAudioKey.split('/').pop());
            }
          }
        } catch (e) {
          console.warn('[IMPORT] Failed to restore voice files:', e);
        }
      }
    } else {
      jsonStr = await file.text();
    }

    await yieldToMainThread();
    const json = parsedJson ?? JSON.parse(jsonStr);

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

    if (!file.name.endsWith('.zip') && !desktopFilePath?.endsWith('.zip')) {
      const dataToRestore = json.data || json;
      const msgs = dataToRestore.messages || [];
      const voiceCount = msgs.filter((m: any) => m.isVoiceMessage).length;

      if (voiceCount > 0 && isVoiceServiceAvailable()) {
        const { listVoiceFiles } = await import('../../services/voiceFileService');
        const voiceFiles = await listVoiceFiles();
        if (voiceFiles.length === 0) {
          const confirmMsg = language === 'zh'
            ? `检测到您的备份包含 ${voiceCount} 条语音记录，但当前数据目录中没有音频文件。导入后语音将无法播放。\n\n建议您导入完整的 ZIP 备份，或稍后手动将音频文件放入数据目录。\n\n是否继续仅导入文本？`
            : `Your backup contains ${voiceCount} voice messages, but no audio files were found in the current data directory. Voices will not play after import.\n\nIt is recommended to import a full ZIP backup, or manually place the audio files in the data directory later.\n\nContinue importing text only?`;

          const proceed = await dialogService.confirm({
            message: confirmMsg,
            variant: 'danger',
          });
          if (!proceed) {
            return false;
          }
        }
      }
    }

    const restoredData = await deps.restoreParsedBackupPayload(json, importedImages);
    if (restoredData) {
      // Plan 14 Phase A (P2 #6 Phase 2 finale): hydrate any legacy inline
      // `message.image` that still ships in an older backup JSON into the
      // `imageId` + file-store pipeline. Runtime code no longer reads
      // `message.image` at all (MessageEntity dropped the field in Dexie
      // V11), so this pass is the only place that legacy inline data can
      // survive an import — and it must run before autosave or
      // mapMessageToEntity sees the messages, otherwise the inline payload
      // is silently discarded with no image rendered.
      //
      // Failure mode on individual hydrate errors: the message loses its
      // image entirely (no imageId, no inline). This is acceptable because
      // the alternative — keeping the inline field alive just for the UI —
      // reintroduces exactly the dual-shape problem Phase 2 just removed.
      try {
        const legacyInlineMessages = Array.isArray(restoredData.messages)
          ? restoredData.messages.filter((m: any) => m?.image && !m?.imageId)
          : [];
        if (legacyInlineMessages.length > 0) {
          const hydratedIds = new Map<string, string>();
          for (const m of legacyInlineMessages) {
            try {
              const newId = `img_legacy_${m.id}`;
              await imageService.saveImageWithId(newId, m.image);
              hydratedIds.set(m.id, newId);
            } catch (err) {
              console.warn('[IMPORT] Inline image hydrate failed for', m.id, err);
            }
          }
          // Clear `image` on every legacy row (hydrated or not) so nothing
          // downstream ever observes the transient shape.
          const legacyIds = new Set(legacyInlineMessages.map((m: any) => m.id));
          state.setMessages(prev => prev.map(m => {
            if (!legacyIds.has(m.id)) return m;
            const newId = hydratedIds.get(m.id);
            return newId
              ? { ...m, imageId: newId, image: undefined }
              : { ...m, image: undefined };
          }));
          if (hydratedIds.size > 0) {
            console.log(`[IMPORT] Hydrated ${hydratedIds.size} legacy inline image(s) into imageId.`);
          }
        }
      } catch (hydrateErr) {
        console.warn('[IMPORT] Inline image hydrate pass failed:', hydrateErr);
      }

      if (json.vectors) {
        await yieldToMainThread();
        // P1 #13 follow-up (Plan 4): restoreVectors now returns a structured
        // result. Surface partial/failed restores via a non-blocking notice so
        // the user can choose to rebuild the memory bank from the UI. Restore
        // continues regardless.
        const restoreResult = await restoreVectors(json.vectors);
        if (!restoreResult?.ok) {
          console.warn('[IMPORT] RAG vectors restore was partial or failed:', restoreResult);
          state.setSystemNotice(
            language === 'zh'
              ? 'RAG 向量恢复不完整，可手动重建记忆库以补齐。'
              : 'RAG vectors restore was partial. You can manually rebuild the memory bank to refill.'
          );
        }
        state.setRagDirtyNoticeShown(false);
        state.setIsRagHistoryDirty(false);
      } else if (backupConfig.ragEnabled && Array.isArray(restoredData.messages) && restoredData.messages.length > 0) {
        state.setIsRagHistoryDirty(true);
        console.warn('[LOCAL RAG] Imported backup restored messages without vector snapshots. Rebuild recommended.');
      }
      deps.updateBaseline(json.timestamp || Date.now(), restoredData);
      if (flowState === 'APP') {
        state.setSystemNotice(language === 'zh' ? '备份恢复成功！' : 'Backup restored successfully!');
      }
      if (autoZipDegradedMessage) {
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
    if (flowState === 'APP') {
      void dialogService.alert({
        message: language === 'zh' ? '导入备份失败：不是有效的 JSON 或 ZIP 文件。' : 'Failed to import backup: Not a valid JSON or ZIP file.',
        icon: 'error',
      });
    }
    return false;
  }
}

// handleCloudRestore removed — cloud sync feature was deprecated and removed (P0 #6).
