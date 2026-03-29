import React from 'react';
import { Book, ChevronDown, ChevronUp } from 'lucide-react';

interface GuideSectionTranslations {
  guideTitle: string;
  guideDesc: string;
  viewFullGuide: string;
}

interface GuideSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  onOpenGuide: () => void;
  isDarkMode: boolean;
  t: GuideSectionTranslations;
  sectionBorder: string;
}

export const GuideSection: React.FC<GuideSectionProps> = ({
  isOpen,
  onToggle,
  onOpenGuide,
  isDarkMode,
  t,
  sectionBorder
}) => {
  return (
    <div className={`flex flex-col rounded-lg border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between p-4 w-full">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-full ${isDarkMode ? 'bg-yellow-900/30 text-yellow-400' : 'bg-yellow-100 text-yellow-700'}`}>
            <Book size={20} />
          </div>
          <div className="text-left">
            <h3 className={`font-bold text-sm ${isDarkMode ? 'text-yellow-100' : 'text-gray-900'}`}>{t.guideTitle}</h3>
            {!isOpen && <p className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{t.guideDesc}</p>}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className="opacity-50" /> : <ChevronDown size={16} className="opacity-50" />}
      </button>

      {isOpen && (
        <div className="p-4 pt-0 animate-in slide-in-from-top-2">
          <p className={`text-xs mb-3 font-mono ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{t.guideDesc}</p>
          <button
            onClick={onOpenGuide}
            className={`w-full py-3 rounded border border-dashed flex items-center justify-center gap-2 font-mono font-bold text-xs transition-all ${
              isDarkMode
                ? 'border-yellow-500/50 text-yellow-500 hover:bg-yellow-500/10'
                : 'border-[#b8860b]/50 text-[#b8860b] hover:bg-[#b8860b]/10'
            }`}
          >
            <Book size={14} /> {t.viewFullGuide}
          </button>
        </div>
      )}
    </div>
  );
};
