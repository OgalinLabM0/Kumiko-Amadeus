import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { BackupConfig, EmotionType, Language, TtsConfig } from '../../types';
import { db } from '../../services/db';
import { isDesktopElectron } from '../../services/desktopBackupService';
// F2B.3: dropped `isMobilePwa` + `httpInvoke` imports. Auto-zip + tts-config
// were synced PC↔phone via Fastify; with the PWA bridge gone the only
// runtime that hits this code is Electron desktop (Capacitor APK skips
// `isDesktopElectron()` and the auto-zip toggle is hidden in F2A.4).
import {
  emitPreferencesChanged,
  queueLocalStoragePreferenceSync,
} from '../../services/preferencesSync';
import { sanitizeTtsConfig as sanitizeTtsConfigShared } from '../../services/ttsConfigSanitize';
import { UI_TRANSLATIONS } from '../../constants';
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
    // 自动 ZIP 备份开关在 PC 主进程持久化（electron-store）。F2B.3 删了
    // `isMobilePwa()` httpInvoke 分支 — Capacitor APK 上这个开关在 F2A.4
    // 已隐藏（无 restore UI 的 4h 自动备份本来就废了），所以只剩 Electron
    // desktop 一条路径。
    let cancelled = false;
    if (isDesktopElectron()) {
      window.electronAPI!.invoke('app:get-auto-zip-backup').then((result: any) => {
        if (!cancelled) setAutoZipEnabled(result?.enabled === true);
      });
    }
    return () => { cancelled = true; };
  }, [setAutoZipEnabled]);

  const handleToggleAutoZip = useCallback((): void => {
    const newValue = !autoZipEnabled;
    setAutoZipEnabled(newValue);
    if (isDesktopElectron()) {
      void window.electronAPI!.invoke('app:set-auto-zip-backup', { enabled: newValue })
        .then(() => {
          emitPreferencesChanged(['app:auto-zip-backup']);
        })
        .catch((e) => {
          console.warn('[useAppPreferencesSync] desktop set-auto-zip-backup failed:', e);
        });
    }
  }, [autoZipEnabled, setAutoZipEnabled]);

  const sanitizeTtsConfig = useCallback((value: unknown): TtsConfig => sanitizeTtsConfigShared(value), []);

  const ttsConfigRef = useRef<TtsConfig>(ttsConfig);
  useEffect(() => {
    ttsConfigRef.current = ttsConfig;
  }, [ttsConfig]);

  const handleTtsConfigChange = useCallback((next: TtsConfig): void => {
    const sanitized = sanitizeTtsConfig(next);
    setTtsConfig(sanitized);
    // We just called `setTtsConfig(sanitized)` on the line above; the prefs
    // sync layer would otherwise `JSON.parse + sanitize + setTtsConfig` the
    // same value a second time, which on Windows desktop noticeably compounded
    // the per-click work behind the settings flash regression. We also opt out
    // of the generic `preferences:changed` broadcast because the dedicated
    // `tts-config:changed` IPC below already fans out to every paired phone.
    queueLocalStoragePreferenceSync('kumiko_tts_config', JSON.stringify(sanitized), {
      propagateToDesktop: false,
      applyToStore: false,
      broadcast: false,
    });

    // F2B.3: dropped the `isMobilePwa()` httpInvoke branch + the cross-device
    // PC↔phone fan-out comment block. Capacitor APK is standalone, no
    // upstream PC to push to. Electron desktop still emits the in-process
    // broadcast for any IPC listener that wants it.
    if (isDesktopElectron()) {
      try {
        window.electronAPI?.send?.('mobile-event-broadcast', { type: 'tts-config:changed' });
      } catch (e) {
        console.warn('[useAppPreferencesSync] desktop tts-config:changed broadcast failed:', e);
      }
    }
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
