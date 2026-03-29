import React from 'react';
import { ChevronDown, ChevronUp, Clock, Globe, MapPin, Settings, Watch } from 'lucide-react';
import { LocationConfig, Language } from '../../types';

interface BilingualOption {
  value: string;
  zh: string;
  en: string;
}

interface LocationSectionTranslations {
  locationTitle: string;
  locationDesc: string;
  modelLocation: string;
  userLocation: string;
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
  return (
    <div className={`flex flex-col rounded-lg border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between p-4 w-full">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-full ${isDarkMode ? 'bg-orange-900/30 text-orange-400' : 'bg-orange-100 text-orange-700'}`}>
            <MapPin size={20} />
          </div>
          <div className="text-left">
            <h3 className={`font-bold text-sm ${isDarkMode ? 'text-yellow-100' : 'text-gray-900'}`}>{t.locationTitle}</h3>
            {!isOpen && <p className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{t.locationDesc}</p>}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className="opacity-50" /> : <ChevronDown size={16} className="opacity-50" />}
      </button>

      {isOpen && locationConfig && (
        <div className="p-4 pt-0 animate-in slide-in-from-top-2 flex flex-col gap-4 max-h-[350px] overflow-y-auto overflow-x-hidden scrollbar-thin">
          <div className={innerCardClass}>
            <p className={`text-xs mb-3 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{t.locationDesc}</p>
            <div className="mb-4">
              <h4 className={`text-xs font-bold mb-2 flex items-center gap-2 ${isDarkMode ? 'text-orange-400' : 'text-orange-600'}`}>
                <Settings size={12} /> {t.modelLocation}
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-2">
                <div>
                  <label className={labelClass}>{t.country}</label>
                  <select value={locationConfig.modelCountry} onChange={(e) => onLocationUpdate('modelCountry', e.target.value)} className={inputClass}>
                    {countries.map((c) => <option key={c.value} value={c.value}>{l(c)}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>{t.timezone}</label>
                  <select value={locationConfig.modelTimezone} onChange={(e) => onLocationUpdate('modelTimezone', e.target.value)} className={inputClass}>
                    {timezones.map((tz) => <option key={tz.value} value={tz.value}>{l(tz)}</option>)}
                  </select>
                </div>
              </div>
              <div className={`flex items-center gap-2 p-2 rounded text-[11px] font-mono font-bold border transition-colors ${isDarkMode ? 'bg-black/40 border-orange-500/30 text-orange-400' : 'bg-orange-50 border-orange-300 text-orange-700'}`}>
                <Watch size={14} className="animate-pulse" />
                <span>{modelPreviewTime || 'Calculating...'}</span>
              </div>
            </div>
            <div className={`w-full h-px mb-4 ${isDarkMode ? 'bg-white/10' : 'bg-gray-200'}`}></div>
            <div>
              <h4 className={`text-xs font-bold mb-2 flex items-center gap-2 ${isDarkMode ? 'text-blue-400' : 'text-blue-600'}`}>
                <Globe size={12} /> {t.userLocation}
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-2">
                <div>
                  <label className={labelClass}>{t.country}</label>
                  <select value={locationConfig.userCountry} onChange={(e) => onLocationUpdate('userCountry', e.target.value)} className={inputClass}>
                    {countries.map((c) => <option key={c.value} value={c.value}>{l(c)}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>{t.timezone}</label>
                  <select value={locationConfig.userTimezone} onChange={(e) => onLocationUpdate('userTimezone', e.target.value)} className={inputClass}>
                    {timezones.map((tz) => <option key={tz.value} value={tz.value}>{l(tz)}</option>)}
                  </select>
                </div>
              </div>
              <div className={`flex items-center gap-2 p-2 rounded text-[11px] font-mono font-bold border transition-colors ${isDarkMode ? 'bg-black/40 border-green-500/30 text-green-400' : 'bg-green-50 border-green-300 text-green-700'}`}>
                <Watch size={14} className="animate-pulse" />
                <span>{previewTime || 'Calculating...'}</span>
              </div>
            </div>
          </div>
          <div className="flex items-start gap-2 p-2 rounded bg-orange-500/10 border border-orange-500/20 text-orange-500 text-[10px] font-mono mt-1">
            <Clock size={12} className="mt-0.5 flex-shrink-0" />
            <p>{t.timezoneHelp || 'Timezones follow IANA standard.'}</p>
          </div>
        </div>
      )}
    </div>
  );
};
