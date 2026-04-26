package com.kumiko.amadeus.app;

import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.Window;

import androidx.core.view.WindowCompat;

import com.getcapacitor.BridgeActivity;
import com.kumiko.amadeus.app.alarms.KumikoAlarmsPlugin;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "MainActivity";

    /** v2.14.24: pending-action SharedPreferences shape understood by
     *  KumikoAlarmsPlugin.drainPendingActions and the JS drainer. */
    private static final String PENDING_ACTIONS_PREFS = "kumiko_pending_actions";
    private static final String KEY_LAST_ACTION = "last_action";
    private static final String KEY_LAST_REMINDER_ID = "last_reminder_id";
    private static final String KEY_LAST_REMINDER_EVENT = "last_reminder_event";
    private static final String KEY_LAST_ACTION_AT = "last_action_at";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register our custom plugins BEFORE super.onCreate so the bridge
        // picks them up at JS bridge initialization. KumikoAlarmsPlugin
        // exposes scheduleExact / cancel / canScheduleExact /
        // requestExactAlarmPermission / drainPendingActions to the
        // services/androidAlarmService.ts JS wrapper.
        registerPlugin(KumikoAlarmsPlugin.class);
        super.onCreate(savedInstanceState);

        // v2.14.24: handle the launching intent in case MainActivity was
        // cold-started by a heads-up tap (EXTRA_OPEN_CALL / EXTRA_ACCEPT_CALL /
        // EXTRA_DECLINE_CALL). For warm-starts the same logic runs in
        // onNewIntent() because launchMode=singleTask reuses the existing
        // activity instance.
        handleIncomingCallIntent(getIntent());

        // F1.3 hotfix: Android 15 starts enforcing edge-to-edge by default for
        // apps targetSdk 35+, but our themes (Theme.SplashScreen) still ship
        // the legacy default — content stops above the gesture nav bar and
        // Android paints a system-default white strip in the unused area
        // (the "下方有白条" symptom from v2.13.0 user reports). Calling
        // setDecorFitsSystemWindows(false) tells Android to extend the
        // WebView under the status + nav bars; we then null out the bar
        // backgrounds so the WebView's CSS gradient is what the user sees
        // edge-to-edge, and the existing index.html `viewport-fit=cover`
        // + `--sat / --sab` safe-area variables already pad components
        // away from the system bars where they need to.
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Avoid the Android 8+ default "scrim" that re-introduces a
            // grey/white tint behind a transparent navigation bar on some
            // OEM skins (Pixel 6+ Android 12+ adds it back; setting
            // navigationBarContrastEnforced = false suppresses it).
            window.setNavigationBarContrastEnforced(false);
        }
        // Light icons (white) on the status / nav bars so they stay
        // legible over the dark IntroScreen / chat backgrounds. The
        // WebView's per-screen styling can still flip these via the
        // @capacitor/status-bar plugin if we ever ship a light theme.
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
        handleIncomingCallIntent(intent);
    }

    /**
     * v2.14.24: inspect a freshly-arrived Intent for our reminder-call
     * extras. If any is set we (a) write the action into kumiko_pending_actions
     * for the JS drainer to pick up, and (b) cancel the heads-up
     * notification + stop the ringer service. The JS drainer then bridges
     * the action into voiceSlice.pendingCallAction so VoiceCallOverlay
     * shows the correct state (ringing for "open", connected for "accept",
     * toast for "decline").
     */
    private void handleIncomingCallIntent(Intent intent) {
        if (intent == null) return;
        String reminderId;
        String action;
        if ((reminderId = intent.getStringExtra(KumikoAlarmsPlugin.EXTRA_OPEN_CALL)) != null) {
            action = "open_call";
        } else if ((reminderId = intent.getStringExtra(KumikoAlarmsPlugin.EXTRA_ACCEPT_CALL)) != null) {
            action = "accept_call";
        } else if ((reminderId = intent.getStringExtra(KumikoAlarmsPlugin.EXTRA_DECLINE_CALL)) != null) {
            action = "decline_call";
        } else {
            return;
        }

        String reminderEvent = intent.getStringExtra(KumikoAlarmsPlugin.EXTRA_REMINDER_EVENT);
        if (reminderEvent == null) reminderEvent = "";

        try {
            SharedPreferences prefs = getSharedPreferences(PENDING_ACTIONS_PREFS, MODE_PRIVATE);
            prefs.edit()
                .putString(KEY_LAST_ACTION, action)
                .putString(KEY_LAST_REMINDER_ID, reminderId)
                .putString(KEY_LAST_REMINDER_EVENT, reminderEvent)
                .putLong(KEY_LAST_ACTION_AT, System.currentTimeMillis())
                .apply();
        } catch (Throwable t) {
            Log.w(TAG, "Failed to write pending action prefs", t);
        }

        try {
            KumikoAlarmsPlugin.cancelIncomingCallHeadsUp(this, reminderId);
        } catch (Throwable t) {
            Log.w(TAG, "Failed to cancel heads-up after intent dispatch", t);
        }

        // Clear the consumed extras from the intent so subsequent
        // setIntent / getIntent calls don't re-trigger this branch (e.g.
        // configuration change after a call accept).
        intent.removeExtra(KumikoAlarmsPlugin.EXTRA_OPEN_CALL);
        intent.removeExtra(KumikoAlarmsPlugin.EXTRA_ACCEPT_CALL);
        intent.removeExtra(KumikoAlarmsPlugin.EXTRA_DECLINE_CALL);
    }
}
