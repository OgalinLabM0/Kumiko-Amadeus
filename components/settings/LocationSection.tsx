import React, { useMemo } from 'react';
import { ChevronDown, ChevronUp, Clock, Globe, Lock, MapPin, Watch } from 'lucide-react';
import { LocationConfig, Language } from '../../types';
import { Collapse } from '../Collapse';
import { ThemedSelect, type ThemedSelectOption } from '../common/ThemedSelect';

interface BilingualOption {
  value: string;
  zh: string;
  en: string;
}

interface LocationSectionTranslations {
  locationTitle: string;
  locationDesc: string;
  modelLocation: string;
  modelLocationDesc?: string;
  modelTimezoneLocked?: string;
  userLocation: string;
  userLocationDesc?: string;
  country: string;
  timezone: string;
  timezoneHelp?: string;
}

interface LocationSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  language: Language;
  sectionBorder: string;
  innerCardClass: string;
  inputClass: string;
  labelClass: string;
  t: LocationSectionTranslations;
  locationConfig?: LocationConfig;
  countries: BilingualOption[];
  timezones: BilingualOption[];
  modelPreviewTime: string;
  previewTime: string;
  onLocationUpdate: (key: keyof LocationConfig, value: string) => void;
}

export const LocationSection: React.FC<LocationSectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  language,
  sectionBorder,
  innerCardClass,
  inputClass,
  labelClass,
  t,
  locationConfig,
  countries,
  timezones,
  modelPreviewTime,
  previewTime,
  onLocationUpdate
}) => {
  const l = (opt: BilingualOption) => language === 'zh' ? opt.zh : opt.en;
  const japanLabel = language === 'zh' ? '日本' : 'Japan';
  const tokyoLabel = language === 'zh' ? '亚洲/东京（日本、韩国）' : 'Asia/Tokyo (Japan, Korea)';
  const countryOptions = useMemo<ThemedSelectOption[]>(
    () => countries.map(c => ({ value: c.value, label: l(c) })),
    [countries, language],
  );
  const timezoneOptions = useMemo<ThemedSelectOption[]>(
    () => timezones.map(tz => ({ value: tz.value, label: l(tz) })),
    [timezones, language],
  );
  return (
    <div className={`flex flex-col rounded-[1.2rem] border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between px-4 py-[1.05rem] w-full">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-2xl border ${isDarkMode ? 'border-orange-500/20 bg-orange-900/20 text-orange-300' : 'border-orange-200 bg-orange-50/90 text-orange-700'}`}>
            <MapPin size={18} />
          </div>
          <div className="text-left">
            <h3 className={`ka-section-title ${isDarkMode ? 'text-[#f5ebdc]' : 'text-[#49301f]'}`}>{t.locationTitle}</h3>
            {!isOpen && <p className={`ka-section-desc ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{t.locationDesc}</p>}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} /> : <ChevronDown size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />}
      </button>

      <Collapse isOpen={isOpen && !!locationConfig}>
        <div className="px-4 pb-4 pt-0 flex flex-col gap-4 overflow-visible">
          <div className={innerCardClass}>
            <p className={`ka-copy-sm mb-3 ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{t.locationDesc}</p>
            <div className="mb-4">
              <h4 className={`ka-setting-item-title mb-2 flex items-center gap-2 ${isDarkMode ? 'text-orange-400' : 'text-orange-600'}`}>
                <Watch size={12} /> {t.modelLocation}
              </h4>
              {t.modelLocationDesc && (
                <p className={`ka-copy-sm mb-3 ${isDarkMode ? 'text-[#c8b49d]' : 'text-[#866a4b]'}`}>{t.modelLocationDesc}</p>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-2">
                <div>
                  <label className={labelClass}>{t.country}</label>
                  <div className={`${inputClass} flex items-center justify-between opacity-80 cursor-not-allowed`}>
                    <span>{japanLabel}</span>
                    <Lock size={14} className={isDarkMode ? 'text-orange-300/70' : 'text-orange-700/70'} />
                  </div>
                </div>
                <div>
                  <label className={labelClass}>{t.timezone}</label>
                  <div className={`${inputClass} flex items-center justify-between opacity-80 cursor-not-allowed`}>
                    <span>{tokyoLabel}</span>
                    <Lock size={14} className={isDarkMode ? 'text-orange-300/70' : 'text-orange-700/70'} />
                  </div>
                </div>
              </div>
              <div className={`flex items-center gap-2 p-2 rounded ka-copy-sm font-mono font-semibold border transition-colors ${isDarkMode ? 'bg-black/40 border-orange-500/30 text-orange-400' : 'bg-orange-50 border-orange-300 text-orange-700'}`}>
                <Watch size={14} className="animate-pulse" />
                <span>{modelPreviewTime || 'Calculating...'}</span>
              </div>
              {t.modelTimezoneLocked && (
                <div className={`mt-2 flex items-start gap-2 rounded-xl border px-3 py-2 ka-copy-sm ${isDarkMode ? 'border-orange-500/20 bg-orange-500/10 text-orange-200/85' : 'border-orange-200 bg-orange-50/70 text-orange-700'}`}>
                  <Lock size={12} className="mt-0.5 flex-shrink-0" />
                  <p>{t.modelTimezoneLocked}</p>
                </div>
              )}
            </div>
            <div className={`w-full h-px mb-4 ${isDarkMode ? 'bg-white/10' : 'bg-gray-200'}`}></div>
            <div>
              <h4 className={`ka-setting-item-title mb-2 flex items-center gap-2 ${isDarkMode ? 'text-blue-400' : 'text-blue-600'}`}>
                <Globe size={12} /> {t.userLocation}
              </h4>
              {t.userLocationDesc && (
                <p className={`ka-copy-sm mb-3 ${isDarkMode ? 'text-[#c8b49d]' : 'text-[#866a4b]'}`}>{t.userLocationDesc}</p>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-2">
                <div>
                  <label className={labelClass}>{t.country}</label>
                  <ThemedSelect
                    value={locationConfig.userCountry}
                    onChange={(val) => onLocationUpdate('userCountry', val)}
                    options={countryOptions}
                    isDarkMode={isDarkMode}
                    className={inputClass}
                    ariaLabel={t.country}
                  />
                </div>
                <div>
                  <label className={labelClass}>{t.timezone}</label>
                  <ThemedSelect
                    value={locationConfig.userTimezone}
                    onChange={(val) => onLocationUpdate('userTimezone', val)}
                    options={timezoneOptions}
                    isDarkMode={isDarkMode}
                    className={inputClass}
                    ariaLabel={t.timezone}
                  />
                </div>
              </div>
              <div className={`flex items-center gap-2 p-2 rounded ka-copy-sm font-mono font-semibold border transition-colors ${isDarkMode ? 'bg-black/40 border-green-500/30 text-green-400' : 'bg-green-50 border-green-300 text-green-700'}`}>
                <Watch size={14} className="animate-pulse" />
                <span>{previewTime || 'Calculating...'}</span>
              </div>
            </div>
          </div>
          <div className="flex items-start gap-2 p-2 rounded bg-orange-500/10 border border-orange-500/20 text-orange-500 ka-copy-sm mt-1">
            <Clock size={12} className="mt-0.5 flex-shrink-0" />
            <p>{t.timezoneHelp || 'Timezones follow IANA standard.'}</p>
          </div>
        </div>
      </Collapse>
    </div>
  );
};
