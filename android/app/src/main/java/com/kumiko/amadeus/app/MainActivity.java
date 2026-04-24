package com.kumiko.amadeus.app;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;

import androidx.core.view.WindowCompat;

import com.getcapacitor.BridgeActivity;
import com.kumiko.amadeus.app.alarms.KumikoAlarmsPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register our custom plugins BEFORE super.onCreate so the bridge
        // picks them up at JS bridge initialization. KumikoAlarmsPlugin
        // exposes scheduleExact / cancel / canScheduleExact /
        // requestExactAlarmPermission / drainPendingActions to the
        // services/androidAlarmService.ts JS wrapper.
        registerPlugin(KumikoAlarmsPlugin.class);
        super.onCreate(savedInstanceState);

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
}
