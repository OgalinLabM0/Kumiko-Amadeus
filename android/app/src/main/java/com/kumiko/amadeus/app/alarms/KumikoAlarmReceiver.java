// android/app/src/main/java/com/kumiko/amadeus/app/alarms/KumikoAlarmReceiver.java
//
// v2.14.27: silent activity wake + short-lived FGS. Replaces the v2.14.24-26
// "notification-first" path that posted CallStyle notifications and started
// KumikoCallRingingService directly from native. Now the receiver does
// nothing user-visible — it just wakes the WebView (silent MainActivity
// launch) and ensures a foreground service is running for ~30 s so the JS
// LLM generation has process headroom even if the user's screen never lit.
//
// Flow:
//   1. Acquire short wake lock.
//   2. startForegroundService(KumikoAlarmGuardianService, ACTION_REMINDER_DISPATCH)
//      with the reminder extras. Service shows a low-importance "preparing"
//      notification and self-stops after 30 s if JS doesn't take over.
//   3. startActivity(MainActivity, NEW_TASK | NO_HISTORY | NO_USER_ACTION)
//      with EXTRA_REMINDER_FIRED + payload. MainActivity.onNewIntent will
//      bridge this into a `kumikoAlarmFired` JS event; the JS listener
//      then runs the LLM and posts the final notification through
//      LocalNotifications.
//   4. Release wake lock; FGS keeps the process alive from here.
//
// Trade-offs (acknowledged in the v2.14.27 plan):
//   - On an active (lit) screen the silent activity launch may flash for a
//     frame; on a locked screen it's invisible. Accepted by the user.
//   - We no longer differentiate text vs. call mode in native code; the JS
//     listener decides which channel to post into based on the wantsCall
//     flag bridged through the JS event payload.

package com.kumiko.amadeus.app.alarms;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.PowerManager;
import android.util.Log;

import com.kumiko.amadeus.app.MainActivity;

public class KumikoAlarmReceiver extends BroadcastReceiver {

    public static final String EXTRA_REMINDER_ID = "reminder_id";
    public static final String EXTRA_REMINDER_EVENT = "reminder_event";
    public static final String EXTRA_REMINDER_TEXT = "reminder_text";
    public static final String EXTRA_WANTS_CALL = "wants_call";
    public static final String EXTRA_RINGTONE_FILE_ID = "ringtone_file_id";
    /** v2.14.23: marks the T-5min Xiaomi prewarm alarm. The receiver
     *  treats it as a no-op (just consumes the wake to nudge the kernel
     *  out of deep doze before the real alarm fires). */
    public static final String EXTRA_IS_PREWARM = "is_prewarm";
    /** v2.14.27: tells MainActivity that the activity launch was caused by
     *  an alarm and the WebView should be notified via a kumikoAlarmFired
     *  JS event. Pre-v2.14.27 receiver builds did not set this. */
    public static final String EXTRA_REMINDER_FIRED = "kumiko_reminder_fired";

    private static final String TAG = "KumikoAlarmReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        // Hold a wake lock for ≤30s while we dispatch the silent wake-up.
        // FGS will keep the system alive after we release it; this just
        // covers the brief window before the service binder lands.
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
            if (isPrewarm) {
                Log.i(TAG, "Prewarm alarm fired (no-op): id=" + reminderId);
                return;
            }

            Log.i(TAG, "Alarm fired: id=" + reminderId + " event=" + reminderEvent + " wantsCall=" + wantsCall);

            // Step 1: kick off (or upgrade) the alarm guardian foreground
            // service. It shows a "preparing reminder" placeholder
            // notification and self-stops after 30 s if JS doesn't take
            // over by then. Process stays alive for the duration so JS
            // LLM generation can run.
            try {
                Intent fgsIntent = new Intent(context, KumikoAlarmGuardianService.class);
                fgsIntent.setAction(KumikoAlarmGuardianService.ACTION_REMINDER_DISPATCH);
                fgsIntent.putExtra(EXTRA_REMINDER_ID, reminderId);
                fgsIntent.putExtra(EXTRA_REMINDER_EVENT, reminderEvent);
                fgsIntent.putExtra(EXTRA_REMINDER_TEXT, reminderText);
                fgsIntent.putExtra(EXTRA_WANTS_CALL, wantsCall);
                fgsIntent.putExtra(EXTRA_RINGTONE_FILE_ID, ringtoneFileId != null ? ringtoneFileId : "");
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(fgsIntent);
                } else {
                    context.startService(fgsIntent);
                }
            } catch (Throwable t) {
                Log.w(TAG, "startForegroundService(KumikoAlarmGuardianService) failed", t);
            }

            // Step 2: silent MainActivity wake. FLAG_ACTIVITY_NEW_TASK is
            // required for receiver context starts; NO_HISTORY makes the
            // launch transient (won't show up in Recents); NO_USER_ACTION
            // suppresses ringtone/sound intent broadcasts that other
            // listeners might react to. MainActivity.onNewIntent reads
            // EXTRA_REMINDER_FIRED and bridges the payload to JS.
            try {
                Intent wakeIntent = new Intent(context, MainActivity.class);
                wakeIntent.setFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_NO_HISTORY
                    | Intent.FLAG_ACTIVITY_NO_USER_ACTION
                );
                wakeIntent.putExtra(EXTRA_REMINDER_FIRED, true);
                wakeIntent.putExtra(EXTRA_REMINDER_ID, reminderId);
                wakeIntent.putExtra(EXTRA_REMINDER_EVENT, reminderEvent);
                wakeIntent.putExtra(EXTRA_REMINDER_TEXT, reminderText);
                wakeIntent.putExtra(EXTRA_WANTS_CALL, wantsCall);
                wakeIntent.putExtra(EXTRA_RINGTONE_FILE_ID, ringtoneFileId != null ? ringtoneFileId : "");
                context.startActivity(wakeIntent);
            } catch (Throwable t) {
                // Android 14+ may reject background activity starts on
                // some OEMs even with the alarm-bg permission; the FGS
                // alone keeps the process alive long enough for the next
                // user resume to drain the reminder. We log and move on.
                Log.w(TAG, "startActivity(MainActivity) wake failed", t);
            }

            // v2.14.23: alarm has fired; remove its ledger row so a reboot
            // doesn't resurrect it. Done AFTER dispatch so a thrown wake
            // is preferred over a silently-dropped reboot resurrection.
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
}
