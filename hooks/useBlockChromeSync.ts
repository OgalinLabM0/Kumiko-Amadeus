// hooks/useBlockChromeSync.ts
//
// v2.14.29 Reactive Mood + Affection + Block Timer.
//
// Pushes the current block-runtime status to the Electron main process so
// `electron/notifications.cjs` can prepend "[拉黑中]" / "[Blocked]" to the
// window title and tray tooltip. Mirror of `useUnreadAlertsChrome.ts`'s
// final IPC effect, kept in its own hook because:
//
//   1. Different lifecycle: `blockRuntime` ticks down independently of
//      `unreadAlertCount`, and we need to push an "active=false" the
//      moment the timer expires (driven from `useBlockRegulator`'s
//      `clearBlock`), not on the next message.
//   2. Same code lives in both branches of the conditional flow (APP +
//      backgrounded), so isolating it avoids accidental cross-talk with
//      the unread-alert title machinery (which mutates `document.title`
//      directly even on web).
//   3. Web/mobile: this hook is a no-op outside Electron, so the call
//      site can stay unconditional.

import { useEffect } from 'react';
import { isDesktopElectron } from '../services/desktopBackupService';
import { useAppStore } from '../store';

export function useBlockChromeSync(): void {
  const blockRuntime = useAppStore(s => s.blockRuntime);
  const language = useAppStore(s => s.language);

  useEffect(() => {
    if (!isDesktopElectron()) return;
    const now = Date.now();
    const active = blockRuntime !== null && blockRuntime.activeUntilMs > now;
    try {
      const ipc = (window as { electronAPI?: { send?: (channel: string, data: unknown) => void } }).electronAPI;
      ipc?.send?.('app:update-block-state', {
        active,
        language: language === 'en' ? 'en' : 'zh',
      });
    } catch (error) {
      console.warn('[BLOCK-CHROME] Failed to sync block state to Electron shell:', error);
    }
  }, [blockRuntime?.activeUntilMs, blockRuntime?.startedAt, language]);
}
