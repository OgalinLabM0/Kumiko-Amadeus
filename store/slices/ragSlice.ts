import type { StateCreator } from 'zustand';

export const RAG_HISTORY_DIRTY_STORAGE_KEY = 'kumiko_rag_history_dirty';

export type RagStatusValue = 'IDLE' | 'RECALLING' | 'INDEXING' | 'ERROR' | 'OFF';

export interface RagSlice {
  ragStatus: RagStatusValue;
  ragProgressLabel: string | null;
  isRagHistoryDirty: boolean;
  ragDirtyNoticeShown: boolean;

  setRagStatus: (v: RagStatusValue | ((prev: RagStatusValue) => RagStatusValue)) => void;
  setRagProgressLabel: (v: string | null) => void;
  setIsRagHistoryDirty: (v: boolean) => void;
  setRagDirtyNoticeShown: (v: boolean) => void;
}

export const createRagSlice: StateCreator<RagSlice, [], [], RagSlice> = (set) => ({
  ragStatus: 'OFF',
  ragProgressLabel: null,
  isRagHistoryDirty: false,
  ragDirtyNoticeShown: false,

  setRagStatus: (v) => set((s) => ({ ragStatus: typeof v === 'function' ? v(s.ragStatus) : v })),
  setRagProgressLabel: (v) => set({ ragProgressLabel: v }),
  setIsRagHistoryDirty: (v) => set({ isRagHistoryDirty: v }),
  setRagDirtyNoticeShown: (v) => set({ ragDirtyNoticeShown: v }),
});
