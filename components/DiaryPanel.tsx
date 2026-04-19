import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { db, KumikoDiaryEntity } from '../services/db';
import { X, ChevronLeft, ChevronRight, ArrowLeft, BookOpen, Calendar, RefreshCw, PenLine, CheckSquare, Square } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { DiaryBackfillDialog, type BackfillProgress } from './DiaryBackfillDialog';
import { CustomDialog } from './settings/CustomDialog';
// SettingsToggle no longer needed here — the auto-backfill toggle moved to
// SettingsPanel / DiaryLifeSection (P0 #12 + #37 settings consolidation).
import type { DiaryGapInfo, BatchRewriteResult } from '../services/lifeStreamService';

type ViewLevel = 'year' | 'month' | 'day';

interface DiaryPanelProps {
  isOpen: boolean;
  onClose: () => void;
  language?: 'zh' | 'en';
  isDarkMode?: boolean;
  rewritingDate: string | null;
  setRewritingDate: (date: string | null) => void;
  bfProgress?: BackfillProgress;
  setBfProgress: (p: BackfillProgress | undefined) => void;
  bfComplete: boolean;
  setBfComplete: (v: boolean) => void;
  bfCount: number;
  setBfCount: (v: number) => void;
}

const toDateStr = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const WEEKDAY_LABELS_ZH = ['一', '二', '三', '四', '五', '六', '日'];
const WEEKDAY_LABELS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_LABELS_ZH = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const MONTH_LABELS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const JST_TIMEZONE = 'Asia/Tokyo';
// AUTO_DIARY_BACKFILL_STORAGE_KEY and getAutoDiaryBackfillEnabled were moved to
// hooks/useAutoDiaryBackfill.ts (and the toggle UI to settings/DiaryLifeSection).
// The behavioral side of the flag still lives in store/slices/diarySlice.ts, which
// reads the same localStorage key.

const getCurrentJstDate = () => new Date(new Date().toLocaleString('en-US', { timeZone: JST_TIMEZONE }));

const getDelayUntilNextJstDay = () => {
  const currentJst = getCurrentJstDate();
  const nextJstDay = new Date(currentJst);
  nextJstDay.setHours(24, 0, 5, 0);
  return Math.max(1000, nextJstDay.getTime() - currentJst.getTime());
};

// getMondayOfWeek removed with renderWeekView (P1 #30).

export const DiaryPanel: React.FC<DiaryPanelProps> = ({
  isOpen, onClose, language = 'zh', isDarkMode = false,
  rewritingDate, setRewritingDate,
  bfProgress, setBfProgress,
  bfComplete, setBfComplete,
  bfCount, setBfCount,
}) => {
  const [todayJst, setTodayJst] = useState<Date>(() => getCurrentJstDate());
  const todayStr = useMemo(
    () => toDateStr(todayJst.getFullYear(), todayJst.getMonth() + 1, todayJst.getDate()),
    [todayJst]
  );

  const [viewLevel, setViewLevel] = useState<ViewLevel>('day');
  const [selectedYear, setSelectedYear] = useState(todayJst.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(todayJst.getMonth() + 1);
  // `selectedWeekMonday` removed with renderWeekView (P1 #30).
  const [selectedDate, setSelectedDate] = useState(todayStr);
  const [isAnimating, setIsAnimating] = useState(false);

  const [gapInfo, setGapInfo] = useState<DiaryGapInfo | null>(null);
  const [gapCheckMsg, setGapCheckMsg] = useState<string | null>(null);
  const [showRewriteConfirm, setShowRewriteConfirm] = useState(false);
  const [rewriteFeedback, setRewriteFeedback] = useState<string | null>(null);
  const [rewriteError, setRewriteError] = useState<string | null>(null);
  // auto-backfill toggle state + persistence moved to SettingsPanel / DiaryLifeSection.

  const [batchSelectMode, setBatchSelectMode] = useState(false);
  const [selectedForRewrite, setSelectedForRewrite] = useState<Set<string>>(new Set());
  const [showBatchConfirm, setShowBatchConfirm] = useState(false);
  const [batchRewriting, setBatchRewriting] = useState(false);
  const [batchRewriteProgress, setBatchRewriteProgress] = useState<{ current: number; total: number; dateStr: string } | null>(null);
  const [batchRewriteResult, setBatchRewriteResult] = useState<BatchRewriteResult | null>(null);

  // P2 #47: the prior version fired a bare setTimeout to clear `gapCheckMsg`,
  // with no cleanup path. Closing the panel mid-countdown meant the callback
  // still tried to setState on an unmounted component. Track the timer in a
  // ref and clear it on panel close / re-check / unmount.
  const gapCheckMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelGapCheckMsgTimer = useCallback(() => {
    if (gapCheckMsgTimerRef.current) {
      clearTimeout(gapCheckMsgTimerRef.current);
      gapCheckMsgTimerRef.current = null;
    }
  }, []);
  const checkGaps = useCallback(async (showNoGapFeedback = false) => {
    const { detectDiaryGaps } = await import('../services/lifeStreamService');
    const info = await detectDiaryGaps();
    if (info.totalMissing > 0) {
      setGapInfo(info);
      setGapCheckMsg(null);
      cancelGapCheckMsgTimer();
    } else if (showNoGapFeedback) {
      setGapCheckMsg(language === 'zh' ? '没有发现日记缺口' : 'No diary gaps found');
      cancelGapCheckMsgTimer();
      gapCheckMsgTimerRef.current = setTimeout(() => {
        setGapCheckMsg(null);
        gapCheckMsgTimerRef.current = null;
      }, 5000);
    }
  }, [language, cancelGapCheckMsgTimer]);

  useEffect(() => { if (isOpen) checkGaps(); }, [checkGaps, isOpen]);
  useEffect(() => {
    return cancelGapCheckMsgTimer;
  }, [cancelGapCheckMsgTimer]);

  useEffect(() => {
    if (!isOpen) return;
    let timerId: number | null = null;

    const scheduleNextRefresh = () => {
      timerId = window.setTimeout(() => {
        setTodayJst(getCurrentJstDate());
        scheduleNextRefresh();
      }, getDelayUntilNextJstDay());
    };

    scheduleNextRefresh();

    return () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [isOpen]);

  useEffect(() => {
    setRewriteFeedback(null);
    setRewriteError(null);
  }, [selectedDate]);

  // Auto-backfill persistence moved to hooks/useAutoDiaryBackfill.ts.

  const handleBfAll = useCallback(async () => {
    if (!gapInfo) return;
    const { batchGenerateDiaries } = await import('../services/lifeStreamService');
    setBfComplete(false);
    setBfCount(0);
    const count = await batchGenerateDiaries(
      gapInfo.missingDates,
      (c, t, d) => setBfProgress({ current: c, total: t, currentDate: d }),
      gapInfo.contextAfter
    );
    setBfProgress(undefined);
    setBfComplete(true);
    setBfCount(count);
  }, [gapInfo]);

  const handleBfOne = useCallback(async () => {
    if (!gapInfo) return;
    const { batchGenerateDiaries } = await import('../services/lifeStreamService');
    const sorted = [...gapInfo.missingDates].sort();
    const last = sorted[sorted.length - 1];
    setBfComplete(false);
    setBfCount(0);
    const count = await batchGenerateDiaries(
      [last],
      (c, t, d) => setBfProgress({ current: c, total: t, currentDate: d }),
      gapInfo.contextAfter
    );
    setBfProgress(undefined);
    setBfComplete(true);
    setBfCount(count);
  }, [gapInfo]);

  const handleBfDismiss = useCallback(() => {
    setGapInfo(null);
    setBfProgress(undefined);
    setBfComplete(false);
    setBfCount(0);
  }, []);

  const diaryDates = useLiveQuery(async () => {
    const all = await db.kumikoDiary.toArray();
    return new Set(all.map(entry => entry.date));
  }, []);

  const sortedDiaryDates = useMemo(
    () => diaryDates ? Array.from(diaryDates).sort() : [],
    [diaryDates]
  );

  const earliestDateStr = useLiveQuery(async () => {
    const earliestMsg = await db.messages.orderBy('timestamp').first();
    const earliestDiary = await db.kumikoDiary.orderBy('date').first();
    const candidates: string[] = [];
    if (earliestMsg) {
      const d = new Date(earliestMsg.timestamp);
      const jst = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
      candidates.push(toDateStr(jst.getFullYear(), jst.getMonth() + 1, jst.getDate()));
    }
    if (earliestDiary) candidates.push(earliestDiary.date);
    if (candidates.length === 0) return todayStr;
    candidates.sort();
    return candidates[0];
  }, []);

  const minDate = useMemo(() => {
    if (!earliestDateStr) return todayJst;
    const [y, m, d] = earliestDateStr.split('-').map(Number);
    return new Date(y, m - 1, d);
  }, [earliestDateStr, todayJst]);

  const currentDiary = useLiveQuery(
    () => db.kumikoDiary.where('date').equals(selectedDate).first(),
    [selectedDate]
  );

  const handleRewriteCurrentDiary = useCallback(() => {
    if (!currentDiary || rewritingDate) return;
    setShowRewriteConfirm(true);
  }, [currentDiary, rewritingDate]);

  const handleRewriteConfirmed = useCallback(async () => {
    setShowRewriteConfirm(false);
    if (!currentDiary) return;

    setRewriteFeedback(null);
    setRewriteError(null);
    setRewritingDate(currentDiary.date);

    try {
      const { rewriteDiaryEntry } = await import('../services/lifeStreamService');
      const rewrittenDiary = await rewriteDiaryEntry(currentDiary.date);
      if (rewrittenDiary) {
        setRewriteFeedback(language === 'zh' ? '已按当前设定重写这篇日记。' : 'Diary rewritten with current canon settings.');
      } else {
        setRewriteError(language === 'zh' ? '重写失败，没有找到这篇日记。' : 'Rewrite failed. Diary entry was not found.');
      }
    } catch (error) {
      console.error('[DiaryPanel] Failed to rewrite diary entry:', error);
      setRewriteError(language === 'zh' ? '重写失败，请稍后再试。' : 'Rewrite failed. Please try again later.');
    } finally {
      setRewritingDate(null);
    }
  }, [currentDiary, language]);

  const syncSelectedDate = useCallback((dateStr: string) => {
    const [year, month] = dateStr.split('-').map(Number);
    setSelectedDate(dateStr);
    setSelectedYear(year);
    setSelectedMonth(month);
  }, []);

  const prevDiaryDate = useMemo(() => {
    let previous: string | null = null;
    for (const date of sortedDiaryDates) {
      if (date >= selectedDate) break;
      previous = date;
    }
    return previous;
  }, [selectedDate, sortedDiaryDates]);

  const nextDiaryDate = useMemo(
    () => sortedDiaryDates.find(date => date > selectedDate) || null,
    [selectedDate, sortedDiaryDates]
  );

  const isDateInRange = useCallback((dateStr: string) => {
    if (!earliestDateStr) return false;
    return dateStr >= earliestDateStr && dateStr <= todayStr;
  }, [earliestDateStr, todayStr]);

  const isMonthInRange = useCallback((year: number, month: number) => {
    if (!earliestDateStr) return false;
    const [minY, minM] = earliestDateStr.split('-').map(Number);
    const monthStart = year * 12 + month;
    const minMonthVal = minY * 12 + minM;
    const todayMonthVal = todayJst.getFullYear() * 12 + (todayJst.getMonth() + 1);
    return monthStart >= minMonthVal && monthStart <= todayMonthVal;
  }, [earliestDateStr, todayJst]);

  const canGoYearLeft = useMemo(() => {
    if (!earliestDateStr) return false;
    const minY = parseInt(earliestDateStr.split('-')[0]);
    return selectedYear > minY;
  }, [earliestDateStr, selectedYear]);

  const canGoYearRight = selectedYear < todayJst.getFullYear();

  const animate = (cb: () => void) => {
    setIsAnimating(true);
    setTimeout(() => { cb(); setIsAnimating(false); }, 150);
  };

  const inkClass = isDarkMode ? 'text-[#ead8c1]' : 'text-[#785A42]';
  const inkSoftClass = isDarkMode ? 'text-[#c7b29a]' : 'text-[#785A42]/60';
  const inkMutedClass = isDarkMode ? 'text-[#a48a71]' : 'text-[#785A42]/45';
  const disabledInkClass = isDarkMode ? 'text-[#6a5a4c]' : 'text-[#785A42]/20';
  const borderClass = isDarkMode ? 'border-[#2a2522]/60' : 'border-[#785A42]/10';
  const shellBgClass = isDarkMode ? 'bg-[#161412]' : 'bg-[#f9f7f2]';
  const chromeBgClass = isDarkMode ? 'bg-[#17120e]/92' : 'bg-white/50';
  const subChromeBgClass = isDarkMode ? 'bg-[#15110c]/84' : 'bg-white/30';
  const cardBgClass = isDarkMode ? 'bg-[#17120e]' : 'bg-white';
  const cardHeaderBgClass = isDarkMode ? 'bg-[#211a14]' : 'bg-[#785A42]/5';
  const toggleActiveTrackClass = isDarkMode ? 'bg-emerald-500/90' : 'bg-emerald-500';
  const toggleInactiveTrackClass = isDarkMode ? 'bg-[#3a3128]' : 'bg-[#d8d2c7]';

  const handleBack = () => {
    if (viewLevel === 'day') animate(() => setViewLevel('month'));
    else if (viewLevel === 'month') animate(() => setViewLevel('year'));
  };

  const titleText = useMemo(() => {
    if (viewLevel === 'year') return `${selectedYear}`;
    if (viewLevel === 'month') {
      const ml = language === 'zh' ? MONTH_LABELS_ZH : MONTH_LABELS_EN;
      return `${selectedYear} ${ml[selectedMonth - 1]}`;
    }

    const [, m, d] = selectedDate.split('-');
    const dateObj = new Date(selectedDate + 'T00:00:00');
    const weekday = language === 'zh'
      ? ['日', '一', '二', '三', '四', '五', '六'][dateObj.getDay()]
      : dateObj.toLocaleDateString('en-US', { weekday: 'long' });
    return language === 'zh'
      ? `${parseInt(m)}月${parseInt(d)}日 周${weekday}`
      : `${selectedDate} ${weekday}`;
  }, [viewLevel, selectedYear, selectedMonth, selectedDate, language]);

  const renderYearView = () => {
    const ml = language === 'zh' ? MONTH_LABELS_ZH : MONTH_LABELS_EN;
    return (
      <div className="grid grid-cols-3 gap-3 p-4">
        {ml.map((label, i) => {
          const m = i + 1;
          const inRange = isMonthInRange(selectedYear, m);
          const hasEntries = diaryDates && Array.from(diaryDates).some(d => d.startsWith(`${selectedYear}-${String(m).padStart(2, '0')}`));
          return (
            <button
              key={m}
              disabled={!inRange}
              onClick={() => { setSelectedMonth(m); animate(() => setViewLevel('month')); }}
              className={`relative p-4 rounded-lg border text-center transition-all ${
                inRange
                  ? `${isDarkMode ? 'border-[#6b523d]/35 bg-[#17120d] hover:bg-[#1f1812] text-[#ead8c1]' : 'border-[#785A42]/20 hover:bg-[#785A42]/10 text-[#785A42]'} cursor-pointer`
                  : `${isDarkMode ? 'border-[#3a2d21] text-[#6a5a4c]' : 'border-[#785A42]/5 text-[#785A42]/20'} cursor-not-allowed`
              }`}
            >
              <span className="ka-label font-semibold">{label}</span>
              {hasEntries && inRange && <span className={`absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full ${isDarkMode ? 'bg-[#d8b36f]' : 'bg-[#785A42]/60'}`} />}
            </button>
          );
        })}
      </div>
    );
  };

  const renderMonthView = () => {
    const weekdayLabels = language === 'zh' ? WEEKDAY_LABELS_ZH : WEEKDAY_LABELS_EN;
    // ensure using local time exactly as requested
    const firstDay = new Date(selectedYear, selectedMonth - 1, 1);
    const firstWeekdayOffset = (firstDay.getDay() + 6) % 7; // Monday = 0
    const nextMonthDayZero = new Date(selectedYear, selectedMonth, 0);
    const daysInMonth = nextMonthDayZero.getDate();
    
    const cells = Array.from({ length: firstWeekdayOffset + daysInMonth }, (_, index) => {
      if (index < firstWeekdayOffset) return null;
      return index - firstWeekdayOffset + 1;
    });
    while (cells.length % 7 !== 0) {
      cells.push(null);
    }

    return (
      <div className="p-4">
        <div className="grid grid-cols-7 gap-3">
          {cells.map((dayNumber, index) => {
            if (!dayNumber) {
              return <div key={`empty-${index}`} className="min-h-[96px] rounded-xl bg-transparent" />;
            }

            const dateStr = toDateStr(selectedYear, selectedMonth, dayNumber);
            const weekdayIndex = (index % 7);
            const inRange = isDateInRange(dateStr);
            const hasDiary = diaryDates?.has(dateStr);
            const isToday = dateStr === todayStr;
            const isSelected = batchSelectMode && selectedForRewrite.has(dateStr);

            return (
              <button
                key={dateStr}
                disabled={!inRange || (batchSelectMode && !hasDiary)}
                onClick={() => {
                  if (batchSelectMode && hasDiary) {
                    setSelectedForRewrite(prev => {
                      const next = new Set(prev);
                      if (next.has(dateStr)) next.delete(dateStr);
                      else next.add(dateStr);
                      return next;
                    });
                  } else if (!batchSelectMode) {
                    syncSelectedDate(dateStr);
                    animate(() => setViewLevel('day'));
                  }
                }}
                className={`group relative min-h-[96px] rounded-xl border p-3 flex flex-col justify-between transition-all overflow-hidden ${
                  isSelected
                    ? `${isDarkMode ? 'border-[#d8b36f]/60 bg-[#2a1f14] ring-2 ring-[#d8b36f]/40 text-[#f0dfc7]' : 'border-[#785A42]/50 bg-[#785A42]/12 ring-2 ring-[#785A42]/30 text-[#785A42]'} cursor-pointer`
                    : !inRange || (batchSelectMode && !hasDiary)
                      ? `${isDarkMode ? 'border-[#3a2d21] bg-[#15100c] text-[#6a5a4c]' : 'border-[#785A42]/5 bg-[#785A42]/[0.02] text-[#785A42]/20'} cursor-not-allowed`
                      : isToday
                        ? `${isDarkMode ? 'border-[#7a6246]/55 bg-[#211a14] text-[#f0dfc7] shadow-[0_8px_18px_rgba(0,0,0,0.25)] ring-1 ring-[#d1ad72]/20' : 'border-[#785A42]/40 bg-[#785A42]/8 text-[#785A42] shadow-[0_4px_12px_rgba(120,90,66,0.06)] ring-1 ring-[#785A42]/20'}`
                        : hasDiary
                          ? `${isDarkMode ? 'border-[#5f4a37]/45 bg-[#19130f] hover:bg-[#211812] hover:border-[#7a6246]/55 text-[#ead8c1] shadow-sm' : 'border-[#785A42]/20 bg-white hover:bg-[#785A42]/5 hover:border-[#785A42]/30 text-[#785A42] shadow-sm'} cursor-pointer`
                          : `${isDarkMode ? 'border-[#4a392b] bg-[#15110d] hover:bg-[#1d1711] text-[#d4c1a7]' : 'border-[#785A42]/10 bg-[#fffdf7] hover:bg-[#785A42]/6 text-[#785A42]'} cursor-pointer`
                }`}
              >
                <div className="flex items-baseline justify-between w-full">
                  <span className="flex items-center gap-1.5">
                    {batchSelectMode && hasDiary && (
                      isSelected
                        ? <CheckSquare className={`w-3.5 h-3.5 ${isDarkMode ? 'text-[#d8b36f]' : 'text-[#785A42]'}`} />
                        : <Square className={`w-3.5 h-3.5 ${isDarkMode ? 'text-[#6a5a4c]' : 'text-[#785A42]/30'}`} />
                    )}
                    <span className={`ka-value text-xl font-bold tracking-tight ${isToday ? (isDarkMode ? 'text-[#f0dfc7]' : 'text-[#5d402b]') : ''}`}>
                      {dayNumber}
                    </span>
                  </span>
                  <span className={`ka-micro font-medium uppercase tracking-wider ${isToday ? inkClass : `${isDarkMode ? 'text-[#8e7761] group-hover:text-[#c0a788]' : 'text-[#785A42]/40 group-hover:text-[#785A42]/60'}`} transition-colors`}>
                    {weekdayLabels[weekdayIndex]}
                  </span>
                </div>
                
                <div className="w-full flex items-center justify-between mt-3">
                  <span className={`text-[10px] font-medium tracking-wide ${inRange ? (hasDiary ? (isDarkMode ? 'text-[#c5b29a]' : 'text-[#785A42]/70') : (isDarkMode ? 'text-[#7a6756]' : 'text-[#785A42]/30')) : 'text-transparent'}`}>
                    {inRange ? (hasDiary ? (language === 'zh' ? '已有记录' : 'Recorded') : (language === 'zh' ? '空白' : 'Blank')) : ''}
                  </span>
                  {hasDiary && <span className={`w-2 h-2 rounded-full ${isDarkMode ? 'bg-[#d8b36f] shadow-[0_0_8px_rgba(216,179,111,0.32)]' : 'bg-[#785A42] shadow-[0_0_6px_rgba(120,90,66,0.6)]'}`} />}
                </div>

                {isToday && (
                  <div className={`absolute -bottom-2 -right-2 w-12 h-12 rounded-full blur-xl pointer-events-none ${isDarkMode ? 'bg-[#d2ab6e]/8' : 'bg-[#785A42]/5'}`} />
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  // P1 #30: `renderWeekView` used to exist here but was never reachable — the
  // ViewLevel union only has 'year' | 'month' | 'day', and no UI switched to
  // 'week'. Removed along with its sole supporting state `selectedWeekMonday`
  // and helper `getMondayOfWeek`.

  const renderDayView = () => (
    <div className="px-4 py-3">
      <div className={`${cardBgClass} rounded-xl shadow-md border ${borderClass} overflow-hidden`}>
        <div className={`${cardHeaderBgClass} px-5 py-2.5 border-b ${borderClass}`}>
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={() => prevDiaryDate && syncSelectedDate(prevDiaryDate)}
              disabled={!prevDiaryDate}
              className={`p-1.5 rounded-full transition-colors ${
                prevDiaryDate
                  ? `${inkClass} ${isDarkMode ? 'hover:bg-white/5' : 'hover:bg-[#785A42]/10'}`
                  : `${disabledInkClass} cursor-not-allowed`
              }`}
            >
              <ChevronLeft size={16} />
            </button>
            <div className={`${inkClass} font-mincho ka-label font-semibold tracking-[0.03em] text-center flex-1`}>{titleText}</div>
            <button
              onClick={() => nextDiaryDate && syncSelectedDate(nextDiaryDate)}
              disabled={!nextDiaryDate}
              className={`p-1.5 rounded-full transition-colors ${
                nextDiaryDate
                  ? `${inkClass} ${isDarkMode ? 'hover:bg-white/5' : 'hover:bg-[#785A42]/10'}`
                  : `${disabledInkClass} cursor-not-allowed`
              }`}
            >
              <ChevronRight size={16} />
            </button>
            {currentDiary?.rewriteCount && currentDiary.rewriteCount > 0 && (
              <span
                title={language === 'zh' ? `已重写 ${currentDiary.rewriteCount} 次` : `Rewritten ${currentDiary.rewriteCount} time${currentDiary.rewriteCount > 1 ? 's' : ''}`}
                className={`ml-1 cursor-default ${isDarkMode ? 'text-[#cdb89f]/50' : 'text-[#785A42]/45'}`}
              >
                <PenLine size={11} />
              </span>
            )}
            {currentDiary && (
              <button
                onClick={handleRewriteCurrentDiary}
                disabled={rewritingDate === selectedDate}
                className={`flex items-center gap-1 px-2.5 py-1 rounded border ka-micro font-semibold transition-colors ml-1 ${
                  rewritingDate === selectedDate
                    ? `${borderClass} ${disabledInkClass} cursor-not-allowed`
                    : `${borderClass} ${inkClass} ${isDarkMode ? 'hover:bg-white/5' : 'hover:bg-[#785A42]/10'}`
                }`}
                title={language === 'zh' ? '如果旧内容写偏了，可以按当前设定直接覆盖重写' : 'Rewrite this entry with current canon settings'}
              >
                <RefreshCw size={11} className={rewritingDate === selectedDate ? 'animate-spin' : ''} />
                {rewritingDate === selectedDate
                  ? (language === 'zh' ? '重写中...' : 'Rewriting...')
                  : (language === 'zh' ? '重写' : 'Rewrite')}
              </button>
            )}
          </div>
          {(rewriteError || rewriteFeedback) && (
            <div className={`mt-1.5 ka-micro ${rewriteError ? 'text-red-500' : 'text-green-600'}`}>
              {rewriteError || rewriteFeedback}
            </div>
          )}
        </div>
        <div className="px-5 py-4 min-h-[250px]">
          {currentDiary ? (
            <div className="space-y-4">
              <div className={`${inkClass} leading-relaxed whitespace-pre-wrap ka-copy`}>{currentDiary.content}</div>
              <div className={`pt-4 mt-4 border-t ${borderClass} ka-copy-sm ${inkMutedClass} italic`}>
                {language === 'zh' ? '摘要' : 'Summary'}: {currentDiary.summary}
              </div>
            </div>
          ) : (
            <div className={`flex flex-col items-center justify-center ${inkMutedClass} space-y-3 py-10`}>
              <BookOpen size={28} className="opacity-50" />
              <p className="ka-copy-sm">
                {selectedDate === todayStr
                  ? (language === 'zh' ? '今天的日记还没有写...' : "Today's diary hasn't been written yet...")
                  : (language === 'zh' ? '这一天没有日记。' : 'No diary for this day.')}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className={`absolute inset-0 z-50 flex flex-col ${shellBgClass}`} style={{ opacity: isOpen ? 1 : 0, transform: isOpen ? 'translateY(0)' : 'translateY(10px)', pointerEvents: isOpen ? 'auto' as const : 'none' as const, visibility: isOpen ? 'visible' as const : 'hidden' as const, transition: isOpen ? 'opacity 300ms ease-out, transform 300ms ease-out, visibility 0s 0s' : 'opacity 200ms ease-in, transform 200ms ease-in, visibility 0s 200ms', willChange: 'opacity, transform' as const, contain: 'layout style' as const }}>
      {/* Header */}
      <div className={`flex-none h-14 border-b ${borderClass} flex items-center justify-between px-4 ${chromeBgClass} backdrop-blur-md`}>
        <div className="flex items-center gap-2">
          {viewLevel !== 'year' ? (
            <button onClick={handleBack} className={`p-1.5 ${inkSoftClass} ${isDarkMode ? 'hover:text-[#ead8c1] hover:bg-white/5' : 'hover:text-[#785A42] hover:bg-[#785A42]/5'} rounded-full transition-colors`}>
              <ArrowLeft size={18} />
            </button>
          ) : (
            <Calendar size={18} className={inkClass} />
          )}
          <h2 className={`font-mincho ka-overlay-title font-semibold tracking-[0.03em] ${inkClass}`}>
            {language === 'zh' ? '久美子的日记' : "Kumiko's Diary"}
          </h2>
        </div>
        <div className="flex items-center gap-1">
          {gapCheckMsg && (
            <span className={`ka-micro mr-1 animate-in fade-in duration-300 ${isDarkMode ? 'text-green-400/80' : 'text-green-600/80'}`}>{gapCheckMsg}</span>
          )}
          <button
            onClick={() => checkGaps(true)}
            title={language === 'zh' ? '检查日记缺口' : 'Check diary gaps'}
            className={`p-2 ${inkMutedClass} ${isDarkMode ? 'hover:text-[#ead8c1] hover:bg-white/5' : 'hover:text-[#785A42] hover:bg-[#785A42]/5'} rounded-full transition-colors`}
          >
            <RefreshCw size={16} />
          </button>
          <button onClick={onClose} className={`p-2 ${inkSoftClass} ${isDarkMode ? 'hover:text-[#ead8c1] hover:bg-white/5' : 'hover:text-[#785A42] hover:bg-[#785A42]/5'} rounded-full transition-colors`}>
            <X size={20} />
          </button>
        </div>
      </div>

      {/* Auto-backfill toggle moved to Settings > Diary & Life Stream (P0 #12). */}

      {/* Sub-header with navigation title — hidden in day view to avoid date duplication */}
      {viewLevel !== 'day' && (
        <div className={`flex-none h-10 border-b ${borderClass} flex items-center justify-between px-4 ${subChromeBgClass}`}>
          {viewLevel === 'year' ? (
            <>
              <button onClick={() => canGoYearLeft && animate(() => setSelectedYear(y => y - 1))} disabled={!canGoYearLeft}
                className={`p-1 rounded ${canGoYearLeft ? `${inkClass} ${isDarkMode ? 'hover:bg-white/5' : 'hover:bg-[#785A42]/5'}` : disabledInkClass}`}>
                <ChevronLeft size={16} />
              </button>
              <span className={`font-mincho ka-label font-semibold tracking-[0.03em] ${inkClass}`}>{titleText}</span>
              <button onClick={() => canGoYearRight && animate(() => setSelectedYear(y => y + 1))} disabled={!canGoYearRight}
                className={`p-1 rounded ${canGoYearRight ? `${inkClass} ${isDarkMode ? 'hover:bg-white/5' : 'hover:bg-[#785A42]/5'}` : disabledInkClass}`}>
                <ChevronRight size={16} />
              </button>
            </>
          ) : (
            <div className="flex items-center justify-between w-full">
              <span className={`font-mincho ka-label font-semibold tracking-[0.03em] ${inkClass}`}>{titleText}</span>
              <button
                onClick={() => {
                  setBatchSelectMode(prev => {
                    if (prev) setSelectedForRewrite(new Set());
                    return !prev;
                  });
                }}
                title={language === 'zh' ? (batchSelectMode ? '退出批量选择' : '批量重写') : (batchSelectMode ? 'Exit selection' : 'Batch rewrite')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all ${
                  batchSelectMode
                    ? `${isDarkMode ? 'bg-[#d8b36f]/20 text-[#d8b36f] border border-[#d8b36f]/30' : 'bg-[#785A42]/10 text-[#785A42] border border-[#785A42]/30'}`
                    : `${isDarkMode ? 'text-[#8e7761] hover:text-[#ead8c1] hover:bg-white/5' : 'text-[#785A42]/50 hover:text-[#785A42] hover:bg-[#785A42]/5'}`
                }`}
              >
                {language === 'zh' ? (batchSelectMode ? '退出选择' : '批量重写') : (batchSelectMode ? 'Cancel' : 'Batch')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Content */}
      <div data-resize-heavy className={`flex-1 overflow-y-auto transition-opacity duration-150 ${isAnimating ? 'opacity-0' : 'opacity-100'}`}>
        {viewLevel === 'year' && renderYearView()}
        {viewLevel === 'month' && renderMonthView()}
        {viewLevel === 'day' && renderDayView()}
      </div>

      {gapInfo && gapInfo.totalMissing > 0 && (
        <DiaryBackfillDialog
          gapInfo={gapInfo}
          language={language || 'zh'}
          isDarkMode={isDarkMode}
          onConfirmAll={handleBfAll}
          onConfirmOne={handleBfOne}
          onDismiss={handleBfDismiss}
          progress={bfProgress}
          isComplete={bfComplete}
          generatedCount={bfCount}
        />
      )}

      <CustomDialog
        isOpen={showRewriteConfirm}
        title={language === 'zh' ? '重写日记' : 'Rewrite Diary'}
        message={language === 'zh'
          ? '要按当前设定重写这篇日记吗？这会直接覆盖当前内容。'
          : 'Rewrite this diary using the current canon settings? This will overwrite the current entry.'}
        type="confirm"
        confirmText={language === 'zh' ? '确定重写' : 'Rewrite'}
        cancelText={language === 'zh' ? '取消' : 'Cancel'}
        onConfirm={handleRewriteConfirmed}
        onCancel={() => setShowRewriteConfirm(false)}
        isDarkMode={isDarkMode}
        language={language}
      />

      {batchSelectMode && viewLevel === 'month' && selectedForRewrite.size > 0 && !batchRewriting && (
        <div className={`flex-none border-t ${borderClass} px-4 py-3 ${subChromeBgClass} flex items-center justify-between`}>
          <span className={`ka-label ${inkClass} text-sm`}>
            {language === 'zh' ? `已选 ${selectedForRewrite.size} 篇` : `${selectedForRewrite.size} selected`}
          </span>
          <button
            onClick={() => setShowBatchConfirm(true)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${isDarkMode ? 'bg-[#d8b36f]/20 text-[#d8b36f] hover:bg-[#d8b36f]/30 border border-[#d8b36f]/30' : 'bg-[#785A42]/10 text-[#785A42] hover:bg-[#785A42]/15 border border-[#785A42]/20'}`}
          >
            {language === 'zh' ? '开始重写' : 'Start Rewrite'}
          </button>
        </div>
      )}

      {batchRewriting && batchRewriteProgress && (
        <div className={`flex-none border-t ${borderClass} px-4 py-3 ${subChromeBgClass}`}>
          <div className="flex items-center justify-between mb-2">
            <span className={`ka-label text-sm ${inkClass}`}>
              {language === 'zh' ? `重写中 ${batchRewriteProgress.current}/${batchRewriteProgress.total}` : `Rewriting ${batchRewriteProgress.current}/${batchRewriteProgress.total}`}
            </span>
            <span className={`ka-micro text-xs ${inkMutedClass}`}>{batchRewriteProgress.dateStr}</span>
          </div>
          <div className={`w-full h-1.5 rounded-full ${isDarkMode ? 'bg-[#3a2d21]' : 'bg-[#785A42]/10'}`}>
            <div
              className={`h-full rounded-full transition-all duration-300 ${isDarkMode ? 'bg-[#d8b36f]' : 'bg-[#785A42]'}`}
              style={{ width: `${(batchRewriteProgress.current / batchRewriteProgress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      <CustomDialog
        isOpen={showBatchConfirm}
        title={language === 'zh' ? '批量重写日记' : 'Batch Rewrite'}
        message={language === 'zh'
          ? `确定要重写选中的 ${selectedForRewrite.size} 篇日记吗？将按日期顺序逐篇重写，耗时较长。`
          : `Rewrite ${selectedForRewrite.size} selected entries? They will be rewritten sequentially. This may take a while.`}
        type="confirm"
        confirmText={language === 'zh' ? '确定重写' : 'Confirm'}
        cancelText={language === 'zh' ? '取消' : 'Cancel'}
        onConfirm={async () => {
          setShowBatchConfirm(false);
          setBatchRewriting(true);
          setBatchRewriteResult(null);
          try {
            const { batchRewriteDiaries } = await import('../services/lifeStreamService');
            const result = await batchRewriteDiaries(
              Array.from(selectedForRewrite),
              (current, total, dateStr) => setBatchRewriteProgress({ current, total, dateStr })
            );
            setBatchRewriteResult(result);
          } catch (e) {
            console.error('[DiaryPanel] Batch rewrite failed:', e);
            setBatchRewriteResult({ rewritten: 0, failed: Array.from(selectedForRewrite), total: selectedForRewrite.size });
          } finally {
            setBatchRewriting(false);
            setBatchRewriteProgress(null);
            setSelectedForRewrite(new Set());
            setBatchSelectMode(false);
          }
        }}
        onCancel={() => setShowBatchConfirm(false)}
        isDarkMode={isDarkMode}
        language={language}
      />

      <CustomDialog
        isOpen={batchRewriteResult !== null}
        title={language === 'zh' ? '批量重写完成' : 'Batch Rewrite Complete'}
        message={batchRewriteResult
          ? (language === 'zh'
            ? `共 ${batchRewriteResult.total} 篇，成功重写 ${batchRewriteResult.rewritten} 篇。${batchRewriteResult.failed.length > 0 ? `\n失败：${batchRewriteResult.failed.join('、')}` : ''}`
            : `${batchRewriteResult.rewritten} of ${batchRewriteResult.total} rewritten.${batchRewriteResult.failed.length > 0 ? `\nFailed: ${batchRewriteResult.failed.join(', ')}` : ''}`)
          : ''}
        type="info"
        confirmText={language === 'zh' ? '好的' : 'OK'}
        onConfirm={() => setBatchRewriteResult(null)}
        onCancel={() => setBatchRewriteResult(null)}
        isDarkMode={isDarkMode}
        language={language}
      />
    </div>
  );
};
