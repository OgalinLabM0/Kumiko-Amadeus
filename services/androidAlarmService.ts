// services/androidAlarmService.ts
//
// B.2 (A6.4): JS wrapper around the native KumikoAlarmsPlugin
// (android/app/src/main/java/com/kumiko/amadeus/app/alarms/KumikoAlarmsPlugin.java).
// Lets useScheduledReminders schedule one OS-level alarm per reminder
// instead of polling every second from a JS interval. The alarm fires
// even when the WebView is killed by Doze.
//
// PWA / Electron / Capacitor non-Android never call into here — guard
// with isCapacitorNative() at the call site (we double-check inside
// each function as belt-and-suspenders).

import { getCapacitorPlatform, isCapacitorNative } from './environment';

// v2.14.17: localStorage flags for the exact-alarm permission flow:
//   - PROMPTED: set on first launch after we have asked the user once via
//     requestExactAlarmPermission. Prevents re-prompting on every cold start
//     after the user dismisses the system settings page.
//   - FALLBACK_NOTICE: set on first time we observe an alarm scheduled with
//     `exact === false` (Android downgraded to inexact). Prevents toasting
//     the user every time a reminder gets re-scheduled inexactly.
export const EXACT_ALARM_PERMISSION_PROMPTED_STORAGE_KEY = 'kumiko_exact_alarm_permission_prompted';
export const EXACT_ALARM_FALLBACK_NOTICE_STORAGE_KEY = 'kumiko_exact_alarm_fallback_notice_shown';
export const FULL_SCREEN_INTENT_PERMISSION_PROMPTED_STORAGE_KEY = 'kumiko_full_screen_intent_permission_prompted';

export interface ScheduleAlarmInput {
  reminderId: string;
  /** Epoch ms when the alarm should fire. */
  at: number;
  /** Short event description (e.g. "喝水"). */
  event: string;
  /** Display text for the notification body if non-call route. */
  text?: string;
  /** True → KumikoAlarmReceiver launches IncomingCallActivity (full-screen
   *  call UI). False → posts a kumiko_messages text notification. The
   *  caller (useScheduledReminders) makes this decision based on
   *  ttsConfig.voiceMode + whether TTS keys are present, exactly the
   *  same check the desktop / PWA path uses. */
  wantsCall?: boolean;
  /** Selected ringtone id (built-in 01.mp3..08.mp3 or custom.ext). Passed to
   *  native so IncomingCallActivity can ring with the user's configured sound. */
  ringtoneFileId?: string;
}

export interface ScheduleAlarmResult {
  scheduled: boolean;
  exact: boolean;
  at?: number;
  reminderId?: string;
  error?: string;
}

export interface NativeAndroidAlertPermissionStatus {
  sdkInt: number;
  notificationsEnabled: boolean;
  messagesChannelReady: boolean;
  callsChannelReady: boolean;
  exactAlarmReady: boolean;
  fullScreenIntentReady: boolean;
  /** v2.14.23: REQUEST_IGNORE_BATTERY_OPTIMIZATIONS state. true → app on the
   *  user's "no battery optimization" list; reduces Doze interference. */
  batteryOptimizationsIgnored: boolean;
  /** v2.14.23: True iff the self-managed Telecom PhoneAccount has been
   *  registered via TelecomManager.registerPhoneAccount AND the user has
   *  enabled it in Settings → Apps → Default apps → Calling accounts.
   *  When false, KumikoAlarmReceiver.wantsCall=true falls back to the
   *  legacy CATEGORY_CALL + IncomingCallActivity direct-launch path. */
  phoneAccountReady: boolean;
}

export interface NativeOemDeviceInfo {
  manufacturer: string;
  brand: string;
  model: string;
  androidVersion: string;
  /** Best-effort reflective read of Xiaomi's OP_SHOW_WHEN_LOCKED. */
  showOnLockState: 'granted' | 'denied' | 'unknown';
}

/** Vendor-specific deep-link keys recognized by the native plugin. */
export type VendorPermissionKey =
  | 'xiaomi.autostart'
  | 'xiaomi.permEditor'
  | 'xiaomi.batteryOptimizations'
  | 'huawei.protectedApps'
  | 'huawei.batteryOptimizations'
  | 'huawei.startup'
  | 'samsung.batteryUsage'
  | 'samsung.deviceCare'
  | 'samsung.sleepingApps'
  | 'oppo.startup'
  | 'oppo.batteryOptimizations'
  | 'vivo.backgroundStartup'
  | 'vivo.batteryOptimizations'
  | 'oneplus.startup'
  | 'realme.startup'
  | 'honor.protectedApps'
  | 'generic.appDetails'
  | 'generic.ignoreBatteryOptimizations';

/** v2.14.23: structured self-test report. KumikoAlarms records four wall-clock
 *  timestamps as the alarm flows from AlarmManager → BroadcastReceiver →
 *  Notification → IncomingCallActivity → user accept-tap. JS calls
 *  `startSelfTestProbe()` before scheduling the placeholder reminder, the
 *  user puts the app to background or locks the screen, then on resume JS
 *  calls `collectSelfTestReport()` to retrieve which stages were reached. */
export interface AlarmSelfTestReport {
  /** Was a probe armed? false → JS forgot to call startSelfTestProbe first. */
  armed: boolean;
  /** Epoch ms at AlarmManager-fire (KumikoAlarmReceiver.onReceive). 0 if not yet. */
  alarmFiredAt: number;
  /** Epoch ms once the FSI Notification has been posted via NotificationManager. */
  notifPostedAt: number;
  /** Epoch ms IncomingCallActivity (or its Telecom-backed equivalent) onCreate. */
  fsiLaunchedAt: number;
  /** Epoch ms once the user taps Accept and the action is committed to ledger. */
  acceptReceivedAt: number;
}

interface KumikoAlarmsPluginShape {
  scheduleExact(opts: ScheduleAlarmInput): Promise<ScheduleAlarmResult>;
  cancel(opts: { reminderId: string }): Promise<{ cancelled: boolean }>;
  canScheduleExact(): Promise<{ canScheduleExact: boolean }>;
  requestExactAlarmPermission(): Promise<void>;
  canUseFullScreenIntent(): Promise<{ canUseFullScreenIntent: boolean }>;
  requestFullScreenIntentPermission(): Promise<void>;
  getAlertPermissionStatus(): Promise<NativeAndroidAlertPermissionStatus>;
  openAppNotificationSettings(): Promise<void>;
  ensureNotificationChannels(): Promise<{ ready: boolean }>;
  getOemDeviceInfo(): Promise<NativeOemDeviceInfo>;
  openVendorSetting(opts: { key: VendorPermissionKey }): Promise<{ opened: boolean; usedFallback: boolean }>;
  postTestMessageNotification(opts: { title: string; body: string }): Promise<{ posted: boolean }>;
  postTestIncomingCall(opts: { title: string; body: string; ringtoneFileId?: string }): Promise<{ posted: boolean }>;
  cancelTestNotifications(): Promise<void>;
  drainPendingActions(): Promise<{
    callAction?: { action: string; reminderId?: string; reminderEvent?: string; at?: number };
    repliesJson: string;
  }>;
  /** v2.14.23: cheap no-op call used by JS as a synchronous "warm the bridge"
   *  signal. The first JS→native call after WebView startup typically takes
   *  2-5s while Capacitor lazy-loads the plugin descriptor; calling this
   *  early (and waiting up to 8s) prevents the production permission probe
   *  from being the cold-start bridge victim. */
  prewarm(): Promise<{ ok: true }>;
  /** v2.14.23: REQUEST_IGNORE_BATTERY_OPTIMIZATIONS dialog. The system will
   *  show an in-place "allow Kumiko to keep running in background" prompt
   *  (no settings deep-link). */
  requestIgnoreBatteryOptimization(): Promise<{ requested: boolean }>;
  /** v2.14.23: returns whether the app is currently on the OS-level
   *  "battery optimizations exempt" allowlist. */
  isIgnoringBatteryOptimizations(): Promise<{ ignored: boolean }>;
  /** v2.14.23: inspect / register / un-register the self-managed Telecom
   *  PhoneAccount used to route reminder calls through Android's Telecom
   *  framework instead of a generic FSI notification. */
  isPhoneAccountRegistered(): Promise<{ registered: boolean; enabled: boolean }>;
  registerPhoneAccount(): Promise<{ registered: boolean }>;
  unregisterPhoneAccount(): Promise<void>;
  openPhoneAccountSettings(): Promise<void>;
  /** v2.14.23: end-to-end deep self-test. JS calls startSelfTestProbe before
   *  scheduling a placeholder reminder, the user backgrounds/locks the
   *  device, then on resume JS calls collectSelfTestReport which returns
   *  the four wall-clock timestamps showing which stage of the alarm flow
   *  arrived. */
  startSelfTestProbe(opts: { reminderId: string }): Promise<{ armed: boolean }>;
  collectSelfTestReport(): Promise<AlarmSelfTestReport>;
  /** v2.14.23: prune the native ledger of any reminderId whose at < now - 60s.
   *  Called from JS at app startup; the BootReceiver also prunes inline. */
  pruneExpiredLedger(): Promise<{ pruned: number; remaining: number }>;
  /** v2.14.23: explicit start/stop of the long-running KumikoAlarmGuardianService
   *  (FOREGROUND_SERVICE_SPECIAL_USE / subtype=alarm). JS controls the
   *  lifetime so the guardian only runs while at least one reminder is
   *  pending. */
  startAlarmGuardian(opts?: { reason?: string }): Promise<{ started: boolean }>;
  stopAlarmGuardian(): Promise<{ stopped: boolean }>;
}

// v2.14.3 N.7: caches both the resolved plugin handle and the in-flight
// import Promise. Previously every consumer (scheduleAndroidAlarm,
// cancelAndroidAlarm, canScheduleExactAlarms, drainPendingActions, …)
// re-ran `registerPlugin('KumikoAlarms')` on each call. Capacitor's
// runtime tolerates duplicate registrations but logs
// `[WARN] Capacitor plugin "KumikoAlarms" already registered` for every
// repeat — easily 10+ lines per minute under normal use, drowning out
// the actually-useful logcat entries. With the cached handle the warn
// fires at most once (the very first call after the native side
// pre-registered it from MainActivity).
let cachedPlugin: KumikoAlarmsPluginShape | null = null;
let pluginPromise: Promise<KumikoAlarmsPluginShape | null> | null = null;
async function getPlugin(): Promise<KumikoAlarmsPluginShape | null> {
  if (!isCapacitorNative()) return null;
  // v2.14.17: belt-and-suspenders platform check. KumikoAlarmsPlugin is an
  // Android-only native module — registerPlugin would throw on iOS Capacitor
  // because the iOS layer never registered it. Bail early so future iOS work
  // doesn't crash here on first reminder schedule.
  if (getCapacitorPlatform() !== 'android') return null;
  if (cachedPlugin) return cachedPlugin;
  if (pluginPromise) return pluginPromise;
  pluginPromise = (async () => {
    try {
      // Lazy-import @capacitor/core only when we actually need to dispatch
      // (so PC / PWA bundles don't pay the import cost).
      const { registerPlugin } = await import('@capacitor/core');
      const plugin = registerPlugin<KumikoAlarmsPluginShape>('KumikoAlarms');
      cachedPlugin = plugin;
      return plugin;
    } catch (e) {
      console.warn('[androidAlarms] plugin import failed:', e);
      // Reset the promise so a future caller can retry — useful in dev
      // when @capacitor/core is mid-HMR.
      pluginPromise = null;
      return null;
    }
  })();
  return pluginPromise;
}

export async function scheduleAndroidAlarm(input: ScheduleAlarmInput): Promise<ScheduleAlarmResult> {
  const plugin = await getPlugin();
  if (!plugin) return { scheduled: false, exact: false, error: 'not_capacitor_android' };
  try {
    return await plugin.scheduleExact(input);
  } catch (e) {
    return { scheduled: false, exact: false, error: e instanceof Error ? e.message : 'plugin_error' };
  }
}

export async function cancelAndroidAlarm(reminderId: string): Promise<boolean> {
  const plugin = await getPlugin();
  if (!plugin) return false;
  try {
    const res = await plugin.cancel({ reminderId });
    return res.cancelled;
  } catch (e) {
    console.warn('[androidAlarms] cancel failed:', e);
    return false;
  }
}

export async function canScheduleExactAlarms(): Promise<boolean> {
  const plugin = await getPlugin();
  if (!plugin) return false;
  try {
    const res = await plugin.canScheduleExact();
    return res.canScheduleExact === true;
  } catch {
    return false;
  }
}

export async function requestExactAlarmPermission(): Promise<void> {
  const plugin = await getPlugin();
  if (!plugin) return;
  try {
    await plugin.requestExactAlarmPermission();
  } catch (e) {
    console.warn('[androidAlarms] requestExactAlarmPermission failed:', e);
  }
}

export async function canUseFullScreenIntent(): Promise<boolean> {
  const plugin = await getPlugin();
  if (!plugin) return false;
  try {
    const res = await plugin.canUseFullScreenIntent();
    return res.canUseFullScreenIntent === true;
  } catch {
    return false;
  }
}

export async function requestFullScreenIntentPermission(): Promise<void> {
  const plugin = await getPlugin();
  if (!plugin) return;
  try {
    await plugin.requestFullScreenIntentPermission();
  } catch (e) {
    console.warn('[androidAlarms] requestFullScreenIntentPermission failed:', e);
  }
}

export async function getNativeAndroidAlertPermissionStatus(): Promise<NativeAndroidAlertPermissionStatus | null> {
  const plugin = await getPlugin();
  if (!plugin) return null;
  try {
    return await plugin.getAlertPermissionStatus();
  } catch (e) {
    console.warn('[androidAlarms] getAlertPermissionStatus failed:', e);
    return null;
  }
}

export async function openAndroidAppNotificationSettings(): Promise<void> {
  const plugin = await getPlugin();
  if (!plugin) return;
  try {
    await plugin.openAppNotificationSettings();
  } catch (e) {
    console.warn('[androidAlarms] openAppNotificationSettings failed:', e);
  }
}

/**
 * One-shot bootstrap to create the kumiko_messages / kumiko_calls native
 * channels. Kept separate from the read-only snapshot path so a stalled
 * channel-creation call can never block the permission detection UI.
 */
export async function ensureKumikoNotificationChannelsNative(): Promise<boolean> {
  const plugin = await getPlugin();
  if (!plugin) return false;
  try {
    const result = await plugin.ensureNotificationChannels();
    return result.ready === true;
  } catch (e) {
    console.warn('[androidAlarms] ensureNotificationChannels failed:', e);
    return false;
  }
}

export async function getOemDeviceInfo(): Promise<NativeOemDeviceInfo | null> {
  const plugin = await getPlugin();
  if (!plugin) return null;
  try {
    return await plugin.getOemDeviceInfo();
  } catch (e) {
    console.warn('[androidAlarms] getOemDeviceInfo failed:', e);
    return null;
  }
}

export async function openVendorPermissionSetting(key: VendorPermissionKey): Promise<{ opened: boolean; usedFallback: boolean }> {
  const plugin = await getPlugin();
  if (!plugin) return { opened: false, usedFallback: false };
  try {
    const result = await plugin.openVendorSetting({ key });
    return {
      opened: result.opened === true,
      usedFallback: result.usedFallback === true,
    };
  } catch (e) {
    console.warn('[androidAlarms] openVendorSetting failed:', e);
    return { opened: false, usedFallback: false };
  }
}

export async function postAndroidTestMessageNotification(opts: { title: string; body: string }): Promise<boolean> {
  const plugin = await getPlugin();
  if (!plugin) return false;
  try {
    const result = await plugin.postTestMessageNotification(opts);
    return result.posted === true;
  } catch (e) {
    console.warn('[androidAlarms] postTestMessageNotification failed:', e);
    return false;
  }
}

export async function postAndroidTestIncomingCall(opts: { title: string; body: string; ringtoneFileId?: string }): Promise<boolean> {
  const plugin = await getPlugin();
  if (!plugin) return false;
  try {
    const result = await plugin.postTestIncomingCall(opts);
    return result.posted === true;
  } catch (e) {
    console.warn('[androidAlarms] postTestIncomingCall failed:', e);
    return false;
  }
}

export async function cancelAndroidTestNotifications(): Promise<void> {
  const plugin = await getPlugin();
  if (!plugin) return;
  try {
    await plugin.cancelTestNotifications();
  } catch (e) {
    console.warn('[androidAlarms] cancelTestNotifications failed:', e);
  }
}

export interface DrainedAction {
  type: 'call';
  action: 'accept_call' | 'reject_call';
  reminderId?: string;
  reminderEvent?: string;
  atMs?: number;
}

export interface DrainedReply {
  type: 'reply';
  text: string;
  atMs: number;
}

/**
 * Drain pending actions queued natively while the WebView was offline:
 *   - call accept / reject taps from IncomingCallActivity
 *   - Direct Reply text submissions from RemoteReplyReceiver
 * Called from App.tsx on cold-start AND on App.appResume so anything
 * that landed during background state gets replayed through the
 * normal chat / VoiceCallOverlay pipelines.
 */
/**
 * v2.14.23: explicit Capacitor plugin warm-up. The first call to a Capacitor
 * plugin after a cold WebView start can take 2-5s (or longer on busy ROMs)
 * while the bridge lazily resolves the native descriptor. If that first
 * call happens to be `getAlertPermissionStatus()` from the permission UI,
 * the user sees four "Unknown" rows — exactly the v2.14.22 regression GPT-5.5
 * called out. We resolve this by issuing a no-op `prewarm()` early in the
 * bootstrap sequence with an 8-second budget; subsequent permission probes
 * benefit from the now-resolved bridge.
 *
 * Returns true iff the bridge produced a result inside the timeout. Returns
 * false on timeout / any failure; caller should still proceed (the regular
 * probe path tolerates a cold bridge, just slower).
 */
export async function prewarmKumikoAlarmsPlugin(timeoutMs = 8_000): Promise<boolean> {
  const plugin = await getPlugin();
  if (!plugin) return false;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[androidAlarms] prewarm timed out after ${timeoutMs}ms`);
      resolve(false);
    }, timeoutMs);
    plugin
      .prewarm()
      .then(
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        (e) => {
          clearTimeout(timer);
          // Older native binaries may not yet expose `prewarm`; fall back
          // to the cheapest read-only method we know exists so we still
          // pay the bridge-resolution cost up front.
          const methodMissing = e && typeof e === 'object' && (
            (e as { code?: string }).code === 'UNIMPLEMENTED'
            || /prewarm|not implemented|UNIMPLEMENTED/i.test(((e as Error)?.message) || '')
          );
          if (!methodMissing) {
            console.warn('[androidAlarms] prewarm failed:', e);
            resolve(false);
            return;
          }
          plugin
            .canScheduleExact()
            .then(() => resolve(true))
            .catch(() => resolve(false));
        },
      );
  });
}

export async function isIgnoringBatteryOptimizations(): Promise<boolean | null> {
  const plugin = await getPlugin();
  if (!plugin) return null;
  try {
    const result = await plugin.isIgnoringBatteryOptimizations();
    return result.ignored === true;
  } catch (e) {
    console.warn('[androidAlarms] isIgnoringBatteryOptimizations failed:', e);
    return null;
  }
}

export async function requestIgnoreBatteryOptimization(): Promise<boolean> {
  const plugin = await getPlugin();
  if (!plugin) return false;
  try {
    const result = await plugin.requestIgnoreBatteryOptimization();
    return result.requested === true;
  } catch (e) {
    console.warn('[androidAlarms] requestIgnoreBatteryOptimization failed:', e);
    return false;
  }
}

export async function isPhoneAccountRegistered(): Promise<{ registered: boolean; enabled: boolean } | null> {
  const plugin = await getPlugin();
  if (!plugin) return null;
  try {
    return await plugin.isPhoneAccountRegistered();
  } catch (e) {
    console.warn('[androidAlarms] isPhoneAccountRegistered failed:', e);
    return null;
  }
}

export async function registerPhoneAccount(): Promise<boolean> {
  const plugin = await getPlugin();
  if (!plugin) return false;
  try {
    const result = await plugin.registerPhoneAccount();
    return result.registered === true;
  } catch (e) {
    console.warn('[androidAlarms] registerPhoneAccount failed:', e);
    return false;
  }
}

export async function openPhoneAccountSettings(): Promise<void> {
  const plugin = await getPlugin();
  if (!plugin) return;
  try {
    await plugin.openPhoneAccountSettings();
  } catch (e) {
    console.warn('[androidAlarms] openPhoneAccountSettings failed:', e);
  }
}

export async function startKumikoSelfTestProbe(reminderId: string): Promise<boolean> {
  const plugin = await getPlugin();
  if (!plugin) return false;
  try {
    const result = await plugin.startSelfTestProbe({ reminderId });
    return result.armed === true;
  } catch (e) {
    console.warn('[androidAlarms] startSelfTestProbe failed:', e);
    return false;
  }
}

export async function collectKumikoSelfTestReport(): Promise<AlarmSelfTestReport | null> {
  const plugin = await getPlugin();
  if (!plugin) return null;
  try {
    return await plugin.collectSelfTestReport();
  } catch (e) {
    console.warn('[androidAlarms] collectSelfTestReport failed:', e);
    return null;
  }
}

export async function pruneExpiredAlarmLedger(): Promise<{ pruned: number; remaining: number } | null> {
  const plugin = await getPlugin();
  if (!plugin) return null;
  try {
    return await plugin.pruneExpiredLedger();
  } catch (e) {
    console.warn('[androidAlarms] pruneExpiredLedger failed:', e);
    return null;
  }
}

export async function startKumikoAlarmGuardian(reason?: string): Promise<boolean> {
  const plugin = await getPlugin();
  if (!plugin) return false;
  try {
    const result = await plugin.startAlarmGuardian({ reason });
    return result.started === true;
  } catch (e) {
    console.warn('[androidAlarms] startAlarmGuardian failed:', e);
    return false;
  }
}

export async function stopKumikoAlarmGuardian(): Promise<boolean> {
  const plugin = await getPlugin();
  if (!plugin) return false;
  try {
    const result = await plugin.stopAlarmGuardian();
    return result.stopped === true;
  } catch (e) {
    console.warn('[androidAlarms] stopAlarmGuardian failed:', e);
    return false;
  }
}

export async function drainPendingNativeActions(): Promise<{
  call?: DrainedAction;
  replies: DrainedReply[];
}> {
  const plugin = await getPlugin();
  if (!plugin) return { replies: [] };
  try {
    const raw = await plugin.drainPendingActions();
    const out: { call?: DrainedAction; replies: DrainedReply[] } = { replies: [] };
    if (raw.callAction && (raw.callAction.action === 'accept_call' || raw.callAction.action === 'reject_call')) {
      out.call = {
        type: 'call',
        action: raw.callAction.action,
        reminderId: raw.callAction.reminderId,
        reminderEvent: raw.callAction.reminderEvent,
        atMs: raw.callAction.at,
      };
    }
    try {
      const repliesArr = JSON.parse(raw.repliesJson || '[]') as Array<{ ts?: number; text?: string }>;
      for (const r of repliesArr) {
        if (typeof r?.text === 'string' && r.text.trim().length > 0) {
          out.replies.push({
            type: 'reply',
            text: r.text,
            atMs: typeof r.ts === 'number' ? r.ts : Date.now(),
          });
        }
      }
    } catch (e) {
      console.warn('[androidAlarms] failed to parse pending replies:', e);
    }
    return out;
  } catch (e) {
    console.warn('[androidAlarms] drainPendingActions failed:', e);
    return { replies: [] };
  }
}
