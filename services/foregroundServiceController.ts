// services/foregroundServiceController.ts
//
// B.1 (A6.1): Android Foreground Service controller. Spins up
// @capawesome-team/capacitor-android-foreground-service so the
// app process stays alive after the user backgrounds / locks the
// phone, which is the prerequisite for proactive features (RNG
// 主动消息 / 睡眠协议 / Busy 跟进 / B.2 AlarmManager / B.5 自动备份)
// to keep firing. Without this, Android Doze mode would kill the
// JS runtime within ~5-15 minutes of going to background and the
// user would notice every reminder skipping.
//
// User-facing trade-off: a persistent notification "Kumiko·Amadeus
// 运行中" sits in the system tray. Users CAN disable it via system
// settings (notification channel "kumiko_foreground_service" → off)
// but disabling it lets Android kill the process under memory pressure
// and breaks the proactive features. We surface this trade-off in the
// settings panel so the user knows what's happening.
//
// Lifecycle:
//   - On app boot (App.tsx mounts in Capacitor) → startForegroundService
//     unless the user has disabled it in settings.
//   - On Capacitor standalone the persistent notification is mandatory
//     because there's no PC to keep proactive timers alive remotely.
//   - In Capacitor paired mode the FG service is also useful (PC may
//     not be online when the user expects a reminder), but we leave
//     it user-toggleable.
//   - The service stays alive until explicitly stopped via the
//     settings toggle or the app uninstall.
//
// PWA / Electron never call this module.

import { isCapacitorNative } from './environment';

export const FG_SERVICE_NOTIFICATION_ID = 1; // any positive int; recycled
export const FG_SERVICE_CHANNEL_ID = 'kumiko_foreground_service';
export const FG_SERVICE_DISABLED_STORAGE_KEY = 'kumiko_fg_service_disabled';

interface StartOptions {
  /** Bilingual override for the persistent notification title/body. */
  language?: 'zh' | 'en';
}

let started = false;

function isExplicitlyDisabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(FG_SERVICE_DISABLED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setForegroundServiceDisabled(disabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (disabled) {
      window.localStorage.setItem(FG_SERVICE_DISABLED_STORAGE_KEY, 'true');
    } else {
      window.localStorage.removeItem(FG_SERVICE_DISABLED_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Start (or no-op if already started) the foreground service. Safe to
 * call from any lifecycle point — internally idempotent so a remount
 * during fast refresh / settings save doesn't double-spawn the service.
 */
export async function startForegroundServiceIfNeeded(opts: StartOptions = {}): Promise<void> {
  if (!isCapacitorNative()) return;
  if (isExplicitlyDisabled()) return;
  if (started) return;
  try {
    const { ForegroundService } = await import('@capawesome-team/capacitor-android-foreground-service');
    // Capacitor 7's local-notifications createChannel is shared by
    // ForegroundService too — A6.2 already created kumiko_messages and
    // kumiko_calls; here we add a third channel that's silent / no
    // vibration / no lights so the persistent notification doesn't
    // grab attention each app boot.
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      await LocalNotifications.createChannel({
        id: FG_SERVICE_CHANNEL_ID,
        name: '运行状态 · App status',
        description: 'Kumiko·Amadeus 后台保活',
        importance: 1, // IMPORTANCE_MIN — bottom of system tray, no sound/vibrate
        visibility: 1, // PUBLIC
        vibration: false,
        sound: undefined,
        lights: false,
      });
    } catch (e) {
      console.warn('[fgService] createChannel failed (continuing):', e);
    }
    const language = opts.language || 'zh';
    await ForegroundService.startForegroundService({
      id: FG_SERVICE_NOTIFICATION_ID,
      title: 'Kumiko·Amadeus',
      body: language === 'zh' ? '运行中' : 'Running',
      smallIcon: 'ic_stat_icon_config_sample',
      silent: true,
      notificationChannelId: FG_SERVICE_CHANNEL_ID,
    });
    started = true;
    console.log('[fgService] started');
  } catch (e) {
    console.warn('[fgService] start failed:', e);
  }
}

export async function stopForegroundService(): Promise<void> {
  if (!isCapacitorNative()) return;
  if (!started) return;
  try {
    const { ForegroundService } = await import('@capawesome-team/capacitor-android-foreground-service');
    await ForegroundService.stopForegroundService();
    started = false;
  } catch (e) {
    console.warn('[fgService] stop failed:', e);
  }
}

/**
 * Update the persistent notification text. Used when proactive state
 * shifts to something the user might want surfaced (e.g. "正在生成日记" /
 * "睡眠模式开启"). Falls back silently if not supported by current plugin
 * version (older 6.x didn't expose update).
 */
export async function updateForegroundService(title: string, body: string): Promise<void> {
  if (!isCapacitorNative() || !started) return;
  try {
    const { ForegroundService } = await import('@capawesome-team/capacitor-android-foreground-service');
    if (typeof (ForegroundService as { updateForegroundService?: unknown }).updateForegroundService === 'function') {
      await (ForegroundService as unknown as {
        updateForegroundService: (opts: { id: number; title: string; body: string; smallIcon: string }) => Promise<void>;
      }).updateForegroundService({
        id: FG_SERVICE_NOTIFICATION_ID,
        title,
        body,
        smallIcon: 'ic_stat_icon_config_sample',
      });
    }
  } catch (e) {
    console.warn('[fgService] update failed:', e);
  }
}

export function isForegroundServiceStarted(): boolean {
  return started;
}
