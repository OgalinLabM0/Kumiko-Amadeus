// components/settings/MobileBrowseRootSection.tsx
//
// Phase 6 Part C: desktop-only Settings section for configuring the root
// directory the mobile remote file browser is allowed to traverse.
//
// Default: parent of app.getPath('userData'), with automatic fallback to
// userData itself when the parent is a broad public OS directory (Windows
// AppData\Roaming, Linux ~/.config, mac ~/Library/Application Support).
// Users can override via the "更改..." button which opens Electron's
// native folder picker through `fs:pick-mobile-browse-root`. The override
// is persisted to kumiko-config.json (main-process user-config.cjs) and
// shared across restarts.
//
// Why desktop-only: the corresponding `fs:set-mobile-browse-root` channel
// is intentionally NOT in the mobile HTTP allowlist (see
// electron/server/ipc-bridge.cjs). A phone cannot widen its own sandbox
// remotely — only a human at the PC can change the root.

import React, { useCallback, useEffect, useState } from 'react';
import { FolderCog, ChevronDown, ChevronUp, FolderOpen, RefreshCw, ShieldCheck, AlertTriangle } from 'lucide-react';
import { Language } from '../../types';
import { Collapse } from '../Collapse';

interface MobileBrowseRootSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  language: Language;
  sectionBorder: string;
  innerCardClass: string;
}

interface RootState {
  root: string | null;
  defaultRoot: string | null;
  isOverride: boolean;
  userData: string | null;
  appDir: string | null;
  loading: boolean;
  error: string | null;
}

const TEXT = {
  zh: {
    title: '手机浏览根目录',
    desc: '限定手机远程文件浏览器可以访问的 PC 目录范围。',
    currentLabel: '当前根目录',
    defaultLabel: '默认根目录',
    defaultSource: '（软件数据目录的上一级文件夹 / 不安全时回退到软件数据目录）',
    overrideBadge: '已手动覆盖',
    defaultBadge: '默认值',
    change: '更改...',
    reset: '恢复默认',
    hint: '手机只能在这个目录和它的子目录中读取/写入文件。超出范围的请求会被 PC 主进程直接拒绝（E_OUT_OF_ROOT）。',
    safety: '本设置仅可在桌面端修改。手机 PWA 无权调用 fs:set-mobile-browse-root。',
    loadFailed: '读取失败：',
    pickFailed: '选择目录失败：',
    resetConfirm: '已恢复默认根目录。',
  },
  en: {
    title: 'Mobile Browse Root',
    desc: 'Limit which PC directories the mobile remote file browser can reach.',
    currentLabel: 'Current root',
    defaultLabel: 'Default root',
    defaultSource: '(Parent of user data dir / falls back to user data dir when parent is unsafe)',
    overrideBadge: 'Manually overridden',
    defaultBadge: 'Default',
    change: 'Change...',
    reset: 'Reset to default',
    hint: 'Phones can only read/write files inside this directory (and its subdirectories). Anything outside is rejected server-side (E_OUT_OF_ROOT).',
    safety: 'This setting is desktop-only. Mobile PWAs are NOT allowed to call fs:set-mobile-browse-root.',
    loadFailed: 'Failed to load: ',
    pickFailed: 'Pick failed: ',
    resetConfirm: 'Reset to default root.',
  },
};

export const MobileBrowseRootSection: React.FC<MobileBrowseRootSectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  language,
  sectionBorder,
  innerCardClass,
}) => {
  const t = TEXT[language] || TEXT.zh;
  const [state, setState] = useState<RootState>({
    root: null,
    defaultRoot: null,
    isOverride: false,
    userData: null,
    appDir: null,
    loading: true,
    error: null,
  });

  const refresh = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await window.electronAPI?.invoke('fs:get-mobile-browse-root');
      if (res && typeof res === 'object' && (res as { ok?: boolean }).ok) {
        const r = res as {
          root: string;
          defaultRoot: string;
          isOverride: boolean;
          userData: string;
          appDir: string;
        };
        setState({
          root: r.root,
          defaultRoot: r.defaultRoot,
          isOverride: r.isOverride,
          userData: r.userData,
          appDir: r.appDir,
          loading: false,
          error: null,
        });
      } else {
        setState((s) => ({ ...s, loading: false, error: (res as { error?: string })?.error || 'unknown' }));
      }
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, []);

  useEffect(() => {
    if (isOpen) void refresh();
  }, [isOpen, refresh]);

  const handlePick = useCallback(async () => {
    try {
      const res = await window.electronAPI?.invoke('fs:pick-mobile-browse-root');
      if (res && typeof res === 'object') {
        const r = res as { ok?: boolean; canceled?: boolean; error?: string };
        if (r.canceled) return;
        if (!r.ok) {
          setState((s) => ({ ...s, error: t.pickFailed + (r.error || '') }));
          return;
        }
      }
      await refresh();
    } catch (e) {
      setState((s) => ({ ...s, error: t.pickFailed + (e as Error).message }));
    }
  }, [refresh, t]);

  const handleReset = useCallback(async () => {
    try {
      await window.electronAPI?.invoke('fs:set-mobile-browse-root', { path: null });
      await refresh();
    } catch (e) {
      setState((s) => ({ ...s, error: (e as Error).message }));
    }
  }, [refresh]);

  return (
    <div className={`flex flex-col rounded-[1.2rem] border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between px-4 py-[1.05rem] w-full">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-2xl border ${isDarkMode ? 'border-teal-500/20 bg-teal-900/20 text-teal-300' : 'border-teal-200 bg-teal-50/90 text-teal-700'}`}>
            <FolderCog size={18} />
          </div>
          <div className="text-left">
            <h3 className={`ka-section-title ${isDarkMode ? 'text-[#f5ebdc]' : 'text-[#49301f]'}`}>{t.title}</h3>
            {!isOpen && <p className={`ka-section-desc ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{t.desc}</p>}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} /> : <ChevronDown size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />}
      </button>

      <Collapse isOpen={isOpen}>
        <div className="px-4 pb-4 pt-0 flex flex-col gap-3 overflow-visible">
          <div className={innerCardClass}>
            <p className={`ka-copy-sm mb-3 ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{t.desc}</p>

            <div className="flex items-center justify-between mb-1">
              <span className={`ka-setting-item-title flex items-center gap-2 ${isDarkMode ? 'text-teal-400' : 'text-teal-700'}`}>
                <ShieldCheck size={13} /> {t.currentLabel}
              </span>
              <span className={`ka-micro px-2 py-0.5 rounded-full ${state.isOverride ? (isDarkMode ? 'bg-teal-500/20 text-teal-300' : 'bg-teal-50 text-teal-700') : (isDarkMode ? 'bg-[#3e3429] text-[#c8b49d]' : 'bg-[#efe3d0] text-[#8f7458]')}`}>
                {state.isOverride ? t.overrideBadge : t.defaultBadge}
              </span>
            </div>
            <p className={`break-all font-mono text-[12px] leading-relaxed px-3 py-2 rounded ${isDarkMode ? 'bg-black/30 text-[#e7d9c4]' : 'bg-[#f8eedd] text-[#5a3a1f]'}`}>
              {state.loading ? '…' : (state.root || '?')}
            </p>

            <div className="flex items-center justify-between mt-3 mb-1">
              <span className={`ka-setting-item-title ${isDarkMode ? 'text-[#d9c1a4]' : 'text-[#8b6a47]'}`}>{t.defaultLabel}</span>
            </div>
            <p className={`break-all font-mono text-[11px] leading-relaxed px-3 py-2 rounded opacity-80 ${isDarkMode ? 'bg-black/20 text-[#d9c1a4]' : 'bg-[#faf1e2] text-[#866a4b]'}`}>
              {state.loading ? '…' : (state.defaultRoot || '?')}
            </p>
            <p className={`ka-micro mt-1 ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{t.defaultSource}</p>

            <div className="flex gap-2 mt-3">
              <button
                onClick={handlePick}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg ka-copy-sm font-semibold border transition-colors ${isDarkMode ? 'border-teal-500/40 text-teal-300 hover:bg-teal-500/10' : 'border-teal-500/40 text-teal-700 hover:bg-teal-50'}`}
              >
                <FolderOpen size={14} /> {t.change}
              </button>
              <button
                onClick={handleReset}
                disabled={!state.isOverride || state.loading}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg ka-copy-sm font-semibold border transition-colors ${state.isOverride && !state.loading ? (isDarkMode ? 'border-[#5e4b34] text-[#d9c1a4] hover:bg-white/5' : 'border-[#a6876a] text-[#6a4c30] hover:bg-[#f2e3cf]') : 'border-[#999]/30 text-[#999] cursor-not-allowed'}`}
              >
                <RefreshCw size={14} /> {t.reset}
              </button>
            </div>

            {state.error && (
              <div className={`mt-3 flex items-start gap-2 px-3 py-2 rounded border ${isDarkMode ? 'border-red-500/30 bg-red-500/10 text-red-200' : 'border-red-500/40 bg-red-50 text-red-700'}`}>
                <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                <span className="ka-copy-sm break-all">{state.error}</span>
              </div>
            )}

            <p className={`ka-micro mt-3 leading-relaxed ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>
              {t.hint}
            </p>
            <p className={`ka-micro mt-1 leading-relaxed opacity-80 ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>
              {t.safety}
            </p>
          </div>
        </div>
      </Collapse>
    </div>
  );
};
