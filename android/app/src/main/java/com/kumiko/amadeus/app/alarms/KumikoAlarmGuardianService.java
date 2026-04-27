// android/app/src/main/java/com/kumiko/amadeus/app/alarms/KumikoAlarmGuardianService.java
//
// v2.14.23: long-running foreground service that visibly anchors our
// process priority while at least one user reminder is pending.
//
// v2.14.27: now also handles short-lived "reminder dispatch" runs. When the
// receiver fires it starts the service with ACTION_REMINDER_DISPATCH; the
// service upgrades the same notification ID to a low-importance "Kumiko 正
// 在准备提醒…" placeholder for ≤30 s, gives JS room to run the LLM, and
// auto-stops if JS doesn't ack with stopForeground sooner.
//
// Why subtype="specialUse"? Android 14 (SDK 34) requires every FGS
// to declare a foregroundServiceType matching its purpose. None of
// the predefined types (camera, dataSync, location, mediaPlayback,
// phoneCall, …) cleanly fit "I'm guarding alarms"; "specialUse" is
// the documented escape hatch for use cases not covered by the
// predefined list.
//
// Lifecycle:
//   - JS / native scheduleExact starts us via startGuardianService()
//   - Receiver-triggered REMINDER_DISPATCH runs share the same Service
//     instance (Android pipes onStartCommand into a single Service).
//   - JS / native cancel-when-empty stops us via stopAlarmGuardian().
//   - On reboot, KumikoBootReceiver re-starts us iff the ledger has
//     non-empty rows.

package com.kumiko.amadeus.app.alarms;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import com.kumiko.amadeus.app.MainActivity;
import com.kumiko.amadeus.app.R;

public class KumikoAlarmGuardianService extends Service {

    public static final String EXTRA_START_REASON = "kumiko_guardian_start_reason";
    /** v2.14.27: when set, onStartCommand temporarily upgrades the ongoing
     *  notification to a low-importance "Kumiko 正在准备提醒…" placeholder
     *  and arms a 30 s self-stop timer. JS can stop early by stopping the
     *  service via stopAlarmGuardian once the LLM-generated notification
     *  has been posted. */
    public static final String ACTION_REMINDER_DISPATCH = "com.kumiko.amadeus.alarms.REMINDER_DISPATCH";
    /** v2.14.27: how long the dispatch placeholder is kept up before we
     *  self-stop. JS LLM generation typically completes in 2-15 s; 30 s
     *  is a safe ceiling that still lets the user dismiss the placeholder
     *  manually if generation hangs. */
    private static final long REMINDER_DISPATCH_TIMEOUT_MS = 30_000L;

    private static final String TAG = "AlarmGuardianSvc";
    private static final int NOTIFICATION_ID = 921025;
    private static final String CHANNEL_ID_GUARDIAN = "kumiko_guardian";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    @Nullable
    private Runnable dispatchTimeout;

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        String reason = intent != null ? intent.getStringExtra(EXTRA_START_REASON) : "unknown";
        Log.i(TAG, "onStartCommand action=" + action + " reason=" + reason);
        try {
            ensureGuardianChannel(this);
            boolean isDispatch = ACTION_REMINDER_DISPATCH.equals(action);
            Notification notification = isDispatch
                ? buildDispatchNotification()
                : buildAnchorNotification();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                // Android 14+ requires the explicit type in startForeground().
                // FOREGROUND_SERVICE_TYPE_SPECIAL_USE because none of the
                // predefined types cleanly fits "alarm guardian".
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            if (isDispatch) {
                armDispatchTimeout();
            } else {
                cancelDispatchTimeout();
            }
        } catch (Throwable t) {
            Log.e(TAG, "Failed to enter foreground; stopping self to avoid ANR", t);
            stopSelf();
            return START_NOT_STICKY;
        }
        // START_STICKY is correct here: if Android low-memory-kills us,
        // the framework will redeliver onStartCommand with a null intent
        // so we re-anchor the process. JS still controls explicit stops
        // via stopAlarmGuardian().
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "onDestroy");
        cancelDispatchTimeout();
        super.onDestroy();
    }

    private void armDispatchTimeout() {
        cancelDispatchTimeout();
        dispatchTimeout = () -> {
            Log.i(TAG, "Reminder dispatch timeout reached; downgrading to anchor");
            try {
                NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) {
                    // Either drop back to the long-term anchor (if JS hasn't
                    // explicitly stopped us) or stop entirely. Stopping is
                    // the safer default; the boot receiver / scheduleExact
                    // will re-anchor when the next reminder arms.
                    nm.cancel(NOTIFICATION_ID);
                }
            } catch (Throwable t) {
                Log.w(TAG, "Failed to cancel dispatch placeholder on timeout", t);
            }
            stopSelf();
        };
        mainHandler.postDelayed(dispatchTimeout, REMINDER_DISPATCH_TIMEOUT_MS);
    }

    private void cancelDispatchTimeout() {
        if (dispatchTimeout != null) {
            mainHandler.removeCallbacks(dispatchTimeout);
            dispatchTimeout = null;
        }
    }

    private Notification buildAnchorNotification() {
        Intent tapIntent = new Intent(this, MainActivity.class);
        tapIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentPi = PendingIntent.getActivity(
            this,
            NOTIFICATION_ID,
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(this, CHANNEL_ID_GUARDIAN)
            .setSmallIcon(R.drawable.ic_stat_kumiko)
            .setContentTitle("Kumiko·Amadeus")
            .setContentText("提醒守护中 · keeping reminders alive")
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(contentPi)
            .setOngoing(true)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .build();
    }

    /**
     * v2.14.27: short-lived "preparing reminder" placeholder shown while JS
     * generates the LLM response. Bumped to PRIORITY_LOW so the user knows
     * something is happening, but not enough to trigger sound/vibration —
     * the final notification (posted by JS via LocalNotifications) is what
     * actually rings.
     */
    private Notification buildDispatchNotification() {
        Intent tapIntent = new Intent(this, MainActivity.class);
        tapIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentPi = PendingIntent.getActivity(
            this,
            NOTIFICATION_ID,
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(this, CHANNEL_ID_GUARDIAN)
            .setSmallIcon(R.drawable.ic_stat_kumiko)
            .setContentTitle("Kumiko·Amadeus")
            .setContentText("正在准备提醒… · preparing reminder")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(contentPi)
            .setOngoing(true)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .build();
    }

    private static void ensureGuardianChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID_GUARDIAN) != null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID_GUARDIAN,
            "守护进程 · Guardian",
            NotificationManager.IMPORTANCE_MIN
        );
        channel.setDescription("低优先级守护通知，让提醒不被系统杀掉");
        channel.setShowBadge(false);
        nm.createNotificationChannel(channel);
    }
}
