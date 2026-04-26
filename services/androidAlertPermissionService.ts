import { getCapacitorPlatform, isCapacitorNative } from './environment';
import {
  cancelAndroidTestNotifications,
  ensureKumikoNotificationChannelsNative,
  getNativeAndroidAlertPermissionStatus,
  getOemDeviceInfo,
  isIgnoringBatteryOptimizations,
  isPhoneAccountRegistered,
  openAndroidAppNotificationSettings,
  openVendorPermissionSetting,
  postAndroidTestIncomingCall,
  postAndroidTestMessageNotification,
  requestExactAlarmPermission,
  requestFullScreenIntentPermission,
  type NativeAndroidAlertPermissionStatus,
  type NativeOemDeviceInfo,
  type VendorPermissionKey,
} from './androidAlarmService';
import {
  checkKumikoNotificationPermission,
  requestKumikoNotificationPermission,
} from './capacitorNotifications';
import { ensureNativeRingtoneForAlarm } from './voiceFileService';

export type AndroidAlertPermissionState = 'granted' | 'denied' | 'unavailable' | 'unknown';
export type AndroidAlertPermissionKey =
  | 'notifications'
  | 'exactAlarm'
  | 'fullScreenIntent'
  | 'messagesChannel'
  | 'callsChannel'
  /** v2.14.23: REQUEST_IGNORE_BATTERY_OPTIMIZATIONS allowlist state. */
  | 'batteryOptimizations'
  /** v2.14.23: self-managed Telecom PhoneAccount registered + enabled by user. */
  | 'phoneAccount';

export interface AndroidAlertPermissionItem {
  key: AndroidAlertPermissionKey;
  state: AndroidAlertPermissionState;
  canOpenSettings: boolean;
}

export type OemVendor =
  | 'xiaomi'
  | 'huawei'
  | 'samsung'
  | 'oppo'
  | 'vivo'
  | 'oneplus'
  | 'realme'
  | 'honor'
  | 'meizu'
  | 'asus'
  | 'lenovo'
  | 'motorola'
  | 'nothing'
  | 'google'
  | 'unknown';

export interface AndroidOemSnapshot {
  vendor: OemVendor;
  manufacturerRaw: string;
  brandRaw: string;
  miuiShowOnLockState: AndroidAlertPermissionState;
  hasVendorGuide: boolean;
}

export interface AndroidAlertPermissionSnapshot {
  supported: boolean;
  sdkInt?: number;
  overall: AndroidAlertPermissionState;
  items: Record<AndroidAlertPermissionKey, AndroidAlertPermissionItem>;
  nativeStatus: NativeAndroidAlertPermissionStatus | null;
  oem: AndroidOemSnapshot | null;
  /** Set if any individual probe timed out / threw. UI uses to surface a hint. */
  partial: boolean;
}

export interface AndroidAlertTestResult {
  ok: boolean;
  reason?: AndroidAlertPermissionKey | 'unsupported' | 'native-failed' | 'timeout';
}

// v2.14.23: pumped from 2.5s → 5s. Cold-start Capacitor bridge can take
// 2-5s on busy ROMs (HyperOS/MIUI especially); a 2.5s budget was the
// root cause of v2.14.22's "everything Unknown" regression. The
// snapshot caller (`getAndroidAlertPermissionSnapshot`) also retries
// once on partial result, so the worst-case wall clock of a cold UI
// probe is ~10s, still inside the 8s+buffer overall UI timeout.
const SNAPSHOT_PROBE_TIMEOUT_MS = 5_000;
const TEST_ACTION_TIMEOUT_MS = 6_000;

class TimeoutError extends Error {
  constructor(label: string) {
    super(`timeout:${label}`);
    this.name = 'TimeoutError';
  }
}

async function withTimeout<T>(label: string, promise: Promise<T>, ms = SNAPSHOT_PROBE_TIMEOUT_MS): Promise<T> {
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

async function safeProbe<T>(label: string, run: () => Promise<T>, fallback: T, timeoutMs: number = SNAPSHOT_PROBE_TIMEOUT_MS): Promise<{ value: T; ok: boolean }> {
  try {
    const value = await withTimeout(label, run(), timeoutMs);
    return { value, ok: true };
  } catch (e) {
    if (e instanceof TimeoutError) {
      console.warn(`[androidAlertPermission] ${label} timed out after ${timeoutMs}ms`);
    } else {
      console.warn(`[androidAlertPermission] ${label} failed:`, e);
    }
    return { value: fallback, ok: false };
  }
}

const unavailableItem = (key: AndroidAlertPermissionKey): AndroidAlertPermissionItem => ({
  key,
  state: 'unavailable',
  canOpenSettings: false,
});

const itemFromBoolean = (
  key: AndroidAlertPermissionKey,
  granted: boolean | null | undefined,
  canOpenSettings = true,
): AndroidAlertPermissionItem => ({
  key,
  state: granted == null ? 'unknown' : (granted ? 'granted' : 'denied'),
  canOpenSettings,
});

const itemFromState = (
  key: AndroidAlertPermissionKey,
  state: AndroidAlertPermissionState,
  canOpenSettings = true,
): AndroidAlertPermissionItem => ({ key, state, canOpenSettings });

const KNOWN_VENDORS: Record<string, OemVendor> = {
  xiaomi: 'xiaomi',
  redmi: 'xiaomi',
  poco: 'xiaomi',
  pocophone: 'xiaomi',
  huawei: 'huawei',
  honor: 'honor',
  samsung: 'samsung',
  oppo: 'oppo',
  realme: 'realme',
  oneplus: 'oneplus',
  vivo: 'vivo',
  iqoo: 'vivo',
  meizu: 'meizu',
  asus: 'asus',
  lenovo: 'lenovo',
  motorola: 'motorola',
  moto: 'motorola',
  nothing: 'nothing',
  google: 'google',
  pixel: 'google',
};

function classifyVendor(manufacturer?: string | null, brand?: string | null): OemVendor {
  const candidates = [manufacturer, brand].map((value) => (value || '').toLowerCase().trim());
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (KNOWN_VENDORS[candidate]) return KNOWN_VENDORS[candidate];
    for (const key of Object.keys(KNOWN_VENDORS)) {
      if (candidate.includes(key)) return KNOWN_VENDORS[key];
    }
  }
  return 'unknown';
}

const VENDORS_WITH_GUIDE = new Set<OemVendor>([
  'xiaomi', 'huawei', 'honor', 'samsung', 'oppo', 'realme', 'oneplus', 'vivo',
]);

function buildOemSnapshot(info: NativeOemDeviceInfo | null): AndroidOemSnapshot | null {
  if (!info) return null;
  const vendor = classifyVendor(info.manufacturer, info.brand);
  const miuiShowOnLockState: AndroidAlertPermissionState = vendor === 'xiaomi'
    ? (info.showOnLockState === 'granted'
      ? 'granted'
      : info.showOnLockState === 'denied'
        ? 'denied'
        : 'unknown')
    : 'unavailable';
  return {
    vendor,
    manufacturerRaw: info.manufacturer || '',
    brandRaw: info.brand || '',
    miuiShowOnLockState,
    hasVendorGuide: VENDORS_WITH_GUIDE.has(vendor),
  };
}

const unsupportedSnapshot = (): AndroidAlertPermissionSnapshot => {
  const items = {
    notifications: unavailableItem('notifications'),
    exactAlarm: unavailableItem('exactAlarm'),
    fullScreenIntent: unavailableItem('fullScreenIntent'),
    messagesChannel: unavailableItem('messagesChannel'),
    callsChannel: unavailableItem('callsChannel'),
    batteryOptimizations: unavailableItem('batteryOptimizations'),
    phoneAccount: unavailableItem('phoneAccount'),
  };
  return {
    supported: false,
    overall: 'unavailable',
    items,
    nativeStatus: null,
    oem: null,
    partial: false,
  };
};

/**
 * Read-only snapshot. Critical guarantees:
 *   - never calls a side-effecting plugin method (channel creation lives in
 *     `ensureKumikoNotificationChannelsForBootstrap` and the native `MainActivity`).
 *   - every native/Capacitor probe is wrapped in `withTimeout`. A stalled
 *     probe degrades that single item to `unknown` instead of hanging the UI.
 *   - returns within ~5s × number-of-parallel-probes (we run them in parallel
 *     so the wall-clock cap is the slowest single probe). v2.14.23: bumped
 *     from 2.5s → 5s because cold Capacitor bridge can take 2-5s on busy
 *     ROMs (HyperOS/MIUI), and added a one-shot retry when `partial` flips
 *     true to give the bridge another chance after warm-up.
 */
async function buildAlertPermissionSnapshotOnce(): Promise<AndroidAlertPermissionSnapshot> {
  if (!isCapacitorNative() || getCapacitorPlatform() !== 'android') {
    return unsupportedSnapshot();
  }

  const [permResult, nativeResult, oemResult, batteryResult, phoneAccountResult] = await Promise.all([
    safeProbe('checkKumikoNotificationPermission', () => checkKumikoNotificationPermission(), false),
    safeProbe<NativeAndroidAlertPermissionStatus | null>('getAlertPermissionStatus', () => getNativeAndroidAlertPermissionStatus(), null),
    safeProbe<NativeOemDeviceInfo | null>('getOemDeviceInfo', () => getOemDeviceInfo(), null),
    safeProbe<boolean | null>('isIgnoringBatteryOptimizations', () => isIgnoringBatteryOptimizations(), null),
    safeProbe<{ registered: boolean; enabled: boolean } | null>('isPhoneAccountRegistered', () => isPhoneAccountRegistered(), null),
  ]);

  const nativeStatus = nativeResult.value;
  const oem = buildOemSnapshot(oemResult.value);

  const notificationsItem: AndroidAlertPermissionItem = (() => {
    if (!permResult.ok && !nativeResult.ok) return itemFromState('notifications', 'unknown');
    if (nativeStatus) {
      const granted = permResult.value && nativeStatus.notificationsEnabled;
      return itemFromBoolean('notifications', granted);
    }
    return itemFromBoolean('notifications', permResult.value);
  })();

  const messagesChannelItem: AndroidAlertPermissionItem = nativeResult.ok && nativeStatus
    ? itemFromBoolean('messagesChannel', nativeStatus.messagesChannelReady)
    : itemFromState('messagesChannel', 'unknown');

  const callsChannelItem: AndroidAlertPermissionItem = nativeResult.ok && nativeStatus
    ? itemFromBoolean('callsChannel', nativeStatus.callsChannelReady)
    : itemFromState('callsChannel', 'unknown');

  const exactAlarmItem: AndroidAlertPermissionItem = nativeResult.ok && nativeStatus
    ? itemFromBoolean('exactAlarm', nativeStatus.exactAlarmReady)
    : itemFromState('exactAlarm', 'unknown');

  const fullScreenItem: AndroidAlertPermissionItem = nativeResult.ok && nativeStatus
    ? itemFromBoolean('fullScreenIntent', nativeStatus.fullScreenIntentReady)
    : itemFromState('fullScreenIntent', 'unknown');

  // v2.14.23: prefer the new `batteryOptimizationsIgnored` field on
  // NativeAndroidAlertPermissionStatus; fall back to the standalone
  // probe if the alert-status payload is missing it (older native
  // binary). batteryOptimizations isn't a hard "denied" by Android —
  // it's an opt-in allowlist; so when neither path produces an answer
  // we mark unknown rather than denied.
  const batteryGranted = nativeStatus && typeof nativeStatus.batteryOptimizationsIgnored === 'boolean'
    ? nativeStatus.batteryOptimizationsIgnored
    : batteryResult.value;
  const batteryItem: AndroidAlertPermissionItem = batteryGranted == null
    ? itemFromState('batteryOptimizations', batteryResult.ok ? 'unknown' : 'unknown')
    : itemFromBoolean('batteryOptimizations', batteryGranted);

  const phoneAccountValue = nativeStatus && typeof nativeStatus.phoneAccountReady === 'boolean'
    ? { registered: nativeStatus.phoneAccountReady, enabled: nativeStatus.phoneAccountReady }
    : phoneAccountResult.value;
  const phoneAccountItem: AndroidAlertPermissionItem = phoneAccountValue == null
    ? itemFromState('phoneAccount', 'unknown')
    : itemFromBoolean('phoneAccount', phoneAccountValue.registered && phoneAccountValue.enabled);

  const items: AndroidAlertPermissionSnapshot['items'] = {
    notifications: notificationsItem,
    exactAlarm: exactAlarmItem,
    fullScreenIntent: fullScreenItem,
    messagesChannel: messagesChannelItem,
    callsChannel: callsChannelItem,
    batteryOptimizations: batteryItem,
    phoneAccount: phoneAccountItem,
  };

  // v2.14.23: only "core" items count toward the overall pipeline state.
  // `batteryOptimizations` and `phoneAccount` are both optional reliability
  // boosters: phoneAccount degrades gracefully to the legacy FSI Activity
  // path, and batteryOptimizations is an allowlist that some users prefer
  // not to grant. Their state is surfaced individually in the UI but the
  // top-level "ready / needs setup" badge tracks the AOSP basics so we
  // don't scare users into thinking the entire pipeline is broken when
  // it's really just a reliability optimisation that's off.
  const coreItems: AndroidAlertPermissionItem[] = [
    items.notifications, items.messagesChannel, items.callsChannel, items.exactAlarm, items.fullScreenIntent,
  ];
  const coreStates = coreItems.map((item) => item.state);
  const overall: AndroidAlertPermissionState = coreStates.every((state) => state === 'granted')
    ? 'granted'
    : coreStates.some((state) => state === 'denied')
      ? 'denied'
      : 'unknown';

  const partial = !permResult.ok || !nativeResult.ok || !oemResult.ok || !batteryResult.ok || !phoneAccountResult.ok;

  return {
    supported: true,
    sdkInt: nativeStatus?.sdkInt,
    overall,
    items,
    nativeStatus,
    oem,
    partial,
  };
}

export async function getAndroidAlertPermissionSnapshot(opts: { retryOnPartial?: boolean } = {}): Promise<AndroidAlertPermissionSnapshot> {
  const { retryOnPartial = true } = opts;
  const first = await buildAlertPermissionSnapshotOnce();
  if (!first.partial || !retryOnPartial || !first.supported) return first;
  // v2.14.23: cold Capacitor bridge often resolves on the first call.
  // Retry once before reporting `partial: true` to the UI; the retry
  // benefits from the cached plugin handle so it should return inside
  // the SNAPSHOT_PROBE_TIMEOUT_MS budget. If it still partials we give
  // up and surface partial=true so the UI can prompt the user to
  // refresh manually.
  console.info('[androidAlertPermission] partial snapshot detected; retrying once');
  const second = await buildAlertPermissionSnapshotOnce();
  return second;
}

/**
 * One-shot bootstrap during APP flow start: ensure the native notification
 * channels exist so a missing channel doesn't show as "denied" forever. We
 * keep this OUT of `getAndroidAlertPermissionSnapshot` because creating a
 * channel is a side effect with potential to stall on misbehaving ROMs.
 */
export async function ensureAndroidAlertChannelsBootstrap(): Promise<void> {
  if (!isCapacitorNative() || getCapacitorPlatform() !== 'android') return;
  await safeProbe('ensureKumikoNotificationChannelsNative', () => ensureKumikoNotificationChannelsNative(), undefined);
}

export async function requestAndroidNotificationPermission(): Promise<AndroidAlertPermissionSnapshot> {
  await safeProbe('requestKumikoNotificationPermission', () => requestKumikoNotificationPermission(), false);
  return getAndroidAlertPermissionSnapshot();
}

export async function openAndroidAlertPermissionSettings(key: AndroidAlertPermissionKey): Promise<void> {
  if (key === 'exactAlarm') {
    await safeProbe('requestExactAlarmPermission', () => requestExactAlarmPermission(), undefined);
    return;
  }
  if (key === 'fullScreenIntent') {
    await safeProbe('requestFullScreenIntentPermission', () => requestFullScreenIntentPermission(), undefined);
    return;
  }
  if (key === 'batteryOptimizations') {
    // v2.14.23: REQUEST_IGNORE_BATTERY_OPTIMIZATIONS spawns an in-place
    // system dialog. If that fails (e.g. the user already accepted once
    // and Android is suppressing the dialog), KumikoAlarmsPlugin falls
    // back to opening Settings → Apps → Battery so the user can flip
    // the toggle manually. The native helper handles both paths so we
    // don't need to differentiate here.
    const { requestIgnoreBatteryOptimization } = await import('./androidAlarmService');
    await safeProbe('requestIgnoreBatteryOptimization', () => requestIgnoreBatteryOptimization(), false);
    return;
  }
  if (key === 'phoneAccount') {
    // v2.14.23: registering the PhoneAccount is a one-time native call;
    // enabling it is a user action in Settings → Apps → Default apps →
    // Calling accounts. We attempt the registration first, then deep-link
    // into the calling-accounts settings page so the user can flip the
    // toggle. Falls back to App details if the deep-link fails.
    const { registerPhoneAccount, openPhoneAccountSettings } = await import('./androidAlarmService');
    await safeProbe('registerPhoneAccount', () => registerPhoneAccount(), false);
    await safeProbe('openPhoneAccountSettings', () => openPhoneAccountSettings(), undefined);
    return;
  }
  await safeProbe('openAndroidAppNotificationSettings', () => openAndroidAppNotificationSettings(), undefined);
}

export async function openAndroidVendorPermissionSetting(key: VendorPermissionKey): Promise<{ opened: boolean; usedFallback: boolean }> {
  const result = await safeProbe(
    `openVendorPermissionSetting:${key}`,
    () => openVendorPermissionSetting(key),
    { opened: false, usedFallback: false },
  );
  return result.value;
}

async function runTimedTest<T>(
  label: string,
  run: () => Promise<T>,
  predicate: (value: T) => boolean,
): Promise<AndroidAlertTestResult> {
  try {
    const value = await withTimeout(label, run(), TEST_ACTION_TIMEOUT_MS);
    return predicate(value) ? { ok: true } : { ok: false, reason: 'native-failed' };
  } catch (e) {
    if (e instanceof TimeoutError) return { ok: false, reason: 'timeout' };
    console.warn(`[androidAlertPermission] ${label} threw:`, e);
    return { ok: false, reason: 'native-failed' };
  }
}

export async function runAndroidMessageNotificationTest(): Promise<AndroidAlertTestResult> {
  const snapshot = await getAndroidAlertPermissionSnapshot();
  if (!snapshot.supported) return { ok: false, reason: 'unsupported' };
  if (snapshot.items.notifications.state === 'denied') return { ok: false, reason: 'notifications' };
  if (snapshot.items.messagesChannel.state === 'denied') return { ok: false, reason: 'messagesChannel' };

  return runTimedTest(
    'postAndroidTestMessageNotification',
    () => postAndroidTestMessageNotification({
      title: 'Kumiko·Amadeus',
      body: 'Android message notification test',
    }),
    (posted) => posted === true,
  );
}

export async function runAndroidIncomingCallTest(ringtoneFileId?: string | null): Promise<AndroidAlertTestResult> {
  const snapshot = await getAndroidAlertPermissionSnapshot();
  if (!snapshot.supported) return { ok: false, reason: 'unsupported' };
  if (snapshot.items.notifications.state === 'denied') return { ok: false, reason: 'notifications' };
  if (snapshot.items.callsChannel.state === 'denied') return { ok: false, reason: 'callsChannel' };
  if (snapshot.items.fullScreenIntent.state === 'denied') return { ok: false, reason: 'fullScreenIntent' };

  await safeProbe('ensureNativeRingtoneForAlarm', () => ensureNativeRingtoneForAlarm(ringtoneFileId), undefined);
  return runTimedTest(
    'postAndroidTestIncomingCall',
    () => postAndroidTestIncomingCall({
      title: '黄前久美子 来电测试',
      body: '来电弹窗 / 铃声 / 震动测试',
      ringtoneFileId: ringtoneFileId || '',
    }),
    (posted) => posted === true,
  );
}

export async function clearAndroidAlertTests(): Promise<void> {
  await safeProbe('cancelAndroidTestNotifications', () => cancelAndroidTestNotifications(), undefined);
}
