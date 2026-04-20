import { useEffect } from 'react';
import { DEFAULT_WORLD_BOOK, LOCALIZED_WORLD_BOOK } from '../constants';
import type { Language, WorldBookEntry } from '../types';

export interface UseWorldBookLocalizationParams {
  language: Language;
  isDataLoaded: boolean;
  setWorldBook: (
    v: WorldBookEntry[] | ((prev: WorldBookEntry[]) => WorldBookEntry[]),
  ) => void;
}

export function useWorldBookLocalization(params: UseWorldBookLocalizationParams): void {
  const { language, isDataLoaded, setWorldBook } = params;

  useEffect(() => {
      const officialLore = LOCALIZED_WORLD_BOOK[language] || DEFAULT_WORLD_BOOK;
      const officialLoreMap = new Map(officialLore.map(e => [e.id, e]));

      setWorldBook(prevBook => {
          let hasChanged = false;
          const customEntries = prevBook.filter(e => !officialLoreMap.has(e.id));

          const newOfficialEntries = officialLore.map(officialEntry => {
              const userSettings = prevBook.find(e => e.id === officialEntry.id);
              if (userSettings) {
                  if (userSettings.content !== officialEntry.content || userSettings.title !== officialEntry.title) {
                      hasChanged = true;
                  }
                  return {
                      ...officialEntry,
                      isActive: userSettings.isActive,
                      isHighPriority: userSettings.isHighPriority,
                  };
              }
              return officialEntry;
          });

          const prevOfficialCount = prevBook.filter(e => officialLoreMap.has(e.id)).length;

          if (prevOfficialCount !== newOfficialEntries.length) {
              hasChanged = true;
          }

          if (!hasChanged && customEntries.length === (prevBook.length - prevOfficialCount)) {
              return prevBook;
          }

          return [...newOfficialEntries, ...customEntries];
      });
  }, [language, isDataLoaded]);
}
