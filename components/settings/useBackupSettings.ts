import { useEffect, useState } from 'react';
import { BackupConfig, Language } from '../../types';
import { SettingsDialogConfig } from './useSettingsDialog';

type ShowDialog = (config: Omit<SettingsDialogConfig, 'isOpen'>) => void;

interface UseBackupSettingsParams {
  isOpen: boolean;
  language: Language;
  backupConfig: BackupConfig;
  cloudSyncAvailable: boolean;
  onBackupConfigChange: (config: BackupConfig) => void;
  showDialog: ShowDialog;
}

export const useBackupSettings = ({
  isOpen,
  language,
  backupConfig,
  cloudSyncAvailable,
  onBackupConfigChange,
  showDialog
}: UseBackupSettingsParams) => {
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    if (backupConfig.endpointUrl && backupConfig.endpointUrl.trim().length > 0) {
      setIsConnected(true);
    } else {
      setIsConnected(false);
    }
  }, [isOpen, backupConfig.endpointUrl]);

  const toggleBackup = (key: 'localEnabled' | 'cloudEnabled' | 'ragEnabled') => {
    if (key === 'cloudEnabled' && !cloudSyncAvailable) {
      return;
    }
    const newConfig = { ...backupConfig, [key]: !backupConfig[key] };
    onBackupConfigChange(newConfig);
  };

  const updateCloudConfig = (key: keyof BackupConfig, value: string) => {
    if (!cloudSyncAvailable) {
      return;
    }
    const newConfig = { ...backupConfig, [key]: value };
    onBackupConfigChange(newConfig);
    if (key === 'endpointUrl') {
      setIsConnected(false);
      setConnectionError(null);
    }
  };

  const testConnection = async () => {
    if (!backupConfig.endpointUrl) {
      showDialog({
        title: language === 'zh' ? '错误' : 'Error',
        message: language === 'zh'
          ? '请输入有效的后端服务地址。'
          : 'Please enter a valid Backend Service URL.',
        type: 'alert'
      });
      return;
    }

    setIsConnecting(true);
    setConnectionError(null);

    try {
      const baseUrl = backupConfig.endpointUrl.replace(/\/+$/, '');
      const healthUrl = `${baseUrl}/`;

      const response = await fetch(healthUrl, {
        method: 'GET',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          ...(backupConfig.apiKey ? { Authorization: `Bearer ${backupConfig.apiKey}` } : {})
        }
      });

      if (response.ok) {
        setIsConnected(true);
        onBackupConfigChange({
          ...backupConfig,
          cloudEnabled: true
        });
      } else {
        console.warn('API returned non-200:', response.status);
        if (response.status === 404) {
          setConnectionError('Error 404: Service not found at this URL.');
        } else {
          setConnectionError(`Error: Server returned ${response.status} ${response.statusText}`);
        }
        setIsConnected(false);
      }
    } catch (e: any) {
      console.error('Connection test failed', e);
      setConnectionError(`Network Error: ${e.message || 'Unknown error'}. Check CORS and URL.`);
      setIsConnected(false);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = () => {
    setIsConnected(false);
    onBackupConfigChange({
      ...backupConfig,
      endpointUrl: '',
      cloudEnabled: false
    });
  };

  const formatLastBackup = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  return {
    isConnecting,
    isConnected,
    connectionError,
    toggleBackup,
    updateCloudConfig,
    testConnection,
    handleDisconnect,
    formatLastBackup
  };
};
