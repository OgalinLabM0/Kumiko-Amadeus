import { useEffect, useRef } from 'react';
import type { AppUpdateState, Language } from '../../types';
import { UI_TRANSLATIONS } from '../../constants';
import { isDesktopElectron } from '../../services/desktopBackupService';
import { isCapacitorNative } from '../../services/environment';
// F2B.3: dropped `isMobilePwa` + `httpApi` imports. The PWA used to
// live-mirror desktop updater state via `app:update:get-state` + the
// WS `update:state` push; that bridge is gone now.
import { DEFAULT_APP_UPDATE_STATE } from '../../store/slices/updaterSlice';
import {
  checkForAndroidUpdate,
  markUpdatePrompted,
  openAndroidUpdateUrl,
  shouldShowUpdatePrompt,
} from '../../services/androidUpdaterService';
import { dialogService } from '../../services/dialogService';

export interface UseAppUpdaterInput {
  appUpdateState: AppUpdateState;
  /** Matches the `updaterSlice` setter signature so the caller can pass the
   *  store action directly. Only the functional form is used internally. */
  setAppUpdateState: (v: AppUpdateState | ((prev: AppUpdateState) => AppUpdateState)) => void;
  setShowAppUpdateModal: (v: boolean) => void;
  setSystemNotice: (text: string | null) => void;
  language: Language;
}

/**
 * Bridges the Electron `electron-updater` main process with the UI:
 *
 *   - Subscribes to `app:update-status` events and forwards payloads into
 *     the updater store slice; marks the status as `unsupported` when the
 *     renderer is running outside Electron.
 *   - Reads the initial updater state via `app:update:get-state` on mount
 *     so a late-rendered App still reflects an already-finished check.
 *   - Watches `appUpdateState.status` and raises a SystemNotice toast
 *     (plus opens the install modal) on the `available` -> `downloaded`
 *     transitions, using `lastAppUpdateStatusRef` for edge detection.
 *
 * Pure side-effect hook: returns nothing. Identical behaviour to the two
 * useEffects that previously lived inline inside `App.tsx`.
 */
export const useAppUpdater = ({
  appUpdateState,
  setAppUpdateState,
  setShowAppUpdateModal,
  setSystemNotice,
  language,
}: UseAppUpdaterInput): void => {
  const lastAppUpdateStatusRef = useRef<AppUpdateState['status']>(DEFAULT_APP_UPDATE_STATE.status);

  useEffect(() => {
    let cancelled = false;

    if (isDesktopElectron() && window.electronAPI) {
      const handleUpdateStatus = (_event: any, payload: AppUpdateState) => {
        if (!payload) return;
        setAppUpdateState((prev) => ({ ...prev, ...payload }));
      };
      window.electronAPI.on('app:update-status', handleUpdateStatus);
      window.electronAPI.invoke('app:update:get-state')
        .then((result: any) => {
          if (cancelled || !result?.success || !result.state) return;
          setAppUpdateState((prev) => ({ ...prev, ...result.state }));
        })
        .catch((error: unknown) => {
          console.error('[UPDATER] Failed to read initial updater state:', error);
        });
      return () => {
        cancelled = true;
        window.electronAPI?.removeListener?.('app:update-status', handleUpdateStatus);
      };
    }

    // A8: Android Capacitor in-app updater. Replaces electron-updater
    // (which can't run inside the WebView). Polls GitHub Releases API
    // 30 s after mount, then once a week (services/androidUpdaterService.ts
    // owns the cooldown). New version → bilingual dialog → tap-to-open
    // the release page in the system browser. Per-version cooldown
    // suppresses re-prompting the same tag within 24 h after dismissal.
    if (isCapacitorNative()) {
      const timer = setTimeout(async () => {
        if (cancelled) return;
        const info = await checkForAndroidUpdate();
        if (cancelled || !info?.hasUpdate || !info.latestVersion) return;
        if (!shouldShowUpdatePrompt(info.latestVersion)) return;
        markUpdatePrompted(info.latestVersion);
        // v2.14.3 N.3: normalize both sides of the arrow so a "2.14.2 → v2.14.3"
        // mismatch never shows up. `__APP_VERSION__` is bare ("2.14.2"); the
        // GitHub tag may include a leading "v". Strip uniformly then re-add `v`.
        const stripV = (raw: string | undefined | null) =>
          raw && /^v\d/i.test(raw) ? raw.slice(1) : (raw || '');
        const cur = stripV(info.currentVersion);
        const lat = stripV(info.latestVersion);
        const title = language === 'zh' ? '有新版本可用' : 'New version available';
        const message = language === 'zh'
          ? `当前版本 v${cur} → 最新 v${lat}\n\n点击「打开下载页」会跳到 GitHub Release 页面，请下载 APK 后手动安装。`
          : `Current v${cur} → latest v${lat}\n\nTapping "Open download page" will jump to the GitHub Release page; download the APK and install it manually.`;
        const ok = await dialogService.confirm({
          title,
          message,
          confirmText: language === 'zh' ? '打开下载页' : 'Open download page',
          cancelText: language === 'zh' ? '稍后再说' : 'Later',
        }).catch(() => false);
        if (ok && info.releaseUrl) {
          await openAndroidUpdateUrl(info.releaseUrl);
        }
      }, 30_000);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }

    // F2B.3: PWA branch removed. The Capacitor APK has its own GitHub
    // Releases polling above; anything else (legacy web preview, dev
    // server) just reports `unsupported` and stays out of the way.
    setAppUpdateState((prev) => ({ ...prev, status: 'unsupported', isPackaged: false }));
    return () => { cancelled = true; };
  }, [setAppUpdateState, language]);

  useEffect(() => {
    const previousStatus = lastAppUpdateStatusRef.current;

    if (
      appUpdateState.status === 'available' &&
      previousStatus !== 'available' &&
      appUpdateState.availableVersion
    ) {
      const nextText = UI_TRANSLATIONS[language].updateToastAvailable.replace(
        '{0}',
        `v${appUpdateState.availableVersion}`,
      );
      setSystemNotice(nextText);
    }

    if (appUpdateState.status === 'downloaded' && previousStatus !== 'downloaded') {
      setSystemNotice(UI_TRANSLATIONS[language].updateToastReady);
      setShowAppUpdateModal(true);
    }

    // v2.14.3 N.3: surface a toast when a *manual* check returns
    // "already on latest". Triggered only on the `checking → not-available`
    // edge so the periodic background poll (which leaves the previous
    // status as `idle` / `unsupported`) doesn't silently shower the user
    // with toasts every time they reopen the app. Same edge guard for
    // `error`, which previously was visible only inside the section's
    // collapsed status string.
    if (previousStatus === 'checking' && appUpdateState.status === 'not-available') {
      setSystemNotice(UI_TRANSLATIONS[language].updateUpToDate);
    }
    if (previousStatus === 'checking' && appUpdateState.status === 'error') {
      const errMsg = appUpdateState.error || UI_TRANSLATIONS[language].updateError;
      setSystemNotice(errMsg);
    }

    lastAppUpdateStatusRef.current = appUpdateState.status;
  }, [
    appUpdateState.status,
    appUpdateState.availableVersion,
    appUpdateState.error,
    language,
    setShowAppUpdateModal,
    setSystemNotice,
  ]);
};
