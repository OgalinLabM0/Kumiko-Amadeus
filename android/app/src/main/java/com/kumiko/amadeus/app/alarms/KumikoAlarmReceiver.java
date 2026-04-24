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
import android.os.Build;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.kumiko.amadeus.app.MainActivity;
import com.kumiko.amadeus.app.calls.IncomingCallActivity;

public class KumikoAlarmReceiver extends BroadcastReceiver {

    public static final String EXTRA_REMINDER_ID = "reminder_id";
    public static final String EXTRA_REMINDER_EVENT = "reminder_event";
    public static final String EXTRA_REMINDER_TEXT = "reminder_text";
    public static final String EXTRA_WANTS_CALL = "wants_call";

    public static final String CHANNEL_ID_MESSAGES = "kumiko_messages";
    private static final String TAG = "KumikoAlarmReceiver";

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

            if (reminderId == null) reminderId = "alarm-" + System.currentTimeMillis();
            if (reminderEvent == null) reminderEvent = "提醒";
            if (reminderText == null) reminderText = reminderEvent;

            Log.i(TAG, "Alarm fired: id=" + reminderId + " event=" + reminderEvent + " wantsCall=" + wantsCall);

            if (wantsCall) {
                // Route 1: full-screen incoming call. The activity itself
                // handles ringtone + wake screen + Accept/Reject buttons.
                Intent callIntent = new Intent(context, IncomingCallActivity.class);
                callIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                callIntent.putExtra(EXTRA_REMINDER_ID, reminderId);
                callIntent.putExtra(EXTRA_REMINDER_EVENT, reminderEvent);
                callIntent.putExtra(EXTRA_REMINDER_TEXT, reminderText);
                context.startActivity(callIntent);
            } else {
                // Route 2: text-mode reminder via a normal LocalNotification.
                // Channel kumiko_messages was created by the JS LocalNotifications
                // wrapper (services/capacitorNotifications.ts) on first use;
                // we recreate it here defensively in case the receiver fires
                // before the WebView has ever booted.
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
            }
        } catch (Throwable t) {
            Log.e(TAG, "Failed to dispatch alarm", t);
        } finally {
            try { wakeLock.release(); } catch (Throwable ignored) {}
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
}
