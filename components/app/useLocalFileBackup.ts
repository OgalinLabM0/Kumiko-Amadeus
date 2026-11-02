import { useCallback, type MutableRefObject } from 'react';
import type { BackupConfig, Language } from '../../types';
import { LOCAL_BACKUP_PATH_STORAGE_KEY } from './appConstants';
import {
  isDesktopElectron,
  parseDesktopBackupImportFile,
  pickDesktopBackupOpenFile,
  pickDesktopBackupSaveFile,
} from '../../services/desktopBackupService';
import { normalizeBackupConfig } from '../../services/appConfig';
import { isVoiceServiceAvailable } from '../../services/voiceFileService';
import { dialogService } from '../../services/dialogService';
import { openSessionJson, protectionStatus } from '../../services/backupProtection';
import { isEncryptedBackup } from '../../services/portableBackupCrypto.mjs';
import { getDataRestoreVersion, isDataRestoreBlocked } from '../../services/dataRestoreGate';
import { useAppStore } from '../../store';
import { yieldToMainThread } from './appUtils';
import { validateBackupImportPayload } from './backupImportValidation';
import type { BackupPayload } from './backupData';
// F2B.1: dropped `MobilePickResult` import + `isMobilePwa` / `httpInvoke`
// imports from this file. The Phase 6 mobile-PWA-via-PC remote file
// picker is gone (no MobileRemoteFileBrowser, no useMobileRemoteFilePicker
// hook). Desktop Electron now owns 100% of the LOCAL backup tab; Capacitor
// Android hides it via F2A.4 in BackupSection.

export interface UseLocalFileBackupInput {
  /** Holds the current local backup target: File System Access `FileSystemFileHandle`
   *  in the browser or an absolute path string in Electron. */
  fileHandleRef: MutableRefObject<any>;
  backupData: BackupPayload;
  language: Language;
  setConnectedFileName: (name: string | null) => void;
  setBackupConfig: (v: BackupConfig | ((prev: BackupConfig) => BackupConfig)) => void;
  setLastBackupTime: (v: number | null) => void;
  updateBaseline: (timestamp?: number, baselineData?: any) => void;
  performFileSave: (handle: any, data: any) => Promise<boolean>;
  restoreBackupData: (backup: any, mediaHooks?: undefined, expectedVersion?: string) => Promise<any>;
}

export interface UseLocalFileBackupResult {
  /** Create a new local backup file and write the current snapshot to it. */
  handleCreateNewLocalFile: () => Promise<boolean>;
  /** Open an existing local backup file and restore from it. */
  handleOpenLocalFile: () => Promise<boolean>;
  /** Disconnect the current local backup file without touching its contents. */
  handleDisconnectLocalFile: () => void;
  /** Re-read the connected local backup file, confirming discard of dirty state. */
  handleManualLocalReload: () => Promise<void>;
}

/**
 * Centralises the four "local file" backup handlers that used to live inline
 * in App.tsx. Each handler mirrors its pre-extraction behaviour exactly,
 * including the `useCallback` dependency arrays and the voice-file pre-check
 * inside `handleOpenLocalFile`.
 *
 * All cross-cutting state (fileHandleRef, store setters, backup payload) is
 * passed in so the hook has no hidden store coupling and can be reasoned
 * about in isolation.
 */
export const useLocalFileBackup = ({
  fileHandleRef,
  backupData,
  language,
  setConnectedFileName,
  setBackupConfig,
  setLastBackupTime,
  updateBaseline,
  performFileSave,
  restoreBackupData,
}: UseLocalFileBackupInput): UseLocalFileBackupResult => {
  const handleCreateNewLocalFile = useCallback(async (): Promise<boolean> => {
    try {
      const defaultFileName = `kumiko_backup_${new Date().toISOString().slice(0, 10)}.${await protectionStatus() ? 'kab' : 'json'}`;

      // F2B.1: removed the `if (isMobilePwa())` branch that delegated to
      // MobileRemoteFileBrowser via `pickMobileCreateFile`. PWA is gone;
      // BackupSection hides this button on Capacitor (F2A.4).
      if (isDesktopElectron()) {
        const result = await pickDesktopBackupSaveFile(defaultFileName);
        if (result.canceled) return false;
        if (!result.success || !result.filePath) {
          void dialogService.alert({
            message: (language === 'zh' ? '访问本地文件失败：' : 'Failed to access local file: ') + (result.error || ''),
            icon: 'error',
          });
          return false;
        }

        fileHandleRef.current = result.filePath;
        setConnectedFileName(result.fileName || result.filePath.split(/[\\/]/).pop() || result.filePath);
        localStorage.setItem(LOCAL_BACKUP_PATH_STORAGE_KEY, result.filePath);
      } else {
        // @ts-ignore -- showSaveFilePicker is not yet in lib.dom
        if (typeof window.showSaveFilePicker !== 'function') {
          void dialogService.alert({
            message: language === 'zh' ? '您的浏览器不支持 File System Access API。' : 'Your browser does not support the File System Access API.',
            icon: 'error',
          });
          return false;
        }
        // @ts-ignore -- File System Access API typing
        const handle = await window.showSaveFilePicker({
          suggestedName: defaultFileName,
          types: [{ description: 'Backup File', accept: { 'application/json': ['.json'], 'application/octet-stream': ['.kab'] } }],
        });
        fileHandleRef.current = handle;
        setConnectedFileName(handle.name);
        localStorage.removeItem(LOCAL_BACKUP_PATH_STORAGE_KEY);
      }

      setBackupConfig((prev) => normalizeBackupConfig({ ...prev, localEnabled: true }));
      const didSave = await performFileSave(fileHandleRef.current, backupData);
      if (!didSave) return false;

      const savedAt = Date.now();
      setLastBackupTime(savedAt);
      updateBaseline(savedAt);
      return true;
    } catch (err: any) {
      if (err.name === 'AbortError') return false;
      void dialogService.alert({
        message: (language === 'zh' ? '访问文件系统失败：' : 'Failed to access file system: ') + (err.message || ''),
        icon: 'error',
      });
      return false;
    }
  }, [backupData, updateBaseline, language]);

  const handleDisconnectLocalFile = useCallback((): void => {
    fileHandleRef.current = null;
    setConnectedFileName(null);
    localStorage.removeItem(LOCAL_BACKUP_PATH_STORAGE_KEY);
    setBackupConfig((prev) => normalizeBackupConfig({ ...prev, localEnabled: false }));
    // F2B.1: removed the `if (isMobilePwa())` `backup:disconnect-desktop-file`
    // broadcast. With no more multi-device PWA fan-out, disconnect is purely
    // a local state reset.
  }, []);

  const handleOpenLocalFile = useCallback(async (): Promise<boolean> => {
    if (isDataRestoreBlocked()) return false;
    const expectedVersion = getDataRestoreVersion();
    try {
      let text = '';
      let parsedJson: any = null;
      let selectedHandle: any = null;
      let selectedName: string | null = null;

      // F2B.1: removed the `if (isMobilePwa())` branch that delegated to
      // MobileRemoteFileBrowser + `backup:read-desktop-file`.
      if (isDesktopElectron()) {
        const result = await pickDesktopBackupOpenFile();
        if (result.canceled) return false;
        if (!result.success || !result.filePath) {
          void dialogService.alert({
            message: (language === 'zh' ? '访问本地文件失败：' : 'Failed to access local file: ') + (result.error || ''),
            icon: 'error',
          });
          return false;
        }

        selectedHandle = result.filePath;
        selectedName = result.fileName || result.filePath.split(/[\\/]/).pop() || result.filePath;
        const password = isEncryptedBackup(result.content) ? await dialogService.prompt({ message: language === 'zh' ? '输入该备份的密码。' : 'Enter the password for this backup.', secret: true }) : undefined;
        if (isEncryptedBackup(result.content) && !password) return false;
        const parsedResult = await parseDesktopBackupImportFile(result.filePath, password || undefined);
        if (!parsedResult.success || !parsedResult.json) {
          throw new Error(parsedResult.error || 'Failed to parse desktop backup file.');
        }
        parsedJson = parsedResult.json;
      } else {
        // @ts-ignore -- showOpenFilePicker not yet in lib.dom
        if (typeof window.showOpenFilePicker !== 'function') {
          void dialogService.alert({
            message: language === 'zh' ? '您的浏览器不支持 File System Access API。' : 'Your browser does not support the File System Access API.',
            icon: 'error',
          });
          return false;
        }
        // @ts-ignore -- File System Access API typing
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'Backup File', accept: { 'application/json': ['.json'], 'application/octet-stream': ['.kab'] } }],
          multiple: false,
        });
        selectedHandle = handle;
        selectedName = handle.name;

        try {
          const file = await handle.getFile();
          text = await openSessionJson(await file.text());
        } catch (readErr) {
          console.log('Error reading file:', readErr);
          void dialogService.alert({
            message: language === 'zh' ? '读取所选文件失败。' : 'Failed to read the selected file.',
            icon: 'error',
          });
          return false;
        }
      }

      if (parsedJson || text) {
        await yieldToMainThread();
        const json = parsedJson ?? JSON.parse(text);
        const validation = validateBackupImportPayload(json);
        if (!validation.valid) {
          throw new Error(`Invalid backup payload: ${validation.reason || 'unrecognized structure'}`);
        }

        // Voice-file pre-check: warn if the backup has voice messages but the
        // current data directory has no audio files yet.
        const dataToRestore = json.data || json;
        const msgs = dataToRestore?.messages || [];
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

        if (isDataRestoreBlocked() || getDataRestoreVersion() !== expectedVersion) throw new Error('Data changed while the backup was being prepared.');
        const restoredData = json ? await restoreBackupData(json, undefined, expectedVersion) : null;
        if (restoredData) {
          fileHandleRef.current = selectedHandle;
          setConnectedFileName(selectedName);
          if (typeof selectedHandle === 'string') localStorage.setItem(LOCAL_BACKUP_PATH_STORAGE_KEY, selectedHandle);
          else localStorage.removeItem(LOCAL_BACKUP_PATH_STORAGE_KEY);
          setBackupConfig((prev) => normalizeBackupConfig({ ...prev, localEnabled: true }));
          const restoredAt = json.timestamp || Date.now();
          setLastBackupTime(restoredAt);
          updateBaseline(restoredAt, restoredData);
          return true;
        }
        return false;
      }

      return true;
    } catch (err: any) {
      if (err.name === 'AbortError') return false;
      void dialogService.alert({
        message: (language === 'zh' ? '访问文件系统失败：' : 'Failed to access file system: ') + (err.message || ''),
        icon: 'error',
      });
      return false;
    }
  }, [restoreBackupData, updateBaseline, language]);

  const handleManualLocalReload = useCallback(async (): Promise<void> => {
    if (isDataRestoreBlocked()) return;
    const expectedVersion = getDataRestoreVersion();
    const handle = fileHandleRef.current;
    if (!handle) return;
    const proceed = await dialogService.confirm({
      message: language === 'zh'
        ? '要从本地文件重新加载数据吗？当前未保存的改动将会丢失。'
        : 'Reload data from local file? Current unsaved changes will be lost.',
      variant: 'danger',
    });
    if (!proceed) return;
    try {
      let text = '';
      let parsedJson: any = null;

      // F2B.1: dropped the `if (isMobilePwa() && typeof handle === 'string')`
      // branch — that path used `backup:read-desktop-file` over HTTP IPC,
      // which is gone with the PWA bridge.
      if (isDesktopElectron() && typeof handle === 'string') {
        let parsedResult = await parseDesktopBackupImportFile(handle);
        if (!parsedResult.success && /password|corrupted|key|storage/i.test(parsedResult.error || '')) {
          const password = await dialogService.prompt({ message: language === 'zh' ? '输入该备份的密码。' : 'Enter the password for this backup.', secret: true });
          if (!password) return;
          parsedResult = await parseDesktopBackupImportFile(handle, password);
        }
        if (!parsedResult.success || !parsedResult.json) {
          throw new Error(parsedResult.error || 'Failed to parse desktop backup file.');
        }
        parsedJson = parsedResult.json;
      } else {
        const file = await handle.getFile();
        text = await openSessionJson(await file.text());
      }

      if (parsedJson || text) {
        await yieldToMainThread();
        const json = parsedJson ?? JSON.parse(text);
        const validation = validateBackupImportPayload(json);
        if (!validation.valid) {
          throw new Error(`Invalid backup payload: ${validation.reason || 'unrecognized structure'}`);
        }
        if (isDataRestoreBlocked() || getDataRestoreVersion() !== expectedVersion) throw new Error('Data changed while the backup was being prepared.');
        const restoredData = await restoreBackupData(json, undefined, expectedVersion);
        if (restoredData) {
          updateBaseline(json.timestamp || Date.now(), restoredData);
          useAppStore.getState().setSystemNotice(
            language === 'zh' ? '数据重新加载成功。' : 'Data reloaded successfully.'
          );
        }
      }
    } catch (e) {
      console.error(e);
      void dialogService.alert({
        message: language === 'zh' ? '重新加载数据失败。' : 'Failed to reload data.',
        icon: 'error',
      });
    }
  }, [restoreBackupData, updateBaseline, language]);

  return {
    handleCreateNewLocalFile,
    handleOpenLocalFile,
    handleDisconnectLocalFile,
    handleManualLocalReload,
  };
};
