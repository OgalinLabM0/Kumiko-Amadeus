// hooks/useAndroidPendingActionsDrainer.ts
//
// B.2 + B.3 + B.4 + v2.14.24: on Capacitor, drain any pending native actions
// that were stashed by MainActivity (call open/accept/decline from heads-up
// CallStyle taps; pre-v2.14.24 also IncomingCallActivity) or RemoteReplyReceiver
// (Direct Reply text) while the WebView was killed by Doze / not yet booted.
// Replays each drained item back through the normal chat / store pipeline so
// the UI ends up consistent.
//
// Triggers:
//   - On mount (cold start: app icon tapped, or heads-up notification tap
//     launches MainActivity)
//   - On App.appResume from @capacitor/app (warm start: backgrounded WebView
//     comes back and we want to scoop any new replies)
//
// Side effect: when a call action is drained we also call
// stopAndroidCallRinging() to silence KumikoCallRingingService — the user
// is now on screen with the React VoiceCallOverlay and the loop ringtone
// shouldn't keep ringing for the remaining 60 s window.
//
// PWA / Electron never call into here.

import { useEffect } from 'react';
import type { MissedMessageAlert } from '../types';
import { useAppStore } from '../store';
import { isCapacitorNative } from '../services/environment';
import {
  drainPendingNativeActions,
  stopAndroidCallRinging,
} from '../services/androidAlarmService';
import { addMessageToStore } from '../components/app/chatActions';

export const useAndroidPendingActionsDrainer = (): void => {
  useEffect(() => {
    if (!isCapacitorNative()) return;
    let cancelled = false;
    let removeListener: (() => void) | null = null;

    const drainOnce = async () => {
      const drained = await drainPendingNativeActions();
      if (cancelled) return;

      const callEvent = drained.call?.reminderEvent;
      const callAction = drained.call?.action;
      if (drained.call && callEvent && callAction) {
        // v2.14.24: silence the looping ringtone foreground service the
        // moment any heads-up tap reaches us. Without this, the ringtone
        // would keep playing for ~60 s after the user has already entered
        // the React UI — exactly the regression the v2.14.21 plan called
        // out as "rings forever even after I tapped accept".
        void stopAndroidCallRinging();

        const lang = useAppStore.getState().language;
        const eventForUi = callEvent || '提醒';
        const writeMissedAlert = (kind: 'declined' | 'auto-missed') => {
          const previewText = kind === 'declined'
            ? (lang === 'zh' ? `已拒接：${eventForUi}` : `Declined call: ${eventForUi}`)
            : (lang === 'zh' ? `未接来电：${eventForUi}` : `Missed call: ${eventForUi}`);
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
        };

        if (callAction === 'open_call') {
          // Body-tap: park as `open` so chatActions shows the ringing
          // overlay for the user to confirm accept / decline in-app.
          useAppStore.getState().setPendingCallAction({
            event: callEvent,
            action: 'open',
            at: drained.call.atMs,
          });
        } else if (callAction === 'accept_call') {
          // Accept circle: park as `accept` so the overlay auto-fires
          // its onAccept closure and skips the ringing UI.
          useAppStore.getState().setPendingCallAction({
            event: callEvent,
            action: 'accept',
            at: drained.call.atMs,
          });
          useAppStore.getState().setSystemNotice(lang === 'zh' ? '正在接通…' : 'Connecting…');
        } else if (callAction === 'decline_call' || callAction === 'reject_call') {
          // Decline / legacy reject: park as `decline` and surface a
          // toast + missed-call alert. chatActions.triggerTimedReminderMessage
          // will short-circuit and not show an overlay at all.
          useAppStore.getState().setPendingCallAction({
            event: callEvent,
            action: 'decline',
            at: drained.call.atMs,
          });
          useAppStore.getState().setSystemNotice(lang === 'zh' ? '已拒接' : 'Declined');
          writeMissedAlert(callAction === 'decline_call' ? 'declined' : 'auto-missed');
        }
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
