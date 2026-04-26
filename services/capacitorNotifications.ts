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
//   kumiko_messages  = MessagingStyle text bubble
//                      pattern [0, 200] (short pulse, like WeChat new msg)
//                      Kind: proactive, reply, reminder (text-only)
//   kumiko_calls     = FullScreenIntent + repeating long pattern
//                      [0, 400, 200, 400, 200, 400] (LINE incoming call)
//                      Kind: incoming-call (only the timed-reminder path
//                      reaches here; see plan A6 routing)
//   kumiko_foreground_service = persistent state notification (no vibrate)
//                      Lives under A6.1's foreground service; we don't
//                      post into it from this module yet.
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

const CHANNEL_MESSAGES = 'kumiko_messages';
const CHANNEL_CALLS = 'kumiko_calls';
const NOTIFICATION_ID_BASE = 1000;

let channelsInitialized = false;
let nextNotificationId = NOTIFICATION_ID_BASE;

function deriveNotificationId(): number {
  // local-notifications wants 32-bit ints; recycle once we hit ~2 billion
  // (we never will, but defensive).
  nextNotificationId = (nextNotificationId + 1) & 0x7fffffff;
  return Math.max(NOTIFICATION_ID_BASE, nextNotificationId);
}

async function ensureChannelsAndPermission(): Promise<boolean> {
  if (!isCapacitorNative()) return false;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    if (!channelsInitialized) {
      // Create the two channels (Android 8+ requires this before any
      // notification can post). createChannel is idempotent — calling it
      // every boot just re-binds the same name/desc/sound config.
      await LocalNotifications.createChannel({
        id: CHANNEL_MESSAGES,
        name: '新消息 · Messages',
        description: '黄前久美子 主动联络',
        importance: 4, // IMPORTANCE_HIGH
        visibility: 1, // PUBLIC
        vibration: true,
        lights: true,
      });
      await LocalNotifications.createChannel({
        id: CHANNEL_CALLS,
        name: '来电 · Incoming calls',
        description: '黄前久美子 来电（定时提醒触发）',
        importance: 5, // IMPORTANCE_MAX (heads-up + full-screen)
        visibility: 1,
        vibration: true,
        sound: 'ringtone', // Android falls back to default if missing
        lights: true,
      });
      channelsInitialized = true;
    }

    // Ensure the user has actually granted POST_NOTIFICATIONS (Android 13+).
    // Best-effort — we don't block the caller if the user denies, the
    // notification simply silently fails to surface.
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') {
      const req = await LocalNotifications.requestPermissions();
      if (req.display !== 'granted') return false;
    }
    return true;
  } catch (e) {
    console.warn('[capacitorNotifications] channel / permission setup failed:', e);
    return false;
  }
}

export async function primeKumikoNotificationRuntime(): Promise<boolean> {
  // Called once after the Android app reaches APP flow so proactive messages
  // and text reminders do not discover missing channels/permission only when
  // the first background notification is already trying to fire.
  return ensureChannelsAndPermission();
}

/**
 * Post a system-tray notification on Android Capacitor. No-op on PWA /
 * Electron — the existing dispatch in showBackgroundNotification handles
 * those platforms and won't call into this module.
 */
export async function postKumikoNotification(opts: PostNotificationOptions): Promise<void> {
  if (!isCapacitorNative()) return;
  const ok = await ensureChannelsAndPermission();
  if (!ok) return;

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
