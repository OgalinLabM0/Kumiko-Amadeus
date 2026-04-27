import React from 'react';
import { BellRing, BrainCircuit, CheckSquare, Clock3, Maximize, Minimize, Moon, Settings, Sun, Trash2, User, BookOpen } from 'lucide-react';
import { ExtendedSyncStatus, RagStatusIndicator, SyncStatusIndicator } from '../SyncStatus';
import { useAppStore } from '../../store';
import { isMobileLikeRuntime } from '../../services/environment';

// Mobile perf: cache the mobile-runtime flag at module load so hot paths
// (ResizeObserver callbacks, per-frame rAF loops) don't re-probe the
// runtime on every invocation. Desktop Electron and web fallback both
// resolve to `false` here, so their behaviour is unchanged.
// A.3: cache resolves to true for any mobile-like runtime (PWA +
// Capacitor APK), so Capacitor users see the same touch-friendly
// header tweaks as PWA users regardless of pairing state.
let _chatHeaderIsMobile: boolean | null = null;
const chatHeaderIsMobile = (): boolean => {
  if (_chatHeaderIsMobile === null) {
    try { _chatHeaderIsMobile = isMobileLikeRuntime(); } catch { _chatHeaderIsMobile = false; }
  }
  return _chatHeaderIsMobile;
};

interface AppChatHeaderProps {
  ragStatus: 'IDLE' | 'RECALLING' | 'INDEXING' | 'ERROR' | 'OFF' | 'STALE';
  syncStatus: ExtendedSyncStatus;
  headerBg: string;
  headerShadow: string;
  textColor: string;
  mutedTextColor: string;
  isCloudEnabled: boolean;
  isLocalEnabled: boolean;
  onToggleFullscreen: () => void;
  onToggleSelectionMode: () => void;
  onToggleTheme: (e?: React.MouseEvent) => void;
  onSyncClick: () => void;
}

export const AppChatHeader: React.FC<AppChatHeaderProps> = ({
  ragStatus,
  syncStatus,
  headerBg,
  headerShadow,
  textColor,
  mutedTextColor,
  isCloudEnabled,
  isLocalEnabled,
  onToggleFullscreen,
  onToggleSelectionMode,
  onToggleTheme,
  onSyncClick
}) => {
  const isDarkMode = useAppStore(s => s.isDarkMode);
  const isTalking = useAppStore(s => s.isTalking);
  const language = useAppStore(s => s.language);
  const isFullscreen = useAppStore(s => s.isFullscreen);
  const isSelectionMode = useAppStore(s => s.isSelectionMode);
  const isMessageCenterOpen = useAppStore(s => s.isMessageCenterOpen);
  const isTaskPanelOpen = useAppStore(s => s.isTaskPanelOpen);
  const setIsMemoryPanelOpen = useAppStore(s => s.setIsMemoryPanelOpen);
  const setIsDiaryOpen = useAppStore(s => s.setIsDiaryOpen);
  const setIsProfileOpen = useAppStore(s => s.setIsProfileOpen);
  const setIsSettingsOpen = useAppStore(s => s.setIsSettingsOpen);
  const setIsMessageCenterOpen = useAppStore(s => s.setIsMessageCenterOpen);
  const setIsTaskPanelOpen = useAppStore(s => s.setIsTaskPanelOpen);
  const messageAlerts = useAppStore(s => s.messageAlerts);
  const relativeReminders = useAppStore(s => s.relativeReminders);
  const dailyReminders = useAppStore(s => s.dailyReminders);

  const unreadMessageCount = React.useMemo(() => messageAlerts.filter(a => !a.isRead).length, [messageAlerts]);
  const activeTaskCount = relativeReminders.length + dailyReminders.length;
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const identityRef = React.useRef<HTMLDivElement | null>(null);
  const controlsRef = React.useRef<HTMLDivElement | null>(null);
  const [headerScale, setHeaderScale] = React.useState(1);
  const fullName = language === 'zh' ? '黄前 久美子' : 'OUMAE KUMIKO';

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    const identity = identityRef.current;
    const controls = controlsRef.current;
    if (!container || !identity || !controls || typeof ResizeObserver === 'undefined') return;

    const updateScale = () => {
      const availableWidth = container.clientWidth;
      const requiredWidth = identity.scrollWidth + controls.scrollWidth + 18;
      if (availableWidth <= 0 || requiredWidth <= 0) {
        setHeaderScale(1);
        return;
      }

      const nextScale = Math.max(0.58, Math.min(1, availableWidth / requiredWidth));
      setHeaderScale(prev => Math.abs(prev - nextScale) < 0.005 ? prev : nextScale);
    };

    // Mobile perf: debounce ResizeObserver with an extra 120ms trailing
    // delay on top of the rAF batching. Phones fire resize events for
    // every keystroke (virtual keyboard anims) and every orientation
    // nudge, and the scale recompute touches layout (scrollWidth), which
    // is a double-reflow we don't need to run at 60fps. Desktop keeps
    // the rAF-only path.
    const isMobile = chatHeaderIsMobile();
    let rafId = 0;
    let trailingTimer: number | undefined;
    const schedule = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (document.documentElement.hasAttribute('data-resizing')) return;
        updateScale();
      });
    };
    const resizeObserver = new ResizeObserver(() => {
      if (isMobile) {
        if (trailingTimer !== undefined) window.clearTimeout(trailingTimer);
        trailingTimer = window.setTimeout(() => {
          trailingTimer = undefined;
          schedule();
        }, 120);
      } else {
        schedule();
      }
    });
    resizeObserver.observe(container);
    resizeObserver.observe(identity);
    resizeObserver.observe(controls);
    updateScale();

    return () => {
      cancelAnimationFrame(rafId);
      if (trailingTimer !== undefined) window.clearTimeout(trailingTimer);
      resizeObserver.disconnect();
    };
  }, [
    activeTaskCount,
    isDarkMode,
    isFullscreen,
    isSelectionMode,
    isTalking,
    isCloudEnabled,
    isLocalEnabled,
    language,
    ragStatus,
    syncStatus,
    unreadMessageCount
  ]);

  return (
    <div
      className={`overflow-hidden border-b px-3 md:px-4 transition-colors duration-200 md:duration-500 ${headerBg} ${headerShadow}`}
      style={{
        // Phase 7 Part t6_main_shell: push the title row past the device
        // safe-area inset on notched phones. Desktop Electron / wide
        // browsers see env(safe-area-inset-top) === 0 so the original
        // h-16 dimension is preserved byte-for-byte.
        //
        // Mobile-only trim: `max(var(--sat) - 6px, 0px)` shaves 6px off
        // the safe-area inset so the header visually rides a little
        // higher on notched phones while still staying clear of the
        // status bar (typical --sat is ≥ 20–50px, so we keep ≥ 14–44px
        // of clearance). On desktop --sat === 0, max() resolves to 0
        // and the original h-16 layout is preserved exactly.
        height: 'calc(4rem + max(var(--sat) - 6px, 0px))',
        paddingTop: 'max(var(--sat) - 6px, 0px)',
      }}
    >
      <div ref={containerRef} className="flex h-16 w-full items-center justify-center overflow-hidden">
        <div
          className="flex items-center justify-between gap-3"
          style={{
            width: `${100 / headerScale}%`,
            transform: `scale(${headerScale})`,
            transformOrigin: 'center center'
          }}
        >
          <div ref={identityRef} className="flex shrink-0 items-center gap-2.5">
            <div className={`h-2.5 w-2.5 rounded-full shrink-0 ${isTalking ? 'bg-green-500 animate-pulse' : (isDarkMode ? 'bg-yellow-600' : 'bg-[#b8860b]')}`}></div>
            <span
              className={`shrink-0 whitespace-nowrap font-mincho ka-panel-title ${textColor}`}
              title={fullName}
            >
              {fullName}
            </span>
          </div>

          <div ref={controlsRef} className={`flex shrink-0 items-center gap-2 ${mutedTextColor}`}>
            <button onClick={onToggleFullscreen} className="inline-flex hover:text-yellow-500 transition-colors" title={language === 'zh' ? '切换全屏' : 'Toggle Fullscreen'}>
              {isFullscreen ? <Minimize size={17} /> : <Maximize size={17} />}
            </button>
            <button onClick={onToggleSelectionMode} className={`inline-flex hover:text-red-500 transition-colors ${isSelectionMode ? 'text-red-500 animate-pulse' : ''}`} title={language === 'zh' ? '消息管理' : 'Manage Messages'}>
              {isSelectionMode ? <CheckSquare size={17} /> : <Trash2 size={17} />}
            </button>
            <button onClick={() => setIsMemoryPanelOpen(true)} className="inline-flex hover:text-yellow-500 transition-colors" title={language === 'zh' ? '记忆系统' : 'Core Memory Bank'}>
              <BrainCircuit size={17} />
            </button>
            <button onClick={() => setIsDiaryOpen(true)} className="inline-flex hover:text-yellow-500 transition-colors" title={language === 'zh' ? '久美子的日记' : 'Kumiko\'s Diary'}>
              <BookOpen size={17} />
            </button>
            <button onClick={onToggleTheme} className="inline-flex hover:text-yellow-500 transition-colors" title={language === 'zh' ? '切换主题' : 'Toggle Theme'}>
              {isDarkMode ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <button onClick={() => setIsProfileOpen(true)} className="inline-flex hover:text-yellow-500 transition-colors" title={language === 'zh' ? '角色档案' : 'Character Profile'}>
              <User size={17} />
            </button>
            <button onClick={() => { setIsTaskPanelOpen(false); setIsMessageCenterOpen(!isMessageCenterOpen); }} className="relative inline-flex hover:text-yellow-500 transition-colors" title={language === 'zh' ? '消息中心' : 'Message Center'}>
              <BellRing size={17} />
              {unreadMessageCount > 0 && (
                <span className="absolute -top-2 -right-2 min-w-[1rem] h-4 px-1 rounded-full bg-[#c75a1d] ka-micro leading-4 text-white text-center">
                  {unreadMessageCount > 99 ? '99+' : unreadMessageCount}
                </span>
              )}
            </button>
            <button onClick={() => { setIsMessageCenterOpen(false); setIsTaskPanelOpen(!isTaskPanelOpen); }} className="relative inline-flex hover:text-yellow-500 transition-colors" title={language === 'zh' ? '定时任务' : 'Scheduled Tasks'}>
              <Clock3 size={17} />
              {activeTaskCount > 0 && (
                <span className="absolute -top-2 -right-2 min-w-[1rem] h-4 px-1 rounded-full bg-red-500 ka-micro leading-4 text-white text-center">
                  {activeTaskCount > 99 ? '99+' : activeTaskCount}
                </span>
              )}
            </button>

            <RagStatusIndicator status={ragStatus} isDarkMode={isDarkMode} language={language} />

            <SyncStatusIndicator
              status={syncStatus}
              isDarkMode={isDarkMode}
              language={language}
              isCloudEnabled={isCloudEnabled}
              isLocalEnabled={isLocalEnabled}
              onClick={onSyncClick}
            />
            <button onClick={() => setIsSettingsOpen(true)} className="inline-flex hover:text-yellow-500 transition-colors" title={language === 'zh' ? '系统设置' : 'System Settings'}>
              <Settings size={17} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

interface AppSelectionBannerProps {
  isDarkMode: boolean;
  text: string;
  clearLabel: string;
  cancelLabel: string;
  onClear: () => void;
  onCancel: () => void;
}

export const AppSelectionBanner: React.FC<AppSelectionBannerProps> = ({
  isDarkMode,
  text,
  clearLabel,
  cancelLabel,
  onClear,
  onCancel
}) => {
  return (
    <div className={`h-10 flex items-center justify-center px-6 ka-micro font-bold animate-in slide-in-from-top duration-200 ${isDarkMode ? 'bg-red-900/20 text-red-400' : 'bg-red-100 text-red-600'}`}>
      <span>{text}</span>
      <div className="flex gap-4 ml-auto">
        <button onClick={onClear} className="hover:text-red-200 underline">{clearLabel}</button>
        <button onClick={onCancel} className="hover:text-white">{cancelLabel}</button>
      </div>
    </div>
  );
};
