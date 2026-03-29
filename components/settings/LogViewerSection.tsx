import React from 'react';
import { ChevronDown, ChevronUp, Terminal } from 'lucide-react';

interface LogViewerTranslations {
  logTitle: string;
  logDesc: string;
  clearLog: string;
}

interface DevLogEntry {
  level: 'log' | 'warn' | 'error';
  message: string;
  timestamp: string;
}

interface LogViewerSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  onClear: () => void;
  isDarkMode: boolean;
  t: LogViewerTranslations;
  sectionBorder: string;
  devLogs: DevLogEntry[];
  logContainerRef: React.RefObject<HTMLDivElement>;
}

export const LogViewerSection: React.FC<LogViewerSectionProps> = ({
  isOpen,
  onToggle,
  onClear,
  isDarkMode,
  t,
  sectionBorder,
  devLogs,
  logContainerRef
}) => {
  const visibleLogs = React.useMemo(() => devLogs.slice(-120), [devLogs]);
  const hiddenLogCount = Math.max(0, devLogs.length - visibleLogs.length);

  return (
    <div className={`flex flex-col rounded-lg border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between p-4 w-full">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-full ${isDarkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-700'}`}>
            <Terminal size={20} />
          </div>
          <div className="text-left">
            <h3 className={`font-bold text-sm ${isDarkMode ? 'text-yellow-100' : 'text-gray-900'}`}>{t.logTitle}</h3>
            {!isOpen && <p className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{t.logDesc}</p>}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className="opacity-50" /> : <ChevronDown size={16} className="opacity-50" />}
      </button>

      {isOpen && (
        <div className="p-4 pt-0 animate-in slide-in-from-top-2 space-y-2">
          <p className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{t.logDesc}</p>
          {hiddenLogCount > 0 && (
            <p className={`text-[10px] ${isDarkMode ? 'text-gray-500' : 'text-gray-500'}`}>
              Showing the latest {visibleLogs.length} logs. {hiddenLogCount} older entries are hidden to keep the viewer responsive.
            </p>
          )}
          <div ref={logContainerRef} className={`h-48 p-2 rounded border overflow-y-auto overflow-x-hidden scrollbar-thin text-[10px] font-mono whitespace-pre-wrap break-all ${isDarkMode ? 'bg-black/50 border-gray-700' : 'bg-white border-gray-300'}`}>
            {visibleLogs.map((log, i) => {
              let colorClass = isDarkMode ? 'text-gray-400' : 'text-gray-600';
              if (log.level === 'warn') colorClass = 'text-yellow-500';
              if (log.level === 'error') colorClass = 'text-red-500';
              return (
                <p key={i} className={colorClass}>
                  <span className="opacity-60 mr-2">{log.timestamp}</span>
                  <span className="font-bold mr-1">[{log.level.toUpperCase()}]</span>
                  {log.message}
                </p>
              );
            })}
          </div>
          <button onClick={onClear} className={`w-full py-1.5 rounded text-xs font-bold border ${isDarkMode ? 'border-gray-700 text-gray-400 hover:bg-gray-800' : 'border-gray-300 text-gray-600 hover:bg-gray-200'}`}>
            {t.clearLog}
          </button>
        </div>
      )}
    </div>
  );
};
