import { create } from 'zustand';
import { createUiSlice, type UiSlice } from './slices/uiSlice';
import { createStatusSlice, type StatusSlice } from './slices/statusSlice';
import { createUpdaterSlice, type UpdaterSlice } from './slices/updaterSlice';
import { createMemorySlice, type MemorySlice } from './slices/memorySlice';
import { createSummarySlice, type SummarySlice } from './slices/summarySlice';
import { createChatSlice, type ChatSlice } from './slices/chatSlice';
import { createVoiceSlice, type VoiceSlice } from './slices/voiceSlice';
import { createBackupSlice, type BackupSlice } from './slices/backupSlice';
import { createSelectionSlice, type SelectionSlice } from './slices/selectionSlice';
import { createRagSlice, type RagSlice } from './slices/ragSlice';
import { createReminderSlice, type ReminderSlice } from './slices/reminderSlice';
import { createDiarySlice, type DiarySlice } from './slices/diarySlice';
import { createBusySlice, type BusySlice } from './slices/busySlice';

export type AppStoreState = UiSlice & StatusSlice & UpdaterSlice & MemorySlice & SummarySlice & ChatSlice & VoiceSlice & BackupSlice & SelectionSlice & RagSlice & ReminderSlice & DiarySlice & BusySlice;

export const useAppStore = create<AppStoreState>()((...args) => ({
  ...createUiSlice(...args),
  ...createStatusSlice(...args),
  ...createUpdaterSlice(...args),
  ...createMemorySlice(...args),
  ...createSummarySlice(...args),
  ...createChatSlice(...args),
  ...createVoiceSlice(...args),
  ...createBackupSlice(...args),
  ...createSelectionSlice(...args),
  ...createRagSlice(...args),
  ...createReminderSlice(...args),
  ...createDiarySlice(...args),
  ...createBusySlice(...args),
}));
