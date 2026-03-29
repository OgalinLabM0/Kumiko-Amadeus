import { AnchorEntry, EmotionType, Language, LocationConfig, Message, SummaryArchiveState, WorldBookEntry } from '../../types';

export interface RelativeReminderBackup {
  id: string;
  event: string;
  dueAt: number;
  createdAt: number;
  sourceText?: string;
  retryAt?: number;
}

export interface DailyReminderBackup {
  id: string;
  event: string;
  hour: number;
  minute: number;
  timeZone: string;
  createdAt: number;
  paused?: boolean;
  lastTriggeredDate?: string;
  sourceText?: string;
  retryAt?: number;
}

export interface BackupPayload {
  messages: Message[];
  coreMemory: string;
  worldBook: Partial<WorldBookEntry>[];
  contextLimit: number;
  turnCount: number;
  summaryArchiveState: SummaryArchiveState;
  currentEmotion: EmotionType;
  locationConfig: LocationConfig;
  language: Language;
  anchors: AnchorEntry[];
  kumikoNotebook: string;
  relativeReminders: RelativeReminderBackup[];
  dailyReminders: DailyReminderBackup[];
}

interface BuildBackupDataParams {
  messages: Message[];
  coreMemory: string;
  worldBook: WorldBookEntry[];
  contextLimit: number;
  turnCount: number;
  summaryArchiveState: SummaryArchiveState;
  currentEmotion: EmotionType;
  locationConfig: LocationConfig;
  language: Language;
  anchors: AnchorEntry[];
  kumikoNotebook: string;
  relativeReminders: RelativeReminderBackup[];
  dailyReminders: DailyReminderBackup[];
  defaultWorldBook: WorldBookEntry[];
  localizedWorldBook: Record<Language, WorldBookEntry[]>;
}

export const sanitizeWorldBookForBackup = (
  worldBook: WorldBookEntry[],
  language: Language,
  localizedWorldBook: Record<Language, WorldBookEntry[]>,
  defaultWorldBook: WorldBookEntry[]
): Partial<WorldBookEntry>[] => {
  const officialIds = new Set((localizedWorldBook[language] || defaultWorldBook).map(entry => entry.id));

  return worldBook.map(entry => {
    if (officialIds.has(entry.id)) {
      return {
        id: entry.id,
        isActive: entry.isActive,
        isHighPriority: entry.isHighPriority,
      };
    }

    return entry;
  });
};

export const buildBackupData = ({
  messages,
  coreMemory,
  worldBook,
  contextLimit,
  turnCount,
  summaryArchiveState,
  currentEmotion,
  locationConfig,
  language,
  anchors,
  kumikoNotebook,
  relativeReminders,
  dailyReminders,
  defaultWorldBook,
  localizedWorldBook,
}: BuildBackupDataParams): BackupPayload => ({
  messages,
  coreMemory,
  worldBook: sanitizeWorldBookForBackup(worldBook, language, localizedWorldBook, defaultWorldBook),
  contextLimit,
  turnCount,
  summaryArchiveState,
  currentEmotion,
  locationConfig,
  language,
  anchors,
  kumikoNotebook,
  relativeReminders,
  dailyReminders,
});

export const validateBackupData = (
  data: BackupPayload,
  language: Language,
  localizedWorldBook: Record<Language, WorldBookEntry[]>,
  defaultWorldBook: WorldBookEntry[]
): boolean => {
  if (!data?.worldBook || !Array.isArray(data.worldBook)) {
    console.warn('[Save Validation] Missing worldBook array');
    return false;
  }

  const officialEntryCount = (localizedWorldBook[language] || defaultWorldBook).length;
  const safeThreshold = Math.floor(officialEntryCount * 0.2);

  if (data.worldBook.length < safeThreshold) {
    console.warn(`[Save Validation] WorldBook size suspiciously low (${data.worldBook.length} < ${safeThreshold}). Write blocked.`);
    return false;
  }

  return true;
};
