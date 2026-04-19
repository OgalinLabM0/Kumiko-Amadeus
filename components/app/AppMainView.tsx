import React from 'react';
import { ImageViewer } from '../ImageViewer';
import { MemoryPanel } from '../MemoryPanel';
import { ProfilePanel } from '../ProfilePanel';
import { SettingsPanel } from '../SettingsPanel';
import { AppAvatarPanel } from './AppAvatarPanel';
import { AppChatFooter } from './AppChatFooter';
import { AppChatHeader, AppSelectionBanner } from './AppChatHeader';
import { AppMessageList } from './AppMessageList';
import { AppUpdateModal, DeleteConfirmationModal, DoubleClearAllModal, ClearAllModal, SyncConflictModal, SyncErrorModal } from './AppModals';
import { DisconnectedBanner } from './AppStatusOverlays';
import { MessageCenterPanel } from './MessageCenterPanel';
import { TaskPanel } from './TaskPanel';
import { DiaryPanel } from '../DiaryPanel';

interface AppMainViewProps {
  memoryPanelProps: React.ComponentProps<typeof MemoryPanel>;
  profilePanelProps: React.ComponentProps<typeof ProfilePanel>;
  settingsPanelProps: React.ComponentProps<typeof SettingsPanel>;
  diaryPanelProps: React.ComponentProps<typeof DiaryPanel>;
  deleteConfirmationModalProps: React.ComponentProps<typeof DeleteConfirmationModal>;
  clearAllModalProps: React.ComponentProps<typeof ClearAllModal>;
  doubleClearAllModalProps: React.ComponentProps<typeof DoubleClearAllModal>;
  syncConflictModalProps: React.ComponentProps<typeof SyncConflictModal>;
  syncErrorModalProps: React.ComponentProps<typeof SyncErrorModal>;
  appUpdateModalProps: React.ComponentProps<typeof AppUpdateModal>;
  // cloudRestoreModalProps removed with cloud sync feature (P0 #6).
  imageViewerProps: React.ComponentProps<typeof ImageViewer>;
  avatarPanelProps: React.ComponentProps<typeof AppAvatarPanel>;
  chatHeaderProps: React.ComponentProps<typeof AppChatHeader>;
  messageCenterPanelProps: React.ComponentProps<typeof MessageCenterPanel>;
  taskPanelProps: React.ComponentProps<typeof TaskPanel>;
  selectionBannerProps: React.ComponentProps<typeof AppSelectionBanner> | null;
  messageListProps: React.ComponentProps<typeof AppMessageList>;
  chatFooterProps: React.ComponentProps<typeof AppChatFooter>;
  isSelectionMode: boolean;
  sidebarBg: string;
  chatContainerShadow: string;
  isDisconnected?: boolean;
}

export const AppMainView: React.FC<AppMainViewProps> = ({
  memoryPanelProps,
  profilePanelProps,
  settingsPanelProps,
  diaryPanelProps,
  deleteConfirmationModalProps,
  clearAllModalProps,
  doubleClearAllModalProps,
  syncConflictModalProps,
  syncErrorModalProps,
  appUpdateModalProps,
  imageViewerProps,
  avatarPanelProps,
  chatHeaderProps,
  messageCenterPanelProps,
  taskPanelProps,
  selectionBannerProps,
  messageListProps,
  chatFooterProps,
  isSelectionMode,
  sidebarBg,
  chatContainerShadow,
  isDisconnected = false
}) => {
  return (
    <div className="absolute inset-0 w-full h-full flex flex-col md:flex-row animate-in fade-in duration-500" style={{overflow:'clip', contain:'layout style'}}>
      <MemoryPanel {...memoryPanelProps} />
      <ProfilePanel {...profilePanelProps} />
      <SettingsPanel {...settingsPanelProps} />
      <DiaryPanel {...diaryPanelProps} />
      <DeleteConfirmationModal {...deleteConfirmationModalProps} />
      <ClearAllModal {...clearAllModalProps} />
      <DoubleClearAllModal {...doubleClearAllModalProps} />
      <SyncConflictModal {...syncConflictModalProps} />
      <SyncErrorModal {...syncErrorModalProps} />
      <AppUpdateModal {...appUpdateModalProps} />
      <ImageViewer {...imageViewerProps} />
      <AppAvatarPanel {...avatarPanelProps} />

      <div className={`relative z-20 h-full w-full md:w-1/2 lg:w-2/5 flex flex-col border-l transition-colors duration-500 overflow-hidden min-h-0 ${sidebarBg} ${chatContainerShadow}`} style={{contain:'layout style'}}>
        <AppChatHeader {...chatHeaderProps} />
        <DisconnectedBanner
          isVisible={isDisconnected}
          isDarkMode={messageListProps.isDarkMode}
          language={messageListProps.language}
        />
        <MessageCenterPanel {...messageCenterPanelProps} />
        <TaskPanel {...taskPanelProps} />
        {isSelectionMode && selectionBannerProps && (
          <AppSelectionBanner {...selectionBannerProps} />
        )}
        <AppMessageList {...messageListProps} />
        <AppChatFooter {...chatFooterProps} />
      </div>
    </div>
  );
};
