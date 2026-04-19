import type { StateCreator } from 'zustand';
import type { DiaryGapInfo } from '../../services/lifeStreamService';

const AUTO_DIARY_BACKFILL_STORAGE_KEY = 'kumiko_auto_diary_backfill';

export interface DiarySlice {
  diaryRewritingDate: string | null;
  diaryBfProgress: { current: number; total: number; currentDate: string } | undefined;
  diaryBfComplete: boolean;
  diaryBfCount: number;
  backfillGapInfo: DiaryGapInfo | null;
  backfillProgress: { current: number; total: number; currentDate: string } | undefined;
  backfillComplete: boolean;
  backfillGeneratedCount: number;
  autoDiaryBackfillRunning: boolean;

  setDiaryRewritingDate: (v: string | null) => void;
  setDiaryBfProgress: (v: { current: number; total: number; currentDate: string } | undefined) => void;
  setDiaryBfComplete: (v: boolean) => void;
  setDiaryBfCount: (v: number) => void;
  setBackfillGapInfo: (v: DiaryGapInfo | null) => void;
  runDiaryBackfill: (dates: string[], afterContext?: string) => Promise<void>;
  isAutoDiaryBackfillEnabled: () => boolean;
  runAutoDiaryBackfill: (precomputedGapInfo?: DiaryGapInfo | null) => Promise<boolean>;
  handleBackfillAll: () => Promise<void>;
  handleBackfillOne: () => Promise<void>;
  dismissBackfill: () => void;
}

export const createDiarySlice: StateCreator<DiarySlice, [], [], DiarySlice> = (set, get) => ({
  diaryRewritingDate: null,
  diaryBfProgress: undefined,
  diaryBfComplete: false,
  diaryBfCount: 0,
  backfillGapInfo: null,
  backfillProgress: undefined,
  backfillComplete: false,
  backfillGeneratedCount: 0,
  autoDiaryBackfillRunning: false,

  setDiaryRewritingDate: (v) => set({ diaryRewritingDate: v }),
  setDiaryBfProgress: (v) => set({ diaryBfProgress: v }),
  setDiaryBfComplete: (v) => set({ diaryBfComplete: v }),
  setDiaryBfCount: (v) => set({ diaryBfCount: v }),
  setBackfillGapInfo: (v) => set({ backfillGapInfo: v }),

  runDiaryBackfill: async (dates, afterContext) => {
    const { batchGenerateDiaries } = await import('../../services/lifeStreamService');
    set({ backfillComplete: false, backfillGeneratedCount: 0 });
    const count = await batchGenerateDiaries(
      dates,
      (current, total, currentDate) => set({ backfillProgress: { current, total, currentDate } }),
      afterContext,
    );
    set({ backfillProgress: undefined, backfillComplete: true, backfillGeneratedCount: count });
  },

  isAutoDiaryBackfillEnabled: () => {
    try {
      return window.localStorage.getItem(AUTO_DIARY_BACKFILL_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  },

  runAutoDiaryBackfill: async (precomputedGapInfo) => {
    if (!get().isAutoDiaryBackfillEnabled() || get().autoDiaryBackfillRunning) return false;

    set({ autoDiaryBackfillRunning: true });
    try {
      const { batchGenerateDiaries, detectDiaryGaps } = await import('../../services/lifeStreamService');
      const gapInfo = precomputedGapInfo && precomputedGapInfo.totalMissing > 0
        ? precomputedGapInfo
        : await detectDiaryGaps();

      if (gapInfo.totalMissing <= 0 || gapInfo.missingDates.length === 0) return false;

      await batchGenerateDiaries(gapInfo.missingDates, () => {}, gapInfo.contextAfter);
      return true;
    } catch (error) {
      console.warn('[Diary] Auto background backfill failed:', error);
      return false;
    } finally {
      set({ autoDiaryBackfillRunning: false });
    }
  },

  handleBackfillAll: async () => {
    const { backfillGapInfo, runDiaryBackfill } = get();
    if (!backfillGapInfo || backfillGapInfo.missingDates.length === 0) return;
    await runDiaryBackfill(backfillGapInfo.missingDates, backfillGapInfo.contextAfter);
  },

  handleBackfillOne: async () => {
    const { backfillGapInfo, runDiaryBackfill } = get();
    if (!backfillGapInfo || backfillGapInfo.missingDates.length === 0) return;
    const sorted = [...backfillGapInfo.missingDates].sort();
    const lastOne = sorted[sorted.length - 1];
    await runDiaryBackfill([lastOne], backfillGapInfo.contextAfter);
  },

  dismissBackfill: () => {
    set({
      backfillGapInfo: null,
      backfillProgress: undefined,
      backfillComplete: false,
      backfillGeneratedCount: 0,
    });
  },
});
