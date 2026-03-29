import { useEffect, useState } from 'react';
import { Language } from '../../types';
import { DataDirectoryInfo } from './DataManagementSection';

export const useDataManagementInfo = (
  isOpen: boolean,
  isDesktopElectron: boolean,
  language: Language
) => {
  const [storageUsage, setStorageUsage] = useState<{ usage: number; quota: number } | null>(null);
  const [dataDirectoryInfo, setDataDirectoryInfo] = useState<DataDirectoryInfo | null>(null);

  const formatDataDirectoryError = (error?: string | null) => {
    if (!error) return '';
    if (language === 'zh') {
      if (error.includes('not empty')) return '目标目录不是空文件夹，请重新选择一个空目录。';
      if (error.includes('cannot contain each other')) return '源目录与目标目录不能互相包含，请重新选择。';
      return `迁移失败：${error}`;
    }
    return error;
  };

  const refreshStorageEstimate = async () => {
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        setStorageUsage({
          usage: estimate.usage || 0,
          quota: estimate.quota || 0
        });
      } catch (e) {
        console.error('Failed to estimate storage', e);
      }
    }
  };

  const refreshDataDirectoryInfo = async () => {
    if (!isDesktopElectron) {
      setDataDirectoryInfo(null);
      return;
    }

    try {
      if (!window.electronAPI) return;
      const result = await window.electronAPI.invoke('app:get-data-directory-info');
      if (result?.success) {
        setDataDirectoryInfo(result);
      }
    } catch (e) {
      console.error('Failed to load data directory info', e);
    }
  };

  useEffect(() => {
    if (isOpen) {
      refreshStorageEstimate();
      refreshDataDirectoryInfo();
    }
  }, [isOpen]);

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return {
    storageUsage,
    dataDirectoryInfo,
    formatDataDirectoryError,
    formatBytes,
    refreshStorageEstimate
  };
};
