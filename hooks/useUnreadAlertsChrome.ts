import { useCallback, useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { isDesktopElectron } from '../services/desktopBackupService';
import { isMobilePwa } from '../services/environment';
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

    // Phase 5 Part B: native app-badge for mobile PWAs. Android Chrome
    // ≥ 81, iOS 16.4+ installed-to-home-screen, desktop Edge/Chrome all
    // honor setAppBadge when the PWA is in the foreground. The service
    // worker also writes the badge on push arrival (sw.ts) — this
    // effect covers the in-session case where messages come in while
    // the PWA is the foreground app (push is suppressed then).
    // Permission failures + unsupported browsers are silently ignored
    // so desktop web fallbacks don't flood the console.
    if (isMobilePwa()) {
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
