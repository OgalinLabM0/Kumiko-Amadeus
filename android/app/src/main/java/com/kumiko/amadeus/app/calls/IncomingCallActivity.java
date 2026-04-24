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
// We deliberately don't play a ringtone here — the LocalNotification
// channel kumiko_calls (created from JS) already has a vibration
// pattern + system ringer, and adding a duplicate audio source from
// native would conflict.

package com.kumiko.amadeus.app.calls;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.kumiko.amadeus.app.MainActivity;
import com.kumiko.amadeus.app.alarms.KumikoAlarmReceiver;

public class IncomingCallActivity extends Activity {

    public static final String PENDING_ACTION_ACCEPT = "accept_call";
    public static final String PENDING_ACTION_REJECT = "reject_call";
    public static final String EXTRA_PENDING_ACTION = "kumiko_pending_action";

    private String reminderId;
    private String reminderEvent;
    private String reminderText;

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
        if (reminderEvent == null) reminderEvent = "提醒";
        if (reminderText == null) reminderText = reminderEvent;

        setContentView(buildLayout());
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
}
