// android/app/src/main/java/com/kumiko/amadeus/app/alarms/KumikoBootReceiver.java
//
// v2.14.23: rebuild AlarmManager state after device reboot or app
// upgrade. AlarmManager forgets every pending alarm at every reboot
// (this is the documented Android behaviour, not a bug); without this
// receiver every reminder set before the user's nightly reboot
// silently misses. We persist enough metadata in the SharedPreferences
// "kumiko_alarm_ledger" (see KumikoAlarmsPlugin.persistLedgerEntry)
// to feed scheduleAlarmInternal again here.
//
// Triggers:
//   - BOOT_COMPLETED        — standard cold reboot.
//   - LOCKED_BOOT_COMPLETED — fires earlier than BOOT_COMPLETED on
//     devices using direct boot (FBE), before user unlock; we still
//     re-register so the alarm queue is back even before unlock.
//   - QUICKBOOT_POWERON     — HTC/Asus/Xiaomi quickboot path; some
//     ROMs only fire this and skip BOOT_COMPLETED.
//   - MY_PACKAGE_REPLACED   — fires when our APK upgrade replaces the
//     installed app. AlarmManager resets across upgrades too.
//
// Why not "ACTION_REBOOT"? That's a privileged action that requires
// REBOOT permission and isn't broadcast to user apps anyway.
//
// Pruning: we run pruneExpiredLedgerInternal first so any reminder
// whose `at` is in the past doesn't immediately re-fire on resume.
// The 60s "grace" window matches the JS-side prune so a reminder
// scheduled to fire right at boot doesn't get unfairly dropped.
//
// Guardian: after re-scheduling, if any non-expired rows remain, we
// also re-launch KumikoAlarmGuardianService so process-priority is
// anchored from boot onwards.

package com.kumiko.amadeus.app.alarms;

import android.app.AlarmManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.UserManager;
import android.util.Log;

import org.json.JSONObject;

import java.util.List;

public class KumikoBootReceiver extends BroadcastReceiver {

    private static final String TAG = "KumikoBootReceiver";
    private static final String ACTION_QUICKBOOT_POWERON = "android.intent.action.QUICKBOOT_POWERON";
    private static final String ACTION_HTC_QUICKBOOT_POWERON = "com.htc.intent.action.QUICKBOOT_POWERON";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        Log.i(TAG, "onReceive action=" + action);
        if (action == null) return;

        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
            && !Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)
            && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
            && !ACTION_QUICKBOOT_POWERON.equals(action)
            && !ACTION_HTC_QUICKBOOT_POWERON.equals(action)) {
            return;
        }

        // Direct-boot guard. Our ledger lives in default SharedPreferences
        // (credential-encrypted storage), which is unavailable until the
        // user unlocks for the first time on FBE-enabled devices (Pixel 6+
        // and most modern Android 10+). LOCKED_BOOT_COMPLETED fires before
        // unlock; if we proceed in that window we'll either crash or read
        // an empty ledger and silently drop every reminder. We bail and
        // wait for the regular BOOT_COMPLETED (which fires after first
        // unlock and is queued to us automatically).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            UserManager userManager = (UserManager) context.getSystemService(Context.USER_SERVICE);
            if (userManager != null && !userManager.isUserUnlocked()) {
                Log.i(TAG, "User not yet unlocked; deferring boot recovery to post-unlock BOOT_COMPLETED");
                return;
            }
        }

        try {
            int[] counts = KumikoAlarmsPlugin.pruneExpiredLedgerInternal(context);
            Log.i(TAG, "Ledger pruned=" + counts[0] + " remaining=" + counts[1]);
            if (counts[1] <= 0) return;

            AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (am == null) {
                Log.w(TAG, "AlarmManager unavailable on boot; cannot re-schedule");
                return;
            }
            List<JSONObject> rows = KumikoAlarmsPlugin.readPendingLedgerEntries(context);
            int scheduled = 0;
            for (JSONObject row : rows) {
                try {
                    String reminderId = row.optString("reminderId");
                    long at = row.optLong("at", 0L);
                    if (reminderId == null || reminderId.isEmpty() || at <= 0L) continue;
                    String event = row.optString("event", "提醒");
                    String text = row.optString("text", event);
                    boolean wantsCall = row.optBoolean("wantsCall", false);
                    String ringtoneFileId = row.optString("ringtoneFileId", "");
                    boolean ok = KumikoAlarmsPlugin.scheduleAlarmInternal(
                        context, am, reminderId, at, event, text, wantsCall, ringtoneFileId, /*isPrewarm*/ false
                    );
                    if (ok) scheduled++;
                    if (KumikoAlarmsPlugin.isXiaomiHyperOs() && (at - System.currentTimeMillis()) >= 10L * 60_000L) {
                        long prewarmAt = at - 5L * 60_000L;
                        KumikoAlarmsPlugin.scheduleAlarmInternal(
                            context, am, reminderId + KumikoAlarmsPlugin.PREWARM_REMINDER_SUFFIX, prewarmAt,
                            event, text, wantsCall, ringtoneFileId, /*isPrewarm*/ true
                        );
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "Failed to re-schedule one row; continuing", t);
                }
            }
            Log.i(TAG, "Re-scheduled " + scheduled + " of " + rows.size() + " alarms after boot");

            if (scheduled > 0) {
                try {
                    KumikoAlarmsPlugin.startGuardianService(context, "boot:" + action);
                } catch (Throwable t) {
                    Log.w(TAG, "Could not start guardian after boot; alarms still set", t);
                }
            }
        } catch (Throwable t) {
            Log.e(TAG, "Boot recovery failed", t);
        }
    }
}
