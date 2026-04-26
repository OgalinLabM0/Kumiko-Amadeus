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
  | 'huawei.protectedApps'
  | 'huawei.batteryOptimizations'
  | 'samsung.batteryUsage'
  | 'samsung.deviceCare'
  | 'oppo.startup'
  | 'oppo.batteryOptimizations'
  | 'vivo.backgroundStartup'
  | 'vivo.batteryOptimizations'
  | 'oneplus.startup'
  | 'realme.startup'
  | 'honor.protectedApps'
  | 'generic.appDetails'
  | 'generic.ignoreBatteryOptimizations';

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
