import React from 'react';
import { ChevronDown, ChevronUp, Globe } from 'lucide-react';

interface GeneralSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  sectionBorder: string;
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
  const innerCardClass = `p-3 rounded border ${isDarkMode ? 'bg-black/30 border-white/10' : 'bg-white border-gray-200'}`;

  return (
    <div className={`flex flex-col rounded-lg border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between p-4 w-full">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-full ${isDarkMode ? 'bg-purple-900/30 text-purple-400' : 'bg-purple-100 text-purple-700'}`}>
            <Globe size={20} />
          </div>
          <div className="text-left">
            <h3 className={`font-bold text-sm ${isDarkMode ? 'text-yellow-100' : 'text-gray-900'}`}>{title}</h3>
            {!isOpen && <p className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{desc}</p>}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className="opacity-50" /> : <ChevronDown size={16} className="opacity-50" />}
      </button>

      {isOpen && (
        <div className="p-4 pt-0 animate-in slide-in-from-top-2">
          <div className={innerCardClass}>
            <p className={`text-xs mb-3 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{desc}</p>
            <div className="flex items-center justify-between">
              <span className={`text-sm font-bold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>{languageLabel}</span>
              <div className="flex gap-1 bg-black/20 p-1 rounded">
                <button onClick={() => onLanguageChange('zh')} className={`px-3 py-1 rounded text-xs font-bold transition-all ${language === 'zh' ? (isDarkMode ? 'bg-yellow-600 text-black' : 'bg-white text-black shadow') : 'text-gray-500'}`}>中文</button>
                <button onClick={() => onLanguageChange('en')} className={`px-3 py-1 rounded text-xs font-bold transition-all ${language === 'en' ? (isDarkMode ? 'bg-yellow-600 text-black' : 'bg-white text-black shadow') : 'text-gray-500'}`}>EN</button>
              </div>
            </div>
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-500/10">
              <div>
                <span className={`text-sm font-bold block ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>{proactiveTitle}</span>
                <span className={`text-[10px] ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{proactiveDesc}</span>
              </div>
              <button onClick={onToggleProactive} className={`w-10 h-5 rounded-full relative transition-colors ${enableProactive ? 'bg-green-600' : 'bg-gray-600'}`}>
                <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-all ${enableProactive ? 'left-6' : 'left-1'}`}></div>
              </button>
            </div>
            {showWebPushFallback && (
              <div className="flex items-center justify-between mt-2 pt-2 border-t border-dashed border-gray-500/10 opacity-70">
                <div>
                  <span className={`text-xs font-bold block ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>{webPushTitle}</span>
                </div>
                <button onClick={onSubscribePush} disabled={isPushActionDisabled} className={`px-2 py-1 rounded text-[10px] font-bold transition-all ${isPushActionDisabled && !isSubscribing ? 'bg-green-600 text-white cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-500 text-white shadow-md'}`}>
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
