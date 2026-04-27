// android/app/src/main/java/com/kumiko/amadeus/app/alarms/KumikoAlarmsPlugin.java
//
// v2.14.27: drastically slimmed-down "lightweight scheduler" plugin. The
// pre-v2.14.27 plugin tried to be the entire reminder runtime — it owned
// notifications, ringtones, Telecom self-managed calls, OEM permission
// detection, deep self-test probes, and a session-storage bridge health
// tracker. v2.14.25-26 still couldn't make all of that reliable on
// HyperOS / OneUI / EMUI, so we cut almost everything and now defer to
// the @capacitor/local-notifications plugin (the "fallback path" that
// was already working) for every actually-user-visible notification.
//
// What this plugin still does (kept):
//   - scheduleExact / cancel — drive AlarmManager.setExactAndAllowWhileIdle
//     and the SharedPreferences ledger so reboots don't drop reminders
//   - prewarm — cheap no-op to amortise Capacitor's bridge cold-start cost
//   - canScheduleExact / requestExactAlarmPermission
//   - canUseFullScreenIntent / requestFullScreenIntentPermission
//   - openSettings(key) — generic deep link to a notification / exact
//     alarm / FSI / battery optimization / app details system page
//   - drainPendingActions — drain the pending-call/Direct Reply prefs
//   - the alarm guardian FGS lifecycle (start at scheduleExact, stop at
//     last cancel, plus REMINDER_DISPATCH short-lived upgrade)
//   - the v3 channel migration (created by LocalNotifications too;
//     migration just clears the legacy v1/v2 channels)
//   - notifyAlarmFired — STATIC helper called from MainActivity when the
//     receiver wakes us; bridges the payload into a kumikoAlarmFired JS
//     event the JS-side useScheduledReminders hook listens for. Falls
//     back to SharedPreferences if the plugin instance hasn't loaded yet
//     (the JS listener flushes the queue once load() runs).
//
// What's gone (deleted in v2.14.27):
//   - getAlertPermissionStatus / getOemDeviceInfo / openVendorSetting —
//     replaced by the simplified PermissionStatusSnapshot in
//     services/androidAlertPermissionService.ts which only consumes
//     LocalNotifications.checkPermissions() + the 2 boolean probes here
//   - postTestMessageNotification / postTestIncomingCall / cancelTest…
//     — JS now calls LocalNotifications.schedule directly for tests
//   - postIncomingCallHeadsUp / cancelIncomingCallHeadsUp / CallStyle
//     pipeline — silent activity wake + LocalNotifications instead
//   - registerPhoneAccount / unregisterPhoneAccount /
//     openPhoneAccountSettings / isPhoneAccountRegistered / Telecom
//     self-managed integration — KumikoConnectionService deleted
//   - KumikoCallRingingService start/stop — service deleted
//   - startSelfTestProbe / collectSelfTestReport — JS-side test harness
//     trimmed to a single LocalNotifications-driven happy path
//   - requestIgnoreBatteryOptimization / isIgnoringBatteryOptimizations —
//     no reliable cross-OEM probe; UI now just deep-links
//   - 4-thread executor + withIpcTimeout — without the heavy IPCs
//     (Telecom/AppOps/PowerManager probes) the surface no longer needs
//     bulkhead protection; reverted to a single-thread executor.

package com.kumiko.amadeus.app.alarms;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "KumikoAlarms")
public class KumikoAlarmsPlugin extends Plugin {

    private static final String TAG = "KumikoAlarmsPlugin";

    /** v2.14.24-27: notification channels still owned by the migration
     *  helper because LocalNotifications can post on these channelIds and
     *  we want the v3 settings (DND bypass on calls, lockscreen visibility,
     *  vibration patterns) applied before the first JS-side notification
     *  fires. */
    public static final String CHANNEL_ID_MESSAGES = "kumiko_messages_v3";
    public static final String CHANNEL_ID_CALLS = "kumiko_calls_v3";
    private static final String[] LEGACY_CHANNEL_IDS = new String[] {
        "kumiko_messages",
        "kumiko_messages_v2",
        "kumiko_calls",
        "kumiko_calls_v2",
    };
    private static final String CHANNEL_MIGRATION_PREFS = "kumiko_channel_migration";
    private static final String CHANNEL_MIGRATION_KEY_V3 = "v3_done";

    // v2.14.24: explicit "two short taps" vs "long persistent ring" patterns
    // so the user can audibly distinguish a passive message notification
    // from a reminder-call without looking at the screen.
    public static final long[] MESSAGE_VIBRATION_PATTERN = new long[]{0, 250, 120, 250};
    public static final long[] CALL_VIBRATION_PATTERN = new long[]{0, 800, 600, 800, 600, 800, 600, 800};

    // v2.14.23: native ledger keys. Each entry is a JSON blob keyed by
    // reminderId so KumikoBootReceiver can rebuild AlarmManager state
    // after BOOT_COMPLETED / MY_PACKAGE_REPLACED.
    public static final String LEDGER_PREFS = "kumiko_alarm_ledger";
    public static final String LEDGER_KEY_PREFIX = "alarm:";

    // v2.14.23: Xiaomi/HyperOS prewarm-alarm reminder-id suffix.
    public static final String PREWARM_REMINDER_SUFFIX = "::prewarm";

    /** v2.14.27: pending-alarm-fired queue for cold-start replay. When the
     *  receiver wakes us before the plugin's load() ran, the silent
     *  activity launch still gets to MainActivity but the plugin instance
     *  isn't alive yet to fire kumikoAlarmFired listeners — those events
     *  haven't been registered on the JS side either. We persist the
     *  payload(s) here and flush once the plugin loads.  */
    private static final String PENDING_ALARM_FIRED_PREFS = "kumiko_pending_alarm_fired";
    private static final String PENDING_ALARM_FIRED_KEY = "queue";

    private static final int PREWARM_REQUEST_CODE_OFFSET = 0x10000000;

    // v2.14.27: single-thread executor is enough for the slim surface
    // (no Telecom/AppOps probes left). Keeps plugin call bodies off the
    // WebView main thread without bridge contention.
    private static final ExecutorService PLUGIN_EXECUTOR = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "kumiko-alarms-worker");
        t.setDaemon(true);
        return t;
    });

    private static final ExecutorService LOAD_EXECUTOR = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "kumiko-alarms-load");
        t.setDaemon(true);
        return t;
    });

    /** v2.14.27: live plugin instance, set in load(). Used by the static
     *  notifyAlarmFired bridge so MainActivity can dispatch a JS event
     *  without holding a hard reference to this object. */
    private static volatile KumikoAlarmsPlugin INSTANCE;

    /**
     * Helper that dispatches a {@link PluginCall} body to the shared
     * worker, with a global try/catch that converts any uncaught Throwable
     * into a {@code call.reject(...)}. Without this catch, an exception
     * inside the lambda would leak the PluginCall (never resolved or
     * rejected).
     */
    private void onWorker(PluginCall call, String label, Runnable body) {
        PLUGIN_EXECUTOR.execute(() -> {
            try {
                body.run();
            } catch (Throwable t) {
                Log.e(TAG, label + " native body crashed", t);
                try {
                    call.reject("native crash in " + label + ": " + t.getMessage());
                } catch (Throwable ignored) {
                    // PluginCall may already be resolved/rejected; nothing more to do.
                }
            }
        });
    }

    @Override
    public void load() {
        super.load();
        INSTANCE = this;
        Context ctx = getContext();
        LOAD_EXECUTOR.execute(() -> {
            try {
                runChannelMigrationToV3(ctx);
                ensureMessagesChannel(ctx);
                ensureCallsChannel(ctx);
            } catch (Throwable t) {
                Log.w(TAG, "Channel setup at load() failed (non-fatal)", t);
            }
            // v2.14.27: drain any alarm-fired payloads that arrived before
            // load(). Each emits a kumikoAlarmFired listener event so the
            // JS-side useScheduledReminders force-tick can run.
            try {
                drainPendingAlarmFired(ctx);
            } catch (Throwable t) {
                Log.w(TAG, "drainPendingAlarmFired failed", t);
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (INSTANCE == this) INSTANCE = null;
        super.handleOnDestroy();
    }

    public static void runChannelMigrationToV3(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        SharedPreferences prefs = context.getSharedPreferences(CHANNEL_MIGRATION_PREFS, Context.MODE_PRIVATE);
        if (prefs.getBoolean(CHANNEL_MIGRATION_KEY_V3, false)) return;
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        for (String legacy : LEGACY_CHANNEL_IDS) {
            try {
                nm.deleteNotificationChannel(legacy);
            } catch (Throwable t) {
                Log.w(TAG, "deleteNotificationChannel(" + legacy + ") failed", t);
            }
        }
        prefs.edit().putBoolean(CHANNEL_MIGRATION_KEY_V3, true).apply();
        Log.i(TAG, "Channel migration v3 complete; legacy channels deleted");
    }

    // === @PluginMethod surface (slim) ================================

    @PluginMethod
    public void scheduleExact(PluginCall call) {
        onWorker(call, "scheduleExact", () -> {
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

            boolean exactScheduled = scheduleAlarmInternal(
                context, am, reminderId, atMs, reminderEvent, reminderText, wantsCall, ringtoneFileId, /*isPrewarm*/ false
            );

            try {
                persistLedgerEntry(context, reminderId, atMs, reminderEvent, reminderText, wantsCall, ringtoneFileId);
            } catch (Throwable t) {
                Log.w(TAG, "Failed to persist ledger entry; reboot recovery may not work", t);
            }

            // v2.14.23: Xiaomi/HyperOS double-alarm prewarm.
            long delayMs = atMs - System.currentTimeMillis();
            boolean prewarmScheduled = false;
            if (isXiaomiHyperOs() && delayMs >= 10L * 60_000L) {
                long prewarmAt = atMs - 5L * 60_000L;
                try {
                    prewarmScheduled = scheduleAlarmInternal(
                        context, am, reminderId + PREWARM_REMINDER_SUFFIX, prewarmAt,
                        reminderEvent, reminderText, wantsCall, ringtoneFileId, /*isPrewarm*/ true
                    );
                } catch (Throwable t) {
                    Log.w(TAG, "Failed to schedule Xiaomi prewarm alarm; main alarm still scheduled", t);
                }
            }

            try {
                startGuardianService(context, "scheduleExact");
            } catch (Throwable t) {
                Log.w(TAG, "Could not start alarm guardian; alarm still scheduled but priority lower", t);
            }

            JSObject ret = new JSObject();
            ret.put("scheduled", true);
            ret.put("exact", exactScheduled);
            ret.put("at", atMs);
            ret.put("reminderId", reminderId);
            ret.put("prewarmScheduled", prewarmScheduled);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        onWorker(call, "cancel", () -> {
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

            boolean cancelledMain = cancelAlarmInternal(context, am, reminderId, /*isPrewarm*/ false);
            cancelAlarmInternal(context, am, reminderId, /*isPrewarm*/ true);

            try {
                removeLedgerEntry(context, reminderId);
            } catch (Throwable t) {
                Log.w(TAG, "Failed to remove ledger entry for " + reminderId, t);
            }

            JSObject ret = new JSObject();
            ret.put("cancelled", cancelledMain);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void canScheduleExact(PluginCall call) {
        onWorker(call, "canScheduleExact", () -> {
            boolean can = canScheduleExactAlarmNow(getContext());
            JSObject ret = new JSObject();
            ret.put("canScheduleExact", can);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void requestExactAlarmPermission(PluginCall call) {
        onWorker(call, "requestExactAlarmPermission", () -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                try {
                    Intent settings = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
                    settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(settings);
                } catch (Throwable t) {
                    Log.w(TAG, "Could not open exact-alarm settings", t);
                }
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void canUseFullScreenIntent(PluginCall call) {
        onWorker(call, "canUseFullScreenIntent", () -> {
            boolean can = canUseFullScreenIntentNow(getContext());
            JSObject ret = new JSObject();
            ret.put("canUseFullScreenIntent", can);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void requestFullScreenIntentPermission(PluginCall call) {
        onWorker(call, "requestFullScreenIntentPermission", () -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                Context context = getContext();
                try {
                    Intent settings = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT);
                    settings.setData(Uri.parse("package:" + context.getPackageName()));
                    settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    context.startActivity(settings);
                } catch (Throwable t) {
                    Log.w(TAG, "Could not open full-screen intent settings; falling back to app notification settings", t);
                    try {
                        Intent fallback = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                        fallback.putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
                        fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        context.startActivity(fallback);
                    } catch (Throwable t2) {
                        Log.w(TAG, "Could not open app notification settings either", t2);
                    }
                }
            }
            call.resolve();
        });
    }

    /**
     * v2.14.27: generic deep link to a system settings page so the JS UI
     * can stop maintaining N specialised methods. Supported keys:
     *   - "notifications"      → Settings.ACTION_APP_NOTIFICATION_SETTINGS
     *   - "exactAlarm"         → ACTION_REQUEST_SCHEDULE_EXACT_ALARM
     *   - "fullScreenIntent"   → ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT
     *   - "batteryOptimization"→ ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
     *                            (falls back to the global list if the
     *                             per-app dialog isn't available)
     *   - "appDetails"         → ACTION_APPLICATION_DETAILS_SETTINGS
     */
    @PluginMethod
    public void openSettings(PluginCall call) {
        onWorker(call, "openSettings", () -> {
            String key = call.getString("key", "");
            if (key == null) key = "";
            Context context = getContext();
            boolean opened = false;
            try {
                Intent intent = buildSettingsIntent(context, key);
                if (intent != null) {
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    context.startActivity(intent);
                    opened = true;
                }
            } catch (Throwable t) {
                Log.w(TAG, "openSettings(" + key + ") primary path failed; trying app details fallback", t);
                try {
                    Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                    fallback.setData(Uri.parse("package:" + context.getPackageName()));
                    fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    context.startActivity(fallback);
                    opened = true;
                } catch (Throwable t2) {
                    Log.w(TAG, "openSettings app details fallback also failed", t2);
                }
            }
            JSObject ret = new JSObject();
            ret.put("opened", opened);
            call.resolve(ret);
        });
    }

    private static Intent buildSettingsIntent(Context context, String key) {
        switch (key) {
            case "notifications": {
                Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                intent.putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
                return intent;
            }
            case "exactAlarm":
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    return new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
                }
                return null;
            case "fullScreenIntent":
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    Intent intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT);
                    intent.setData(Uri.parse("package:" + context.getPackageName()));
                    return intent;
                }
                return null;
            case "batteryOptimization": {
                Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                intent.setData(Uri.parse("package:" + context.getPackageName()));
                return intent;
            }
            case "appDetails":
            default: {
                Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                intent.setData(Uri.parse("package:" + context.getPackageName()));
                return intent;
            }
        }
    }

    /**
     * v2.14.23: cheap no-op invoked by JS at startup to amortise
     * Capacitor's plugin-bridge cold-start cost. Returning a stable
     * JSObject forces the bridge descriptor to resolve.
     */
    @PluginMethod
    public void prewarm(PluginCall call) {
        onWorker(call, "prewarm", () -> {
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void drainPendingActions(PluginCall call) {
        onWorker(call, "drainPendingActions", () -> {
            // Drain SharedPreferences entries that MainActivity (legacy
            // call open/accept/decline from heads-up tap, kept for upgrade
            // compatibility) and RemoteReplyReceiver (Direct Reply text)
            // wrote while the WebView was offline.
            JSObject result = new JSObject();

            SharedPreferences callPrefs = getContext()
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

            SharedPreferences replyPrefs = getContext()
                .getSharedPreferences("kumiko_pending_replies", Context.MODE_PRIVATE);
            String queueRaw = replyPrefs.getString("queue", "[]");
            result.put("repliesJson", queueRaw);
            replyPrefs.edit().clear().apply();

            call.resolve(result);
        });
    }

    // === Static helpers used by Receivers / Services / MainActivity ===

    /**
     * v2.14.27: bridge an alarm-fired payload from {@link
     * com.kumiko.amadeus.app.MainActivity} into a {@code kumikoAlarmFired}
     * JS event. If the plugin instance isn't loaded yet (cold launch
     * before the WebView/bridge is ready), the payload is queued in
     * {@link #PENDING_ALARM_FIRED_PREFS} and {@link #drainPendingAlarmFired}
     * flushes it on next load().
     */
    public static void notifyAlarmFired(
        Context context,
        String reminderId,
        String reminderEvent,
        String reminderText,
        boolean wantsCall,
        String ringtoneFileId
    ) {
        JSObject payload = new JSObject();
        payload.put("reminderId", reminderId != null ? reminderId : "");
        payload.put("reminderEvent", reminderEvent != null ? reminderEvent : "");
        payload.put("reminderText", reminderText != null ? reminderText : "");
        payload.put("wantsCall", wantsCall);
        payload.put("ringtoneFileId", ringtoneFileId != null ? ringtoneFileId : "");
        payload.put("at", System.currentTimeMillis());

        KumikoAlarmsPlugin instance = INSTANCE;
        if (instance != null) {
            try {
                instance.notifyListeners("kumikoAlarmFired", payload);
                return;
            } catch (Throwable t) {
                Log.w(TAG, "notifyAlarmFired listener emit failed; queueing", t);
            }
        }
        // Queue for replay on next load(). We use a JSON array so multiple
        // events can pile up (rare — only matters if two alarms fire in
        // the same cold-start window).
        try {
            SharedPreferences prefs = context.getSharedPreferences(PENDING_ALARM_FIRED_PREFS, Context.MODE_PRIVATE);
            String existing = prefs.getString(PENDING_ALARM_FIRED_KEY, "[]");
            org.json.JSONArray array;
            try {
                array = new org.json.JSONArray(existing);
            } catch (Throwable ignored) {
                array = new org.json.JSONArray();
            }
            JSONObject row = new JSONObject();
            row.put("reminderId", reminderId != null ? reminderId : "");
            row.put("reminderEvent", reminderEvent != null ? reminderEvent : "");
            row.put("reminderText", reminderText != null ? reminderText : "");
            row.put("wantsCall", wantsCall);
            row.put("ringtoneFileId", ringtoneFileId != null ? ringtoneFileId : "");
            row.put("at", System.currentTimeMillis());
            array.put(row);
            prefs.edit().putString(PENDING_ALARM_FIRED_KEY, array.toString()).apply();
        } catch (Throwable t) {
            Log.w(TAG, "notifyAlarmFired queue write failed", t);
        }
    }

    private void drainPendingAlarmFired(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PENDING_ALARM_FIRED_PREFS, Context.MODE_PRIVATE);
        String existing = prefs.getString(PENDING_ALARM_FIRED_KEY, "[]");
        if (existing == null || existing.equals("[]")) return;
        try {
            org.json.JSONArray array = new org.json.JSONArray(existing);
            for (int i = 0; i < array.length(); i++) {
                JSONObject row = array.optJSONObject(i);
                if (row == null) continue;
                JSObject payload = new JSObject();
                payload.put("reminderId", row.optString("reminderId", ""));
                payload.put("reminderEvent", row.optString("reminderEvent", ""));
                payload.put("reminderText", row.optString("reminderText", ""));
                payload.put("wantsCall", row.optBoolean("wantsCall", false));
                payload.put("ringtoneFileId", row.optString("ringtoneFileId", ""));
                payload.put("at", row.optLong("at", System.currentTimeMillis()));
                try {
                    notifyListeners("kumikoAlarmFired", payload);
                } catch (Throwable t) {
                    Log.w(TAG, "drainPendingAlarmFired emit failed", t);
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "drainPendingAlarmFired parse failed", t);
        } finally {
            prefs.edit().remove(PENDING_ALARM_FIRED_KEY).apply();
        }
    }

    /**
     * Internal helper used by both scheduleExact and the native re-schedule
     * path called by KumikoBootReceiver after a reboot. Returns true iff
     * the alarm was scheduled with {@code setExactAndAllowWhileIdle};
     * false means we fell back to {@code setAndAllowWhileIdle} (inexact,
     * ±15min on Doze ROMs).
     */
    public static boolean scheduleAlarmInternal(
        Context context,
        AlarmManager am,
        String reminderId,
        long atMs,
        String reminderEvent,
        String reminderText,
        boolean wantsCall,
        String ringtoneFileId,
        boolean isPrewarm
    ) {
        Intent receiverIntent = new Intent(context, KumikoAlarmReceiver.class);
        receiverIntent.putExtra(KumikoAlarmReceiver.EXTRA_REMINDER_ID, reminderId);
        receiverIntent.putExtra(KumikoAlarmReceiver.EXTRA_REMINDER_EVENT, reminderEvent);
        receiverIntent.putExtra(KumikoAlarmReceiver.EXTRA_REMINDER_TEXT, reminderText);
        receiverIntent.putExtra(KumikoAlarmReceiver.EXTRA_WANTS_CALL, wantsCall);
        receiverIntent.putExtra(KumikoAlarmReceiver.EXTRA_RINGTONE_FILE_ID, ringtoneFileId);
        receiverIntent.putExtra(KumikoAlarmReceiver.EXTRA_IS_PREWARM, isPrewarm);

        int requestCode = isPrewarm
            ? (reminderId.hashCode() ^ PREWARM_REQUEST_CODE_OFFSET)
            : reminderId.hashCode();
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getBroadcast(context, requestCode, receiverIntent, piFlags);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (am.canScheduleExactAlarms()) {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pi);
                    return true;
                } else {
                    Log.w(TAG, "Exact alarm permission denied; falling back to inexact (id=" + reminderId + ")");
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pi);
                    return false;
                }
            } else {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pi);
                return true;
            }
        } catch (SecurityException se) {
            Log.w(TAG, "SecurityException; using inexact (id=" + reminderId + ")", se);
            try {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pi);
            } catch (Throwable ignored) {
                // If even the inexact path throws there's nothing we can do.
            }
            return false;
        } catch (Throwable t) {
            Log.e(TAG, "Schedule alarm failed (id=" + reminderId + ")", t);
            return false;
        }
    }

    public static boolean cancelAlarmInternal(Context context, AlarmManager am, String reminderId, boolean isPrewarm) {
        if (reminderId == null || reminderId.isEmpty()) return false;
        Intent receiverIntent = new Intent(context, KumikoAlarmReceiver.class);
        int requestCode = isPrewarm
            ? (reminderId.hashCode() ^ PREWARM_REQUEST_CODE_OFFSET)
            : reminderId.hashCode();
        int piFlags = PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getBroadcast(context, requestCode, receiverIntent, piFlags);
        if (pi != null) {
            try { am.cancel(pi); } catch (Throwable ignored) {}
            try { pi.cancel(); } catch (Throwable ignored) {}
            return true;
        }
        return false;
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

    /**
     * Idempotent. Safe to call from any native entry point that needs to
     * post on {@link #CHANNEL_ID_MESSAGES}.
     */
    public static void ensureMessagesChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID_MESSAGES) != null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID_MESSAGES,
            "新消息 · Messages",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("黄前久美子 主动联络（不会唤醒整页屏幕）");
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        channel.enableVibration(true);
        channel.setVibrationPattern(MESSAGE_VIBRATION_PATTERN);
        channel.setShowBadge(true);
        nm.createNotificationChannel(channel);
    }

    /**
     * Idempotent. Configures the high-priority "来电提醒" channel used by
     * LocalNotifications when JS posts a call-style reminder.
     */
    public static void ensureCallsChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID_CALLS) != null) return;

        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID_CALLS,
            "来电提醒 · Calls",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("黄前久美子 来电式提醒（高优先 + 全屏 + 振动）");
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        channel.enableVibration(true);
        channel.setVibrationPattern(CALL_VIBRATION_PATTERN);
        channel.setBypassDnd(true);
        channel.setShowBadge(true);
        AudioAttributes attrs = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        channel.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), attrs);
        nm.createNotificationChannel(channel);
    }

    // === v2.14.23 ledger / guardian helpers ===========================

    public static void persistLedgerEntry(
        Context context,
        String reminderId,
        long atMs,
        String reminderEvent,
        String reminderText,
        boolean wantsCall,
        String ringtoneFileId
    ) throws JSONException {
        SharedPreferences prefs = context.getSharedPreferences(LEDGER_PREFS, Context.MODE_PRIVATE);
        JSONObject row = new JSONObject();
        row.put("reminderId", reminderId);
        row.put("at", atMs);
        row.put("event", reminderEvent != null ? reminderEvent : "");
        row.put("text", reminderText != null ? reminderText : "");
        row.put("wantsCall", wantsCall);
        row.put("ringtoneFileId", ringtoneFileId != null ? ringtoneFileId : "");
        row.put("createdAt", System.currentTimeMillis());
        prefs.edit().putString(LEDGER_KEY_PREFIX + reminderId, row.toString()).apply();
    }

    public static void removeLedgerEntry(Context context, String reminderId) {
        if (reminderId == null) return;
        SharedPreferences prefs = context.getSharedPreferences(LEDGER_PREFS, Context.MODE_PRIVATE);
        prefs.edit().remove(LEDGER_KEY_PREFIX + reminderId).apply();
    }

    public static int[] pruneExpiredLedgerInternal(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(LEDGER_PREFS, Context.MODE_PRIVATE);
        long cutoff = System.currentTimeMillis() - 60_000L;
        int pruned = 0;
        int remaining = 0;
        SharedPreferences.Editor editor = prefs.edit();
        java.util.Map<String, ?> all = prefs.getAll();
        for (java.util.Map.Entry<String, ?> entry : all.entrySet()) {
            String key = entry.getKey();
            if (!key.startsWith(LEDGER_KEY_PREFIX)) continue;
            String value = String.valueOf(entry.getValue());
            try {
                JSONObject row = new JSONObject(value);
                long at = row.optLong("at", 0L);
                if (at <= 0L || at < cutoff) {
                    editor.remove(key);
                    pruned++;
                } else {
                    remaining++;
                }
            } catch (Throwable t) {
                editor.remove(key);
                pruned++;
            }
        }
        editor.apply();
        return new int[] { pruned, remaining };
    }

    public static List<JSONObject> readPendingLedgerEntries(Context context) {
        List<JSONObject> out = new ArrayList<>();
        SharedPreferences prefs = context.getSharedPreferences(LEDGER_PREFS, Context.MODE_PRIVATE);
        for (java.util.Map.Entry<String, ?> entry : prefs.getAll().entrySet()) {
            String key = entry.getKey();
            if (!key.startsWith(LEDGER_KEY_PREFIX)) continue;
            try {
                JSONObject row = new JSONObject(String.valueOf(entry.getValue()));
                out.add(row);
            } catch (Throwable ignored) {}
        }
        return out;
    }

    public static boolean isXiaomiHyperOs() {
        String brand = String.valueOf(Build.BRAND).toLowerCase();
        String manufacturer = String.valueOf(Build.MANUFACTURER).toLowerCase();
        return brand.contains("xiaomi") || brand.contains("redmi") || manufacturer.contains("xiaomi");
    }

    public static void startGuardianService(Context context, String reason) {
        Intent intent = new Intent(context, KumikoAlarmGuardianService.class);
        intent.putExtra(KumikoAlarmGuardianService.EXTRA_START_REASON, reason != null ? reason : "unknown");
        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (Throwable t) {
            Log.w(TAG, "startForegroundService failed; trying startService as fallback", t);
            try {
                context.startService(intent);
            } catch (Throwable ignored) {}
        }
    }
}
