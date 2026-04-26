// android/app/src/main/java/com/kumiko/amadeus/app/alarms/KumikoAlarmsPlugin.java
//
// B.2 (A6.4): Capacitor plugin exposing AlarmManager.setExactAndAllowWhileIdle
// to JS. Replaces useScheduledReminders' 1s setInterval polling that doesn't
// survive Android Doze. JS calls scheduleExact / cancel / cancelAll, which
// schedule a PendingIntent against KumikoAlarmReceiver. When the alarm fires
// the receiver routes to either a normal LocalNotification (text mode) or a
// CallStyle heads-up + KumikoCallRingingService (call-mode reminder); the
// React VoiceCallOverlay handles the actual incoming-call UI in v2.14.24+.
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
import android.app.Person;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.Settings;
import android.telecom.PhoneAccount;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.kumiko.amadeus.app.MainActivity;
import com.kumiko.amadeus.app.calls.KumikoCallRingingService;
import com.kumiko.amadeus.app.calls.KumikoConnectionService;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;

@CapacitorPlugin(name = "KumikoAlarms")
public class KumikoAlarmsPlugin extends Plugin {

    private static final String TAG = "KumikoAlarmsPlugin";
    // v2.14.24: bumped to *_v3 to force recreation. Pre-v3 channels were
    // created with conflicting settings by both this plugin and Capacitor's
    // LocalNotifications wrapper depending on which path raced first; once
    // a channel is created its importance / vibration / sound are *immutable*
    // from the app side (only the user can change them via system settings).
    // The only way to ship corrected channel settings is to use a new ID and
    // delete the old one. Cost: any user-customised channel preferences on
    // the v1/v2 channels are lost once. Worth it.
    public static final String CHANNEL_ID_MESSAGES = "kumiko_messages_v3";
    public static final String CHANNEL_ID_CALLS = "kumiko_calls_v3";
    /** v2.14.24: legacy channel IDs deleted on first plugin load after upgrade. */
    private static final String[] LEGACY_CHANNEL_IDS = new String[] {
        "kumiko_messages",
        "kumiko_messages_v2",
        "kumiko_calls",
        "kumiko_calls_v2",
    };
    private static final String CHANNEL_MIGRATION_PREFS = "kumiko_channel_migration";
    private static final String CHANNEL_MIGRATION_KEY_V3 = "v3_done";

    private static final int TEST_MESSAGE_NOTIFICATION_ID = 921021;
    private static final int TEST_CALL_NOTIFICATION_ID = 921022;
    // v2.14.24: explicit "two short taps" vs "long persistent ring" patterns
    // so the user can audibly distinguish a passive message notification
    // from a reminder-call without looking at the screen. Old single-pulse
    // pattern blended into the system default and was the #1 cause of "I
    // didn't notice the reminder" reports in the v2.14.23 feedback.
    public static final long[] MESSAGE_VIBRATION_PATTERN = new long[]{0, 250, 120, 250};
    public static final long[] CALL_VIBRATION_PATTERN = new long[]{0, 800, 600, 800, 600, 800, 600, 800};

    // v2.14.23: native ledger keys. Each entry is a JSON blob keyed by
    // reminderId so KumikoBootReceiver can rebuild the AlarmManager state
    // after BOOT_COMPLETED / MY_PACKAGE_REPLACED. We deliberately keep the
    // schema flat (one row per reminder; values are primitive) so a
    // future schema migration can rewrite the prefs file in-place
    // without touching SQLite.
    public static final String LEDGER_PREFS = "kumiko_alarm_ledger";
    public static final String LEDGER_KEY_PREFIX = "alarm:";
    public static final String SELF_TEST_PREFS = "kumiko_alarm_self_test";
    public static final String SELF_TEST_KEY_REMINDER_ID = "reminder_id";
    public static final String SELF_TEST_KEY_ARMED = "armed";
    public static final String SELF_TEST_KEY_ALARM_FIRED_AT = "alarm_fired_at";
    public static final String SELF_TEST_KEY_NOTIF_POSTED_AT = "notif_posted_at";
    public static final String SELF_TEST_KEY_FSI_LAUNCHED_AT = "fsi_launched_at";
    public static final String SELF_TEST_KEY_ACCEPT_RECEIVED_AT = "accept_received_at";

    // v2.14.23: PhoneAccount handle id used to register the self-managed
    // ConnectionService with TelecomManager. This id is opaque to users
    // and is only used by the framework to disambiguate calls within
    // the same package; we keep one handle for the entire app.
    public static final String PHONE_ACCOUNT_ID = "kumiko_amadeus_self_managed";

    // v2.14.23: Xiaomi/HyperOS prewarm-alarm reminder-id suffix. Used to
    // distinguish between the user-scheduled alarm and the T-5min wake
    // alarm we schedule in addition. The receiver checks for this suffix
    // and treats it as a no-op (we just need the kernel side-effect of
    // having recently fired an alarm; the actual fire is at the real
    // user-set time via Handler.postDelayed scheduled by the prewarm
    // alarm's own onReceive path).
    public static final String PREWARM_REMINDER_SUFFIX = "::prewarm";

    // v2.14.23: separate keyspace within the AlarmManager for prewarm
    // alarms so cancelling the user reminder also cancels its prewarm
    // companion. We add a constant offset to the reminderId hash so the
    // PendingIntent request code never collides with the real alarm.
    private static final int PREWARM_REQUEST_CODE_OFFSET = 0x10000000;

    @Override
    public void load() {
        super.load();
        // v2.14.24: one-shot delete of legacy channel IDs + eager creation
        // of the v3 channels.
        //
        // Capacitor's plugin load() runs once per process when the bridge
        // resolves the plugin descriptor (i.e. on every cold start of
        // MainActivity). The SharedPreferences flag makes the actual delete
        // idempotent across launches; gating on the flag also avoids
        // touching NotificationManager unnecessarily after migration.
        //
        // We also pre-create the v3 channels here because Capacitor's
        // LocalNotifications plugin may post by channelId before any
        // reminder fires (e.g. proactive RNG message via postKumikoNotification),
        // and an unknown channelId would silently route to the default channel
        // — losing our DND-bypass / lockscreen visibility settings.
        try {
            Context ctx = getContext();
            runChannelMigrationToV3(ctx);
            ensureMessagesChannel(ctx);
            ensureCallsChannel(ctx);
        } catch (Throwable t) {
            Log.w(TAG, "Channel setup at load() failed (non-fatal)", t);
        }
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

        boolean exactScheduled = scheduleAlarmInternal(
            context, am, reminderId, atMs, reminderEvent, reminderText, wantsCall, ringtoneFileId, /*isPrewarm*/ false
        );

        // v2.14.23: persist the reminder metadata to the native ledger so
        // KumikoBootReceiver can rebuild AlarmManager state after the device
        // reboots. AlarmManager forgets all pending alarms after every
        // reboot (including LOCKED_BOOT_COMPLETED), so without this every
        // reminder set before the user's nightly reboot silently misses.
        // Side effect: cancel() also removes the row, keeping the ledger in
        // sync with the AlarmManager view.
        try {
            persistLedgerEntry(context, reminderId, atMs, reminderEvent, reminderText, wantsCall, ringtoneFileId);
        } catch (Throwable t) {
            Log.w(TAG, "Failed to persist ledger entry; reboot recovery may not work", t);
        }

        // v2.14.23: Xiaomi/HyperOS double-alarm. MIUI's power-management
        // layer rounds long-delay alarms to 5-minute boundaries (a
        // documented kernel-side behaviour reproduced on every MIUI 12+
        // device we tested). Scheduling a second "prewarm" alarm 5 minutes
        // before the real one nudges the kernel out of deep doze ahead of
        // time, which empirically reduces drift from ~5min to ~10s. This
        // is a *mitigation*, not a guarantee — MIUI can still drift if the
        // app is force-stopped or the user has aggressive battery saver on.
        // We only do this for delays >= 10min; shorter ones don't benefit.
        long delayMs = atMs - System.currentTimeMillis();
        boolean prewarmScheduled = false;
        if (isXiaomiHyperOs() && delayMs >= 10L * 60_000L) {
            long prewarmAt = atMs - 5L * 60_000L;
            try {
                prewarmScheduled = scheduleAlarmInternal(
                    context, am, reminderId + PREWARM_REMINDER_SUFFIX, prewarmAt,
                    reminderEvent, reminderText, wantsCall, ringtoneFileId, /*isPrewarm*/ true
                );
                Log.i(TAG, "Xiaomi double-alarm: prewarm at " + prewarmAt + " for reminder " + reminderId);
            } catch (Throwable t) {
                Log.w(TAG, "Failed to schedule Xiaomi prewarm alarm; main alarm still scheduled", t);
            }
        }

        // v2.14.23: ensure the long-running alarm guardian is up. The
        // foreground service holds a persistent ongoing notification that
        // visibly anchors our process priority on aggressive ROMs, dropping
        // the "killed by Android" rate enough to materially improve
        // delivery reliability. The service is started lazily and stopped
        // by JS once the last reminder is consumed.
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
    }

    /**
     * Internal helper used by both scheduleExact and the native re-schedule
     * path called by KumikoBootReceiver after a reboot. Returns true iff the
     * alarm was scheduled with `setExactAndAllowWhileIdle`; false means we
     * fell back to `setAndAllowWhileIdle` (inexact, ±15min on Doze ROMs).
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

        boolean cancelledMain = cancelAlarmInternal(context, am, reminderId, /*isPrewarm*/ false);
        boolean cancelledPrewarm = cancelAlarmInternal(context, am, reminderId, /*isPrewarm*/ true);

        // v2.14.23: also remove the ledger row so the boot receiver doesn't
        // resurrect a cancelled reminder. We do this even when the
        // PendingIntent lookup returned null (cancelled is best-effort);
        // the ledger is the source of truth for reboot recovery.
        try {
            removeLedgerEntry(context, reminderId);
        } catch (Throwable t) {
            Log.w(TAG, "Failed to remove ledger entry for " + reminderId, t);
        }

        JSObject ret = new JSObject();
        ret.put("cancelled", cancelledMain);
        ret.put("prewarmCancelled", cancelledPrewarm);
        call.resolve(ret);
    }

    /**
     * Internal helper. Cancels the AlarmManager registration AND the
     * underlying PendingIntent. Returns true iff the PendingIntent
     * existed (i.e. there was actually a registered alarm to cancel).
     */
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

    /**
     * v2.14.21: One-shot bootstrap for the kumiko_messages / kumiko_calls
     * notification channels. Side effect kept OUT of getAlertPermissionStatus
     * so the read-only detection path can never stall on misbehaving ROMs.
     * Idempotent — the underlying createNotificationChannel re-binds an
     * existing channel.
     */
    @PluginMethod
    public void ensureNotificationChannels(PluginCall call) {
        try {
            Context context = getContext();
            ensureMessagesChannel(context);
            ensureCallsChannel(context);
            JSObject ret = new JSObject();
            ret.put("ready", true);
            call.resolve(ret);
        } catch (Throwable t) {
            Log.w(TAG, "ensureNotificationChannels failed", t);
            JSObject ret = new JSObject();
            ret.put("ready", false);
            call.resolve(ret);
        }
    }

    /**
     * v2.14.21: Reports manufacturer/brand/model so JS can branch into
     * vendor-specific guidance (Xiaomi/Huawei/Samsung/OPPO/vivo). Also
     * surfaces best-effort MIUI "Show on lock screen" state via reflection.
     */
    @PluginMethod
    public void getOemDeviceInfo(PluginCall call) {
        Context context = getContext();
        JSObject ret = new JSObject();
        ret.put("manufacturer", KumikoVendorPermissionHelper.manufacturer());
        ret.put("brand", KumikoVendorPermissionHelper.brand());
        ret.put("model", KumikoVendorPermissionHelper.model());
        ret.put("androidVersion", KumikoVendorPermissionHelper.androidVersion());
        KumikoVendorPermissionHelper.ShowOnLockState lockState =
            KumikoVendorPermissionHelper.detectMiuiShowOnLock(context);
        switch (lockState) {
            case GRANTED: ret.put("showOnLockState", "granted"); break;
            case DENIED: ret.put("showOnLockState", "denied"); break;
            default: ret.put("showOnLockState", "unknown"); break;
        }
        call.resolve(ret);
    }

    /**
     * v2.14.21: Vendor-aware deep link. Caller passes a stable key like
     * "xiaomi.autostart" / "samsung.batteryUsage"; the helper probes a list
     * of candidate Intents (most-specific first) with PackageManager.resolveActivity()
     * before launching, falling back to the AOSP App details page if every
     * vendor candidate is missing on the device.
     */
    @PluginMethod
    public void openVendorSetting(PluginCall call) {
        String key = call.getString("key", "");
        if (key == null || key.isEmpty()) {
            JSObject ret = new JSObject();
            ret.put("opened", false);
            ret.put("usedFallback", false);
            call.resolve(ret);
            return;
        }
        KumikoVendorPermissionHelper.OpenResult result =
            KumikoVendorPermissionHelper.openVendorSetting(getContext(), key);
        JSObject ret = new JSObject();
        ret.put("opened", result.opened);
        ret.put("usedFallback", result.usedFallback);
        call.resolve(ret);
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
            String title = call.getString("title", "黄前久美子 来电测试");
            String body = call.getString("body", "来电弹窗 / 铃声 / 震动测试");
            String ringtoneFileId = call.getString("ringtoneFileId", "");
            String testReminderId = "test-incoming-call-" + System.currentTimeMillis();

            // v2.14.24: post the same heads-up the production reminder
            // path uses, so the test really exercises the user-facing
            // notification surface (CallStyle on API 31+, Accept/Decline
            // actions on older). Also start the ringer FG service so the
            // test confirms ringtone + vibration loop.
            postIncomingCallHeadsUp(context, testReminderId, title, body, ringtoneFileId);
            try {
                Intent ringer = new Intent(context, KumikoCallRingingService.class);
                ringer.putExtra(KumikoCallRingingService.EXTRA_REMINDER_ID, testReminderId);
                ringer.putExtra(KumikoCallRingingService.EXTRA_RINGTONE_FILE_ID, ringtoneFileId);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(ringer);
                } else {
                    context.startService(ringer);
                }
            } catch (Throwable t) {
                Log.w(TAG, "Test incoming call: ringer start failed", t);
            }

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

    /**
     * v2.14.23: cheap no-op invoked by JS at startup to amortise
     * Capacitor's plugin-bridge cold-start cost (typically 2-5s on the
     * very first call after WebView boot). Returning a stable JSObject
     * forces the bridge descriptor to resolve.
     */
    @PluginMethod
    public void prewarm(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    /**
     * v2.14.23: REQUEST_IGNORE_BATTERY_OPTIMIZATIONS in-place dialog. The
     * system shows a "Allow Kumiko Amadeus to keep running in background?"
     * Yes/No popup; the user's choice is reflected in
     * isIgnoringBatteryOptimizations() on next read. Best-effort; if the
     * Settings page isn't available (some forked ROMs) we fall back to
     * the global "Battery optimization" list page.
     */
    @PluginMethod
    public void requestIgnoreBatteryOptimization(PluginCall call) {
        Context context = getContext();
        boolean requested = false;
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            requested = true;
        } catch (Throwable t) {
            Log.w(TAG, "Direct REQUEST_IGNORE_BATTERY_OPTIMIZATIONS failed; falling back to settings list", t);
            try {
                Intent fallback = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(fallback);
                requested = true;
            } catch (Throwable t2) {
                Log.w(TAG, "Battery optimization settings list not available either", t2);
            }
        }
        JSObject ret = new JSObject();
        ret.put("requested", requested);
        call.resolve(ret);
    }

    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        Context context = getContext();
        boolean ignored = false;
        try {
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (pm != null) ignored = pm.isIgnoringBatteryOptimizations(context.getPackageName());
        } catch (Throwable t) {
            Log.w(TAG, "isIgnoringBatteryOptimizations probe failed", t);
        }
        JSObject ret = new JSObject();
        ret.put("ignored", ignored);
        call.resolve(ret);
    }

    /**
     * v2.14.23: PhoneAccount inspection. The "registered" half is true iff
     * we've called TelecomManager.registerPhoneAccount. The "enabled" half
     * is true iff the user has additionally toggled the account on in
     * Settings → Apps → Default Apps → Calling accounts. Both halves must
     * be true before we should attempt addNewIncomingCall(); when only
     * "registered" is true we still hit the legacy FSI fallback path.
     */
    @PluginMethod
    public void isPhoneAccountRegistered(PluginCall call) {
        boolean registered = false;
        boolean enabled = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Context context = getContext();
            TelecomManager tm = (TelecomManager) context.getSystemService(Context.TELECOM_SERVICE);
            if (tm != null) {
                try {
                    PhoneAccountHandle handle = buildPhoneAccountHandle(context);
                    PhoneAccount account = tm.getPhoneAccount(handle);
                    if (account != null) {
                        registered = true;
                        // PhoneAccount.isEnabled() is a CTS-tested API on M+.
                        try { enabled = account.isEnabled(); } catch (Throwable ignored) {}
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "isPhoneAccountRegistered probe failed", t);
                }
            }
        }
        JSObject ret = new JSObject();
        ret.put("registered", registered);
        ret.put("enabled", enabled);
        call.resolve(ret);
    }

    @PluginMethod
    public void registerPhoneAccount(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            JSObject ret = new JSObject();
            ret.put("registered", false);
            call.resolve(ret);
            return;
        }
        Context context = getContext();
        TelecomManager tm = (TelecomManager) context.getSystemService(Context.TELECOM_SERVICE);
        if (tm == null) {
            JSObject ret = new JSObject();
            ret.put("registered", false);
            call.resolve(ret);
            return;
        }
        boolean ok = false;
        try {
            PhoneAccountHandle handle = buildPhoneAccountHandle(context);
            PhoneAccount.Builder builder = PhoneAccount.builder(handle, "Kumiko·Amadeus")
                .addSupportedUriScheme(PhoneAccount.SCHEME_TEL)
                .addSupportedUriScheme(PhoneAccount.SCHEME_SIP)
                .setShortDescription("黄前久美子 · 提醒来电");
            // CAPABILITY_SELF_MANAGED is required for the system to delegate
            // call rendering to our ConnectionService instead of the dialer.
            // Self-managed accounts are NOT user-enabled by default — the
            // user has to flip it on in Settings → Apps → Default Apps →
            // Calling accounts. We surface that toggle from the JS UI via
            // openPhoneAccountSettings().
            int caps = PhoneAccount.CAPABILITY_SELF_MANAGED;
            // CAPABILITY_SUPPORTS_VIDEO_CALLING isn't strictly required but
            // some OEMs (Xiaomi specifically) gate the visible UI on its
            // presence; cheap to add and avoids a "this account is incomplete"
            // grey-out in some MIUI builds.
            caps |= PhoneAccount.CAPABILITY_VIDEO_CALLING;
            builder.setCapabilities(caps);
            tm.registerPhoneAccount(builder.build());
            ok = true;
        } catch (SecurityException se) {
            Log.w(TAG, "registerPhoneAccount denied — MANAGE_OWN_CALLS not granted?", se);
        } catch (Throwable t) {
            Log.w(TAG, "registerPhoneAccount failed", t);
        }
        JSObject ret = new JSObject();
        ret.put("registered", ok);
        call.resolve(ret);
    }

    @PluginMethod
    public void unregisterPhoneAccount(PluginCall call) {
        Context context = getContext();
        TelecomManager tm = (TelecomManager) context.getSystemService(Context.TELECOM_SERVICE);
        if (tm != null) {
            try {
                tm.unregisterPhoneAccount(buildPhoneAccountHandle(context));
            } catch (Throwable t) {
                Log.w(TAG, "unregisterPhoneAccount failed", t);
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void openPhoneAccountSettings(PluginCall call) {
        Context context = getContext();
        try {
            // The "official" deep link is TelecomManager.ACTION_CHANGE_PHONE_ACCOUNTS,
            // but it doesn't exist as an Intent action constant we can target reliably
            // across ROMs. The known-good workaround is the call settings page which
            // every Android variant routes to the same internal screen.
            Intent intent = new Intent("android.telecom.action.CHANGE_PHONE_ACCOUNTS");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } catch (Throwable t) {
            Log.w(TAG, "Direct phone-account settings unavailable; falling back to call settings", t);
            try {
                Intent fallback = new Intent(TelecomManager.ACTION_SHOW_CALL_ACCESSIBILITY_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(fallback);
            } catch (Throwable t2) {
                Log.w(TAG, "Call settings fallback failed; opening app details", t2);
                try {
                    Intent appDetails = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                    appDetails.setData(Uri.parse("package:" + context.getPackageName()));
                    appDetails.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    context.startActivity(appDetails);
                } catch (Throwable ignored) {}
            }
        }
        call.resolve();
    }

    /**
     * v2.14.23: arm a one-shot self-test slot. JS calls this BEFORE the
     * placeholder reminder is scheduled, then on resume calls
     * collectSelfTestReport() to retrieve which stages of the alarm flow
     * actually arrived. The slot is keyed by reminderId so we can ignore
     * stale fires from previous runs.
     */
    @PluginMethod
    public void startSelfTestProbe(PluginCall call) {
        String reminderId = call.getString("reminderId");
        if (reminderId == null || reminderId.isEmpty()) {
            call.reject("reminderId required");
            return;
        }
        SharedPreferences prefs = getContext()
            .getSharedPreferences(SELF_TEST_PREFS, Context.MODE_PRIVATE);
        prefs.edit()
            .putString(SELF_TEST_KEY_REMINDER_ID, reminderId)
            .putBoolean(SELF_TEST_KEY_ARMED, true)
            .putLong(SELF_TEST_KEY_ALARM_FIRED_AT, 0L)
            .putLong(SELF_TEST_KEY_NOTIF_POSTED_AT, 0L)
            .putLong(SELF_TEST_KEY_FSI_LAUNCHED_AT, 0L)
            .putLong(SELF_TEST_KEY_ACCEPT_RECEIVED_AT, 0L)
            .apply();
        JSObject ret = new JSObject();
        ret.put("armed", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void collectSelfTestReport(PluginCall call) {
        SharedPreferences prefs = getContext()
            .getSharedPreferences(SELF_TEST_PREFS, Context.MODE_PRIVATE);
        JSObject ret = new JSObject();
        ret.put("armed", prefs.getBoolean(SELF_TEST_KEY_ARMED, false));
        ret.put("alarmFiredAt", prefs.getLong(SELF_TEST_KEY_ALARM_FIRED_AT, 0L));
        ret.put("notifPostedAt", prefs.getLong(SELF_TEST_KEY_NOTIF_POSTED_AT, 0L));
        ret.put("fsiLaunchedAt", prefs.getLong(SELF_TEST_KEY_FSI_LAUNCHED_AT, 0L));
        ret.put("acceptReceivedAt", prefs.getLong(SELF_TEST_KEY_ACCEPT_RECEIVED_AT, 0L));
        call.resolve(ret);
    }

    /**
     * v2.14.23: drop ledger rows whose `at` is more than 60s in the past.
     * Called on JS startup so a cancelled-but-not-fired alarm doesn't
     * resurrect across a reboot. The boot receiver also calls this
     * inline before re-scheduling.
     */
    @PluginMethod
    public void pruneExpiredLedger(PluginCall call) {
        Context context = getContext();
        int[] counts = pruneExpiredLedgerInternal(context);
        JSObject ret = new JSObject();
        ret.put("pruned", counts[0]);
        ret.put("remaining", counts[1]);
        call.resolve(ret);
    }

    @PluginMethod
    public void startAlarmGuardian(PluginCall call) {
        boolean started = false;
        try {
            startGuardianService(getContext(), call.getString("reason", "manual"));
            started = true;
        } catch (Throwable t) {
            Log.w(TAG, "startAlarmGuardian failed", t);
        }
        JSObject ret = new JSObject();
        ret.put("started", started);
        call.resolve(ret);
    }

    /**
     * v2.14.24: stops {@link KumikoCallRingingService} from JS, e.g. when
     * the user closes the React VoiceCallOverlay manually. The service
     * also self-stops after MAX_RING_DURATION_MS, but we want to short-
     * circuit that as soon as the user reaches the overlay (otherwise the
     * ringtone keeps ringing for up to a minute despite the overlay being
     * already on screen).
     */
    @PluginMethod
    public void stopCallRinging(PluginCall call) {
        boolean stopped = false;
        try {
            Context context = getContext();
            Intent intent = new Intent(context, KumikoCallRingingService.class);
            intent.setAction(KumikoCallRingingService.ACTION_STOP);
            // Use startService so the service receives ACTION_STOP via
            // onStartCommand; that path also runs the cleanup. Calling
            // stopService alone races with onStartCommand if the service
            // hasn't been promoted to foreground yet.
            context.startService(intent);
            stopped = true;
        } catch (Throwable t) {
            Log.w(TAG, "stopCallRinging failed", t);
        }
        JSObject ret = new JSObject();
        ret.put("stopped", stopped);
        call.resolve(ret);
    }

    @PluginMethod
    public void stopAlarmGuardian(PluginCall call) {
        boolean stopped = false;
        try {
            Context context = getContext();
            Intent intent = new Intent(context, KumikoAlarmGuardianService.class);
            stopped = context.stopService(intent);
        } catch (Throwable t) {
            Log.w(TAG, "stopAlarmGuardian failed", t);
        }
        JSObject ret = new JSObject();
        ret.put("stopped", stopped);
        call.resolve(ret);
    }

    @PluginMethod
    public void drainPendingActions(PluginCall call) {
        // v2.14.24: drain SharedPreferences entries that MainActivity (call
        // open/accept/decline from heads-up tap) and RemoteReplyReceiver
        // (Direct Reply text) wrote while the WebView was offline. Returns
        // a snapshot to JS which replays them through the normal message
        // pipeline. Pre-v2.14.24 the writer was IncomingCallActivity; the
        // wire format is unchanged so existing JS drainer code works as-is.
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

    /**
     * Idempotent. Safe to call from any native entry point that needs to
     * post on {@link #CHANNEL_ID_MESSAGES}. v2.14.24: made {@code public}
     * so {@link KumikoAlarmReceiver} and other native components don't
     * duplicate the channel definition (each duplicate ran the risk of
     * setting different importance/vibration depending on whoever raced
     * to {@code createNotificationChannel} first).
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
     * both legacy fullScreenIntent and the v2.14.24 CallStyle heads-up
     * path. v2.14.24 additions:
     *   - {@code setBypassDnd(true)} — call-style notifications must ring
     *     even when the device is in DND, otherwise reminders silently
     *     drop on locked-screen evenings (which is when they matter most).
     *     Honoured at the system level only if the user has granted the
     *     "Do Not Disturb access" special permission, which we surface in
     *     the onboarding wizard.
     *   - {@code setShowBadge(true)} — keeps the launcher icon dot in sync
     *     with missed reminders.
     *   - long persistent vibration pattern matching {@link Notification.CallStyle}
     *     conventions so the device buzzes continuously instead of a single
     *     short pulse that could be missed.
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

    // === v2.14.24: heads-up CallStyle helper ==========================
    //
    // Single source of truth for "post a Notification.CallStyle.forIncomingCall
    // heads-up that always shows the user there is an incoming reminder
    // and routes their tap into MainActivity → React VoiceCallOverlay".
    //
    // Why a separate helper instead of inlining inside the receiver?
    //   - KumikoConnectionService also needs to post the same heads-up
    //     when Telecom asks us to render a self-managed incoming call
    //     (`onCreateIncomingConnection`).
    //   - Having both call sites go through this one method gives us
    //     dedup-by-reminderId (the {@link #LAST_HEADS_UP_POSTED_AT} map),
    //     which in turn lets us keep "post heads-up always THEN attempt
    //     Telecom" in the receiver without double-notifying when Telecom
    //     subsequently invokes us to display the same call.
    //
    // What's in the heads-up:
    //   - API 31+: Notification.CallStyle.forIncomingCall(person, declinePi,
    //     acceptPi). Android renders the canonical green-Accept / red-Decline
    //     round buttons heads-up banner.
    //   - API < 31: NotificationCompat.Builder + addAction(Decline) +
    //     addAction(Accept). Less polished but still has tap targets.
    //   - All builds: setCategory(CATEGORY_CALL), setOngoing(true),
    //     setVisibility(PUBLIC), setFullScreenIntent → MainActivity, flag
    //     FLAG_INSISTENT (so heads-up doesn't auto-dismiss after a few
    //     seconds; user must respond).
    //   - PendingIntents target MainActivity with EXTRA_OPEN_CALL /
    //     EXTRA_ACCEPT_CALL / EXTRA_DECLINE_CALL. MainActivity writes the
    //     intent into kumiko_pending_actions SharedPrefs and the JS drainer
    //     picks it up and bridges into VoiceCallOverlay.
    //
    // What this helper does NOT do:
    //   - Play ringtone audio. That is the job of {@link KumikoCallRingingService}
    //     (FG service with MediaPlayer + Vibrator wave loop). The receiver
    //     starts that service in parallel with the heads-up post; the
    //     channel sound plays once at heads-up post for ROMs that don't
    //     respect the FG service path.

    public static final String EXTRA_OPEN_CALL = "kumiko_extra_open_call";
    public static final String EXTRA_ACCEPT_CALL = "kumiko_extra_accept_call";
    public static final String EXTRA_DECLINE_CALL = "kumiko_extra_decline_call";
    public static final String EXTRA_REMINDER_EVENT = "kumiko_extra_reminder_event";
    public static final String EXTRA_REMINDER_TEXT = "kumiko_extra_reminder_text";
    public static final String EXTRA_RINGTONE_FILE_ID = "kumiko_extra_ringtone_file_id";

    private static final ConcurrentHashMap<String, Long> LAST_HEADS_UP_POSTED_AT = new ConcurrentHashMap<>();
    private static final long HEADS_UP_DEDUP_WINDOW_MS = 5_000L;

    /**
     * Idempotent within {@link #HEADS_UP_DEDUP_WINDOW_MS}. Posts the
     * incoming-call heads-up notification. Stamps SELF_TEST_KEY_NOTIF_POSTED_AT
     * if the reminder is the currently-armed self-test.
     *
     * @return true if a notification was posted, false if a recent dedup
     *         hit caused a skip (caller can ignore the return — both cases
     *         are "the user has been notified").
     */
    public static boolean postIncomingCallHeadsUp(
        Context context,
        String reminderId,
        String reminderEvent,
        String reminderText,
        String ringtoneFileId
    ) {
        if (reminderId == null) reminderId = "call-" + System.currentTimeMillis();
        if (reminderEvent == null || reminderEvent.isEmpty()) reminderEvent = "黄前久美子 来电";
        if (reminderText == null || reminderText.isEmpty()) reminderText = reminderEvent;

        long now = System.currentTimeMillis();
        Long previous = LAST_HEADS_UP_POSTED_AT.get(reminderId);
        if (previous != null && (now - previous) < HEADS_UP_DEDUP_WINDOW_MS) {
            Log.i(TAG, "postIncomingCallHeadsUp dedup hit for reminderId=" + reminderId);
            return false;
        }
        LAST_HEADS_UP_POSTED_AT.put(reminderId, now);

        try {
            ensureCallsChannel(context);

            int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
            int idHash = reminderId.hashCode();

            PendingIntent contentPi = buildMainActivityPi(
                context, reminderId, reminderEvent, reminderText, ringtoneFileId,
                EXTRA_OPEN_CALL, idHash, piFlags
            );
            PendingIntent acceptPi = buildMainActivityPi(
                context, reminderId, reminderEvent, reminderText, ringtoneFileId,
                EXTRA_ACCEPT_CALL, idHash ^ 0x2, piFlags
            );
            PendingIntent declinePi = buildMainActivityPi(
                context, reminderId, reminderEvent, reminderText, ringtoneFileId,
                EXTRA_DECLINE_CALL, idHash ^ 0x1, piFlags
            );

            Uri ringtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            Notification notification;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                Person caller = new Person.Builder()
                    .setName(reminderEvent)
                    .setImportant(true)
                    .build();
                Notification.CallStyle style = Notification.CallStyle
                    .forIncomingCall(caller, declinePi, acceptPi);
                Notification.Builder builder = new Notification.Builder(context, CHANNEL_ID_CALLS)
                    .setSmallIcon(android.R.drawable.sym_call_incoming)
                    .setContentTitle(reminderEvent)
                    .setContentText(reminderText)
                    .setCategory(Notification.CATEGORY_CALL)
                    .setVisibility(Notification.VISIBILITY_PUBLIC)
                    .setFullScreenIntent(contentPi, true)
                    .setOngoing(true)
                    .setStyle(style);
                notification = builder.build();
            } else {
                NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID_CALLS)
                    .setSmallIcon(android.R.drawable.sym_call_incoming)
                    .setContentTitle(reminderEvent)
                    .setContentText(reminderText)
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(reminderText))
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                    .setFullScreenIntent(contentPi, true)
                    .setContentIntent(contentPi)
                    .setOngoing(true)
                    .setAutoCancel(false)
                    .setSound(ringtone)
                    .setVibrate(CALL_VIBRATION_PATTERN)
                    .addAction(android.R.drawable.ic_menu_close_clear_cancel, "拒接 · Decline", declinePi)
                    .addAction(android.R.drawable.ic_menu_call, "接听 · Accept", acceptPi);
                notification = builder.build();
            }

            // FLAG_INSISTENT keeps ringtone + vibration looping until the
            // user responds. Without it, OEMs auto-dismiss the heads-up
            // banner after ~3-5 seconds and the user misses the reminder.
            notification.flags |= Notification.FLAG_INSISTENT;

            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.notify(idHash, notification);
            }

            writeSelfTestNotifPostedAt(context, reminderId);
            Log.i(TAG, "postIncomingCallHeadsUp posted reminderId=" + reminderId);
            return true;
        } catch (Throwable t) {
            Log.e(TAG, "postIncomingCallHeadsUp failed", t);
            // Clear dedup so a subsequent retry isn't blocked.
            LAST_HEADS_UP_POSTED_AT.remove(reminderId);
            return false;
        }
    }

    /**
     * Cancel a heads-up posted by {@link #postIncomingCallHeadsUp} and
     * also stop the ringtone service. Called by MainActivity when the
     * user responds via the heads-up actions or taps into the activity.
     */
    public static void cancelIncomingCallHeadsUp(Context context, String reminderId) {
        if (reminderId == null) return;
        try {
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.cancel(reminderId.hashCode());
            }
        } catch (Throwable t) {
            Log.w(TAG, "cancelIncomingCallHeadsUp notify cancel failed", t);
        }
        LAST_HEADS_UP_POSTED_AT.remove(reminderId);
        try {
            Intent stopRing = new Intent(context, KumikoCallRingingService.class);
            stopRing.setAction(KumikoCallRingingService.ACTION_STOP);
            context.startService(stopRing);
        } catch (Throwable t) {
            Log.w(TAG, "cancelIncomingCallHeadsUp stop ringer failed", t);
        }
    }

    private static PendingIntent buildMainActivityPi(
        Context context,
        String reminderId,
        String reminderEvent,
        String reminderText,
        String ringtoneFileId,
        String actionExtraKey,
        int requestCode,
        int piFlags
    ) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra(actionExtraKey, reminderId);
        intent.putExtra(EXTRA_REMINDER_EVENT, reminderEvent != null ? reminderEvent : "");
        intent.putExtra(EXTRA_REMINDER_TEXT, reminderText != null ? reminderText : "");
        intent.putExtra(EXTRA_RINGTONE_FILE_ID, ringtoneFileId != null ? ringtoneFileId : "");
        return PendingIntent.getActivity(context, requestCode, intent, piFlags);
    }

    private static void writeSelfTestNotifPostedAt(Context context, String reminderId) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(SELF_TEST_PREFS, Context.MODE_PRIVATE);
            if (!prefs.getBoolean(SELF_TEST_KEY_ARMED, false)) return;
            String armedId = prefs.getString(SELF_TEST_KEY_REMINDER_ID, null);
            if (armedId == null || !armedId.equals(reminderId)) return;
            prefs.edit().putLong(SELF_TEST_KEY_NOTIF_POSTED_AT, System.currentTimeMillis()).apply();
        } catch (Throwable t) {
            Log.w(TAG, "writeSelfTestNotifPostedAt failed", t);
        }
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

    // === v2.14.23 ledger / guardian / phone-account helpers ===========

    /**
     * Persist a single alarm row to the ledger SharedPreferences. Called
     * from scheduleExact and re-callable from the boot receiver after a
     * pruneExpiredLedgerInternal pass.
     */
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

    /**
     * Returns int[] { prunedCount, remainingCount }. Called from the
     * pruneExpiredLedger plugin method AND from KumikoBootReceiver before
     * it iterates remaining rows to re-schedule them.
     */
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
                // Corrupt row — drop it so the boot receiver doesn't trip.
                editor.remove(key);
                pruned++;
            }
        }
        editor.apply();
        return new int[] { pruned, remaining };
    }

    /**
     * Iterate the ledger and return one JSObject per still-pending row.
     * Used by KumikoBootReceiver to feed scheduleAlarmInternal.
     */
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

    /**
     * Best-effort detector for Xiaomi MIUI / HyperOS using the same brand
     * checks as KumikoVendorPermissionHelper. Avoid pulling in the helper's
     * full dependency graph here — we just want a single boolean.
     */
    public static boolean isXiaomiHyperOs() {
        String brand = String.valueOf(Build.BRAND).toLowerCase();
        String manufacturer = String.valueOf(Build.MANUFACTURER).toLowerCase();
        return brand.contains("xiaomi") || brand.contains("redmi") || manufacturer.contains("xiaomi");
    }

    public static void startGuardianService(Context context, String reason) {
        Intent intent = new Intent(context, KumikoAlarmGuardianService.class);
        intent.putExtra(KumikoAlarmGuardianService.EXTRA_START_REASON, reason != null ? reason : "unknown");
        try {
            // Foreground service rules: on Android 12+ we MUST start with
            // ContextCompat.startForegroundService and the service has 5s
            // to call startForeground(). The guardian's onStartCommand is
            // strict about this.
            ContextCompat.startForegroundService(context, intent);
        } catch (Throwable t) {
            Log.w(TAG, "startForegroundService failed; trying startService as fallback", t);
            try {
                context.startService(intent);
            } catch (Throwable ignored) {}
        }
    }

    public static PhoneAccountHandle buildPhoneAccountHandle(Context context) {
        ComponentName component = new ComponentName(context, KumikoConnectionService.class);
        return new PhoneAccountHandle(component, PHONE_ACCOUNT_ID);
    }
}
