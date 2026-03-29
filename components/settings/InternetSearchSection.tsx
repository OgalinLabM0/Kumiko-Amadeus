import React from 'react';
import { Activity, AlertTriangle, CheckCircle, ChevronDown, ChevronUp, Globe, Loader2, RefreshCw } from 'lucide-react';

interface InternetSearchTranslations {
  internetSearchConfig: string;
  internetSearchDesc?: string;
  enableInternetSearch: string;
  tavilyApiKey: string;
  usage: string;
  testSearch: string;
}

interface InternetSearchSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  sectionBorder: string;
  innerCardClass: string;
  inputClass: string;
  t: InternetSearchTranslations;
  tavilyApiKey: string;
  enableInternetSearch: boolean;
  tavilyUsage: string | null;
  searchStatus?: string;
  searchStatusType?: 'neutral' | 'success' | 'error';
  onSaveConfig: (key: string, enabled: boolean) => void;
  onRefreshUsage: () => void;
  onTestSearch: () => void;
}

export const InternetSearchSection: React.FC<InternetSearchSectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  sectionBorder,
  innerCardClass,
  inputClass,
  t,
  tavilyApiKey,
  enableInternetSearch,
  tavilyUsage,
  searchStatus,
  searchStatusType,
  onSaveConfig,
  onRefreshUsage,
  onTestSearch
}) => {
  const isTesting = searchStatusType === 'neutral' && !!searchStatus;
  return (
    <div className={`flex flex-col rounded-lg border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between p-4 w-full">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-full ${isDarkMode ? 'bg-blue-900/30 text-blue-400' : 'bg-blue-100 text-blue-700'}`}>
            <Globe size={20} />
          </div>
          <div className="text-left">
            <h3 className={`font-bold text-sm ${isDarkMode ? 'text-yellow-100' : 'text-gray-900'}`}>{t.internetSearchConfig}</h3>
            {!isOpen && t.internetSearchDesc && <p className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{t.internetSearchDesc}</p>}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className="opacity-50" /> : <ChevronDown size={16} className="opacity-50" />}
      </button>

      {isOpen && (
        <div className="p-4 pt-0 animate-in slide-in-from-top-2 space-y-4">
          {t.internetSearchDesc && <p className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{t.internetSearchDesc}</p>}
          <div className={innerCardClass}>
            <div className="flex items-center justify-between mb-4">
              <label className={`text-xs font-bold ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>{t.enableInternetSearch}</label>
              <button
                onClick={() => onSaveConfig(tavilyApiKey, !enableInternetSearch)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${enableInternetSearch ? 'bg-teal-500' : 'bg-gray-400'}`}
              >
                <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${enableInternetSearch ? 'translate-x-5' : 'translate-x-1'}`} />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className={`block text-[10px] font-bold ${isDarkMode ? 'text-gray-400' : 'text-gray-700'}`}>{t.tavilyApiKey}</label>
                <input
                  type="password"
                  value={tavilyApiKey}
                  onChange={(e) => onSaveConfig(e.target.value, enableInternetSearch)}
                  placeholder="tvly-..."
                  className={inputClass}
                />
              </div>
              {tavilyUsage && (
                <div className={`flex items-center justify-between text-[10px] font-mono p-2 rounded ${isDarkMode ? 'bg-black/30 text-gray-400' : 'bg-gray-200 text-gray-600'}`}>
                  <span>{t.usage}: {tavilyUsage}</span>
                  <button onClick={onRefreshUsage} className="hover:text-teal-500 transition-colors" title="Refresh Usage">
                    <RefreshCw size={12} />
                  </button>
                </div>
              )}
              <button onClick={onTestSearch} disabled={isTesting}
                className={`w-full py-2 rounded text-xs font-bold flex items-center justify-center gap-2 transition-colors border ${isTesting ? 'opacity-60 cursor-wait' : ''} ${isDarkMode ? 'border-gray-600 text-gray-300 hover:bg-gray-700' : 'border-gray-300 text-gray-700 hover:bg-gray-200'}`}>
                {isTesting ? <Loader2 size={14} className="animate-spin" /> : <Activity size={14} />}
                {t.testSearch}
              </button>
              {searchStatus && (
                <div className={`flex items-center gap-2 text-xs font-bold font-mono p-2 rounded border ${
                  searchStatusType === 'error' ? 'text-red-500 bg-red-500/10 border-red-500/20' :
                  searchStatusType === 'success' ? 'text-green-500 bg-green-500/10 border-green-500/20' :
                  (isDarkMode ? 'text-gray-400 bg-gray-500/10 border-gray-500/20' : 'text-gray-600 bg-gray-200 border-gray-300')
                }`}>
                  {searchStatusType === 'error' && <AlertTriangle size={14} />}
                  {searchStatusType === 'success' && <CheckCircle size={14} />}
                  {isTesting && <Loader2 size={14} className="animate-spin" />}
                  {searchStatus}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
