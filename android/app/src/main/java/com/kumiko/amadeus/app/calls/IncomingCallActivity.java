// android/app/src/main/java/com/kumiko/amadeus/app/calls/IncomingCallActivity.java
//
// B.3 (A6.3): full-screen incoming call activity launched by
// KumikoAlarmReceiver when a user-set reminder fires AND the user
// has TTS enabled (the only "AI calls" path per the plan: text mode
// reminders + RNG / sleep / busy proactives all stay as silent
// MessagingStyle notifications).
//
// Design choices:
//   - Manifest sets `showOnLockScreen` + `turnScreenOn` so the activity
//     pierces the keyguard and turns the display on. We additionally
//     call setShowWhenLocked / setTurnScreenOn at runtime as a belt-
//     and-suspenders for older Android versions where the manifest
//     attributes weren't honoured.
//   - The activity hosts a tiny native UI (just two buttons) instead
//     of trying to render React; the WebView would take 1-2 seconds
//     to start which kills the "instant LINE-style call" feel.
//   - On Accept: launch MainActivity with a pending-action extra
//     "kumiko_pending_action=accept_call" + reminder payload. The
//     WebView reads this on resume (via @capacitor/app's appUrlOpen
//     event which we hook in JS later) and replays the existing
//     setVoiceCallOverlayData accept path.
//   - On Reject: drop everything, finish() the activity. Logging the
//     reject as a missed-call alert is also done by the WebView via
//     the same pending-action queue (action="reject_call").
//
// v2.14.21: the call screen is also the reliable ringtone/vibration
// fallback. Full-screen notification routing wakes the activity from
// background/lock screen; this activity then loops the user's selected
// ringtone until Accept/Reject/onDestroy.

package com.kumiko.amadeus.app.calls;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.kumiko.amadeus.app.MainActivity;
import com.kumiko.amadeus.app.alarms.KumikoAlarmReceiver;

public class IncomingCallActivity extends Activity {

    private static final String TAG = "IncomingCallActivity";
    private static final long[] CALL_VIBRATION_PATTERN = new long[]{0, 650, 250, 650, 250, 900};

    public static final String PENDING_ACTION_ACCEPT = "accept_call";
    public static final String PENDING_ACTION_REJECT = "reject_call";
    public static final String EXTRA_PENDING_ACTION = "kumiko_pending_action";

    private String reminderId;
    private String reminderEvent;
    private String reminderText;
    private String ringtoneFileId;
    private MediaPlayer ringtonePlayer;
    private Vibrator vibrator;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Pierce keyguard + wake screen on Android 8.1+. Older devices
        // honor the manifest attributes only.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            //noinspection deprecation
            getWindow().addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
            );
        }

        Intent intent = getIntent();
        reminderId = intent.getStringExtra(KumikoAlarmReceiver.EXTRA_REMINDER_ID);
        reminderEvent = intent.getStringExtra(KumikoAlarmReceiver.EXTRA_REMINDER_EVENT);
        reminderText = intent.getStringExtra(KumikoAlarmReceiver.EXTRA_REMINDER_TEXT);
        ringtoneFileId = intent.getStringExtra(KumikoAlarmReceiver.EXTRA_RINGTONE_FILE_ID);
        if (reminderEvent == null) reminderEvent = "提醒";
        if (reminderText == null) reminderText = reminderEvent;

        setContentView(buildLayout());
        startRinging();
    }

    private View buildLayout() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        // Cream background matching the rest of the app brand.
        root.setBackground(new ColorDrawable(Color.parseColor("#f9f7f2")));
        root.setPadding(48, 96, 48, 96);

        TextView header = new TextView(this);
        header.setText("黄前久美子 来电");
        header.setTextSize(20);
        header.setGravity(Gravity.CENTER);
        header.setTextColor(Color.parseColor("#5b4732"));
        header.setPadding(0, 0, 0, 24);
        root.addView(header);

        TextView eventText = new TextView(this);
        eventText.setText(reminderEvent);
        eventText.setTextSize(28);
        eventText.setGravity(Gravity.CENTER);
        eventText.setTextColor(Color.parseColor("#785A42"));
        eventText.setPadding(0, 0, 0, 64);
        root.addView(eventText);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.CENTER);

        Button reject = new Button(this);
        reject.setText("挂断 · Reject");
        reject.setOnClickListener(v -> dispatch(PENDING_ACTION_REJECT));
        LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        rp.setMargins(0, 0, 24, 0);
        buttons.addView(reject, rp);

        Button accept = new Button(this);
        accept.setText("接听 · Accept");
        accept.setOnClickListener(v -> dispatch(PENDING_ACTION_ACCEPT));
        buttons.addView(accept);

        root.addView(buttons);
        return root;
    }

    private void dispatch(String action) {
        stopRinging();
        cancelCallNotification();
        if (PENDING_ACTION_ACCEPT.equals(action)) {
            // Bring MainActivity to the foreground with the pending-action
            // payload. JS App.tsx hooks @capacitor/app's appResume event to
            // drain SharedPreferences for any pending action, then routes
            // through the existing setVoiceCallOverlayData accept path
            // (chatActions.triggerTimedReminderMessage's onAccept closure).
            Intent main = new Intent(this, MainActivity.class);
            main.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            main.putExtra(EXTRA_PENDING_ACTION, action);
            main.putExtra(KumikoAlarmReceiver.EXTRA_REMINDER_ID, reminderId);
            main.putExtra(KumikoAlarmReceiver.EXTRA_REMINDER_EVENT, reminderEvent);
            main.putExtra(KumikoAlarmReceiver.EXTRA_REMINDER_TEXT, reminderText);
            startActivity(main);
        } else {
            // Reject: stash the action in SharedPreferences so the next time
            // the user opens the app the WebView can record a "missed call"
            // alert. Doesn't bring the app to the foreground.
            getSharedPreferences("kumiko_pending_actions", MODE_PRIVATE)
                .edit()
                .putString("last_action", PENDING_ACTION_REJECT)
                .putString("last_reminder_id", reminderId)
                .putString("last_reminder_event", reminderEvent)
                .putLong("last_action_at", System.currentTimeMillis())
                .apply();
        }
        finish();
    }

    @Override
    protected void onDestroy() {
        stopRinging();
        cancelCallNotification();
        super.onDestroy();
    }

    private void startRinging() {
        startVibration();
        try {
            ringtonePlayer = createConfiguredRingtonePlayer();
            if (ringtonePlayer != null) {
                ringtonePlayer.setLooping(true);
                ringtonePlayer.start();
                return;
            }
        } catch (Throwable t) {
            Log.w(TAG, "Configured ringtone failed; falling back to system ringtone", t);
            releasePlayer();
        }

        try {
            Uri defaultRingtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            ringtonePlayer = MediaPlayer.create(this, defaultRingtone);
            if (ringtonePlayer != null) {
                ringtonePlayer.setLooping(true);
                ringtonePlayer.start();
            }
        } catch (Throwable t) {
            Log.w(TAG, "System ringtone fallback failed", t);
            releasePlayer();
        }
    }

    private MediaPlayer createConfiguredRingtonePlayer() throws Exception {
        String id = ringtoneFileId == null ? "" : ringtoneFileId.trim();
        MediaPlayer player = new MediaPlayer();
        player.setAudioAttributes(new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build());

        if (id.matches("^0[1-8]\\.mp3$")) {
            AssetFileDescriptor afd = null;
            try {
                afd = getAssets().openFd("public/ringtones/" + id);
                player.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
            } finally {
                if (afd != null) {
                    try { afd.close(); } catch (Throwable ignored) {}
                }
            }
            player.prepare();
            return player;
        }

        if (id.matches("^custom\\.(mp3|wav|ogg|m4a|aac|flac)$")) {
            java.io.File file = new java.io.File(new java.io.File(getFilesDir(), "ringtones"), id);
            if (file.exists() && file.length() > 0) {
                player.setDataSource(file.getAbsolutePath());
                player.prepare();
                return player;
            }
        }

        try { player.release(); } catch (Throwable ignored) {}
        return null;
    }

    private void startVibration() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                VibratorManager manager = (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                vibrator = manager != null ? manager.getDefaultVibrator() : null;
            } else {
                //noinspection deprecation
                vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            }
            if (vibrator == null || !vibrator.hasVibrator()) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createWaveform(CALL_VIBRATION_PATTERN, 0));
            } else {
                //noinspection deprecation
                vibrator.vibrate(CALL_VIBRATION_PATTERN, 0);
            }
        } catch (Throwable t) {
            Log.w(TAG, "Call vibration failed", t);
        }
    }

    private void stopRinging() {
        try {
            if (vibrator != null) vibrator.cancel();
        } catch (Throwable ignored) {}
        releasePlayer();
    }

    private void releasePlayer() {
        try {
            if (ringtonePlayer != null) {
                if (ringtonePlayer.isPlaying()) ringtonePlayer.stop();
                ringtonePlayer.release();
            }
        } catch (Throwable ignored) {
        } finally {
            ringtonePlayer = null;
        }
    }

    private void cancelCallNotification() {
        if (reminderId == null) return;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(reminderId.hashCode());
        } catch (Throwable ignored) {}
    }
}
