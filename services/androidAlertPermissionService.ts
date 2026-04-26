import { getCapacitorPlatform, isCapacitorNative } from './environment';
import {
  cancelAndroidTestNotifications,
  getNativeAndroidAlertPermissionStatus,
  openAndroidAppNotificationSettings,
  postAndroidTestIncomingCall,
  postAndroidTestMessageNotification,
  requestExactAlarmPermission,
  requestFullScreenIntentPermission,
  type NativeAndroidAlertPermissionStatus,
} from './androidAlarmService';
import {
  checkKumikoNotificationPermission,
  ensureKumikoNotificationChannels,
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

export interface AndroidAlertPermissionSnapshot {
  supported: boolean;
  sdkInt?: number;
  overall: AndroidAlertPermissionState;
  items: Record<AndroidAlertPermissionKey, AndroidAlertPermissionItem>;
  nativeStatus: NativeAndroidAlertPermissionStatus | null;
}

export interface AndroidAlertTestResult {
  ok: boolean;
  reason?: AndroidAlertPermissionKey | 'unsupported' | 'native-failed';
}

const unavailableItem = (key: AndroidAlertPermissionKey): AndroidAlertPermissionItem => ({
  key,
  state: 'unavailable',
  canOpenSettings: false,
});

const makeItem = (
  key: AndroidAlertPermissionKey,
  granted: boolean | null | undefined,
  canOpenSettings = true,
): AndroidAlertPermissionItem => ({
  key,
  state: granted == null ? 'unknown' : (granted ? 'granted' : 'denied'),
  canOpenSettings,
});

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
  };
};

export async function getAndroidAlertPermissionSnapshot(): Promise<AndroidAlertPermissionSnapshot> {
  if (!isCapacitorNative() || getCapacitorPlatform() !== 'android') {
    return unsupportedSnapshot();
  }

  const channelsReadyFromJs = await ensureKumikoNotificationChannels();
  const [notificationPermission, nativeStatus] = await Promise.all([
    checkKumikoNotificationPermission(),
    getNativeAndroidAlertPermissionStatus(),
  ]);

  const notificationsGranted = nativeStatus
    ? notificationPermission && nativeStatus.notificationsEnabled
    : notificationPermission;

  const messagesChannelReady = nativeStatus
    ? nativeStatus.messagesChannelReady
    : (channelsReadyFromJs ? null : false);
  const callsChannelReady = nativeStatus
    ? nativeStatus.callsChannelReady
    : (channelsReadyFromJs ? null : false);

  const items: AndroidAlertPermissionSnapshot['items'] = {
    notifications: makeItem('notifications', notificationsGranted, true),
    exactAlarm: makeItem('exactAlarm', nativeStatus?.exactAlarmReady, true),
    fullScreenIntent: makeItem('fullScreenIntent', nativeStatus?.fullScreenIntentReady, true),
    messagesChannel: makeItem('messagesChannel', messagesChannelReady, true),
    callsChannel: makeItem('callsChannel', callsChannelReady, true),
  };

  const values = Object.values(items).map((item) => item.state);
  const overall: AndroidAlertPermissionState = values.every((state) => state === 'granted')
    ? 'granted'
    : values.some((state) => state === 'denied')
      ? 'denied'
      : 'unknown';

  return {
    supported: true,
    sdkInt: nativeStatus?.sdkInt,
    overall,
    items,
    nativeStatus,
  };
}

export async function requestAndroidNotificationPermission(): Promise<AndroidAlertPermissionSnapshot> {
  await ensureKumikoNotificationChannels();
  await requestKumikoNotificationPermission();
  return getAndroidAlertPermissionSnapshot();
}

export async function openAndroidAlertPermissionSettings(key: AndroidAlertPermissionKey): Promise<void> {
  if (key === 'exactAlarm') {
    await requestExactAlarmPermission();
    return;
  }
  if (key === 'fullScreenIntent') {
    await requestFullScreenIntentPermission();
    return;
  }
  await openAndroidAppNotificationSettings();
}

export async function runAndroidMessageNotificationTest(): Promise<AndroidAlertTestResult> {
  const snapshot = await getAndroidAlertPermissionSnapshot();
  if (!snapshot.supported) return { ok: false, reason: 'unsupported' };
  if (snapshot.items.notifications.state !== 'granted') return { ok: false, reason: 'notifications' };
  if (snapshot.items.messagesChannel.state !== 'granted') return { ok: false, reason: 'messagesChannel' };

  const posted = await postAndroidTestMessageNotification({
    title: 'Kumiko·Amadeus',
    body: 'Android message notification test',
  });
  return posted ? { ok: true } : { ok: false, reason: 'native-failed' };
}

export async function runAndroidIncomingCallTest(ringtoneFileId?: string | null): Promise<AndroidAlertTestResult> {
  const snapshot = await getAndroidAlertPermissionSnapshot();
  if (!snapshot.supported) return { ok: false, reason: 'unsupported' };
  if (snapshot.items.notifications.state !== 'granted') return { ok: false, reason: 'notifications' };
  if (snapshot.items.callsChannel.state !== 'granted') return { ok: false, reason: 'callsChannel' };
  if (snapshot.items.fullScreenIntent.state !== 'granted') return { ok: false, reason: 'fullScreenIntent' };

  await ensureNativeRingtoneForAlarm(ringtoneFileId);
  const posted = await postAndroidTestIncomingCall({
    title: '黄前久美子 来电测试',
    body: '来电弹窗 / 铃声 / 震动测试',
    ringtoneFileId: ringtoneFileId || '',
  });
  return posted ? { ok: true } : { ok: false, reason: 'native-failed' };
}

export async function clearAndroidAlertTests(): Promise<void> {
  await cancelAndroidTestNotifications();
}
