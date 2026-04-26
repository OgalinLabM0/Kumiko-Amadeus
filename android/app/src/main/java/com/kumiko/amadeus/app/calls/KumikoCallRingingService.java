// android/app/src/main/java/com/kumiko/amadeus/app/calls/KumikoCallRingingService.java
//
// v2.14.24: foreground service that plays the user's configured ringtone
// and runs a long persistent vibration loop while a Kumiko reminder
// CallStyle heads-up notification is displayed. Replaces the role
// {@link IncomingCallActivity}'s onCreate ringtone playback played in
// v2.14.23. Why split it out into a dedicated service:
//
//   1. We deleted IncomingCallActivity in v2.14.24. Heads-up notification
//      tap goes straight into MainActivity, which renders the React
//      VoiceCallOverlay. The audio loop has to live in its own service
//      so that whichever surface the user taps (heads-up, FSI, lock-screen
//      shade) the ringer keeps going until they respond.
//   2. HyperOS / MIUI kills background MediaPlayer playback aggressively
//      unless the playback is anchored to a foreground service with
//      `phoneCall` subtype. A plain Activity-bound MediaPlayer started
//      from KumikoAlarmReceiver.onReceive sometimes never produces
//      audible sound on Xiaomi devices in deep doze.
//   3. The ringer must auto-stop at 60 s even if the user never responds,
//      to avoid an infinite ringtone loop (a regression we hit in v2.14.20
//      when MediaPlayer.setLooping(true) was forgotten to be cancelled
//      after the activity was swiped away).

package com.kumiko.amadeus.app.calls;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.text.TextUtils;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import com.kumiko.amadeus.app.R;
import com.kumiko.amadeus.app.alarms.KumikoAlarmsPlugin;

import java.io.File;

public class KumikoCallRingingService extends Service {

    private static final String TAG = "KumikoCallRinger";

    /** When set, the service stops playback and removes itself. Used by
     *  MainActivity on incoming-call-action and the dedup helper. */
    public static final String ACTION_STOP = "com.kumiko.amadeus.app.action.STOP_CALL_RINGER";

    public static final String EXTRA_REMINDER_ID = "kumiko_call_ringer_reminder_id";
    public static final String EXTRA_RINGTONE_FILE_ID = "kumiko_call_ringer_ringtone_file_id";

    /** Hard ceiling — even if no caller stops us, the service self-stops
     *  to avoid an infinite ringtone loop. Matches WeChat/LINE behaviour
     *  where an unanswered call rings ~60 s before giving up. */
    private static final long MAX_RING_DURATION_MS = 60_000L;

    /** Persistent vibration pattern (ms): off, on, off, on, … the
     *  {@code repeat=0} parameter loops from index 0 indefinitely. */
    private static final long[] VIBRATE_PATTERN = new long[]{ 0, 800, 600, 800, 600, 800, 600, 800 };

    @Nullable private MediaPlayer mediaPlayer;
    @Nullable private Vibrator vibrator;
    @Nullable private Handler stopHandler;
    @Nullable private Runnable stopRunnable;

    @Nullable @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopRingingAndSelf();
            return START_NOT_STICKY;
        }

        String reminderId = intent != null ? intent.getStringExtra(EXTRA_REMINDER_ID) : null;
        String ringtoneFileId = intent != null ? intent.getStringExtra(EXTRA_RINGTONE_FILE_ID) : null;

        // Promote to foreground IMMEDIATELY (within 5 s of startForegroundService);
        // not doing so on Android 12+ throws a ForegroundServiceDidNotStartInTimeException.
        startInForeground(reminderId);

        try {
            startMediaPlayer(ringtoneFileId);
        } catch (Throwable t) {
            Log.w(TAG, "MediaPlayer start failed", t);
        }
        try {
            startVibrationLoop();
        } catch (Throwable t) {
            Log.w(TAG, "Vibration start failed", t);
        }

        scheduleAutoStop();
        return START_NOT_STICKY;
    }

    private void startInForeground(@Nullable String reminderId) {
        // Use a low-importance "ongoing" notification that the user sees as
        // "Kumiko 来电响铃中" — separate from the high-priority CallStyle
        // heads-up that postIncomingCallHeadsUp() posts. This is just the
        // foreground service tether. Same channel works because it's
        // already imported high-importance for ringing semantics.
        KumikoAlarmsPlugin.ensureCallsChannel(this);
        Notification notification = new NotificationCompat.Builder(this, KumikoAlarmsPlugin.CHANNEL_ID_CALLS)
            .setSmallIcon(R.drawable.ic_stat_kumiko)
            .setContentTitle("黄前久美子 正在响铃")
            .setContentText("点击系统来电卡片接听 / 拒接")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .build();

        int notificationId = reminderId != null ? Math.abs(reminderId.hashCode() ^ 0x4) : 921030;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(notificationId, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // FOREGROUND_SERVICE_TYPE_PHONE_CALL added in Q, became
            // mandatory-on-newer-API on 14+. Pass the type explicitly so
            // the OS routes the service into the phone-call category and
            // doesn't apply normal foreground-service runtime restrictions.
            startForeground(notificationId, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL);
        } else {
            startForeground(notificationId, notification);
        }
    }

    @SuppressLint("UnsafeOptInUsageError")
    private void startMediaPlayer(@Nullable String ringtoneFileId) throws Exception {
        Uri ringtone = resolveRingtoneUri(ringtoneFileId);
        if (ringtone == null) return;
        AudioAttributes attrs = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        mediaPlayer = new MediaPlayer();
        mediaPlayer.setAudioAttributes(attrs);
        mediaPlayer.setLooping(true);
        mediaPlayer.setDataSource(this, ringtone);
        mediaPlayer.setOnPreparedListener(mp -> {
            try { mp.start(); } catch (Throwable ignored) {}
        });
        mediaPlayer.prepareAsync();
    }

    @Nullable
    private Uri resolveRingtoneUri(@Nullable String ringtoneFileId) {
        if (!TextUtils.isEmpty(ringtoneFileId)) {
            // ringtoneFileId is a path inside the app's webview-readable
            // file storage (set by the JS-side ttsConfig). Resolve to a
            // file:// URI if it exists; otherwise fall back to default.
            try {
                File f = new File(getFilesDir(), ringtoneFileId);
                if (f.exists() && f.canRead()) return Uri.fromFile(f);
            } catch (Throwable ignored) {}
            try {
                File f = new File(ringtoneFileId);
                if (f.exists() && f.canRead()) return Uri.fromFile(f);
            } catch (Throwable ignored) {}
        }
        return RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
    }

    private void startVibrationLoop() {
        Vibrator v = resolveVibrator();
        if (v == null || !v.hasVibrator()) return;
        vibrator = v;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // repeat=0 → restart at index 0 of the pattern indefinitely.
            v.vibrate(VibrationEffect.createWaveform(VIBRATE_PATTERN, 0));
        } else {
            //noinspection deprecation
            v.vibrate(VIBRATE_PATTERN, 0);
        }
    }

    @Nullable
    private Vibrator resolveVibrator() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            VibratorManager mgr = (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
            return mgr != null ? mgr.getDefaultVibrator() : null;
        } else {
            //noinspection deprecation
            return (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        }
    }

    private void scheduleAutoStop() {
        stopHandler = new Handler(Looper.getMainLooper());
        stopRunnable = this::stopRingingAndSelf;
        stopHandler.postDelayed(stopRunnable, MAX_RING_DURATION_MS);
    }

    private void stopRingingAndSelf() {
        try {
            if (mediaPlayer != null) {
                try { mediaPlayer.stop(); } catch (Throwable ignored) {}
                try { mediaPlayer.release(); } catch (Throwable ignored) {}
                mediaPlayer = null;
            }
        } catch (Throwable ignored) {}
        try {
            if (vibrator != null) {
                try { vibrator.cancel(); } catch (Throwable ignored) {}
                vibrator = null;
            }
        } catch (Throwable ignored) {}
        try {
            if (stopHandler != null && stopRunnable != null) {
                stopHandler.removeCallbacks(stopRunnable);
            }
            stopHandler = null;
            stopRunnable = null;
        } catch (Throwable ignored) {}
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                //noinspection deprecation
                stopForeground(true);
            }
        } catch (Throwable ignored) {}
        stopSelf();
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        stopRingingAndSelf();
    }
}
