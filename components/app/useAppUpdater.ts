import { useEffect, useRef } from 'react';
import type { AppUpdateState, Language } from '../../types';
import { UI_TRANSLATIONS } from '../../constants';
import { isDesktopElectron } from '../../services/desktopBackupService';
import { isMobilePwa } from '../../services/environment';
import { httpInvoke, subscribeEvents } from '../../services/httpApi';
import { DEFAULT_APP_UPDATE_STATE } from '../../store/slices/updaterSlice';

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

    // Mobile PWA: live-mirror the desktop updater state. The desktop
    // broadcaster forwards every `app:update-status` payload into the
    // WS fan-out as `update:state` (Phase 3 Part D). We also fetch the
    // initial snapshot via HTTP IPC so a phone that opens after a
    // check has already run still sees the current status.
    if (isMobilePwa()) {
      httpInvoke<{ success?: boolean; state?: AppUpdateState }>('app:update:get-state', {})
        .then((result) => {
          if (cancelled || !result?.success || !result.state) return;
          setAppUpdateState((prev) => ({ ...prev, ...(result.state as AppUpdateState) }));
        })
        .catch((error: unknown) => {
          console.error('[UPDATER] Mobile initial update state fetch failed:', error);
        });
      const unsubscribe = subscribeEvents((event) => {
        if (event?.type !== 'update:state') return;
        const payload = (event as { state?: AppUpdateState }).state;
        if (!payload) return;
        setAppUpdateState((prev) => ({ ...prev, ...payload }));
      });
      return () => {
        cancelled = true;
        unsubscribe();
      };
    }

    // Neither desktop nor PWA: legacy web-preview build with no backend.
    setAppUpdateState((prev) => ({ ...prev, status: 'unsupported', isPackaged: false }));
    return () => { cancelled = true; };
  }, [setAppUpdateState]);

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

    lastAppUpdateStatusRef.current = appUpdateState.status;
  }, [
    appUpdateState.status,
    appUpdateState.availableVersion,
    language,
    setShowAppUpdateModal,
    setSystemNotice,
  ]);
};
