import { AnchorEntry, EmotionType, Language, LocationConfig, Message, SummaryArchiveState, WorldBookEntry } from '../../types';
import { DailyFragmentEntity, KumikoDiaryEntity, PsycheStateEntity, WorldCharacterStatusMap } from '../../services/db';

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
  worldCharacterStatus?: WorldCharacterStatusMap;
  kumikoDiary?: KumikoDiaryEntity[];
  dailyFragments?: DailyFragmentEntity[];
  psycheState?: PsycheStateEntity | null;
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
  worldCharacterStatus?: WorldCharacterStatusMap;
  kumikoDiary?: KumikoDiaryEntity[];
  dailyFragments?: DailyFragmentEntity[];
  psycheState?: PsycheStateEntity | null;
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
  worldCharacterStatus,
  kumikoDiary,
  dailyFragments,
  psycheState,
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
  worldCharacterStatus,
  kumikoDiary,
  dailyFragments,
  psycheState,
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

  // Structural sanity checks: if a field is present, it must have the right
  // shape. Missing fields are tolerated to avoid false-positives on fresh
  // installs / first-run empty state. The goal is to catch the case where a
  // code bug overwrites a field with a wrong-typed value before autosave
  // silently commits the corruption to disk.
  if (data.messages !== undefined && !Array.isArray(data.messages)) {
    console.warn('[Save Validation] messages present but not an array. Write blocked.');
    return false;
  }

  if (data.relativeReminders !== undefined && !Array.isArray(data.relativeReminders)) {
    console.warn('[Save Validation] relativeReminders present but not an array. Write blocked.');
    return false;
  }

  if (data.dailyReminders !== undefined && !Array.isArray(data.dailyReminders)) {
    console.warn('[Save Validation] dailyReminders present but not an array. Write blocked.');
    return false;
  }

  if (data.kumikoDiary !== undefined && !Array.isArray(data.kumikoDiary)) {
    console.warn('[Save Validation] kumikoDiary present but not an array. Write blocked.');
    return false;
  }

  if (
    data.worldCharacterStatus !== undefined &&
    data.worldCharacterStatus !== null &&
    (typeof data.worldCharacterStatus !== 'object' || Array.isArray(data.worldCharacterStatus))
  ) {
    console.warn('[Save Validation] worldCharacterStatus present but not a plain object. Write blocked.');
    return false;
  }

  if (
    data.summaryArchiveState !== undefined &&
    data.summaryArchiveState !== null &&
    typeof data.summaryArchiveState !== 'object'
  ) {
    console.warn('[Save Validation] summaryArchiveState present but not an object. Write blocked.');
    return false;
  }

  return true;
};
