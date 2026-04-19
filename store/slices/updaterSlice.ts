import type { StateCreator } from 'zustand';
import type { AppUpdateState } from '../../types';
import { isDesktopElectron } from '../../services/desktopBackupService';

export const DEFAULT_APP_UPDATE_STATE: AppUpdateState = {
  status: 'idle',
  currentVersion: '0.0.0',
  availableVersion: null,
  releaseDate: null,
  progressPercent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  error: null,
  isPackaged: false,
};

export interface UpdaterSlice {
  appUpdateState: AppUpdateState;
  showAppUpdateModal: boolean;

  setAppUpdateState: (v: AppUpdateState | ((prev: AppUpdateState) => AppUpdateState)) => void;
  setShowAppUpdateModal: (v: boolean) => void;
  handleCheckForAppUpdates: () => Promise<void>;
  handleDownloadAppUpdate: () => Promise<void>;
  handleInstallAppUpdate: () => Promise<void>;
}

export const createUpdaterSlice: StateCreator<UpdaterSlice, [], [], UpdaterSlice> = (set, get) => ({
  appUpdateState: DEFAULT_APP_UPDATE_STATE,
  showAppUpdateModal: false,

  setAppUpdateState: (v) =>
    set((s) => ({
      appUpdateState: typeof v === 'function' ? v(s.appUpdateState) : v,
    })),
  setShowAppUpdateModal: (v) => set({ showAppUpdateModal: v }),

  handleCheckForAppUpdates: async () => {
    if (!isDesktopElectron() || !window.electronAPI) return;
    try {
      const result = await window.electronAPI.invoke('app:update:check');
      if (result?.success === false && result?.error) {
        get().setAppUpdateState((prev) => ({ ...prev, status: 'error', error: result.error }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[UPDATER] Failed to start update check:', error);
      get().setAppUpdateState((prev) => ({ ...prev, status: 'error', error: message }));
    }
  },

  handleDownloadAppUpdate: async () => {
    if (!isDesktopElectron() || !window.electronAPI) return;
    try {
      const result = await window.electronAPI.invoke('app:update:download');
      if (result?.success === false && result?.error) {
        get().setAppUpdateState((prev) => ({ ...prev, status: 'error', error: result.error }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[UPDATER] Failed to start update download:', error);
      get().setAppUpdateState((prev) => ({ ...prev, status: 'error', error: message }));
    }
  },

  handleInstallAppUpdate: async () => {
    if (!isDesktopElectron() || !window.electronAPI) return;
    set({ showAppUpdateModal: false });
    try {
      const result = await window.electronAPI.invoke('app:update:quit-and-install');
      if (result?.success === false && result?.error) {
        get().setAppUpdateState((prev) => ({ ...prev, status: 'error', error: result.error }));
        set({ showAppUpdateModal: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[UPDATER] Failed to install downloaded update:', error);
      get().setAppUpdateState((prev) => ({ ...prev, status: 'error', error: message }));
      set({ showAppUpdateModal: true });
    }
  },
});
