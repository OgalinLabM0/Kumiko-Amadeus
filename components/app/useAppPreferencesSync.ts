import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { BackupConfig, EmotionType, Language, TtsConfig } from '../../types';
import { db } from '../../services/db';
import { isDesktopElectron } from '../../services/desktopBackupService';
import { DEFAULT_TTS_CONFIG, UI_TRANSLATIONS } from '../../constants';
import { isBuiltInRingtoneId, isCustomRingtoneId } from '../../services/voiceFileService';
import { RAG_HISTORY_DIRTY_STORAGE_KEY, type RagStatusValue } from '../../store/slices/ragSlice';

export interface UseAppPreferencesSyncInput {
  isDataLoaded: boolean;
  isBulkRestoreInProgressRef: MutableRefObject<boolean>;
  currentEmotion: EmotionType;
  autoZipEnabled: boolean;
  setAutoZipEnabled: (v: boolean) => void;
  ttsConfig: TtsConfig;
  setTtsConfig: (v: TtsConfig) => void;
  backupConfig: BackupConfig;
  ragStatus: RagStatusValue;
  setRagStatus: (v: RagStatusValue | ((prev: RagStatusValue) => RagStatusValue)) => void;
  setRagProgressLabel: (v: string | null) => void;
  isRagHistoryDirty: boolean;
  language: Language;
  setStatusText: (v: string) => void;
}

export interface UseAppPreferencesSyncResult {
  /** Merge a partial/unknown value onto `DEFAULT_TTS_CONFIG` and sanitise the ringtone id. */
  sanitizeTtsConfig: (value: unknown) => TtsConfig;
  /** Sanitise + persist + push the new config into the store + localStorage mirror. */
  handleTtsConfigChange: (next: TtsConfig) => void;
  /** Flip `autoZipEnabled` both in the store and via Electron IPC. */
  handleToggleAutoZip: () => void;
  /** Always-latest ref to the current `ttsConfig`; consumers outside React effects
   *  (e.g. background proactive message pipelines) read the ref instead of the state. */
  ttsConfigRef: MutableRefObject<TtsConfig>;
}

/**
 * Owns all the small preference -> storage / IPC sync side-effects that used
 * to clutter App.tsx:
 *
 *   - persist currentEmotion to IndexedDB
 *   - hydrate autoZipEnabled from Electron main on mount + toggle handler
 *   - TTS config: latest-value ref + sanitise + localStorage mirror
 *   - RAG: clear progress label once status leaves busy, flip status when
 *     backupConfig.ragEnabled changes, persist isRagHistoryDirty and the full
 *     backupConfig to IndexedDB
 *   - refresh statusText ("connected") whenever the UI language changes
 *
 * All state/setters are injected so the hook has no implicit store coupling
 * and the guard rails (`isDataLoaded`, `isBulkRestoreInProgressRef`) that the
 * inline effects used are preserved verbatim.
 */
export const useAppPreferencesSync = ({
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
}: UseAppPreferencesSyncInput): UseAppPreferencesSyncResult => {
  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_current_emotion', currentEmotion);
  }, [currentEmotion, isDataLoaded, isBulkRestoreInProgressRef]);

  useEffect(() => {
    if (isDesktopElectron()) {
      window.electronAPI!.invoke('app:get-auto-zip-backup').then((result: any) => {
        setAutoZipEnabled(result?.enabled === true);
      });
    }
  }, [setAutoZipEnabled]);

  const handleToggleAutoZip = useCallback((): void => {
    const newValue = !autoZipEnabled;
    setAutoZipEnabled(newValue);
    if (isDesktopElectron()) {
      window.electronAPI!.invoke('app:set-auto-zip-backup', { enabled: newValue });
    }
  }, [autoZipEnabled, setAutoZipEnabled]);

  const sanitizeTtsConfig = useCallback((value: unknown): TtsConfig => {
    const merged = {
      ...DEFAULT_TTS_CONFIG,
      ...(value && typeof value === 'object' ? (value as Partial<TtsConfig>) : {}),
    };

    if (!isBuiltInRingtoneId(merged.ringtoneFileId) && !isCustomRingtoneId(merged.ringtoneFileId)) {
      merged.ringtoneFileId = DEFAULT_TTS_CONFIG.ringtoneFileId;
    }

    return merged as TtsConfig;
  }, []);

  const ttsConfigRef = useRef<TtsConfig>(ttsConfig);
  useEffect(() => {
    ttsConfigRef.current = ttsConfig;
  }, [ttsConfig]);

  const handleTtsConfigChange = useCallback((next: TtsConfig): void => {
    const sanitized = sanitizeTtsConfig(next);
    setTtsConfig(sanitized);
    localStorage.setItem('kumiko_tts_config', JSON.stringify(sanitized));
  }, [sanitizeTtsConfig, setTtsConfig]);

  useEffect(() => {
    if (ragStatus !== 'RECALLING' && ragStatus !== 'INDEXING') {
      setRagProgressLabel(null);
    }
  }, [ragStatus, setRagProgressLabel]);

  useEffect(() => {
    const ragEnabled = backupConfig.ragEnabled ?? false;
    if (ragEnabled) {
      setRagStatus((prev) => (prev === 'OFF' ? 'IDLE' : prev));
    } else {
      setRagStatus('OFF');
    }
  }, [backupConfig.ragEnabled, setRagStatus]);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal(RAG_HISTORY_DIRTY_STORAGE_KEY, isRagHistoryDirty);
  }, [isRagHistoryDirty, isDataLoaded, isBulkRestoreInProgressRef]);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_backup_config', backupConfig);
  }, [backupConfig, isDataLoaded, isBulkRestoreInProgressRef]);

  useEffect(() => {
    setStatusText(UI_TRANSLATIONS[language].signalConnected);
  }, [language, setStatusText]);

  return {
    sanitizeTtsConfig,
    handleTtsConfigChange,
    handleToggleAutoZip,
    ttsConfigRef,
  };
};
