import { getCapacitorPlatform, isCapacitorNative } from './environment';
import {
  cancelAndroidTestNotifications,
  ensureKumikoNotificationChannelsNative,
  getNativeAndroidAlertPermissionStatus,
  getOemDeviceInfo,
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
  | 'callsChannel';

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

const SNAPSHOT_PROBE_TIMEOUT_MS = 2_500;
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

async function safeProbe<T>(label: string, run: () => Promise<T>, fallback: T): Promise<{ value: T; ok: boolean }> {
  try {
    const value = await withTimeout(label, run());
    return { value, ok: true };
  } catch (e) {
    if (e instanceof TimeoutError) {
      console.warn(`[androidAlertPermission] ${label} timed out after ${SNAPSHOT_PROBE_TIMEOUT_MS}ms`);
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
 *   - returns within ~2.5s × number-of-parallel-probes (we run them in parallel
 *     so the wall-clock cap is the slowest single probe).
 */
export async function getAndroidAlertPermissionSnapshot(): Promise<AndroidAlertPermissionSnapshot> {
  if (!isCapacitorNative() || getCapacitorPlatform() !== 'android') {
    return unsupportedSnapshot();
  }

  const [permResult, nativeResult, oemResult] = await Promise.all([
    safeProbe('checkKumikoNotificationPermission', () => checkKumikoNotificationPermission(), false),
    safeProbe<NativeAndroidAlertPermissionStatus | null>('getAlertPermissionStatus', () => getNativeAndroidAlertPermissionStatus(), null),
    safeProbe<NativeOemDeviceInfo | null>('getOemDeviceInfo', () => getOemDeviceInfo(), null),
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

  const items: AndroidAlertPermissionSnapshot['items'] = {
    notifications: notificationsItem,
    exactAlarm: exactAlarmItem,
    fullScreenIntent: fullScreenItem,
    messagesChannel: messagesChannelItem,
    callsChannel: callsChannelItem,
  };

  const values = Object.values(items).map((item) => item.state);
  const overall: AndroidAlertPermissionState = values.every((state) => state === 'granted')
    ? 'granted'
    : values.some((state) => state === 'denied')
      ? 'denied'
      : 'unknown';

  const partial = !permResult.ok || !nativeResult.ok || !oemResult.ok;

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
