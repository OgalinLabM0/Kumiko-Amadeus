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
 * Phase 7 regression fix (iOS PWA env() cold-start regression): probe
 * the browser's resolved env(safe-area-inset-*) value via a physical
 * hidden DOM element. Reading these from CSS custom properties / JS
 * directly is unreliable (WebKit bugs #274773 / #191872 return stale or
 * zero values). `offsetHeight` on an element sized with `env(...)`
 * forces a synchronous layout and gives us the real computed px.
 * Reference: fozzedout/iphone-pwa-game-guide.md §3 "Cold-Start Probing".
 */
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

const isEditableElement = (el: EventTarget | null): boolean => {
  const node = el as HTMLElement | null;
  if (!node || !node.tagName) return false;
  const tag = node.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  return !!node.isContentEditable;
};

export interface UseViewportSyncInput {
  /** 背景色：会写到 html / body / #root / appShell 的 backgroundColor。
   *  PairingGate 阶段传配对页米色 `#f9f7f2`，APP 阶段传主题色（白 / 棕黑）。 */
  bg: string;
  /** 可选 ref：APP 阶段传 appShellRef 让外层壳尺寸跟随；
   *  PairingGate 阶段不传，因为壳还没挂。 */
  appShellRef?: RefObject<HTMLDivElement | null>;
  /** 关闭整 hook 时传 false（用于配对完成后让 App 内的 useAppViewport
   *  接管，避免两个 hook 互相覆盖 listener / styles）。默认 true。 */
  enabled?: boolean;
}

/**
 * 纯 DOM viewport 同步逻辑：visualViewport 高度 → html/body 尺寸 +
 * `--app-vh` / `--app-height` CSS 变量；safe-area-inset-* 探测 →
 * `--sat / --sar / --sab / --sal`；body fixed 锁定避免 iOS 反弹。
 *
 * **关键修正（vs Phase 7 历史代码）**：iOS WKWebView 在键盘弹起时
 * `window.innerHeight` / `documentElement.clientHeight` 都不缩，只有
 * `visualViewport.height` 是真值。原代码 `Math.max(innerHeight, vv.height)`
 * 会取大值（全屏）→ body fixed 被推出可视区域露白条 / 露 iOS 灰背景。
 * 这里改为以 `visualViewport.height` 为权威值。
 *
 * **键盘信号双源**：visualViewport.resize 在 iOS Capacitor WebView 上
 * 的触发时机不一致；@capacitor/keyboard 的 `keyboardWillShow` /
 * `keyboardWillHide` 是 native 层 hook，比 visualViewport 更早触发也更稳定。
 * 双源都注册为补充信号，失败（非 Capacitor 环境）时静默降级。
 */
export const useViewportSync = ({
  bg,
  appShellRef,
  enabled = true,
}: UseViewportSyncInput): void => {
  useLayoutEffect(() => {
    if (!enabled) return;

    // Guard so the viewport-fit=auto<->cover toggle only runs once per
    // effect lifetime. Without this, the recursive `applyViewportFix()`
    // call from inside the rAF branch would flip the meta tag forever on
    // devices where env() legitimately stays at 0 (e.g. iPhone SE without
    // a notch, where `safe-area-inset-*` really is 0px).
    let vpFitToggleAttempted = false;

    const applyViewportFix = () => {
      const isStandalone =
        (window.navigator as any).standalone === true ||
        window.matchMedia('(display-mode: standalone)').matches;

      if (isDesktopElectron()) {
        // Electron 桌面端窗口尺寸由 chrome 管，键盘永不缩 webview，直接 100vh。
        document.documentElement.style.setProperty('--app-height', '100vh');
        document.documentElement.style.setProperty('--app-vh', '100vh');
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

      // 手机端：恢复 v115 的极简模型。
      //
      // 上一轮我们在每次 visualViewport 事件里把 body 改成
      //   `position: fixed; top: ${vv.offsetTop}px; height: ${vv.height}px`
      // 想跟 iOS 键盘联动；结果反过来制造了「键盘弹起后 app 被锁在键盘
      // 上方那块、收键盘后回不来」的问题。v115 / 老 PWA 没做这件事，靠
      // CSS 100vh + overflow:hidden + iOS Safari 自带「聚焦 input 时
      // 自动滚进可视区」就足够了。
      //
      // 这里只写：
      //   1) `--app-height / --app-vh` 设静态 100vh，与 index.html 默认值一致；
      //   2) 各元素的 backgroundColor，保持主题切换正常；
      // 不再碰 html / body 的 height、position、top、overflow 等会卡住
      // iOS 键盘自然回弹的属性。
      document.documentElement.style.setProperty('--app-height', '100vh');
      document.documentElement.style.setProperty('--app-vh', '100vh');
      document.documentElement.style.backgroundColor = bg;
      document.body.style.backgroundColor = bg;

      const root = document.getElementById('root');
      if (root) root.style.backgroundColor = bg;

      if (appShellRef?.current) {
        appShellRef.current.style.backgroundColor = bg;
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

    // 仅作为 safe-area 重新探测触发器。`window.resize` /
    // `orientationchange` / `pageshow` / `visibilitychange` 是横竖屏 / 回前台
    // 等真正会改变 safe-area 与窗口尺寸的事件；它们触发 `applyViewportFix`
    // 重新探测 env() 是合理的。
    //
    // **不**在这里听 `visualViewport.resize` / `scroll`：上一轮把它们接到
    // `applyViewportFix` 上是为了「按键盘缩 body 高度」，结果反过来制造
    // 「键盘把 app 顶起来下不来」的 bug。键盘弹起的高度补偿现在改走
    // 下面那条独立的 `--kb-inset` 通道，单向写一个 CSS 变量给聊天列消费。
    const onResize = () => requestAnimationFrame(applyViewportFix);
    const onVisible = () => {
      if (!document.hidden) {
        setTimeout(applyViewportFix, 50);
        setTimeout(applyViewportFix, 250);
        setTimeout(applyViewportFix, 600);
      }
    };

    // --kb-inset：键盘遮挡的高度（px）。仅作为单向 CSS 变量供
    // `AppMainView` 聊天列读取做 `padding-bottom`，让消息列表被键盘
    // 动态挤短、输入框贴在键盘上沿；头部与立绘背景不动。
    //
    // 之所以这里安全、不会重蹈上一轮的覆辙：
    //   - **完全不动 `<body>` / `<html>`** 的 position / top / height；
    //   - 只写一个 `:root` 变量，零 React 状态、零 layout thrash；
    //   - 即使读到异常值（vv 缺失 / 负数 / NaN），`Math.max(0, ...)` 兜底为 0，
    //     最坏后果是聊天列底部留白不准，刷新一下就回 0，**不会卡住整个 app**。
    //
    // 同时听 `resize` 与 `scroll`：iOS Safari 在收键盘的瞬间会先发
    // `scroll`（vv.offsetTop 归零）再发 `resize`（vv.height 回弹），
    // 双源都接才能在键盘动画结束前后都拿到正确值。
    //
    // **focus 估算窗口**：iOS Safari 决定要不要上滑 visual viewport 的
    // 时机在 `focus` 那一帧，比 visualViewport.resize 早一拍。我们在
    // `focusin` 同步写入估算键盘高度（estimateKeyboardHeight），让
    // AppMainView 聊天列瞬间就有 padding-bottom，footer 已在估算键盘
    // 上方 → Safari 检查 input 是否被挡时看到「不被挡」，跳过偏移。
    // 之后 visualViewport.resize 报真实键盘高度，再覆盖估算值。
    // `focusEstimateActive` 是闭包级 let，避免多个 hook 实例互相污染。
    let focusEstimateActive = false;
    let focusEstimateTimer: number | null = null;

    const estimateKeyboardHeight = (): number => {
      const w = window.innerWidth || 0;
      const h = window.innerHeight || 0;
      const isPad = Math.min(w, h) >= 600;
      const isLandscape = w > h;
      // iPhone 竖屏中文键盘（含候选栏）≈ 320px；横屏 ≈ 220px；iPad ≈ 320px。
      // 估算只是为了让 Safari 在 focus 决策那一帧看到 footer 已在键盘
      // 上方，几十像素的偏差不会让人察觉，由 visualViewport.resize 后接管。
      if (isPad) return 320;
      return isLandscape ? 220 : 320;
    };

    const updateKeyboardInset = () => {
      const vv = window.visualViewport;
      if (!vv) {
        if (!focusEstimateActive) {
          document.documentElement.style.setProperty('--kb-inset', '0px');
        }
        return;
      }
      const innerH = window.innerHeight || 0;
      const kb = Math.max(0, Math.round(innerH - vv.height));
      // 键盘已经真的弹起（vv 缩了）时，用真实值；估算窗口期内 vv 还
      // 没缩（kb===0），不要把估算冲成 0 —— 那样会让 Safari 在 focus
      // 那一帧又看到 input 被挡，重新触发 visual viewport 偏移。
      if (kb > 0 || !focusEstimateActive) {
        document.documentElement.style.setProperty('--kb-inset', `${kb}px`);
      }
    };

    const handleFocusIn = (e: FocusEvent) => {
      if (!isEditableElement(e.target)) return;
      focusEstimateActive = true;
      document.documentElement.style.setProperty(
        '--kb-inset',
        `${estimateKeyboardHeight()}px`,
      );
      if (focusEstimateTimer !== null) {
        clearTimeout(focusEstimateTimer);
      }
      // 600ms 后认为键盘动画已结束（典型 iOS 键盘动画 ~250ms，留余量），
      // 之后把控制权交还给 visualViewport.resize 的真实测量。
      focusEstimateTimer = window.setTimeout(() => {
        focusEstimateActive = false;
        focusEstimateTimer = null;
        updateKeyboardInset();
      }, 600);
    };

    const handleFocusOut = () => {
      // 等下一拍看新的 activeElement 是不是又跳到另一个输入框
      // （Safari 切换 INPUT 时会先 focusout 再 focusin）。如果还是
      // editable，保留估算窗口；否则归零让 footer 自然落回底部。
      setTimeout(() => {
        if (isEditableElement(document.activeElement)) return;
        focusEstimateActive = false;
        if (focusEstimateTimer !== null) {
          clearTimeout(focusEstimateTimer);
          focusEstimateTimer = null;
        }
        document.documentElement.style.setProperty('--kb-inset', '0px');
      }, 0);
    };

    applyViewportFix();
    updateKeyboardInset();

    if (!isDesktopElectron()) {
      window.addEventListener('resize', onResize, { passive: true });
      window.addEventListener('orientationchange', onResize, { passive: true });
      window.addEventListener('pageshow', onResize, { passive: true });
      document.addEventListener('visibilitychange', onVisible);

      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', updateKeyboardInset, { passive: true });
        window.visualViewport.addEventListener('scroll', updateKeyboardInset, { passive: true });
      }

      document.addEventListener('focusin', handleFocusIn, { passive: true });
      document.addEventListener('focusout', handleFocusOut, { passive: true });
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
        document.removeEventListener('visibilitychange', onVisible);

        if (window.visualViewport) {
          window.visualViewport.removeEventListener('resize', updateKeyboardInset);
          window.visualViewport.removeEventListener('scroll', updateKeyboardInset);
        }

        document.removeEventListener('focusin', handleFocusIn);
        document.removeEventListener('focusout', handleFocusOut);
        if (focusEstimateTimer !== null) {
          clearTimeout(focusEstimateTimer);
          focusEstimateTimer = null;
        }
      }
    };
  }, [bg, appShellRef, enabled]);
};

/**
 * Encapsulates every DOM / viewport / theme side-effect that App.tsx used to
 * own inline. The contract is intentionally identical to the pre-extraction
 * behaviour so the refactor is observationally a no-op:
 *
 *   - iOS PWA `focusout` keyboard dismissal recovery
 *   - iOS + Electron viewport height / safe-area / background sync (delegated
 *     to `useViewportSync`, runs at layout phase so `appShellRef` can be
 *     styled before paint)
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
    // iOS Safari PWA keyboard recovery only. On desktop / Android this used to
    // fire on every blur (including settings buttons), which then dispatched a
    // synthetic `resize` event. That synthetic resize triggered the global
    // `data-resizing` freeze (transition-duration: 0s + content-visibility:
    // hidden on heavy subtrees), which on Windows manifested as a visible
    // flash on every settings click and a portrait jump when the panel closed.
    // Restrict the recovery to iOS where it is actually needed; remeasuring
    // the viewport on real keyboard show/hide is already handled by the
    // visualViewport `resize` + `@capacitor/keyboard keyboardWillHide`
    // listeners inside `useViewportSync`.
    if (!isIOS) return;

    const handleFocusOut = () => {
      setTimeout(() => {
        if (
          !document.activeElement ||
          (document.activeElement.tagName !== 'INPUT' &&
            document.activeElement.tagName !== 'TEXTAREA')
        ) {
          const resetScroll = () => {
            try { window.scrollTo(0, 0); } catch { /* ignore */ }
            try { document.documentElement.scrollTop = 0; } catch { /* ignore */ }
            try { document.body.scrollTop = 0; } catch { /* ignore */ }
          };
          resetScroll();
          requestAnimationFrame(resetScroll);
          setTimeout(resetScroll, 120);
          setTimeout(resetScroll, 320);
        }
      }, 60);
    };

    window.addEventListener('focusout', handleFocusOut);

    return () => {
      window.removeEventListener('focusout', handleFocusOut);
    };
  }, [isIOS]);

  // bg follows flowState + theme: APP 阶段为主题色，其它（INTRO / AUTH / CONFIG）
  // 为配对 / splash 米色 #f9f7f2，与 MobilePairingChrome / index.html splash 同色。
  const bg = useMemo(() => {
    return flowState === 'APP' ? (isDarkMode ? '#1b140d' : '#ffffff') : '#f9f7f2';
  }, [flowState, isDarkMode]);

  useViewportSync({ bg, appShellRef });

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
    // Keep the <html> ka-dark class in sync across every flow state so global
    // CSS (e.g. the :-webkit-autofill overrides in index.html, AIConfigScreen's
    // html.ka-dark selectors) can react to dark mode even before the user
    // reaches the main APP flow.
    document.documentElement.classList.toggle('ka-dark', isDarkMode);
    if (flowState !== 'APP') return;
    // NOTE: must match `containerBg` in components/app/appShellStyles.ts so the
    // BrowserWindow fill color painted during window resize is indistinguishable
    // from the app's own background.
    const themeColor = isDarkMode ? '#1b140d' : '#ffffff';
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
      // Android WebView emits window.resize while the IME opens/closes. While an
      // input is focused, skip the heavy-subtree freeze so Settings panels stay
      // mounted and the keyboard does not immediately collapse.
      if (!isDesktopElectron() && isEditableElement(document.activeElement)) return;

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
