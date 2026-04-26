import { useCallback, useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { isDesktopElectron } from '../services/desktopBackupService';
import { isCapacitorNative, isMobileLikeRuntime } from '../services/environment';
import { showBackgroundNotification } from '../components/app/chatActions';
import type { MessageAlertKind, MissedMessageAlert } from '../types';

type FlowState = 'INTRO' | 'AUTH' | 'CONFIG' | 'APP';

export interface UseUnreadAlertsChromeParams {
  flowState: FlowState;
  unreadAlertCount: number;
  setMessageAlerts: Dispatch<SetStateAction<MissedMessageAlert[]>>;
}

export interface UseUnreadAlertsChromeReturn {
  markAllAlertsRead: () => void;
  registerBackgroundAlert: (
    messageId: string,
    preview: string,
    kind: MessageAlertKind,
  ) => void;
  showBackgroundMessageNotification: (
    body: string,
    kind?: MessageAlertKind,
    messageId?: string,
  ) => void;
}

export function useUnreadAlertsChrome(
  params: UseUnreadAlertsChromeParams,
): UseUnreadAlertsChromeReturn {
  const { flowState, unreadAlertCount, setMessageAlerts } = params;

  const markAllAlertsRead = useCallback(() => {
    setMessageAlerts(prev => {
      let changed = false;
      const next = prev.map(alert => {
        if (alert.isRead) return alert;
        changed = true;
        return { ...alert, isRead: true };
      });
      return changed ? next : prev;
    });
  }, [setMessageAlerts]);

  const registerBackgroundAlert = useCallback(
    (messageId: string, preview: string, kind: MessageAlertKind) => {
      const trimmedPreview = preview.trim();
      if (!trimmedPreview || (!document.hidden && document.hasFocus())) {
        return;
      }

      setMessageAlerts(prev => {
        const nextAlert: MissedMessageAlert = {
          id: `${kind}-${messageId}`,
          messageId,
          preview: trimmedPreview,
          timestamp: Date.now(),
          kind,
          isRead: false,
        };
        return [nextAlert, ...prev.filter(alert => alert.id !== nextAlert.id)].slice(0, 50);
      });
    },
    [setMessageAlerts],
  );

  const showBackgroundMessageNotification = useCallback(
    (body: string, kind: MessageAlertKind = 'reply', messageId?: string) => {
      showBackgroundNotification(body, kind, messageId);
    },
    [registerBackgroundAlert],
  );

  useEffect(() => {
    if (flowState !== 'APP') return;

    const markVisibleAlertsRead = () => {
      if (!document.hidden && document.hasFocus()) {
        markAllAlertsRead();
      }
    };

    markVisibleAlertsRead();
    window.addEventListener('focus', markVisibleAlertsRead);
    document.addEventListener('visibilitychange', markVisibleAlertsRead);

    return () => {
      window.removeEventListener('focus', markVisibleAlertsRead);
      document.removeEventListener('visibilitychange', markVisibleAlertsRead);
    };
  }, [flowState, markAllAlertsRead]);

  useEffect(() => {
    if (flowState !== 'APP' || !isCapacitorNative()) return;
    void import('../services/capacitorNotifications')
      .then(({ primeKumikoNotificationRuntime }) => primeKumikoNotificationRuntime())
      .catch((error) => {
        console.warn('[UNREAD] Failed to prime Capacitor notification runtime:', error);
      });
  }, [flowState]);

  useEffect(() => {
    const baseTitle = 'Kumiko\u00b7Amadeus';
    document.title = unreadAlertCount > 0 ? `(${unreadAlertCount}) ${baseTitle}` : baseTitle;

    if (isDesktopElectron()) {
      try {
        const ipc = (window as any).electronAPI;
        ipc?.send('app:update-unread-state', { count: unreadAlertCount });
      } catch (error) {
        console.warn('[UNREAD] Failed to sync unread state to Electron shell:', error);
      }
    }

    // Phase 5 Part B + A.3: native app-badge for any mobile-like
    // runtime (PWA + Capacitor APK). Android Chrome ≥ 81, iOS 16.4+
    // installed-to-home-screen, desktop Edge/Chrome all honor
    // setAppBadge when the PWA is in the foreground. Capacitor's
    // Android WebView also exposes the API on Chromium 81+ so the
    // launcher icon badge updates without us going through Capacitor's
    // separate Badge plugin. The service worker writes the badge on
    // push arrival (sw.ts, PWA only) — this effect covers the
    // in-session case where messages come in while the app is in the
    // foreground.
    if (isMobileLikeRuntime()) {
      const nav = navigator as Navigator & {
        setAppBadge?: (count?: number) => Promise<void>;
        clearAppBadge?: () => Promise<void>;
      };
      if (typeof nav.setAppBadge === 'function') {
        if (unreadAlertCount > 0) {
          void nav.setAppBadge(unreadAlertCount).catch(() => { /* ignore */ });
        } else if (typeof nav.clearAppBadge === 'function') {
          void nav.clearAppBadge().catch(() => { /* ignore */ });
        } else {
          void nav.setAppBadge(0).catch(() => { /* ignore */ });
        }
      }
    }
  }, [unreadAlertCount]);

  return {
    markAllAlertsRead,
    registerBackgroundAlert,
    showBackgroundMessageNotification,
  };
}
