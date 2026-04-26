// android/app/src/main/java/com/kumiko/amadeus/app/alarms/KumikoAlarmReceiver.java
//
// B.2 (A6.4): the BroadcastReceiver invoked by AlarmManager when a
// user's scheduled reminder fires.
//
// v2.14.24 architecture switch — "notification first":
//   1. Voice-call reminder (wantsCall=true) → ALWAYS post the heads-up
//      CallStyle notification via KumikoAlarmsPlugin.postIncomingCallHeadsUp,
//      AND start KumikoCallRingingService (foreground service that loops
//      ringtone audio + persistent vibration). On API 31+ we ADDITIONALLY
//      try Telecom.addNewIncomingCall — but this is purely additive: the
//      heads-up + ringer are guaranteed-up regardless of whether Telecom
//      eventually accepts the call. This eliminates the v2.14.23 silent-
//      failure mode where Telecom queued the call asynchronously, then
//      KumikoConnectionService.onCreateIncomingConnectionFailed got
//      invoked with no fallback and the user saw nothing.
//   2. Text-mode reminder → normal LocalNotification on
//      kumiko_messages_v3 channel; user taps to open app.
//
// CRITICAL: the routing decision is made ENTIRELY HERE in native code,
// because the JS WebView may not be alive when the alarm fires. We
// don't have access to the user's TtsConfig from native land, so we
// just encode the choice into the PendingIntent's extras at schedule
// time (see KumikoAlarmsPlugin.scheduleExact). When the receiver
// fires, we read `wantsCall` from extras and act accordingly.
//
// Wake-lock acquired briefly so the system doesn't go back to sleep
// while we post the notification / start the foreground ringer. Released
// after dispatch (or 30s ceiling). Once the FG service is running it
// keeps the system alive on its own.

package com.kumiko.amadeus.app.alarms;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.telecom.PhoneAccount;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.kumiko.amadeus.app.MainActivity;
import com.kumiko.amadeus.app.calls.KumikoCallRingingService;

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
                // v2.14.24: notification-first. Always post the heads-up +
                // start the ringer. Telecom is best-effort additive and
                // does NOT prevent us from showing the call.
                dispatchHeadsUpReminder(context, reminderId, reminderEvent, reminderText, ringtoneFileId);
                tryDispatchSelfManagedCall(context, reminderId, reminderEvent, reminderText, ringtoneFileId);
            } else {
                // Route 2: text-mode reminder via a normal LocalNotification.
                KumikoAlarmsPlugin.ensureMessagesChannel(context);

                Intent tapIntent = new Intent(context, MainActivity.class);
                tapIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                tapIntent.putExtra(EXTRA_REMINDER_ID, reminderId);
                int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
                PendingIntent contentPi = PendingIntent.getActivity(context, reminderId.hashCode(), tapIntent, piFlags);

                Notification notification = new NotificationCompat.Builder(context, KumikoAlarmsPlugin.CHANNEL_ID_MESSAGES)
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
     * v2.14.24: post the heads-up CallStyle notification AND start the
     * dedicated ringer foreground service. The heads-up handles the user-
     * visible UI (banner / FSI on lock screen / accept-decline buttons),
     * while {@link KumikoCallRingingService} owns the persistent ringtone
     * audio and vibration loop. We never call {@code startActivity} from
     * here — Android 12+ blocks background activity starts, so the heads-
     * up's tap-into-MainActivity flow is the only reliable path.
     */
    private void dispatchHeadsUpReminder(
        Context context,
        String reminderId,
        String reminderEvent,
        String reminderText,
        String ringtoneFileId
    ) {
        KumikoAlarmsPlugin.postIncomingCallHeadsUp(
            context, reminderId, reminderEvent, reminderText, ringtoneFileId
        );
        try {
            Intent ringer = new Intent(context, KumikoCallRingingService.class);
            ringer.putExtra(KumikoCallRingingService.EXTRA_REMINDER_ID, reminderId);
            ringer.putExtra(KumikoCallRingingService.EXTRA_RINGTONE_FILE_ID,
                ringtoneFileId != null ? ringtoneFileId : "");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(ringer);
            } else {
                context.startService(ringer);
            }
        } catch (Throwable t) {
            Log.w(TAG, "startForegroundService(KumikoCallRingingService) failed", t);
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

    // v2.14.24: ensureMessagesChannel / ensureCallsChannel previously
    // duplicated here are now centralized in
    // {@link KumikoAlarmsPlugin#ensureMessagesChannel(Context)} /
    // {@link KumikoAlarmsPlugin#ensureCallsChannel(Context)}. Whichever
    // call site reaches them first wins, but because they all create the
    // same channel object the result is deterministic regardless of order.
}
