import { useEffect, useState } from 'react';
import { Language } from '../../types';
import { SettingsDialogConfig } from './useSettingsDialog';

type ShowDialog = (config: Omit<SettingsDialogConfig, 'isOpen'>) => void;

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
    const storedUser = localStorage.getItem('kumiko_auth_username') || 'Kumiko';
    const storedPass = localStorage.getItem('kumiko_auth_password') || '0821';
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

  return {
    authUsername,
    authPassword,
    isEditingAccount,
    setAuthUsername,
    setAuthPassword,
    startEditingAccount: () => setIsEditingAccount(true),
    cancelEditingAccount: () => setIsEditingAccount(false),
    handleSaveAccount
  };
};
