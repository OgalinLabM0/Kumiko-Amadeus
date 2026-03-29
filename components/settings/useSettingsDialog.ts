import { useState } from 'react';

export interface SettingsDialogConfig {
  isOpen: boolean;
  title: string;
  message: string;
  type: 'alert' | 'confirm' | 'prompt';
  inputPlaceholder?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm?: (inputValue?: string) => void;
  onCancel?: () => void;
}

export const useSettingsDialog = () => {
  const [dialogConfig, setDialogConfig] = useState<SettingsDialogConfig>({
    isOpen: false,
    title: '',
    message: '',
    type: 'alert'
  });

  const showDialog = (config: Omit<SettingsDialogConfig, 'isOpen'>) => {
    setDialogConfig({ ...config, isOpen: true });
  };

  const closeDialog = () => {
    setDialogConfig((prev) => ({ ...prev, isOpen: false }));
  };

  return {
    dialogConfig,
    setDialogConfig,
    showDialog,
    closeDialog
  };
};
