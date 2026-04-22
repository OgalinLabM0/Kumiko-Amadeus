import React, { useMemo } from 'react';
import { BookOpen, ChevronDown, ChevronUp } from 'lucide-react';
import { Collapse } from '../Collapse';
import { SettingsToggle } from './SettingsToggle';
import { useAppStore } from '../../store';
import type { DiaryLayerPreset } from '../../constants/diaryLayerConfig';
import { useAutoDiaryBackfill } from '../../hooks/useAutoDiaryBackfill';
import { ThemedSelect, type ThemedSelectOption } from '../common/ThemedSelect';

interface DiaryLifeSectionTranslations {
  diaryLifeTitle: string;
  diaryLifeDesc: string;
  diaryMemoryDepth: string;
  diaryDepth_economy: string;
  diaryDepth_balanced: string;
  diaryDepth_rich: string;
  diaryDepthHelp_economy: string;
  diaryDepthHelp_balanced: string;
  diaryDepthHelp_rich: string;
  autoDiaryBackfill: string;
  autoDiaryBackfillDesc: string;
}

interface DiaryLifeSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  t: DiaryLifeSectionTranslations;
  sectionBorder: string;
}

// Settings tile that owns diary-related configuration:
//   - diaryLayerPreset: how much diary history to inject per turn (see P0 #12)
//   - autoDiaryBackfill: whether to auto-generate missed diary entries in background
// Previously these lived scattered across DiaryPanel; centralizing per the
// "SettingsPanel = only configuration home" policy decided in the audit plan.
export const DiaryLifeSection: React.FC<DiaryLifeSectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  t,
  sectionBorder,
}) => {
  const diaryLayerPreset = useAppStore(s => s.diaryLayerPreset);
  const setDiaryLayerPreset = useAppStore(s => s.setDiaryLayerPreset);
  const [autoBackfill, setAutoBackfill] = useAutoDiaryBackfill();

  const descByPreset: Record<DiaryLayerPreset, string> = {
    economy: t.diaryDepthHelp_economy,
    balanced: t.diaryDepthHelp_balanced,
    rich: t.diaryDepthHelp_rich,
  };

  const depthSelectClass = `w-full rounded-lg px-3 py-2 ka-input-copy border transition-colors ${isDarkMode ? 'bg-[#211811] border-[#8c6a3c] text-[#f2e5cf] focus:border-amber-500' : 'bg-white border-[#d7cebf] text-[#4c3a2b] focus:border-amber-600'}`;
  const depthOptions = useMemo<ThemedSelectOption[]>(
    () => [
      { value: 'economy', label: t.diaryDepth_economy },
      { value: 'balanced', label: t.diaryDepth_balanced },
      { value: 'rich', label: t.diaryDepth_rich },
    ],
    [t.diaryDepth_economy, t.diaryDepth_balanced, t.diaryDepth_rich],
  );

  const toggleTrackActive = 'bg-green-600/95';
  const toggleTrackInactive = isDarkMode ? 'bg-[#3e3429]' : 'bg-[#d7d2ca]';

  return (
    <div className={`flex flex-col rounded-[1.2rem] border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between px-4 py-[1.05rem] w-full">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-2xl border ${isDarkMode ? 'border-amber-500/20 bg-amber-900/20 text-amber-300' : 'border-amber-200 bg-amber-50/90 text-amber-700'}`}>
            <BookOpen size={18} />
          </div>
          <div className="text-left">
            <h3 className={`ka-section-title ${isDarkMode ? 'text-[#f5ebdc]' : 'text-[#49301f]'}`}>{t.diaryLifeTitle}</h3>
            {!isOpen && <p className={`ka-section-desc ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{t.diaryLifeDesc}</p>}
          </div>
        </div>
        {isOpen
          ? <ChevronUp size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />
          : <ChevronDown size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />}
      </button>

      <Collapse isOpen={isOpen}>
        <div className="px-4 pb-4 pt-0 flex flex-col gap-4">
          <p className={`ka-copy-sm ${isDarkMode ? 'text-[#cdbca9]' : 'text-[#7c6245]'}`}>{t.diaryLifeDesc}</p>

          {/* Diary memory depth */}
          <div className="flex flex-col gap-2">
            <label className={`ka-setting-item-title ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
              {t.diaryMemoryDepth}
            </label>
            <ThemedSelect
              value={diaryLayerPreset}
              onChange={(val) => setDiaryLayerPreset(val as DiaryLayerPreset)}
              options={depthOptions}
              isDarkMode={isDarkMode}
              className={depthSelectClass}
              ariaLabel={t.diaryMemoryDepth}
            />
            <p className={`ka-copy-xs leading-relaxed ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>
              {descByPreset[diaryLayerPreset]}
            </p>
          </div>

          {/* Auto diary backfill toggle */}
          <div className="flex items-start justify-between gap-3 pt-3 border-t border-gray-500/15">
            <div className="flex flex-col">
              <span className={`ka-setting-item-title ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
                {t.autoDiaryBackfill}
              </span>
              <span className={`ka-copy-xs mt-0.5 ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>
                {t.autoDiaryBackfillDesc}
              </span>
            </div>
            <div className="flex-shrink-0">
              <SettingsToggle
                checked={autoBackfill}
                onClick={() => setAutoBackfill(prev => !prev)}
                activeTrackClass={toggleTrackActive}
                inactiveTrackClass={toggleTrackInactive}
                ariaLabel={t.autoDiaryBackfill}
              />
            </div>
          </div>
        </div>
      </Collapse>
    </div>
  );
};
