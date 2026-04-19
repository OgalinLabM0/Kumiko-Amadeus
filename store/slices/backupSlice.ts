import type { StateCreator } from 'zustand';
import type { BackupConfig } from '../../types';
import { DEFAULT_BACKUP_CONFIG } from '../../services/appConfig';

// Cloud-sync slice fields (isCloudSynced, showCloudRestorePrompt) were removed when the
// cloud-sync feature was dropped from the product. See also: BackupConfig has been
// trimmed to { localEnabled, ragEnabled } in types.ts.
export interface BackupSlice {
  backupConfig: BackupConfig;
  autoZipEnabled: boolean;
  autoBackupInterval: number;
  connectedFileName: string | null;
  lastBackupTime: number | null;
  syncErrorMessage: string | null;
  showSyncErrorModal: boolean;
  isAutoZipping: boolean;

  setBackupConfig: (v: BackupConfig | ((prev: BackupConfig) => BackupConfig)) => void;
  setAutoZipEnabled: (v: boolean) => void;
  setAutoBackupInterval: (v: number) => void;
  setConnectedFileName: (v: string | null) => void;
  setLastBackupTime: (v: number | null) => void;
  setSyncErrorMessage: (v: string | null) => void;
  setShowSyncErrorModal: (v: boolean) => void;
  setIsAutoZipping: (v: boolean) => void;
}

export const createBackupSlice: StateCreator<BackupSlice, [], [], BackupSlice> = (set) => ({
  backupConfig: { ...DEFAULT_BACKUP_CONFIG },
  autoZipEnabled: false,
  autoBackupInterval: 2,
  connectedFileName: null,
  lastBackupTime: null,
  syncErrorMessage: null,
  showSyncErrorModal: false,
  isAutoZipping: false,

  setBackupConfig: (v) => set((s) => ({ backupConfig: typeof v === 'function' ? v(s.backupConfig) : v })),
  setAutoZipEnabled: (v) => set({ autoZipEnabled: v }),
  setAutoBackupInterval: (v) => set({ autoBackupInterval: v }),
  setConnectedFileName: (v) => set({ connectedFileName: v }),
  setLastBackupTime: (v) => set({ lastBackupTime: v }),
  setSyncErrorMessage: (v) => set({ syncErrorMessage: v }),
  setShowSyncErrorModal: (v) => set({ showSyncErrorModal: v }),
  setIsAutoZipping: (v) => set({ isAutoZipping: v }),
});
