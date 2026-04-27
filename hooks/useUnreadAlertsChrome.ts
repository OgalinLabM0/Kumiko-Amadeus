import { useCallback, useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { isDesktopElectron } from '../services/desktopBackupService';
import { isMobileLikeRuntime } from '../services/environment';
import { showBackgroundNotification } from '../components/app/chatActions';
import {
  EXACT_ALARM_PERMISSION_PROMPTED_STORAGE_KEY,
  FULL_SCREEN_INTENT_PERMISSION_PROMPTED_STORAGE_KEY,
  prewarmKumikoAlarmsPlugin,
} from '../services/androidAlarmService';
import {
  getPermissionStatusSnapshot,
  openAndroidAlertPermissionSettings,
  requestAndroidNotificationPermission,
} from '../services/androidAlertPermissionService';
import { useAppStore } from '../store';
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
    if (flowState !== 'APP') return;
    let cancelled = false;
    let running = false;

    const getPermissionCopy = () => {
      const language = useAppStore.getState().language;
      return language === 'en'
        ? {
          notificationDenied: 'Android notification permission is not enabled. New messages, reminders, vibration, and call alerts may stay silent until you allow notifications for Kumiko.',
          exactPrompt: 'Opening Android Alarms & reminders permission. Please allow it so timed reminders can ring exactly while the phone is locked.',
          exactStillMissing: 'Exact alarm permission is still off. Timed reminders may be delayed by Android; enable Alarms & reminders in system settings.',
          fullScreenPrompt: 'Opening Android full-screen notification permission. Please allow it so reminder calls can pop over the lock screen.',
          fullScreenStillMissing: 'Full-screen notification permission is still off. Reminder calls may fall back to a heads-up notification instead of the incoming-call screen.',
        }
        : {
          notificationDenied: 'Android 通知权限尚未开启。主动消息、提醒、震动和来电弹窗可能会静默，请在系统弹窗或应用通知设置里允许 Kumiko 通知。',
          exactPrompt: '即将打开 Android「闹钟与提醒」权限页。请允许它，这样定时提醒才能在锁屏/后台准点响。',
          exactStillMissing: '精准闹钟权限仍未开启。Android 可能会延迟定时提醒，请在系统设置里允许「闹钟与提醒」。',
          fullScreenPrompt: '即将打开 Android「全屏通知」权限页。请允许它，这样提醒来电才能覆盖锁屏弹出。',
          fullScreenStillMissing: '全屏通知权限仍未开启。提醒来电可能只能降级成横幅通知，不能弹出微信式来电页。',
        };
    };

    const setNotice = (message: string) => {
      try {
        useAppStore.getState().setSystemNotice(message);
      } catch (error) {
        console.warn('[UNREAD] Failed to set Android permission notice:', error);
      }
    };

    const runPermissionBootstrap = async () => {
      if (running) return;
      running = true;
      try {
        const copy = getPermissionCopy();
        // v2.14.27: lightweight bootstrap — warm the slim native bridge
        // (4 s budget) then take a 5-item permission snapshot. Channel
        // creation lives in KumikoAlarmsPlugin.load() so JS no longer
        // needs an explicit ensureChannels call.
        await prewarmKumikoAlarmsPlugin();
        if (cancelled) return;
        let snapshot = await getPermissionStatusSnapshot();
        if (cancelled) return;
        if (!snapshot.supported) return;

        if (snapshot.items.notifications.state !== 'granted') {
          snapshot = await requestAndroidNotificationPermission();
          if (cancelled) return;
          if (snapshot.items.notifications.state !== 'granted') {
            setNotice(copy.notificationDenied);
            return;
          }
        }

        if (snapshot.items.exactAlarm.state !== 'granted') {
          const prompted = window.localStorage.getItem(EXACT_ALARM_PERMISSION_PROMPTED_STORAGE_KEY);
          if (!prompted) {
            window.localStorage.setItem(EXACT_ALARM_PERMISSION_PROMPTED_STORAGE_KEY, '1');
            setNotice(copy.exactPrompt);
            await openAndroidAlertPermissionSettings('exactAlarm');
            return;
          }
          setNotice(copy.exactStillMissing);
        }

        if (cancelled) return;
        if (snapshot.items.fullScreenIntent.state !== 'granted') {
          const prompted = window.localStorage.getItem(FULL_SCREEN_INTENT_PERMISSION_PROMPTED_STORAGE_KEY);
          if (!prompted) {
            window.localStorage.setItem(FULL_SCREEN_INTENT_PERMISSION_PROMPTED_STORAGE_KEY, '1');
            setNotice(copy.fullScreenPrompt);
            await openAndroidAlertPermissionSettings('fullScreenIntent');
            return;
          }
          setNotice(copy.fullScreenStillMissing);
        }
      } catch (error) {
        console.warn('[UNREAD] Failed to bootstrap Android notification permissions:', error);
      } finally {
        running = false;
      }
    };

    void runPermissionBootstrap();
    const onReturnFromSettings = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void runPermissionBootstrap();
    };
    window.addEventListener('focus', onReturnFromSettings);
    document.addEventListener('visibilitychange', onReturnFromSettings);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onReturnFromSettings);
      document.removeEventListener('visibilitychange', onReturnFromSettings);
    };
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
