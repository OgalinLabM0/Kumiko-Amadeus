import React from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, Download, RefreshCw, Rocket } from 'lucide-react';
import { UI_TRANSLATIONS } from '../../constants';
import type { AppUpdateState, Language } from '../../types';

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
  onInstallUpdate
}) => {
  const t = UI_TRANSLATIONS[language] as any;
  const progressPercent = Math.max(0, Math.min(100, updateState.progressPercent || 0));
  const releaseDate = updateState.releaseDate
    ? new Date(updateState.releaseDate).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')
    : null;

  let statusText = t.updateSectionDesc;
  if (!updateState.isPackaged) {
    statusText = t.updateUnsupported;
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

  const checkDisabled = !updateState.isPackaged || updateState.status === 'checking' || updateState.status === 'downloading';
  const downloadDisabled = !updateState.isPackaged || updateState.status !== 'available';
  const installDisabled = !updateState.isPackaged || updateState.status !== 'downloaded';

  return (
    <div className={`flex flex-col rounded-lg border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between p-4 w-full">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-full ${isDarkMode ? 'bg-cyan-900/30 text-cyan-300' : 'bg-cyan-100 text-cyan-700'}`}>
            <Rocket size={20} />
          </div>
          <div className="text-left">
            <h3 className={`font-bold text-sm ${isDarkMode ? 'text-yellow-100' : 'text-gray-900'}`}>{t.updateSection}</h3>
            {!isOpen && <p className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{statusText}</p>}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className="opacity-50" /> : <ChevronDown size={16} className="opacity-50" />}
      </button>

      {isOpen && (
        <div className="p-4 pt-0 animate-in slide-in-from-top-2 flex flex-col gap-3">
          <p className={`text-xs font-mono ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{t.updateSectionDesc}</p>

          <div className={`rounded-lg border p-3 ${isDarkMode ? 'border-white/10 bg-black/30' : 'border-gray-200 bg-white'}`}>
            <div className={`text-xs font-mono flex flex-col gap-1 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
              <div>{t.updateCurrentVersion}: <span className="font-bold">v{updateState.currentVersion}</span></div>
              {updateState.availableVersion && <div>{t.updateLatestVersion}: <span className="font-bold">v{updateState.availableVersion}</span></div>}
              {releaseDate && <div>{t.updateReleaseDate}: {releaseDate}</div>}
              <div className={isDarkMode ? 'text-cyan-300' : 'text-cyan-700'}>{statusText}</div>
            </div>
          </div>

          {updateState.status === 'downloading' && (
            <div className={`rounded-lg border p-3 ${isDarkMode ? 'border-cyan-500/20 bg-cyan-500/5' : 'border-cyan-200 bg-cyan-50'}`}>
              <div className="flex items-center justify-between text-xs mb-2">
                <span>{t.updateDownloadProgress}</span>
                <span>{progressPercent.toFixed(1)}%</span>
              </div>
              <div className={`h-2 rounded-full overflow-hidden ${isDarkMode ? 'bg-white/10' : 'bg-gray-200'}`}>
                <div className="h-full bg-cyan-500 transition-all duration-200" style={{ width: `${progressPercent}%` }} />
              </div>
              <div className={`mt-2 text-[11px] font-mono ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                {formatBytes(updateState.transferred)} / {formatBytes(updateState.total)}
              </div>
            </div>
          )}

          {updateState.status === 'error' && updateState.error && (
            <div className={`rounded-lg border p-3 text-xs font-mono whitespace-pre-wrap ${isDarkMode ? 'border-red-500/30 bg-red-500/10 text-red-200' : 'border-red-200 bg-red-50 text-red-700'}`}>
              {updateState.error}
            </div>
          )}

          {!updateState.isPackaged && (
            <div className={`rounded-lg border p-3 text-xs ${isDarkMode ? 'border-amber-500/30 bg-amber-500/10 text-amber-200' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
              {t.updateUnsupported}
            </div>
          )}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <button
              onClick={onCheckForUpdates}
              disabled={checkDisabled}
              className={`py-2.5 rounded flex items-center justify-center gap-2 text-xs font-mono font-bold transition-colors ${
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
              className={`py-2.5 rounded flex items-center justify-center gap-2 text-xs font-mono font-bold transition-colors ${
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
              className={`py-2.5 rounded flex items-center justify-center gap-2 text-xs font-mono font-bold transition-colors ${
                installDisabled
                  ? (isDarkMode ? 'bg-white/5 text-gray-500' : 'bg-gray-100 text-gray-400')
                  : (isDarkMode ? 'bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30' : 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200')
              }`}
            >
              <CheckCircle2 size={14} />
              {t.updateInstall}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
