// services/capacitorNotifications.ts
//
// A6.2: Android Capacitor native notification + haptic wrapper. Replaces
// the browser `new Notification(...)` fallback path on Capacitor with
// @capacitor/local-notifications so the system tray actually wakes the
// user, and adds Haptics so the LINE / 微信-style vibration patterns
// fire on incoming proactive messages and reminders.
//
// Hides plugin imports behind small async helpers so the rest of the
// codebase (chatActions, VoiceCallOverlay, etc.) doesn't need to know
// the plugin shapes — just calls postKumikoNotification / vibrateForKind.
//
// Channel design (mirrors the plan's three-channel rule + the LINE/微信
// alignment we agreed on):
//
//   kumiko_messages_v3  = MessagingStyle text bubble (Android plugin owned)
//                         pattern [0, 250, 120, 250]
//                         Kind: proactive, reply, reminder (text-only)
//   kumiko_calls_v3     = FullScreenIntent + CallStyle (Android plugin owned)
//                         long persistent pattern, DND bypass, lockscreen public
//                         Kind: incoming-call
//   kumiko_foreground_service = persistent state notification (no vibrate)
//                         Lives under the foreground-service plugin; we don't
//                         post into it from this module.
//
// v2.14.24 IMPORTANT: channel creation is **owned by the native
// KumikoAlarmsPlugin** (see Java load() override). Pre-v3 we created
// channels from BOTH this file (via @capacitor/local-notifications
// createChannel) AND from Java; whichever raced first locked in its
// settings, which was the root cause of "messages channel has wrong
// vibration" / "calls channel doesn't bypass DND" bugs in v2.14.22-23.
// Now this file only references the channel IDs to schedule INTO them.
//
// PWA / Electron paths are unchanged — they still post via electronAPI
// or browser Notification. Capacitor branch is gated on isCapacitorNative()
// so the module is dead code on PC.

import { isCapacitorNative } from './environment';

export type KumikoNotificationKind =
  | 'proactive'   // unsolicited message (RNG / sleep / busy follow-up)
  | 'reply'       // direct reply to user message
  | 'reminder'    // user-set scheduled reminder text
  | 'incoming-call'; // FullScreenIntent path (only used by the timed
                  // reminder pipeline, NEVER by the other proactive
                  // sources — keeps the "calls only from reminder"
                  // edge property the plan committed to).

export interface PostNotificationOptions {
  title: string;
  body: string;
  kind: KumikoNotificationKind;
  messageId?: string;
}

// v2.14.24: bumped to *_v3, native plugin owns creation/migration.
const CHANNEL_MESSAGES = 'kumiko_messages_v3';
const CHANNEL_CALLS = 'kumiko_calls_v3';
const NOTIFICATION_ID_BASE = 1000;

let nextNotificationId = NOTIFICATION_ID_BASE;

export interface KumikoNotificationRuntimeStatus {
  supported: boolean;
  channelsReady: boolean;
  permissionGranted: boolean;
}

function deriveNotificationId(): number {
  // local-notifications wants 32-bit ints; recycle once we hit ~2 billion
  // (we never will, but defensive).
  nextNotificationId = (nextNotificationId + 1) & 0x7fffffff;
  return Math.max(NOTIFICATION_ID_BASE, nextNotificationId);
}

export async function ensureKumikoNotificationChannels(): Promise<boolean> {
  // v2.14.24: native KumikoAlarmsPlugin.load() is now the single source of
  // truth for kumiko_messages_v3 / kumiko_calls_v3 channel creation. This
  // function is kept as a no-op-on-native API stub so callers
  // (primeKumikoNotificationRuntime, postKumikoNotification, etc.) don't
  // need conditional branches. We just trust the native plugin: by the
  // time JS code runs, BridgeActivity.onCreate has finished and load()
  // has run, so the channels already exist.
  return isCapacitorNative();
}

export async function checkKumikoNotificationPermission(): Promise<boolean> {
  if (!isCapacitorNative()) return false;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const perm = await LocalNotifications.checkPermissions();
    return perm.display === 'granted';
  } catch (e) {
    console.warn('[capacitorNotifications] permission check failed:', e);
    return false;
  }
}

export async function requestKumikoNotificationPermission(): Promise<boolean> {
  if (!isCapacitorNative()) return false;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const req = await LocalNotifications.requestPermissions();
    return req.display === 'granted';
  } catch (e) {
    console.warn('[capacitorNotifications] permission request failed:', e);
    return false;
  }
}

export async function primeKumikoNotificationRuntime(): Promise<KumikoNotificationRuntimeStatus> {
  const channelsReady = await ensureKumikoNotificationChannels();
  if (!isCapacitorNative()) {
    return { supported: false, channelsReady, permissionGranted: false };
  }
  const permissionGranted = await checkKumikoNotificationPermission()
    || await requestKumikoNotificationPermission();
  return { supported: true, channelsReady, permissionGranted };
}

/**
 * Post a system-tray notification on Android Capacitor. No-op on PWA /
 * Electron — the existing dispatch in showBackgroundNotification handles
 * those platforms and won't call into this module.
 */
export async function postKumikoNotification(opts: PostNotificationOptions): Promise<void> {
  if (!isCapacitorNative()) return;
  const channelsReady = await ensureKumikoNotificationChannels();
  const permissionGranted = await checkKumikoNotificationPermission();
  if (!channelsReady || !permissionGranted) return;

  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const channelId = opts.kind === 'incoming-call' ? CHANNEL_CALLS : CHANNEL_MESSAGES;
    await LocalNotifications.schedule({
      notifications: [
        {
          id: deriveNotificationId(),
          title: opts.title,
          body: opts.body,
          channelId,
          smallIcon: 'ic_stat_icon_config_sample', // capacitor's default Android template
          // Android only honors `extra` after a tap, not in the OS panel,
          // so we stash messageId there for our future deep-link handler
          // (TODO: wire when we add a tap handler in App.tsx).
          extra: opts.messageId ? { kumikoMessageId: opts.messageId } : undefined,
        },
      ],
    });
  } catch (e) {
    console.warn('[capacitorNotifications] schedule failed:', e);
  }
}

// ── Haptics ─────────────────────────────────────────────────────────
// Three patterns aligned with the LINE/微信 reference in the plan:
//   - text/proactive/reply/reminder  → short pulse  ~200 ms
//   - incoming-call                  → repeating long bursts (we only
//                                      fire one as a starter; native
//                                      ringtone audio + system call UI
//                                      handle the rest of the loop)
//   - foreground service status      → no haptic
//
// `@capacitor/haptics` exposes Haptics.vibrate({duration}) which Android
// honors directly via the Vibrator service. iOS only supports system
// haptic patterns (impact/selection), so duration is ignored there —
// fine because we're an Android-first design and iOS gets a sensible
// default tap-style pulse.

export async function vibrateForKind(kind: KumikoNotificationKind): Promise<void> {
  if (!isCapacitorNative()) return;
  try {
    const { Haptics } = await import('@capacitor/haptics');
    if (kind === 'incoming-call') {
      // 500ms initial pulse to grab attention; the LocalNotifications
      // channel above also ships a vibration:true so the OS layers a
      // longer ringer pattern on top.
      await Haptics.vibrate({ duration: 500 });
    } else {
      await Haptics.vibrate({ duration: 200 });
    }
  } catch (e) {
    // Silent — haptics are nice-to-have. Some Android devices throttle /
    // suppress vibration during DND or low-battery modes and surface as
    // exceptions; nothing we can do.
  }
}
