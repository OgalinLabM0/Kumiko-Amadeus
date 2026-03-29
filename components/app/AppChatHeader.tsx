import React from 'react';
import { BellRing, BrainCircuit, CheckSquare, Clock3, Maximize, Minimize, Moon, Settings, Sun, Trash2, User } from 'lucide-react';
import { ExtendedSyncStatus, RagStatusIndicator, SyncStatusIndicator } from '../SyncStatus';
import { Language } from '../../types';

interface AppChatHeaderProps {
  isDarkMode: boolean;
  isTalking: boolean;
  language: Language;
  isFullscreen: boolean;
  isSelectionMode: boolean;
  unreadMessageCount: number;
  activeTaskCount: number;
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
  onOpenMemory: () => void;
  onToggleTheme: () => void;
  onOpenProfile: () => void;
  onOpenInbox: () => void;
  onOpenTasks: () => void;
  onSyncClick: () => void;
  onOpenSettings: () => void;
}

export const AppChatHeader: React.FC<AppChatHeaderProps> = ({
  isDarkMode,
  isTalking,
  language,
  isFullscreen,
  isSelectionMode,
  unreadMessageCount,
  activeTaskCount,
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
  onOpenMemory,
  onToggleTheme,
  onOpenProfile,
  onOpenInbox,
  onOpenTasks,
  onSyncClick,
  onOpenSettings
}) => {
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

      const nextScale = Math.max(0.72, Math.min(1, availableWidth / requiredWidth));
      setHeaderScale(prev => Math.abs(prev - nextScale) < 0.005 ? prev : nextScale);
    };

    const resizeObserver = new ResizeObserver(updateScale);
    resizeObserver.observe(container);
    resizeObserver.observe(identity);
    resizeObserver.observe(controls);
    updateScale();

    return () => {
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
    <div className={`h-16 overflow-hidden border-b px-3 md:px-4 transition-colors duration-500 ${headerBg} ${headerShadow}`}>
      <div ref={containerRef} className="flex h-full w-full items-center justify-center overflow-hidden">
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
              className={`shrink-0 whitespace-nowrap font-mono text-[15px] font-bold tracking-[0.16em] ${textColor}`}
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
            <button onClick={onOpenMemory} className="inline-flex hover:text-yellow-500 transition-colors" title={language === 'zh' ? '记忆系统' : 'Core Memory Bank'}>
              <BrainCircuit size={17} />
            </button>
            <button onClick={onToggleTheme} className="inline-flex hover:text-yellow-500 transition-colors" title={language === 'zh' ? '切换主题' : 'Toggle Theme'}>
              {isDarkMode ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <button onClick={onOpenProfile} className="inline-flex hover:text-yellow-500 transition-colors" title={language === 'zh' ? '角色档案' : 'Character Profile'}>
              <User size={17} />
            </button>
            <button onClick={onOpenInbox} className="relative inline-flex hover:text-yellow-500 transition-colors" title={language === 'zh' ? '消息中心' : 'Message Center'}>
              <BellRing size={17} />
              {unreadMessageCount > 0 && (
                <span className="absolute -top-2 -right-2 min-w-[1rem] h-4 px-1 rounded-full bg-[#c75a1d] text-[10px] leading-4 text-white font-mono text-center">
                  {unreadMessageCount > 99 ? '99+' : unreadMessageCount}
                </span>
              )}
            </button>
            <button onClick={onOpenTasks} className="relative inline-flex hover:text-yellow-500 transition-colors" title={language === 'zh' ? '定时任务' : 'Scheduled Tasks'}>
              <Clock3 size={17} />
              {activeTaskCount > 0 && (
                <span className="absolute -top-2 -right-2 min-w-[1rem] h-4 px-1 rounded-full bg-red-500 text-[10px] leading-4 text-white font-mono text-center">
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
            <button onClick={onOpenSettings} className="inline-flex hover:text-yellow-500 transition-colors" title={language === 'zh' ? '系统设置' : 'System Settings'}>
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
    <div className={`h-10 flex items-center justify-center px-6 text-xs font-mono font-bold animate-in slide-in-from-top duration-200 ${isDarkMode ? 'bg-red-900/20 text-red-400' : 'bg-red-100 text-red-600'}`}>
      <span>{text}</span>
      <div className="flex gap-4 ml-auto">
        <button onClick={onClear} className="hover:text-red-200 underline">{clearLabel}</button>
        <button onClick={onCancel} className="hover:text-white">{cancelLabel}</button>
      </div>
    </div>
  );
};
