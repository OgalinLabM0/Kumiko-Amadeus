import { useEffect, useState } from 'react';
import { Language } from '../../types';
import { SettingsDialogConfig } from './useSettingsDialog';
import {
  PREFERENCES_UPDATED_EVENT,
  queueLocalStoragePreferenceSync,
} from '../../services/preferencesSync';

interface SearchTranslations {
  searchStatusTesting: string;
  searchStatusSuccess: string;
  searchStatusFailed: string;
}

type ShowDialog = (config: Omit<SettingsDialogConfig, 'isOpen'>) => void;

export const useTavilySearchSettings = (
  isSettingsOpen: boolean,
  isInternetSearchOpen: boolean,
  language: Language,
  t: SearchTranslations,
  showDialog: ShowDialog
) => {
  const [tavilyApiKey, setTavilyApiKey] = useState('');
  const [enableInternetSearch, setEnableInternetSearch] = useState(false);
  const [tavilyUsage, setTavilyUsage] = useState<string | null>(null);
  const [searchStatus, setSearchStatus] = useState<string>('');
  const [searchStatusType, setSearchStatusType] = useState<'neutral' | 'success' | 'error'>('neutral');

  const syncFromStorage = () => {
    const storedTavilyKey = localStorage.getItem('tavily_api_key') || '';
    const storedEnableSearch = localStorage.getItem('enable_internet_search') === 'true';
    setTavilyApiKey(storedTavilyKey);
    setEnableInternetSearch(storedEnableSearch);
  };

  useEffect(() => {
    syncFromStorage();
  }, [isSettingsOpen]);

  useEffect(() => {
    const handlePreferencesUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ keys?: string[] }>).detail;
      if (!Array.isArray(detail?.keys)) return;
      if (detail.keys.includes('tavily_api_key') || detail.keys.includes('enable_internet_search')) {
        syncFromStorage();
      }
    };
    window.addEventListener(PREFERENCES_UPDATED_EVENT, handlePreferencesUpdated as EventListener);
    return () => {
      window.removeEventListener(PREFERENCES_UPDATED_EVENT, handlePreferencesUpdated as EventListener);
    };
  }, []);

  const refreshUsage = async (key = tavilyApiKey) => {
    if (!key) {
      setTavilyUsage(null);
      return;
    }
    try {
      const res = await fetch('https://search.omkk.org/api/usage', {
        headers: { 'x-api-key': key }
      });
      if (res.ok) {
        const data = await res.json();
        setTavilyUsage(`${data.used} / ${data.limit}`);
      } else {
        setTavilyUsage('Error fetching usage');
      }
    } catch {
      setTavilyUsage('Network error');
    }
  };

  // Preload rework: fetch usage as soon as the API key is known (which
  // happens on SettingsPanel mount because it's now permanently mounted),
  // so the InternetSearch section doesn't show empty usage on first open.
  // The `isInternetSearchOpen` dependency is intentionally omitted.
  useEffect(() => {
    if (tavilyApiKey) {
      refreshUsage(tavilyApiKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tavilyApiKey]);

  // Re-check usage when the section is explicitly opened (keeps the
  // original "open to refresh" semantic).
  useEffect(() => {
    if (isInternetSearchOpen && tavilyApiKey) {
      refreshUsage(tavilyApiKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInternetSearchOpen]);

  const saveConfig = (key: string, enabled: boolean) => {
    setTavilyApiKey(key);
    setEnableInternetSearch(enabled);
    queueLocalStoragePreferenceSync('tavily_api_key', key);
    queueLocalStoragePreferenceSync('enable_internet_search', String(enabled));
  };

  const testSearch = async () => {
    if (!tavilyApiKey) {
      showDialog({
        title: language === 'zh' ? '错误' : 'Error',
        message: language === 'zh' ? '请先输入 API Key' : 'Please enter API Key first',
        type: 'alert'
      });
      return;
    }
    setSearchStatus(t.searchStatusTesting);
    setSearchStatusType('neutral');
    try {
      const res = await fetch(`https://search.omkk.org/api/search?q=${encodeURIComponent('test')}`, {
        headers: { 'x-api-key': tavilyApiKey }
      });
      if (res.ok) {
        setSearchStatus(t.searchStatusSuccess);
        setSearchStatusType('success');
        refreshUsage(tavilyApiKey);
      } else {
        setSearchStatus(t.searchStatusFailed);
        setSearchStatusType('error');
      }
    } catch {
      setSearchStatus(t.searchStatusFailed);
      setSearchStatusType('error');
    }
  };

  return {
    tavilyApiKey,
    enableInternetSearch,
    tavilyUsage,
    searchStatus,
    searchStatusType,
    setSearchStatus,
    setSearchStatusType,
    saveConfig,
    testSearch,
    refreshUsage
  };
};
