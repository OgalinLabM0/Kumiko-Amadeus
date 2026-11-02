import { useEffect, useState } from 'react';
import { Language } from '../../types';
import { SettingsDialogConfig } from './useSettingsDialog';
import { PREFERENCES_UPDATED_EVENT, queueLocalStoragePreferenceSync } from '../../services/preferencesSync';
import { hasTavilyCredential, removeTavilyCredential, requestTavily, saveTavilyCredential } from '../../services/tavilyCredentials';
interface SearchTranslations { searchStatusTesting: string; searchStatusSuccess: string; searchStatusFailed: string; }
type ShowDialog = (config: Omit<SettingsDialogConfig, 'isOpen'>) => void;
export const useTavilySearchSettings = (isSettingsOpen: boolean, isInternetSearchOpen: boolean, language: Language, t: SearchTranslations, showDialog: ShowDialog) => {
  const [tavilyApiKey, setTavilyApiKey] = useState('');
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [enableInternetSearch, setEnableInternetSearch] = useState(false);
  const [tavilyUsage, setTavilyUsage] = useState<string | null>(null);
  const [searchStatus, setSearchStatus] = useState('');
  const [searchStatusType, setSearchStatusType] = useState<'neutral' | 'success' | 'error'>('neutral');
  const syncFromStorage = () => { setHasSavedKey(hasTavilyCredential()); setEnableInternetSearch(localStorage.getItem('enable_internet_search') === 'true'); };
  useEffect(() => { syncFromStorage(); }, [isSettingsOpen]);
  useEffect(() => {
    const handler = (event: Event) => { const keys = (event as CustomEvent<{ keys?: string[] }>).detail?.keys;
      if (keys?.includes('tavily_api_key') || keys?.includes('enable_internet_search')) syncFromStorage(); };
    window.addEventListener(PREFERENCES_UPDATED_EVENT, handler); return () => window.removeEventListener(PREFERENCES_UPDATED_EVENT, handler);
  }, []);
  const refreshUsage = async () => {
    if (!hasTavilyCredential()) { setTavilyUsage(null); return; }
    try { const data = await requestTavily('usage'); setTavilyUsage(`${data.used} / ${data.limit}`); syncFromStorage(); }
    catch { setTavilyUsage('Network or secure storage error'); }
  };
  useEffect(() => { if (isInternetSearchOpen && hasSavedKey) void refreshUsage(); }, [isInternetSearchOpen, hasSavedKey]);
  const saveConfig = async (key: string, enabled: boolean) => {
    try {
      if (key.trim()) { await saveTavilyCredential(key.trim()); setTavilyApiKey(''); setHasSavedKey(true); }
      setEnableInternetSearch(enabled); queueLocalStoragePreferenceSync('enable_internet_search', String(enabled));
      if (key.trim()) setSearchStatus(language === 'zh' ? '密钥已保存' : 'API key saved');
    } catch (error) { showDialog({ title: language === 'zh' ? '保存失败' : 'Save failed', message: error instanceof Error ? error.message : 'Secure storage failed', type: 'alert' }); }
  };
  const testSearch = async () => {
    if (!hasTavilyCredential()) { showDialog({ title: language === 'zh' ? '错误' : 'Error', message: language === 'zh' ? '请先保存 API Key' : 'Save the API key first', type: 'alert' }); return; }
    setSearchStatus(t.searchStatusTesting); setSearchStatusType('neutral');
    try { await requestTavily('search', 'test'); setSearchStatus(t.searchStatusSuccess); setSearchStatusType('success'); void refreshUsage(); }
    catch { setSearchStatus(t.searchStatusFailed); setSearchStatusType('error'); }
  };
  const removeConfig = () => {
    try { removeTavilyCredential(); setHasSavedKey(false); setTavilyUsage(null); setTavilyApiKey(''); }
    catch (error) { showDialog({ title: language === 'zh' ? '移除失败' : 'Remove failed', message: error instanceof Error ? error.message : 'Remove failed', type: 'alert' }); }
  };
  return { tavilyApiKey, hasSavedKey, setTavilyApiKey, enableInternetSearch, tavilyUsage, searchStatus, searchStatusType,
    setSearchStatus, setSearchStatusType, saveConfig, removeConfig, testSearch, refreshUsage };
};
