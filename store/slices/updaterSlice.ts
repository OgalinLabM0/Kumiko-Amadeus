import type { StateCreator } from 'zustand';
import type { AppUpdateState, UpdaterCacheInfo } from '../../types';
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
  // v2.10.1: mirror of the desktop pending/ directory that
  // electron-updater writes downloads into. `null` means "not fetched
  // yet" (renderer boot, or mobile/web where the cache doesn't exist).
  // The Settings > App Update > Download Cache UI block uses this to
  // render size, file count, and the copy/open/clear buttons.
  updaterCacheInfo: UpdaterCacheInfo | null;

  setAppUpdateState: (v: AppUpdateState | ((prev: AppUpdateState) => AppUpdateState)) => void;
  setShowAppUpdateModal: (v: boolean) => void;
  handleCheckForAppUpdates: () => Promise<void>;
  handleDownloadAppUpdate: () => Promise<void>;
  handleInstallAppUpdate: () => Promise<void>;
  // v2.10.1: pending/ directory inspection + manual cleanup. All three
  // no-op on non-desktop-Electron runtimes.
  refreshUpdaterCacheInfo: () => Promise<void>;
  openUpdaterCacheFolder: () => Promise<{ success: boolean; error?: string }>;
  clearUpdaterCache: () => Promise<{ success: boolean; error?: string; sizeBytes?: number }>;
}

export const createUpdaterSlice: StateCreator<UpdaterSlice, [], [], UpdaterSlice> = (set, get) => ({
  appUpdateState: DEFAULT_APP_UPDATE_STATE,
  showAppUpdateModal: false,
  updaterCacheInfo: null,

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
      } else {
        // A successful download materializes the installer .exe into
        // pending/; refresh so the UI shows the actual size/file count
        // without waiting for the user to toggle the section.
        void get().refreshUpdaterCacheInfo();
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
        // Install failed — the main process already force-cleaned the
        // cache in onQuitAndInstallError, so refresh to mirror the new
        // empty state in the UI.
        void get().refreshUpdaterCacheInfo();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[UPDATER] Failed to install downloaded update:', error);
      get().setAppUpdateState((prev) => ({ ...prev, status: 'error', error: message }));
      set({ showAppUpdateModal: true });
      void get().refreshUpdaterCacheInfo();
    }
  },

  refreshUpdaterCacheInfo: async () => {
    if (!isDesktopElectron() || !window.electronAPI) {
      set({ updaterCacheInfo: null });
      return;
    }
    try {
      const result = await window.electronAPI.invoke('app:update:get-cache-info');
      if (result?.success && result.info) {
        set({ updaterCacheInfo: result.info as UpdaterCacheInfo });
      } else {
        set({ updaterCacheInfo: null });
      }
    } catch (error) {
      console.warn('[UPDATER] Failed to fetch cache info:', error);
      set({ updaterCacheInfo: null });
    }
  },

  openUpdaterCacheFolder: async () => {
    if (!isDesktopElectron() || !window.electronAPI) {
      return { success: false, error: 'Cache folder is only accessible on desktop.' };
    }
    try {
      const result = await window.electronAPI.invoke('app:update:open-cache-folder');
      return result ?? { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  },

  clearUpdaterCache: async () => {
    if (!isDesktopElectron() || !window.electronAPI) {
      return { success: false, error: 'Cache cleanup is only available on desktop.' };
    }
    try {
      const result = await window.electronAPI.invoke('app:update:clear-cache');
      // Always refresh: even a failed clear may have partially removed
      // some orphan directories, so the UI should mirror the new state.
      void get().refreshUpdaterCacheInfo();
      return result ?? { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void get().refreshUpdaterCacheInfo();
      return { success: false, error: message };
    }
  },
});
