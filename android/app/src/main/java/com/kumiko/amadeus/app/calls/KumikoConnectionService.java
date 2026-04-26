// android/app/src/main/java/com/kumiko/amadeus/app/calls/KumikoConnectionService.java
//
// v2.14.23: self-managed Telecom ConnectionService.
// v2.14.24 update: notification posting consolidated into
// {@link KumikoAlarmsPlugin#postIncomingCallHeadsUp(Context, String, String, String, String)}.
//
// In v2.14.24 the AlarmReceiver always posts the heads-up notification
// FIRST (and starts the ringer FG service), then optionally invokes
// Telecom.addNewIncomingCall as a bonus. So by the time Telecom routes
// the call back here, the heads-up usually already exists for this
// reminder. The dedup map inside {@link KumikoAlarmsPlugin} suppresses
// the duplicate post (see HEADS_UP_DEDUP_WINDOW_MS), and we simply
// delegate without touching the notification surface here.
//
// We still construct a {@link KumikoConnection} so Telecom can render
// its system-level call UI on supported OEMs (Pixel + recent Samsung
// stock). On HyperOS / EMUI / etc. that drops the connection silently,
// the heads-up notification is what the user sees — same as before.

package com.kumiko.amadeus.app.calls;

import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.telecom.Connection;
import android.telecom.ConnectionRequest;
import android.telecom.ConnectionService;
import android.telecom.PhoneAccountHandle;
import android.util.Log;

import androidx.annotation.RequiresApi;

import com.kumiko.amadeus.app.alarms.KumikoAlarmReceiver;
import com.kumiko.amadeus.app.alarms.KumikoAlarmsPlugin;

@RequiresApi(api = Build.VERSION_CODES.O)
public class KumikoConnectionService extends ConnectionService {

    private static final String TAG = "KumikoConnSvc";
    public static final String EXTRA_REMINDER_ID = KumikoAlarmReceiver.EXTRA_REMINDER_ID;
    public static final String EXTRA_REMINDER_EVENT = KumikoAlarmReceiver.EXTRA_REMINDER_EVENT;
    public static final String EXTRA_REMINDER_TEXT = KumikoAlarmReceiver.EXTRA_REMINDER_TEXT;
    public static final String EXTRA_RINGTONE_FILE_ID = KumikoAlarmReceiver.EXTRA_RINGTONE_FILE_ID;

    @Override
    public Connection onCreateIncomingConnection(
        PhoneAccountHandle connectionManagerPhoneAccount,
        ConnectionRequest request
    ) {
        Log.i(TAG, "onCreateIncomingConnection from " + connectionManagerPhoneAccount);

        Bundle extras = request.getExtras();
        Bundle innerExtras = extras != null
            ? extras.getBundle(android.telecom.TelecomManager.EXTRA_INCOMING_CALL_EXTRAS)
            : null;
        Bundle source = innerExtras != null ? innerExtras : (extras != null ? extras : new Bundle());

        String reminderId = source.getString(EXTRA_REMINDER_ID, "telecom-call-" + System.currentTimeMillis());
        String reminderEvent = source.getString(EXTRA_REMINDER_EVENT, "提醒");
        String reminderText = source.getString(EXTRA_REMINDER_TEXT, reminderEvent);
        String ringtoneFileId = source.getString(EXTRA_RINGTONE_FILE_ID, "");

        final Context appContext = getApplicationContext();
        KumikoConnection.IncomingCallUiHandler uiHandler = new KumikoConnection.IncomingCallUiHandler() {
            @Override
            public void show(KumikoConnection connection) {
                // v2.14.24: delegate to KumikoAlarmsPlugin's static helper.
                // It is dedup-aware (HEADS_UP_DEDUP_WINDOW_MS) so when the
                // AlarmReceiver has already posted within the last 5s this
                // call no-ops, avoiding a double notification when both
                // routes fire for the same reminder. PendingIntents in
                // the helper target MainActivity, NOT the deleted
                // IncomingCallActivity.
                KumikoAlarmsPlugin.postIncomingCallHeadsUp(
                    appContext,
                    connection.getReminderId(),
                    connection.getReminderEvent(),
                    connection.getReminderText(),
                    connection.getRingtoneFileId()
                );
                writeSelfTestTimestamp(appContext, KumikoAlarmsPlugin.SELF_TEST_KEY_FSI_LAUNCHED_AT, connection.getReminderId());
            }
            @Override
            public void dismiss(KumikoConnection connection) {
                if (connection.getReminderId() != null) {
                    KumikoAlarmsPlugin.cancelIncomingCallHeadsUp(appContext, connection.getReminderId());
                }
            }
        };

        return new KumikoConnection(uiHandler, reminderId, reminderEvent, reminderText, ringtoneFileId);
    }

    @Override
    public void onCreateIncomingConnectionFailed(
        PhoneAccountHandle connectionManagerPhoneAccount,
        ConnectionRequest request
    ) {
        super.onCreateIncomingConnectionFailed(connectionManagerPhoneAccount, request);
        // v2.14.24: not a problem any more. The AlarmReceiver already
        // posted the heads-up + started the ringer service before invoking
        // Telecom; failure to surface a system-level call UI just means
        // we lose the bonus Pixel/Samsung overlay treatment, the user
        // still sees the heads-up.
        Log.i(TAG, "onCreateIncomingConnectionFailed; heads-up was already posted by AlarmReceiver");
    }
    /**
     * Best-effort self-test stamp writer. We only stamp if the reminderId
     * matches what JS armed via startSelfTestProbe; otherwise this is a
     * production reminder firing during a self-test session and shouldn't
     * pollute the test report.
     */
    private static void writeSelfTestTimestamp(Context context, String key, String reminderId) {
        try {
            android.content.SharedPreferences prefs = context.getSharedPreferences(
                KumikoAlarmsPlugin.SELF_TEST_PREFS, Context.MODE_PRIVATE);
            if (!prefs.getBoolean(KumikoAlarmsPlugin.SELF_TEST_KEY_ARMED, false)) return;
            String armedId = prefs.getString(KumikoAlarmsPlugin.SELF_TEST_KEY_REMINDER_ID, null);
            if (armedId == null || !armedId.equals(reminderId)) return;
            prefs.edit().putLong(key, System.currentTimeMillis()).apply();
        } catch (Throwable t) {
            Log.w(TAG, "writeSelfTestTimestamp failed for " + key, t);
        }
    }
}
