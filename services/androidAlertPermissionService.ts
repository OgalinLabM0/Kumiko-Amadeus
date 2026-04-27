// services/androidAlertPermissionService.ts
//
// v2.14.27: lightweight permission snapshot + LocalNotifications-only test
// runners. The previous v2.14.22-26 design probed five native plugin methods
// in parallel (with 5s budgets each), classified OEM vendors, and gated
// every test on a custom-plugin "post test notification" call that turned
// out to be the very thing HyperOS/MIUI was throttling. We rip all of that
// out.
//
// The new shape:
//   - 5 user-facing items (notifications / exactAlarm / fullScreenIntent /
//     batteryOptimization / lockScreenDisplay), each with a state pill and
//     a "open system settings" deep-link.
//   - notifications  → @capacitor/local-notifications.checkPermissions()
//   - exactAlarm     → KumikoAlarmsPlugin.canScheduleExact()
//   - fullScreenIntent → KumikoAlarmsPlugin.canUseFullScreenIntent()
//   - battery / lockscreen → no reliable read API; reported as 'unknown'
//     so the UI shows "open settings only" and trusts the user.
//   - test runners exclusively use LocalNotifications.schedule(), the
//     fallback path that proved reliable in v2.14.26.

import { getCapacitorPlatform, isCapacitorNative } from './environment';
import {
  canScheduleExactAlarms,
  canUseFullScreenIntent,
  openAndroidSettings,
  requestExactAlarmPermission,
  requestFullScreenIntentPermission,
  type AndroidSettingsKey,
} from './androidAlarmService';
import {
  CHANNEL_CALLS,
  CHANNEL_MESSAGES,
  checkKumikoNotificationPermission,
  postKumikoFallbackCallNotification,
  postKumikoFallbackMessageNotification,
  requestKumikoNotificationPermission,
} from './capacitorNotifications';
import { ensureNativeRingtoneForAlarm } from './voiceFileService';

export type PermissionState = 'granted' | 'denied' | 'unknown' | 'unavailable';
export type PermissionKey =
  | 'notifications'
  | 'exactAlarm'
  | 'fullScreenIntent'
  | 'batteryOptimization'
  | 'lockScreenDisplay';

export interface PermissionItem {
  key: PermissionKey;
  state: PermissionState;
  /** True when JS can re-probe and update the state pill. False for items
   *  whose status cannot be queried programmatically (battery/lockscreen). */
  canVerify: boolean;
  /** True when an "open system settings" deep-link is wired. */
  canOpenSettings: boolean;
}

export interface PermissionStatusSnapshot {
  supported: boolean;
  overall: PermissionState;
  items: Record<PermissionKey, PermissionItem>;
}

export interface PermissionTestResult {
  ok: boolean;
  reason?: 'unsupported' | 'no-permission' | 'schedule-failed' | 'timeout';
}

const TEST_TIMEOUT_MS = 4_000;

class TimeoutError extends Error {
  constructor(label: string) {
    super(`timeout:${label}`);
    this.name = 'TimeoutError';
  }
}

async function withTimeout<T>(label: string, promise: Promise<T>, ms = TEST_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const unavailableItem = (key: PermissionKey): PermissionItem => ({
  key,
  state: 'unavailable',
  canVerify: false,
  canOpenSettings: false,
});

const unsupportedSnapshot = (): PermissionStatusSnapshot => ({
  supported: false,
  overall: 'unavailable',
  items: {
    notifications: unavailableItem('notifications'),
    exactAlarm: unavailableItem('exactAlarm'),
    fullScreenIntent: unavailableItem('fullScreenIntent'),
    batteryOptimization: unavailableItem('batteryOptimization'),
    lockScreenDisplay: unavailableItem('lockScreenDisplay'),
  },
});

/**
 * v2.14.27: cheap, parallel, 4s-budgeted snapshot. Every probe degrades to
 * `unknown` on timeout/error rather than dragging the UI to a halt. No more
 * sessionStorage bridge-health, no more OEM classification, no more 5x
 * safeProbe ritual.
 */
export async function getPermissionStatusSnapshot(): Promise<PermissionStatusSnapshot> {
  if (!isCapacitorNative() || getCapacitorPlatform() !== 'android') {
    return unsupportedSnapshot();
  }

  const [notifGranted, exactGranted, fsiGranted] = await Promise.all([
    safeProbe('checkKumikoNotificationPermission', () => checkKumikoNotificationPermission()),
    safeProbe('canScheduleExactAlarms', () => canScheduleExactAlarms()),
    safeProbe('canUseFullScreenIntent', () => canUseFullScreenIntent()),
  ]);

  const items: PermissionStatusSnapshot['items'] = {
    notifications: {
      key: 'notifications',
      state: booleanToState(notifGranted),
      canVerify: true,
      canOpenSettings: true,
    },
    exactAlarm: {
      key: 'exactAlarm',
      state: booleanToState(exactGranted),
      canVerify: true,
      canOpenSettings: true,
    },
    fullScreenIntent: {
      key: 'fullScreenIntent',
      state: booleanToState(fsiGranted),
      canVerify: true,
      canOpenSettings: true,
    },
    // v2.14.27: no reliable PowerManager.isIgnoringBatteryOptimizations bridge
    // anymore (we deleted the @PluginMethod). The user can verify by going to
    // settings; we trust them on return.
    batteryOptimization: {
      key: 'batteryOptimization',
      state: 'unknown',
      canVerify: false,
      canOpenSettings: true,
    },
    // No public API on AOSP to read MIUI's "show on lockscreen" toggle. Same
    // pattern: open settings + trust the user.
    lockScreenDisplay: {
      key: 'lockScreenDisplay',
      state: 'unknown',
      canVerify: false,
      canOpenSettings: true,
    },
  };

  // Overall = worst of the verifiable items only. unknown counts as unknown,
  // not denied — we don't want to nag users about state we couldn't measure.
  const verifiableStates = [items.notifications.state, items.exactAlarm.state, items.fullScreenIntent.state];
  const overall: PermissionState = verifiableStates.some((s) => s === 'denied')
    ? 'denied'
    : verifiableStates.every((s) => s === 'granted')
      ? 'granted'
      : 'unknown';

  return { supported: true, overall, items };
}

/** v2.14.27: thin alias for callers that still reference the old name during
 *  the gradual rename. Will be removed once AndroidPermissionsSection and
 *  PermissionOnboardingWizard finish migrating. */
export const getAndroidAlertPermissionSnapshot = getPermissionStatusSnapshot;

/** v2.14.27: maps a raw boolean (or null on probe failure) to the user-facing
 *  state pill. We treat `null` as `unknown` so a transient bridge hiccup
 *  doesn't flicker the pill from "granted" to "denied" between two refreshes. */
function booleanToState(granted: boolean | null): PermissionState {
  if (granted === null) return 'unknown';
  return granted ? 'granted' : 'denied';
}

async function safeProbe<T>(label: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await withTimeout(label, run());
  } catch (e) {
    if (e instanceof TimeoutError) {
      console.warn(`[permissionStatus] ${label} timed out after ${TEST_TIMEOUT_MS}ms`);
    } else {
      console.warn(`[permissionStatus] ${label} failed:`, e);
    }
    return null;
  }
}

export async function requestNotificationPermission(): Promise<PermissionStatusSnapshot> {
  await safeProbe('requestKumikoNotificationPermission', () => requestKumikoNotificationPermission());
  return getPermissionStatusSnapshot();
}

const SETTINGS_KEY_FOR: Record<PermissionKey, AndroidSettingsKey | null> = {
  notifications: 'notifications',
  exactAlarm: 'exactAlarm',
  fullScreenIntent: 'fullScreenIntent',
  batteryOptimization: 'batteryOptimization',
  lockScreenDisplay: 'appDetails',
};

/**
 * v2.14.27: open the matching system settings page. Special-cased for
 * exactAlarm/fullScreenIntent because Android exposes a one-shot
 * `request*Permission` Activity intent that is friendlier than the
 * generic Settings deep-link — we try it first and fall back to the
 * generic openSettings entrypoint if Android refuses (older API levels).
 */
export async function openPermissionSettings(key: PermissionKey): Promise<void> {
  if (key === 'exactAlarm') {
    await safeProbe('requestExactAlarmPermission', () => requestExactAlarmPermission());
    return;
  }
  if (key === 'fullScreenIntent') {
    await safeProbe('requestFullScreenIntentPermission', () => requestFullScreenIntentPermission());
    return;
  }
  const settingsKey = SETTINGS_KEY_FOR[key];
  if (!settingsKey) return;
  await safeProbe(`openAndroidSettings:${settingsKey}`, () => openAndroidSettings(settingsKey));
}

/** v2.14.27: alias kept temporarily so AndroidPermissionsSection /
 *  PermissionOnboardingWizard can migrate without two churn passes. */
export async function openAndroidAlertPermissionSettings(key: PermissionKey): Promise<void> {
  await openPermissionSettings(key);
}

export async function requestAndroidNotificationPermission(): Promise<PermissionStatusSnapshot> {
  return requestNotificationPermission();
}

const TEST_TITLE_MESSAGE = 'Kumiko·Amadeus';
const TEST_BODY_MESSAGE = 'Android message notification test';
const TEST_TITLE_CALL = '黄前久美子 来电测试';
const TEST_BODY_CALL = '来电铃声 / 震动测试';

/**
 * v2.14.27: message notification test. Goes straight to LocalNotifications
 * (the proven path); skips the custom plugin entirely so HyperOS throttling
 * of @PluginMethod calls cannot block this test.
 */
export async function runMessageNotificationTest(): Promise<PermissionTestResult> {
  if (!isCapacitorNative() || getCapacitorPlatform() !== 'android') {
    return { ok: false, reason: 'unsupported' };
  }
  const granted = await safeProbe('checkKumikoNotificationPermission', () => checkKumikoNotificationPermission());
  if (granted === false) return { ok: false, reason: 'no-permission' };

  const result = await postKumikoFallbackMessageNotification({
    title: TEST_TITLE_MESSAGE,
    body: TEST_BODY_MESSAGE,
    channelId: CHANNEL_MESSAGES,
  });
  return result.posted
    ? { ok: true }
    : { ok: false, reason: result.reason === 'schedule-failed' ? 'schedule-failed' : 'no-permission' };
}

/**
 * v2.14.27: incoming-call notification test. Same LocalNotifications path
 * (CHANNEL_CALLS still has DND-bypass + max importance from the v3 channel
 * the native plugin created on first launch).
 */
export async function runIncomingCallTest(ringtoneFileId?: string | null): Promise<PermissionTestResult> {
  if (!isCapacitorNative() || getCapacitorPlatform() !== 'android') {
    return { ok: false, reason: 'unsupported' };
  }
  const granted = await safeProbe('checkKumikoNotificationPermission', () => checkKumikoNotificationPermission());
  if (granted === false) return { ok: false, reason: 'no-permission' };

  await safeProbe('ensureNativeRingtoneForAlarm', () => ensureNativeRingtoneForAlarm(ringtoneFileId));

  const result = await postKumikoFallbackCallNotification({
    title: TEST_TITLE_CALL,
    body: TEST_BODY_CALL,
    channelId: CHANNEL_CALLS,
  });
  return result.posted
    ? { ok: true }
    : { ok: false, reason: result.reason === 'schedule-failed' ? 'schedule-failed' : 'no-permission' };
}

/** v2.14.27: aliases kept temporarily for the wizard / settings migration. */
export const runAndroidMessageNotificationTest = runMessageNotificationTest;
export const runAndroidIncomingCallTest = runIncomingCallTest;

/**
 * v2.14.27: legacy export. The v2.14.26 native plugin had `cancelTestNotifications`
 * to scrub previously-posted test notifications; LocalNotifications.cancel
 * needs ids we don't track, so this is now a no-op. The fallback notifications
 * carry channel default behaviour (auto-cancel on tap) so cleanup happens
 * naturally.
 */
export async function clearAndroidAlertTests(): Promise<void> {
  // v2.14.27: no-op. See header comment.
}

/**
 * v2.14.27: legacy alias for `ensureKumikoNotificationChannelsBootstrap`. The
 * native KumikoAlarmsPlugin.load() creates the channels on first launch; JS
 * doesn't need to ensure anything. Kept as a no-op so older callers don't
 * blow up during the rename.
 */
export async function ensureAndroidAlertChannelsBootstrap(): Promise<void> {
  // v2.14.27: no-op — native KumikoAlarmsPlugin.load() creates channels.
}
