import { useEffect, useState } from 'react';
import { Language } from '../../types';
import { UI_TRANSLATIONS } from '../../constants';
import { SettingsDialogConfig } from './useSettingsDialog';
import {
  PREFERENCES_UPDATED_EVENT,
  queueLocalStoragePreferenceSync,
} from '../../services/preferencesSync';

type ShowDialog = (config: Omit<SettingsDialogConfig, 'isOpen'>) => void;

const DEFAULT_USERNAME = 'Kumiko';
const DEFAULT_PASSWORD = '0821';

export const useAccountSettings = (
  isOpen: boolean,
  language: Language,
  showDialog: ShowDialog,
  closeDialog: () => void
) => {
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [isEditingAccount, setIsEditingAccount] = useState(false);

  const syncFromStorage = () => {
    const storedUser = localStorage.getItem('kumiko_auth_username') || DEFAULT_USERNAME;
    const storedPass = localStorage.getItem('kumiko_auth_password') || DEFAULT_PASSWORD;
    setAuthUsername(storedUser);
    setAuthPassword(storedPass);
  };

  // Preload rework: read the credentials on mount (and again when the
  // panel toggles open) so the Account section never renders with blank
  // fields during the first paint.
  useEffect(() => {
    syncFromStorage();
  }, [isOpen]);

  useEffect(() => {
    const handlePreferencesUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ keys?: string[] }>).detail;
      if (!Array.isArray(detail?.keys)) return;
      if (detail.keys.includes('kumiko_auth_username') || detail.keys.includes('kumiko_auth_password')) {
        syncFromStorage();
      }
    };
    window.addEventListener(PREFERENCES_UPDATED_EVENT, handlePreferencesUpdated as EventListener);
    return () => {
      window.removeEventListener(PREFERENCES_UPDATED_EVENT, handlePreferencesUpdated as EventListener);
    };
  }, []);

  const handleSaveAccount = () => {
    if (authUsername.trim() && authPassword.trim()) {
      queueLocalStoragePreferenceSync('kumiko_auth_username', authUsername);
      queueLocalStoragePreferenceSync('kumiko_auth_password', authPassword);
      setIsEditingAccount(false);
      return;
    }

    showDialog({
      title: language === 'zh' ? '错误' : 'Error',
      message: language === 'zh'
        ? '用户名和密码不能为空。'
        : 'Username and Password cannot be empty.',
      type: 'alert'
    });
  };

  const resetAccountToDefaults = () => {
    const t = UI_TRANSLATIONS[language];
    showDialog({
      title: t.accountResetConfirmTitle,
      message: t.accountResetConfirmBody,
      type: 'confirm',
      confirmText: t.accountResetButton,
      onConfirm: () => {
        queueLocalStoragePreferenceSync('kumiko_auth_username', DEFAULT_USERNAME);
        queueLocalStoragePreferenceSync('kumiko_auth_password', DEFAULT_PASSWORD);
        setAuthUsername(DEFAULT_USERNAME);
        setAuthPassword(DEFAULT_PASSWORD);
        setIsEditingAccount(false);
        closeDialog();
      }
    });
  };

  return {
    authUsername,
    authPassword,
    isEditingAccount,
    setAuthUsername,
    setAuthPassword,
    startEditingAccount: () => setIsEditingAccount(true),
    cancelEditingAccount: () => setIsEditingAccount(false),
    handleSaveAccount,
    resetAccountToDefaults
  };
};
