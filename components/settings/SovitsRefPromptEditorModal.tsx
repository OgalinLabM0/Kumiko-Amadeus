import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCcw, Save, Undo2, X } from 'lucide-react';
import type { EmotionType, Language } from '../../types';
import { UI_TRANSLATIONS } from '../../constants';
import {
  SOVITS_REF_METADATA,
  type SovitsRefMetadata,
} from '../../constants/sovitsRefMetadata';
import { useModalKeyboard } from '../../hooks/useModalKeyboard';
import { useModalPortal } from '../../hooks/useModalPortal';
import { dialogService } from '../../services/dialogService';
import { ComposableTextarea } from '../common/ComposableTextarea';

interface SovitsRefPromptEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  language: Language;
  isDarkMode: boolean;
  /**
   * Current value of the `sovitsUseRefText` toggle. Only used to decide
   * whether to show the OFF-mode banner at the top of the modal; editing
   * is allowed regardless so the user can pre-stage prompts before
   * flipping the switch.
   */
  refTextEnabled: boolean;
  /**
   * Existing overrides loaded from `ttsConfig.sovitsCustomPrompts`.
   * Missing / empty entries fall back to the built-in default.
   */
  initialPrompts: Record<string, string>;
  /**
   * Called with the minimal override map to persist (only rows that
   * differ from their built-in default are included; entries that match
   * the default are omitted so the stored record stays bounded).
   */
  onSave: (nextPrompts: Record<string, string>) => void;
}

const GROUPED_METADATA: { emotion: EmotionType; rows: SovitsRefMetadata[] }[] = (() => {
  const byEmotion = new Map<EmotionType, SovitsRefMetadata[]>();
  for (const row of SOVITS_REF_METADATA) {
    const list = byEmotion.get(row.emotion) ?? [];
    list.push(row);
    byEmotion.set(row.emotion, list);
  }
  return [...byEmotion.entries()].map(([emotion, rows]) => ({ emotion, rows }));
})();

const EMOTION_LABELS: Record<EmotionType, { zh: string; en: string }> = {
  neutral: { zh: '平静', en: 'Neutral' },
  smiling: { zh: '微笑', en: 'Smiling' },
  happy: { zh: '开心', en: 'Happy' },
  angry: { zh: '生气', en: 'Angry' },
  sad: { zh: '悲伤', en: 'Sad' },
  shy: { zh: '害羞', en: 'Shy' },
  surprised: { zh: '惊讶', en: 'Surprised' },
  resigned: { zh: '无奈', en: 'Resigned' },
  serious: { zh: '严肃', en: 'Serious' },
  gentle: { zh: '温柔', en: 'Gentle' },
  sleepy: { zh: '疲倦', en: 'Sleepy' },
  confused: { zh: '疑惑', en: 'Confused' },
  confused_2: { zh: '极度疑惑', en: 'Baffled' },
  disgusted: { zh: '不悦', en: 'Displeased' },
  smug: { zh: '得意', en: 'Smug' },
  worried: { zh: '担忧', en: 'Worried' },
  worried_2: { zh: '焦虑', en: 'Anxious' },
};

export const SovitsRefPromptEditorModal: React.FC<SovitsRefPromptEditorModalProps> = ({
  isOpen,
  onClose,
  language,
  isDarkMode,
  refTextEnabled,
  initialPrompts,
  onSave,
}) => {
  const renderPortal = useModalPortal();
  const [draft, setDraft] = useState<Record<string, string>>({});

  const resolveInitial = useCallback((row: SovitsRefMetadata): string => {
    const custom = initialPrompts[row.file];
    return (custom !== undefined && custom.length > 0) ? custom : row.defaultPromptText;
  }, [initialPrompts]);

  useEffect(() => {
    if (!isOpen) return;
    const next: Record<string, string> = {};
    for (const row of SOVITS_REF_METADATA) {
      next[row.file] = resolveInitial(row);
    }
    setDraft(next);
  }, [isOpen, resolveInitial]);

  const dirty = useMemo(() => {
    for (const row of SOVITS_REF_METADATA) {
      if ((draft[row.file] ?? '') !== resolveInitial(row)) return true;
    }
    return false;
  }, [draft, resolveInitial]);

  const t = UI_TRANSLATIONS[language] as Record<string, string>;

  const handleAttemptClose = useCallback(async () => {
    if (dirty) {
      const confirmed = await dialogService.confirm({
        message: t.sovitsPromptUnsavedConfirm,
        variant: 'danger',
        confirmText: language === 'zh' ? '放弃修改' : 'Discard',
        cancelText: language === 'zh' ? '继续编辑' : 'Keep editing',
      });
      if (!confirmed) return;
    }
    onClose();
  }, [dirty, onClose, t.sovitsPromptUnsavedConfirm, language]);

  useModalKeyboard({ isOpen, onClose: handleAttemptClose });

  const handleRowChange = useCallback((file: string, value: string) => {
    setDraft(prev => ({ ...prev, [file]: value }));
  }, []);

  const handleRowReset = useCallback((row: SovitsRefMetadata) => {
    setDraft(prev => ({ ...prev, [row.file]: row.defaultPromptText }));
  }, []);

  const handleResetAll = useCallback(async () => {
    const confirmed = await dialogService.confirm({
      message: t.sovitsPromptResetAllConfirm,
      variant: 'danger',
      confirmText: language === 'zh' ? '一键恢复' : 'Reset all',
    });
    if (!confirmed) return;
    const next: Record<string, string> = {};
    for (const row of SOVITS_REF_METADATA) {
      next[row.file] = row.defaultPromptText;
    }
    setDraft(next);
  }, [t.sovitsPromptResetAllConfirm, language]);

  const handleSave = useCallback(() => {
    const overrides: Record<string, string> = {};
    for (const row of SOVITS_REF_METADATA) {
      const raw = draft[row.file] ?? '';
      const trimmed = raw.trim();
      if (trimmed.length > 0 && raw !== row.defaultPromptText) {
        overrides[row.file] = raw;
      }
    }
    onSave(overrides);
    onClose();
  }, [draft, onSave, onClose]);

  if (!isOpen) return null;

  const bgClass = isDarkMode ? 'bg-[#1f1711] border-[#a88247]/55' : 'bg-[#faf6f0] border-[#e6ddcf]';
  const textClass = isDarkMode ? 'text-[#f1e6d7]' : 'text-[#3d2a18]';
  const titleClass = isDarkMode ? 'text-[#d4a852]' : 'text-[#8a6122]';
  const mutedClass = isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]';
  const rowBg = isDarkMode ? 'bg-[#1e1c1a] border-[#806033]/35' : 'bg-white border-[#e6ddcf]';
  const textareaBg = isDarkMode
    ? 'bg-[#0f0d0c] border-[#806033]/65 text-[#f1e6d7]'
    : 'bg-white border-[#d8cbb5] text-[#3d2a18]';
  const badgeBg = isDarkMode
    ? 'bg-[#21150a] text-[#d4a852] border-[#4f3b2a]'
    : 'bg-[#fff5e3] text-[#8a6122] border-[#e0c58f]';
  const footerBg = isDarkMode ? 'border-[#806033]/45 bg-[#1c1a18]' : 'border-[#e6ddcf] bg-[#f5f0e8]';

  return renderPortal(
    <div
      className="ka-mobile-fullbleed-backdrop fixed inset-0 z-[110] flex items-center justify-center p-4 backdrop-blur-sm safe-area-padding-modal"
      style={{ background: 'radial-gradient(circle, rgba(0,0,0,0.62) 30%, rgba(0,0,0,0) 100%)' }}
      role="dialog"
      aria-modal="true"
    >
      <div className={`ka-mobile-fullbleed-sheet relative w-full max-w-5xl h-full max-h-[92dvh] rounded-[1.2rem] border shadow-2xl overflow-hidden flex flex-col ${bgClass}`}>
        <div className={`absolute top-0 left-0 w-full h-[2px] ${isDarkMode ? 'bg-gradient-to-r from-transparent via-[#d4a852]/50 to-transparent' : 'bg-gradient-to-r from-transparent via-[#b8860b]/30 to-transparent'}`}></div>

        <div className={`flex items-center justify-between px-6 py-4 border-b ${isDarkMode ? 'border-[#806033]/45' : 'border-[#e6ddcf]'}`}>
          <div className="min-w-0 pr-3">
            <div className={`text-lg md:text-xl font-bold ${titleClass}`}>
              {t.sovitsPromptModalTitle}
            </div>
            <p className={`mt-1 ka-copy-sm ${mutedClass}`}>
              {t.sovitsPromptModalIntro}
            </p>
          </div>
          <button
            onClick={handleAttemptClose}
            className={`p-1.5 rounded-full hover:bg-red-500/10 hover:text-red-500 transition-colors ${textClass}`}
            aria-label={t.sovitsPromptCloseLabel}
          >
            <X size={20} />
          </button>
        </div>

        {!refTextEnabled && (
          <div
            className={`mx-6 mt-4 rounded-lg border px-4 py-3 ka-copy-sm leading-relaxed ${
              isDarkMode
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                : 'border-amber-400/60 bg-amber-50 text-amber-800'
            }`}
          >
            {t.sovitsPromptModalOffBanner}
          </div>
        )}

        {/* v2.14.1 H.1: same fullbleed-modal keyboard fix that SettingsPanel
            and MemoryPanel got. With KeyboardResize.None the WebView never
            resizes when the IME slides in, so the long emotion-prompt textareas
            below would slide under the soft keyboard. Reserve --kb-inset of
            extra bottom padding and scroll the focused control into view. */}
        <div
          className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-6"
          style={{ paddingBottom: 'calc(1rem + var(--kb-inset, 0px))' }}
          onFocusCapture={(e) => {
            const target = e.target as HTMLElement | null;
            if (!target) return;
            const tag = target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
              requestAnimationFrame(() => {
                try { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
                catch { /* old WebView without smooth-scroll, ignore */ }
              });
            }
          }}
        >
          {GROUPED_METADATA.map(({ emotion, rows }) => (
            <div key={emotion}>
              <div className={`mb-2 flex items-center gap-2`}>
                <span className={`ka-kicker ${titleClass}`}>
                  {language === 'zh' ? EMOTION_LABELS[emotion].zh : EMOTION_LABELS[emotion].en}
                </span>
                <span className={`ka-micro font-mono ${mutedClass}`}>
                  ({emotion}) × {rows.length}
                </span>
              </div>
              <div className="space-y-3">
                {rows.map((row) => {
                  const current = draft[row.file] ?? '';
                  const isDefault = current === row.defaultPromptText;
                  return (
                    <div key={row.file} className={`rounded-lg border p-3 ${rowBg}`}>
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div className="flex items-center gap-2 flex-wrap min-w-0">
                          <span
                            className={`ka-micro font-mono px-2 py-0.5 rounded border ${badgeBg}`}
                            title={language === 'zh' ? row.translationZh : row.translationZh}
                          >
                            {row.file}.wav
                          </span>
                          <span className={`ka-micro ${mutedClass}`}>
                            {language === 'zh' ? row.labelZh : row.labelEn}
                          </span>
                        </div>
                        <button
                          onClick={() => handleRowReset(row)}
                          disabled={isDefault}
                          className={`flex items-center gap-1 ka-micro px-2 py-0.5 rounded border transition-colors whitespace-nowrap ${
                            isDefault
                              ? `${isDarkMode ? 'text-[#5f5248] border-[#806033]/45' : 'text-[#c0b39c] border-[#e6ddcf]'} cursor-not-allowed opacity-60`
                              : `${isDarkMode ? 'text-[#d4a852] border-[#4f3b2a] hover:bg-amber-900/20' : 'text-[#8a6122] border-[#e0c58f] hover:bg-amber-50'}`
                          }`}
                          title={t.sovitsPromptRowResetTitle}
                        >
                          <Undo2 size={11} />
                          {t.sovitsPromptRowReset}
                        </button>
                      </div>
                      <div className={`ka-micro mb-2 ${mutedClass}`}>
                        <span className={`font-semibold mr-1 ${isDarkMode ? 'text-[#d4a852]' : 'text-[#8a6122]'}`}>
                          {t.sovitsPromptHintHeader}
                        </span>
                        ·{' '}
                        {language === 'zh' ? row.hintZh : row.hintEn}
                      </div>
                      <ComposableTextarea
                        value={current}
                        onChange={(e) => handleRowChange(row.file, e.target.value)}
                        rows={2}
                        className={`w-full px-3 py-2 rounded-md border ka-copy-sm font-mono resize-y min-h-[56px] focus:outline-none focus:ring-1 ${isDarkMode ? 'focus:ring-[#d4a852]/40' : 'focus:ring-[#b8860b]/40'} ${textareaBg}`}
                        spellCheck={false}
                        placeholder={row.defaultPromptText}
                        aria-label={`${t.sovitsPromptTextHeader}: ${row.file}`}
                      />
                      {!isDefault && (
                        <div className={`ka-micro mt-1 ${isDarkMode ? 'text-amber-400' : 'text-amber-700'}`}>
                          {t.sovitsPromptModified}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className={`flex items-center justify-between gap-3 px-6 py-3 border-t ${footerBg}`}>
          <button
            onClick={handleResetAll}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md border ka-copy-sm transition-colors ${
              isDarkMode
                ? 'text-[#b69f87] border-[#4f3b2a] hover:bg-amber-900/20'
                : 'text-[#8a6122] border-[#d8cbb5] hover:bg-amber-50'
            }`}
          >
            <RefreshCcw size={13} />
            {t.sovitsPromptResetAllBtn}
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={handleAttemptClose}
              className={`px-3 py-1.5 rounded-md border ka-copy-sm transition-colors ${
                isDarkMode
                  ? 'text-[#b69f87] border-[#4f3b2a] hover:bg-white/5'
                  : 'text-[#776552] border-[#d8cbb5] hover:bg-white'
              }`}
            >
              {t.sovitsPromptCancelBtn}
            </button>
            <button
              onClick={handleSave}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md ka-copy-sm font-semibold transition-colors ${
                isDarkMode
                  ? 'bg-[#d4a852] text-[#21150a] hover:bg-[#eec171]'
                  : 'bg-[#8a6122] text-white hover:bg-[#a0763c]'
              }`}
            >
              <Save size={13} />
              {t.sovitsPromptSaveBtn}
            </button>
          </div>
        </div>
      </div>
    </div>,
  );
};
