// android/app/src/main/java/com/kumiko/amadeus/app/alarms/KumikoAlarmsPlugin.java
//
// B.2 (A6.4): Capacitor plugin exposing AlarmManager.setExactAndAllowWhileIdle
// to JS. Replaces useScheduledReminders' 1s setInterval polling that doesn't
// survive Android Doze. JS calls scheduleExact / cancel / cancelAll, which
// schedule a PendingIntent against KumikoAlarmReceiver. When the alarm fires
// the receiver routes to either a notification or IncomingCallActivity (B.3).
//
// Why our own plugin instead of @capawesome-team/capacitor-alarm or similar?
//   - We need full control over the receiver's behaviour (route to call
//     activity vs notification based on TtsConfig at schedule time)
//   - Off-the-shelf plugins typically just wrap setExactAndAllowWhileIdle
//     and dispatch a JS callback when the alarm fires; that callback only
//     works if the WebView is alive, defeating the purpose
//   - Plugin surface is small enough (3 methods) to roll our own
//
// Permissions: SCHEDULE_EXACT_ALARM is a "user-revocable" runtime permission
// on Android 12+. We check canScheduleExactAlarms() via AlarmManager and
// fall back to setAndAllowWhileIdle (inexact, ±15min) if denied. The
// settings UI surfaces a request flow when needed.

package com.kumiko.amadeus.app.alarms;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.Settings;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.kumiko.amadeus.app.MainActivity;
import com.kumiko.amadeus.app.calls.IncomingCallActivity;

@CapacitorPlugin(name = "KumikoAlarms")
public class KumikoAlarmsPlugin extends Plugin {

    private static final String TAG = "KumikoAlarmsPlugin";
    private static final String CHANNEL_ID_MESSAGES = "kumiko_messages";
    private static final String CHANNEL_ID_CALLS = "kumiko_calls";
    private static final int TEST_MESSAGE_NOTIFICATION_ID = 921021;
    private static final int TEST_CALL_NOTIFICATION_ID = 921022;
    private static final long[] MESSAGE_VIBRATION_PATTERN = new long[]{0, 200};
    private static final long[] CALL_VIBRATION_PATTERN = new long[]{0, 650, 250, 650, 250, 900};

    @PluginMethod
    public void scheduleExact(PluginCall call) {
        String reminderId = call.getString("reminderId");
        if (reminderId == null || reminderId.isEmpty()) {
            call.reject("reminderId required");
            return;
        }
        Long atMs = call.getLong("at");
        if (atMs == null || atMs <= 0) {
            call.reject("at (epoch ms) required");
            return;
        }
        String reminderEvent = call.getString("event", "提醒");
        String reminderText = call.getString("text", reminderEvent);
        boolean wantsCall = Boolean.TRUE.equals(call.getBoolean("wantsCall", false));
        String ringtoneFileId = call.getString("ringtoneFileId", "");

        Context context = getContext();
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) {
            call.reject("AlarmManager unavailable");
            return;
        }

        Intent receiverIntent = new Intent(context, KumikoAlarmReceiver.class);
        receiverIntent.putExtra(KumikoAlarmReceiver.EXTRA_REMINDER_ID, reminderId);
        receiverIntent.putExtra(KumikoAlarmReceiver.EXTRA_REMINDER_EVENT, reminderEvent);
        receiverIntent.putExtra(KumikoAlarmReceiver.EXTRA_REMINDER_TEXT, reminderText);
        receiverIntent.putExtra(KumikoAlarmReceiver.EXTRA_WANTS_CALL, wantsCall);
        receiverIntent.putExtra(KumikoAlarmReceiver.EXTRA_RINGTONE_FILE_ID, ringtoneFileId);

        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getBroadcast(
            context,
            reminderId.hashCode(),
            receiverIntent,
            piFlags
        );

        boolean exactScheduled = false;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (am.canScheduleExactAlarms()) {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pi);
                    exactScheduled = true;
                } else {
                    Log.w(TAG, "Exact alarm permission denied; falling back to inexact");
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pi);
                }
            } else {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pi);
                exactScheduled = true;
            }
        } catch (SecurityException se) {
            Log.w(TAG, "SecurityException scheduling exact alarm; falling back to inexact", se);
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pi);
        } catch (Throwable t) {
            // Capacitor 7's PluginCall.reject signature is (message, code?,
            // exception?) where exception must be Exception, not Throwable.
            // Stringify and log separately to keep the JS side message clean.
            Log.e(TAG, "Schedule failed", t);
            call.reject("Schedule failed: " + t.getMessage());
            return;
        }

        JSObject ret = new JSObject();
        ret.put("scheduled", true);
        ret.put("exact", exactScheduled);
        ret.put("at", atMs);
        ret.put("reminderId", reminderId);
        call.resolve(ret);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String reminderId = call.getString("reminderId");
        if (reminderId == null || reminderId.isEmpty()) {
            call.reject("reminderId required");
            return;
        }
        Context context = getContext();
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) {
            call.reject("AlarmManager unavailable");
            return;
        }
        Intent receiverIntent = new Intent(context, KumikoAlarmReceiver.class);
        int piFlags = PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getBroadcast(
            context,
            reminderId.hashCode(),
            receiverIntent,
            piFlags
        );
        if (pi != null) {
            am.cancel(pi);
            pi.cancel();
        }
        JSObject ret = new JSObject();
        ret.put("cancelled", pi != null);
        call.resolve(ret);
    }

    @PluginMethod
    public void canScheduleExact(PluginCall call) {
        boolean can = canScheduleExactAlarmNow(getContext());
        JSObject ret = new JSObject();
        ret.put("canScheduleExact", can);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestExactAlarmPermission(PluginCall call) {
        // Open the system settings page where the user can grant
        // SCHEDULE_EXACT_ALARM. Best-effort — caller should re-check
        // canScheduleExact() after the user returns.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                Intent settings = new Intent(android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
                settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(settings);
                call.resolve();
                return;
            } catch (Throwable t) {
                Log.w(TAG, "Could not open exact-alarm settings", t);
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void canUseFullScreenIntent(PluginCall call) {
        boolean can = canUseFullScreenIntentNow(getContext());
        JSObject ret = new JSObject();
        ret.put("canUseFullScreenIntent", can);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestFullScreenIntentPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            Context context = getContext();
            try {
                Intent settings = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT);
                settings.setData(Uri.parse("package:" + context.getPackageName()));
                settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(settings);
                call.resolve();
                return;
            } catch (Throwable t) {
                Log.w(TAG, "Could not open full-screen intent settings; falling back to app notification settings", t);
                try {
                    Intent fallback = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                    fallback.putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
                    fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    context.startActivity(fallback);
                    call.resolve();
                    return;
                } catch (Throwable t2) {
                    Log.w(TAG, "Could not open app notification settings", t2);
                }
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void getAlertPermissionStatus(PluginCall call) {
        Context context = getContext();
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        boolean notificationsEnabled = NotificationManagerCompat.from(context).areNotificationsEnabled();
        boolean messagesChannelReady = isChannelUsable(nm, CHANNEL_ID_MESSAGES);
        boolean callsChannelReady = isChannelUsable(nm, CHANNEL_ID_CALLS);

        JSObject ret = new JSObject();
        ret.put("sdkInt", Build.VERSION.SDK_INT);
        ret.put("notificationsEnabled", notificationsEnabled);
        ret.put("messagesChannelReady", messagesChannelReady);
        ret.put("callsChannelReady", callsChannelReady);
        ret.put("exactAlarmReady", canScheduleExactAlarmNow(context));
        ret.put("fullScreenIntentReady", canUseFullScreenIntentNow(context));
        call.resolve(ret);
    }

    @PluginMethod
    public void openAppNotificationSettings(PluginCall call) {
        Context context = getContext();
        try {
            Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            intent.putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } catch (Throwable t) {
            Log.w(TAG, "Could not open app notification settings", t);
            try {
                Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                fallback.setData(Uri.parse("package:" + context.getPackageName()));
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(fallback);
            } catch (Throwable t2) {
                Log.w(TAG, "Could not open app details settings", t2);
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void postTestMessageNotification(PluginCall call) {
        Context context = getContext();
        try {
            ensureMessagesChannel(context);
            String title = call.getString("title", "Kumiko·Amadeus");
            String body = call.getString("body", "Android notification test");

            Intent tapIntent = new Intent(context, MainActivity.class);
            tapIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent contentPi = PendingIntent.getActivity(
                context,
                TEST_MESSAGE_NOTIFICATION_ID,
                tapIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            Notification notification = new NotificationCompat.Builder(context, CHANNEL_ID_MESSAGES)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setContentIntent(contentPi)
                .setAutoCancel(true)
                .setVibrate(MESSAGE_VIBRATION_PATTERN)
                .build();

            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) {
                call.reject("NotificationManager unavailable");
                return;
            }
            nm.notify(TEST_MESSAGE_NOTIFICATION_ID, notification);
            vibrate(context, MESSAGE_VIBRATION_PATTERN, -1);
            JSObject ret = new JSObject();
            ret.put("posted", true);
            call.resolve(ret);
        } catch (Throwable t) {
            Log.e(TAG, "Test message notification failed", t);
            call.reject("Test message notification failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void postTestIncomingCall(PluginCall call) {
        Context context = getContext();
        try {
            ensureCallsChannel(context);
            String title = call.getString("title", "黄前久美子 来电测试");
            String body = call.getString("body", "来电弹窗 / 铃声 / 震动测试");
            String ringtoneFileId = call.getString("ringtoneFileId", "");

            Intent callIntent = new Intent(context, IncomingCallActivity.class);
            callIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            callIntent.putExtra(KumikoAlarmReceiver.EXTRA_REMINDER_ID, "test-incoming-call");
            callIntent.putExtra(KumikoAlarmReceiver.EXTRA_REMINDER_EVENT, title);
            callIntent.putExtra(KumikoAlarmReceiver.EXTRA_REMINDER_TEXT, body);
            callIntent.putExtra(KumikoAlarmReceiver.EXTRA_RINGTONE_FILE_ID, ringtoneFileId);
            callIntent.putExtra(KumikoAlarmReceiver.EXTRA_TEST_MODE, true);

            PendingIntent fullScreenPi = PendingIntent.getActivity(
                context,
                TEST_CALL_NOTIFICATION_ID,
                callIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            Notification notification = new NotificationCompat.Builder(context, CHANNEL_ID_CALLS)
                .setSmallIcon(android.R.drawable.sym_call_incoming)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setFullScreenIntent(fullScreenPi, true)
                .setContentIntent(fullScreenPi)
                .setOngoing(true)
                .setAutoCancel(true)
                .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
                .setVibrate(CALL_VIBRATION_PATTERN)
                .build();

            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) {
                call.reject("NotificationManager unavailable");
                return;
            }
            nm.notify(TEST_CALL_NOTIFICATION_ID, notification);
            context.startActivity(callIntent);
            JSObject ret = new JSObject();
            ret.put("posted", true);
            call.resolve(ret);
        } catch (Throwable t) {
            Log.e(TAG, "Test incoming call failed", t);
            call.reject("Test incoming call failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void cancelTestNotifications(PluginCall call) {
        try {
            NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.cancel(TEST_MESSAGE_NOTIFICATION_ID);
                nm.cancel(TEST_CALL_NOTIFICATION_ID);
                nm.cancel("test-incoming-call".hashCode());
            }
        } catch (Throwable t) {
            Log.w(TAG, "Cancel test notifications failed", t);
        }
        call.resolve();
    }

    @PluginMethod
    public void drainPendingActions(PluginCall call) {
        // Drain SharedPreferences entries that IncomingCallActivity (call
        // accept/reject) and RemoteReplyReceiver (Direct Reply text) wrote
        // while the WebView was offline. Returns a snapshot to JS, which
        // then replays them through the normal message pipeline.
        JSObject result = new JSObject();

        android.content.SharedPreferences callPrefs = getContext()
            .getSharedPreferences("kumiko_pending_actions", Context.MODE_PRIVATE);
        String lastAction = callPrefs.getString("last_action", null);
        if (lastAction != null) {
            JSObject call0 = new JSObject();
            call0.put("action", lastAction);
            call0.put("reminderId", callPrefs.getString("last_reminder_id", null));
            call0.put("reminderEvent", callPrefs.getString("last_reminder_event", null));
            call0.put("at", callPrefs.getLong("last_action_at", 0));
            result.put("callAction", call0);
            callPrefs.edit().clear().apply();
        }

        android.content.SharedPreferences replyPrefs = getContext()
            .getSharedPreferences("kumiko_pending_replies", Context.MODE_PRIVATE);
        String queueRaw = replyPrefs.getString("queue", "[]");
        result.put("repliesJson", queueRaw);
        replyPrefs.edit().clear().apply();

        call.resolve(result);
    }

    private static boolean canScheduleExactAlarmNow(Context context) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return am.canScheduleExactAlarms();
        return true;
    }

    private static boolean canUseFullScreenIntentNow(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true;
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        return nm != null && nm.canUseFullScreenIntent();
    }

    private static boolean isChannelUsable(NotificationManager nm, String channelId) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        if (nm == null) return false;
        NotificationChannel channel = nm.getNotificationChannel(channelId);
        return channel != null && channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    private static void ensureMessagesChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID_MESSAGES) != null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID_MESSAGES,
            "新消息 · Messages",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("黄前久美子 主动联络");
        channel.enableVibration(true);
        channel.setVibrationPattern(MESSAGE_VIBRATION_PATTERN);
        nm.createNotificationChannel(channel);
    }

    private static void ensureCallsChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID_CALLS) != null) return;

        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID_CALLS,
            "来电提醒 · Calls",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("黄前久美子 来电式提醒");
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        channel.enableVibration(true);
        channel.setVibrationPattern(CALL_VIBRATION_PATTERN);
        AudioAttributes attrs = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        channel.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), attrs);
        nm.createNotificationChannel(channel);
    }

    private static void vibrate(Context context, long[] pattern, int repeat) {
        try {
            Vibrator vibrator;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                VibratorManager manager = (VibratorManager) context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                vibrator = manager != null ? manager.getDefaultVibrator() : null;
            } else {
                //noinspection deprecation
                vibrator = (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
            }
            if (vibrator == null || !vibrator.hasVibrator()) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, repeat));
            } else {
                //noinspection deprecation
                vibrator.vibrate(pattern, repeat);
            }
        } catch (Throwable t) {
            Log.w(TAG, "Vibration failed", t);
        }
    }
}
