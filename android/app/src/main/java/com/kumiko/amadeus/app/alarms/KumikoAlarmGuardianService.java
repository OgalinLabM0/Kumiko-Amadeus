// android/app/src/main/java/com/kumiko/amadeus/app/alarms/KumikoAlarmGuardianService.java
//
// v2.14.23: long-running foreground service that visibly anchors our
// process priority while at least one user reminder is pending. On
// aggressive ROMs (MIUI/HyperOS, EMUI/HarmonyOS, OneUI's "deep sleep"
// list) a backgrounded app is repeatedly suspended and eventually
// killed; once killed, AlarmManager is supposed to still fire our
// PendingIntent and start a new process to deliver, but in practice
// the kill+restart cycle introduces drift (10s-5min depending on the
// vendor). Holding a foregroundServiceType="specialUse" ongoing
// notification keeps the OOM score low enough that the kill loop
// never starts in the first place.
//
// Why subtype="specialUse"? Android 14 (SDK 34) requires every FGS
// to declare a foregroundServiceType matching its purpose. None of
// the predefined types (camera, dataSync, location, mediaPlayback,
// phoneCall, …) cleanly fit "I'm guarding alarms"; "specialUse" is
// the documented escape hatch for use cases not covered by the
// predefined list, and requires a justification string in the
// manifest (see <property> on the service element). We use the
// `subtype` extra "alarm" to communicate the actual purpose.
//
// Lifecycle:
//   - JS / native scheduleExact starts us via startGuardianService()
//   - We post the ongoing notification, call startForeground() within
//     the 5s deadline, then sit idle. We do NOT do any background
//     work; we are purely a process-priority anchor.
//   - JS / native cancel-when-empty stops us via stopAlarmGuardian().
//     We do NOT auto-stop on our own — the JS reminder slice is the
//     authoritative source of "are there pending reminders".
//   - On reboot, KumikoBootReceiver re-starts us iff the ledger has
//     non-empty rows.
//
// Notification design:
//   - kumiko_messages channel reused with PRIORITY_MIN to avoid
//     adding noise. The user sees a small persistent row in the
//     notification shade saying "Kumiko is guarding your reminders".
//     Tapping it opens MainActivity; otherwise it's silent.

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
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import com.kumiko.amadeus.app.MainActivity;

public class KumikoAlarmGuardianService extends Service {

    public static final String EXTRA_START_REASON = "kumiko_guardian_start_reason";
    private static final String TAG = "AlarmGuardianSvc";
    private static final int NOTIFICATION_ID = 921025;
    private static final String CHANNEL_ID_GUARDIAN = "kumiko_guardian";

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String reason = intent != null ? intent.getStringExtra(EXTRA_START_REASON) : "unknown";
        Log.i(TAG, "onStartCommand reason=" + reason);
        try {
            ensureGuardianChannel(this);
            Notification notification = buildOngoingNotification();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                // Android 14+ requires the explicit type in startForeground().
                // We use FOREGROUND_SERVICE_TYPE_SPECIAL_USE because none of
                // the predefined types cleanly fit "alarm guardian".
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIFICATION_ID, notification);
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
        super.onDestroy();
    }

    private Notification buildOngoingNotification() {
        Intent tapIntent = new Intent(this, MainActivity.class);
        tapIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentPi = PendingIntent.getActivity(
            this,
            NOTIFICATION_ID,
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(this, CHANNEL_ID_GUARDIAN)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
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
