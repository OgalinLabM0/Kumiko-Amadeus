import React from 'react';
import { BookOpen, AlertCircle, CheckCircle, Loader2 } from 'lucide-react';
import type { DiaryGapInfo } from '../services/lifeStreamService';
import { useModalKeyboard } from '../hooks/useModalKeyboard';
import { useModalPortal } from '../hooks/useModalPortal';

export interface BackfillProgress {
  current: number;
  total: number;
  currentDate: string;
}

interface DiaryBackfillDialogProps {
  gapInfo: DiaryGapInfo;
  language: 'zh' | 'en';
  isDarkMode?: boolean;
  onConfirmAll: () => void;
  onConfirmOne: () => void;
  onDismiss: () => void;
  progress?: BackfillProgress;
  isComplete?: boolean;
  generatedCount?: number;
}

export const DiaryBackfillDialog: React.FC<DiaryBackfillDialogProps> = ({
  gapInfo,
  language,
  isDarkMode = false,
  onConfirmAll,
  onConfirmOne,
  onDismiss,
  progress,
  isComplete,
  generatedCount,
}) => {
  const isZh = language === 'zh';
  const isGenerating = !!progress && !isComplete;
  const renderPortal = useModalPortal();

  // P2 #42: allow Esc to dismiss. Respect ongoing batch generation — do not
  // let Esc cancel mid-batch (matches the existing behaviour where the Skip
  // button is hidden while generating).
  useModalKeyboard({ isOpen: !isGenerating, onClose: onDismiss });
  const panelClass = isDarkMode
    ? 'bg-[#17120e] border-[#6a523f]/60 text-[#ead8c1] shadow-[0_30px_90px_rgba(0,0,0,0.55)]'
    : 'bg-[#f9f7f2] border-[#785A42]/20 text-[#785A42]';
  const headerClass = isDarkMode
    ? 'bg-[#221a13] border-[#5a4635]/45'
    : 'bg-[#785A42]/5 border-[#785A42]/10';
  const softTextClass = isDarkMode ? 'text-[#cdb89f]' : 'text-[#785A42]/60';
  const subtleTextClass = isDarkMode ? 'text-[#9e8770]' : 'text-[#785A42]/40';
  const secondaryButtonClass = isDarkMode
    ? 'bg-[#1d1712] border-[#5a4635]/45 text-[#ead8c1] hover:bg-[#271e16]'
    : 'bg-white border-[#785A42]/20 text-[#785A42] hover:bg-[#785A42]/5';
  const progressTrackClass = isDarkMode ? 'bg-white/8' : 'bg-[#785A42]/10';
  const primaryButtonClass = isDarkMode
    ? 'bg-[linear-gradient(180deg,#9f7449,#7e5c3b)] text-[#fffaf2] hover:brightness-105'
    : 'bg-[#785A42] text-white hover:bg-[#5e4433]';
  const dismissButtonClass = isDarkMode
    ? 'text-[#b89f84] hover:text-[#f0decb]'
    : 'text-[#785A42]/50 hover:text-[#785A42]';

  const gapTypeLabel = isZh
    ? gapInfo.gapType === 'all_missing' ? '全部缺失'
      : gapInfo.gapType === 'tail_missing' ? '近期缺失'
      : gapInfo.gapType === 'mid_gap' ? '中间缺口'
      : ''
    : gapInfo.gapType === 'all_missing' ? 'All Missing'
      : gapInfo.gapType === 'tail_missing' ? 'Recent Gap'
      : gapInfo.gapType === 'mid_gap' ? 'Middle Gap'
      : '';

  // Phase 7 Part t5_a1_diary_backfill: portal the overlay into <body> so its
  // `fixed inset-0` is relative to the viewport instead of the DiaryPanel
  // host (which sets `contain: layout style` + `transform` + bottom safe-area
  // padding, hijacking the containing block and leaking a white strip at the
  // bottom on iOS PWA). The App.tsx-level instance is unaffected because it
  // renders at the root; re-portaling there is a no-op.
  return renderPortal(
    // Phase 7 Part t11_modal_toast: add safe-area padding so the dialog
    // card clears iOS's home indicator and notch on phones. Desktop
    // Electron sees env() === 0 and keeps the original centering.
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center backdrop-blur-sm animate-in fade-in duration-200"
      style={{
        background: isDarkMode
          ? 'radial-gradient(circle, rgba(8,6,5,0.82) 28%, rgba(6,5,4,0.92) 100%)'
          : 'radial-gradient(circle, rgba(0,0,0,0.42) 24%, rgba(0,0,0,0.64) 100%)',
        paddingTop: 'max(1rem, var(--sat))',
        paddingBottom: 'max(1rem, var(--sab))',
        paddingLeft: 'max(1rem, var(--sal))',
        paddingRight: 'max(1rem, var(--sar))',
      }}
    >
      <div className={`rounded-xl shadow-2xl border w-[90%] max-w-sm overflow-hidden ${panelClass}`}>
        {/* Header */}
        <div className={`px-5 py-3 border-b flex items-center gap-2 ${headerClass}`}>
          <BookOpen size={16} className={isDarkMode ? 'text-[#d8bb88]' : 'text-[#785A42]'} />
          <span className={`font-bold text-sm tracking-wider ${isDarkMode ? 'text-[#ead8c1]' : 'text-[#785A42]'}`}>
            {isZh ? '日记补齐' : 'Diary Backfill'}
          </span>
          {gapTypeLabel && (
            <span className={`ml-auto text-[9px] font-mono px-1.5 py-0.5 rounded ${isDarkMode ? 'text-[#bfa58c] bg-white/6' : 'text-[#785A42]/50 bg-[#785A42]/10'}`}>
              {gapTypeLabel}
            </span>
          )}
        </div>

        {/* Body */}
        <div className="p-5">
          {isComplete ? (
            <div className="flex flex-col items-center gap-3 py-2">
              <CheckCircle size={32} className={isDarkMode ? 'text-green-400' : 'text-green-600'} />
              <p className={`text-sm text-center font-medium ${isDarkMode ? 'text-[#ead8c1]' : 'text-[#785A42]'}`}>
                {isZh
                  ? `补充完成，共生成 ${generatedCount ?? 0} 篇日记。`
                  : `Backfill complete. ${generatedCount ?? 0} diary entries generated.`}
              </p>
            </div>
          ) : isGenerating ? (
            <div className="flex flex-col gap-3 py-2">
              <div className="flex items-center gap-2 text-[#785A42]">
                <Loader2 size={16} className={`animate-spin ${isDarkMode ? 'text-[#d8bb88]' : 'text-[#785A42]'}`} />
                <span className={`text-xs font-mono ${isDarkMode ? 'text-[#ead8c1]' : 'text-[#785A42]'}`}>
                  {isZh
                    ? `正在补充 ${progress.current}/${progress.total}：${progress.currentDate}`
                    : `Generating ${progress.current}/${progress.total}: ${progress.currentDate}`}
                </span>
              </div>
              <div className={`w-full rounded-full h-2 overflow-hidden ${progressTrackClass}`}>
                <div
                  className={`h-full rounded-full transition-all duration-300 ${isDarkMode ? 'bg-[#cda15f]' : 'bg-[#785A42]'}`}
                  style={{ width: `${(progress.current / progress.total) * 100}%` }}
                />
              </div>
              <p className={`text-[9px] text-center font-mono ${subtleTextClass}`}>
                {isZh ? '生成期间请勿关闭窗口...' : 'Please do not close the window...'}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-2">
                <AlertCircle size={16} className="text-amber-600 mt-0.5 flex-shrink-0" />
                <p className={`text-sm ${isDarkMode ? 'text-[#ead8c1]' : 'text-[#785A42]'}`}>
                  {isZh
                    ? `检测到 ${gapInfo.totalMissing} 天的日记缺失。是否补充？`
                    : `${gapInfo.totalMissing} missing diary entries detected. Backfill?`}
                </p>
              </div>

              <div className="flex flex-col gap-2 mt-1">
                <button
                  onClick={onConfirmAll}
                  className={`w-full py-2 px-3 text-xs font-bold rounded-lg transition-colors tracking-wider ${primaryButtonClass}`}
                >
                  {isZh
                    ? `全部补充（${gapInfo.totalMissing} 天）`
                    : `Backfill All (${gapInfo.totalMissing} days)`}
                </button>
                <button
                  onClick={onConfirmOne}
                  className={`w-full py-2 px-3 border text-xs font-bold rounded-lg transition-colors ${secondaryButtonClass}`}
                >
                  {isZh ? '仅补充最近 1 天' : 'Backfill 1 Day Only'}
                </button>
              </div>

              <p className={`text-[9px] text-center font-mono mt-1 ${subtleTextClass}`}>
                {isZh
                  ? '选择"仅补充 1 天"将只生成最近一天的日记。'
                  : '"1 Day Only" generates only the most recent missing day.'}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        {(isComplete || (!isGenerating && !isComplete)) && (
          <div className="px-5 pb-4">
            <button
              onClick={onDismiss}
              className={`w-full py-1.5 text-[10px] font-mono transition-colors ${dismissButtonClass}`}
            >
              {isComplete
                ? (isZh ? '关闭' : 'Close')
                : (isZh ? '暂时跳过' : 'Skip for now')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
