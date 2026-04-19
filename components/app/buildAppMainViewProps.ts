import React from 'react';
import { ExtendedSyncStatus } from '../SyncStatus';
import { AppMainView } from './AppMainView';
import { AppUpdateState, BackupConfig, EmotionType, Language, LocationConfig, Message, WorldBookEntry, AnchorEntry, TtsConfig } from '../../types';

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
  diaryRewritingDate: string | null;
  setDiaryRewritingDate: React.Dispatch<React.SetStateAction<string | null>>;
  diaryBfProgress?: { current: number; total: number; currentDate: string };
  setDiaryBfProgress: React.Dispatch<React.SetStateAction<{ current: number; total: number; currentDate: string } | undefined>>;
  diaryBfComplete: boolean;
  setDiaryBfComplete: React.Dispatch<React.SetStateAction<boolean>>;
  diaryBfCount: number;
  setDiaryBfCount: React.Dispatch<React.SetStateAction<number>>;
  flushIfDirty: () => void;
  coreMemory: string;
  contextLimit: number;
  messages: Message[];
  worldBook: WorldBookEntry[];
  handleSaveMemory: (newCoreMemory: string, newWorldBook: WorldBookEntry[], newContextLimit: number) => void;
  isDarkMode: boolean;
  turnCount: number;
  summaryProgressText: string;
  handleManualSummary: () => Promise<void>;
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
  setLocationConfig: React.Dispatch<React.SetStateAction<LocationConfig>>;
  setAutoBackupInterval: React.Dispatch<React.SetStateAction<number>>;
  handleCreateNewLocalFile: () => Promise<boolean>;
  handleOpenLocalFile: () => Promise<boolean>;
  triggerManualSave: () => void;
  handleManualLocalReload: () => Promise<void>;
  backupConfig: BackupConfig;
  handleBackupConfigChange: (nextConfig: BackupConfig) => void;
  // cloudSyncAvailable / handleCloudRestore / handleCloudPush removed with cloud sync.
  devLogs: { level: 'log' | 'warn' | 'error'; message: string; timestamp: string }[];
  setDevLogs: React.Dispatch<React.SetStateAction<{ level: 'log' | 'warn' | 'error'; message: string; timestamp: string }[]>>;
  handleTtsConfigChange: (config: TtsConfig) => void;
  appUpdateState: AppUpdateState;
  handleCheckForAppUpdates: () => Promise<void>;
  handleDownloadAppUpdate: () => Promise<void>;
  handleInstallAppUpdate: () => Promise<void>;
  showAppUpdateModal: boolean;
  setShowAppUpdateModal: React.Dispatch<React.SetStateAction<boolean>>;
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
  // showCloudRestorePrompt / setShowCloudRestorePrompt / hasPerformedInitialPull removed with cloud sync.
  isIOS: boolean;
  viewingImage: string | null;
  isTalking: boolean;
  statusText: string;
  avatarPanelBg: string;
  overlayClass: string;
  avatarGradient: string;
  statusTextColor: string;
  isSelectionMode: boolean;
  ragStatus: 'IDLE' | 'RECALLING' | 'INDEXING' | 'ERROR' | 'OFF' | 'STALE';
  headerBg: string;
  headerShadow: string;
  textColor: string;
  mutedTextColor: string;
  fileHandleRef: React.MutableRefObject<any>;
  toggleFullscreen: () => void;
  toggleSelectionMode: () => void;
  toggleTheme: (e?: React.MouseEvent) => void;
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
  inputAreaBg: string;
  inputShadow: string;
  inputBoxBg: string;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  handleImageSelect: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleSend: () => void;
  messagesRef: React.MutableRefObject<Message[]>;
  initiateDeleteSelected: () => void;
  sidebarBg: string;
  chatContainerShadow: string;
  handleRegenerateVoice?: (msg: Message) => void;
  regeneratingVoiceIds?: Set<string>;
  handleDisconnectLocalFile?: () => void;
  handleResendMessage?: (id: string) => void;
  handleWithdrawMessage?: (id: string) => void;
  isDisconnected?: boolean;
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
    diaryRewritingDate,
    setDiaryRewritingDate,
    diaryBfProgress,
    setDiaryBfProgress,
    diaryBfComplete,
    setDiaryBfComplete,
    diaryBfCount,
    setDiaryBfCount,
    flushIfDirty,
    coreMemory,
    contextLimit,
    messages,
    worldBook,
    handleSaveMemory,
    isDarkMode,
    turnCount,
    summaryProgressText,
    handleManualSummary,
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
    setLocationConfig,
    setAutoBackupInterval,
    handleCreateNewLocalFile,
    handleOpenLocalFile,
    triggerManualSave,
    handleManualLocalReload,
    backupConfig,
    handleBackupConfigChange,
    devLogs,
    setDevLogs,
    handleTtsConfigChange,
    appUpdateState,
    handleCheckForAppUpdates,
    handleDownloadAppUpdate,
    handleInstallAppUpdate,
    showAppUpdateModal,
    setShowAppUpdateModal,
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
    isIOS,
    viewingImage,
    isTalking,
    statusText,
    avatarPanelBg,
    overlayClass,
    avatarGradient,
    statusTextColor,
    isSelectionMode,
    ragStatus,
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
    inputAreaBg,
    inputShadow,
    inputBoxBg,
    fileInputRef,
    handleKeyDown,
    handleImageSelect,
    handleSend,
    messagesRef,
    initiateDeleteSelected,
    sidebarBg,
    chatContainerShadow,
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
      turnCount,
      summaryProgressText,
      onManualSummary: handleManualSummary,
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
      onExportBackup: handleExportBackup,
      onImportBackup: (file) => handleImportBackup(file),
      onRebuildRag: handleRebuildRag,
      onLanguageChange: setLanguage,
      onLocationChange: setLocationConfig,
      onIntervalChange: setAutoBackupInterval,
      onSelectLocalFile: handleCreateNewLocalFile,
      onOpenLocalFile: handleOpenLocalFile,
      onManualLocalSave: triggerManualSave,
      onManualLocalLoad: handleManualLocalReload,
      onBackupConfigChange: handleBackupConfigChange,
      devLogs,
      onClearDevLogs: () => setDevLogs([]),
      onTtsConfigChange: handleTtsConfigChange,
      onCheckForUpdates: handleCheckForAppUpdates,
      onDownloadUpdate: handleDownloadAppUpdate,
      onInstallUpdate: handleInstallAppUpdate,
      onToggleAutoZip: handleToggleAutoZip,
      onDisconnectLocalFile: handleDisconnectLocalFile
    },
    diaryPanelProps: {
      isOpen: isDiaryOpen,
      onClose: () => setIsDiaryOpen(false),
      language,
      isDarkMode,
      rewritingDate: diaryRewritingDate,
      setRewritingDate: setDiaryRewritingDate,
      bfProgress: diaryBfProgress,
      setBfProgress: setDiaryBfProgress,
      bfComplete: diaryBfComplete,
      setBfComplete: setDiaryBfComplete,
      bfCount: diaryBfCount,
      setBfCount: setDiaryBfCount,
    },
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
      // Cloud restore removed; conflict modal is no-op for this button until resolved manually.
      onRestore: () => { /* cloud sync removed */ }
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
    // cloudRestoreModalProps removed with cloud sync feature.
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
      ragStatus,
      syncStatus: syncStatus as ExtendedSyncStatus,
      headerBg,
      headerShadow,
      textColor,
      mutedTextColor,
      isCloudEnabled: false,
      isLocalEnabled: !!fileHandleRef.current,
      onToggleFullscreen: toggleFullscreen,
      onToggleSelectionMode: toggleSelectionMode,
      onToggleTheme: toggleTheme,
      onSyncClick: () => {
        if ((syncStatus as string) === 'ERROR') manualRetry();
        else if ((syncStatus as string) === 'ERROR' || syncErrorMessage) setShowSyncErrorModal(true);
        else triggerManualSave();
      },
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
    regeneratingVoiceIds: params.regeneratingVoiceIds,
    onResend: params.handleResendMessage,
    onWithdraw: params.handleWithdrawMessage
  },
    isDisconnected: params.isDisconnected ?? false,
    chatFooterProps: {
      inputAreaBg,
      inputShadow,
      inputBoxBg,
      selectedLabel: t.selected,
      deleteLabel: t.delete,
      replyingToLabel: t.replyingTo,
      roleModelLabel: t.roleModel,
      roleUserLabel: t.roleUser,
      recallGlobalTooltip: t.recallGlobalTooltip,
      typingLabel: t.typing,
      uploadTitle: t.uploadTitle,
      sendPlaceholder: t.sendPlaceholder,
      inputRef,
      fileInputRef,
      onKeyDown: handleKeyDown,
      onImageSelect: handleImageSelect,
      onSend: handleSend,
      onOpenImagePicker: () => fileInputRef.current?.click(),
      onRecallPending: () => {
        const latest = messagesRef.current.filter((m) => pendingMessageIdsRef.current.has(m.id)).pop();
        if (latest) handleRecall(latest.id);
      },
      onDeleteSelected: initiateDeleteSelected
    },
    isSelectionMode,
    sidebarBg,
    chatContainerShadow
  };
};
