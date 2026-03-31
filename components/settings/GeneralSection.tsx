import React from 'react';
import { ChevronDown, ChevronUp, Settings } from 'lucide-react';
import { SettingsToggle } from './SettingsToggle';

interface GeneralSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  sectionBorder: string;
  innerCardClass: string;
  title: string;
  desc: string;
  languageLabel: string;
  language: 'zh' | 'en';
  onLanguageChange: (lang: 'zh' | 'en') => void;
  proactiveTitle: string;
  proactiveDesc: string;
  enableProactive: boolean;
  onToggleProactive: () => void;
  showWebPushFallback: boolean;
  webPushTitle: string;
  pushButtonLabel: string;
  isPushActionDisabled: boolean;
  onSubscribePush: () => void;
  isSubscribing: boolean;
}

export const GeneralSection: React.FC<GeneralSectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  sectionBorder,
  innerCardClass,
  title,
  desc,
  languageLabel,
  language,
  onLanguageChange,
  proactiveTitle,
  proactiveDesc,
  enableProactive,
  onToggleProactive,
  showWebPushFallback,
  webPushTitle,
  pushButtonLabel,
  isPushActionDisabled,
  onSubscribePush,
  isSubscribing
}) => {
  const activeTrackClass = 'bg-green-600/95 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]';
  const inactiveTrackClass = isDarkMode ? 'bg-[#3e3429]' : 'bg-[#d7d2ca]';

  return (
    <div className={`flex flex-col rounded-[1.2rem] border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between px-4 py-[1.05rem] w-full">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-2xl border ${isDarkMode ? 'border-purple-500/20 bg-purple-900/20 text-purple-300' : 'border-purple-200 bg-purple-50/90 text-purple-700'}`}>
            <Settings size={18} />
          </div>
          <div className="text-left">
            <h3 className={`ka-section-title ${isDarkMode ? 'text-[#f5ebdc]' : 'text-[#49301f]'}`}>{title}</h3>
            {!isOpen && <p className={`ka-section-desc ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{desc}</p>}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} /> : <ChevronDown size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />}
      </button>

      {isOpen && (
        <div className="px-4 pb-4 pt-0 animate-in slide-in-from-top-2">
          <div className={innerCardClass}>
            <p className={`ka-copy-sm mb-4 ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{desc}</p>
            <div className="flex flex-col gap-4">
              <span className={`ka-setting-item-title ${isDarkMode ? 'text-[#f1e6d7]' : 'text-[#54402d]'}`}>{languageLabel}</span>
              <div className={`grid grid-cols-2 gap-2 rounded-[1rem] p-1.5 ${isDarkMode ? 'bg-[#120e0c]/70 border border-[#4e3d2e]/55' : 'bg-[#f5f1ea] border border-[#e8dfd1]'}`}>
                <button 
                  onClick={() => onLanguageChange('zh')} 
                  className={`relative flex items-center justify-center py-2.5 px-4 rounded-[0.85rem] ka-label font-semibold transition-all duration-300 ${
                    language === 'zh' 
                      ? (isDarkMode ? 'bg-[#ead0a0] text-[#25190c] shadow-[0_8px_18px_rgba(228,178,79,0.18)] ring-1 ring-[#e4b24f]/70' : 'bg-white text-[#7b5625] shadow-[0_6px_14px_rgba(119,89,44,0.10)] ring-1 ring-[#dbc398]') 
                      : (isDarkMode ? 'text-[#b8a38a] hover:text-[#f4e7d7] hover:bg-white/5' : 'text-[#8d7b65] hover:text-[#785a42] hover:bg-white/80')
                  }`}
                >
                  <span className="relative z-10 tracking-[0.08em] text-[12px]">中文</span>
                </button>
                <button 
                  onClick={() => onLanguageChange('en')} 
                  className={`relative flex items-center justify-center py-2.5 px-4 rounded-[0.85rem] ka-label font-semibold transition-all duration-300 ${
                    language === 'en' 
                      ? (isDarkMode ? 'bg-[#ead0a0] text-[#25190c] shadow-[0_8px_18px_rgba(228,178,79,0.18)] ring-1 ring-[#e4b24f]/70' : 'bg-white text-[#7b5625] shadow-[0_6px_14px_rgba(119,89,44,0.10)] ring-1 ring-[#dbc398]') 
                      : (isDarkMode ? 'text-[#b8a38a] hover:text-[#f4e7d7] hover:bg-white/5' : 'text-[#8d7b65] hover:text-[#785a42] hover:bg-white/80')
                  }`}
                >
                  <span className="relative z-10 tracking-[0.1em] text-[12px]">EN</span>
                </button>
              </div>
            </div>
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-500/10">
              <div>
                <span className={`ka-setting-item-title block ${isDarkMode ? 'text-[#f1e6d7]' : 'text-[#54402d]'}`}>{proactiveTitle}</span>
                <span className={`ka-copy-sm ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{proactiveDesc}</span>
              </div>
              <div className="flex-shrink-0 overflow-visible">
                <SettingsToggle
                  checked={enableProactive}
                  onClick={onToggleProactive}
                  activeTrackClass={activeTrackClass}
                  inactiveTrackClass={inactiveTrackClass}
                  ariaLabel={proactiveTitle}
                />
              </div>
            </div>
            {showWebPushFallback && (
              <div className="flex items-center justify-between mt-2 pt-2 border-t border-dashed border-gray-500/10 opacity-70">
                <div>
                  <span className={`ka-copy-sm font-semibold block ${isDarkMode ? 'text-[#d7c7b5]' : 'text-[#6f5438]'}`}>{webPushTitle}</span>
                </div>
                <button onClick={onSubscribePush} disabled={isPushActionDisabled} className={`px-2 py-1 rounded ka-label transition-all ${isPushActionDisabled && !isSubscribing ? 'bg-green-600 text-white cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-500 text-white shadow-md'}`}>
                  {pushButtonLabel}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
