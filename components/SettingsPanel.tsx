
import React, { useState, useEffect, useRef } from 'react';
import { X, Save, RotateCcw, Settings, Edit2, Eye, EyeOff, Cloud, HardDrive, Upload, Download, RefreshCw, Check, Globe, ChevronUp, ChevronDown, MapPin, Clock, FileJson, AlertTriangle, Link as LinkIcon, UserCircle, Key, Menu, Brain, Paperclip, CheckSquare, Zap, Send, Database, Image, Watch, AlertCircle, Lock, Activity, ShieldCheck, Power, CheckCircle } from 'lucide-react';
import { Language, LocationConfig, BackupConfig, AIConfig } from '../types';
import { UI_TRANSLATIONS } from '../constants';
import { getCurrentAIConfig, validateAIConnection, validateModels, validateSearchCapability } from '../services/geminiService';
import { clearAllLocalRagMemory } from '../services/localRagService';
import { CLOUD_SYNC_AVAILABLE, getDefaultMainModel, getDefaultSummaryModel, getDefaultVisionModel } from '../services/appConfig';
import { db } from '../services/db';
import { DataManagementSection } from './settings/DataManagementSection';
import { AccountSection } from './settings/AccountSection';
import { ApiConfigSection } from './settings/ApiConfigSection';
import { AppUpdateSection } from './settings/AppUpdateSection';
import { BackupSection } from './settings/BackupSection';
import { CustomDialog } from './settings/CustomDialog';
import { FullGuideModal } from './settings/FullGuideModal';
import { GeneralSection } from './settings/GeneralSection';
import { GuideSection } from './settings/GuideSection';
import { InternetSearchSection } from './settings/InternetSearchSection';
import { LogViewerSection } from './settings/LogViewerSection';
import { LocationSection } from './settings/LocationSection';
import { COUNTRIES, LOCAL_CONFIG_TRANSLATIONS, TIMEZONES } from './settings/settingsConfig';
import { useAccountSettings } from './settings/useAccountSettings';
import { useBackupSettings } from './settings/useBackupSettings';
import { useDataManagementInfo } from './settings/useDataManagementInfo';
import { useLocationPreview } from './settings/useLocationPreview';
import { useProactivePushSettings } from './settings/useProactivePushSettings';
import { useSettingsDialog } from './settings/useSettingsDialog';
import { useTavilySearchSettings } from './settings/useTavilySearchSettings';
import { TtsConfigSection } from './settings/TtsConfigSection';
import type { AppUpdateState, TtsConfig } from '../types';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  isDarkMode: boolean;
  onExportBackup?: () => void;
  onImportBackup?: (file: File) => void;
  onRebuildRag?: () => void;
  ragStatus?: 'IDLE' | 'RECALLING' | 'INDEXING' | 'ERROR' | 'OFF' | 'STALE';
  ragProgressLabel?: string | null;
  language: Language;
  onLanguageChange: (lang: Language) => void;
  locationConfig?: LocationConfig;
  onLocationChange?: (config: LocationConfig) => void;
  
  autoBackupInterval: number;
  onIntervalChange: (minutes: number) => void;
  connectedFileName: string | null;
  lastBackupTime: number | null;
  onSelectLocalFile: () => void; 
  onOpenLocalFile: () => void;   
  onManualLocalSave?: () => void; 
  onManualLocalLoad?: () => void; 

  backupConfig: BackupConfig;
  onBackupConfigChange: (config: BackupConfig) => void;
  onCloudRestore: () => void;
  onCloudPush: () => void;
  
  isCloudSynced: boolean;
  
  // New props for Dev Logs
  devLogs: { level: 'log' | 'warn' | 'error'; message: string; timestamp: string }[];
  onClearDevLogs: () => void;
  ttsConfig?: TtsConfig;
  onTtsConfigChange?: (config: TtsConfig) => void;
  appUpdateState: AppUpdateState;
  onCheckForUpdates: () => void;
  onDownloadUpdate: () => void;
  onInstallUpdate: () => void;

  autoZipEnabled: boolean;
  onToggleAutoZip: () => void;
  onDisconnectLocalFile?: () => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ 
  isOpen, 
  onClose, 
  isDarkMode,
  onExportBackup,
  onImportBackup,
  ragStatus = 'OFF',
  ragProgressLabel = null,
  language,
  onLanguageChange,
  locationConfig,
  onLocationChange,
  autoBackupInterval,
  onIntervalChange,
  connectedFileName,
  lastBackupTime,
  onSelectLocalFile,
  onOpenLocalFile,
  onManualLocalSave,
  onManualLocalLoad,
  backupConfig,
  onBackupConfigChange,
  onCloudRestore,
  onCloudPush,
  isCloudSynced,
  devLogs,
  onClearDevLogs,
  onRebuildRag,
  ttsConfig,
  onTtsConfigChange,
  appUpdateState,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate,
  autoZipEnabled,
  onToggleAutoZip,
  onDisconnectLocalFile
}) => {
  const t = UI_TRANSLATIONS[language];
  const t_local = LOCAL_CONFIG_TRANSLATIONS[language];
  const isDesktopElectron = typeof window !== 'undefined' && 'electronAPI' in window;
  
  const [isGeneralOpen, setIsGeneralOpen] = useState(false);
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [isLocationOpen, setIsLocationOpen] = useState(false);
  const [isBackupOpen, setIsBackupOpen] = useState(false);
  const [isGuideOpen, setIsGuideOpen] = useState(false); 
  const [isUpdateOpen, setIsUpdateOpen] = useState(false);
  const [isApiConfigOpen, setIsApiConfigOpen] = useState(false);
  const [isSecurityOpen, setIsSecurityOpen] = useState(false);
  const [isAllocationOpen, setIsAllocationOpen] = useState(false);
  const [isVisionOpen, setIsVisionOpen] = useState(false);
  const [isRagOpen, setIsRagOpen] = useState(false);
  const [isInternetSearchOpen, setIsInternetSearchOpen] = useState(false);
  const [isTtsOpen, setIsTtsOpen] = useState(false);
  const [isDataManagementOpen, setIsDataManagementOpen] = useState(false);
  const [isLogViewerOpen, setIsLogViewerOpen] = useState(false);
  const { dialogConfig, setDialogConfig, showDialog, closeDialog } = useSettingsDialog();
  const {
    enableProactive,
    isPushSupported,
    pushSubscription,
    isSubscribing,
    handleToggleProactive,
    handleSubscribePush
  } = useProactivePushSettings(language, showDialog);
  const [showFullGuide, setShowFullGuide] = useState(false);
  const {
    authUsername,
    authPassword,
    isEditingAccount,
    setAuthUsername,
    setAuthPassword,
    startEditingAccount,
    cancelEditingAccount,
    handleSaveAccount
  } = useAccountSettings(isOpen, language, showDialog);
  const {
    isConnecting,
    isConnected,
    connectionError,
    toggleBackup,
    updateCloudConfig,
    testConnection,
    handleDisconnect,
    formatLastBackup
  } = useBackupSettings({
    isOpen,
    language,
    backupConfig,
    cloudSyncAvailable: CLOUD_SYNC_AVAILABLE,
    onBackupConfigChange,
    showDialog
  });
  
  const { previewTime, modelPreviewTime } = useLocationPreview(isOpen, locationConfig, language);
  
  const [localAiConfig, setLocalAiConfig] = useState<AIConfig>(getCurrentAIConfig());
  const [isValidating, setIsValidating] = useState(false);
  const [validationStatus, setValidationStatus] = useState<string>('');
  const [validationStatusType, setValidationStatusType] = useState<'neutral' | 'success' | 'error'>('neutral');
  
  // Search Validation State
  const [isSearchValidating, setIsSearchValidating] = useState(false);

  const logContainerRef = useRef<HTMLDivElement>(null);

  // New states for model validation
  const [isModelValidating, setIsModelValidating] = useState(false);
  const [modelValidationResult, setModelValidationResult] = useState<{ main: boolean | null, summary: boolean | null, vision: boolean | null }>({ main: null, summary: null, vision: null });
  const {
    tavilyApiKey,
    enableInternetSearch,
    tavilyUsage,
    searchStatus,
    searchStatusType,
    setSearchStatus,
    setSearchStatusType,
    saveConfig: handleSaveTavilyConfig,
    testSearch: handleTestTavilySearch,
    refreshUsage: fetchTavilyUsage
  } = useTavilySearchSettings(isOpen, isInternetSearchOpen, language, t, showDialog);
  const {
    storageUsage,
    dataDirectoryInfo,
    formatDataDirectoryError,
    formatBytes,
    refreshStorageEstimate
  } = useDataManagementInfo(isDataManagementOpen, isDesktopElectron, language);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const isInIframe = typeof window !== 'undefined' && window.self !== window.top;

  useEffect(() => {
    if (isOpen) {
        setLocalAiConfig(getCurrentAIConfig());
    }
  }, [isOpen]); 
  
  useEffect(() => {
    if (isLogViewerOpen && logContainerRef.current) {
        logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [devLogs, isLogViewerOpen]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && onImportBackup) {
      onImportBackup(file);
    }
    e.target.value = '';
  };
  
  const handleLocationUpdate = (key: keyof LocationConfig, value: string) => {
    if (onLocationChange && locationConfig) {
      onLocationChange({ ...locationConfig, [key]: value });
    }
  };

  const handleTestApiConnection = async () => {
      setIsValidating(true);
      setValidationStatus(t_local.validating);
      setValidationStatusType('neutral');
      setModelValidationResult({ main: null, summary: null }); 
      setSearchStatus(''); 

      const isValid = await validateAIConnection(localAiConfig);
      
      if (!isValid) {
          if (localAiConfig.useEnvKey) {
              setValidationStatus(t_local.error_env_missing);
          } else {
              setValidationStatus(t_local.error_invalid);
          }
          setValidationStatusType('error');
      } else {
          setValidationStatus(t_local.success);
          setValidationStatusType('success');
      }
      setIsValidating(false);
  };

  const handleSearchValidation = async () => {
      setIsSearchValidating(true);
      setSearchStatus(t_local.validatingSearch);
      setSearchStatusType('neutral');

      const result = await validateSearchCapability(localAiConfig);

      if (result.success) {
          setSearchStatus(t_local.searchSuccess);
          setSearchStatusType('success');
      } else {
          setSearchStatus(result.message || t_local.searchFail);
          setSearchStatusType('error');
      }
      setIsSearchValidating(false);
  };
  
  const handleModelValidation = async () => {
    setIsModelValidating(true);
    setModelValidationResult({ main: null, summary: null, vision: null });
    const result = await validateModels(localAiConfig);
    const nextResult = { main: result.main, summary: result.summary, vision: result.vision };
    setModelValidationResult(nextResult);
    setIsModelValidating(false);
    return nextResult;
  };

  const handleValidateAll = async () => {
      setIsValidating(true);
      setValidationStatus(t_local.validating);
      setValidationStatusType('neutral');
      setModelValidationResult({ main: null, summary: null, vision: null }); 
      setSearchStatus(''); 

      const isValid = await validateAIConnection(localAiConfig);
      
      if (!isValid) {
          if (localAiConfig.useEnvKey) {
              setValidationStatus(t_local.error_env_missing);
          } else {
              setValidationStatus(t_local.error_invalid);
          }
          setValidationStatusType('error');
          setIsValidating(false);
          return;
      } else {
          setValidationStatus(t_local.success);
          setValidationStatusType('success');
      }

      const modelResult = await handleModelValidation();
      
      if (localAiConfig.provider === 'gemini') {
          setIsSearchValidating(true);
          setSearchStatus(t_local.validatingSearch);
          setSearchStatusType('neutral');

          const searchResult = await validateSearchCapability(localAiConfig);

          if (searchResult.success) {
              setSearchStatus(t_local.searchSuccess);
              setSearchStatusType('success');
          } else {
              setSearchStatus(searchResult.message || t_local.searchFail);
              setSearchStatusType('error');
          }
          setIsSearchValidating(false);
      }
      
      setIsValidating(false);
  };

  const handleSaveApiConfig = () => {
      localStorage.setItem('kumiko_ai_config', JSON.stringify(localAiConfig));
      // Force reload is MANDATORY for iOS Web App to pick up new config cleanly
      showDialog({
        title: language === 'zh' ? "配置已保存" : "Configuration Saved",
        message: language === 'zh' ? "配置已保存。系统将立即重启以应用更改。\n\n这能确保新 Key 被正确加载。" : "Configuration saved. System will restart immediately to apply changes.\n\nThis ensures the new Key is loaded correctly.",
        type: 'confirm',
        confirmText: language === 'zh' ? "立即重启" : "Restart Now",
        cancelText: language === 'zh' ? "稍后" : "Later",
        onConfirm: () => {
            closeDialog();
            window.location.reload();
        },
        onCancel: () => {
            closeDialog();
            setValidationStatus('');
            setValidationStatusType('neutral');
            setModelValidationResult({ main: null, summary: null });
        }
      });
  };

  const handleRequestRebuildRag = () => {
      if (!onRebuildRag) {
          return;
      }
      setDialogConfig({
          isOpen: true,
          title: language === 'zh' ? '重建记忆库' : 'Rebuild Memory Bank',
          message: language === 'zh' ? '这可能需要几分钟时间，确定要重建记忆库吗？' : 'This may take a few minutes. Are you sure you want to rebuild the memory bank?',
          type: 'confirm',
          confirmText: language === 'zh' ? '确定重建' : 'Rebuild',
          cancelText: language === 'zh' ? '取消' : 'Cancel',
          onConfirm: () => {
              setDialogConfig({ ...dialogConfig, isOpen: false });
              onRebuildRag();
          }
      });
  };

  const handleClearOldImages = async () => {
      showDialog({
          title: language === 'zh' ? "清理旧图片" : "Clear Old Images",
          message: language === 'zh' ? "确定要清理旧图片吗？这将只保留最近的50张图片以节省空间。" : "Are you sure you want to clear old images? This will keep only the 50 most recent images to save space.",
          type: 'confirm',
          onConfirm: async () => {
              closeDialog();
              try {
                  const images = await db.images.orderBy('timestamp').toArray();
                  if (images.length > 50) {
                      const toDelete = images.slice(0, images.length - 50);
                      const idsToDelete = toDelete.map(img => img.id);
                      await db.images.bulkDelete(idsToDelete);
                      refreshStorageEstimate();
                      showDialog({ 
                          title: language === 'zh' ? "成功" : "Success", 
                          message: language === 'zh' ? `成功删除了 ${idsToDelete.length} 张旧图片。` : `Successfully deleted ${idsToDelete.length} old images.`, 
                          type: 'alert' 
                      });
                  } else {
                      showDialog({ 
                          title: language === 'zh' ? "提示" : "Info", 
                          message: language === 'zh' ? "您的图片少于50张，无需清理。" : "You have fewer than 50 images. No cleanup needed.", 
                          type: 'alert' 
                      });
                  }
              } catch (e) {
                  console.error("Failed to clear old images", e);
                  showDialog({ 
                      title: language === 'zh' ? "错误" : "Error", 
                      message: language === 'zh' ? "清理旧图片失败。" : "Failed to clear old images.", 
                      type: 'alert' 
                  });
              }
          },
          onCancel: closeDialog
      });
  };

  const handleClearAllData = async () => {
      showDialog({
          title: language === 'zh' ? "警告" : "WARNING",
          message: language === 'zh' ? "这将删除所有本地数据（消息、图片、设置）。此操作无法撤销。您绝对确定吗？" : "This will delete ALL local data (messages, images, settings). This action cannot be undone. Are you absolutely sure?",
          type: 'confirm',
          confirmText: language === 'zh' ? "是的，删除所有内容" : "Yes, delete everything",
          onConfirm: () => {
              showDialog({
                  title: language === 'zh' ? "三重确认" : "TRIPLE CONFIRMATION",
                  message: language === 'zh' ? "您真的确定要清空所有内容吗？" : "Are you REALLY sure you want to wipe everything?",
                  type: 'confirm',
                  confirmText: language === 'zh' ? "是的，我确定" : "Yes, I am sure",
                  onConfirm: () => {
                      showDialog({
                          title: language === 'zh' ? "最后警告" : "FINAL WARNING",
                          message: language === 'zh' ? "所有数据将永久丢失。输入 'yes' 继续。" : "All data will be lost forever. Type 'yes' to proceed.",
                          type: 'prompt',
                          inputPlaceholder: language === 'zh' ? "输入 'yes'" : "Type 'yes'",
                          confirmText: language === 'zh' ? "清空数据" : "WIPE DATA",
                          onConfirm: async (input) => {
                              if (input && input.toLowerCase() === 'yes') {
                                  try {
                                      await clearAllLocalRagMemory();
                                      await Promise.all([
                                          db.messages.clear(),
                                          db.images.clear(),
                                          db.vectors.clear(),
                                          db.keyval.clear()
                                      ]);
                                      localStorage.clear();
                                      sessionStorage.clear();
                                      showDialog({
                                          title: language === 'zh' ? "成功" : "Success",
                                          message: language === 'zh' ? "所有数据已清空。应用程序现在将重新加载。" : "All data cleared. The application will now reload.",
                                          type: 'alert',
                                          onConfirm: () => {
                                              closeDialog();
                                              window.location.reload();
                                          }
                                      });
                                  } catch (e) {
                                      console.error("Failed to clear all data", e);
                                      showDialog({ 
                                          title: language === 'zh' ? "错误" : "Error", 
                                          message: language === 'zh' ? "清空所有数据失败。" : "Failed to clear all data.", 
                                          type: 'alert' 
                                      });
                                  }
                              } else {
                                  closeDialog();
                              }
                          },
                          onCancel: closeDialog
                      });
                  },
                  onCancel: closeDialog
              });
          },
          onCancel: closeDialog
      });
  };

  const handleQuitAppCompletely = () => {
      showDialog({
          title: language === 'zh' ? "彻底退出" : "Quit Completely",
          message: language === 'zh'
              ? "这会立刻结束桌面版后台进程与托盘驻留。\n\n如果你准备卸载软件或测试残留清理，建议先执行这一步。"
              : "This will immediately stop the desktop background process and tray resident app.\n\nIf you're about to uninstall or test cleanup, do this first.",
          type: 'confirm',
          confirmText: language === 'zh' ? "立即退出" : "Quit Now",
          onConfirm: async () => {
              try {
                  if (typeof window !== 'undefined' && window.electronAPI) {
                      await window.electronAPI.invoke('quit-app');
                      return;
                  }
                  window.close();
              } catch (e) {
                  console.error("Failed to quit app completely", e);
                  showDialog({
                      title: language === 'zh' ? "错误" : "Error",
                      message: language === 'zh' ? "彻底退出失败，请从托盘中手动退出。" : "Failed to quit completely. Please exit manually from the tray.",
                      type: 'alert'
                  });
              }
          },
          onCancel: closeDialog
      });
  };

  const handleMoveDataDirectory = async () => {
      if (!isDesktopElectron) {
          showDialog({
              title: language === 'zh' ? '不可用' : 'Unavailable',
              message: language === 'zh' ? '这个功能仅在桌面版中可用。' : 'This feature is only available in the desktop build.',
              type: 'alert'
          });
          return;
      }

      try {
          if (!window.electronAPI) throw new Error('electronAPI not available');
          const pickResult = await window.electronAPI.invoke('app:pick-data-directory');

          if (!pickResult || pickResult.canceled || !pickResult.targetPath) {
              return;
          }

          showDialog({
              title: language === 'zh' ? '迁移本机数据目录' : 'Move Local Data Directory',
              message: language === 'zh'
                  ? `新的数据目录将切换为：\n${pickResult.targetPath}\n\n应用会安全退出并自动重启，然后把本机数据迁移到该目录。\n迁移期间请不要强制关闭程序。`
                  : `The new local data directory will be:\n${pickResult.targetPath}\n\nThe app will quit safely, restart automatically, and then migrate your local data to this directory.\nPlease do not force-close the app during migration.`,
              type: 'confirm',
              confirmText: language === 'zh' ? '迁移并重启' : 'Move And Restart',
              onConfirm: async () => {
                  closeDialog();
                  if (!window.electronAPI) return;
                  const result = await window.electronAPI.invoke('app:migrate-data-directory', { targetPath: pickResult.targetPath });
                  if (!result?.success && !result?.alreadyActive) {
                      showDialog({
                          title: language === 'zh' ? '迁移失败' : 'Migration Failed',
                          message: formatDataDirectoryError(result?.error || (language === 'zh' ? '未知错误。' : 'Unknown error.')),
                          type: 'alert'
                      });
                  }
              },
              onCancel: closeDialog
          });
      } catch (e) {
          console.error('Failed to move data directory', e);
          showDialog({
              title: language === 'zh' ? '错误' : 'Error',
              message: language === 'zh' ? '打开目录选择器失败。' : 'Failed to open the directory picker.',
              type: 'alert'
          });
      }
  };

  const handleResetDataDirectory = () => {
      if (!isDesktopElectron || !dataDirectoryInfo?.isCustom) {
          return;
      }

      showDialog({
          title: language === 'zh' ? '恢复默认目录' : 'Restore Default Directory',
          message: language === 'zh'
              ? `应用会安全退出并自动重启，然后把本机数据迁回默认目录：\n${dataDirectoryInfo.defaultPath}`
              : `The app will quit safely, restart automatically, and move local data back to the default directory:\n${dataDirectoryInfo.defaultPath}`,
          type: 'confirm',
          confirmText: language === 'zh' ? '恢复并重启' : 'Restore And Restart',
          onConfirm: async () => {
              closeDialog();
              try {
                  if (!window.electronAPI) return;
                  const result = await window.electronAPI.invoke('app:reset-data-directory');
                  if (!result?.success && !result?.alreadyActive) {
                      showDialog({
                          title: language === 'zh' ? '恢复失败' : 'Restore Failed',
                          message: formatDataDirectoryError(result?.error || (language === 'zh' ? '未知错误。' : 'Unknown error.')),
                          type: 'alert'
                      });
                  }
              } catch (e) {
                  console.error('Failed to reset data directory', e);
                  showDialog({
                      title: language === 'zh' ? '错误' : 'Error',
                      message: language === 'zh' ? '恢复默认目录失败。' : 'Failed to restore the default directory.',
                      type: 'alert'
                  });
              }
          },
          onCancel: closeDialog
      });
  };

  const updateAiConfig = (key: keyof AIConfig, value: any) => {
      setLocalAiConfig(prev => ({ ...prev, [key]: value }));
      if (validationStatusType !== 'neutral') {
          setValidationStatus('');
          setValidationStatusType('neutral');
      }
      if (key === 'model_main' || key === 'model_summary') {
          setModelValidationResult({ main: null, summary: null });
      }
      setSearchStatus('');
      setSearchStatusType('neutral');
  };

  if (!isOpen) return null;

  const bgClass = isDarkMode ? 'bg-black/95 border-yellow-900/50' : 'bg-white/95 border-yellow-500/30';
  const textClass = isDarkMode ? 'text-yellow-100' : 'text-gray-800';
  const titleClass = isDarkMode ? 'text-yellow-500' : 'text-[#b8860b]';
  const sectionBorder = isDarkMode ? 'border-yellow-900/30 bg-yellow-900/5' : 'border-gray-200 bg-gray-50';
  const inputClass = `w-full p-2 rounded border outline-none font-mono text-base md:text-sm ${isDarkMode ? 'bg-[#1a1a1a] border-gray-700 text-white focus:border-yellow-500' : 'bg-white border-gray-300 text-black focus:border-blue-500'}`;
  const labelClass = `text-xs font-mono font-bold uppercase mb-1 block ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`;
  const innerCardClass = `p-3 rounded border ${isDarkMode ? 'bg-black/30 border-white/10' : 'bg-white border-gray-200'}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm safe-area-padding-modal" style={{ background: 'radial-gradient(circle, rgba(0,0,0,0.6) 30%, rgba(0,0,0,0) 100%)' }}>
      <div className={`w-full max-w-md max-h-[90dvh] rounded-lg border shadow-2xl flex flex-col overflow-hidden animate-[breathe_0.3s_ease-out] relative ${bgClass}`}>
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-yellow-600 to-transparent opacity-50"></div>
        <div className={`flex items-center justify-between px-6 py-4 border-b ${isDarkMode ? 'border-yellow-900/30' : 'border-gray-200'}`}>
          <div className="flex items-center gap-3">
            <Settings size={20} className={titleClass} />
            <span className={`font-mono font-bold tracking-wider text-lg ${titleClass}`}>{t.settingsTitle}</span>
          </div>
          <button onClick={onClose} className={`p-1.5 rounded-full hover:bg-red-500/10 hover:text-red-500 transition-colors ${textClass}`}><X size={20} /></button>
        </div>
        
        <div className="flex-1 p-6 flex flex-col gap-4 overflow-y-auto scrollbar-thin touch-scroll">
          
          {/* ... (Other sections unchanged) ... */}
          <GeneralSection
            isOpen={isGeneralOpen}
            onToggle={() => setIsGeneralOpen(!isGeneralOpen)}
            isDarkMode={isDarkMode}
            sectionBorder={sectionBorder}
            title={t.generalSettings}
            desc={t.generalDesc}
            languageLabel={t.language}
            language={language}
            onLanguageChange={onLanguageChange}
            proactiveTitle={language === 'zh' ? '后台活动与推送唤醒' : 'Background Proactive Push'}
            proactiveDesc={language === 'zh' ? '允许接收 AI 主动发起的定时关怀与系统原生通知 (消耗 Token)' : 'Receive AI proactive scheduled messages via native notifications (Consumes tokens)'}
            enableProactive={enableProactive}
            onToggleProactive={handleToggleProactive}
            showWebPushFallback={isPushSupported && !isDesktopElectron}
            webPushTitle={language === 'zh' ? 'Web 浏览器推送订阅' : 'Web Push Subscription'}
            pushButtonLabel={isSubscribing ? 'Wait...' : pushSubscription ? 'Enabled' : 'Enable'}
            isPushActionDisabled={!!pushSubscription || isSubscribing}
            onSubscribePush={handleSubscribePush}
            isSubscribing={isSubscribing}
          />
          <AccountSection
            isOpen={isAccountOpen}
            onToggle={() => setIsAccountOpen(!isAccountOpen)}
            isDarkMode={isDarkMode}
            sectionBorder={sectionBorder}
            inputClass={inputClass}
            labelClass={labelClass}
            title={t.accountSettings}
            desc={t.accountDesc}
            changeUserPass={t.changeUserPass}
            usernameLabel={t.username}
            passwordLabel={t.passwordLabel}
            saveLabel={t.save}
            cancelLabel={t.cancel}
            editLabel={t.edit}
            authUsername={authUsername}
            authPassword={authPassword}
            isEditing={isEditingAccount}
            onUsernameChange={setAuthUsername}
            onPasswordChange={setAuthPassword}
            onSave={handleSaveAccount}
            onStartEdit={startEditingAccount}
            onCancelEdit={cancelEditingAccount}
          />
          <LocationSection
            isOpen={isLocationOpen}
            onToggle={() => setIsLocationOpen(!isLocationOpen)}
            isDarkMode={isDarkMode}
            language={language}
            sectionBorder={sectionBorder}
            innerCardClass={innerCardClass}
            inputClass={inputClass}
            labelClass={labelClass}
            t={t}
            locationConfig={locationConfig}
            countries={COUNTRIES}
            timezones={TIMEZONES}
            modelPreviewTime={modelPreviewTime}
            previewTime={previewTime}
            onLocationUpdate={handleLocationUpdate}
          />
          <BackupSection
            isOpen={isBackupOpen}
            onToggle={() => setIsBackupOpen(!isBackupOpen)}
            isDarkMode={isDarkMode}
            t={t}
            sectionBorder={sectionBorder}
            cloudSyncAvailable={CLOUD_SYNC_AVAILABLE}
            backupConfig={backupConfig}
            connectedFileName={connectedFileName}
            lastBackupTime={lastBackupTime}
            isInIframe={isInIframe}
            isConnected={isConnected}
            isConnecting={isConnecting}
            connectionError={connectionError}
            isCloudSynced={isCloudSynced}
            formatLastBackup={formatLastBackup}
            onToggleLocalBackup={() => toggleBackup('localEnabled')}
            onToggleCloudBackup={() => toggleBackup('cloudEnabled')}
            onSelectLocalFile={onSelectLocalFile}
            onOpenLocalFile={onOpenLocalFile}
            onManualLocalSave={onManualLocalSave}
            onManualLocalLoad={onManualLocalLoad}
            onUpdateCloudConfig={updateCloudConfig}
            onTestConnection={testConnection}
            onDisconnect={handleDisconnect}
            onCloudPush={onCloudPush}
            onCloudRestore={onCloudRestore}
            onExportBackup={onExportBackup}
            onOpenImportDialog={() => {
              fileInputRef.current?.click();
            }}
            autoZipEnabled={autoZipEnabled}
            onToggleAutoZip={onToggleAutoZip}
            onDisconnectLocalFile={onDisconnectLocalFile}
          />
          <GuideSection
            isOpen={isGuideOpen}
            onToggle={() => setIsGuideOpen(!isGuideOpen)}
            onOpenGuide={() => setShowFullGuide(true)}
            isDarkMode={isDarkMode}
            t={t}
            sectionBorder={sectionBorder}
          />
          <AppUpdateSection
            isOpen={isUpdateOpen}
            onToggle={() => setIsUpdateOpen(!isUpdateOpen)}
            isDarkMode={isDarkMode}
            language={language}
            sectionBorder={sectionBorder}
            updateState={appUpdateState}
            onCheckForUpdates={onCheckForUpdates}
            onDownloadUpdate={onDownloadUpdate}
            onInstallUpdate={onInstallUpdate}
          />

          <DataManagementSection
            isOpen={isDataManagementOpen}
            onToggle={() => setIsDataManagementOpen(!isDataManagementOpen)}
            isDarkMode={isDarkMode}
            language={language}
            t={t}
            sectionBorder={sectionBorder}
            storageUsage={storageUsage}
            formatBytes={formatBytes}
            isDesktopElectron={isDesktopElectron}
            dataDirectoryInfo={dataDirectoryInfo}
            formatDataDirectoryError={formatDataDirectoryError}
            onMoveDataDirectory={handleMoveDataDirectory}
            onResetDataDirectory={handleResetDataDirectory}
            onQuitAppCompletely={handleQuitAppCompletely}
            onClearOldImages={handleClearOldImages}
            onClearAllData={handleClearAllData}
          />

          <ApiConfigSection
            isOpen={isApiConfigOpen}
            onToggle={() => setIsApiConfigOpen(!isApiConfigOpen)}
            isDarkMode={isDarkMode}
            language={language}
            t_local={t_local}
            sectionBorder={sectionBorder}
            innerCardClass={innerCardClass}
            inputClass={inputClass}
            labelClass={labelClass}
            localAiConfig={localAiConfig}
            backupConfig={backupConfig}
            ragStatus={ragStatus}
            ragProgressLabel={ragProgressLabel}
            modelValidationResult={modelValidationResult}
            isSecurityOpen={isSecurityOpen}
            isAllocationOpen={isAllocationOpen}
            isVisionOpen={isVisionOpen}
            isRagOpen={isRagOpen}
            validationStatus={validationStatus}
            validationStatusType={validationStatusType}
            searchStatus={searchStatus}
            searchStatusType={searchStatusType}
            isValidating={isValidating}
            isModelValidating={isModelValidating}
            isSearchValidating={isSearchValidating}
            onToggleSecurity={() => setIsSecurityOpen(!isSecurityOpen)}
            onToggleAllocation={() => setIsAllocationOpen(!isAllocationOpen)}
            onToggleVision={() => setIsVisionOpen(!isVisionOpen)}
            onToggleRag={() => setIsRagOpen(!isRagOpen)}
            onUpdateAiConfig={updateAiConfig}
            onToggleRagEnabled={() => toggleBackup('ragEnabled')}
            onRequestRebuildRag={onRebuildRag ? handleRequestRebuildRag : undefined}
            onSave={handleSaveApiConfig}
            onValidateAll={handleValidateAll}
          />

          {ttsConfig && onTtsConfigChange && (
            <TtsConfigSection
              isOpen={isTtsOpen}
              onToggle={() => setIsTtsOpen(!isTtsOpen)}
              isDarkMode={isDarkMode}
              language={language}
              sectionBorder={sectionBorder}
              inputClass={inputClass}
              labelClass={labelClass}
              innerCardClass={innerCardClass}
              ttsConfig={ttsConfig}
              onTtsConfigChange={onTtsConfigChange}
            />
          )}

          <InternetSearchSection
            isOpen={isInternetSearchOpen}
            onToggle={() => setIsInternetSearchOpen(!isInternetSearchOpen)}
            isDarkMode={isDarkMode}
            sectionBorder={sectionBorder}
            innerCardClass={innerCardClass}
            inputClass={inputClass}
            t={t}
            tavilyApiKey={tavilyApiKey}
            enableInternetSearch={enableInternetSearch}
            tavilyUsage={tavilyUsage}
            searchStatus={searchStatus}
            searchStatusType={searchStatusType}
            onSaveConfig={handleSaveTavilyConfig}
            onRefreshUsage={fetchTavilyUsage}
            onTestSearch={handleTestTavilySearch}
          />

          <LogViewerSection
            isOpen={isLogViewerOpen}
            onToggle={() => setIsLogViewerOpen(!isLogViewerOpen)}
            onClear={onClearDevLogs}
            isDarkMode={isDarkMode}
            t={t_local}
            sectionBorder={sectionBorder}
            devLogs={devLogs}
            logContainerRef={logContainerRef}
          />

        </div>
        <input type="file" ref={fileInputRef} className="hidden" accept=".json,.zip" onChange={handleFileChange} />
        <div className={`p-3 bg-opacity-30 flex justify-end ${isDarkMode ? 'bg-black' : 'bg-gray-50'}`}><span className={`text-[10px] font-mono ${isDarkMode ? 'text-yellow-900/50' : 'text-gray-400'}`}>{t.systemConfig}</span></div>
      </div>
      <FullGuideModal isOpen={showFullGuide} onClose={() => setShowFullGuide(false)} language={language} isDarkMode={isDarkMode} />
      <CustomDialog 
        isOpen={dialogConfig.isOpen}
        title={dialogConfig.title}
        message={dialogConfig.message}
        type={dialogConfig.type}
        inputPlaceholder={dialogConfig.inputPlaceholder}
        confirmText={dialogConfig.confirmText}
        cancelText={dialogConfig.cancelText}
        onConfirm={dialogConfig.onConfirm || closeDialog}
        onCancel={dialogConfig.onCancel || closeDialog}
        isDarkMode={isDarkMode}
        language={language}
      />
    </div>
  );
};
