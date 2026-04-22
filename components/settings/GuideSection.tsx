import React from 'react';
import { Book, ChevronDown, ChevronUp } from 'lucide-react';
import { Collapse } from '../Collapse';

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
  innerCardClass: string;
}

export const GuideSection: React.FC<GuideSectionProps> = ({
  isOpen,
  onToggle,
  onOpenGuide,
  isDarkMode,
  t,
  sectionBorder,
  innerCardClass,
}) => {
  return (
    <div className={`flex flex-col rounded-[1.2rem] border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between px-4 py-[1.05rem] w-full">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-2xl border ${isDarkMode ? 'border-amber-500/20 bg-amber-900/20 text-amber-300' : 'border-amber-200 bg-amber-50/90 text-amber-700'}`}>
            <Book size={18} />
          </div>
          <div className="text-left">
            <h3 className={`ka-section-title ${isDarkMode ? 'text-[#f5ebdc]' : 'text-[#49301f]'}`}>{t.guideTitle}</h3>
            {!isOpen && <p className={`ka-section-desc ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{t.guideDesc}</p>}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} /> : <ChevronDown size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />}
      </button>

      <Collapse isOpen={isOpen}>
        <div className="px-4 pb-4 pt-0 flex flex-col gap-4">
          <div className={innerCardClass}>
            <p className={`ka-section-desc mb-3 ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{t.guideDesc}</p>
            <button
              onClick={onOpenGuide}
              className={`w-full py-3 rounded-xl border border-dashed flex items-center justify-center gap-2 ka-label transition-all ${
                isDarkMode
                  ? 'border-yellow-500/50 text-yellow-500 hover:bg-yellow-500/10'
                  : 'border-[#b8860b]/50 text-[#b8860b] hover:bg-[#b8860b]/10'
              }`}
            >
              <Book size={14} /> {t.viewFullGuide}
            </button>
          </div>
        </div>
      </Collapse>
    </div>
  );
};
