// hooks/useAndroidPendingActionsDrainer.ts
//
// B.2 + B.3 + B.4 (A6.3 + A6.4): on Capacitor, drain any pending native
// actions that were stashed by IncomingCallActivity (call accept/reject
// taps) or RemoteReplyReceiver (Direct Reply text) while the WebView
// was killed by Doze / not yet booted. Replays each drained item back
// through the normal chat / store pipeline so the UI ends up consistent.
//
// Triggers:
//   - On mount (cold start: app icon tapped, or notification tap launches
//     MainActivity)
//   - On App.appResume from @capacitor/app (warm start: backgrounded WebView
//     comes back and we want to scoop any new replies)
//
// PWA / Electron never call into here.

import { useEffect } from 'react';
import type { MissedMessageAlert } from '../types';
import { useAppStore } from '../store';
import { isCapacitorNative } from '../services/environment';
import { drainPendingNativeActions } from '../services/androidAlarmService';
import { addMessageToStore } from '../components/app/chatActions';

export const useAndroidPendingActionsDrainer = (): void => {
  useEffect(() => {
    if (!isCapacitorNative()) return;
    let cancelled = false;
    let removeListener: (() => void) | null = null;

    const drainOnce = async () => {
      const drained = await drainPendingNativeActions();
      if (cancelled) return;

      // Reject-call: log a "missed call" alert. We don't run the chat
      // pipeline here because the user already explicitly rejected the
      // call — Kumiko shouldn't insist on delivering the message.
      if (drained.call?.action === 'reject_call') {
        const event = drained.call.reminderEvent || '提醒';
        const lang = useAppStore.getState().language;
        const previewText = lang === 'zh'
          ? `未接来电：${event}`
          : `Missed call: ${event}`;
        const alertId = `missed-call-${drained.call?.reminderId || Date.now()}`;
        const newAlert: MissedMessageAlert = {
          id: alertId,
          messageId: undefined as unknown as string,
          preview: previewText,
          timestamp: drained.call?.atMs || Date.now(),
          kind: 'reminder',
          isRead: false,
        };
        useAppStore.getState().setMessageAlerts((prev) =>
          [newAlert, ...prev.filter((a) => a.id !== alertId)].slice(0, 50)
        );
      }

      // Accept-call: park the reminder event in the store as an
      // auto-accept hint. v2.14.23: when useScheduledReminders polling
      // catches up within 1-2s and calls triggerTimedReminderMessage,
      // it consumes the hint and skips the in-app ringing UI — the
      // user already tapped Accept on the lock-screen FSI, so making
      // them tap Accept a second time was the v2.14.22 paper-cut.
      if (drained.call?.action === 'accept_call' && drained.call.reminderEvent) {
        useAppStore.getState().setPendingAutoAcceptReminderEvent(drained.call.reminderEvent);
        const lang = useAppStore.getState().language;
        useAppStore.getState().setSystemNotice(lang === 'zh' ? '正在接通…' : 'Connecting…');
      }

      // Each Direct Reply gets injected as a user message via the existing
      // chat pipeline. Each call to addUserMessage triggers the LLM round
      // trip. To avoid thrashing, we serialise (await each completion) but
      // ALL messages from a single batch reach Kumiko in one open WebView.
      for (const reply of drained.replies) {
        const text = reply.text.trim();
        if (!text) continue;
        // Inject as a user message into the store. The next chat-loop
        // tick (whichever component subscribes to the messages slice)
        // will see the new user turn and the existing executeSend logic
        // can pick it up. For the v1 of B.4 we accept that the AI
        // response only fires when the user actually opens / interacts
        // with the chat — Direct Reply text WILL be visible in history
        // immediately, but the LLM round trip needs an in-app trigger.
        // A future refactor can hoist the executeSend ref into a
        // module-level singleton so we can fire-and-forget here.
        const messageId = addMessageToStore(
          'user',
          text,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          'neutral',
        );
        void messageId;
      }
    };

    void drainOnce();

    // Listen for app:appResume via @capacitor/app to drain again on
    // foreground wake-ups (most common for Direct Reply: user replies
    // from notification, app comes back later).
    void (async () => {
      try {
        const { App } = await import('@capacitor/app');
        const sub = await App.addListener('appStateChange', (state) => {
          if (state.isActive) {
            void drainOnce();
          }
        });
        if (cancelled) {
          sub.remove();
        } else {
          removeListener = () => sub.remove();
        }
      } catch (e) {
        console.warn('[androidPendingDrainer] failed to attach App listener:', e);
      }
    })();

    return () => {
      cancelled = true;
      if (removeListener) {
        try { removeListener(); } catch { /* ignore */ }
      }
    };
  }, []);
};
