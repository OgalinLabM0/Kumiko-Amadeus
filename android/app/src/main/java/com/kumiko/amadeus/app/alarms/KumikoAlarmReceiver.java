// android/app/src/main/java/com/kumiko/amadeus/app/alarms/KumikoAlarmReceiver.java
//
// B.2 (A6.4): the BroadcastReceiver invoked by AlarmManager when a
// user's scheduled reminder fires. Replaces the JS-side 1-second
// `setInterval` polling that useScheduledReminders runs on PC — on
// Android, polling is power-killer-ish (and gets killed by Doze
// after ~5-15 minutes of background), so we hand the timekeeping
// over to the OS via setExactAndAllowWhileIdle.
//
// Two routing decisions per fire:
//   1. Voice-call mode (config.voiceMode != 'text' AND user is configured
//      with TTS keys) → launch IncomingCallActivity to wake the screen
//      with a full-screen LINE/微信-style call UI.
//   2. Text mode → fall back to a normal LocalNotification using the
//      kumiko_messages channel; user taps to open app.
//
// CRITICAL: the routing decision is made ENTIRELY HERE in native code,
// because the JS WebView may not be alive when the alarm fires. We
// don't have access to the user's TtsConfig from native land, so we
// just encode the choice into the PendingIntent's extras at schedule
// time (see KumikoAlarmsPlugin.scheduleExact). When the receiver
// fires, we read `wantsCall` from extras and act accordingly.
//
// Wake-lock acquired briefly so the system doesn't go back to sleep
// while we post the notification / start the activity. Released after
// the work is done (or after 30s as a hard ceiling, doesn't matter
// because the started Activity / posted Notification keeps the
// system alive on its own once dispatched).

package com.kumiko.amadeus.app.alarms;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.telecom.PhoneAccount;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.kumiko.amadeus.app.MainActivity;
import com.kumiko.amadeus.app.calls.IncomingCallActivity;

public class KumikoAlarmReceiver extends BroadcastReceiver {

    public static final String EXTRA_REMINDER_ID = "reminder_id";
    public static final String EXTRA_REMINDER_EVENT = "reminder_event";
    public static final String EXTRA_REMINDER_TEXT = "reminder_text";
    public static final String EXTRA_WANTS_CALL = "wants_call";
    public static final String EXTRA_RINGTONE_FILE_ID = "ringtone_file_id";
    public static final String EXTRA_TEST_MODE = "test_mode";
    /** v2.14.23: marks the T-5min Xiaomi prewarm alarm. The receiver
     *  treats it as a no-op (just consumes the wake to nudge the kernel
     *  out of deep doze before the real alarm fires). */
    public static final String EXTRA_IS_PREWARM = "is_prewarm";

    public static final String CHANNEL_ID_MESSAGES = "kumiko_messages";
    public static final String CHANNEL_ID_CALLS = "kumiko_calls";
    private static final String TAG = "KumikoAlarmReceiver";
    private static final long[] CALL_VIBRATION_PATTERN = new long[]{0, 650, 250, 650, 250, 900};

    @Override
    public void onReceive(Context context, Intent intent) {
        // Hold a wake lock for ≤30s while we dispatch the notification or
        // start the call activity. Doze / aggressive ROMs can otherwise
        // race us back to sleep before the notification is committed.
        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock wakeLock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "kumiko:alarm-dispatch"
        );
        wakeLock.acquire(30_000L);

        try {
            String reminderId = intent.getStringExtra(EXTRA_REMINDER_ID);
            String reminderEvent = intent.getStringExtra(EXTRA_REMINDER_EVENT);
            String reminderText = intent.getStringExtra(EXTRA_REMINDER_TEXT);
            boolean wantsCall = intent.getBooleanExtra(EXTRA_WANTS_CALL, false);
            String ringtoneFileId = intent.getStringExtra(EXTRA_RINGTONE_FILE_ID);
            boolean isPrewarm = intent.getBooleanExtra(EXTRA_IS_PREWARM, false);

            if (reminderId == null) reminderId = "alarm-" + System.currentTimeMillis();
            if (reminderEvent == null) reminderEvent = "提醒";
            if (reminderText == null) reminderText = reminderEvent;

            // v2.14.23: Xiaomi prewarm alarm. We deliberately do nothing
            // visible here — the kernel-side side-effect (waking us from
            // deep doze 5min before the real alarm) is the entire point.
            // Just log + bail.
            if (isPrewarm) {
                Log.i(TAG, "Prewarm alarm fired (no-op): id=" + reminderId);
                return;
            }

            Log.i(TAG, "Alarm fired: id=" + reminderId + " event=" + reminderEvent + " wantsCall=" + wantsCall);

            // v2.14.23: stamp self-test alarmFiredAt before any user-visible
            // routing happens, so even if the FSI launch fails the JS-side
            // self-test report can show that the alarm did make it past
            // AlarmManager.
            writeSelfTestTimestamp(context, KumikoAlarmsPlugin.SELF_TEST_KEY_ALARM_FIRED_AT, reminderId);

            if (wantsCall) {
                boolean dispatchedViaTelecom = tryDispatchSelfManagedCall(
                    context, reminderId, reminderEvent, reminderText, ringtoneFileId
                );
                if (!dispatchedViaTelecom) {
                    dispatchLegacyFsi(context, reminderId, reminderEvent, reminderText, ringtoneFileId);
                }
            } else {
                // Route 2: text-mode reminder via a normal LocalNotification.
                ensureMessagesChannel(context);

                Intent tapIntent = new Intent(context, MainActivity.class);
                tapIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                tapIntent.putExtra(EXTRA_REMINDER_ID, reminderId);
                int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
                PendingIntent contentPi = PendingIntent.getActivity(context, reminderId.hashCode(), tapIntent, piFlags);

                Notification notification = new NotificationCompat.Builder(context, CHANNEL_ID_MESSAGES)
                    .setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setContentTitle("Kumiko·Amadeus")
                    .setContentText(reminderText)
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(reminderText))
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setCategory(NotificationCompat.CATEGORY_REMINDER)
                    .setContentIntent(contentPi)
                    .setAutoCancel(true)
                    .build();

                NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
                nm.notify(reminderId.hashCode(), notification);
                writeSelfTestTimestamp(context, KumikoAlarmsPlugin.SELF_TEST_KEY_NOTIF_POSTED_AT, reminderId);
            }

            // v2.14.23: alarm has fired; remove its ledger row so a reboot
            // doesn't resurrect it. Do this AFTER dispatch in case
            // posting the notification throws (we'd rather re-fire on
            // reboot than silently drop).
            try {
                KumikoAlarmsPlugin.removeLedgerEntry(context, reminderId);
            } catch (Throwable t) {
                Log.w(TAG, "Failed to remove ledger row after fire (will resurrect on reboot)", t);
            }
        } catch (Throwable t) {
            Log.e(TAG, "Failed to dispatch alarm", t);
        } finally {
            try { wakeLock.release(); } catch (Throwable ignored) {}
        }
    }

    /**
     * v2.14.23: try the Telecom-managed incoming-call path. Returns true
     * iff the framework accepted addNewIncomingCall (which transfers
     * rendering responsibility to KumikoConnectionService); false means
     * caller should fall through to the legacy FSI notification path.
     */
    private boolean tryDispatchSelfManagedCall(
        Context context,
        String reminderId,
        String reminderEvent,
        String reminderText,
        String ringtoneFileId
    ) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false;
        try {
            TelecomManager tm = (TelecomManager) context.getSystemService(Context.TELECOM_SERVICE);
            if (tm == null) return false;
            PhoneAccountHandle handle = KumikoAlarmsPlugin.buildPhoneAccountHandle(context);
            PhoneAccount account = tm.getPhoneAccount(handle);
            if (account == null) return false;
            if (!account.isEnabled()) {
                Log.i(TAG, "PhoneAccount registered but not user-enabled; falling back to legacy FSI");
                return false;
            }

            Bundle innerExtras = new Bundle();
            innerExtras.putString(EXTRA_REMINDER_ID, reminderId);
            innerExtras.putString(EXTRA_REMINDER_EVENT, reminderEvent);
            innerExtras.putString(EXTRA_REMINDER_TEXT, reminderText);
            innerExtras.putString(EXTRA_RINGTONE_FILE_ID, ringtoneFileId != null ? ringtoneFileId : "");

            Bundle outerExtras = new Bundle();
            outerExtras.putBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS, innerExtras);

            tm.addNewIncomingCall(handle, outerExtras);
            return true;
        } catch (SecurityException se) {
            Log.w(TAG, "tryDispatchSelfManagedCall denied (MANAGE_OWN_CALLS missing?)", se);
            return false;
        } catch (Throwable t) {
            Log.w(TAG, "tryDispatchSelfManagedCall failed; falling back to legacy FSI", t);
            return false;
        }
    }

    /**
     * Legacy CATEGORY_CALL + setFullScreenIntent + IncomingCallActivity
     * direct-launch path. This is the v2.14.22 behaviour kept verbatim
     * for ROMs that don't honour self-managed Telecom calls (some MIUI
     * builds before 14, some EMUI 11 PowerGenie configurations).
     */
    private void dispatchLegacyFsi(
        Context context,
        String reminderId,
        String reminderEvent,
        String reminderText,
        String ringtoneFileId
    ) {
        ensureCallsChannel(context);
        Intent callIntent = new Intent(context, IncomingCallActivity.class);
        callIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        callIntent.putExtra(EXTRA_REMINDER_ID, reminderId);
        callIntent.putExtra(EXTRA_REMINDER_EVENT, reminderEvent);
        callIntent.putExtra(EXTRA_REMINDER_TEXT, reminderText);
        callIntent.putExtra(EXTRA_RINGTONE_FILE_ID, ringtoneFileId);

        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent fullScreenPi = PendingIntent.getActivity(
            context,
            reminderId.hashCode(),
            callIntent,
            piFlags
        );

        Uri defaultRingtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        Notification notification = new NotificationCompat.Builder(context, CHANNEL_ID_CALLS)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle("黄前久美子 来电")
            .setContentText(reminderText)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(reminderText))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setFullScreenIntent(fullScreenPi, true)
            .setContentIntent(fullScreenPi)
            .setOngoing(true)
            .setAutoCancel(true)
            .setSound(defaultRingtone)
            .setVibrate(CALL_VIBRATION_PATTERN)
            .build();

        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(reminderId.hashCode(), notification);
        writeSelfTestTimestamp(context, KumikoAlarmsPlugin.SELF_TEST_KEY_NOTIF_POSTED_AT, reminderId);

        try {
            context.startActivity(callIntent);
        } catch (Throwable t) {
            Log.w(TAG, "Direct call activity launch blocked; full-screen notification posted", t);
        }
    }

    private static void writeSelfTestTimestamp(Context context, String key, String reminderId) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(
                KumikoAlarmsPlugin.SELF_TEST_PREFS, Context.MODE_PRIVATE);
            if (!prefs.getBoolean(KumikoAlarmsPlugin.SELF_TEST_KEY_ARMED, false)) return;
            String armedId = prefs.getString(KumikoAlarmsPlugin.SELF_TEST_KEY_REMINDER_ID, null);
            if (armedId == null || !armedId.equals(reminderId)) return;
            prefs.edit().putLong(key, System.currentTimeMillis()).apply();
        } catch (Throwable t) {
            Log.w(TAG, "writeSelfTestTimestamp failed", t);
        }
    }

    private static void ensureMessagesChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel existing = nm.getNotificationChannel(CHANNEL_ID_MESSAGES);
        if (existing != null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID_MESSAGES,
            "新消息 · Messages",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("黄前久美子 主动联络");
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[]{0, 200});
        nm.createNotificationChannel(channel);
    }

    private static void ensureCallsChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel existing = nm.getNotificationChannel(CHANNEL_ID_CALLS);
        if (existing != null) return;

        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID_CALLS,
            "来电提醒 · Calls",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("黄前久美子 来电式提醒");
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        channel.enableVibration(true);
        channel.setVibrationPattern(CALL_VIBRATION_PATTERN);

        Uri defaultRingtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        AudioAttributes attrs = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        channel.setSound(defaultRingtone, attrs);
        nm.createNotificationChannel(channel);
    }
}
