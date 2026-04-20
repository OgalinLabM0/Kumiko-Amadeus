import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { isDesktopElectron } from '../services/desktopBackupService';

type FlowState = 'INTRO' | 'AUTH' | 'CONFIG' | 'APP';

export interface UseAppViewportInput {
  flowState: FlowState;
  isDarkMode: boolean;
  setIsFullscreen: (value: boolean) => void;
}

export interface UseAppViewportResult {
  appShellRef: RefObject<HTMLDivElement>;
  isIOS: boolean;
  toggleFullscreen: () => void;
}

/**
 * Encapsulates every DOM / viewport / theme side-effect that App.tsx used to
 * own inline. The contract is intentionally identical to the pre-extraction
 * behaviour so the refactor is observationally a no-op:
 *
 *   - iOS PWA `focusout` keyboard dismissal recovery
 *   - iOS + Electron viewport height / safe-area / background sync (runs at
 *     layout phase so `appShellRef` can be styled before paint)
 *   - iOS wake lock while `flowState === 'APP'`
 *   - `fullscreenchange` <-> store sync + `toggleFullscreen` helper
 *   - `<meta name="theme-color">` + Electron BrowserWindow bgColor sync
 *   - `data-resizing` flag on `<html>` during resize for heavy-subtree freeze
 *
 * The hook owns `appShellRef` and the memoised `isIOS` flag so the caller no
 * longer has to duplicate the UA sniff or thread the ref through its effects.
 */
export const useAppViewport = ({
  flowState,
  isDarkMode,
  setIsFullscreen,
}: UseAppViewportInput): UseAppViewportResult => {
  const appShellRef = useRef<HTMLDivElement>(null);

  const isIOS = useMemo(() => {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
  }, []);

  useEffect(() => {
    // Fix for iOS Safari PWA keyboard pushing app up and not restoring
    const handleFocusOut = () => {
      setTimeout(() => {
        if (
          !document.activeElement ||
          (document.activeElement.tagName !== 'INPUT' &&
            document.activeElement.tagName !== 'TEXTAREA')
        ) {
          window.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
        }
      }, 100);
    };

    window.addEventListener('focusout', handleFocusOut);

    return () => {
      window.removeEventListener('focusout', handleFocusOut);
    };
  }, []);

  useLayoutEffect(() => {
    const applyViewportFix = () => {
      const vv = window.visualViewport;
      const isStandalone =
        (window.navigator as any).standalone === true ||
        window.matchMedia('(display-mode: standalone)').matches;

      let h = window.innerHeight || 0;

      if (vv) {
        h = Math.max(h, Math.round(vv.height + vv.offsetTop));
      }

      if (isStandalone) {
        h = Math.max(h, document.documentElement.clientHeight || 0);
      }

      const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
      const topOffset = (isStandalone && isIOSDevice) ? 'env(safe-area-inset-top)' : '0';

      let hpx = (isStandalone && isIOSDevice) ? `calc(${h}px - env(safe-area-inset-top))` : `${h}px`;
      if (isStandalone && typeof CSS !== 'undefined' && CSS.supports('height: 100dvh')) {
        hpx = isIOSDevice ? 'calc(100dvh - env(safe-area-inset-top))' : '100dvh';
      }
      const bg = flowState === 'APP'
        ? (isDarkMode ? '#121212' : '#ffffff')
        : '#f9f7f2';

      if (isDesktopElectron()) {
        document.documentElement.style.setProperty('--app-height', '100vh');
        document.documentElement.style.overflow = 'hidden';
        document.documentElement.style.backgroundColor = bg;

        Object.assign(document.body.style, {
          margin: '0',
          padding: '0',
          height: '100vh',
          overflow: 'hidden',
          backgroundColor: bg,
        });

        const root = document.getElementById('root');
        if (root) root.style.backgroundColor = bg;

        if (window.electronAPI?.setBgColor) {
          window.electronAPI.setBgColor(bg);
        }
        return;
      }

      hpx = hpx || `${h}px`;

      document.documentElement.style.setProperty('--app-height', hpx);

      Object.assign(document.documentElement.style, {
        height: hpx,
        minHeight: hpx,
        overflow: 'hidden',
        backgroundColor: bg,
      });

      Object.assign(document.body.style, {
        position: 'fixed',
        top: topOffset,
        left: '0',
        right: '0',
        bottom: '0',
        width: '100%',
        height: hpx,
        minHeight: hpx,
        margin: '0',
        padding: '0',
        overflow: 'hidden',
        backgroundColor: bg,
        transform: 'translateZ(0)',
      });

      const root = document.getElementById('root');
      if (root) {
        Object.assign(root.style, {
          position: 'absolute',
          top: '0',
          left: '0',
          right: '0',
          bottom: '0',
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          backgroundColor: bg,
        });
      }

      if (appShellRef.current) {
        Object.assign(appShellRef.current.style, {
          position: 'absolute',
          top: '0',
          left: '0',
          right: '0',
          bottom: '0',
          width: '100%',
          height: '100%',
          minHeight: '0',
          maxHeight: 'none',
          overflow: 'hidden',
          backgroundColor: bg,
        });
      }
    };

    const onResize = () => requestAnimationFrame(applyViewportFix);
    const onVisible = () => {
      if (!document.hidden) {
        setTimeout(applyViewportFix, 50);
        setTimeout(applyViewportFix, 250);
        setTimeout(applyViewportFix, 600);
      }
    };

    applyViewportFix();

    if (!isDesktopElectron()) {
      window.addEventListener('resize', onResize, { passive: true });
      window.addEventListener('orientationchange', onResize, { passive: true });
      window.addEventListener('pageshow', onResize, { passive: true });

      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', onResize, { passive: true });
        window.visualViewport.addEventListener('scroll', onResize, { passive: true });
      }

      document.addEventListener('visibilitychange', onVisible);
    }

    setTimeout(applyViewportFix, 0);
    setTimeout(applyViewportFix, 100);
    setTimeout(applyViewportFix, 400);

    return () => {
      if (!isDesktopElectron()) {
        window.removeEventListener('resize', onResize);
        window.removeEventListener('orientationchange', onResize);
        window.removeEventListener('pageshow', onResize);

        if (window.visualViewport) {
          window.visualViewport.removeEventListener('resize', onResize);
          window.visualViewport.removeEventListener('scroll', onResize);
        }

        document.removeEventListener('visibilitychange', onVisible);
      }
    };
  }, [isDarkMode, flowState]);

  useEffect(() => {
    let wakeLock: any = null;

    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator && flowState === 'APP') {
          // @ts-ignore -- wakeLock typing not yet in current lib.dom
          wakeLock = await navigator.wakeLock.request('screen');
          console.log('[iOS Optimization] Screen Wake Lock acquired.');
        }
      } catch (err) {
        console.warn('[iOS Optimization] Wake Lock failed:', err);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock();
      }
    };

    if (flowState === 'APP') {
      requestWakeLock();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (wakeLock) wakeLock.release();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [flowState]);

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [setIsFullscreen]);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch((err) =>
        console.error(`Error: ${err.message}`),
      );
    } else if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  }, []);

  useEffect(() => {
    if (flowState !== 'APP') return;
    // NOTE: must match `containerBg` in components/app/appShellStyles.ts so the
    // BrowserWindow fill color painted during window resize is indistinguishable
    // from the app's own background.
    const themeColor = isDarkMode ? '#121212' : '#ffffff';
    document.body.style.backgroundColor = themeColor;
    document.documentElement.style.backgroundColor = themeColor;
    let metaThemeColor = document.querySelector("meta[name='theme-color']");
    if (!metaThemeColor) {
      metaThemeColor = document.createElement('meta');
      metaThemeColor.setAttribute('name', 'theme-color');
      document.head.appendChild(metaThemeColor);
    }
    metaThemeColor.setAttribute('content', themeColor);
    // Sync to Electron main: BrowserWindow.backgroundColor covers the "gap" that
    // appears during window resize before Chromium finishes painting.
    try {
      window.electronAPI?.setBgColor?.(themeColor);
    } catch {
      /* non-Electron env */
    }
  }, [isDarkMode, flowState]);

  // Flag `data-resizing` on <html> during window resize so global CSS can
  // freeze expensive effects (backdrop-filter, transitions, animations) and
  // skip reflow+paint on elements tagged `data-resize-heavy`. Released 200ms
  // after the last resize tick.
  useEffect(() => {
    let timer: number | null = null;
    const onResize = () => {
      document.documentElement.setAttribute('data-resizing', '');
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        document.documentElement.removeAttribute('data-resizing');
        timer = null;
      }, 200);
    };
    window.addEventListener('resize', onResize, { passive: true });
    return () => {
      window.removeEventListener('resize', onResize);
      if (timer !== null) window.clearTimeout(timer);
      document.documentElement.removeAttribute('data-resizing');
    };
  }, []);

  return { appShellRef, isIOS, toggleFullscreen };
};
