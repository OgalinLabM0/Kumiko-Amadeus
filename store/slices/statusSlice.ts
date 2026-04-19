import type { StateCreator } from 'zustand';
import { AppState } from '../../types';

export interface StatusSlice {
  isDataLoaded: boolean;
  dataLoadError: string | null;
  appState: AppState;
  systemNotice: string | null;
  statusText: string;
  isDisconnected: boolean;

  setIsDataLoaded: (v: boolean) => void;
  setDataLoadError: (v: string | null) => void;
  setAppState: (v: AppState) => void;
  setSystemNotice: (v: string | null) => void;
  setStatusText: (v: string | ((prev: string) => string)) => void;
  setIsDisconnected: (v: boolean) => void;
}

export const createStatusSlice: StateCreator<StatusSlice, [], [], StatusSlice> = (set) => ({
  isDataLoaded: false,
  dataLoadError: null,
  appState: AppState.CONNECTING,
  systemNotice: null,
  statusText: '',
  isDisconnected: false,

  setIsDataLoaded: (v) => set({ isDataLoaded: v }),
  setDataLoadError: (v) => set({ dataLoadError: v }),
  setAppState: (v) => set({ appState: v }),
  setSystemNotice: (v) => set({ systemNotice: v }),
  setStatusText: (v) => set((s) => ({ statusText: typeof v === 'function' ? v(s.statusText) : v })),
  setIsDisconnected: (v) => set({ isDisconnected: v }),
});
