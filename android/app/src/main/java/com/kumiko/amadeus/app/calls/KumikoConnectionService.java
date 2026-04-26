// android/app/src/main/java/com/kumiko/amadeus/app/calls/KumikoConnectionService.java
//
// v2.14.23: self-managed Telecom ConnectionService. The system delegates
// incoming-call rendering to us when our plugin invokes
// TelecomManager.addNewIncomingCall() with our PhoneAccountHandle.
//
// Flow at fire-time (chronological, when phoneAccountReady === true):
//   1. KumikoAlarmReceiver.onReceive fires.
//   2. It calls TelecomManager.addNewIncomingCall(handle, extras).
//   3. Telecom routes the request here, onCreateIncomingConnection.
//   4. We construct a KumikoConnection with reminder metadata and
//      return it. Connection.setRinging() puts it in RINGING state.
//   5. Telecom calls KumikoConnection.onShowIncomingCallUi().
//   6. KumikoConnection delegates to UI_HANDLER which posts a
//      Notification.CallStyle.forIncomingCall + setFullScreenIntent
//      pointing back to IncomingCallActivity. On Android 12+ this
//      style is the most reliable lock-screen incoming-call render
//      for self-managed call apps.
//   7. User taps Accept → onAnswer → MainActivity foreground +
//      pending action queue write. User taps Decline → onReject →
//      pending action queue write only.
//
// Fallback: if for any reason we can't construct a Connection (no
// permission, framework refuses, etc.) the framework calls
// onCreateIncomingConnectionFailed and we just no-op; the receiver
// then fires the legacy CATEGORY_CALL FSI path. This is the
// "graceful degradation" we promise the user.

package com.kumiko.amadeus.app.calls;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.content.Context;
import android.content.Intent;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.telecom.Connection;
import android.telecom.ConnectionRequest;
import android.telecom.ConnectionService;
import android.telecom.PhoneAccountHandle;
import android.util.Log;

import androidx.annotation.RequiresApi;
import androidx.core.app.NotificationCompat;

import com.kumiko.amadeus.app.alarms.KumikoAlarmReceiver;
import com.kumiko.amadeus.app.alarms.KumikoAlarmsPlugin;

@RequiresApi(api = Build.VERSION_CODES.O)
public class KumikoConnectionService extends ConnectionService {

    private static final String TAG = "KumikoConnSvc";
    private static final String CHANNEL_ID_CALLS = "kumiko_calls";
    public static final String EXTRA_REMINDER_ID = KumikoAlarmReceiver.EXTRA_REMINDER_ID;
    public static final String EXTRA_REMINDER_EVENT = KumikoAlarmReceiver.EXTRA_REMINDER_EVENT;
    public static final String EXTRA_REMINDER_TEXT = KumikoAlarmReceiver.EXTRA_REMINDER_TEXT;
    public static final String EXTRA_RINGTONE_FILE_ID = KumikoAlarmReceiver.EXTRA_RINGTONE_FILE_ID;
    private static final long[] CALL_VIBRATION_PATTERN = new long[]{0, 650, 250, 650, 250, 900};

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
                postCallStyleNotification(appContext, connection);
                writeSelfTestTimestamp(appContext, KumikoAlarmsPlugin.SELF_TEST_KEY_FSI_LAUNCHED_AT, connection.getReminderId());
            }
            @Override
            public void dismiss(KumikoConnection connection) {
                NotificationManager nm = (NotificationManager) appContext.getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null && connection.getReminderId() != null) {
                    nm.cancel(connection.getReminderId().hashCode());
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
        Log.w(TAG, "onCreateIncomingConnectionFailed; receiver should fall back to legacy FSI");
    }

    /**
     * Posts the Notification.CallStyle.forIncomingCall notification that
     * Telecom expects every self-managed call client to display while a
     * connection is RINGING. The notification points its full-screen
     * intent at IncomingCallActivity (existing FSI UI) so accept/decline
     * inside the activity still works the same way.
     */
    private static void postCallStyleNotification(Context context, KumikoConnection connection) {
        try {
            ensureCallsChannel(context);

            Intent fsi = new Intent(context, IncomingCallActivity.class);
            fsi.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            fsi.putExtra(KumikoAlarmReceiver.EXTRA_REMINDER_ID, connection.getReminderId());
            fsi.putExtra(KumikoAlarmReceiver.EXTRA_REMINDER_EVENT, connection.getReminderEvent());
            fsi.putExtra(KumikoAlarmReceiver.EXTRA_REMINDER_TEXT, connection.getReminderText());
            fsi.putExtra(KumikoAlarmReceiver.EXTRA_RINGTONE_FILE_ID, connection.getRingtoneFileId());

            PendingIntent fullScreenPi = PendingIntent.getActivity(
                context,
                connection.getReminderId().hashCode(),
                fsi,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            // Reject action: send a broadcast / start the activity in
            // reject mode. Simpler to share the same FSI intent here and
            // let onCreate detect a "reject" extra; we go via the
            // Connection's onReject() in Activity.dispatch instead, so
            // these PendingIntents are mostly cosmetic for CallStyle.
            PendingIntent declinePi = PendingIntent.getActivity(
                context,
                connection.getReminderId().hashCode() ^ 0x1,
                buildRejectIntent(context, connection),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            // v2.14.23: when the user taps Accept on the system CallStyle
            // notification we want to auto-dispatch the same way Decline
            // does — otherwise the user taps accept on the system UI then
            // the activity opens and they have to tap accept *again*. The
            // EXTRA_PRESELECTED_ACTION=accept route inside IncomingCallActivity
            // skips its own UI render and goes straight to dispatch().
            Intent acceptIntent = new Intent(context, IncomingCallActivity.class);
            acceptIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            acceptIntent.putExtra(KumikoAlarmReceiver.EXTRA_REMINDER_ID, connection.getReminderId());
            acceptIntent.putExtra(KumikoAlarmReceiver.EXTRA_REMINDER_EVENT, connection.getReminderEvent());
            acceptIntent.putExtra(KumikoAlarmReceiver.EXTRA_REMINDER_TEXT, connection.getReminderText());
            acceptIntent.putExtra(KumikoAlarmReceiver.EXTRA_RINGTONE_FILE_ID, connection.getRingtoneFileId());
            acceptIntent.putExtra(IncomingCallActivity.EXTRA_PRESELECTED_ACTION, IncomingCallActivity.PENDING_ACTION_ACCEPT);
            PendingIntent acceptPi = PendingIntent.getActivity(
                context,
                connection.getReminderId().hashCode() ^ 0x2,
                acceptIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            Uri ringtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID_CALLS)
                .setSmallIcon(android.R.drawable.sym_call_incoming)
                .setContentTitle(connection.getReminderEvent())
                .setContentText(connection.getReminderText())
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setFullScreenIntent(fullScreenPi, true)
                .setContentIntent(fullScreenPi)
                .setOngoing(true)
                .setAutoCancel(true)
                .setSound(ringtone)
                .setVibrate(CALL_VIBRATION_PATTERN);

            // Notification.CallStyle.forIncomingCall is API 31+. On older
            // devices we just rely on PRIORITY_MAX + CATEGORY_CALL +
            // setFullScreenIntent which is the recommended pre-31 shape.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                Person caller = new Person.Builder()
                    .setName(connection.getReminderEvent())
                    .setImportant(true)
                    .build();
                Notification.CallStyle style = Notification.CallStyle
                    .forIncomingCall(caller, declinePi, acceptPi);
                Notification.Builder native31Builder = new Notification.Builder(context, CHANNEL_ID_CALLS)
                    .setSmallIcon(android.R.drawable.sym_call_incoming)
                    .setContentTitle(connection.getReminderEvent())
                    .setContentText(connection.getReminderText())
                    .setCategory(Notification.CATEGORY_CALL)
                    .setVisibility(Notification.VISIBILITY_PUBLIC)
                    .setFullScreenIntent(fullScreenPi, true)
                    .setOngoing(true)
                    .setStyle(style);
                Notification notif = native31Builder.build();
                NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) nm.notify(connection.getReminderId().hashCode(), notif);
            } else {
                NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) nm.notify(connection.getReminderId().hashCode(), builder.build());
            }
            writeSelfTestTimestamp(context, KumikoAlarmsPlugin.SELF_TEST_KEY_NOTIF_POSTED_AT, connection.getReminderId());
        } catch (Throwable t) {
            Log.e(TAG, "Failed to post CallStyle FSI notification", t);
        }
    }

    private static Intent buildRejectIntent(Context context, KumikoConnection connection) {
        Intent intent = new Intent(context, IncomingCallActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra(KumikoAlarmReceiver.EXTRA_REMINDER_ID, connection.getReminderId());
        intent.putExtra(KumikoAlarmReceiver.EXTRA_REMINDER_EVENT, connection.getReminderEvent());
        intent.putExtra(KumikoAlarmReceiver.EXTRA_REMINDER_TEXT, connection.getReminderText());
        intent.putExtra(KumikoAlarmReceiver.EXTRA_RINGTONE_FILE_ID, connection.getRingtoneFileId());
        intent.putExtra(IncomingCallActivity.EXTRA_PRESELECTED_ACTION, IncomingCallActivity.PENDING_ACTION_REJECT);
        return intent;
    }

    private static void ensureCallsChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID_CALLS) != null) return;
        android.app.NotificationChannel channel = new android.app.NotificationChannel(
            CHANNEL_ID_CALLS,
            "来电提醒 · Calls",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        channel.enableVibration(true);
        channel.setVibrationPattern(CALL_VIBRATION_PATTERN);
        Uri ringtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        android.media.AudioAttributes attrs = new android.media.AudioAttributes.Builder()
            .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        channel.setSound(ringtone, attrs);
        nm.createNotificationChannel(channel);
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
