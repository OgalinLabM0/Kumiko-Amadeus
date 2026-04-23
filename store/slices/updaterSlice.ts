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
  // Returns success/cancelled/error so the UI layer can decide what to
  // render (inline toast success vs failure message) without having to
  // re-read the store state, which races with the main-process emit
  // that follows `app:update:cancel-download`.
  handleCancelAppUpdate: () => Promise<{ success: boolean; cancelled?: boolean; error?: string }>;
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

  handleCancelAppUpdate: async () => {
    if (!isDesktopElectron() || !window.electronAPI) {
      return { success: false, error: 'unsupported' };
    }
    const currentStatus = get().appUpdateState.status;
    if (currentStatus !== 'downloading') {
      // Idempotent no-op: button should already be hidden if status is
      // not 'downloading', but guard anyway so double-clicks or races
      // don't land us in a stuck state.
      return { success: true, cancelled: false };
    }

    // Optimistic transitional state: disables the cancel button and
    // swaps its label to "正在取消…". Main process will overwrite with
    // `status: 'available'` once cancelAppUpdateDownload returns.
    get().setAppUpdateState((prev) => ({ ...prev, status: 'cancelling', error: null }));

    try {
      const result = await window.electronAPI.invoke('app:update:cancel-download');
      if (result?.success === false) {
        // IPC returned failure (e.g. no active download, unsupported
        // runtime). Revert to `downloading` so the user can see the
        // original progress and retry — main is still downloading.
        get().setAppUpdateState((prev) => ({
          ...prev,
          status: 'downloading',
          error: result?.error || null,
        }));
        return { success: false, error: result?.error || 'cancel-failed' };
      }
      // Success: main already emitted `status: 'available'` + wiped
      // pending/. Refresh the cache-info card so the 0 B / 0 files
      // reflect the wipe without waiting for the collapse to re-open.
      void get().refreshUpdaterCacheInfo();
      return { success: true, cancelled: result?.cancelled !== false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[UPDATER] Failed to cancel update download:', error);
      get().setAppUpdateState((prev) => ({
        ...prev,
        status: 'downloading',
        error: message,
      }));
      return { success: false, error: message };
    }
  },

  handleInstallAppUpdate: async () => {
    if (!isDesktopElectron() || !window.electronAPI) return;
    set({ showAppUpdateModal: false });
    try {
      const result = await window.electronAPI.invoke('app:update:quit-and-install');
      if (result?.success === false && result?.error) {
        // 'installer-missing' means main has already re-started a download
        // and pushed a fresher state (status:'available' / 'downloading').
        // Don't clobber it with status:'error' — just refresh cache info
        // so the user sees the re-download in progress.
        if (result?.errorCode === 'installer-missing') {
          void get().refreshUpdaterCacheInfo();
          return;
        }
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
