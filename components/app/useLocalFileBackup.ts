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
import { isMobilePwa } from '../../services/environment';
import { httpInvoke } from '../../services/httpApi';
import { dialogService } from '../../services/dialogService';
import { useAppStore } from '../../store';
import { yieldToMainThread } from './appUtils';
import type { BackupPayload } from './backupData';
import type { MobilePickResult } from './useMobileRemoteFilePicker';

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
  restoreBackupData: (backup: any) => Promise<any>;
  // Phase 6 Part C4: mobile PWA replaces the File System Access API + desktop
  // dialogs with the MobileRemoteFileBrowser overlay. When the picker returns
  // `null` the user canceled (same semantics as AbortError).
  pickMobileOpenFile?: (opts?: { acceptExtensions?: string[] }) => Promise<MobilePickResult | null>;
  pickMobileCreateFile?: (opts?: { defaultFileName?: string; acceptExtensions?: string[] }) => Promise<MobilePickResult | null>;
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
  pickMobileOpenFile,
  pickMobileCreateFile,
}: UseLocalFileBackupInput): UseLocalFileBackupResult => {
  const handleCreateNewLocalFile = useCallback(async (): Promise<boolean> => {
    try {
      const defaultFileName = `kumiko_backup_${new Date().toISOString().slice(0, 10)}.json`;

      if (isMobilePwa()) {
        // Phase 6 Part C4: phone never spawns a native dialog. We delegate
        // to MobileRemoteFileBrowser for the (folder, filename) pair, then
        // commit the backup target to the PC via
        // `backup:set-desktop-backup-path` so every connected device sees
        // the same connectedFileName.
        if (!pickMobileCreateFile) {
          void dialogService.alert({
            message: language === 'zh' ? '移动端文件选择器未就绪。' : 'Mobile file picker is not wired up.',
            icon: 'error',
          });
          return false;
        }
        const picked = await pickMobileCreateFile({
          defaultFileName,
          acceptExtensions: ['.json'],
        });
        if (!picked) return false;
        fileHandleRef.current = picked.filePath;
        setConnectedFileName(picked.fileName);
        localStorage.setItem(LOCAL_BACKUP_PATH_STORAGE_KEY, picked.filePath);
        try {
          await httpInvoke('backup:set-desktop-backup-path', { path: picked.filePath });
        } catch (e) {
          console.warn('[LOCAL BACKUP] Mobile register desktop path failed:', e);
        }
      } else if (isDesktopElectron()) {
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
          types: [{ description: 'JSON Backup File', accept: { 'application/json': ['.json'] } }],
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
  }, [backupData, updateBaseline, pickMobileCreateFile, language]);

  const handleDisconnectLocalFile = useCallback((): void => {
    fileHandleRef.current = null;
    setConnectedFileName(null);
    localStorage.removeItem(LOCAL_BACKUP_PATH_STORAGE_KEY);
    setBackupConfig((prev) => normalizeBackupConfig({ ...prev, localEnabled: false }));
    // Phase 6 Part C4: when a phone disconnects, tell the PC so it can
    // broadcast `backup:desktop-path-changed` and every other phone
    // clears its own connectedFileName / handle too.
    if (isMobilePwa()) {
      void httpInvoke('backup:disconnect-desktop-file').catch((err) => {
        console.warn('[LOCAL BACKUP] Mobile disconnect broadcast failed:', err);
      });
    }
  }, []);

  const handleOpenLocalFile = useCallback(async (): Promise<boolean> => {
    try {
      let text = '';
      let parsedJson: any = null;

      if (isMobilePwa()) {
        // Phase 6 Part C4: the mobile LOCAL tab supports plain .json
        // backups (the ZIP-with-images path is the MANUAL tab, which
        // already routes through `POST /api/backup/import` regardless of
        // the active client). Here we ask the phone's picker for a file,
        // then read its bytes from the PC via `backup:read-desktop-file`,
        // decode base64 → UTF-8, and parse as JSON.
        if (!pickMobileOpenFile) {
          void dialogService.alert({
            message: language === 'zh' ? '移动端文件选择器未就绪。' : 'Mobile file picker is not wired up.',
            icon: 'error',
          });
          return false;
        }
        const picked = await pickMobileOpenFile({ acceptExtensions: ['.json'] });
        if (!picked) return false;

        fileHandleRef.current = picked.filePath;
        setConnectedFileName(picked.fileName);
        localStorage.setItem(LOCAL_BACKUP_PATH_STORAGE_KEY, picked.filePath);
        try {
          await httpInvoke('backup:set-desktop-backup-path', { path: picked.filePath });
        } catch (e) {
          console.warn('[LOCAL BACKUP] Mobile register desktop path failed:', e);
        }

        const readRes: any = await httpInvoke('backup:read-desktop-file', { path: picked.filePath });
        if (!readRes || !readRes.ok) {
          throw new Error(readRes?.error || 'Failed to read desktop backup file from mobile.');
        }
        const b64 = String(readRes.content || '');
        try {
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
          text = new TextDecoder('utf-8').decode(bytes);
        } catch {
          try { text = atob(b64); } catch { text = b64; }
        }
      } else if (isDesktopElectron()) {
        const result = await pickDesktopBackupOpenFile();
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
        const parsedResult = await parseDesktopBackupImportFile(result.filePath);
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
          types: [{ description: 'JSON Backup File', accept: { 'application/json': ['.json'] } }],
          multiple: false,
        });
        fileHandleRef.current = handle;
        setConnectedFileName(handle.name);
        localStorage.removeItem(LOCAL_BACKUP_PATH_STORAGE_KEY);

        try {
          const file = await handle.getFile();
          text = await file.text();
        } catch (readErr) {
          console.log('Error reading file:', readErr);
          void dialogService.alert({
            message: language === 'zh' ? '读取所选文件失败。' : 'Failed to read the selected file.',
            icon: 'error',
          });
          return false;
        }
      }

      setBackupConfig((prev) => normalizeBackupConfig({ ...prev, localEnabled: true }));

      if (parsedJson || text) {
        await yieldToMainThread();
        const json = parsedJson ?? JSON.parse(text);

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
      void dialogService.alert({
        message: (language === 'zh' ? '访问文件系统失败：' : 'Failed to access file system: ') + (err.message || ''),
        icon: 'error',
      });
      return false;
    }
  }, [restoreBackupData, updateBaseline, pickMobileOpenFile, language]);

  const handleManualLocalReload = useCallback(async (): Promise<void> => {
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

      if (isMobilePwa() && typeof handle === 'string') {
        // Phase 6 Part C4: mobile reload reads the same sandboxed path
        // via `backup:read-desktop-file`. Path traversal is enforced on
        // the PC, so a compromised phone can't get outside mobileBrowseRoot.
        const readRes: any = await httpInvoke('backup:read-desktop-file', { path: handle });
        if (!readRes || !readRes.ok) {
          throw new Error(readRes?.error || 'Failed to read desktop backup file from mobile.');
        }
        const b64 = String(readRes.content || '');
        try {
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
          text = new TextDecoder('utf-8').decode(bytes);
        } catch {
          try { text = atob(b64); } catch { text = b64; }
        }
      } else if (isDesktopElectron() && typeof handle === 'string') {
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
