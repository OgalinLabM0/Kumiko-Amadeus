// components/settings/MobileSetupGuideModal.tsx
//
// Modal that walks the user through Tailscale setup for Mobile Remote
// Access. Rendered from MobileAccessSection (either via the header
// "View full guide" button or when the user clicks "Open tutorial
// section" on an error card). Reuses the left-sidebar + right-article
// layout pioneered by FullGuideModal, but renders from structured data
// in constants/mobileSetupGuideContent.ts instead of markdown.
//
// Structured (rather than markdown) because every link in this guide
// needs to route through openExternalUrl — we can't rely on `<a>` tags
// in Electron without hijacking the navigation event. Rendering from
// typed data also lets the MobileAccessSection deep-link into a
// specific step (`initialSectionId`) when showing a troubleshooting
// error.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Book,
  CheckCircle2,
  Download,
  ExternalLink,
  FileWarning,
  Info,
  Network,
  Server,
  Smartphone,
  X,
} from 'lucide-react';
import type { Language } from '../../types';
import {
  MOBILE_SETUP_GUIDE,
  type GuideSection,
  type MobileGuideSectionId,
} from '../../constants/mobileSetupGuideContent';
import { useModalKeyboard } from '../../hooks/useModalKeyboard';
import { useModalPortal } from '../../hooks/useModalPortal';
import { openExternalUrl } from '../../utils/openExternal';

interface MobileSetupGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
  language: Language;
  isDarkMode: boolean;
  initialSectionId?: MobileGuideSectionId;
}

const SECTION_ICONS: Record<MobileGuideSectionId, React.ElementType> = {
  'step0-install': Download,
  'step1-https': Network,
  'step2-enable': Server,
  'step3-phone': Smartphone,
  'step4-errors': FileWarning,
};

export const MobileSetupGuideModal: React.FC<MobileSetupGuideModalProps> = ({
  isOpen,
  onClose,
  language,
  isDarkMode,
  initialSectionId,
}) => {
  const sections = useMemo<GuideSection[]>(
    () => MOBILE_SETUP_GUIDE[language] || MOBILE_SETUP_GUIDE.zh,
    [language],
  );

  const defaultId = sections[0]?.id ?? 'step0-install';
  const [activeId, setActiveId] = useState<MobileGuideSectionId>(initialSectionId || defaultId);
  const [isClosing, setIsClosing] = useState(false);
  const articleScrollRef = useRef<HTMLDivElement | null>(null);
  const renderPortal = useModalPortal();

  const isVisible = isOpen || isClosing;

  useEffect(() => {
    if (isOpen) {
      setIsClosing(false);
      setActiveId(initialSectionId || defaultId);
    }
  }, [isOpen, initialSectionId, defaultId]);

  useEffect(() => {
    if (!isOpen || !articleScrollRef.current) return;
    articleScrollRef.current.scrollTop = 0;
  }, [activeId, isOpen]);

  const handleClose = useCallback(() => {
    setIsClosing(true);
  }, []);

  useModalKeyboard({ isOpen, onClose: handleClose });

  const handleAnimationEnd = (e: React.AnimationEvent) => {
    if (isClosing && e.animationName === 'mobileGuideOut') {
      setIsClosing(false);
      onClose();
    }
  };

  const activeSection = sections.find((s) => s.id === activeId) || sections[0];
  const activeIndex = sections.findIndex((s) => s.id === (activeSection?.id || defaultId));
  const ActiveIcon = activeSection ? SECTION_ICONS[activeSection.id] || Info : Info;

  if (!isVisible || !activeSection) return null;

  const bgClass = isDarkMode ? 'bg-[#161412] border-[#2a2522]/60' : 'bg-[#faf6f0] border-[#e6ddcf]';
  const titleClass = isDarkMode ? 'text-[#d4a852]' : 'text-[#8a6122]';
  const textClass = isDarkMode ? 'text-[#f1e6d7]' : 'text-[#3d2a18]';
  const mutedClass = isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]';
  const panelClass = isDarkMode ? 'bg-[#1e1c1a] border-[#2a2522]/40' : 'bg-white border-[#e6ddcf]';
  const panelMutedClass = isDarkMode ? 'bg-[#211912] border-[#4f3b2a]' : 'bg-[#faf5ee] border-[#eadfce]';
  const linkBtnClass = isDarkMode
    ? 'inline-flex items-center gap-1.5 rounded-full border border-[#4f3b2a] bg-[#211912] px-3 py-1.5 text-[13px] font-medium text-[#d4a852] hover:bg-[#2a1e12] transition-colors'
    : 'inline-flex items-center gap-1.5 rounded-full border border-[#e0c58f] bg-[#fff8ea] px-3 py-1.5 text-[13px] font-medium text-[#8a6122] hover:bg-[#fceecb] transition-colors';
  const animClass = isClosing
    ? 'animate-[mobileGuideOut_200ms_ease-in_forwards]'
    : 'animate-[mobileGuideIn_300ms_ease-out]';
  const backdropAnimClass = isClosing
    ? 'animate-[mobileGuideBackdropOut_200ms_ease-in_forwards]'
    : 'animate-[mobileGuideBackdropIn_300ms_ease-out]';

  const handleLinkClick = async (url: string) => {
    await openExternalUrl(url);
  };

  // Phase 7 Part t5_a3_mobile_setup_guide: portal into <body> so the backdrop
  // is relative to the viewport, not the SettingsPanel `ka-settings-shell`
  // (which has `contain: layout style paint` + `transform` and would otherwise
  // clip this modal to the settings window on desktop compact mode).
  return renderPortal(
    <>
      <style>{`
        @keyframes mobileGuideIn {
          from { transform: translateY(24px) scale(0.97); opacity: 0; }
          to { transform: translateY(0) scale(1); opacity: 1; }
        }
        @keyframes mobileGuideOut {
          from { transform: translateY(0) scale(1); opacity: 1; }
          to { transform: translateY(12px) scale(0.98); opacity: 0; }
        }
        @keyframes mobileGuideBackdropIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes mobileGuideBackdropOut {
          from { opacity: 1; }
          to { opacity: 0; }
        }
      `}</style>
      <div
        className={`ka-mobile-fullbleed-backdrop fixed inset-0 z-[120] flex items-center justify-center p-4 backdrop-blur-sm safe-area-padding-modal ${backdropAnimClass}`}
        style={{ background: 'radial-gradient(circle, rgba(0,0,0,0.62) 30%, rgba(0,0,0,0) 100%)' }}
      >
        <div
          className={`ka-mobile-fullbleed-sheet relative w-full max-w-6xl h-full max-h-[92dvh] rounded-[1.2rem] border shadow-2xl overflow-hidden flex flex-col ${animClass} ${bgClass}`}
          style={{ contain: 'layout style paint' }}
          onAnimationEnd={handleAnimationEnd}
        >
          <div className={`absolute top-0 left-0 w-full h-[2px] ${isDarkMode ? 'bg-gradient-to-r from-transparent via-[#d4a852]/50 to-transparent' : 'bg-gradient-to-r from-transparent via-[#b8860b]/30 to-transparent'}`}></div>

          {/* Header */}
          <div className={`flex items-center justify-between px-6 py-4 border-b ${isDarkMode ? 'border-[#2a2522]/50' : 'border-[#e6ddcf]'}`}>
            <div className="flex items-center gap-3 min-w-0">
              <div className={`flex h-10 w-10 items-center justify-center rounded-2xl border ${isDarkMode ? 'border-amber-500/20 bg-amber-900/20 text-amber-300' : 'border-amber-200 bg-amber-50/90 text-amber-700'}`}>
                <Book size={18} />
              </div>
              <div className="min-w-0">
                <div className={`text-xl sm:text-2xl md:text-3xl font-bold ${titleClass}`}>
                  {language === 'zh' ? '手机远程访问 · 完整配置教程' : 'Mobile Remote Access · Setup Guide'}
                </div>
                <p className={`mt-1 ka-copy-sm ${mutedClass}`}>
                  {language === 'zh'
                    ? '把桌面版变成你的专属私人服务器，手机走 Tailscale 私有隧道连回来。'
                    : 'Turn the desktop into your personal server; the phone reaches it through a private Tailscale tunnel.'}
                </p>
              </div>
            </div>
            <button
              onClick={handleClose}
              className={`p-1.5 rounded-full hover:bg-red-500/10 hover:text-red-500 transition-colors ${textClass}`}
              aria-label={language === 'zh' ? '关闭' : 'Close'}
            >
              <X size={20} />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 min-h-0 flex flex-col md:flex-row">
            {/* Sidebar */}
            <div
              className={`w-full md:w-64 lg:w-72 flex flex-col border-b md:border-b-0 md:border-r min-h-0 ${
                isDarkMode ? 'bg-[#1c1a18] border-[#2a2522]/50' : 'bg-[#f5f0e8] border-[#e6ddcf]'
              }`}
            >
              <div className={`hidden md:block p-4 border-b ${isDarkMode ? 'border-[#2a2522]/40' : 'border-[#e6ddcf]'}`}>
                <div className={`rounded-lg border p-4 ${panelMutedClass}`}>
                  <div className={`ka-kicker ${titleClass}`}>
                    {language === 'zh' ? 'KUMIKO MOBILE SETUP' : 'KUMIKO MOBILE SETUP'}
                  </div>
                  <p className={`mt-2 text-[14px] leading-7 ${mutedClass}`}>
                    {language === 'zh'
                      ? '前两步只做一次，之后每天只要看第二步和第三步。'
                      : 'Steps 0 and 1 are one-time setup — daily usage only needs Steps 2 and 3.'}
                  </p>
                </div>
              </div>

              <div className="flex flex-1 overflow-x-auto md:overflow-y-auto md:flex-col p-2 md:p-3 gap-1.5 md:gap-2 no-scrollbar md:scrollbar-thin snap-x snap-mandatory md:snap-none">
                {sections.map((section, index) => {
                  const isActive = activeId === section.id;
                  const Icon = SECTION_ICONS[section.id] || Info;

                  return (
                    <button
                      key={section.id}
                      onClick={() => setActiveId(section.id)}
                      className={`flex items-center gap-1.5 md:gap-3 px-2.5 py-2 md:px-4 md:py-3 rounded-full md:rounded-xl text-left transition-all whitespace-nowrap md:whitespace-normal border snap-start ${
                        isActive
                          ? (isDarkMode
                            ? 'bg-[#d4a852] text-[#21150a] border-transparent shadow-[0_10px_20px_rgba(212,168,82,0.18)]'
                            : 'bg-[#fff5e3] text-[#8a6122] border-[#e0c58f] shadow-[0_8px_18px_rgba(138,97,34,0.10)]')
                          : (isDarkMode
                            ? 'text-[#b69f87] border-transparent hover:text-[#dccab6] hover:bg-white/5'
                            : 'text-[#776552] border-transparent hover:text-[#5c4720] hover:bg-[#faf5ee]')
                      }`}
                    >
                      <div className={`rounded-lg md:rounded-xl p-1.5 md:p-2 ${isActive ? (isDarkMode ? 'bg-[#21150a]/30 text-[#21150a]' : 'bg-[#e0c58f]/40 text-[#8a6122]') : (isDarkMode ? 'bg-white/5 text-[#8f7458]' : 'bg-black/[0.04] text-[#9d8251]')}`}>
                        <Icon size={14} />
                      </div>
                      <span className="md:hidden ka-micro font-semibold">{String(index).padStart(2, '0')}</span>
                      <div className="min-w-0 hidden md:block">
                        <div className="ka-micro opacity-55">STEP {String(index).padStart(2, '0')}</div>
                        <div className="text-[14.5px] leading-6 font-semibold md:text-[15px]">{section.title.replace(/^Step \d+ · /, '').replace(/^Step \d+ · /, '')}</div>
                      </div>
                    </button>
                  );
                })}
              </div>

              <div
                className={`hidden md:flex px-4 py-2 border-t items-center justify-between ka-micro ${
                  isDarkMode ? 'border-[#2a2522]/40 text-[#6b5a45]' : 'border-[#e6ddcf] text-[#8a7557]'
                }`}
              >
                <span>MOBILE ACCESS</span>
                <span>LOCAL FIRST</span>
              </div>
            </div>

            {/* Article */}
            <div className="relative min-h-0 flex-1 flex flex-col overflow-hidden">
              <div className={`px-5 md:px-6 py-4 border-b ${isDarkMode ? 'border-[#2a2522]/40 bg-[#161412]' : 'border-[#e6ddcf] bg-[#faf6f0]'}`}>
                <div className="flex items-center gap-3">
                  <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${isDarkMode ? 'bg-[#211912] text-[#d4a852]' : 'bg-[#fff5e3] text-[#8a6122]'}`}>
                    <ActiveIcon size={16} />
                  </div>
                  <div className="min-w-0">
                    <div className={`ka-kicker ${isDarkMode ? 'text-[#6b5a45]' : 'text-[#9a7d50]'}`}>
                      {language === 'zh' ? `章节 ${activeIndex + 1} / ${sections.length}` : `Section ${activeIndex + 1} / ${sections.length}`}
                    </div>
                    <h3 className={`font-mincho text-base sm:text-lg md:text-xl font-semibold tracking-[0.02em] ${isDarkMode ? 'text-[#f1e6d7]' : 'text-[#6f4e19]'}`}>
                      {activeSection.title}
                    </h3>
                  </div>
                </div>
              </div>

              <div
                ref={articleScrollRef}
                data-resize-heavy
                className="flex-1 overflow-y-auto p-3 sm:p-4 md:p-6 lg:p-8 scrollbar-thin"
              >
                <div className={`mx-auto max-w-4xl rounded-[1.15rem] border overflow-hidden ${panelClass}`}>
                  <div className={`px-5 py-4 border-b ${isDarkMode ? 'border-[#2a2522]/30 bg-[#1e1c1a] text-gray-300' : 'border-[#eadfce] bg-[#faf5ee] text-gray-700'}`}>
                    <p className="text-[15px] leading-7">{activeSection.intro}</p>
                  </div>

                  <div className={`p-4 md:p-6 lg:p-8 space-y-4 ${isDarkMode ? 'text-gray-300' : 'text-gray-800'}`}>
                    {/* Steps */}
                    {activeSection.steps.length > 0 && (
                      <ol className="space-y-4">
                        {activeSection.steps.map((step, idx) => (
                          <li key={idx} className="flex items-start gap-3">
                            <div className={`flex-shrink-0 flex h-7 w-7 items-center justify-center rounded-full font-mono text-sm font-bold ${isDarkMode ? 'bg-[#211912] text-[#d4a852] border border-[#4f3b2a]' : 'bg-[#fff5e3] text-[#8a6122] border border-[#e0c58f]'}`}>
                              {idx + 1}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-[15.5px] leading-7">{step.text}</p>
                              {step.note && (
                                <div className={`mt-2 rounded-lg border px-3 py-2 text-[14px] leading-6 ${
                                  isDarkMode
                                    ? 'border-yellow-900/35 bg-yellow-900/10 text-yellow-100/85'
                                    : 'border-[#d9c7a4] bg-[#fff8ea] text-[#6f5524]'
                                }`}>
                                  <Info size={12} className="inline mr-1 mb-0.5" />
                                  {step.note}
                                </div>
                              )}
                              {step.link && (
                                <button
                                  type="button"
                                  onClick={() => handleLinkClick(step.link!.url)}
                                  className={`mt-2 ${linkBtnClass}`}
                                >
                                  <ExternalLink size={12} />
                                  {step.link.label}
                                </button>
                              )}
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}

                    {/* Errors table */}
                    {activeSection.errors && activeSection.errors.length > 0 && (
                      <div className="space-y-3">
                        {activeSection.errors.map((err) => (
                          <div
                            key={err.code}
                            className={`rounded-lg border overflow-hidden ${
                              isDarkMode
                                ? 'border-red-800/45 bg-red-900/10'
                                : 'border-red-200 bg-red-50/50'
                            }`}
                          >
                            <div className={`px-4 py-2 flex items-center gap-2 border-b ${
                              isDarkMode ? 'border-red-800/40 bg-red-900/20' : 'border-red-200 bg-red-50'
                            }`}>
                              <AlertTriangle size={14} className={isDarkMode ? 'text-red-300' : 'text-red-600'} />
                              <code className={`font-mono text-[13px] font-bold ${isDarkMode ? 'text-red-200' : 'text-red-700'}`}>
                                {err.code}
                              </code>
                            </div>
                            <div className="p-4 space-y-2">
                              <div>
                                <div className={`text-[12px] font-semibold uppercase tracking-wider mb-1 ${mutedClass}`}>
                                  {language === 'zh' ? '现象' : 'Symptom'}
                                </div>
                                <p className="text-[14.5px] leading-6">{err.symptom}</p>
                              </div>
                              <div>
                                <div className={`text-[12px] font-semibold uppercase tracking-wider mb-1 ${mutedClass}`}>
                                  {language === 'zh' ? '原因' : 'Cause'}
                                </div>
                                <p className="text-[14.5px] leading-6">{err.cause}</p>
                              </div>
                              <div>
                                <div className={`text-[12px] font-semibold uppercase tracking-wider mb-1 ${mutedClass}`}>
                                  {language === 'zh' ? '修复' : 'Fix'}
                                </div>
                                <ul className="space-y-1">
                                  {err.fixSteps.map((fix, i) => (
                                    <li key={i} className="flex items-start gap-2 text-[14.5px] leading-6">
                                      <CheckCircle2 size={12} className={`flex-shrink-0 mt-1.5 ${isDarkMode ? 'text-emerald-400' : 'text-emerald-600'}`} />
                                      <span>{fix}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                              {(err.actionLink || err.jumpSectionId) && (
                                <div className="pt-1 flex flex-wrap gap-2">
                                  {err.actionLink && (
                                    <button
                                      type="button"
                                      onClick={() => handleLinkClick(err.actionLink!.url)}
                                      className={linkBtnClass}
                                    >
                                      <ExternalLink size={12} />
                                      {err.actionLink.label}
                                    </button>
                                  )}
                                  {err.jumpSectionId && err.jumpSectionId !== activeSection.id && (
                                    <button
                                      type="button"
                                      onClick={() => setActiveId(err.jumpSectionId!)}
                                      className={linkBtnClass}
                                    >
                                      <ArrowRight size={12} />
                                      {language === 'zh' ? '跳到对应章节' : 'Jump to section'}
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Tail note */}
                    {activeSection.tailNote && (
                      <div className={`rounded-lg border px-4 py-3 text-[14px] leading-6 ${
                        isDarkMode
                          ? 'border-emerald-900/40 bg-emerald-900/10 text-emerald-100/85'
                          : 'border-emerald-200 bg-emerald-50/60 text-emerald-900/80'
                      }`}>
                        <CheckCircle2 size={12} className="inline mr-1 mb-0.5" />
                        {activeSection.tailNote}
                      </div>
                    )}

                    <div className="h-12" />
                  </div>
                </div>
              </div>

              <div
                className={`px-5 md:px-6 py-2 border-t flex items-center justify-between ka-micro ${
                  isDarkMode ? 'border-[#2a2522]/40 bg-[#1c1a18] text-[#6b5a45]' : 'border-[#e6ddcf] bg-[#f5f0e8] text-[#8d7654]'
                }`}
              >
                <span>KUMIKO·AMADEUS · MOBILE SETUP</span>
                <span>PHASE 2</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default MobileSetupGuideModal;
