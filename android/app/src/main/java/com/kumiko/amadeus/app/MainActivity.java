package com.kumiko.amadeus.app;

import android.os.Bundle;

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
    }
}
