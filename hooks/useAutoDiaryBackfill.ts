import { useCallback, useEffect, useState } from 'react';

// Shared persistent toggle for "automatically fill missing diary entries in the
// background". Used to live inline inside DiaryPanel; now that the setting has
// moved to SettingsPanel / DiaryLifeSection, both components read/write the same
// localStorage key via this hook so their views stay in lock-step.
export const AUTO_DIARY_BACKFILL_STORAGE_KEY = 'kumiko_auto_diary_backfill';
const STORAGE_EVENT_FLAG = 'kumiko-auto-diary-backfill-changed';

const readPersisted = (): boolean => {
  try {
    return window.localStorage.getItem(AUTO_DIARY_BACKFILL_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
};

const writePersisted = (value: boolean) => {
  try {
    window.localStorage.setItem(AUTO_DIARY_BACKFILL_STORAGE_KEY, value ? 'true' : 'false');
    // Broadcast intra-tab change so the DiaryPanel instance that didn't initiate
    // the write still observes it (storage events only fire cross-tab).
    window.dispatchEvent(new CustomEvent(STORAGE_EVENT_FLAG, { detail: value }));
  } catch {
    // Ignore storage write failures (e.g. private-mode localStorage).
  }
};

export const useAutoDiaryBackfill = (): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] => {
  const [value, setValue] = useState<boolean>(() => readPersisted());

  useEffect(() => {
    const onCustom = (e: Event) => {
      const ce = e as CustomEvent<boolean>;
      if (typeof ce.detail === 'boolean') setValue(ce.detail);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === AUTO_DIARY_BACKFILL_STORAGE_KEY) {
        setValue(e.newValue === 'true');
      }
    };
    window.addEventListener(STORAGE_EVENT_FLAG, onCustom);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(STORAGE_EVENT_FLAG, onCustom);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const update = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setValue(prev => {
      const resolved = typeof next === 'function' ? (next as (prev: boolean) => boolean)(prev) : next;
      writePersisted(resolved);
      return resolved;
    });
  }, []);

  return [value, update];
};
