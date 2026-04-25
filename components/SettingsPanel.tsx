
import React, { startTransition, useState, useEffect, useRef, useMemo, useLayoutEffect, useCallback } from 'react';
import { X, Save, RotateCcw, Settings, Edit2, Eye, EyeOff, Cloud, HardDrive, Upload, Download, RefreshCw, Check, Globe, ChevronUp, ChevronDown, MapPin, Clock, FileJson, AlertTriangle, Link as LinkIcon, UserCircle, Key, Menu, Brain, Paperclip, CheckSquare, Zap, Send, Database, Image, Watch, AlertCircle, Lock, Activity, ShieldCheck, Power, CheckCircle, Volume2, Maximize2, Minimize2, BookOpen } from 'lucide-react';
import { Language, LocationConfig, BackupConfig, AIConfig } from '../types';
import { UI_TRANSLATIONS } from '../constants';
import { useAppStore } from '../store';
import { getCurrentAIConfig, validateAIConnection, validateModels, validateSearchCapability } from '../services/geminiService';
import { setAIConfig } from '../services/llmCore';
import { clearAllLocalRagMemory, syncRawHistoryMessagesToMain } from '../services/localRagService';
import { getDefaultMainModel, getDefaultSummaryModel, getDefaultVisionModel } from '../services/appConfig';
import { db } from '../services/db';
import { deleteRingtoneFile, deleteVoiceFile, isVoiceServiceAvailable, listVoiceFiles } from '../services/voiceFileService';
import { DataManagementSection } from './settings/DataManagementSection';
// F2B.4: removed `MobileAccessSection` + `MobileBrowseRootSection` imports.
// The PC-side Tailscale-cert + Fastify mobile-bridge UI was deleted along
// with the rest of the PWA pairing infrastructure.
import { AccountSection } from './settings/AccountSection';
import { ApiConfigSection } from './settings/ApiConfigSection';
import { AppUpdateSection } from './settings/AppUpdateSection';
import { BackupSection } from './settings/BackupSection';
import { DiaryLifeSection } from './settings/DiaryLifeSection';
import { MemoryContextSection } from './settings/MemoryContextSection';
import { MediaSection } from './settings/MediaSection';
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
import type { AppUpdateState, TtsConfig, UpdaterCacheInfo } from '../types';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onExportBackup?: () => void;
  onImportBackup?: (file: File) => void;
  onRebuildRag?: () => void;
  onLanguageChange: (lang: Language) => void;
  onLocationChange?: (config: LocationConfig) => void;
  onIntervalChange: (minutes: number) => void;
  onSelectLocalFile: () => void; 
  onOpenLocalFile: () => void;   
  onManualLocalSave?: () => void; 
  onManualLocalLoad?: () => void; 
  onBackupConfigChange: (config: BackupConfig) => void;
  onCloudRestore: () => void;
  onCloudPush: () => void;
  devLogs: { level: 'log' | 'warn' | 'error'; message: string; timestamp: string }[];
  onClearDevLogs: () => void;
  onTtsConfigChange?: (config: TtsConfig) => void;
  onCheckForUpdates: () => void;
  onDownloadUpdate: () => void;
  // Async so callers can chain inline toast / error UI after the main
  // process resolves the IPC; resolves even when the user already
  // cancelled — see updaterSlice.handleCancelAppUpdate.
  onCancelAppUpdate: () => Promise<{ success: boolean; cancelled?: boolean; error?: string }>;
  onInstallUpdate: () => void;
  // v2.10.1 Download Cache block. Optional so we don't have to
  // retrofit every call-site in storybook / test harnesses, though
  // components/App.tsx always provides them in the real app.
  updaterCacheInfo?: UpdaterCacheInfo | null;
  onRefreshUpdaterCacheInfo?: () => Promise<void>;
  onOpenUpdaterCacheFolder?: () => Promise<{ success: boolean; error?: string }>;
  onClearUpdaterCache?: () => Promise<{ success: boolean; error?: string; sizeBytes?: number }>;
  onToggleAutoZip: () => void;
  onDisconnectLocalFile?: () => void;
}

type SettingsSectionId =
  | 'api'
  | 'tts'
  | 'search'
  | 'general'
  | 'location'
  | 'memoryContext'
  | 'diaryLife'
  | 'media'
  | 'backup'
  | 'data'
  | 'update'
  | 'account'
  | 'guide'
  | 'logs';

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ 
  isOpen, 
  onClose, 
  onExportBackup,
  onImportBackup,
  onLanguageChange,
  onLocationChange,
  onIntervalChange,
  onSelectLocalFile,
  onOpenLocalFile,
  onManualLocalSave,
  onManualLocalLoad,
  onBackupConfigChange,
  onCloudRestore,
  onCloudPush,
  devLogs,
  onClearDevLogs,
  onRebuildRag,
  onTtsConfigChange,
  onCheckForUpdates,
  onDownloadUpdate,
  onCancelAppUpdate,
  onInstallUpdate,
  updaterCacheInfo = null,
  onRefreshUpdaterCacheInfo,
  onOpenUpdaterCacheFolder,
  onClearUpdaterCache,
  onToggleAutoZip,
  onDisconnectLocalFile
}) => {
  const isDarkMode = useAppStore(s => s.isDarkMode);
  const language = useAppStore(s => s.language);
  const locationConfig = useAppStore(s => s.locationConfig);
  const ragStatus = useAppStore(s => s.ragStatus) as 'IDLE' | 'RECALLING' | 'INDEXING' | 'ERROR' | 'OFF' | 'STALE';
  const ragProgressLabel = useAppStore(s => s.ragProgressLabel);
  const backupConfig = useAppStore(s => s.backupConfig);
  const connectedFileName = useAppStore(s => s.connectedFileName);
  const lastBackupTime = useAppStore(s => s.lastBackupTime);
  const autoBackupInterval = useAppStore(s => s.autoBackupInterval);
  const autoZipEnabled = useAppStore(s => s.autoZipEnabled);
  const ttsConfig = useAppStore(s => s.ttsConfig);
  const appUpdateState = useAppStore(s => s.appUpdateState);
  const t = UI_TRANSLATIONS[language];
  const t_local = LOCAL_CONFIG_TRANSLATIONS[language];
  const isDesktopElectron = typeof window !== 'undefined' && 'electronAPI' in window;
  // v2.14.1 G.1 / G.2: Capacitor probe lives next to the Electron probe so
  // every "are we on PC?" / "are we on mobile?" branch in this file gets the
  // same answer. Plain browser PWA falls through both as `false` (used by
  // legacy / preview / test builds).
  const isCapacitorMobile = typeof window !== 'undefined'
    && Boolean((window as any).Capacitor?.isNativePlatform?.());
  
  const [isGeneralOpen, setIsGeneralOpen] = useState(true);
  const [isAccountOpen, setIsAccountOpen] = useState(true);
  const [isLocationOpen, setIsLocationOpen] = useState(true);
  const [isBackupOpen, setIsBackupOpen] = useState(true);
  const [isDiaryLifeOpen, setIsDiaryLifeOpen] = useState(true);
  const [isMemoryContextOpen, setIsMemoryContextOpen] = useState(true);
  const [isMediaOpen, setIsMediaOpen] = useState(true);
  const [isGuideOpen, setIsGuideOpen] = useState(true); 
  const [isUpdateOpen, setIsUpdateOpen] = useState(true);
  const [isApiConfigOpen, setIsApiConfigOpen] = useState(true);
  const [isSecurityOpen, setIsSecurityOpen] = useState(false);
  const [isAllocationOpen, setIsAllocationOpen] = useState(false);
  const [isVisionOpen, setIsVisionOpen] = useState(false);
  const [isRagOpen, setIsRagOpen] = useState(false);
  const [isInternetSearchOpen, setIsInternetSearchOpen] = useState(true);
  // A5.0: Cloud embedding config (Capacitor Android only). Section
  // hides itself on Electron / PWA via internal isCapacitorNative()
  // gate, so this state is harmless on non-mobile platforms.
  // v2.14.3 N.5: default to collapsed. The user mostly only touches this
  // once (set provider on first launch) — keeping it expanded was forcing
  // long scrolls past API-key-shaped fields every time they opened
  // settings. Re-embed banner inside the section is enough to draw the
  // user back in when something *actually* needs attention.
  const [isEmbeddingOpen, setIsEmbeddingOpen] = useState(false);
  const [isTtsOpen, setIsTtsOpen] = useState(true);
  const [isDataManagementOpen, setIsDataManagementOpen] = useState(true);
  const [isLogViewerOpen, setIsLogViewerOpen] = useState(false);
  const [isExpandedView, setIsExpandedView] = useState(true);
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth));
  const [activeSectionId, setActiveSectionId] = useState<SettingsSectionId>('api');
  const activeSectionIdRef = useRef<SettingsSectionId>('api');
  const { dialogConfig, setDialogConfig, showDialog, closeDialog } = useSettingsDialog();
  const {
    enableProactive,
    handleToggleProactive,
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
    handleSaveAccount,
    resetAccountToDefaults
  } = useAccountSettings(isOpen, language, showDialog, closeDialog);
  // useBackupSettings simplified after cloud-sync removal: only local toggle + time formatter.
  const {
    toggleBackup,
    formatLastBackup,
  } = useBackupSettings({
    language,
    backupConfig,
    onBackupConfigChange,
  });
  
  const { previewTime, modelPreviewTime } = useLocationPreview(isOpen, locationConfig, language);
  
  const [localAiConfig, setLocalAiConfig] = useState<AIConfig>(getCurrentAIConfig());
  const [isValidating, setIsValidating] = useState(false);
  const [validationStatus, setValidationStatus] = useState<string>('');
  const [validationStatusType, setValidationStatusType] = useState<'neutral' | 'success' | 'error'>('neutral');
  
  // Search Validation State
  const [isSearchValidating, setIsSearchValidating] = useState(false);

  const logContainerRef = useRef<HTMLDivElement>(null);
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const topNavScrollRef = useRef<HTMLDivElement>(null);
  const topNavIndicatorTrackRef = useRef<HTMLDivElement>(null);
  const topNavIndicatorThumbRef = useRef<HTMLDivElement>(null);
  const topNavIndicatorMetricsRef = useRef({ widthPercent: 0, offsetPercent: 0 });
  const topNavIndicatorRafRef = useRef<number | null>(null);
  const topNavIndicatorDragOffsetRef = useRef(0);
  const contentScrollSyncRafRef = useRef<number | null>(null);
  const activeSectionSyncStampRef = useRef(0);
  const manualSectionFocusRef = useRef<{ id: SettingsSectionId | null; until: number; targetTop: number | null }>({
    id: null,
    until: 0,
    targetTop: null,
  });
  const previousCompactLayoutRef = useRef<boolean | null>(null);
  const topNavButtonRefs = useRef<Partial<Record<SettingsSectionId, HTMLButtonElement | null>>>({});
  const sideNavButtonRefs = useRef<Partial<Record<SettingsSectionId, HTMLButtonElement | null>>>({});
  const [isTopNavIndicatorVisible, setIsTopNavIndicatorVisible] = useState(false);
  const [isTopNavIndicatorHovered, setIsTopNavIndicatorHovered] = useState(false);
  const [isTopNavIndicatorDragging, setIsTopNavIndicatorDragging] = useState(false);
  const [topNavFadeState, setTopNavFadeState] = useState({ left: false, right: false });

  useEffect(() => {
    activeSectionIdRef.current = activeSectionId;
  }, [activeSectionId]);

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

  const applySectionLayoutDefaults = useCallback((compactLayout: boolean) => {
    setIsApiConfigOpen(!compactLayout);
    setIsTtsOpen(!compactLayout);
    setIsInternetSearchOpen(!compactLayout);
    setIsGeneralOpen(!compactLayout);
    setIsLocationOpen(!compactLayout);
    setIsMemoryContextOpen(!compactLayout);
    setIsDiaryLifeOpen(!compactLayout);
    setIsMediaOpen(!compactLayout);
    setIsBackupOpen(!compactLayout);
    setIsDataManagementOpen(!compactLayout);
    setIsUpdateOpen(!compactLayout);
    setIsAccountOpen(!compactLayout);
    setIsGuideOpen(!compactLayout);
    setIsLogViewerOpen(false);
  }, []);

  const isCompactSettingsLayout = useMemo(() => !isExpandedView || viewportWidth < 900, [isExpandedView, viewportWidth]);

  useEffect(() => {
    if (isOpen) {
        setLocalAiConfig(getCurrentAIConfig());
        // Initial sidebar mode threshold is unified with `isCompactSettingsLayout`
        // (>=900). At 768-899 the shell was rendered at the larger breakpoint
        // but the sidebar stayed hidden, producing a "big modal with no sidebar
        // and a horizontal tab strip on top" hybrid that the user (correctly)
        // mistook for the mobile layout being shown on PC. With both values at
        // 900, PC Electron windows >=900px wide always open in sidebar mode and
        // the compact layout is reserved for genuinely narrow viewports.
        const initialExpanded = typeof window !== 'undefined' && window.innerWidth >= 900;
        setIsExpandedView(initialExpanded);
        setActiveSectionId('api');
        previousCompactLayoutRef.current = null;
    }
  }, [isOpen]); 

  useEffect(() => {
    const rootEl = document.documentElement;

    const syncViewportWidth = () => {
      setViewportWidth(window.innerWidth);
    };
    const onResize = () => {
      if (rootEl.hasAttribute('data-resizing')) return;
      syncViewportWidth();
    };

    syncViewportWidth();
    window.addEventListener('resize', onResize);

    const observer = new MutationObserver(() => {
      if (!rootEl.hasAttribute('data-resizing')) {
        syncViewportWidth();
      }
    });
    observer.observe(rootEl, { attributes: true, attributeFilter: ['data-resizing'] });

    return () => {
      window.removeEventListener('resize', onResize);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const previousCompactLayout = previousCompactLayoutRef.current;
    const shouldResetSections =
      previousCompactLayout === null || previousCompactLayout !== isCompactSettingsLayout;

    if (shouldResetSections) {
      applySectionLayoutDefaults(isCompactSettingsLayout);
    }

    previousCompactLayoutRef.current = isCompactSettingsLayout;
  }, [applySectionLayoutDefaults, isCompactSettingsLayout, isOpen]);

  const handleToggleExpandedView = useCallback(() => {
    setIsExpandedView(prev => !prev);
  }, []);
  
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

  useEffect(() => {
    if (!isOpen || !onLocationChange || !locationConfig) return;

    if (
      locationConfig.modelCountry !== 'Japan' ||
      locationConfig.modelTimezone !== 'Asia/Tokyo'
    ) {
      onLocationChange({
        ...locationConfig,
        modelCountry: 'Japan',
        modelTimezone: 'Asia/Tokyo',
      });
    }
  }, [isOpen, locationConfig, onLocationChange]);

  const handleTestApiConnection = async () => {
      setIsValidating(true);
      setValidationStatus(t_local.validating);
      setValidationStatusType('neutral');
      setModelValidationResult({ main: null, summary: null, vision: null });
      setSearchStatus('');

      const isValid = await validateAIConnection(localAiConfig);

      if (!isValid) {
          setValidationStatus(t_local.error_invalid);
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
          setValidationStatus(t_local.error_invalid);
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

  const handleSaveApiConfig = async () => {
      const saveResult = await setAIConfig(localAiConfig);
      if (!saveResult.ok) {
          // v2.14.1 G.1: error copy was hardcoded "保存到 PC 失败" / "Failed to
          // save to PC" — true on Electron because setAIConfig flushes through
          // the IPC bridge into ai-config.json on disk, but on Android (Capacitor)
          // the same path writes to Dexie / Capacitor Filesystem and never
          // touches a PC, so the message was a confusing lie. Split the
          // copy three ways: desktop / mobile / web.
          const failPrefix = language === 'zh'
            ? (isDesktopElectron
                ? '保存到 PC 失败：'
                : (isCapacitorMobile ? '保存到本地失败：' : '保存失败：'))
            : (isDesktopElectron
                ? 'Failed to save to PC: '
                : (isCapacitorMobile ? 'Failed to save locally: ' : 'Save failed: '));
          showDialog({
              title: language === 'zh' ? '保存失败' : 'Save Failed',
              message: failPrefix + (saveResult.error || ''),
              type: 'alert',
              onConfirm: () => closeDialog(),
          });
          return;
      }
      showDialog({
        title: language === 'zh' ? "配置已保存" : "Configuration Saved",
        message: language === 'zh' ? "配置已保存并即时生效。" : "Configuration saved and applied.",
        type: 'alert',
        onConfirm: () => {
            closeDialog();
            setValidationStatus('');
            setValidationStatusType('neutral');
            setModelValidationResult({ main: null, summary: null, vision: null });
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
          message: language === 'zh'
              ? '将基于当前历史消息重新生成每条消息对应的对话向量（turn_pair）。\n\n不会被动：\n· 核心记忆（近期摘要缓冲）与摘要归档状态\n· 摘要块向量（memory chunks，tier=core）\n· 官方世界观向量（lore）\n· 其他非对话类向量\n\n过程中可能需要几分钟；数据库事务保护下失败会自动回滚，不会留下半清空状态。\n\n确定重建吗？'
              : 'This will regenerate the per-message conversation vectors (turn_pair) from your current history.\n\nKept intact:\n- Core memory (recent summary buffer) and summary archive\n- Memory-chunk vectors (tier=core)\n- Official lore vectors\n- All other non-message vectors\n\nMay take a few minutes; wrapped in a database transaction, so any failure rolls back without leaving a half-cleared state.\n\nRebuild?',
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
          message: language === 'zh'
              ? "这将删除所有本地数据（消息、日记、切片、提醒、图片、语音、铃声、设置）。此操作无法撤销。您绝对确定吗？"
              : "This will delete ALL local data (messages, diaries, fragments, reminders, images, voice files, ringtone, and settings). This action cannot be undone. Are you absolutely sure?",
          type: 'confirm',
          confirmText: language === 'zh' ? "是的，删除所有内容" : "Yes, delete everything",
          onConfirm: () => {
              showDialog({
                  title: language === 'zh' ? "三重确认" : "TRIPLE CONFIRMATION",
                  message: language === 'zh'
                      ? "您真的确定要清空所有本地内容吗？包括日记、语音和所有设置。"
                      : "Are you REALLY sure you want to wipe all local content, including diaries, voice files, and settings?",
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
                                      if (isVoiceServiceAvailable()) {
                                          const voiceFiles = await listVoiceFiles();
                                          await Promise.all(voiceFiles.map(file => deleteVoiceFile(file.id)));
                                          await deleteRingtoneFile();
                                      }

                                      await Promise.all([
                                          clearAllLocalRagMemory(),
                                          syncRawHistoryMessagesToMain([], { replaceAll: true })
                                      ]);

                                      await Promise.all([
                                          db.messages.clear(),
                                          db.images.clear(),
                                          db.vectors.clear(),
                                          db.keyval.clear(),
                                          db.episodes.clear(),
                                          db.dailyFragments.clear(),
                                          db.kumikoDiary.clear(),
                                          db.psycheState.clear()
                                      ]);

                                      if ('caches' in window) {
                                          const cacheKeys = await caches.keys();
                                          await Promise.all(cacheKeys.map(cacheKey => caches.delete(cacheKey)));
                                      }

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
          setModelValidationResult(prev => ({ ...prev, main: null, summary: null }));
      }
      if (key === 'model_vision' || key === 'visionProvider') {
          setModelValidationResult(prev => ({ ...prev, vision: null }));
      }
      setSearchStatus('');
      setSearchStatusType('neutral');
  };

  const navItems = useMemo(() => {
    const items = [
      { id: 'api', label: t_local.apiTitle, desc: t_local.apiDesc, icon: ShieldCheck, active: activeSectionId === 'api', accent: isDarkMode ? 'text-yellow-300' : 'text-[#b8860b]' },
      ttsConfig && onTtsConfigChange ? { id: 'tts', label: t.ttsSection, desc: t.ttsSectionDesc, icon: Volume2, active: activeSectionId === 'tts', accent: isDarkMode ? 'text-yellow-300' : 'text-[#b8860b]' } : null,
      { id: 'search', label: t.internetSearchConfig, desc: t.internetSearchDesc, icon: Globe, active: activeSectionId === 'search', accent: isDarkMode ? 'text-yellow-300' : 'text-[#b8860b]' },
      { id: 'general', label: t.generalSettings, desc: t.generalDesc, icon: Settings, active: activeSectionId === 'general', accent: isDarkMode ? 'text-yellow-300' : 'text-[#b8860b]' },
      { id: 'location', label: t.locationTitle, desc: t.locationDesc, icon: MapPin, active: activeSectionId === 'location', accent: isDarkMode ? 'text-yellow-300' : 'text-[#b8860b]' },
      { id: 'memoryContext', label: t.memoryContextTitle, desc: t.memoryContextDesc, icon: Brain, active: activeSectionId === 'memoryContext', accent: isDarkMode ? 'text-yellow-300' : 'text-[#b8860b]' },
      { id: 'diaryLife', label: t.diaryLifeTitle, desc: t.diaryLifeDesc, icon: BookOpen, active: activeSectionId === 'diaryLife', accent: isDarkMode ? 'text-yellow-300' : 'text-[#b8860b]' },
      { id: 'media', label: t.mediaTitle, desc: t.mediaDesc, icon: Image, active: activeSectionId === 'media', accent: isDarkMode ? 'text-yellow-300' : 'text-[#b8860b]' },
      { id: 'backup', label: t.backupTitle, desc: t.backupDesc, icon: HardDrive, active: activeSectionId === 'backup', accent: isDarkMode ? 'text-yellow-300' : 'text-[#b8860b]' },
      { id: 'data', label: t.dataManagementTitle, desc: t.dataManagementDesc, icon: Database, active: activeSectionId === 'data', accent: isDarkMode ? 'text-yellow-300' : 'text-[#b8860b]' },
      { id: 'update', label: t.updateSection, desc: t.updateSectionDesc, icon: Zap, active: activeSectionId === 'update', accent: isDarkMode ? 'text-yellow-300' : 'text-[#b8860b]' },
      { id: 'account', label: t.accountSettings, desc: t.accountDesc, icon: UserCircle, active: activeSectionId === 'account', accent: isDarkMode ? 'text-yellow-300' : 'text-[#b8860b]' },
      { id: 'guide', label: t.guideTitle, desc: t.guideDesc, icon: BookOpen, active: activeSectionId === 'guide', accent: isDarkMode ? 'text-yellow-300' : 'text-[#b8860b]' },
      { id: 'logs', label: t_local.logTitle, desc: t_local.logDesc, icon: Activity, active: activeSectionId === 'logs', accent: isDarkMode ? 'text-yellow-300' : 'text-[#b8860b]' },
    ].filter(Boolean) as Array<{ id: SettingsSectionId; label: string; desc?: string; icon: React.ComponentType<any>; active: boolean; accent: string }>;
    return items;
  }, [
    t_local.apiTitle, t_local.apiDesc, t_local.logTitle, t_local.logDesc,
    t.ttsSection, t.ttsSectionDesc, t.internetSearchConfig, t.internetSearchDesc, t.generalSettings, t.generalDesc,
    t.locationTitle, t.locationDesc, t.backupTitle, t.backupDesc, t.dataManagementTitle, t.dataManagementDesc,
    t.updateSection, t.updateSectionDesc, t.accountSettings, t.accountDesc, t.guideTitle, t.guideDesc,
    ttsConfig, onTtsConfigChange, activeSectionId, isDarkMode, isDesktopElectron, language
  ]);

  const titleClass = isDarkMode ? 'text-yellow-500' : 'text-[#9c7425]';
  const sectionBorder = isDarkMode
    ? 'border-[#8e6a3a]/55 bg-[linear-gradient(180deg,rgba(33,25,19,0.9),rgba(18,14,11,0.94))] shadow-[0_18px_40px_rgba(0,0,0,0.24)]'
    : 'border-[#e6ddd0]/90 bg-[rgba(255,255,255,0.82)] shadow-[0_8px_18px_rgba(44,33,22,0.025)]';
  const inputClass = `w-full rounded-[1rem] border px-3.5 py-2.5 outline-none ka-input-copy transition-all ${isDarkMode ? 'bg-[#211811] border-[#8c6a3c] text-[#f2e5cf] placeholder:text-[#8e7659] focus:border-yellow-500/80 focus:shadow-[0_0_0_3px_rgba(234,179,8,0.08)]' : 'bg-white border-[#e4dacd] text-[#3f2f22] placeholder:text-[#b8a38c] focus:border-[#c59142] focus:shadow-[0_0_0_3px_rgba(197,145,66,0.08)]'}`;
  const labelClass = `ka-copy-sm font-semibold mb-1 block ${isDarkMode ? 'text-[#d7c7b5]' : 'text-[#8a6b4e]'}`;
  const innerCardClass = `p-4 rounded-[1.05rem] border ${isDarkMode ? 'bg-[linear-gradient(180deg,rgba(36,26,17,0.84),rgba(26,19,13,0.78))] border-[#7a5830]/55' : 'bg-[rgba(255,255,255,0.9)] border-[#ebe1d3]'} shadow-[inset_0_1px_0_rgba(255,255,255,0.24)]`;
  const shellClass = isExpandedView
    ? 'w-[min(98vw,90rem)] h-[min(95dvh,60rem)] rounded-[1.85rem]'
    : 'w-[min(92vw,60rem)] h-[min(88dvh,50rem)] rounded-[1.5rem]';
  const shellSurfaceClass = isDarkMode
    ? 'border-[#c9a55a]/60 bg-[#1f1711]/96 shadow-[inset_0_1px_0_rgba(242,217,156,0.1),0_26px_70px_rgba(0,0,0,0.42)]'
    : 'border-[#ded5c8]/90 bg-[rgba(255,255,255,0.95)] shadow-[0_24px_52px_rgba(42,31,20,0.08)]';
  const shellDividerClass = isDarkMode ? 'border-[#a88247]/35' : 'border-[#ebe2d7]';
  const railClass = isDarkMode
    ? 'bg-[linear-gradient(180deg,rgba(36,27,19,0.74),rgba(16,12,9,0.8))]'
    : 'bg-[rgba(255,255,255,0.62)]';
  const bodyClass = isDarkMode
    ? 'bg-[#1f1711]'
    : 'bg-[rgba(255,255,255,0.76)]';
  const navButtonBaseClass = isDarkMode
    ? 'border-transparent bg-transparent text-[#efe3d6] hover:bg-white/[0.04] hover:border-[#5b4630]'
    : 'border-transparent bg-transparent text-[#6d5f4d] hover:bg-black/[0.025] hover:border-[#ece2d4]';
  const navButtonActiveClass = isDarkMode
    ? 'border-[#aa8454] bg-white/[0.06] text-[#f5ddbd] shadow-[0_10px_22px_rgba(0,0,0,0.2)]'
    : 'border-[#e2cfaa] bg-[#fffaf1] text-[#7d5b12] shadow-[0_2px_10px_rgba(52,40,22,0.035)]';
  const utilityButtonClass = isDarkMode
    ? 'border-[#58422d]/60 bg-white/[0.03] text-[#eadccf] hover:bg-white/[0.06]'
    : 'border-[#e4dbcf] bg-[rgba(255,255,255,0.9)] text-[#6d5d49] hover:bg-[#faf8f4]';
  const shouldRenderSection = (_sectionId: SettingsSectionId) => true;

  const scrollToSection = (sectionId: SettingsSectionId, behavior: ScrollBehavior = 'smooth') => {
    const container = contentScrollRef.current;
    const sectionEl = document.getElementById(`settings-section-${sectionId}`);
    if (!container || !sectionEl) {
      sectionEl?.scrollIntoView({ behavior, block: 'start' });
      return null;
    }

    const containerRect = container.getBoundingClientRect();
    const sectionRect = sectionEl.getBoundingClientRect();
    const topPadding = 12;
    const rawTargetTop = container.scrollTop + (sectionRect.top - containerRect.top) - topPadding;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const targetTop = Math.min(Math.max(0, rawTargetTop), maxScrollTop);
    container.scrollTo({ top: targetTop, behavior });
    return targetTop;
  };

  const toggleSectionState = (sectionId: SettingsSectionId) => {
    switch (sectionId) {
      case 'api':
        setIsApiConfigOpen(prev => !prev);
        break;
      case 'tts':
        setIsTtsOpen(prev => !prev);
        break;
      case 'search':
        setIsInternetSearchOpen(prev => !prev);
        break;
      case 'general':
        setIsGeneralOpen(prev => !prev);
        break;
      case 'location':
        setIsLocationOpen(prev => !prev);
        break;
      case 'memoryContext':
        setIsMemoryContextOpen(prev => !prev);
        break;
      case 'diaryLife':
        setIsDiaryLifeOpen(prev => !prev);
        break;
      case 'media':
        setIsMediaOpen(prev => !prev);
        break;
      case 'backup':
        setIsBackupOpen(prev => !prev);
        break;
      case 'data':
        setIsDataManagementOpen(prev => !prev);
        break;
      case 'update':
        setIsUpdateOpen(prev => !prev);
        break;
      case 'account':
        setIsAccountOpen(prev => !prev);
        break;
      case 'guide':
        setIsGuideOpen(prev => !prev);
        break;
      case 'logs':
        setIsLogViewerOpen(prev => !prev);
        break;
    }
  };

  const ensureSectionOpen = (sectionId: SettingsSectionId) => {
    switch (sectionId) {
      case 'api':
        setIsApiConfigOpen(true);
        break;
      case 'tts':
        setIsTtsOpen(true);
        break;
      case 'search':
        setIsInternetSearchOpen(true);
        break;
      case 'general':
        setIsGeneralOpen(true);
        break;
      case 'location':
        setIsLocationOpen(true);
        break;
      case 'memoryContext':
        setIsMemoryContextOpen(true);
        break;
      case 'diaryLife':
        setIsDiaryLifeOpen(true);
        break;
      case 'media':
        setIsMediaOpen(true);
        break;
      case 'backup':
        setIsBackupOpen(true);
        break;
      case 'data':
        setIsDataManagementOpen(true);
        break;
      case 'update':
        setIsUpdateOpen(true);
        break;
      case 'account':
        setIsAccountOpen(true);
        break;
      case 'guide':
        setIsGuideOpen(true);
        break;
      case 'logs':
        setIsLogViewerOpen(true);
        break;
    }
  };

  const focusSection = (sectionId: SettingsSectionId) => {
    const now = performance.now();
    manualSectionFocusRef.current = { id: sectionId, until: now + 1200, targetTop: null };
    activeSectionSyncStampRef.current = now;
    activeSectionIdRef.current = sectionId;
    setActiveSectionId(sectionId);
    ensureSectionOpen(sectionId);
    window.setTimeout(() => {
      const targetTop = scrollToSection(sectionId);
      manualSectionFocusRef.current = {
        id: sectionId,
        until: performance.now() + 1200,
        targetTop,
      };
    }, 80);
  };

  const handleSectionToggle = (sectionId: SettingsSectionId, isCurrentlyOpen: boolean) => {
    if (!isCurrentlyOpen) {
      activeSectionIdRef.current = sectionId;
      setActiveSectionId(sectionId);
    }
    toggleSectionState(sectionId);
  };

  const applyTopNavIndicatorMetrics = (widthPercent: number, offsetPercent: number) => {
    topNavIndicatorMetricsRef.current = { widthPercent, offsetPercent };
    const thumb = topNavIndicatorThumbRef.current;
    if (!thumb) return;
    thumb.style.width = `${widthPercent}%`;
    thumb.style.left = `${offsetPercent}%`;
  };

  const updateTopNavIndicator = () => {
    const container = topNavScrollRef.current;
    if (!container || container.clientWidth <= 0) {
      setIsTopNavIndicatorVisible(false);
      setTopNavFadeState({ left: false, right: false });
      return;
    }

    const { scrollWidth, clientWidth, scrollLeft } = container;
    if (scrollWidth <= clientWidth + 4) {
      setIsTopNavIndicatorVisible(false);
      setTopNavFadeState({ left: false, right: false });
      return;
    }

    const widthPercent = Math.max((clientWidth / scrollWidth) * 100, 14);
    const maxOffset = 100 - widthPercent;
    const offsetPercent = maxOffset <= 0 ? 0 : (scrollLeft / (scrollWidth - clientWidth)) * maxOffset;
    setIsTopNavIndicatorVisible(true);
    setTopNavFadeState({
      left: scrollLeft > 6,
      right: scrollLeft < scrollWidth - clientWidth - 6,
    });
    applyTopNavIndicatorMetrics(widthPercent, offsetPercent);
  };

  const scheduleTopNavIndicatorUpdate = () => {
    if (document.documentElement.hasAttribute('data-resizing')) return;
    if (topNavIndicatorRafRef.current !== null) return;
    topNavIndicatorRafRef.current = window.requestAnimationFrame(() => {
      topNavIndicatorRafRef.current = null;
      updateTopNavIndicator();
    });
  };

  const syncTopNavScrollFromPointer = (clientX: number) => {
    const track = topNavIndicatorTrackRef.current;
    const container = topNavScrollRef.current;
    if (!track || !container) return;

    const trackRect = track.getBoundingClientRect();
    const thumbWidthPx = (topNavIndicatorMetricsRef.current.widthPercent / 100) * trackRect.width;
    const maxThumbLeft = Math.max(trackRect.width - thumbWidthPx, 0);
    const pointerX = clientX - trackRect.left;
    const desiredLeft = Math.min(
      Math.max(pointerX - topNavIndicatorDragOffsetRef.current, 0),
      maxThumbLeft
    );
    const scrollRatio = maxThumbLeft <= 0 ? 0 : desiredLeft / maxThumbLeft;
    container.scrollLeft = scrollRatio * Math.max(container.scrollWidth - container.clientWidth, 0);
  };

  const handleTopNavIndicatorPointerDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isTopNavIndicatorVisible) return;

    const track = topNavIndicatorTrackRef.current;
    if (!track) return;

    const trackRect = track.getBoundingClientRect();
    const thumbWidthPx = (topNavIndicatorMetricsRef.current.widthPercent / 100) * trackRect.width;
    const currentLeftPx = (topNavIndicatorMetricsRef.current.offsetPercent / 100) * trackRect.width;
    const pointerX = event.clientX - trackRect.left;
    const isInsideThumb = pointerX >= currentLeftPx && pointerX <= currentLeftPx + thumbWidthPx;

    topNavIndicatorDragOffsetRef.current = isInsideThumb
      ? pointerX - currentLeftPx
      : thumbWidthPx / 2;

    setIsTopNavIndicatorDragging(true);
    setIsTopNavIndicatorHovered(true);
    syncTopNavScrollFromPointer(event.clientX);
    event.preventDefault();
  };

  useEffect(() => {
    if (!isOpen) return;

    topNavButtonRefs.current[activeSectionId]?.scrollIntoView({ behavior: 'auto', inline: 'center', block: 'nearest' });
    sideNavButtonRefs.current[activeSectionId]?.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' });
  }, [activeSectionId, isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const container = topNavScrollRef.current;
    scheduleTopNavIndicatorUpdate();
    const immediateRaf = window.requestAnimationFrame(() => scheduleTopNavIndicatorUpdate());
    const lateTimeout = window.setTimeout(() => scheduleTopNavIndicatorUpdate(), 140);
    if (!container) {
      return () => {
        window.cancelAnimationFrame(immediateRaf);
        window.clearTimeout(lateTimeout);
      };
    }

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => scheduleTopNavIndicatorUpdate())
      : null;
    resizeObserver?.observe(container);
    if (container.parentElement) {
      resizeObserver?.observe(container.parentElement);
    }

    container.addEventListener('scroll', scheduleTopNavIndicatorUpdate, { passive: true });
    window.addEventListener('resize', scheduleTopNavIndicatorUpdate);
    return () => {
      window.cancelAnimationFrame(immediateRaf);
      window.clearTimeout(lateTimeout);
      resizeObserver?.disconnect();
      container.removeEventListener('scroll', scheduleTopNavIndicatorUpdate);
      window.removeEventListener('resize', scheduleTopNavIndicatorUpdate);
      if (topNavIndicatorRafRef.current !== null) {
        window.cancelAnimationFrame(topNavIndicatorRafRef.current);
        topNavIndicatorRafRef.current = null;
      }
    };
  }, [isOpen, isExpandedView, activeSectionId, navItems.length]);

  useEffect(() => {
    if (!isTopNavIndicatorDragging) return;

    const handleMouseMove = (event: MouseEvent) => {
      syncTopNavScrollFromPointer(event.clientX);
    };

    const handleMouseUp = () => {
      setIsTopNavIndicatorDragging(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isTopNavIndicatorDragging, isTopNavIndicatorVisible]);

  useEffect(() => {
    const container = contentScrollRef.current;
    if (!container || !isOpen) return;

    const computeActiveSectionFromScroll = () => {
      const firstId = navItems[0]?.id;
      const lastId = navItems[navItems.length - 1]?.id;
      if (!firstId || !lastId) return;
      const currentActiveSectionId = activeSectionIdRef.current;
      const manualFocus = manualSectionFocusRef.current;
      const now = performance.now();

      const manualTargetPending =
        manualFocus.id &&
        manualFocus.targetTop !== null &&
        Math.abs(container.scrollTop - manualFocus.targetTop) > 20;

      if (manualFocus.id && (now < manualFocus.until || manualTargetPending)) {
        if (currentActiveSectionId !== manualFocus.id) {
          activeSectionSyncStampRef.current = now;
          activeSectionIdRef.current = manualFocus.id;
          startTransition(() => setActiveSectionId(manualFocus.id as SettingsSectionId));
        }
        return;
      }

      if (manualFocus.id && now >= manualFocus.until) {
        manualSectionFocusRef.current = { id: null, until: 0, targetTop: null };
      }

      if (container.scrollTop <= 12) {
        if (currentActiveSectionId !== firstId) {
          activeSectionSyncStampRef.current = now;
          activeSectionIdRef.current = firstId;
          startTransition(() => setActiveSectionId(firstId));
        }
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const containerViewportTop = containerRect.top + 12;
      const containerViewportBottom = containerRect.bottom - 12;
      const baseActivationLine = containerViewportTop + Math.min(220, Math.max(120, container.clientHeight * 0.38));
      const isNearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 12;
      const bottomCompensationRange = Math.min(320, Math.max(160, container.clientHeight * 0.55));
      const bottomCompensationStart = container.scrollHeight - bottomCompensationRange;
      const bottomProgress = Math.min(
        1,
        Math.max(
          0,
          (container.scrollTop + container.clientHeight - bottomCompensationStart) / bottomCompensationRange
        )
      );
      const maxActivationLine = containerViewportBottom - 108;
      const activationLine = baseActivationLine + (maxActivationLine - baseActivationLine) * bottomProgress;
      let bestId = currentActiveSectionId;
      let bestPassedTop = Number.NEGATIVE_INFINITY;
      let bestUpcomingTop = Number.POSITIVE_INFINITY;
      let hasVisibleSection = false;

      navItems.forEach(({ id }) => {
        const sectionEl = document.getElementById(`settings-section-${id}`);
        if (!sectionEl) return;

        const rect = sectionEl.getBoundingClientRect();
        const visibleTop = Math.max(rect.top, containerViewportTop);
        const visibleBottom = Math.min(rect.bottom, containerViewportBottom);
        const visibleHeight = Math.max(0, visibleBottom - visibleTop);
        if (visibleHeight <= 0) {
          return;
        }

        hasVisibleSection = true;

        if (rect.top <= activationLine) {
          if (rect.top > bestPassedTop) {
            bestPassedTop = rect.top;
            bestId = id;
          }
          return;
        }

        if (rect.top < bestUpcomingTop) {
          bestUpcomingTop = rect.top;
          bestId = id;
        }
      });

      if (bestPassedTop === Number.NEGATIVE_INFINITY && bestUpcomingTop === Number.POSITIVE_INFINITY) {
        if (isNearBottom) {
          bestId = lastId;
        }
      } else if (!hasVisibleSection && isNearBottom) {
        bestId = lastId;
      }

      if (bestId !== currentActiveSectionId) {
        if (now - activeSectionSyncStampRef.current < 96) {
          return;
        }
        activeSectionSyncStampRef.current = now;
        activeSectionIdRef.current = bestId;
        startTransition(() => setActiveSectionId(bestId));
      }
    };

    const scheduleActiveSectionSync = () => {
      if (document.documentElement.hasAttribute('data-resizing')) return;
      if (contentScrollSyncRafRef.current !== null) return;
      contentScrollSyncRafRef.current = window.requestAnimationFrame(() => {
        contentScrollSyncRafRef.current = null;
        computeActiveSectionFromScroll();
      });
    };

    computeActiveSectionFromScroll();
    container.addEventListener('scroll', scheduleActiveSectionSync, { passive: true });
    window.addEventListener('resize', scheduleActiveSectionSync);
    return () => {
      container.removeEventListener('scroll', scheduleActiveSectionSync);
      window.removeEventListener('resize', scheduleActiveSectionSync);
      if (contentScrollSyncRafRef.current !== null) {
        window.cancelAnimationFrame(contentScrollSyncRafRef.current);
        contentScrollSyncRafRef.current = null;
      }
    };
  }, [isOpen, navItems]);

  const sectionsMarkup = useMemo(() => (
    <>
      {shouldRenderSection('api') && (
      <div id="settings-section-api" >
        <ApiConfigSection
          isOpen={isApiConfigOpen}
          onToggle={() => handleSectionToggle('api', isApiConfigOpen)}
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
          isEmbeddingOpen={isEmbeddingOpen}
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
          onToggleEmbedding={() => setIsEmbeddingOpen((v) => !v)}
          onToggleRag={() => setIsRagOpen(!isRagOpen)}
          onUpdateAiConfig={updateAiConfig}
          onToggleRagEnabled={() => toggleBackup('ragEnabled')}
          onRequestRebuildRag={onRebuildRag ? handleRequestRebuildRag : undefined}
          onSave={handleSaveApiConfig}
          onValidateAll={handleValidateAll}
        />
      </div>
      )}

      {ttsConfig && onTtsConfigChange && shouldRenderSection('tts') && (
        <div id="settings-section-tts" >
          <TtsConfigSection
            isOpen={isTtsOpen}
            isPanelOpen={isOpen}
            onToggle={() => handleSectionToggle('tts', isTtsOpen)}
            isDarkMode={isDarkMode}
            language={language}
            sectionBorder={sectionBorder}
            inputClass={inputClass}
            labelClass={labelClass}
            innerCardClass={innerCardClass}
            ttsConfig={ttsConfig}
            onTtsConfigChange={onTtsConfigChange}
          />
        </div>
      )}

      {shouldRenderSection('search') && (
      <div id="settings-section-search" >
        <InternetSearchSection
          isOpen={isInternetSearchOpen}
          onToggle={() => handleSectionToggle('search', isInternetSearchOpen)}
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
        {/* F2A.3c: EmbeddingConfigSection moved into ApiConfigSection
            (Android only, sits right above RagConfigSection as RAG's
            upstream dependency). It used to live here next to Tavily as
            "another external API key card", but UX-wise it makes more
            sense grouped with the rest of the API config block. */}
      </div>
      )}

      {shouldRenderSection('general') && (
      <div id="settings-section-general" >
        <GeneralSection
          isOpen={isGeneralOpen}
          onToggle={() => handleSectionToggle('general', isGeneralOpen)}
          isDarkMode={isDarkMode}
          sectionBorder={sectionBorder}
          innerCardClass={innerCardClass}
          title={t.generalSettings}
          desc={t.generalDesc}
          languageLabel={t.language}
          language={language}
          onLanguageChange={onLanguageChange}
          proactiveTitle={language === 'zh' ? '后台活动与推送唤醒' : 'Background Proactive Push'}
          proactiveDesc={language === 'zh' ? '允许接收 AI 主动发起的定时关怀与系统原生通知 (消耗 Token)' : 'Receive AI proactive scheduled messages via native notifications (Consumes tokens)'}
          enableProactive={enableProactive}
          onToggleProactive={handleToggleProactive}
        />
      </div>
      )}

      {shouldRenderSection('location') && (
      <div id="settings-section-location" >
        <LocationSection
          isOpen={isLocationOpen}
          onToggle={() => handleSectionToggle('location', isLocationOpen)}
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
      </div>
      )}

      {shouldRenderSection('memoryContext') && (
      <div id="settings-section-memoryContext">
        <MemoryContextSection
          isOpen={isMemoryContextOpen}
          onToggle={() => handleSectionToggle('memoryContext', isMemoryContextOpen)}
          isDarkMode={isDarkMode}
          t={t as any}
          sectionBorder={sectionBorder}
        />
      </div>
      )}

      {shouldRenderSection('diaryLife') && (
      <div id="settings-section-diaryLife">
        <DiaryLifeSection
          isOpen={isDiaryLifeOpen}
          onToggle={() => handleSectionToggle('diaryLife', isDiaryLifeOpen)}
          isDarkMode={isDarkMode}
          t={t as any}
          sectionBorder={sectionBorder}
        />
      </div>
      )}

      {shouldRenderSection('media') && (
      <div id="settings-section-media">
        <MediaSection
          isOpen={isMediaOpen}
          onToggle={() => handleSectionToggle('media', isMediaOpen)}
          isDarkMode={isDarkMode}
          t={t as any}
          sectionBorder={sectionBorder}
        />
      </div>
      )}

      {shouldRenderSection('backup') && (
      <div id="settings-section-backup" >
        <BackupSection
          isOpen={isBackupOpen}
          onToggle={() => handleSectionToggle('backup', isBackupOpen)}
          isDarkMode={isDarkMode}
          t={t}
          sectionBorder={sectionBorder}
          backupConfig={backupConfig}
          connectedFileName={connectedFileName}
          lastBackupTime={lastBackupTime}
          isInIframe={isInIframe}
          formatLastBackup={formatLastBackup}
          onToggleLocalBackup={() => toggleBackup('localEnabled')}
          onSelectLocalFile={onSelectLocalFile}
          onOpenLocalFile={onOpenLocalFile}
          onManualLocalSave={onManualLocalSave}
          onManualLocalLoad={onManualLocalLoad}
          onExportBackup={onExportBackup}
          onOpenImportDialog={() => {
            fileInputRef.current?.click();
          }}
          autoZipEnabled={autoZipEnabled}
          onToggleAutoZip={onToggleAutoZip}
          onDisconnectLocalFile={onDisconnectLocalFile}
          language={language}
        />
      </div>
      )}

      {shouldRenderSection('data') && (
      <div id="settings-section-data" >
        <DataManagementSection
          isOpen={isDataManagementOpen}
          onToggle={() => handleSectionToggle('data', isDataManagementOpen)}
          isDarkMode={isDarkMode}
          language={language}
          t={t}
          sectionBorder={sectionBorder}
          storageUsage={storageUsage}
          formatBytes={formatBytes}
          refreshStorageEstimate={refreshStorageEstimate}
          isDesktopElectron={isDesktopElectron}
          dataDirectoryInfo={dataDirectoryInfo}
          formatDataDirectoryError={formatDataDirectoryError}
          onMoveDataDirectory={handleMoveDataDirectory}
          onResetDataDirectory={handleResetDataDirectory}
          onQuitAppCompletely={handleQuitAppCompletely}
          onClearOldImages={handleClearOldImages}
          onClearAllData={handleClearAllData}
        />
      </div>
      )}

      {shouldRenderSection('update') && (
      <div id="settings-section-update" >
        <AppUpdateSection
          isOpen={isUpdateOpen}
          onToggle={() => handleSectionToggle('update', isUpdateOpen)}
          isDarkMode={isDarkMode}
          language={language}
          sectionBorder={sectionBorder}
          updateState={appUpdateState}
          onCheckForUpdates={onCheckForUpdates}
          onDownloadUpdate={onDownloadUpdate}
          onCancelAppUpdate={onCancelAppUpdate}
          onInstallUpdate={onInstallUpdate}
          updaterCacheInfo={updaterCacheInfo}
          onRefreshUpdaterCacheInfo={onRefreshUpdaterCacheInfo ?? (async () => { /* no-op fallback (non-electron) */ })}
          onOpenUpdaterCacheFolder={onOpenUpdaterCacheFolder ?? (async () => ({ success: false, error: 'Cache folder is only accessible on desktop.' }))}
          onClearUpdaterCache={onClearUpdaterCache ?? (async () => ({ success: false, error: 'Cache cleanup is only available on desktop.' }))}
        />
      </div>
      )}

      {shouldRenderSection('account') && (
      <div id="settings-section-account" >
        <AccountSection
          isOpen={isAccountOpen}
          onToggle={() => handleSectionToggle('account', isAccountOpen)}
          isDarkMode={isDarkMode}
          sectionBorder={sectionBorder}
          innerCardClass={innerCardClass}
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
          resetLabel={t.accountResetButton}
          authUsername={authUsername}
          authPassword={authPassword}
          isEditing={isEditingAccount}
          onUsernameChange={setAuthUsername}
          onPasswordChange={setAuthPassword}
          onSave={handleSaveAccount}
          onStartEdit={startEditingAccount}
          onCancelEdit={cancelEditingAccount}
          onResetToDefaults={resetAccountToDefaults}
        />
      </div>
      )}

      {shouldRenderSection('guide') && (
      <div id="settings-section-guide" >
        <GuideSection
          isOpen={isGuideOpen}
          onToggle={() => handleSectionToggle('guide', isGuideOpen)}
          onOpenGuide={() => setShowFullGuide(true)}
          isDarkMode={isDarkMode}
          t={t}
          sectionBorder={sectionBorder}
          innerCardClass={innerCardClass}
        />
      </div>
      )}

      {shouldRenderSection('logs') && (
      <div id="settings-section-logs" >
        <LogViewerSection
          isOpen={isLogViewerOpen}
          onToggle={() => handleSectionToggle('logs', isLogViewerOpen)}
          onClear={onClearDevLogs}
          isDarkMode={isDarkMode}
          t={t_local}
          sectionBorder={sectionBorder}
          devLogs={devLogs}
          logContainerRef={logContainerRef}
        />
      </div>
      )}
    </>
  ), [
    appUpdateState,
    autoZipEnabled,
    backupConfig,
    connectedFileName,
    dataDirectoryInfo,
    devLogs,
    enableInternetSearch,
    enableProactive,
    fileInputRef,
    formatDataDirectoryError,
    formatLastBackup,
    isAccountOpen,
    isApiConfigOpen,
    isBackupOpen,
    isDiaryLifeOpen,
    isMemoryContextOpen,
    isMediaOpen,
    isDarkMode,
    isDataManagementOpen,
    isGeneralOpen,
    isGuideOpen,
    isInIframe,
    isInternetSearchOpen,
    isLocationOpen,
    isLogViewerOpen,
    isModelValidating,
    isSearchValidating,
    isSecurityOpen,
    isTtsOpen,
    isUpdateOpen,
    isValidating,
    language,
    labelClass,
    lastBackupTime,
    localAiConfig,
    locationConfig,
    modelPreviewTime,
    modelValidationResult,
    onBackupConfigChange,
    onCheckForUpdates,
    onClearDevLogs,
    onCloudPush,
    onCloudRestore,
    onDisconnectLocalFile,
    onDownloadUpdate,
    onCancelAppUpdate,
    onExportBackup,
    onImportBackup,
    onInstallUpdate,
    onRefreshUpdaterCacheInfo,
    onOpenUpdaterCacheFolder,
    onClearUpdaterCache,
    updaterCacheInfo,
    onLanguageChange,
    onLocationChange,
    onManualLocalLoad,
    onManualLocalSave,
    onOpenLocalFile,
    onRebuildRag,
    onSelectLocalFile,
    onToggleAutoZip,
    onTtsConfigChange,
    previewTime,
    ragProgressLabel,
    ragStatus,
    searchStatus,
    searchStatusType,
    storageUsage,
    t,
    t_local,
    tavilyApiKey,
    tavilyUsage,
    ttsConfig,
    validationStatus,
    validationStatusType
  ]);

  return (
    <div
      className="ka-settings-backdrop absolute inset-0 z-50 flex items-center justify-center p-3 md:p-5 safe-area-padding-modal backdrop-blur-[8px]"
      style={{
        background: isDarkMode
          ? 'radial-gradient(circle at center, rgba(12,9,7,0.78), rgba(8,6,5,0.92) 72%)'
          : 'radial-gradient(circle at center, rgba(255,255,255,0.42), rgba(238,234,228,0.68) 74%, rgba(226,220,211,0.62) 100%)',
        opacity: isOpen ? 1 : 0,
        pointerEvents: isOpen ? 'auto' as const : 'none' as const,
        visibility: isOpen ? 'visible' as const : 'hidden' as const,
        transition: isOpen
          ? 'opacity 300ms ease-out, visibility 0s 0s'
          : 'opacity 200ms ease-in, visibility 0s 200ms',
        willChange: 'opacity' as const,
      }}
    >
      <div data-settings-expanded={isExpandedView ? 'true' : 'false'} className={`ka-settings-shell relative flex overflow-hidden border ${shellClass} ${shellSurfaceClass}`} style={{ opacity: isOpen ? 1 : 0, transform: isOpen ? 'translateY(0)' : 'translateY(10px)', transition: isOpen ? 'opacity 300ms ease-out, transform 300ms ease-out' : 'opacity 200ms ease-in, transform 200ms ease-in', willChange: 'transform, opacity', contain: 'layout style paint' }}>
        <div className={`absolute top-0 left-0 h-px w-full pointer-events-none ${isDarkMode ? 'bg-gradient-to-r from-transparent via-yellow-700/45 to-transparent' : 'bg-gradient-to-r from-transparent via-[#d8b56f]/42 to-transparent'}`} />
        <div className={`absolute inset-0 pointer-events-none ${isDarkMode ? 'bg-[linear-gradient(135deg,rgba(188,149,91,0.03),transparent_40%,rgba(188,149,91,0.02)_72%,transparent)]' : 'bg-[linear-gradient(180deg,rgba(255,255,255,0.22),rgba(255,255,255,0.02)_26%,transparent_52%)]'}`} />
        {!isExpandedView && (
          <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2 pointer-events-none">
            <div className="h-1 w-12 rounded-full bg-[#ddd5ca] shadow-[inset_0_1px_0_rgba(255,255,255,0.78)]" />
          </div>
        )}

        <aside data-settings-siderail className={`${isExpandedView && !isCompactSettingsLayout ? 'flex' : 'hidden'} w-[15.5rem] shrink-0 flex-col border-r ${shellDividerClass} ${railClass}`}>
          <div className="px-5 pt-5 pb-4 border-b border-inherit">
            <div className="flex items-start gap-3">
              <div className={`mt-0.5 flex h-9 w-9 items-center justify-center rounded-full border ${isDarkMode ? 'border-[#6b5132] bg-[#2a1f16] text-yellow-300' : 'border-[#e5dac9] bg-[#fffdfa] text-[#b07b1e]'}`}>
                <Settings size={16} />
              </div>
              <div className="min-w-0">
                <div className={`ka-panel-title ${titleClass}`}>{t.settingsTitle}</div>
                <div className={`mt-1 ka-kicker ${isDarkMode ? 'text-[#a88960]' : 'text-[#b7955b]'}`}>{t.systemConfig}</div>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-4 space-y-1.5 scrollbar-thin">
            {navItems.map(({ id, label, desc, icon: Icon, active, accent }) => (
              <button
                key={id}
                ref={(el) => { sideNavButtonRefs.current[id] = el; }}
                onClick={() => focusSection(id)}
                className={`w-full min-w-[8rem] rounded-[1rem] border px-3.5 py-3 text-left transition-all duration-200 ${active ? navButtonActiveClass : navButtonBaseClass}`}
              >
                <div className="flex items-start gap-3">
                  <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${active ? (isDarkMode ? 'border-[#aa8454]/70 bg-[#332618]' : 'border-[#e7dbc8] bg-[#fffaf2]') : (isDarkMode ? 'border-[#5a4430]/50 bg-transparent' : 'border-[#ece1d0] bg-[#fffefd]')}`}>
                    <Icon size={16} className={active ? accent : (isDarkMode ? 'text-[#cbb293]' : 'text-[#8b6b48]')} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className={`ka-setting-item-title ${isDarkMode ? 'text-[#f0e4d7]' : 'text-[#60462c]'}`}>{label}</div>
                    {desc && (
                      <div className={`mt-1 ka-copy-sm ${isDarkMode ? 'text-[#ae9880]' : active ? 'text-[#8b724c]' : 'text-[#a08b6f]'}`}>
                        {desc}
                      </div>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>

          <div className={`px-3 py-3 border-t ${shellDividerClass}`}>
            <button
              onClick={handleToggleExpandedView}
              className={`w-full rounded-full border px-3 py-2.5 ka-copy-sm font-semibold flex items-center justify-center gap-2 transition-all ${utilityButtonClass}`}
            >
              {isExpandedView ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              {isExpandedView
                ? (language === 'zh' ? '收为小弹窗' : 'Back To Popup')
                : (language === 'zh' ? '切换全屏' : 'Expand Workspace')}
            </button>
          </div>
        </aside>

        <div className={`relative z-10 flex min-w-0 flex-1 flex-col ${bodyClass}`}>
          <div className={`flex ${isExpandedView ? 'h-16' : 'h-[4.6rem] pt-3'} shrink-0 items-center justify-between border-b px-4 md:px-6 ${shellDividerClass}`}>
            <div className="flex min-w-0 items-center gap-3">
              <div className={`flex h-9 w-9 items-center justify-center rounded-full border lg:hidden ${isDarkMode ? 'border-[#6b5132] bg-[#2a1f16] text-yellow-300' : 'border-[#e5dac9] bg-[#fffdfa] text-[#b07b1e]'}`}>
                <Settings size={16} />
              </div>
              <div className="min-w-0">
                <div className={`ka-panel-title ${titleClass}`}>{t.settingsTitle}</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleToggleExpandedView}
                className={`hidden md:inline-flex rounded-full border p-2 transition-all ${utilityButtonClass}`}
                title={isExpandedView ? (language === 'zh' ? '收为小弹窗' : 'Back To Popup') : (language === 'zh' ? '切换全屏' : 'Expand Workspace')}
              >
                {isExpandedView ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
              <button
                onClick={onClose}
                className={`rounded-full border p-2 transition-all ${utilityButtonClass} hover:text-red-500 hover:border-red-300`}
              >
                <X size={18} />
              </button>
            </div>
          </div>

          <div data-settings-topnav className={`${isExpandedView && !isCompactSettingsLayout ? 'hidden' : ''} border-b ${shellDividerClass}`}>
            <div className="relative">
              <div
                className={`pointer-events-none absolute bottom-2 left-0 top-0 z-10 w-10 transition-all duration-300 ${
                  topNavFadeState.left ? 'opacity-100' : 'opacity-0'
                } ${isDarkMode ? 'bg-gradient-to-r from-[rgba(36,26,17,0.92)] via-[rgba(36,26,17,0.72)] to-transparent' : 'bg-gradient-to-r from-[rgba(255,255,255,0.98)] via-[rgba(255,255,255,0.9)] to-transparent'}`}
              />
              <div
                className={`pointer-events-none absolute bottom-2 right-0 top-0 z-10 w-10 transition-all duration-300 ${
                  topNavFadeState.right ? 'opacity-100' : 'opacity-0'
                } ${isDarkMode ? 'bg-gradient-to-l from-[rgba(36,26,17,0.92)] via-[rgba(36,26,17,0.72)] to-transparent' : 'bg-gradient-to-l from-[rgba(255,255,255,0.98)] via-[rgba(255,255,255,0.9)] to-transparent'}`}
              />
              <div ref={topNavScrollRef} className="flex gap-2 overflow-x-auto no-scrollbar px-4 pt-3 pb-2">
              {navItems.map(({ id, label, icon: Icon, active, accent }) => (
                <button
                  key={id}
                  ref={(el) => { topNavButtonRefs.current[id] = el; }}
                  onClick={() => focusSection(id)}
                  className={`shrink-0 rounded-full border px-3 py-2 ka-copy-sm font-semibold flex items-center gap-2 transition-all min-w-[4rem] justify-center ${active ? navButtonActiveClass : navButtonBaseClass}`}
                >
                  <Icon size={14} className={active ? accent : (isDarkMode ? 'text-[#cbb293]' : 'text-[#8b6b48]')} />
                  <span>{label}</span>
                </button>
              ))}
              </div>
            </div>
            {isTopNavIndicatorVisible && (
              <div data-settings-topnav-indicator className="px-4 pb-2">
                <div
                  ref={topNavIndicatorTrackRef}
                  onMouseDown={handleTopNavIndicatorPointerDown}
                  onMouseEnter={() => setIsTopNavIndicatorHovered(true)}
                  onMouseLeave={() => {
                    if (!isTopNavIndicatorDragging) {
                      setIsTopNavIndicatorHovered(false);
                    }
                  }}
                  className={`group relative h-3 select-none touch-none ${isTopNavIndicatorDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
                >
                  <div
                    className={`absolute inset-x-0 top-1/2 -translate-y-1/2 rounded-full transition-all duration-300 ease-out ${isDarkMode ? 'bg-white/8' : 'bg-[#e7e1d7]'} ${isTopNavIndicatorHovered || isTopNavIndicatorDragging ? 'h-[4px]' : 'h-[2px]'}`}
                  />
                  <div
                    ref={topNavIndicatorThumbRef}
                    className={`absolute top-1/2 -translate-y-1/2 rounded-full transition-all duration-300 ease-out ${isDarkMode ? 'bg-yellow-600/70' : 'bg-[linear-gradient(90deg,#d8bb7b,#bc9450)]'} ${
                      isTopNavIndicatorDragging
                        ? 'h-[5px] shadow-[0_0_0_1px_rgba(255,255,255,0.14),0_4px_12px_rgba(169,124,25,0.22)]'
                        : isTopNavIndicatorHovered
                          ? 'h-[4px] shadow-[0_0_0_1px_rgba(255,255,255,0.14),0_2px_8px_rgba(169,124,25,0.14)]'
                          : 'h-[2px]'
                    }`}
                    style={{ width: '0%', left: '0%' }}
                  />
                </div>
              </div>
            )}
          </div>

          <div
            ref={contentScrollRef}
            data-resize-heavy
            data-settings-content
            className="flex-1 overflow-y-auto touch-scroll scrollbar-thin"
            style={{ paddingBottom: 'var(--kb-inset, 0px)' }}
            onFocusCapture={(e) => {
              // v2.14.1 B.2: with Capacitor's KeyboardResize.None (set in
              // F2A.2 to stop the chat avatar from leaping when the IME
              // appears), the WebView no longer auto-scrolls a focused
              // input into view inside our fixed-overlay settings shell —
              // the input vanishes under the keyboard the moment the user
              // taps it. Combine an adaptive paddingBottom (driven by the
              // --kb-inset CSS var that useAppViewport already maintains)
              // with an explicit scrollIntoView on focus so the input
              // both has somewhere to live AND ends up visible. Using
              // requestAnimationFrame waits one frame for the keyboard's
              // height update to land before we read the layout.
              const target = e.target as HTMLElement | null;
              if (!target) return;
              const tag = target.tagName;
              if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
                requestAnimationFrame(() => {
                  try { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
                  catch { /* old WebView without smooth-scroll, ignore */ }
                });
              }
            }}
          >
            <div className={`mx-auto w-full ${isExpandedView ? 'max-w-[54rem]' : 'max-w-[46rem]'} px-4 py-5 md:px-6 md:py-6 flex flex-col gap-4`}>
              {sectionsMarkup}
            </div>
          </div>

          <div className={`hidden md:block lg:hidden shrink-0 border-t px-4 py-3 ${shellDividerClass}`}>
            <button
              onClick={handleToggleExpandedView}
              className={`w-full rounded-full border px-3 py-2.5 ka-copy-sm font-semibold flex items-center justify-center gap-2 transition-all ${utilityButtonClass}`}
            >
              {isExpandedView ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              {isExpandedView
                ? (language === 'zh' ? '收为小弹窗' : 'Back To Popup')
                : (language === 'zh' ? '切换全屏' : 'Expand Workspace')}
            </button>
          </div>
        </div>
      </div>

      <input type="file" ref={fileInputRef} className="hidden" accept=".json,.zip" onChange={handleFileChange} />

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
