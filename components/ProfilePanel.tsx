
import React from 'react';
import { X, User, Music, Calendar, Heart, Ruler, Activity, Cpu } from 'lucide-react';
import { Language, EmotionType } from '../types';
import { UI_TRANSLATIONS } from '../constants';

interface ProfilePanelProps {
  isOpen: boolean;
  onClose: () => void;
  isDarkMode: boolean;
  language?: Language;
  currentEmotion?: EmotionType; // Optional to prevent breaking if not passed immediately
  turnCount?: number;           // Optional
  summaryProgressText?: string;
}

export const ProfilePanel: React.FC<ProfilePanelProps> = ({ 
    isOpen, 
    onClose, 
    isDarkMode, 
    language = 'zh',
    currentEmotion = 'neutral',
    turnCount = 0,
    summaryProgressText = ''
}) => {
  if (!isOpen) return null;
  
  const t = UI_TRANSLATIONS[language];

  const bgClass = isDarkMode ? 'bg-black/95 border-yellow-900/50' : 'bg-white/95 border-yellow-500/30';
  const textClass = isDarkMode ? 'text-yellow-100' : 'text-gray-800';
  const titleClass = isDarkMode ? 'text-yellow-500' : 'text-[#b8860b]';
  const labelClass = isDarkMode ? 'text-yellow-700' : 'text-yellow-600/80';
  const cardBg = isDarkMode ? 'bg-yellow-900/10' : 'bg-yellow-50';

  // Localized Profile Data
  const profileData = {
    name: language === 'zh' ? '黄前 久美子' : 'OUMAE KUMIKO',
    school: language === 'zh' ? '北宇治高中' : 'Kitauji High School', 
    birthday: language === 'zh' ? '8月21日 (狮子座)' : 'August 21 (Leo)',
    height: '162 cm',
    instrument: language === 'zh' ? '上低音号 (Euphonium)' : 'Euphonium',
    identity: language === 'zh' ? '北宇治高中 吹奏乐部原部长' : 'Former President of Kitauji High School Concert Band',
    likes: language === 'zh' ? '蛋料理、玉米浓汤、意大利面' : 'Egg dishes, Corn soup, Italian pasta'
  };

  const InfoRow = ({ icon: Icon, label, value }: { icon: any, label: string, value: string }) => (
    <div className={`flex items-center gap-4 p-3 rounded border border-transparent hover:border-yellow-600/20 transition-colors ${cardBg}`}>
      <div className={`p-2 rounded-full ${isDarkMode ? 'bg-yellow-900/30 text-yellow-500' : 'bg-yellow-100 text-[#b8860b]'}`}>
        <Icon size={18} />
      </div>
      <div>
        <p className={`text-xs font-mono font-bold uppercase tracking-wider ${labelClass}`}>{label}</p>
        <p className={`text-sm md:text-base font-medium ${textClass}`}>{value}</p>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm safe-area-padding-modal" style={{ background: 'radial-gradient(circle, rgba(0,0,0,0.6) 30%, rgba(0,0,0,0) 100%)' }}>
      <div className={`w-full max-w-md max-h-[90dvh] rounded-lg border shadow-2xl flex flex-col overflow-hidden animate-[breathe_0.3s_ease-out] relative ${bgClass}`}>
        
        {/* Decorative Scanline */}
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-yellow-600 to-transparent opacity-50"></div>

        {/* Header */}
        <div className={`flex items-center justify-between px-6 py-4 border-b ${isDarkMode ? 'border-yellow-900/30' : 'border-gray-200'}`}>
          <div className="flex items-center gap-3">
            <User size={20} className={titleClass} />
            <span className={`font-mono font-bold tracking-wider text-lg ${titleClass}`}>{t.profileTitle}</span>
          </div>
          <button 
            onClick={onClose}
            className={`p-1.5 rounded-full hover:bg-red-500/10 hover:text-red-500 transition-colors ${textClass}`}
          >
            <X size={20} />
          </button>
        </div>

        {/* Content - Scrollable */}
        <div className="flex-1 p-6 flex flex-col gap-3 overflow-y-auto scrollbar-thin">
          <div className="flex items-end justify-between mb-2">
            <div>
              <h2 className={`text-2xl font-bold ${titleClass}`}>
                {profileData.name}
              </h2>
              <p className={`font-mono text-sm opacity-70 ${textClass}`}>
                {profileData.school}
              </p>
            </div>
            <div className={`px-2 py-0.5 rounded text-xs font-mono border ${isDarkMode ? 'border-yellow-600/50 text-yellow-500' : 'border-yellow-600/30 text-yellow-700'}`}>
              {t.statusActive}
            </div>
          </div>

          {/* --- MOBILE EXCLUSIVE TELEMETRY MODULE --- */}
          {/* Synchronized with App.tsx overlay data */}
          <div className="md:hidden mb-2 pt-2 border-t border-dashed border-gray-500/20 animate-in slide-in-from-bottom-2">
              <div className={`flex items-center gap-2 mb-2 ${isDarkMode ? 'text-yellow-500' : 'text-yellow-700'}`}>
                  <Activity size={14} />
                  <h3 className="text-xs font-mono font-bold uppercase tracking-widest">
                      {language === 'zh' ? '神经连结状态 (实时)' : 'NEURAL LINK STATUS'}
                  </h3>
              </div>
              <div className={`grid grid-cols-2 gap-2 p-3 rounded border ${isDarkMode ? 'bg-black/40 border-yellow-900/50' : 'bg-white border-yellow-400/50'}`}>
                  <div className="flex flex-col gap-1">
                      <span className={`text-[10px] font-mono font-bold uppercase tracking-wider ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>SYS-ID</span>
                      <div className="flex items-center gap-1">
                          <Cpu size={12} className={titleClass} />
                          <span className={`text-sm font-mono font-bold ${titleClass}`}>7759-KUMIKO-V3</span>
                      </div>
                  </div>
                  <div className="flex flex-col gap-1">
                      <span className={`text-[10px] font-mono font-bold uppercase tracking-wider ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{t.emotionLabel}</span>
                      <span className={`text-sm font-mono font-bold ${textClass}`}>{currentEmotion.toUpperCase()}</span>
                  </div>
                  <div className="flex flex-col gap-1">
                      <span className={`text-[10px] font-mono font-bold uppercase tracking-wider ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{t.turnsLabel}</span>
                      <span className={`text-sm font-mono font-bold ${textClass}`}>{turnCount}</span>
                  </div>
                  <div className="flex flex-col gap-1">
                      <span className={`text-[10px] font-mono font-bold uppercase tracking-wider ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{t.nextSyncLabel}</span>
                      <span className={`text-sm font-mono font-bold text-yellow-600`}>{summaryProgressText}</span>
                  </div>
              </div>
          </div>
          {/* --- END MOBILE MODULE --- */}

          <InfoRow icon={Calendar} label={t.profileBirthday} value={profileData.birthday} />
          <InfoRow icon={Ruler} label={t.profileHeight} value={profileData.height} />
          <InfoRow icon={Music} label={t.profileInstrument} value={profileData.instrument} />
          <InfoRow icon={User} label={t.profileOccupation} value={profileData.identity} />
          <InfoRow icon={Heart} label={t.profileLikes} value={profileData.likes} />

          <div className={`mt-2 p-3 rounded text-sm italic opacity-80 ${isDarkMode ? 'bg-black/30 text-yellow-200/70' : 'bg-gray-100 text-gray-600'}`}>
            "{t.profileQuote}"
          </div>
        </div>

        {/* Footer */}
        <div className={`p-3 bg-opacity-30 flex justify-end ${isDarkMode ? 'bg-black' : 'bg-gray-50'}`}>
           <span className={`text-[10px] font-mono ${isDarkMode ? 'text-yellow-900/50' : 'text-gray-400'}`}>AMADEUS DATABASE // VER 3.04</span>
        </div>
      </div>
    </div>
  );
};
