import React, { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FolderOpen,
  RefreshCw,
  Rocket,
  Trash2,
} from 'lucide-react';
import { UI_TRANSLATIONS } from '../../constants';
import type { AppUpdateState, Language, UpdaterCacheInfo } from '../../types';
import { Collapse } from '../Collapse';
import { isMobilePwa } from '../../services/environment';
import { isDesktopElectron } from '../../services/desktopBackupService';

type UpdatePlatform = 'desktop' | 'mobile' | 'web';

function detectPlatform(): UpdatePlatform {
  if (isMobilePwa()) return 'mobile';
  if (isDesktopElectron()) return 'desktop';
  return 'web';
}

interface AppUpdateSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  language: Language;
  sectionBorder: string;
  updateState: AppUpdateState;
  onCheckForUpdates: () => void;
  onDownloadUpdate: () => void;
  onInstallUpdate: () => void;
  // v2.10.1 Download Cache block. `updaterCacheInfo` may be null on
  // mobile / web / before the first refresh; the UI falls back to the
  // empty-cache copy in that case. The three action props are awaited
  // so the inline toast messages can reflect success/failure.
  updaterCacheInfo: UpdaterCacheInfo | null;
  onRefreshUpdaterCacheInfo: () => Promise<void>;
  onOpenUpdaterCacheFolder: () => Promise<{ success: boolean; error?: string }>;
  onClearUpdaterCache: () => Promise<{ success: boolean; error?: string; sizeBytes?: number }>;
}

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

export const AppUpdateSection: React.FC<AppUpdateSectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  language,
  sectionBorder,
  updateState,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate,
  updaterCacheInfo,
  onRefreshUpdaterCacheInfo,
  onOpenUpdaterCacheFolder,
  onClearUpdaterCache,
}) => {
  const t = UI_TRANSLATIONS[language] as any;
  const progressPercent = Math.max(0, Math.min(100, updateState.progressPercent || 0));
  const releaseDate = updateState.releaseDate
    ? new Date(updateState.releaseDate).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')
    : null;

  // Platform-aware banner / button policy. The desktop write side
  // (check / download / install) only runs inside a packaged Electron
  // build, so on mobile PWA + dev Electron + plain web preview we want
  // platform-appropriate hints instead of the desktop-only "未打包" text.
  const platform = detectPlatform();
  const isPackagedDesktop = platform === 'desktop' && !!updateState.isPackaged;

  let statusText = t.updateSectionDesc;
  if (platform === 'mobile') {
    statusText = t.updateMobileHint;
  } else if (platform === 'web') {
    statusText = t.updateUnsupported;
  } else if (!updateState.isPackaged) {
    // Desktop dev (npm run dev). Use the dev-specific hint so users
    // don't think the packaged build is also broken.
    statusText = t.updateUnsupportedDev;
  } else if (updateState.status === 'checking') {
    statusText = t.updateChecking;
  } else if (updateState.status === 'available') {
    statusText = t.updateAvailable;
  } else if (updateState.status === 'downloading') {
    statusText = t.updateDownloading;
  } else if (updateState.status === 'downloaded') {
    statusText = t.updateReady;
  } else if (updateState.status === 'not-available') {
    statusText = t.updateUpToDate;
  } else if (updateState.status === 'error') {
    statusText = t.updateError;
  }

  // Buttons are interactive only in packaged desktop builds. Dev mode
  // and mobile both surface them as visible-but-disabled with a tooltip
  // so the UI shape stays predictable across runtimes.
  const buttonsDisabledByPlatform = !isPackagedDesktop;
  const platformDisabledTitle = platform === 'mobile'
    ? t.updateMobileHint
    : platform === 'web'
      ? t.updateUnsupported
      : t.updateUnsupportedDev;
  const checkDisabled = buttonsDisabledByPlatform || updateState.status === 'checking' || updateState.status === 'downloading';
  const downloadDisabled = buttonsDisabledByPlatform || updateState.status !== 'available';
  const installDisabled = buttonsDisabledByPlatform || updateState.status !== 'downloaded';

  // Banner display: packaged desktop never shows it; mobile shows a
  // neutral cyan info pill (not the warning amber); dev desktop shows
  // amber but with the "dev mode" wording; web stays silent (the
  // statusText already conveys the right hint inside the version card).
  let bannerVariant: 'mobile' | 'desktop-dev' | null = null;
  if (platform === 'mobile') {
    bannerVariant = 'mobile';
  } else if (platform === 'desktop' && !updateState.isPackaged) {
    bannerVariant = 'desktop-dev';
  }
  const bannerClassName = bannerVariant === 'desktop-dev'
    ? (isDarkMode ? 'border-amber-500/30 bg-amber-500/10 text-amber-200' : 'border-amber-200 bg-amber-50 text-amber-700')
    : (isDarkMode ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-200' : 'border-cyan-200 bg-cyan-50 text-cyan-700');
  const bannerText = bannerVariant === 'desktop-dev' ? t.updateUnsupportedDev : t.updateMobileHint;

  // ── Download Cache block (packaged-desktop only) ─────────────────
  // Refresh on mount + whenever the update lifecycle transitions so
  // the size/count stay in sync with what electron-updater is actually
  // doing. We debounce through the slice (refreshUpdaterCacheInfo is
  // fire-and-forget; the store handles the async).
  useEffect(() => {
    if (!isPackagedDesktop) return;
    void onRefreshUpdaterCacheInfo();
  }, [isPackagedDesktop, onRefreshUpdaterCacheInfo, updateState.status]);

  const [cacheToast, setCacheToast] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [isClearingCache, setIsClearingCache] = useState(false);
  const [isOpeningCache, setIsOpeningCache] = useState(false);

  // Auto-dismiss the inline toast after 3s so repeated clicks don't
  // stack a wall of green pills above the buttons.
  useEffect(() => {
    if (!cacheToast) return;
    const timer = window.setTimeout(() => setCacheToast(null), 3000);
    return () => window.clearTimeout(timer);
  }, [cacheToast]);

  const handleCopyCachePath = useCallback(async () => {
    const pathToCopy = updaterCacheInfo?.path;
    if (!pathToCopy) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(pathToCopy);
      } else {
        // Fallback for Electron contexts where clipboard write isn't
        // available (e.g. file://). Swallow silently; the toast still
        // fires so the user sees *something*.
      }
      setCacheToast({ tone: 'success', text: t.updateCachePathCopied });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCacheToast({ tone: 'error', text: message });
    }
  }, [updaterCacheInfo, t]);

  const handleOpenCacheFolder = useCallback(async () => {
    if (isOpeningCache) return;
    setIsOpeningCache(true);
    try {
      const result = await onOpenUpdaterCacheFolder();
      if (!result.success && result.error) {
        setCacheToast({ tone: 'error', text: result.error });
      }
    } finally {
      setIsOpeningCache(false);
    }
  }, [isOpeningCache, onOpenUpdaterCacheFolder]);

  const handleClearCache = useCallback(async () => {
    if (isClearingCache) return;
    setIsClearingCache(true);
    try {
      const sizeBefore = updaterCacheInfo?.sizeBytes ?? 0;
      const result = await onClearUpdaterCache();
      if (result.success) {
        const cleared = typeof result.sizeBytes === 'number' ? result.sizeBytes : sizeBefore;
        setCacheToast({
          tone: 'success',
          text: (t.updateCacheCleared as string).replace('{0}', formatBytes(cleared)),
        });
      } else if (result.error) {
        setCacheToast({ tone: 'error', text: result.error });
      }
    } finally {
      setIsClearingCache(false);
    }
  }, [isClearingCache, updaterCacheInfo, onClearUpdaterCache, t]);

  const cacheHasContent = !!updaterCacheInfo && updaterCacheInfo.exists && updaterCacheInfo.sizeBytes > 0;
  const cachePathDisplay = updaterCacheInfo?.path || '';
  const cacheSizeDisplay = updaterCacheInfo
    ? `${formatBytes(updaterCacheInfo.sizeBytes)}${updaterCacheInfo.fileCount > 0 ? ` ${(t.updateCacheFileCount as string).replace('{0}', String(updaterCacheInfo.fileCount))}` : ''}`
    : t.updateCacheEmpty;
  const clearDisabled = !isPackagedDesktop || !cacheHasContent || isClearingCache
    || updateState.status === 'checking' || updateState.status === 'downloading';
  const openDisabled = !isPackagedDesktop || isOpeningCache;
  const copyDisabled = !cachePathDisplay;

  return (
    <div className={`flex flex-col rounded-[1.2rem] border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between px-4 py-[1.05rem] w-full">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-2xl border ${isDarkMode ? 'border-cyan-500/20 bg-cyan-900/20 text-cyan-300' : 'border-cyan-200 bg-cyan-50/90 text-cyan-700'}`}>
            <Rocket size={18} />
          </div>
          <div className="text-left">
            <h3 className={`ka-section-title ${isDarkMode ? 'text-[#f5ebdc]' : 'text-[#49301f]'}`}>{t.updateSection}</h3>
            {!isOpen && <p className={`ka-section-desc ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{statusText}</p>}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} /> : <ChevronDown size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />}
      </button>

      <Collapse isOpen={isOpen}>
        <div className="px-4 pb-4 pt-0 flex flex-col gap-3">
          <p className={`ka-copy-sm ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{t.updateSectionDesc}</p>

          <div className={`rounded-lg border p-3 ${isDarkMode ? 'border-white/10 bg-black/30' : 'border-gray-200 bg-white'}`}>
            <div className={`ka-copy-sm flex flex-col gap-1 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
              <div>{t.updateCurrentVersion}: <span className="font-bold">v{updateState.currentVersion}</span></div>
              {updateState.availableVersion && <div>{t.updateLatestVersion}: <span className="font-bold">v{updateState.availableVersion}</span></div>}
              {releaseDate && <div>{t.updateReleaseDate}: {releaseDate}</div>}
              <div className={isDarkMode ? 'text-cyan-300' : 'text-cyan-700'}>{statusText}</div>
            </div>
          </div>

          {updateState.status === 'downloading' && (
            <div className={`rounded-lg border p-3 ${isDarkMode ? 'border-cyan-500/20 bg-cyan-500/5' : 'border-cyan-200 bg-cyan-50'}`}>
              <div className="flex items-center justify-between ka-copy-sm mb-2">
                <span>{t.updateDownloadProgress}</span>
                <span>{progressPercent.toFixed(1)}%</span>
              </div>
              <div className={`h-2 rounded-full overflow-hidden ${isDarkMode ? 'bg-white/10' : 'bg-gray-200'}`}>
                <div className="h-full bg-cyan-500 transition-all duration-200" style={{ width: `${progressPercent}%` }} />
              </div>
              <div className={`mt-2 ka-copy-sm font-mono ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                {formatBytes(updateState.transferred)} / {formatBytes(updateState.total)}
              </div>
            </div>
          )}

          {updateState.status === 'error' && updateState.error && (
            <div className={`rounded-lg border p-3 ka-copy-sm font-mono whitespace-pre-wrap ${isDarkMode ? 'border-red-500/30 bg-red-500/10 text-red-200' : 'border-red-200 bg-red-50 text-red-700'}`}>
              {updateState.error}
            </div>
          )}

          {bannerVariant !== null && (
            <div className={`rounded-lg border p-3 ka-copy-sm ${bannerClassName}`}>
              {bannerText}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <button
              onClick={onCheckForUpdates}
              disabled={checkDisabled}
              title={buttonsDisabledByPlatform ? platformDisabledTitle : undefined}
              className={`min-h-[2.9rem] px-3 py-2.5 rounded-xl flex items-center justify-center gap-2 text-center leading-tight ka-copy-sm font-semibold transition-colors ${
                checkDisabled
                  ? (isDarkMode ? 'bg-white/5 text-gray-500' : 'bg-gray-100 text-gray-400')
                  : (isDarkMode ? 'bg-sky-500/20 text-sky-200 hover:bg-sky-500/30' : 'bg-sky-100 text-sky-700 hover:bg-sky-200')
              }`}
            >
              <RefreshCw size={14} className={updateState.status === 'checking' ? 'animate-spin' : ''} />
              {t.updateCheck}
            </button>
            <button
              onClick={onDownloadUpdate}
              disabled={downloadDisabled}
              title={buttonsDisabledByPlatform ? platformDisabledTitle : undefined}
              className={`min-h-[2.9rem] px-3 py-2.5 rounded-xl flex items-center justify-center gap-2 text-center leading-tight ka-copy-sm font-semibold transition-colors ${
                downloadDisabled
                  ? (isDarkMode ? 'bg-white/5 text-gray-500' : 'bg-gray-100 text-gray-400')
                  : (isDarkMode ? 'bg-cyan-500/20 text-cyan-200 hover:bg-cyan-500/30' : 'bg-cyan-100 text-cyan-700 hover:bg-cyan-200')
              }`}
            >
              <Download size={14} className={updateState.status === 'downloading' ? 'animate-bounce' : ''} />
              {t.updateDownload}
            </button>
            <button
              onClick={onInstallUpdate}
              disabled={installDisabled}
              title={buttonsDisabledByPlatform ? platformDisabledTitle : undefined}
              className={`min-h-[2.9rem] px-3 py-2.5 rounded-xl flex items-center justify-center gap-2 text-center leading-tight ka-copy-sm font-semibold transition-colors ${
                installDisabled
                  ? (isDarkMode ? 'bg-white/5 text-gray-500' : 'bg-gray-100 text-gray-400')
                  : (isDarkMode ? 'bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30' : 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200')
              }`}
            >
              <CheckCircle2 size={14} />
              {t.updateInstall}
            </button>
          </div>

          {isPackagedDesktop && (
            <div className={`mt-2 rounded-lg border p-3 flex flex-col gap-2 ${isDarkMode ? 'border-white/10 bg-black/30' : 'border-gray-200 bg-white'}`}>
              <div className="flex items-center justify-between">
                <div className={`ka-copy-sm font-semibold ${isDarkMode ? 'text-[#f5ebdc]' : 'text-[#49301f]'}`}>{t.updateCacheSectionTitle}</div>
              </div>

              <div className={`flex items-start gap-2 ka-copy-sm ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                <div className="flex-shrink-0 font-semibold whitespace-nowrap">{t.updateCachePathLabel}:</div>
                <div
                  className={`flex-1 min-w-0 font-mono text-[11px] truncate ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}
                  title={cachePathDisplay}
                >
                  {cachePathDisplay || t.updateCacheEmpty}
                </div>
                <button
                  type="button"
                  onClick={handleCopyCachePath}
                  disabled={copyDisabled}
                  title={t.updateCachePathLabel}
                  className={`flex-shrink-0 p-1.5 rounded-md transition-colors ${
                    copyDisabled
                      ? (isDarkMode ? 'text-gray-600' : 'text-gray-400')
                      : (isDarkMode ? 'text-cyan-300 hover:bg-cyan-500/10' : 'text-cyan-700 hover:bg-cyan-50')
                  }`}
                >
                  <Copy size={12} />
                </button>
              </div>

              <div className={`flex items-center gap-2 ka-copy-sm ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                <div className="flex-shrink-0 font-semibold whitespace-nowrap">{t.updateCacheSizeLabel}:</div>
                <div className={`flex-1 font-mono text-[11px] ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  {cacheSizeDisplay}
                </div>
              </div>

              <p className={`ka-copy-sm text-[11px] leading-snug ${isDarkMode ? 'text-[#8c7660]' : 'text-[#9c7f62]'}`}>
                {t.updateCacheHint}
              </p>

              {cacheToast && (
                <div
                  className={`rounded-md border px-2 py-1.5 ka-copy-sm whitespace-pre-wrap break-all ${
                    cacheToast.tone === 'success'
                      ? (isDarkMode ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-emerald-200 bg-emerald-50 text-emerald-700')
                      : (isDarkMode ? 'border-red-500/30 bg-red-500/10 text-red-200' : 'border-red-200 bg-red-50 text-red-700')
                  }`}
                >
                  {cacheToast.text}
                </div>
              )}

              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={handleOpenCacheFolder}
                  disabled={openDisabled}
                  className={`min-h-[2.4rem] px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-center leading-tight ka-copy-sm font-semibold transition-colors ${
                    openDisabled
                      ? (isDarkMode ? 'bg-white/5 text-gray-500' : 'bg-gray-100 text-gray-400')
                      : (isDarkMode ? 'bg-sky-500/20 text-sky-200 hover:bg-sky-500/30' : 'bg-sky-100 text-sky-700 hover:bg-sky-200')
                  }`}
                >
                  <FolderOpen size={13} />
                  {t.updateCacheOpenFolder}
                </button>
                <button
                  type="button"
                  onClick={handleClearCache}
                  disabled={clearDisabled}
                  className={`min-h-[2.4rem] px-3 py-2 rounded-lg flex items-center justify-center gap-2 text-center leading-tight ka-copy-sm font-semibold transition-colors ${
                    clearDisabled
                      ? (isDarkMode ? 'bg-white/5 text-gray-500' : 'bg-gray-100 text-gray-400')
                      : (isDarkMode ? 'bg-rose-500/20 text-rose-200 hover:bg-rose-500/30' : 'bg-rose-100 text-rose-700 hover:bg-rose-200')
                  }`}
                >
                  <Trash2 size={13} className={isClearingCache ? 'animate-pulse' : ''} />
                  {t.updateCacheClear}
                </button>
              </div>
            </div>
          )}
        </div>
      </Collapse>
    </div>
  );
};
