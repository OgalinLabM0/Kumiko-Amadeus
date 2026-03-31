import React from 'react';
import { ExtendedSyncStatus } from '../SyncStatus';
import { AppMainView } from './AppMainView';
import { AppState, AppUpdateState, BackupConfig, EmotionType, Language, LocationConfig, Message, WorldBookEntry, AnchorEntry, TtsConfig } from '../../types';

type RelativeReminderView = {
  id: string;
  event: string;
  dueAt: number;
};

type DailyReminderView = {
  id: string;
  event: string;
  hour: number;
  minute: number;
  timeZone: string;
  paused?: boolean;
};

interface BuildAppMainViewPropsParams {
  isMemoryPanelOpen: boolean;
  setIsMemoryPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isProfileOpen: boolean;
  setIsProfileOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isSettingsOpen: boolean;
  setIsSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isMessageCenterOpen: boolean;
  setIsMessageCenterOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isTaskPanelOpen: boolean;
  setIsTaskPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isDiaryOpen: boolean;
  setIsDiaryOpen: React.Dispatch<React.SetStateAction<boolean>>;
  flushIfDirty: () => void;
  coreMemory: string;
  contextLimit: number;
  messages: Message[];
  worldBook: WorldBookEntry[];
  handleSaveMemory: (newCoreMemory: string, newWorldBook: WorldBookEntry[], newContextLimit: number) => void;
  isDarkMode: boolean;
  turnCount: number;
  summaryProgressText: string;
  language: Language;
  handleUpdateMessage: (id: string, newText: string) => void;
  handleDeleteMessage: (id: string) => void;
  handleInsertMessage: (afterId: string | null, role: 'user' | 'model') => void;
  handleReorderMessages: (dragIndex: number, hoverIndex: number) => void;
  handleToggleHidden: (id: string) => void;
  handleTogglePin: (id: string) => void;
  handleJumpToMessage: (id: string) => void;
  anchors: AnchorEntry[];
  handleDeleteAnchor: (id: string) => void;
  setViewingImage: React.Dispatch<React.SetStateAction<string | null>>;
  kumikoNotebook: string;
  currentEmotion: EmotionType;
  unreadMessageCount: number;
  messageAlerts: Array<{
    id: string;
    messageId: string;
    preview: string;
    timestamp: number;
    kind: 'reply' | 'proactive' | 'reminder';
    isRead?: boolean;
  }>;
  relativeReminders: RelativeReminderView[];
  dailyReminders: DailyReminderView[];
  handleOpenMessageFromAlert: (messageId: string) => void;
  handleDismissMessageAlert: (id: string) => void;
  handleClearMessageAlerts: () => void;
  handleDeleteRelativeReminder: (id: string) => Promise<void>;
  handleDeleteDailyReminder: (id: string) => Promise<void>;
  handleToggleDailyReminderPaused: (id: string) => Promise<void>;
  handleExportBackup: () => Promise<void>;
  handleImportBackup: (file: File) => Promise<boolean>;
  handleRebuildRag: () => Promise<void>;
  setLanguage: React.Dispatch<React.SetStateAction<Language>>;
  locationConfig: LocationConfig;
  setLocationConfig: React.Dispatch<React.SetStateAction<LocationConfig>>;
  autoBackupInterval: number;
  setAutoBackupInterval: React.Dispatch<React.SetStateAction<number>>;
  connectedFileName: string | null;
  lastBackupTime: number | null;
  handleCreateNewLocalFile: () => Promise<boolean>;
  handleOpenLocalFile: () => Promise<boolean>;
  triggerManualSave: () => void;
  handleManualLocalReload: () => Promise<void>;
  backupConfig: BackupConfig;
  cloudSyncAvailable: boolean;
  handleBackupConfigChange: (nextConfig: BackupConfig) => void;
  handleCloudRestore: (silent?: boolean, checkWelcome?: boolean) => Promise<boolean | any>;
  handleCloudPush: () => Promise<void>;
  isCloudSynced: boolean;
  devLogs: { level: 'log' | 'warn' | 'error'; message: string; timestamp: string }[];
  setDevLogs: React.Dispatch<React.SetStateAction<{ level: 'log' | 'warn' | 'error'; message: string; timestamp: string }[]>>;
  ttsConfig: TtsConfig;
  handleTtsConfigChange: (config: TtsConfig) => void;
  appUpdateState: AppUpdateState;
  handleCheckForAppUpdates: () => Promise<void>;
  handleDownloadAppUpdate: () => Promise<void>;
  handleInstallAppUpdate: () => Promise<void>;
  showAppUpdateModal: boolean;
  setShowAppUpdateModal: React.Dispatch<React.SetStateAction<boolean>>;
  autoZipEnabled: boolean;
  handleToggleAutoZip: () => void;
  showDeleteConfirm: boolean;
  setShowDeleteConfirm: React.Dispatch<React.SetStateAction<boolean>>;
  t: any;
  confirmDeleteSelected: () => void;
  showClearFlow: boolean;
  setShowClearFlow: React.Dispatch<React.SetStateAction<boolean>>;
  setShowDoubleClearFlow: React.Dispatch<React.SetStateAction<boolean>>;
  showDoubleClearFlow: boolean;
  handleClearAll: () => void;
  syncStatus: string;
  showSyncErrorModal: boolean;
  setShowSyncErrorModal: React.Dispatch<React.SetStateAction<boolean>>;
  syncErrorMessage: string | null;
  showCloudRestorePrompt: boolean;
  setShowCloudRestorePrompt: React.Dispatch<React.SetStateAction<boolean>>;
  isIOS: boolean;
  hasPerformedInitialPull: React.MutableRefObject<boolean>;
  viewingImage: string | null;
  isTalking: boolean;
  statusText: string;
  avatarPanelBg: string;
  overlayClass: string;
  avatarGradient: string;
  statusTextColor: string;
  isFullscreen: boolean;
  isSelectionMode: boolean;
  ragStatus: 'IDLE' | 'RECALLING' | 'INDEXING' | 'ERROR' | 'OFF' | 'STALE';
  ragProgressLabel: string | null;
  headerBg: string;
  headerShadow: string;
  textColor: string;
  mutedTextColor: string;
  fileHandleRef: React.MutableRefObject<any>;
  toggleFullscreen: () => void;
  toggleSelectionMode: () => void;
  toggleTheme: () => void;
  manualRetry: () => void;
  initiateClearAll: () => void;
  selectedIds: Set<string>;
  pendingMessageIdsRef: React.MutableRefObject<Set<string>>;
  highlightedMessageId: string | null;
  isListening: boolean;
  isThinking: boolean;
  timeLeft: number;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  inputRef: React.RefObject<HTMLInputElement | null>;
  handleSelectMessage: (id: string) => void;
  handleRecall: (id: string) => void;
  handleReply: (msg: Message) => void;
  selectedImage: string | null;
  replyingToMsg: Message | null;
  inputValue: string;
  inputAreaBg: string;
  inputShadow: string;
  inputBoxBg: string;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  setInputValue: React.Dispatch<React.SetStateAction<string>>;
  handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  handleImageSelect: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleSend: () => void;
  messagesRef: React.MutableRefObject<Message[]>;
  handleCancelReply: () => void;
  setSelectedImage: React.Dispatch<React.SetStateAction<string | null>>;
  initiateDeleteSelected: () => void;
  sidebarBg: string;
  chatContainerShadow: string;
  handleRegenerateVoice?: (msg: Message) => void;
  regeneratingVoiceIds?: Set<string>;
  handleDisconnectLocalFile?: () => void;
}

export const buildAppMainViewProps = (
  params: BuildAppMainViewPropsParams
): React.ComponentProps<typeof AppMainView> => {
  const {
    isMemoryPanelOpen,
    setIsMemoryPanelOpen,
    isProfileOpen,
    setIsProfileOpen,
    isSettingsOpen,
    setIsSettingsOpen,
  isMessageCenterOpen,
  setIsMessageCenterOpen,
  isTaskPanelOpen,
  setIsTaskPanelOpen,
  isDiaryOpen,
  setIsDiaryOpen,
  flushIfDirty,
    coreMemory,
    contextLimit,
    messages,
    worldBook,
    handleSaveMemory,
    isDarkMode,
    turnCount,
    summaryProgressText,
    language,
    handleUpdateMessage,
    handleDeleteMessage,
    handleInsertMessage,
    handleReorderMessages,
    handleToggleHidden,
    handleTogglePin,
    handleJumpToMessage,
    anchors,
    handleDeleteAnchor,
    setViewingImage,
    kumikoNotebook,
    currentEmotion,
    unreadMessageCount,
    messageAlerts,
    relativeReminders,
    dailyReminders,
    handleOpenMessageFromAlert,
    handleDismissMessageAlert,
    handleClearMessageAlerts,
    handleDeleteRelativeReminder,
    handleDeleteDailyReminder,
    handleToggleDailyReminderPaused,
    handleExportBackup,
    handleImportBackup,
    handleRebuildRag,
    setLanguage,
    locationConfig,
    setLocationConfig,
    autoBackupInterval,
    setAutoBackupInterval,
    connectedFileName,
    lastBackupTime,
    handleCreateNewLocalFile,
    handleOpenLocalFile,
    triggerManualSave,
    handleManualLocalReload,
    backupConfig,
    cloudSyncAvailable,
    handleBackupConfigChange,
    handleCloudRestore,
    handleCloudPush,
    isCloudSynced,
    devLogs,
    setDevLogs,
    ttsConfig,
    handleTtsConfigChange,
    appUpdateState,
    handleCheckForAppUpdates,
    handleDownloadAppUpdate,
    handleInstallAppUpdate,
    showAppUpdateModal,
    setShowAppUpdateModal,
    autoZipEnabled,
    handleToggleAutoZip,
    showDeleteConfirm,
    setShowDeleteConfirm,
    t,
    confirmDeleteSelected,
    showClearFlow,
    setShowClearFlow,
    setShowDoubleClearFlow,
    showDoubleClearFlow,
    handleClearAll,
    syncStatus,
    showSyncErrorModal,
    setShowSyncErrorModal,
    syncErrorMessage,
    showCloudRestorePrompt,
    setShowCloudRestorePrompt,
    isIOS,
    hasPerformedInitialPull,
    viewingImage,
    isTalking,
    statusText,
    avatarPanelBg,
    overlayClass,
    avatarGradient,
    statusTextColor,
    isFullscreen,
    isSelectionMode,
    ragStatus,
    ragProgressLabel,
    headerBg,
    headerShadow,
    textColor,
    mutedTextColor,
    fileHandleRef,
    toggleFullscreen,
    toggleSelectionMode,
    toggleTheme,
    manualRetry,
    initiateClearAll,
    selectedIds,
    pendingMessageIdsRef,
    highlightedMessageId,
    isListening,
    isThinking,
    timeLeft,
    messagesEndRef,
    inputRef,
    handleSelectMessage,
    handleRecall,
    handleReply,
    selectedImage,
    replyingToMsg,
    inputValue,
    inputAreaBg,
    inputShadow,
    inputBoxBg,
    fileInputRef,
    setInputValue,
    handleKeyDown,
    handleImageSelect,
    handleSend,
    messagesRef,
    handleCancelReply,
    setSelectedImage,
    initiateDeleteSelected,
    sidebarBg,
    chatContainerShadow,
    handleRegenerateVoice,
    regeneratingVoiceIds,
    handleDisconnectLocalFile
  } = params;

  return {
    memoryPanelProps: {
      isOpen: isMemoryPanelOpen,
      onClose: () => { setIsMemoryPanelOpen(false); flushIfDirty(); },
      memoryContent: coreMemory,
      contextLimit,
      messages,
      worldBook,
      onSave: handleSaveMemory,
      isDarkMode,
      turnCount,
      summaryProgressText,
      language,
      onUpdateMessage: handleUpdateMessage,
      onDeleteMessage: handleDeleteMessage,
      onInsertMessage: handleInsertMessage,
      onReorderMessages: handleReorderMessages,
      onToggleHidden: handleToggleHidden,
      onTogglePin: handleTogglePin,
      onJumpToMessage: handleJumpToMessage,
      anchors,
      onDeleteAnchor: handleDeleteAnchor,
      onImageClick: setViewingImage,
      kumikoNotebook,
    },
    profilePanelProps: {
      isOpen: isProfileOpen,
      onClose: () => { setIsProfileOpen(false); flushIfDirty(); },
      isDarkMode,
      language,
      currentEmotion,
      turnCount,
      summaryProgressText
    },
    settingsPanelProps: {
      isOpen: isSettingsOpen,
      onClose: () => { setIsSettingsOpen(false); flushIfDirty(); },
      isDarkMode,
      onExportBackup: handleExportBackup,
      onImportBackup: (file) => handleImportBackup(file),
      onRebuildRag: handleRebuildRag,
      ragStatus,
      ragProgressLabel,
      language,
      onLanguageChange: setLanguage,
      locationConfig,
      onLocationChange: setLocationConfig,
      autoBackupInterval,
      onIntervalChange: setAutoBackupInterval,
      connectedFileName,
      lastBackupTime,
      onSelectLocalFile: handleCreateNewLocalFile,
      onOpenLocalFile: handleOpenLocalFile,
      onManualLocalSave: triggerManualSave,
      onManualLocalLoad: handleManualLocalReload,
      backupConfig,
      onBackupConfigChange: handleBackupConfigChange,
      onCloudRestore: handleCloudRestore,
      onCloudPush: handleCloudPush,
      isCloudSynced,
      devLogs,
      onClearDevLogs: () => setDevLogs([]),
      ttsConfig,
      onTtsConfigChange: handleTtsConfigChange,
      appUpdateState,
      onCheckForUpdates: handleCheckForAppUpdates,
      onDownloadUpdate: handleDownloadAppUpdate,
      onInstallUpdate: handleInstallAppUpdate,
      autoZipEnabled,
      onToggleAutoZip: handleToggleAutoZip,
      onDisconnectLocalFile: handleDisconnectLocalFile
    },
    diaryPanelProps: isDiaryOpen ? {
      onClose: () => setIsDiaryOpen(false),
      language,
      isDarkMode
    } : null,
    deleteConfirmationModalProps: {
      isOpen: showDeleteConfirm,
      isDarkMode,
      title: t.deleteConfirmTitle,
      description: t.deleteConfirmDesc,
      cancelLabel: t.cancel,
      confirmLabel: t.delete,
      onCancel: () => setShowDeleteConfirm(false),
      onConfirm: confirmDeleteSelected
    },
    clearAllModalProps: {
      isOpen: showClearFlow,
      isDarkMode,
      title: t.clearTitle,
      description: t.clearDesc,
      cancelLabel: t.cancel,
      confirmLabel: t.clearConfirm,
      onCancel: () => setShowClearFlow(false),
      onConfirm: () => {
        setShowClearFlow(false);
        setShowDoubleClearFlow(true);
      }
    },
    doubleClearAllModalProps: {
      isOpen: showDoubleClearFlow,
      isDarkMode,
      title: t.clearDoubleTitle,
      description: t.clearDoubleDesc,
      cancelLabel: t.cancel,
      confirmLabel: t.clearDoubleConfirm,
      onCancel: () => setShowDoubleClearFlow(false),
      onConfirm: () => {
        handleClearAll();
        setShowDoubleClearFlow(false);
      }
    },
    syncConflictModalProps: {
      isOpen: syncStatus === 'CONFLICT',
      isDarkMode,
      message: t.syncConflict,
      onRestore: () => { void handleCloudRestore(); }
    },
    syncErrorModalProps: {
      isOpen: showSyncErrorModal,
      isDarkMode,
      title: t.syncErrorTitle,
      description: t.syncErrorDesc,
      details: syncErrorMessage,
      closeLabel: t.close,
      onClose: () => setShowSyncErrorModal(false)
    },
    appUpdateModalProps: {
      isOpen: showAppUpdateModal,
      isDarkMode,
      title: t.updateModalTitle,
      description: t.updateModalDesc.replace('{0}', `v${appUpdateState.availableVersion || appUpdateState.currentVersion}`),
      installLabel: t.updateInstall,
      laterLabel: t.updateLater,
      onInstall: () => { void handleInstallAppUpdate(); },
      onClose: () => setShowAppUpdateModal(false)
    },
    cloudRestoreModalProps: {
      isOpen: cloudSyncAvailable && showCloudRestorePrompt,
      isDarkMode,
      isIOS,
      language,
      onConfirm: () => {
        void (async () => {
          await handleCloudRestore(false, true);
          setShowCloudRestorePrompt(false);
          hasPerformedInitialPull.current = true;
        })();
      },
      onDismiss: () => {
        setShowCloudRestorePrompt(false);
        hasPerformedInitialPull.current = true;
      }
    },
    imageViewerProps: {
      src: viewingImage,
      onClose: () => setViewingImage(null),
      downloadLabel: t.download
    },
    avatarPanelProps: {
      isDarkMode,
      isTalking,
      language,
      currentEmotion,
      turnCount,
      summaryProgressText,
      statusText,
      avatarPanelBg,
      overlayClass,
      avatarGradient,
      statusTextColor,
      systemName: t.systemName,
      systemId: t.systemId,
      emotionLabel: t.emotionLabel,
      turnsLabel: t.turnsLabel,
      nextSyncLabel: t.nextSyncLabel,
      voiceSyncLabel: t.voiceSync
    },
    chatHeaderProps: {
      isDarkMode,
      isTalking,
      language,
      isFullscreen,
      isSelectionMode,
      unreadMessageCount,
      activeTaskCount: relativeReminders.length + dailyReminders.length,
      ragStatus,
      syncStatus: syncStatus as ExtendedSyncStatus,
      headerBg,
      headerShadow,
      textColor,
      mutedTextColor,
      isCloudEnabled: !!backupConfig.cloudEnabled && !!backupConfig.endpointUrl,
      isLocalEnabled: !!fileHandleRef.current,
      onToggleFullscreen: toggleFullscreen,
      onToggleSelectionMode: toggleSelectionMode,
      onOpenMemory: () => setIsMemoryPanelOpen(true),
      onOpenDiary: () => setIsDiaryOpen(true),
      onToggleTheme: toggleTheme,
      onOpenProfile: () => setIsProfileOpen(true),
      onOpenInbox: () => {
        setIsTaskPanelOpen(false);
        setIsMessageCenterOpen(prev => !prev);
      },
      onOpenTasks: () => {
        setIsMessageCenterOpen(false);
        setIsTaskPanelOpen(prev => !prev);
      },
      onSyncClick: () => {
        if ((syncStatus as string) === 'ERROR') manualRetry();
        else if ((syncStatus as string) === 'ERROR' || syncErrorMessage) setShowSyncErrorModal(true);
        else triggerManualSave();
      },
      onOpenSettings: () => setIsSettingsOpen(true)
    },
    messageCenterPanelProps: {
      isOpen: isMessageCenterOpen,
      onClose: () => setIsMessageCenterOpen(false),
      isDarkMode,
      language,
      unreadCount: unreadMessageCount,
      alerts: messageAlerts,
      onOpenMessage: handleOpenMessageFromAlert,
      onDismissAlert: handleDismissMessageAlert,
      onClearAlerts: handleClearMessageAlerts
    },
    taskPanelProps: {
      isOpen: isTaskPanelOpen,
      onClose: () => setIsTaskPanelOpen(false),
      isDarkMode,
      language,
      relativeReminders,
      dailyReminders,
      onDeleteRelativeReminder: (id) => { void handleDeleteRelativeReminder(id); },
      onDeleteDailyReminder: (id) => { void handleDeleteDailyReminder(id); },
      onToggleDailyReminderPaused: (id) => { void handleToggleDailyReminderPaused(id); }
    },
    selectionBannerProps: isSelectionMode ? {
      isDarkMode,
      text: t.selectMode,
      clearLabel: t.clearDb,
      cancelLabel: t.cancel,
      onClear: initiateClearAll,
      onCancel: toggleSelectionMode
    } : null,
    messageListProps: {
      messages,
      isDarkMode,
      isSelectionMode,
      selectedIds,
      pendingMessageIds: pendingMessageIdsRef.current,
      language,
      highlightedMessageId,
      isListening,
      isThinking,
      timeLeft,
      listeningLabel: t.listening,
      typingLabel: t.typing,
      messagesEndRef,
      onBackgroundClick: () => { if (inputRef.current) inputRef.current.blur(); },
      onSelectMessage: handleSelectMessage,
      onRecall: handleRecall,
      onReply: handleReply,
    onImageClick: setViewingImage,
    onRegenerateVoice: params.handleRegenerateVoice,
    regeneratingVoiceIds: params.regeneratingVoiceIds
  },
    chatFooterProps: {
      isDarkMode,
      isSelectionMode,
      selectedIdsCount: selectedIds.size,
      selectedImage,
      replyingToMsg,
      isListening,
      isThinking,
      inputValue,
      statusText,
      inputAreaBg,
      inputShadow,
      inputBoxBg,
      selectedLabel: t.selected,
      deleteLabel: t.delete,
      replyingToLabel: t.replyingTo,
      roleModelLabel: t.roleModel,
      roleUserLabel: t.roleUser,
      recallGlobalTooltip: t.recallGlobalTooltip,
      uploadTitle: t.uploadTitle,
      sendPlaceholder: t.sendPlaceholder,
      inputRef,
      fileInputRef,
      onInputChange: setInputValue,
      onKeyDown: handleKeyDown,
      onImageSelect: handleImageSelect,
      onSend: handleSend,
      onOpenImagePicker: () => fileInputRef.current?.click(),
      onRecallPending: () => {
        const latest = messagesRef.current.filter((m) => pendingMessageIdsRef.current.has(m.id)).pop();
        if (latest) handleRecall(latest.id);
      },
      onCancelReply: handleCancelReply,
      onClearSelectedImage: () => setSelectedImage(null),
      onDeleteSelected: initiateDeleteSelected
    },
    isSelectionMode,
    sidebarBg,
    chatContainerShadow
  };
};
