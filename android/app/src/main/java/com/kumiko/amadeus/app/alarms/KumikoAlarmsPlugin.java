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
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "KumikoAlarms")
public class KumikoAlarmsPlugin extends Plugin {

    private static final String TAG = "KumikoAlarmsPlugin";

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
        AlarmManager am = (AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
        boolean can = false;
        if (am != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                can = am.canScheduleExactAlarms();
            } else {
                can = true;
            }
        }
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
}
