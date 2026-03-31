import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BrainCircuit,
  CheckSquare,
  Cloud,
  Database,
  Download,
  HardDrive,
  Maximize,
  Minimize,
  Paperclip,
  RefreshCw,
  Reply,
  Save,
  Send,
  Settings,
  Trash2,
  Undo2,
  Upload,
  Wifi,
  WifiOff,
  X,
  Zap,
  Info
} from 'lucide-react';
import { Language } from '../../types';
import { SOFTWARE_GUIDE_SECTIONS } from '../../constants';

const INLINE_ICONS: Record<string, React.ElementType> = {
  Maximize,
  Minimize,
  Undo2,
  Reply,
  Trash2,
  BrainCircuit,
  Settings,
  RefreshCw,
  AlertTriangle,
  Wifi,
  WifiOff,
  Save,
  Cloud,
  HardDrive,
  Upload,
  Download,
  Paperclip,
  CheckSquare,
  Zap,
  Send,
  Database
};

interface FullGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
  language: Language;
  isDarkMode: boolean;
}

export const FullGuideModal: React.FC<FullGuideModalProps> = ({
  isOpen,
  onClose,
  language,
  isDarkMode
}) => {
  const [activeGuideSection, setActiveGuideSection] = useState('intro');
  const articleScrollRef = useRef<HTMLDivElement | null>(null);
  const bgClass = isDarkMode ? 'bg-black/95 border-yellow-900/50' : 'bg-white/95 border-yellow-500/30';
  const textClass = isDarkMode ? 'text-yellow-100' : 'text-gray-800';
  const titleClass = isDarkMode ? 'text-yellow-500' : 'text-[#b8860b]';
  const mutedClass = isDarkMode ? 'text-gray-400' : 'text-[#7a6542]';
  const panelClass = isDarkMode ? 'bg-black/35 border-yellow-900/25' : 'bg-white/75 border-yellow-500/15';
  const panelMutedClass = isDarkMode ? 'bg-yellow-900/10 border-yellow-900/25' : 'bg-yellow-50 border-yellow-200/60';

  useEffect(() => {
    if (isOpen) {
      setActiveGuideSection('intro');
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !articleScrollRef.current) return;
    articleScrollRef.current.scrollTop = 0;
  }, [activeGuideSection, isOpen]);

  const handleGuideSectionChange = (nextSectionId: string) => {
    setActiveGuideSection(nextSectionId);
  };

  const renderInlineContent = (line: string) => {
    const parts = line.split(/(\*\*.*?\*\*|`[^`]+`|\[ICON:[a-zA-Z0-9_]+\])/g);
    return parts.map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return (
          <strong key={i} className={isDarkMode ? 'text-yellow-400' : 'text-[#b8860b]'}>
            {part.slice(2, -2)}
          </strong>
        );
      }

      if (part.startsWith('`') && part.endsWith('`')) {
        return (
          <code
            key={i}
            className={`mx-0.5 rounded px-1.5 py-0.5 font-mono text-[0.92em] ${
              isDarkMode ? 'bg-white/10 text-yellow-300' : 'bg-black/5 text-[#7c5710]'
            }`}
          >
            {part.slice(1, -1)}
          </code>
        );
      }

      if (part.startsWith('[ICON:') && part.endsWith(']')) {
        const iconName = part.slice(6, -1);
        const IconComponent = INLINE_ICONS[iconName];
        if (IconComponent) {
          return (
            <span
              key={i}
              className={`inline-flex items-center justify-center align-text-bottom mx-1 p-0.5 rounded ${
                isDarkMode ? 'bg-white/10 text-yellow-400' : 'bg-black/5 text-[#b8860b]'
              }`}
            >
              <IconComponent size={14} />
            </span>
          );
        }
        return null;
      }

      return <span key={i}>{part}</span>;
    });
  };

  const sections = SOFTWARE_GUIDE_SECTIONS[language];
  const activeData = sections.find((section) => section.id === activeGuideSection) || sections[0];
  const activeIndex = sections.findIndex((section) => section.id === activeData.id);
  const ActiveIcon = activeData.icon;

  const renderedContent = useMemo(() => {
    const lines = activeData.content.split('\n');
    return lines.map((line, idx) => {
      const trimmed = line.trim();

      if (line.startsWith('# ')) {
        return (
          <h1
            key={idx}
            className={`mb-6 mt-2 border-b pb-3 font-mincho text-[1.72rem] md:text-[1.92rem] font-bold tracking-[0.02em] ${
              isDarkMode ? 'border-yellow-900/50 text-yellow-100' : 'border-[#b8860b]/20 text-[#6f4e19]'
            }`}
          >
            {line.replace('# ', '')}
          </h1>
        );
      }

      if (line.startsWith('## ')) {
        return (
          <h2
            key={idx}
            className={`mb-3 mt-7 text-[0.88rem] md:text-[0.94rem] font-semibold tracking-[0.16em] uppercase ${
              isDarkMode ? 'text-yellow-500' : 'text-[#b8860b]'
            }`}
          >
            {line.replace('## ', '')}
          </h2>
        );
      }

      if (line.startsWith('### ')) {
        return (
          <h3
            key={idx}
            className={`mb-2 mt-4 font-mincho text-[1.05rem] md:text-[1.12rem] font-semibold tracking-[0.02em] ${
              isDarkMode ? 'text-yellow-300' : 'text-[#8a6520]'
            }`}
          >
            {line.replace('### ', '')}
          </h3>
        );
      }

      if (trimmed === '---') {
        return <div key={idx} className={`my-5 h-px ${isDarkMode ? 'bg-yellow-900/40' : 'bg-[#b8860b]/15'}`}></div>;
      }

      if (trimmed.startsWith('> ')) {
        return (
          <div
            key={idx}
            className={`mb-4 rounded-lg border px-4 py-3 text-[15.5px] leading-7 md:text-[16px] ${
              isDarkMode
                ? 'border-yellow-900/35 bg-yellow-900/10 text-yellow-100/85'
                : 'border-[#d9c7a4] bg-[#fff8ea] text-[#6f5524]'
            }`}
          >
            {renderInlineContent(trimmed.slice(2))}
          </div>
        );
      }

      if (trimmed.startsWith('- ')) {
        return (
          <div key={idx} className="mb-2 ml-2 flex items-start gap-2">
            <div className={`mt-2 h-1 w-1 flex-shrink-0 rounded-full ${isDarkMode ? 'bg-yellow-600' : 'bg-[#b8860b]'}`}></div>
            <p className="text-[15.5px] leading-8 opacity-90 md:text-[16px]">{renderInlineContent(trimmed.slice(2))}</p>
          </div>
        );
      }

      if (/^\d+\. /.test(trimmed)) {
        return (
          <div key={idx} className="mb-2 ml-2 flex items-start gap-2">
            <span className={`font-mono text-sm font-bold ${isDarkMode ? 'text-yellow-600' : 'text-[#b8860b]'}`}>
              {trimmed.split('.')[0]}.
            </span>
            <p className="text-[15.5px] leading-8 opacity-90 md:text-[16px]">{renderInlineContent(trimmed.replace(/^\d+\. /, ''))}</p>
          </div>
        );
      }

      if (!trimmed) {
        return <div key={idx} className="h-2"></div>;
      }

      return (
        <p key={idx} className="mb-3 text-[16px] leading-8 opacity-90 md:text-[16.5px]">
          {renderInlineContent(line)}
        </p>
      );
    });
  }, [activeData.content, isDarkMode]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 backdrop-blur-sm animate-in fade-in duration-300 safe-area-padding-modal"
      style={{ background: 'radial-gradient(circle, rgba(0,0,0,0.62) 30%, rgba(0,0,0,0) 100%)' }}
    >
      <div
        className={`relative w-full max-w-7xl h-full max-h-[92dvh] rounded-lg border shadow-2xl overflow-hidden flex flex-col animate-[breathe_0.3s_ease-out] ${bgClass}`}
      >
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-yellow-600 to-transparent opacity-50"></div>

        <div className={`flex items-center justify-between px-6 py-4 border-b ${isDarkMode ? 'border-yellow-900/30' : 'border-gray-200'}`}>
          <div className="flex items-center gap-3 min-w-0">
            <div className={`rounded-full p-2 ${isDarkMode ? 'bg-yellow-900/20 text-yellow-500' : 'bg-yellow-100 text-[#b8860b]'}`}>
              <Info size={20} />
            </div>
            <div className="min-w-0">
              <div className={`text-xl sm:text-2xl md:text-3xl font-bold ${titleClass}`}>
                {language === 'zh' ? '全知全能之书' : 'Omniscient Book'}
              </div>
              <p className={`mt-1 ka-copy-sm ${mutedClass}`}>
                {language === 'zh'
                  ? '功能结构、数据链路、回复逻辑与桌面行为的完整系统档案。'
                  : 'Full archive for features, data flow, reply logic, and desktop behavior.'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className={`p-1.5 rounded-full hover:bg-red-500/10 hover:text-red-500 transition-colors ${textClass}`}
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 min-h-0 flex flex-col md:flex-row">
          <div
            className={`w-full md:w-64 lg:w-72 flex flex-col border-b md:border-b-0 md:border-r min-h-0 ${
              isDarkMode ? 'bg-black/28 border-yellow-900/30' : 'bg-white/50 border-gray-200'
            }`}
          >
            <div className={`p-4 border-b ${isDarkMode ? 'border-yellow-900/25' : 'border-gray-200'}`}>
              <div className={`rounded-lg border p-4 ${panelMutedClass}`}>
                <div className={`ka-kicker ${titleClass}`}>
                  {language === 'zh' ? 'AMADEUS 档案索引' : 'AMADEUS INDEX'}
                </div>
                <p className={`mt-2 text-[14px] leading-7 md:text-[14.5px] ${mutedClass}`}>
                  {language === 'zh'
                    ? '这里写的是软件真正如何运转，而不是宣传页摘要。每一章都对应当前桌面版的一条实际链路。'
                    : 'This archive documents how the desktop build actually works, not just what it claims to do.'}
                </p>
              </div>
            </div>

            <div className="flex flex-1 overflow-x-auto md:overflow-y-auto md:flex-col p-3 gap-2 scrollbar-thin">
              {sections.map((section, index) => {
                const isActive = activeGuideSection === section.id;
                const Icon = section.icon;

                return (
                  <button
                    key={section.id}
                    onClick={() => handleGuideSectionChange(section.id)}
                    className={`flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-all whitespace-nowrap md:whitespace-normal border ${
                      isActive
                        ? (isDarkMode
                          ? 'bg-yellow-900/18 text-yellow-200 border-yellow-700/40 shadow-[inset_0_0_0_1px_rgba(234,179,8,0.08)]'
                          : 'bg-yellow-50 text-[#7d5b12] border-yellow-300/70 shadow-sm')
                        : (isDarkMode
                          ? 'text-gray-400 border-transparent hover:text-gray-200 hover:bg-white/5'
                          : 'text-[#776552] border-transparent hover:text-[#5c4720] hover:bg-black/[0.03]')
                    }`}
                  >
                    <div className={`rounded-full p-2 ${isActive ? (isDarkMode ? 'bg-yellow-900/25 text-yellow-400' : 'bg-yellow-100 text-[#b8860b]') : (isDarkMode ? 'bg-white/5 text-gray-500' : 'bg-black/[0.04] text-[#9d8251]')}`}>
                      <Icon size={14} />
                    </div>
                    <div className="min-w-0">
                      <div className="ka-micro opacity-55">{String(index + 1).padStart(2, '0')}</div>
                      <div className="text-[14.5px] leading-6 font-semibold md:text-[15px]">{section.title}</div>
                    </div>
                  </button>
                );
              })}
            </div>

            <div
              className={`px-4 py-2 border-t flex items-center justify-between ka-micro ${
                isDarkMode ? 'border-yellow-900/25 text-gray-500' : 'border-gray-200 text-[#8a7557]'
              }`}
            >
              <span>DESKTOP ARCHIVE</span>
              <span>LOCAL FIRST</span>
            </div>
          </div>

          <div className="relative min-h-0 flex-1 flex flex-col overflow-hidden">
            <div className={`px-5 md:px-6 py-4 border-b ${isDarkMode ? 'border-yellow-900/25 bg-black/15' : 'border-gray-200 bg-white/45'}`}>
              <div className="flex items-center gap-3">
                <div className={`rounded-full p-2 ${isDarkMode ? 'bg-yellow-900/18 text-yellow-400' : 'bg-yellow-100 text-[#b8860b]'}`}>
                  <ActiveIcon size={18} />
                </div>
                <div className="min-w-0">
                  <div className={`ka-kicker ${isDarkMode ? 'text-gray-500' : 'text-[#9a7d50]'}`}>
                    {language === 'zh' ? `章节 ${activeIndex + 1} / ${sections.length}` : `Section ${activeIndex + 1} / ${sections.length}`}
                  </div>
                  <h3 className={`font-mincho text-base sm:text-lg md:text-xl font-semibold tracking-[0.02em] ${isDarkMode ? 'text-yellow-100' : 'text-[#6f4e19]'}`}>
                    {activeData.title}
                  </h3>
                </div>
              </div>
            </div>

            <div
              ref={articleScrollRef}
              className="flex-1 overflow-y-auto p-3 sm:p-4 md:p-6 lg:p-8 scrollbar-thin"
            >
              <div className={`mx-auto max-w-4xl rounded-lg border overflow-hidden ${panelClass}`}>
                <div className={`px-5 py-3 border-b flex items-center justify-between gap-3 ${isDarkMode ? 'border-yellow-900/20 bg-black/25' : 'border-yellow-500/12 bg-yellow-50/60'}`}>
                  <div className="min-w-0">
                    <div className={`ka-kicker ${titleClass}`}>
                      {language === 'zh' ? '系统设计说明' : 'SYSTEM DESIGN DOSSIER'}
                    </div>
                    <p className={`mt-1 text-[14px] leading-7 md:text-[14.5px] ${mutedClass}`}>
                      {language === 'zh'
                        ? '以下内容描述的是软件当前实际执行的结构、条件、数据流与行为规则。'
                        : 'The sections below describe the current live structure, conditions, data flow, and behavior rules.'}
                    </p>
                  </div>
                  <div className={`hidden md:flex items-center gap-2 rounded-full px-3 py-1 ka-micro border ${isDarkMode ? 'border-yellow-700/30 text-yellow-500 bg-yellow-900/10' : 'border-yellow-300 text-[#8f6b12] bg-white'}`}>
                    <ActiveIcon size={12} />
                    <span>AMADEUS</span>
                  </div>
                </div>

                <div className={`p-4 md:p-6 lg:p-8 ${isDarkMode ? 'text-gray-300' : 'text-gray-800'}`}>
                  {renderedContent}
                  <div className="h-16"></div>
                </div>
              </div>
            </div>

            <div
              className={`px-5 md:px-6 py-2 border-t flex items-center justify-between ka-micro ${
                isDarkMode ? 'border-yellow-900/25 bg-black/20 text-gray-500' : 'border-gray-200 bg-gray-50 text-[#8d7654]'
              }`}
            >
              <span>KUMIKO·AMADEUS DESKTOP MANUAL</span>
              <span>AMADEUS ARCHIVE</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
