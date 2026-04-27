// services/androidAlarmService.ts
//
// v2.14.27: drastically slimmed down. The custom KumikoAlarmsPlugin is
// now a pure scheduler — only schedule/cancel exact alarms and 2 boolean
// permission probes. Everything else (notification display, OEM
// detection, Telecom integration, bridge health tracking) lives elsewhere
// or has been deleted entirely. The previous v2.14.25/26 bridge-health
// machinery (sessionStorage `kumiko_native_bridge_health`,
// markKumikoBridgeAlive/Dead, readKumikoBridgeHealth, BRIDGE_HEALTH_TTL_MS)
// was the symptom of an oversized native surface; the cure is to shrink
// the surface, not track its rot.
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
  /** v2.14.27: when true, the JS listener that handles `kumikoAlarmFired`
   *  will fire `triggerTimedReminderMessage` in 'call' mode (LocalNotifications
   *  posts into the calls channel + React VoiceCallOverlay handles the
   *  ringing UI on resume). Native receiver no longer differentiates.
   *  False → standard text notification through the messages channel. */
  wantsCall?: boolean;
  /** Selected ringtone id (built-in 01.mp3..08.mp3 or custom.ext). Carried
   *  through the AlarmManager extras so the JS listener can hand the right
   *  ringtone to the React VoiceCallOverlay when the user taps in. */
  ringtoneFileId?: string;
}

export interface ScheduleAlarmResult {
  scheduled: boolean;
  exact: boolean;
  at?: number;
  reminderId?: string;
  error?: string;
}

/** v2.14.27: payload bridged from MainActivity's `kumikoAlarmFired` JS event.
 *  The JS listener in useScheduledReminders consumes this to immediately
 *  force-tick `checkScheduledReminders()` so the LLM generation runs even
 *  when the regular polling interval is paused (e.g. screen locked). */
export interface AlarmFiredEventPayload {
  reminderId: string;
  event: string;
  text?: string;
  wantsCall?: boolean;
  ringtoneFileId?: string;
  /** Epoch ms when the receiver fired. */
  firedAt: number;
}

interface KumikoAlarmsPluginShape {
  scheduleExact(opts: ScheduleAlarmInput): Promise<ScheduleAlarmResult>;
  cancel(opts: { reminderId: string }): Promise<{ cancelled: boolean }>;
  canScheduleExact(): Promise<{ canScheduleExact: boolean }>;
  requestExactAlarmPermission(): Promise<void>;
  canUseFullScreenIntent(): Promise<{ canUseFullScreenIntent: boolean }>;
  requestFullScreenIntentPermission(): Promise<void>;
  /** v2.14.27: single deep-link entrypoint. Replaces the v2.14.25/26 cluster
   *  of openAppNotificationSettings / requestIgnoreBatteryOptimization /
   *  openPhoneAccountSettings / openVendorSetting. Native handles fallback
   *  to App-details when a system page is unavailable on the running ROM. */
  openSettings(opts: { key: 'notifications' | 'exactAlarm' | 'fullScreenIntent' | 'batteryOptimization' | 'appDetails' }): Promise<{ opened: boolean }>;
  drainPendingActions(): Promise<{
    callAction?: { action: string; reminderId?: string; reminderEvent?: string; at?: number };
    repliesJson: string;
  }>;
  /** v2.14.23: cheap no-op call used by JS as a synchronous "warm the bridge"
   *  signal. The first JS→native call after WebView startup typically takes
   *  2-5s while Capacitor lazy-loads the plugin descriptor; calling this
   *  early prevents the production permission probe from being the
   *  cold-start bridge victim. */
  prewarm(): Promise<{ ok: true }>;
  /** v2.14.27: subscribe to native-emitted JS events (kumikoAlarmFired
   *  bridges the MainActivity onNewIntent handler to JS).  Capacitor's
   *  generic `addListener` shape is opaque to TS; we model the parts we
   *  need plus the unsubscribe handle. */
  addListener?: (
    event: 'kumikoAlarmFired',
    handler: (payload: AlarmFiredEventPayload) => void,
  ) => Promise<{ remove: () => Promise<void> }>;
}

// v2.14.3 N.7: caches both the resolved plugin handle and the in-flight
// import Promise. Capacitor's runtime tolerates duplicate registrations
// but logs a warning per duplicate; with the cached handle the warn
// fires at most once on first use.
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
      const { registerPlugin } = await import('@capacitor/core');
      const plugin = registerPlugin<KumikoAlarmsPluginShape>('KumikoAlarms');
      cachedPlugin = plugin;
      return plugin;
    } catch (e) {
      console.warn('[androidAlarms] plugin import failed:', e);
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

/** v2.14.27: single deep-link entrypoint. Older native binaries that do not
 *  yet expose `openSettings` reject with UNIMPLEMENTED — we surface as
 *  `{ opened: false }` so the caller can show a "no system page available"
 *  toast instead of crashing. */
export type AndroidSettingsKey = 'notifications' | 'exactAlarm' | 'fullScreenIntent' | 'batteryOptimization' | 'appDetails';

export async function openAndroidSettings(key: AndroidSettingsKey): Promise<boolean> {
  const plugin = await getPlugin();
  if (!plugin) return false;
  try {
    const result = await plugin.openSettings({ key });
    return result.opened === true;
  } catch (e) {
    console.warn('[androidAlarms] openSettings failed:', e);
    return false;
  }
}

/**
 * v2.14.23: explicit Capacitor plugin warm-up. The first call to a Capacitor
 * plugin after a cold WebView start can take 2-5s (or longer on busy ROMs)
 * while the bridge lazily resolves the native descriptor. We resolve this
 * by issuing a no-op `prewarm()` early in the bootstrap with a short budget;
 * subsequent calls benefit from the now-resolved bridge.
 *
 * v2.14.27: simplified — no more sessionStorage bridge-health write, no more
 * LocalNotifications self-check, no more 8s budget (the surface is small enough
 * now that 4s is plenty). Returns true iff the bridge produced a result inside
 * the timeout. Returns false on timeout / any failure; caller should still
 * proceed (the regular call path tolerates a cold bridge, just slower).
 */
export async function prewarmKumikoAlarmsPlugin(timeoutMs = 4_000): Promise<boolean> {
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

/**
 * v2.14.27: subscribe to the native `kumikoAlarmFired` JS event emitted from
 * MainActivity.onNewIntent when the AlarmManager broadcast woke the WebView.
 * Returns an `unsubscribe` thunk; safe to call before the bridge is ready
 * (the underlying registerPlugin handle queues the listener registration).
 *
 * Pre-v2.14.27 native binaries do not emit this event; the listener will
 * simply never fire — JS poller in useScheduledReminders still picks the
 * reminder up on its next 1s/60s tick, just slower.
 */
export async function addAlarmFiredListener(
  handler: (payload: AlarmFiredEventPayload) => void,
): Promise<() => void> {
  const plugin = await getPlugin();
  if (!plugin || typeof plugin.addListener !== 'function') return () => {};
  try {
    const sub = await plugin.addListener('kumikoAlarmFired', handler);
    return () => {
      try {
        void sub.remove();
      } catch (e) {
        console.warn('[androidAlarms] addAlarmFiredListener unsubscribe failed:', e);
      }
    };
  } catch (e) {
    console.warn('[androidAlarms] addAlarmFiredListener subscribe failed:', e);
    return () => {};
  }
}

export interface DrainedAction {
  type: 'call';
  /** v2.14.24: the heads-up CallStyle notification produces three action
   *  variants depending on which UI element the user tapped:
   *   - `open_call`     — body of the heads-up (intent to "answer in app").
   *   - `accept_call`   — green Accept circle (or pre-v2.14.24 IncomingCallActivity
   *                       accept button).
   *   - `decline_call`  — red Decline circle (preferred new spelling).
   *   - `reject_call`   — pre-v2.14.24 IncomingCallActivity legacy spelling, kept
   *                       in the union so any unconsumed entries from older
   *                       installs still drain into the same reject branch. */
  action: 'open_call' | 'accept_call' | 'decline_call' | 'reject_call';
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
 *   - call open / accept / decline taps from MainActivity (v2.14.24+
 *     heads-up route) or the legacy IncomingCallActivity (pre-v2.14.24)
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
    if (raw.callAction) {
      const a = raw.callAction.action;
      if (a === 'open_call' || a === 'accept_call' || a === 'decline_call' || a === 'reject_call') {
        out.call = {
          type: 'call',
          action: a,
          reminderId: raw.callAction.reminderId,
          reminderEvent: raw.callAction.reminderEvent,
          atMs: raw.callAction.at,
        };
      }
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
