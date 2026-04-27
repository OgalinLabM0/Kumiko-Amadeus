package com.kumiko.amadeus.app;

import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.Window;

import androidx.core.view.WindowCompat;

import com.getcapacitor.BridgeActivity;
import com.kumiko.amadeus.app.alarms.KumikoAlarmReceiver;
import com.kumiko.amadeus.app.alarms.KumikoAlarmsPlugin;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "MainActivity";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register our custom plugins BEFORE super.onCreate so the bridge
        // picks them up at JS bridge initialization. KumikoAlarmsPlugin
        // (v2.14.27 slim) exposes scheduleExact / cancel / prewarm /
        // canScheduleExact / canUseFullScreenIntent / openSettings /
        // drainPendingActions to the services/androidAlarmService.ts JS
        // wrapper.
        registerPlugin(KumikoAlarmsPlugin.class);
        super.onCreate(savedInstanceState);

        // v2.14.27: handle silent alarm wakes that the receiver dispatches
        // via startActivity(NEW_TASK | NO_HISTORY). The legacy v2.14.24-26
        // heads-up tap path (EXTRA_OPEN_CALL / EXTRA_ACCEPT_CALL /
        // EXTRA_DECLINE_CALL) is gone in v2.14.27 because the receiver no
        // longer posts CallStyle notifications — JS posts via
        // LocalNotifications instead, which routes taps back through its
        // own actionPerformed listener (services/capacitorNotifications.ts).
        handleAlarmFiredIntent(getIntent());

        // F1.3 hotfix: Android 15 starts enforcing edge-to-edge by default
        // for apps targetSdk 35+. Calling setDecorFitsSystemWindows(false)
        // tells Android to extend the WebView under the status + nav bars;
        // we then null out the bar backgrounds so the WebView's CSS
        // gradient is what the user sees edge-to-edge, and the existing
        // index.html `viewport-fit=cover` + `--sat / --sab` safe-area
        // variables already pad components away from the system bars
        // where they need to.
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Avoid the Android 8+ default "scrim" that re-introduces a
            // grey/white tint behind a transparent navigation bar on some
            // OEM skins.
            window.setNavigationBarContrastEnforced(false);
        }
        // Light icons (white) on the status / nav bars so they stay
        // legible over the dark IntroScreen / chat backgrounds.
        View decor = window.getDecorView();
        decor.setSystemUiVisibility(decor.getSystemUiVisibility()
            & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
            & ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Required so getIntent() in subsequent code paths sees the latest
        // intent — by default it keeps returning the original launch
        // intent.
        setIntent(intent);
        handleAlarmFiredIntent(intent);
    }

    /**
     * v2.14.27: silent alarm wakeup. KumikoAlarmReceiver fired an alarm and
     * launched us with EXTRA_REMINDER_FIRED to give the WebView a chance to
     * run JS LLM generation in the foreground process scope. We bridge the
     * payload to a `kumikoAlarmFired` JS event via the plugin so JS code
     * in useScheduledReminders can react immediately. The plugin also
     * persists the payload so a cold-launched WebView (plugin not yet
     * alive) can drain it on resume.
     */
    private void handleAlarmFiredIntent(Intent intent) {
        if (intent == null) return;
        if (!intent.getBooleanExtra(KumikoAlarmReceiver.EXTRA_REMINDER_FIRED, false)) return;

        String reminderId = intent.getStringExtra(KumikoAlarmReceiver.EXTRA_REMINDER_ID);
        String reminderEvent = intent.getStringExtra(KumikoAlarmReceiver.EXTRA_REMINDER_EVENT);
        String reminderText = intent.getStringExtra(KumikoAlarmReceiver.EXTRA_REMINDER_TEXT);
        boolean wantsCall = intent.getBooleanExtra(KumikoAlarmReceiver.EXTRA_WANTS_CALL, false);
        String ringtoneFileId = intent.getStringExtra(KumikoAlarmReceiver.EXTRA_RINGTONE_FILE_ID);

        if (reminderId == null) reminderId = "alarm-" + System.currentTimeMillis();
        if (reminderEvent == null) reminderEvent = "";
        if (reminderText == null) reminderText = reminderEvent;
        if (ringtoneFileId == null) ringtoneFileId = "";

        try {
            KumikoAlarmsPlugin.notifyAlarmFired(
                this, reminderId, reminderEvent, reminderText, wantsCall, ringtoneFileId
            );
        } catch (Throwable t) {
            Log.w(TAG, "notifyAlarmFired failed", t);
        }

        // Clear the consumed flag so subsequent setIntent / getIntent calls
        // don't re-trigger the wake (e.g. configuration change).
        intent.removeExtra(KumikoAlarmReceiver.EXTRA_REMINDER_FIRED);
    }
}
