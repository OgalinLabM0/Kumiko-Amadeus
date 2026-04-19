import { StateCreator } from 'zustand';
import type { SummaryArchiveState } from '../../types';
import { createInitialSummaryArchiveState } from '../../components/app/summaryCycle';

export interface SummarySlice {
  turnCount: number;
  summaryArchiveState: SummaryArchiveState;

  setTurnCount: (v: number) => void;
  setSummaryArchiveState: (v: SummaryArchiveState | ((prev: SummaryArchiveState) => SummaryArchiveState)) => void;
}

export const createSummarySlice: StateCreator<SummarySlice, [], [], SummarySlice> = (set) => ({
  turnCount: 0,
  summaryArchiveState: createInitialSummaryArchiveState(0),

  setTurnCount: (v) => set({ turnCount: v }),
  setSummaryArchiveState: (v) => set((s) => ({ summaryArchiveState: typeof v === 'function' ? v(s.summaryArchiveState) : v })),
});
