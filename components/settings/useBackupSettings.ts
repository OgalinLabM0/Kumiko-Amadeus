import { BackupConfig, Language } from '../../types';

// useBackupSettings was originally a façade over cloud-sync config (endpoint URL, API key,
// userId, connectivity testing). Cloud sync has been removed from the product; what remains
// is a trivial toggle for the local-only flags in BackupConfig. We keep the hook shape so
// callers don't all have to change, but everything cloud-related is gone.
interface UseBackupSettingsParams {
  language: Language;
  backupConfig: BackupConfig;
  onBackupConfigChange: (config: BackupConfig) => void;
}

export const useBackupSettings = ({
  backupConfig,
  onBackupConfigChange,
}: UseBackupSettingsParams) => {
  const toggleBackup = (key: 'localEnabled' | 'ragEnabled') => {
    const newConfig = { ...backupConfig, [key]: !backupConfig[key] };
    onBackupConfigChange(newConfig);
  };

  const formatLastBackup = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  return {
    toggleBackup,
    formatLastBackup,
  };
};
