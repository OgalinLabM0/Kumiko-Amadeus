import type { StateCreator } from 'zustand';

export interface SelectionSlice {
  isSelectionMode: boolean;
  selectedIds: Set<string>;
  showDeleteConfirm: boolean;
  showClearFlow: boolean;
  showDoubleClearFlow: boolean;

  setIsSelectionMode: (v: boolean) => void;
  setSelectedIds: (v: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  setShowDeleteConfirm: (v: boolean) => void;
  setShowClearFlow: (v: boolean) => void;
  setShowDoubleClearFlow: (v: boolean) => void;
}

export const createSelectionSlice: StateCreator<SelectionSlice, [], [], SelectionSlice> = (set) => ({
  isSelectionMode: false,
  selectedIds: new Set(),
  showDeleteConfirm: false,
  showClearFlow: false,
  showDoubleClearFlow: false,

  setIsSelectionMode: (v) => set({ isSelectionMode: v }),
  setSelectedIds: (v) => set((s) => ({ selectedIds: typeof v === 'function' ? v(s.selectedIds) : v })),
  setShowDeleteConfirm: (v) => set({ showDeleteConfirm: v }),
  setShowClearFlow: (v) => set({ showClearFlow: v }),
  setShowDoubleClearFlow: (v) => set({ showDoubleClearFlow: v }),
});
