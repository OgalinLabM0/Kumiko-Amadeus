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
    // Phase 7 regression fix (iOS PWA env() cold-start regression): probe
    // the browser's resolved env(safe-area-inset-*) value via a physical
    // hidden DOM element. Reading these from CSS custom properties / JS
    // directly is unreliable (WebKit bugs #274773 / #191872 return stale or
    // zero values). `offsetHeight` on an element sized with `env(...)`
    // forces a synchronous layout and gives us the real computed px.
    // Reference: fozzedout/iphone-pwa-game-guide.md §3 "Cold-Start Probing".
    const measureEnvInset = (
      prop:
        | 'safe-area-inset-top'
        | 'safe-area-inset-right'
        | 'safe-area-inset-bottom'
        | 'safe-area-inset-left',
    ): number => {
      const el = document.createElement('div');
      el.style.cssText =
        `position:fixed;top:0;left:0;width:0;` +
        `height:env(${prop}, 0px);visibility:hidden;pointer-events:none;z-index:-1`;
      document.body.appendChild(el);
      const val = el.offsetHeight;
      el.remove();
      return val;
    };

    // Guard so the viewport-fit=auto<->cover toggle only runs once per
    // effect lifetime. Without this, the recursive `applyViewportFix()`
    // call from inside the rAF branch would flip the meta tag forever on
    // devices where env() legitimately stays at 0 (e.g. iPhone SE without
    // a notch, where `safe-area-inset-*` really is 0px).
    let vpFitToggleAttempted = false;

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

      // Phase 7 fix: safe-area-top is now handled by each component (AppChatHeader,
      // DiaryPanel, TaskPanel, MessageCenterPanel, etc. all add their own
      // `paddingTop / top: env(safe-area-inset-top)`). Previously we also shifted
      // the <body> down by safe-top on iOS standalone, which caused a double-inset
      // visible as (a) extra blank strip above the chat header and (b) the
      // .ka-settings-shell `height: 100dvh` overflowing its `100dvh - safe-top`
      // backdrop and getting its bottom clipped. Keep body flush at (0,0) and let
      // the component layer place its own safe-area padding.
      const topOffset = '0';

      // Phase 7 regression fix (iOS PWA viewport collapse, 2026-04): DO NOT
      // use `100dvh` here. iOS PWA standalone mode has a well-documented
      // cold-start bug where 100dvh returns stale values until the viewport
      // is "exercised" (rotation). JS-measured `window.innerHeight` in px is
      // stable from first paint. In PWA standalone, 100vh == 100dvh ==
      // window.innerHeight once the viewport has settled, so nothing is lost
      // by sticking to px -- and we dodge the cold-start bug entirely.
      // Reference: fozzedout/iphone-pwa-game-guide.md §2 "Height Declaration Trap".
      const hpx = `${h}px`;
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

      // Phase 7 regression fix: probe env(safe-area-inset-*) and push the
      // resolved px values to --sat/--sar/--sab/--sal on :root. All
      // consumers (index.html safe-area-padding-* helpers, .ka-mobile-
      // fullbleed-sheet, DiaryPanel / TaskPanel / MessageCenterPanel /
      // AppChatHeader / AppChatFooter / 6 AppModals / DiaryBackfillDialog
      // / CustomDialog / SystemToast / VoiceCallOverlay / AIConfigScreen
      // / AuthScreen / IntroScreen / MobilePairingChrome) read these vars
      // instead of env() directly, so this one write fixes the entire app
      // simultaneously. The CSS default for these vars is env(...) so if
      // this probe is slow/blocked, panels still render with env() values.
      const sat = measureEnvInset('safe-area-inset-top');
      const sar = measureEnvInset('safe-area-inset-right');
      const sab = measureEnvInset('safe-area-inset-bottom');
      const sal = measureEnvInset('safe-area-inset-left');

      if (sat > 0 || sab > 0 || sar > 0 || sal > 0) {
        document.documentElement.style.setProperty('--sat', `${sat}px`);
        document.documentElement.style.setProperty('--sar', `${sar}px`);
        document.documentElement.style.setProperty('--sab', `${sab}px`);
        document.documentElement.style.setProperty('--sal', `${sal}px`);
      } else if (isStandalone && !vpFitToggleAttempted) {
        // iOS 26.1 PWA cold-start regression: env() resolves to 0 until
        // the viewport is "exercised". Briefly flip viewport-fit from
        // cover to auto and back, which forces WebKit to recalculate
        // env() without requiring physical device rotation. Then reprobe
        // on the next frame. Guarded by vpFitToggleAttempted so notch-
        // less devices (where env() really is 0) don't loop forever.
        vpFitToggleAttempted = true;
        const meta = document.querySelector('meta[name="viewport"]') as HTMLMetaElement | null;
        if (meta) {
          const original = meta.getAttribute('content') || '';
          if (original.includes('viewport-fit=cover')) {
            meta.setAttribute(
              'content',
              original.replace('viewport-fit=cover', 'viewport-fit=auto'),
            );
            requestAnimationFrame(() => {
              meta.setAttribute('content', original);
              requestAnimationFrame(() => applyViewportFix());
            });
          }
        }
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
    // Phase 7 regression fix: extra late probe to catch iOS PWA cold-start
    // cases where env() populates only after ~1s (WebKit bug #191872).
    setTimeout(applyViewportFix, 1500);

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
