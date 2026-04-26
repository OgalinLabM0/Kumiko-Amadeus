// android/app/src/main/java/com/kumiko/amadeus/app/alarms/KumikoVendorPermissionHelper.java
//
// v2.14.21 OEM 权限体检 helper.
//
// Centralizes the vendor-specific deep-links that we use to take the user
// straight to the OEM permission screen they actually need to flip
// (Xiaomi 自启动 / 锁屏弹窗, Huawei 受保护应用, Samsung Device Care 永不休眠,
// OPPO/vivo 自启动 + 后台高耗电, etc.). All entries are best-effort:
//
//   - Each candidate Intent is probed with PackageManager.resolveActivity()
//     before launch so we don't crash on ROMs that don't ship that activity.
//   - If every vendor candidate fails for the requested key we fall back to
//     the AOSP "App details" page so the user always lands somewhere useful.
//   - Vendor classify uses Build.MANUFACTURER + Build.BRAND so we cover
//     Xiaomi/Redmi/POCO under one umbrella, OPPO/realme/OnePlus/etc.
//
// Reflection layer (Xiaomi Show on lock screen):
//   - Reads AppOpsManager.OP_SHOW_WHEN_LOCKED via checkOpNoThrow on MIUI
//     devices to surface granted/denied. On non-MIUI devices or when the
//     reflective call throws SecurityException / NoSuchMethod, returns
//     "unknown" rather than "denied" so the UI doesn't lie.
//
// All public methods MUST tolerate any Throwable internally and degrade to
// a sensible "did nothing / unknown" return — they are called from a JS
// promise path that has its own withTimeout, but defense in depth keeps
// the system stable on weird ROMs.

package com.kumiko.amadeus.app.alarms;

import android.app.AppOpsManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Process;
import android.provider.Settings;
import android.util.Log;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

public final class KumikoVendorPermissionHelper {

    private static final String TAG = "KumikoVendorHelper";

    public enum ShowOnLockState { GRANTED, DENIED, UNKNOWN }

    private KumikoVendorPermissionHelper() {}

    /** Lower-cased manufacturer for vendor classification. */
    public static String manufacturer() {
        return safe(Build.MANUFACTURER);
    }

    public static String brand() {
        return safe(Build.BRAND);
    }

    public static String model() {
        return safe(Build.MODEL);
    }

    public static String androidVersion() {
        return safe(Build.VERSION.RELEASE);
    }

    /**
     * Best-effort detection of MIUI/HyperOS "Show on lock screen" toggle.
     * Uses AppOpsManager.checkOpNoThrow with the OP code 10020 which is
     * Xiaomi's internal OP_SHOW_WHEN_LOCKED. On non-MIUI / restricted
     * builds the reflective call throws and we return UNKNOWN.
     */
    public static ShowOnLockState detectMiuiShowOnLock(Context context) {
        if (!isXiaomi()) return ShowOnLockState.UNKNOWN;
        try {
            AppOpsManager ops = (AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
            if (ops == null) return ShowOnLockState.UNKNOWN;
            // checkOpNoThrow(int op, int uid, String packageName) is hidden API on
            // some platforms but reflectively reachable. We use the int overload
            // because OP_SHOW_WHEN_LOCKED has no public string constant.
            Method checkOp = AppOpsManager.class.getMethod(
                "checkOpNoThrow", int.class, int.class, String.class);
            int uid = Process.myUid();
            String pkg = context.getPackageName();
            int result = (int) checkOp.invoke(ops, /* op = */ 10020, uid, pkg);
            // MODE_ALLOWED == 0; MODE_IGNORED == 1; MODE_ERRORED == 2;
            // MODE_DEFAULT == 3 (treated as unknown — MIUI usually returns
            // explicit ALLOWED / IGNORED for OP_SHOW_WHEN_LOCKED, DEFAULT
            // means "user hasn't been asked yet" which we surface as unknown).
            switch (result) {
                case AppOpsManager.MODE_ALLOWED: return ShowOnLockState.GRANTED;
                case AppOpsManager.MODE_IGNORED:
                case AppOpsManager.MODE_ERRORED: return ShowOnLockState.DENIED;
                default: return ShowOnLockState.UNKNOWN;
            }
        } catch (SecurityException se) {
            // MIUI sometimes refuses checkOpNoThrow for non-system callers.
            return ShowOnLockState.UNKNOWN;
        } catch (Throwable t) {
            // Reflection / NoSuchMethod / etc on non-MIUI ROMs.
            return ShowOnLockState.UNKNOWN;
        }
    }

    public static boolean isXiaomi() {
        String m = manufacturer().toLowerCase();
        String b = brand().toLowerCase();
        return m.contains("xiaomi") || b.contains("xiaomi") || b.contains("redmi") || b.contains("poco");
    }

    /**
     * Open the closest matching settings page for the requested vendor key.
     * Returns whether anything launched and whether we used the AOSP App
     * details fallback so the UI can tell the user what happened.
     */
    public static OpenResult openVendorSetting(Context context, String key) {
        List<Intent> candidates = candidatesFor(key);
        for (Intent intent : candidates) {
            if (tryStart(context, intent)) {
                return new OpenResult(true, false);
            }
        }
        // Generic fallback: AOSP App details settings page.
        Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        fallback.setData(Uri.parse("package:" + context.getPackageName()));
        fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (tryStart(context, fallback)) {
            return new OpenResult(true, true);
        }
        return new OpenResult(false, false);
    }

    private static List<Intent> candidatesFor(String key) {
        List<Intent> out = new ArrayList<>();
        if (key == null) return out;
        switch (key) {
            case "xiaomi.autostart": {
                // MIUI autostart manager (multiple package paths across versions).
                out.add(componentIntent(
                    "com.miui.securitycenter",
                    "com.miui.permcenter.autostart.AutoStartManagementActivity"));
                out.add(componentIntent(
                    "com.miui.securitycenter",
                    "com.miui.appmanager.ApplicationsDetailsActivity"));
                break;
            }
            case "xiaomi.permEditor": {
                // MIUI per-app permission editor (where Show-on-lock and
                // Background-popup live for MIUI).
                Intent permEditor = new Intent("miui.intent.action.APP_PERM_EDITOR");
                permEditor.setClassName(
                    "com.miui.securitycenter",
                    "com.miui.permcenter.permissions.PermissionsEditorActivity");
                permEditor.putExtra("extra_pkgname", "{pkg}");
                out.add(permEditor);
                Intent altEditor = new Intent("miui.intent.action.APP_PERM_EDITOR");
                altEditor.setClassName(
                    "com.miui.securitycenter",
                    "com.miui.permcenter.permissions.AppPermissionsEditorActivity");
                altEditor.putExtra("extra_pkgname", "{pkg}");
                out.add(altEditor);
                break;
            }
            case "huawei.protectedApps": {
                out.add(componentIntent(
                    "com.huawei.systemmanager",
                    "com.huawei.systemmanager.optimize.process.ProtectActivity"));
                out.add(componentIntent(
                    "com.huawei.systemmanager",
                    "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"));
                break;
            }
            case "huawei.batteryOptimizations": {
                out.add(componentIntent(
                    "com.huawei.systemmanager",
                    "com.huawei.systemmanager.power.ui.HwPowerManagerActivity"));
                out.add(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                break;
            }
            case "honor.protectedApps": {
                out.add(componentIntent(
                    "com.hihonor.systemmanager",
                    "com.huawei.systemmanager.optimize.process.ProtectActivity"));
                out.add(componentIntent(
                    "com.hihonor.systemmanager",
                    "com.hihonor.systemmanager.optimize.process.ProtectActivity"));
                break;
            }
            case "samsung.deviceCare": {
                // Samsung Device Care -> Battery -> Background usage limits ->
                // Never sleeping apps. We can deep-link to the Battery activity;
                // user finishes the navigation manually.
                out.add(componentIntent(
                    "com.samsung.android.lool",
                    "com.samsung.android.sm.ui.battery.BatteryActivity"));
                out.add(componentIntent(
                    "com.samsung.android.sm",
                    "com.samsung.android.sm.battery.ui.BatteryActivity"));
                break;
            }
            case "samsung.batteryUsage": {
                Intent batteryUsage = new Intent("com.samsung.android.sm.ACTION_OPEN_CHECKABLE_LISTACTIVITY");
                batteryUsage.putExtra("activity_type", 2);
                out.add(batteryUsage);
                out.add(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                break;
            }
            case "oppo.startup": {
                out.add(componentIntent(
                    "com.coloros.safecenter",
                    "com.coloros.safecenter.permission.startup.StartupAppListActivity"));
                out.add(componentIntent(
                    "com.coloros.safecenter",
                    "com.coloros.privacypermissionsentry.PermissionTopActivity"));
                out.add(componentIntent(
                    "com.coloros.oppoguardelf",
                    "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity"));
                out.add(componentIntent(
                    "com.oppo.safe",
                    "com.oppo.safe.permission.startup.StartupAppListActivity"));
                break;
            }
            case "oppo.batteryOptimizations": {
                out.add(componentIntent(
                    "com.coloros.oppoguardelf",
                    "com.coloros.powermanager.fuelgaue.PowerSaverModeActivity"));
                out.add(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                break;
            }
            case "realme.startup": {
                out.add(componentIntent(
                    "com.realme.securitycheck",
                    "com.realme.securitycheck.permission.startup.StartupAppListActivity"));
                out.add(componentIntent(
                    "com.coloros.safecenter",
                    "com.coloros.safecenter.permission.startup.StartupAppListActivity"));
                break;
            }
            case "vivo.backgroundStartup": {
                out.add(componentIntent(
                    "com.iqoo.secure",
                    "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"));
                out.add(componentIntent(
                    "com.vivo.permissionmanager",
                    "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"));
                break;
            }
            case "vivo.batteryOptimizations": {
                out.add(componentIntent(
                    "com.iqoo.secure",
                    "com.iqoo.secure.ui.powersaving.PowerSavingManagerActivity"));
                out.add(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                break;
            }
            case "oneplus.startup": {
                out.add(componentIntent(
                    "com.oneplus.security",
                    "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"));
                out.add(componentIntent(
                    "com.coloros.safecenter",
                    "com.coloros.safecenter.permission.startup.StartupAppListActivity"));
                break;
            }
            case "generic.ignoreBatteryOptimizations": {
                out.add(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                break;
            }
            case "generic.appDetails":
            default:
                // Falls through to the global fallback in openVendorSetting.
                break;
        }
        return out;
    }

    private static Intent componentIntent(String pkg, String cls) {
        Intent intent = new Intent();
        intent.setComponent(new ComponentName(pkg, cls));
        return intent;
    }

    private static boolean tryStart(Context context, Intent intent) {
        try {
            // Resolve {pkg} placeholder for MIUI-style permission editor extras.
            String pkgName = context.getPackageName();
            if (intent.hasExtra("extra_pkgname")) {
                String value = intent.getStringExtra("extra_pkgname");
                if (value != null && value.equals("{pkg}")) {
                    intent.putExtra("extra_pkgname", pkgName);
                }
            }
            // Generic per-package data (battery optimization details page).
            if (intent.getAction() != null
                && intent.getAction().equals(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                && intent.getData() == null) {
                // No data scheme needed for the system-wide list page.
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            PackageManager pm = context.getPackageManager();
            if (intent.resolveActivity(pm) == null) {
                return false;
            }
            context.startActivity(intent);
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "tryStart failed for " + intent, t);
            return false;
        }
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }

    public static final class OpenResult {
        public final boolean opened;
        public final boolean usedFallback;

        public OpenResult(boolean opened, boolean usedFallback) {
            this.opened = opened;
            this.usedFallback = usedFallback;
        }
    }
}
