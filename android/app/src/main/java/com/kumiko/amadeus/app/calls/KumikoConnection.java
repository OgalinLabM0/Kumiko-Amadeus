// android/app/src/main/java/com/kumiko/amadeus/app/calls/KumikoConnection.java
//
// v2.14.23: a single self-managed Connection representing one in-flight
// "AI reminder call" through the Android Telecom framework. Created by
// KumikoConnectionService.onCreateIncomingConnection when our plugin
// invokes TelecomManager.addNewIncomingCall().
//
// What's the win over a plain CATEGORY_CALL full-screen notification?
//   - The system treats us as a call client, which on Android 12+
//     bypasses the user-revocable USE_FULL_SCREEN_INTENT permission
//     for incoming-call notifications.
//   - Notification.CallStyle.forIncomingCall renders a dedicated
//     incoming-call UI on the lock screen (avatar + accept/decline)
//     across virtually every OEM, even ones (HyperOS, OneUI) that
//     visibly downgrade ordinary heads-ups.
//   - Doesn't help with battery-saver / force-stop kills (only the
//     foreground-service guardian + manifest <queries> battery-opt
//     deep-link can mitigate those).
//
// CAUTION: this is NOT "Telegram/微信-grade must-arrive". It's just a
// path the system recognises as a call, which gives it slightly
// higher rendering priority than CATEGORY_CALL alone. v2.14.24 makes
// this purely additive — the AlarmReceiver always posts the heads-up
// notification before invoking Telecom, so on ROMs that silently drop
// self-managed connections (some MIUI builds before 14, EMUI 11 with
// PowerGenie, etc.) the user still sees the heads-up.

package com.kumiko.amadeus.app.calls;

import android.os.Build;
import android.telecom.CallAudioState;
import android.telecom.Connection;
import android.telecom.DisconnectCause;
import android.util.Log;

import androidx.annotation.RequiresApi;

@RequiresApi(api = Build.VERSION_CODES.O)
public class KumikoConnection extends Connection {

    private static final String TAG = "KumikoConnection";

    public interface IncomingCallUiHandler {
        void show(KumikoConnection connection);
        void dismiss(KumikoConnection connection);
    }

    private final IncomingCallUiHandler uiHandler;
    private final String reminderId;
    private final String reminderEvent;
    private final String reminderText;
    private final String ringtoneFileId;

    public KumikoConnection(
        IncomingCallUiHandler uiHandler,
        String reminderId,
        String reminderEvent,
        String reminderText,
        String ringtoneFileId
    ) {
        this.uiHandler = uiHandler;
        this.reminderId = reminderId;
        this.reminderEvent = reminderEvent;
        this.reminderText = reminderText;
        this.ringtoneFileId = ringtoneFileId;
        // Audio mode flags: VOIP because we're not a real circuit-switched
        // call. Self-managed connections must specify their audio mode at
        // construction or the framework rejects them.
        setAudioModeIsVoip(true);
        setConnectionProperties(PROPERTY_SELF_MANAGED);
        setRinging();
    }

    public String getReminderId() { return reminderId; }
    public String getReminderEvent() { return reminderEvent; }
    public String getReminderText() { return reminderText; }
    public String getRingtoneFileId() { return ringtoneFileId; }

    @Override
    public void onShowIncomingCallUi() {
        super.onShowIncomingCallUi();
        // The framework calls us here when it wants the app to render its
        // own incoming-call UI. We delegate to KumikoAlarmsPlugin's
        // dedup-aware heads-up helper — typically the receiver has
        // already posted, so this call no-ops; on the rarer pure-Telecom
        // path it posts.
        Log.i(TAG, "onShowIncomingCallUi for " + reminderId);
        try {
            uiHandler.show(this);
        } catch (Throwable t) {
            Log.e(TAG, "Failed to show incoming call UI", t);
            try { setDisconnected(new DisconnectCause(DisconnectCause.ERROR)); } catch (Throwable ignored) {}
            destroy();
        }
    }

    @Override
    public void onAnswer() {
        Log.i(TAG, "onAnswer for " + reminderId);
        setActive();
        uiHandler.dismiss(this);
        // Post the accept action through the kumiko_pending_actions
        // queue MainActivity writes; the WebView drains it on resume
        // and routes through setVoiceCallOverlayData's onAccept. The
        // actual record happens in KumikoConnectionService's caller
        // (or MainActivity onNewIntent) because we need the Context.
    }

    @Override
    public void onReject() {
        Log.i(TAG, "onReject for " + reminderId);
        setDisconnected(new DisconnectCause(DisconnectCause.REJECTED));
        uiHandler.dismiss(this);
        destroy();
    }

    @Override
    public void onDisconnect() {
        Log.i(TAG, "onDisconnect for " + reminderId);
        setDisconnected(new DisconnectCause(DisconnectCause.LOCAL));
        uiHandler.dismiss(this);
        destroy();
    }

    @Override
    public void onAbort() {
        Log.i(TAG, "onAbort for " + reminderId);
        setDisconnected(new DisconnectCause(DisconnectCause.OTHER));
        uiHandler.dismiss(this);
        destroy();
    }

    @Override
    public void onCallAudioStateChanged(CallAudioState state) {
        // We don't actually route audio (TTS playback is owned by
        // KumikoCallRingingService's MediaPlayer), but we still need to
        // override this so the framework's strict-mode checks pass.
        super.onCallAudioStateChanged(state);
    }
}
