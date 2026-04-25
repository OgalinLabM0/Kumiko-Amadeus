import type { StateCreator } from 'zustand';
import type { AppUpdateState, UpdaterCacheInfo } from '../../types';
import { isDesktopElectron } from '../../services/desktopBackupService';
import { isCapacitorNative } from '../../services/environment';

declare const __APP_VERSION__: string;

// v2.14.1 B.4.a: Initialize currentVersion from the build-time
// __APP_VERSION__ define injected by vite.config.ts (sourced from
// package.json `version`). Previously hardcoded '0.0.0', which is what
// the Android Settings page rendered before the desktop bootstrap had
// a chance to call `app:get-version`. Capacitor never calls that IPC so
// the field stayed '0.0.0' forever — surfaced in v2.14.0 as the user
// complaint "应用更新页显示 v0.0.0".
// v2.14.3 N.3: every renderer that displays a version wraps the value
// with a literal `v` prefix (`v{currentVersion}` / `v{availableVersion}`),
// because Electron's electron-updater historically delivers a bare
// "2.14.2" string. Capacitor's GitHub Releases path delivers the raw
// `tag_name`, which by our convention is "v2.14.2" — so the renderer ends
// up rendering "vv2.14.2". Normalize at the slice boundary so neither
// path leaks the prefix into shared state. Any string starting with
// "v" or "V" followed by a digit gets the prefix dropped; everything
// else (including empty / null) is passed through untouched.
const stripLeadingV = (raw: string | null | undefined): string => {
  if (!raw || typeof raw !== 'string') return '';
  return /^v\d/i.test(raw) ? raw.slice(1) : raw;
};

const INITIAL_VERSION: string = (() => {
  try {
    return stripLeadingV(typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : '0.0.0') || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export const DEFAULT_APP_UPDATE_STATE: AppUpdateState = {
  status: 'idle',
  currentVersion: INITIAL_VERSION,
  availableVersion: null,
  releaseDate: null,
  progressPercent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  error: null,
  // On Capacitor we treat the APK as "packaged" so AppUpdateSection's
  // packaged-only buttons enable. Desktop will overwrite this from the
  // Electron bootstrap once `app:update:bootstrap` lands.
  isPackaged: false,
  // v2.14.6 D.1: null = "no check yet". useAppUpdater.ts only fires the
  // "currently up to date" SystemToast when this is exactly 'manual', so
  // the default null value keeps both desktop AND Android cold starts
  // silent until the user (or a startup auto-check) actually runs one.
  triggerSource: null,
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
    // v2.14.1 B.4.b: Capacitor branch — poll GitHub Releases via the
    // existing androidUpdaterService and reflect the result in the
    // shared appUpdateState so the AppUpdateSection UI re-renders. We
    // can't reuse the desktop electron-updater state machine because
    // there is no "downloading" / "downloaded" phase on Android (user
    // sideloads the APK from a browser tab); instead we collapse the
    // flow into 'available' / 'not-available' / 'error'.
    //
    // v2.14.6 D.1: stamp triggerSource:'manual' on every transition so the
    // useAppUpdater hook's manual-only toast gate works on Android too.
    // (handleCheckForAppUpdates is only called from explicit "Check for
    // updates" button presses on this slice — there's no Capacitor startup
    // auto-check beyond useAppUpdater's silent 30 s GitHub poll, which
    // doesn't go through this slice at all.)
    if (isCapacitorNative()) {
      get().setAppUpdateState((prev) => ({
        ...prev,
        status: 'checking',
        error: null,
        triggerSource: 'manual',
      }));
      try {
        const { checkForAndroidUpdate } = await import('../../services/androidUpdaterService');
        const info = await checkForAndroidUpdate(true); // force=true bypasses 7d cooldown
        if (info?.hasUpdate && info.latestVersion) {
          get().setAppUpdateState((prev) => ({
            ...prev,
            status: 'available',
            // Strip the leading "v" so the UI's `v{...}` prefix doesn't double up.
            availableVersion: stripLeadingV(info.latestVersion!),
            error: null,
            triggerSource: 'manual',
          }));
        } else {
          get().setAppUpdateState((prev) => ({
            ...prev,
            status: 'not-available',
            availableVersion: info?.latestVersion ? stripLeadingV(info.latestVersion) : null,
            error: null,
            triggerSource: 'manual',
          }));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[UPDATER] Android check failed:', error);
        get().setAppUpdateState((prev) => ({
          ...prev,
          status: 'error',
          error: message,
          triggerSource: 'manual',
        }));
      }
      return;
    }

    if (!isDesktopElectron() || !window.electronAPI) return;
    try {
      // v2.14.6 D.1: tell main "this is a manual check" so its
      // emitAppUpdateState() sets triggerSource:'manual'. The startup
      // auto-check in electron-main.cjs passes 'startup' instead.
      const result = await window.electronAPI.invoke('app:update:check', 'manual');
      if (result?.success === false && result?.error) {
        get().setAppUpdateState((prev) => ({
          ...prev,
          status: 'error',
          error: result.error,
          triggerSource: 'manual',
        }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[UPDATER] Failed to start update check:', error);
      get().setAppUpdateState((prev) => ({
        ...prev,
        status: 'error',
        error: message,
        triggerSource: 'manual',
      }));
    }
  },

  handleDownloadAppUpdate: async () => {
    // v2.14.1 B.4.b: Capacitor branch — open the GitHub release page in
    // the system browser so the user can download the APK and sideload
    // it. We don't perform the download in-app because that would
    // require REQUEST_INSTALL_PACKAGES + a custom Files / DownloadManager
    // round-trip (see services/androidUpdaterService.ts for the
    // rationale); the system browser path is one extra tap with zero
    // new permissions.
    if (isCapacitorNative()) {
      try {
        const { checkForAndroidUpdate, openAndroidUpdateUrl, markUpdatePrompted } = await import(
          '../../services/androidUpdaterService'
        );
        const info = await checkForAndroidUpdate(true);
        const targetUrl = info?.releaseUrl
          || `https://github.com/OgalinLabM0/Kumiko-Amadeus/releases/latest`;
        if (info?.latestVersion) markUpdatePrompted(info.latestVersion);
        await openAndroidUpdateUrl(targetUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[UPDATER] Android open-download-page failed:', error);
        get().setAppUpdateState((prev) => ({ ...prev, status: 'error', error: message }));
      }
      return;
    }

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
