import React from 'react';
import { AlertTriangle, Loader2, WifiOff, Settings } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { UI_TRANSLATIONS } from '../../constants/uiTranslations';

// v2.14.4 A.1: 三个状态 overlay 改为 i18n。原硬编码英文（"LOADING DATA..." /
// "ESTABLISHING NEURAL LINK..." / "NEURAL LINK FAILED" 等）下放到
// constants/uiTranslations.ts 的 errorOverlay* / loadingDataLine /
// connectingNeuralLink 五个键。`language` 由调用方（App.tsx 与
// AppFlowScreens.tsx）从 useAppStore(s => s.language) 透传进来，
// store 是响应式的 → 切换 UI 语言时三段文案立即重渲染。
type OverlayLanguage = 'zh' | 'en';

interface LoadingDataScreenProps {
  language: OverlayLanguage;
}

export const LoadingDataScreen: React.FC<LoadingDataScreenProps> = ({ language }) => {
  const t = UI_TRANSLATIONS[language];
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-[#f9f7f2] dark:bg-[#1b140d]">
      <div className="animate-pulse flex flex-col items-center">
        <div className="w-12 h-12 border-4 border-orange-500 border-t-transparent rounded-full animate-spin"></div>
        <p className="mt-4 ka-kicker font-mono text-orange-600 dark:text-orange-400">{t.loadingDataLine}</p>
      </div>
    </div>
  );
};

interface AppConnectingOverlayProps {
  isOpen: boolean;
  language: OverlayLanguage;
}

export const AppConnectingOverlay: React.FC<AppConnectingOverlayProps> = ({ isOpen, language }) => {
  const t = UI_TRANSLATIONS[language];
  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center text-yellow-600 backdrop-blur-sm gap-3"
      style={{
        background: 'radial-gradient(circle, rgba(0,0,0,0.8) 30%, rgba(0,0,0,0) 100%)',
        opacity: isOpen ? 1 : 0,
        visibility: isOpen ? 'visible' : 'hidden',
        pointerEvents: isOpen ? 'auto' : 'none',
        transition: isOpen ? 'opacity 220ms ease-out, visibility 0s 0s' : 'opacity 180ms ease-in, visibility 0s 180ms',
      }}
      aria-hidden={!isOpen}
      inert={!isOpen}
    >
      <Loader2 className="animate-spin" size={24} />
      <span className="ka-kicker font-mono tracking-[0.2em]">{t.connectingNeuralLink}</span>
    </div>
  );
};

interface AppErrorOverlayProps {
  isOpen: boolean;
  language: OverlayLanguage;
  onReconfigure: () => void;
}

interface DisconnectedBannerProps {
  isVisible: boolean;
  isDarkMode: boolean;
  language: 'zh' | 'en';
  onOpenSettings?: () => void;
}

export const DisconnectedBanner: React.FC<DisconnectedBannerProps> = ({ isVisible, isDarkMode, language, onOpenSettings }) => (
  <AnimatePresence>
    {isVisible && (
      // Phase 7 Part t11_modal_toast: the banner is rendered just
      // under the chat header on desktop, but on mobile we mount it
      // at the top of the shell. Pad with env(safe-area-inset-top) so
      // iOS notches don't eat the wifi-off icon. Desktop keeps its
      // flush appearance since env() === 0.
      <motion.div
        initial={{ y: -40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: -40, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        style={{ paddingTop: 'calc(0.5rem + var(--sat))' }}
        className={`
          flex items-center justify-center gap-2 px-4 pb-2 z-[120]
          backdrop-blur-md border-b
          ${isDarkMode
            ? 'bg-red-950/60 border-red-800/40 text-red-300'
            : 'bg-red-50/80 border-red-200 text-red-700'
          }
        `}
      >
        <WifiOff size={14} className="flex-shrink-0 opacity-80" />
        <span className="ka-copy-sm font-semibold">
          {language === 'zh' ? '信号中断 · 消息发送失败' : 'Signal Lost · Message delivery failed'}
        </span>
        {onOpenSettings && (
          <button
            onClick={onOpenSettings}
            className={`
              flex items-center gap-1 px-2 py-0.5 rounded-full ka-micro font-semibold transition-colors ml-2
              ${isDarkMode
                ? 'bg-red-900/50 hover:bg-red-800/60 text-red-200'
                : 'bg-red-100 hover:bg-red-200 text-red-700'
              }
            `}
          >
            <Settings size={11} />
            {language === 'zh' ? '检查设置' : 'Settings'}
          </button>
        )}
      </motion.div>
    )}
  </AnimatePresence>
);

export const AppErrorOverlay: React.FC<AppErrorOverlayProps> = ({ isOpen, language, onReconfigure }) => {
  const t = UI_TRANSLATIONS[language];
  return (
    <div
      className="fixed inset-0 z-[200] flex flex-col items-center justify-center text-red-500 backdrop-blur-sm gap-4 p-6 text-center"
      style={{
        background: 'radial-gradient(circle, rgba(0,0,0,0.9) 30%, rgba(0,0,0,0) 100%)',
        opacity: isOpen ? 1 : 0,
        visibility: isOpen ? 'visible' : 'hidden',
        pointerEvents: isOpen ? 'auto' : 'none',
        transition: isOpen ? 'opacity 220ms ease-out, visibility 0s 0s' : 'opacity 180ms ease-in, visibility 0s 180ms',
      }}
      aria-hidden={!isOpen}
      inert={!isOpen}
    >
      <AlertTriangle size={48} className="mb-2" />
      <h2 className="font-mincho text-xl font-semibold tracking-[0.18em]">{t.errorOverlayTitle}</h2>
      <p className="ka-copy-sm opacity-70">{t.errorOverlayBody}</p>
      <button
        onClick={onReconfigure}
        className="mt-4 px-6 py-2 border border-red-500 text-red-500 hover:bg-red-500 hover:text-white transition-colors ka-label tracking-[0.14em]"
      >
        {t.errorOverlayReconfigBtn}
      </button>
    </div>
  );
};
