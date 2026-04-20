import { useCallback, useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { isDesktopElectron } from '../services/desktopBackupService';
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
  }, [unreadAlertCount]);

  return {
    markAllAlertsRead,
    registerBackgroundAlert,
    showBackgroundMessageNotification,
  };
}
