import { StateCreator } from 'zustand';
import type { Language, LocationConfig } from '../../types';
import { DEFAULT_LOCATION_CONFIG } from '../../constants';

type FlowState = 'INTRO' | 'AUTH' | 'CONFIG' | 'APP';

export interface UiSlice {
  flowState: FlowState;
  isDarkMode: boolean;
  isFullscreen: boolean;
  isMemoryPanelOpen: boolean;
  isProfileOpen: boolean;
  isSettingsOpen: boolean;
  isMessageCenterOpen: boolean;
  isTaskPanelOpen: boolean;
  isDiaryOpen: boolean;
  language: Language;
  locationConfig: LocationConfig;
  viewingImage: string | null;

  setFlowState: (v: FlowState) => void;
  setIsDarkMode: (v: boolean | ((prev: boolean) => boolean)) => void;
  setIsFullscreen: (v: boolean) => void;
  setIsMemoryPanelOpen: (v: boolean) => void;
  setIsProfileOpen: (v: boolean) => void;
  setIsSettingsOpen: (v: boolean) => void;
  setIsMessageCenterOpen: (v: boolean) => void;
  setIsTaskPanelOpen: (v: boolean) => void;
  setIsDiaryOpen: (v: boolean) => void;
  setLanguage: (v: Language) => void;
  setLocationConfig: (v: LocationConfig | ((prev: LocationConfig) => LocationConfig)) => void;
  setViewingImage: (v: string | null) => void;
}

export const createUiSlice: StateCreator<UiSlice, [], [], UiSlice> = (set) => ({
  flowState: 'INTRO',
  isDarkMode: false,
  isFullscreen: false,
  isMemoryPanelOpen: false,
  isProfileOpen: false,
  isSettingsOpen: false,
  isMessageCenterOpen: false,
  isTaskPanelOpen: false,
  isDiaryOpen: false,
  language: 'zh',
  locationConfig: DEFAULT_LOCATION_CONFIG,
  viewingImage: null,

  setFlowState: (v) => set({ flowState: v }),
  setIsDarkMode: (v) => set((s) => ({ isDarkMode: typeof v === 'function' ? v(s.isDarkMode) : v })),
  setIsFullscreen: (v) => set({ isFullscreen: v }),
  setIsMemoryPanelOpen: (v) => set({ isMemoryPanelOpen: v }),
  setIsProfileOpen: (v) => set({ isProfileOpen: v }),
  setIsSettingsOpen: (v) => set({ isSettingsOpen: v }),
  setIsMessageCenterOpen: (v) => set({ isMessageCenterOpen: v }),
  setIsTaskPanelOpen: (v) => set({ isTaskPanelOpen: v }),
  setIsDiaryOpen: (v) => set({ isDiaryOpen: v }),
  setLanguage: (v) => set({ language: v }),
  setLocationConfig: (v) => set((s) => ({ locationConfig: typeof v === 'function' ? v(s.locationConfig) : v })),
  setViewingImage: (v) => set({ viewingImage: v }),
});
