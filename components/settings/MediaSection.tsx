import React, { useMemo } from 'react';
import { ChevronDown, ChevronUp, Image as ImageIcon } from 'lucide-react';
import { Collapse } from '../Collapse';
import { useAppStore } from '../../store';
import type { ImageQualityPreset } from '../../constants/imageQualityConfig';
import { ThemedSelect, type ThemedSelectOption } from '../common/ThemedSelect';

// P1 #36: new SettingsPanel tile for image-related preferences. The first (and
// currently only) setting it hosts is the image quality preset — this used to
// be hard-coded to 1024×1024 / 200KB inside imageService.ts, which aggressively
// degraded screenshots, menus, handwritten notes, etc. The four presets are
// defined in constants/imageQualityConfig.ts.
interface MediaSectionTranslations {
  mediaTitle: string;
  mediaDesc: string;
  imageQuality: string;
  imgQ_original: string;
  imgQ_high: string;
  imgQ_standard: string;
  imgQ_compact: string;
  imgQHelp_original: string;
  imgQHelp_high: string;
  imgQHelp_standard: string;
  imgQHelp_compact: string;
}

interface MediaSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  t: MediaSectionTranslations;
  sectionBorder: string;
}

export const MediaSection: React.FC<MediaSectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  t,
  sectionBorder,
}) => {
  const preset = useAppStore(s => s.imageQualityPreset);
  const setPreset = useAppStore(s => s.setImageQualityPreset);

  const helpByPreset: Record<ImageQualityPreset, string> = {
    original: t.imgQHelp_original,
    high: t.imgQHelp_high,
    standard: t.imgQHelp_standard,
    compact: t.imgQHelp_compact,
  };

  const qualitySelectClass = `w-full rounded-lg px-3 py-2 ka-input-copy border transition-colors ${isDarkMode ? 'bg-[#211811] border-[#8c6a3c] text-[#f2e5cf] focus:border-sky-500' : 'bg-white border-[#d7cebf] text-[#4c3a2b] focus:border-sky-600'}`;
  const qualityOptions = useMemo<ThemedSelectOption[]>(
    () => [
      { value: 'original', label: t.imgQ_original },
      { value: 'high', label: t.imgQ_high },
      { value: 'standard', label: t.imgQ_standard },
      { value: 'compact', label: t.imgQ_compact },
    ],
    [t.imgQ_original, t.imgQ_high, t.imgQ_standard, t.imgQ_compact],
  );

  return (
    <div className={`flex flex-col rounded-[1.2rem] border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between px-4 py-[1.05rem] w-full">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-2xl border shrink-0 ${isDarkMode ? 'border-sky-500/20 bg-sky-900/20 text-sky-300' : 'border-sky-200 bg-sky-50/90 text-sky-700'}`}>
            <ImageIcon size={18} />
          </div>
          <div className="text-left">
            <h3 className={`ka-section-title ${isDarkMode ? 'text-[#f5ebdc]' : 'text-[#49301f]'}`}>{t.mediaTitle}</h3>
            {!isOpen && <p className={`ka-section-desc ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{t.mediaDesc}</p>}
          </div>
        </div>
        {isOpen
          ? <ChevronUp size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />
          : <ChevronDown size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />}
      </button>

      <Collapse isOpen={isOpen}>
        <div className="px-4 pb-4 pt-0 flex flex-col gap-4">
          <p className={`ka-copy-sm ${isDarkMode ? 'text-[#cdbca9]' : 'text-[#7c6245]'}`}>{t.mediaDesc}</p>

          <div className="flex flex-col gap-2">
            <label className={`ka-setting-item-title ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
              {t.imageQuality}
            </label>
            <ThemedSelect
              value={preset}
              onChange={(val) => setPreset(val as ImageQualityPreset)}
              options={qualityOptions}
              isDarkMode={isDarkMode}
              className={qualitySelectClass}
              ariaLabel={t.imageQuality}
            />
            <p className={`ka-copy-xs leading-relaxed ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>
              {helpByPreset[preset]}
            </p>
          </div>
        </div>
      </Collapse>
    </div>
  );
};
