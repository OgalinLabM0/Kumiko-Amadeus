// components/MobileRemoteFileBrowser.tsx
//
// Phase 6 Part C3: a full-screen overlay the mobile PWA opens instead of
// `showOpenFilePicker` / `showSaveFilePicker` (which iOS Safari doesn't
// support). Every listing / read / write here is proxied to the PC via
// `fs:*` and `backup:*-desktop-file` channels implemented in
// electron/mobile-fs.cjs, sandboxed to `mobileBrowseRoot`. The PC user
// does NOT need to interact — the phone drives the entire flow.
//
// Two modes:
//   - 'open'   : pick an existing *.json / *.zip backup file to restore.
//   - 'create' : pick a folder + filename (default `kumiko_backup_<date>.json`)
//                to create a new backup target. An empty file isn't created
//                here; caller does the actual write via performFileSave /
//                `backup:write-desktop-file`.
//
// Persistence:
//   - Last browsed path is remembered per-phone in
//     localStorage['kumiko-mobile-last-browsed-path'] and surfaced as a
//     "最近位置" quick-chip on the next open.
//
// Security:
//   - All requests resolve via `fs:*` which enforce path-traversal
//     protection against `mobileBrowseRoot`. Anything outside is rejected
//     server-side with E_OUT_OF_ROOT and surfaced inline in the UI.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Folder,
  FileJson,
  File as FileIcon,
  ArrowUp,
  RefreshCw,
  Save,
  AlertTriangle,
  Clock,
  HardDrive,
  FolderCog,
  Loader2,
} from 'lucide-react';
import type { Language } from '../types';
import { httpInvoke } from '../services/httpApi';

const LAST_PATH_KEY = 'kumiko-mobile-last-browsed-path';

export type MobileRemoteFileBrowserMode = 'open' | 'create';

export interface MobileRemoteFileBrowserResult {
  filePath: string;
  fileName: string;
  mode: MobileRemoteFileBrowserMode;
}

export interface MobileRemoteFileBrowserProps {
  isOpen: boolean;
  mode: MobileRemoteFileBrowserMode;
  language: Language;
  onClose: () => void;
  onSelect: (result: MobileRemoteFileBrowserResult) => void | Promise<void>;
  /** Default filename used in create mode when the field starts empty.
   *  Defaults to `kumiko_backup_YYYY-MM-DD.json`. */
  defaultFileName?: string;
  /** Optional accepted extensions in open mode. Defaults to json+zip. */
  acceptExtensions?: string[];
  isDarkMode?: boolean;
}

interface Shortcut {
  key: string;
  label: string;
  path: string;
}

interface DirItem {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  mtime: number;
}

interface DirState {
  root: string;
  path: string;
  items: DirItem[];
  parent: string | null;
  atRoot: boolean;
}

const TEXT = {
  zh: {
    titleOpen: '选择 PC 上的备份文件',
    titleCreate: '在 PC 上创建备份文件',
    close: '关闭',
    refresh: '刷新',
    up: '上一级',
    back: '返回',
    empty: '此目录为空',
    loading: '正在读取目录…',
    error: '读取失败：',
    shortcutRoot: '根目录',
    shortcutData: '数据目录',
    shortcutApp: '软件目录',
    shortcutRecent: '最近位置',
    currentPath: '当前目录',
    filenameLabel: '文件名',
    filenamePlaceholder: 'kumiko_backup_YYYY-MM-DD.json',
    saveHere: '保存到此目录',
    confirmOverwrite: (name: string) => `文件 “${name}” 已存在，要覆盖吗？`,
    fileTypesOnly: '只能选择 .json 或 .zip 备份文件',
    filenameRequired: '请填写文件名',
    filenameInvalid: '文件名不能包含以下字符：/ \\ : * ? " < > |',
    hintSandbox: '只能访问 PC 上的受限根目录（手机浏览根目录设置）。',
    hintOpen: '轻触文件即可选中并恢复。',
    hintCreate: '先选中一个目录，再输入文件名保存。',
    filesInFolder: (n: number) => `${n} 个项目`,
  },
  en: {
    titleOpen: 'Select a backup file on PC',
    titleCreate: 'Create a backup file on PC',
    close: 'Close',
    refresh: 'Refresh',
    up: 'Up',
    back: 'Back',
    empty: 'This folder is empty',
    loading: 'Loading…',
    error: 'Failed: ',
    shortcutRoot: 'Root',
    shortcutData: 'Data folder',
    shortcutApp: 'App folder',
    shortcutRecent: 'Recent',
    currentPath: 'Current path',
    filenameLabel: 'File name',
    filenamePlaceholder: 'kumiko_backup_YYYY-MM-DD.json',
    saveHere: 'Save here',
    confirmOverwrite: (name: string) => `"${name}" already exists. Overwrite?`,
    fileTypesOnly: 'Only .json or .zip backup files can be selected',
    filenameRequired: 'File name is required',
    filenameInvalid: 'File name cannot contain: / \\ : * ? " < > |',
    hintSandbox: 'Limited to the sandboxed root (Mobile Browse Root setting).',
    hintOpen: 'Tap a file to select and restore.',
    hintCreate: 'Navigate to a folder, then type a file name and save.',
    filesInFolder: (n: number) => `${n} item${n === 1 ? '' : 's'}`,
  },
};

function defaultBackupFileName(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `kumiko_backup_${yyyy}-${mm}-${dd}.json`;
}

function formatSize(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatMtime(ms: number, language: Language): string {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(language === 'zh' ? 'zh-CN' : undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function filenameLooksAllowed(name: string, accept: string[]): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return accept.some(ext => lower.endsWith(ext));
}

function hasInvalidPathChars(name: string): boolean {
  return /[\\/:*?"<>|]/.test(name);
}

export const MobileRemoteFileBrowser: React.FC<MobileRemoteFileBrowserProps> = ({
  isOpen,
  mode,
  language,
  onClose,
  onSelect,
  defaultFileName,
  acceptExtensions,
  isDarkMode = true,
}) => {
  const t = TEXT[language] || TEXT.zh;
  const accept = useMemo(() => (acceptExtensions && acceptExtensions.length > 0 ? acceptExtensions : ['.json', '.zip']), [acceptExtensions]);

  const [shortcuts, setShortcuts] = useState<Shortcut[]>([]);
  const [recentPath, setRecentPath] = useState<string | null>(null);
  const [dir, setDir] = useState<DirState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filename, setFilename] = useState<string>(defaultFileName || defaultBackupFileName());
  const [busy, setBusy] = useState(false);

  const loadDirectory = useCallback(async (targetPath?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res: any = await httpInvoke('fs:list-directory', { path: targetPath || '' });
      if (res && res.ok) {
        setDir({
          root: res.root,
          path: res.path,
          items: Array.isArray(res.items) ? res.items : [],
          parent: res.parent ?? null,
          atRoot: !!res.atRoot,
        });
        try {
          localStorage.setItem(LAST_PATH_KEY, res.path);
          setRecentPath(res.path);
        } catch {
          // localStorage may be unavailable in private modes
        }
      } else {
        setError(t.error + (res?.error || 'unknown'));
      }
    } catch (e) {
      setError(t.error + (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!isOpen) return;
    setFilename(defaultFileName || defaultBackupFileName());
    setError(null);

    let cancelled = false;
    (async () => {
      try {
        const scRes: any = await httpInvoke('fs:get-shortcuts');
        if (!cancelled && scRes && scRes.ok && Array.isArray(scRes.shortcuts)) {
          setShortcuts(scRes.shortcuts);
        }
      } catch (e) {
        if (!cancelled) setError(t.error + (e as Error).message);
      }

      let startPath = '';
      try {
        const stored = localStorage.getItem(LAST_PATH_KEY);
        if (stored) {
          setRecentPath(stored);
          const existsRes: any = await httpInvoke('fs:check-path-exists', { path: stored });
          if (existsRes && existsRes.ok && existsRes.exists && existsRes.isDirectory) {
            startPath = stored;
          }
        }
      } catch {
        // noop; fall back to default root
      }

      if (!cancelled) {
        await loadDirectory(startPath);
      }
    })();

    return () => { cancelled = true; };
  }, [isOpen, defaultFileName, loadDirectory, t]);

  const handleNavigate = useCallback(async (p: string) => {
    await loadDirectory(p);
  }, [loadDirectory]);

  const handleGoUp = useCallback(async () => {
    if (dir && dir.parent) {
      await loadDirectory(dir.parent);
    }
  }, [dir, loadDirectory]);

  const handleItemTap = useCallback(async (item: DirItem) => {
    if (item.isDirectory) {
      await loadDirectory(item.path);
      return;
    }
    if (mode === 'open') {
      if (!filenameLooksAllowed(item.name, accept)) {
        setError(t.fileTypesOnly);
        return;
      }
      setBusy(true);
      try {
        await onSelect({ filePath: item.path, fileName: item.name, mode: 'open' });
      } finally {
        setBusy(false);
      }
    } else {
      setFilename(item.name);
    }
  }, [mode, accept, onSelect, t]);

  const handleConfirmCreate = useCallback(async () => {
    if (!dir) return;
    const name = filename.trim();
    if (!name) {
      setError(t.filenameRequired);
      return;
    }
    if (hasInvalidPathChars(name)) {
      setError(t.filenameInvalid);
      return;
    }
    if (!filenameLooksAllowed(name, accept)) {
      setError(t.fileTypesOnly);
      return;
    }
    const fullPath = dir.path.endsWith('/') || dir.path.endsWith('\\')
      ? `${dir.path}${name}`
      : `${dir.path}${dir.path.includes('\\') ? '\\' : '/'}${name}`;
    try {
      const existsRes: any = await httpInvoke('fs:check-path-exists', { path: fullPath });
      if (existsRes && existsRes.ok && existsRes.exists) {
        if (existsRes.isDirectory) {
          setError(t.filenameInvalid);
          return;
        }
        const proceed = window.confirm(t.confirmOverwrite(name));
        if (!proceed) return;
      }
    } catch (e) {
      setError(t.error + (e as Error).message);
      return;
    }

    setBusy(true);
    try {
      await onSelect({ filePath: fullPath, fileName: name, mode: 'create' });
    } finally {
      setBusy(false);
    }
  }, [dir, filename, accept, onSelect, t]);

  const surfaceBg = isDarkMode
    ? 'bg-[#1b130d] text-[#f5ebdc] border-[#3f3125]'
    : 'bg-[#fdf7ec] text-[#49301f] border-[#e5d5bb]';
  const headerBg = isDarkMode
    ? 'bg-[#231a12] border-b border-[#3f3125]'
    : 'bg-[#f7ecd7] border-b border-[#e5d5bb]';
  const chipBase = isDarkMode
    ? 'bg-[#2a1f16] border-[#4a3a28] text-[#e7d9c4] hover:bg-[#342617]'
    : 'bg-white border-[#e0cdb0] text-[#6a4c30] hover:bg-[#faeed6]';
  const rowHover = isDarkMode ? 'hover:bg-white/5 active:bg-white/10' : 'hover:bg-[#f2e3cf] active:bg-[#ead6bc]';
  const mutedText = isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]';
  const folderColor = isDarkMode ? 'text-amber-300' : 'text-amber-600';
  const fileColor = isDarkMode ? 'text-teal-300' : 'text-teal-700';
  const inputBg = isDarkMode
    ? 'bg-[#2a1f16] border-[#4a3a28] text-[#f5ebdc] placeholder-[#8a7460]'
    : 'bg-white border-[#e0cdb0] text-[#49301f] placeholder-[#a68960]';

  const title = mode === 'open' ? t.titleOpen : t.titleCreate;

  return createPortal(
    <div
      className="fixed inset-0 z-[99998] flex flex-col"
      style={{
        background: 'rgba(0,0,0,0.72)',
        backdropFilter: 'blur(6px)',
        opacity: isOpen ? 1 : 0,
        visibility: isOpen ? 'visible' : 'hidden',
        pointerEvents: isOpen ? 'auto' : 'none',
        transition: isOpen ? 'opacity 220ms ease-out, visibility 0s 0s' : 'opacity 180ms ease-in, visibility 0s 180ms',
      }}
      aria-hidden={!isOpen}
      inert={!isOpen}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={`mx-auto my-0 sm:my-6 flex flex-col w-full sm:max-w-2xl sm:rounded-[1.25rem] overflow-hidden border shadow-2xl h-full sm:h-[85vh] ${surfaceBg}`}>
        <div className={`flex items-center justify-between px-4 py-3 ${headerBg} safe-area-padding-top`}>
          <div className="flex items-center gap-2 min-w-0">
            <FolderCog size={20} className={folderColor} />
            <h2 className="font-bold text-[15px] truncate">{title}</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadDirectory(dir?.path || '')}
              className={`p-2 rounded-full border text-xs flex items-center gap-1 ${chipBase}`}
              aria-label={t.refresh}
            >
              <RefreshCw size={14} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className={`p-2 rounded-full border ${chipBase}`}
              aria-label={t.close}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className={`px-4 py-2 flex flex-wrap gap-1.5 border-b ${isDarkMode ? 'border-[#3f3125]' : 'border-[#ebe1d3]'}`}>
          {shortcuts.map(sc => (
            <button
              key={sc.key}
              type="button"
              onClick={() => void handleNavigate(sc.path)}
              className={`px-3 py-1.5 rounded-full border text-[12px] flex items-center gap-1 ${chipBase}`}
            >
              {sc.key === 'root' && <HardDrive size={12} />}
              {sc.key === 'data' && <Folder size={12} />}
              {sc.key === 'app' && <FileJson size={12} />}
              <span>
                {sc.key === 'root' ? t.shortcutRoot
                  : sc.key === 'data' ? t.shortcutData
                  : sc.key === 'app' ? t.shortcutApp
                  : sc.label}
              </span>
            </button>
          ))}
          {recentPath && recentPath !== (dir?.path || '') && (
            <button
              type="button"
              onClick={() => void handleNavigate(recentPath)}
              className={`px-3 py-1.5 rounded-full border text-[12px] flex items-center gap-1 ${chipBase}`}
            >
              <Clock size={12} />
              <span>{t.shortcutRecent}</span>
            </button>
          )}
        </div>

        <div className={`px-4 py-2 border-b flex items-center gap-2 ${isDarkMode ? 'border-[#3f3125]' : 'border-[#ebe1d3]'}`}>
          <button
            type="button"
            onClick={() => void handleGoUp()}
            disabled={!dir || dir.atRoot || !dir.parent}
            className={`p-1.5 rounded-lg border text-xs ${dir && !dir.atRoot && dir.parent ? chipBase : 'opacity-40 cursor-not-allowed border-transparent'}`}
            aria-label={t.up}
          >
            <ArrowUp size={14} />
          </button>
          <div className={`flex-1 min-w-0 text-[12px] font-mono truncate ${mutedText}`} title={dir?.path || ''}>
            {dir?.path || (loading ? t.loading : '')}
          </div>
          {dir && (
            <span className={`text-[11px] ${mutedText}`}>
              {t.filesInFolder(dir.items.length)}
            </span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className={`flex items-center justify-center gap-2 py-8 ${mutedText}`}>
              <Loader2 size={16} className="animate-spin" />
              <span className="text-sm">{t.loading}</span>
            </div>
          )}
          {!loading && error && (
            <div className={`m-3 p-3 rounded border flex items-start gap-2 ${isDarkMode ? 'border-red-500/40 bg-red-500/10 text-red-200' : 'border-red-500/40 bg-red-50 text-red-700'}`}>
              <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
              <span className="text-sm break-all">{error}</span>
            </div>
          )}
          {!loading && dir && dir.items.length === 0 && !error && (
            <div className={`text-center py-8 text-sm ${mutedText}`}>{t.empty}</div>
          )}
          {!loading && dir && dir.items.length > 0 && (
            <ul>
              {dir.items.map(item => {
                const isAllowedFile = item.isFile && filenameLooksAllowed(item.name, accept);
                const disabled = mode === 'open' && item.isFile && !isAllowedFile;
                return (
                  <li key={item.path}>
                    <button
                      type="button"
                      onClick={() => !disabled && void handleItemTap(item)}
                      disabled={disabled || busy}
                      className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${rowHover} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                    >
                      {item.isDirectory ? (
                        <Folder size={20} className={folderColor} />
                      ) : isAllowedFile ? (
                        <FileJson size={20} className={fileColor} />
                      ) : (
                        <FileIcon size={20} className={mutedText} />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-[14px] font-medium truncate">{item.name}</div>
                        {item.isFile && (
                          <div className={`text-[11px] ${mutedText}`}>
                            {formatSize(item.size)}
                            {item.mtime ? ` · ${formatMtime(item.mtime, language)}` : ''}
                          </div>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {mode === 'create' && (
          <div className={`px-4 py-3 border-t ${isDarkMode ? 'border-[#3f3125] bg-[#231a12]' : 'border-[#ebe1d3] bg-[#f7ecd7]'}`}>
            <label className={`block text-[12px] font-semibold mb-1 ${mutedText}`}>{t.filenameLabel}</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={filename}
                onChange={(e) => { setFilename(e.target.value); if (error) setError(null); }}
                placeholder={t.filenamePlaceholder}
                className={`flex-1 min-w-0 px-3 py-2 rounded-lg border text-[14px] font-mono ${inputBg}`}
                disabled={busy}
              />
              <button
                type="button"
                onClick={() => void handleConfirmCreate()}
                disabled={!dir || busy || loading}
                className={`px-4 py-2 rounded-lg font-bold text-[13px] flex items-center gap-1.5 transition-colors ${isDarkMode ? 'bg-teal-500 text-white hover:bg-teal-400 disabled:bg-[#4a3a28] disabled:text-[#8a7460]' : 'bg-teal-600 text-white hover:bg-teal-500 disabled:bg-[#d6c4a8] disabled:text-[#8f7458]'}`}
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                <span>{t.saveHere}</span>
              </button>
            </div>
            <p className={`mt-2 text-[11px] leading-relaxed ${mutedText}`}>
              {t.hintCreate}
            </p>
          </div>
        )}

        {mode === 'open' && (
          <div className={`px-4 py-3 border-t ${isDarkMode ? 'border-[#3f3125] bg-[#231a12]' : 'border-[#ebe1d3] bg-[#f7ecd7]'}`}>
            <p className={`text-[11px] leading-relaxed ${mutedText}`}>
              {t.hintOpen}
            </p>
            <p className={`mt-1 text-[11px] leading-relaxed opacity-80 ${mutedText}`}>
              {t.hintSandbox}
            </p>
          </div>
        )}

        {busy && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 pointer-events-none">
            <Loader2 size={28} className="animate-spin text-white" />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

export default MobileRemoteFileBrowser;
