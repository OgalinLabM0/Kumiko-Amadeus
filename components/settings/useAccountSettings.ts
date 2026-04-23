import { useEffect, useState } from 'react';
import { Language } from '../../types';
import { UI_TRANSLATIONS } from '../../constants';
import { SettingsDialogConfig } from './useSettingsDialog';

type ShowDialog = (config: Omit<SettingsDialogConfig, 'isOpen'>) => void;

const DEFAULT_USERNAME = 'Kumiko';
const DEFAULT_PASSWORD = '0821';

export const useAccountSettings = (
  isOpen: boolean,
  language: Language,
  showDialog: ShowDialog
) => {
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [isEditingAccount, setIsEditingAccount] = useState(false);

  // Preload rework: read the credentials on mount (and again when the
  // panel toggles open) so the Account section never renders with blank
  // fields during the first paint.
  useEffect(() => {
    const storedUser = localStorage.getItem('kumiko_auth_username') || DEFAULT_USERNAME;
    const storedPass = localStorage.getItem('kumiko_auth_password') || DEFAULT_PASSWORD;
    setAuthUsername(storedUser);
    setAuthPassword(storedPass);
  }, [isOpen]);

  const handleSaveAccount = () => {
    if (authUsername.trim() && authPassword.trim()) {
      localStorage.setItem('kumiko_auth_username', authUsername);
      localStorage.setItem('kumiko_auth_password', authPassword);
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
        localStorage.setItem('kumiko_auth_username', DEFAULT_USERNAME);
        localStorage.setItem('kumiko_auth_password', DEFAULT_PASSWORD);
        setAuthUsername(DEFAULT_USERNAME);
        setAuthPassword(DEFAULT_PASSWORD);
        setIsEditingAccount(false);
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
