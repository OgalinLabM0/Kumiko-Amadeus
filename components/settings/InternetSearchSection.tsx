import React from 'react';
import { Activity, AlertTriangle, CheckCircle, ChevronDown, ChevronUp, ExternalLink, Globe, Loader2, RefreshCw } from 'lucide-react';
import { Collapse } from '../Collapse';
import { SettingsToggle } from './SettingsToggle';
import { openExternalUrl } from '../../utils/openExternal';

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
  language: 'zh' | 'en';
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
  language,
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
    <div className={`flex flex-col rounded-[1.2rem] border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between px-4 py-[1.05rem] w-full">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-2xl border ${isDarkMode ? 'border-blue-500/20 bg-blue-900/20 text-blue-300' : 'border-blue-200 bg-blue-50/90 text-blue-700'}`}>
            <Globe size={18} />
          </div>
          <div className="text-left">
            <h3 className={`ka-section-title ${isDarkMode ? 'text-[#f5ebdc]' : 'text-[#49301f]'}`}>{t.internetSearchConfig}</h3>
            {!isOpen && t.internetSearchDesc && <p className={`ka-section-desc ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{t.internetSearchDesc}</p>}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} /> : <ChevronDown size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />}
      </button>

      <Collapse isOpen={isOpen}>
        <div className="px-4 pb-4 pt-0 space-y-4">
          {t.internetSearchDesc && <p className={`ka-copy-sm ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{t.internetSearchDesc}</p>}
          <div className={innerCardClass}>
            <div className="flex items-center justify-between mb-4">
              <label className={`ka-setting-item-title ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>{t.enableInternetSearch}</label>
              <div className="flex-shrink-0">
                <SettingsToggle
                  checked={enableInternetSearch}
                  onClick={() => onSaveConfig(tavilyApiKey, !enableInternetSearch)}
                  activeTrackClass="bg-teal-500/95"
                  inactiveTrackClass={isDarkMode ? 'bg-[#3e3429]' : 'bg-[#d7d2ca]'}
                  ariaLabel={t.enableInternetSearch}
                />
              </div>
            </div>
            <div className="space-y-3">
              <div>
                <label className={`block ka-label ${isDarkMode ? 'text-gray-400' : 'text-gray-700'}`}>{t.tavilyApiKey}</label>
                <input
                  type="password"
                  value={tavilyApiKey}
                  onChange={(e) => onSaveConfig(e.target.value, enableInternetSearch)}
                  placeholder="tvly-..."
                  className={`${inputClass} mt-1.5`}
                />
                <div className={`mt-1.5 flex flex-wrap items-center gap-2 ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>
                  <span className="ka-copy-sm">
                    {language === 'zh' ? '申请或查看额度：' : 'Open dashboard:'}
                  </span>
                  <button
                    type="button"
                    onClick={() => openExternalUrl('https://tavily.com/')}
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 transition-colors text-xs ${isDarkMode ? 'text-[#d8ba81] hover:text-[#f3d59a] hover:bg-white/5' : 'text-[#a06b22] hover:text-[#84551a] hover:bg-[#fff8ea]'}`}
                  >
                    <ExternalLink size={11} />
                    tavily.com
                  </button>
                </div>
              </div>
              {tavilyUsage && (
                <div className={`flex items-center justify-between ka-micro p-2 rounded ${isDarkMode ? 'bg-black/30 text-gray-400' : 'bg-gray-200 text-gray-600'}`}>
                  <span>{t.usage}: {tavilyUsage}</span>
                  <button onClick={onRefreshUsage} className="hover:text-teal-500 transition-colors" title="Refresh Usage">
                    <RefreshCw size={12} />
                  </button>
                </div>
              )}
              <button onClick={onTestSearch} disabled={isTesting}
                className={`w-full py-2 rounded ka-label flex items-center justify-center gap-2 transition-colors border ${isTesting ? 'opacity-60 cursor-wait' : ''} ${isDarkMode ? 'border-gray-600 text-gray-300 hover:bg-gray-700' : 'border-gray-300 text-gray-700 hover:bg-gray-200'}`}>
                {isTesting ? <Loader2 size={14} className="animate-spin" /> : <Activity size={14} />}
                {t.testSearch}
              </button>
              {searchStatus && (
                <div className={`flex items-center gap-2 ka-copy-sm p-2 rounded border ${
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
      </Collapse>
    </div>
  );
};
