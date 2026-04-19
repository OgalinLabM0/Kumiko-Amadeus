import React, { useEffect, useState } from 'react';
import { Brain, ChevronDown, ChevronUp } from 'lucide-react';
import { Collapse } from '../Collapse';
import { useAppStore } from '../../store';
import { db } from '../../services/db';

// P1 #37: contextLimit setting moved here from the MemoryPanel (business-content
// panel). MemoryPanel now only owns *content* (coreMemory text, worldBook entries,
// pinned messages) while all configuration lives under SettingsPanel. The toggle
// reads/writes the same Zustand field and same Dexie key (`kumiko_context_limit`)
// that MemoryPanel used to, so existing user values are preserved verbatim.
interface MemoryContextSectionTranslations {
  memoryContextTitle: string;
  memoryContextDesc: string;
  memoryContextSliderLabel: string;
  memoryContextHelp: string;
}

interface MemoryContextSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  t: MemoryContextSectionTranslations;
  sectionBorder: string;
}

export const MemoryContextSection: React.FC<MemoryContextSectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  t,
  sectionBorder,
}) => {
  const contextLimit = useAppStore(s => s.contextLimit);
  const setContextLimit = useAppStore(s => s.setContextLimit);
  const isDataLoaded = useAppStore(s => s.isDataLoaded);

  const [draft, setDraft] = useState<number>(contextLimit);
  useEffect(() => { setDraft(contextLimit); }, [contextLimit]);

  const commit = (value: number) => {
    const clamped = Math.max(10, Math.min(500, Math.round(value)));
    setDraft(clamped);
    setContextLimit(clamped);
    if (isDataLoaded) {
      db.setVal('kumiko_context_limit', clamped).catch(err => {
        console.warn('[MemoryContextSection] Failed to persist context limit:', err);
      });
    }
  };

  return (
    <div className={`flex flex-col rounded-[1.2rem] border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between px-4 py-[1.05rem] w-full">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-2xl border ${isDarkMode ? 'border-emerald-500/20 bg-emerald-900/20 text-emerald-300' : 'border-emerald-200 bg-emerald-50/90 text-emerald-700'}`}>
            <Brain size={18} />
          </div>
          <div className="text-left">
            <h3 className={`ka-section-title ${isDarkMode ? 'text-[#f5ebdc]' : 'text-[#49301f]'}`}>{t.memoryContextTitle}</h3>
            {!isOpen && <p className={`ka-section-desc ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{t.memoryContextDesc}</p>}
          </div>
        </div>
        {isOpen
          ? <ChevronUp size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />
          : <ChevronDown size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />}
      </button>

      <Collapse isOpen={isOpen}>
        <div className="px-4 pb-4 pt-0 flex flex-col gap-4">
          <p className={`ka-copy-sm ${isDarkMode ? 'text-[#cdbca9]' : 'text-[#7c6245]'}`}>{t.memoryContextDesc}</p>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-4">
              <label className={`ka-setting-item-title ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
                {t.memoryContextSliderLabel}
              </label>
              <input
                type="number"
                min={10}
                max={500}
                value={draft}
                onChange={e => setDraft(Math.max(10, Math.min(500, parseInt(e.target.value, 10) || 0)))}
                onBlur={() => commit(draft)}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                className={`w-24 px-2 py-1 rounded text-center ka-input-copy outline-none focus:ring-1 focus:ring-emerald-500/40 ${isDarkMode ? 'bg-[#1b1712] border border-[#4a3a2a] text-[#f0e6d8]' : 'bg-white border border-[#d7cebf] text-[#4c3a2b]'}`}
              />
            </div>
            <input
              type="range"
              min={10}
              max={500}
              step={10}
              value={draft}
              onChange={e => commit(parseInt(e.target.value, 10))}
              className="w-full accent-emerald-500"
              aria-label={t.memoryContextSliderLabel}
            />
            <p className={`ka-copy-xs leading-relaxed ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>
              {t.memoryContextHelp}
            </p>
          </div>
        </div>
      </Collapse>
    </div>
  );
};
