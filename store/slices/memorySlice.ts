import { StateCreator } from 'zustand';
import type { WorldBookEntry, AnchorEntry } from '../../types';
import { LOCALIZED_WORLD_BOOK } from '../../constants';
import {
  DEFAULT_DIARY_LAYER_PRESET,
  type DiaryLayerPreset,
} from '../../constants/diaryLayerConfig';
import {
  DEFAULT_IMAGE_QUALITY_PRESET,
  type ImageQualityPreset,
} from '../../constants/imageQualityConfig';

export interface MemorySlice {
  coreMemory: string;
  kumikoNotebook: string;
  worldBook: WorldBookEntry[];
  contextLimit: number;
  anchors: AnchorEntry[];
  // Controls how much diary history is injected into the chat context vs. left
  // to RAG on-demand. See constants/diaryLayerConfig.ts.
  diaryLayerPreset: DiaryLayerPreset;
  // How aggressively user images are resampled before being stored on disk /
  // in Dexie. See constants/imageQualityConfig.ts.
  imageQualityPreset: ImageQualityPreset;

  setCoreMemory: (v: string) => void;
  setKumikoNotebook: (v: string) => void;
  setWorldBook: (v: WorldBookEntry[] | ((prev: WorldBookEntry[]) => WorldBookEntry[])) => void;
  setContextLimit: (v: number) => void;
  setAnchors: (v: AnchorEntry[] | ((prev: AnchorEntry[]) => AnchorEntry[])) => void;
  setDiaryLayerPreset: (v: DiaryLayerPreset) => void;
  setImageQualityPreset: (v: ImageQualityPreset) => void;
}

export const createMemorySlice: StateCreator<MemorySlice, [], [], MemorySlice> = (set) => ({
  coreMemory: '',
  kumikoNotebook: '',
  worldBook: LOCALIZED_WORLD_BOOK['zh'],
  contextLimit: 100,
  anchors: [],
  diaryLayerPreset: DEFAULT_DIARY_LAYER_PRESET,
  imageQualityPreset: DEFAULT_IMAGE_QUALITY_PRESET,

  setCoreMemory: (v) => set({ coreMemory: v }),
  setKumikoNotebook: (v) => set({ kumikoNotebook: v }),
  setWorldBook: (v) => set((s) => ({ worldBook: typeof v === 'function' ? v(s.worldBook) : v })),
  setContextLimit: (v) => set({ contextLimit: v }),
  setAnchors: (v) => set((s) => ({ anchors: typeof v === 'function' ? v(s.anchors) : v })),
  setDiaryLayerPreset: (v) => set({ diaryLayerPreset: v }),
  setImageQualityPreset: (v) => set({ imageQualityPreset: v }),
});
