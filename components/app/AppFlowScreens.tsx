import React from 'react';
import { AIConfigScreen } from '../AIConfigScreen';
import { AppState, BackupConfig, Language } from '../../types';
import { AppConnectingOverlay, AppErrorOverlay } from './AppStatusOverlays';
import { AuthScreen } from '../AuthScreen';
import { IntroScreen } from '../IntroScreen';

type FlowState = 'INTRO' | 'AUTH' | 'CONFIG' | 'APP';

interface AppFlowScreensProps {
  flowState: FlowState;
  appState: AppState;
  language: Language;
  backupConfig: BackupConfig;
  connectedFileName: string | null;
  onLanguageChange: (lang: Language) => void;
  onBackupConfigChange: (config: BackupConfig) => void;
  onSelectLocalFile: () => Promise<boolean>;
  onImportBackup: (file: File) => Promise<boolean>;
  onConnectCloud: (url: string, id: string, key?: string) => Promise<boolean>;
  onRestoreCloud: () => Promise<any>;
  onDisconnectLocalFile?: () => void;
  onShowAuth: () => void;
  onShowConfig: () => void;
  onShowApp: () => void;
  onReconfigure: () => void;
}

export const AppFlowScreens: React.FC<AppFlowScreensProps> = ({
  flowState,
  appState,
  language,
  backupConfig,
  connectedFileName,
  onLanguageChange,
  onBackupConfigChange,
  onSelectLocalFile,
  onImportBackup,
  onConnectCloud,
  onRestoreCloud,
  onDisconnectLocalFile,
  onShowAuth,
  onShowConfig,
  onShowApp,
  onReconfigure
}) => {
  return (
    <>
      {flowState === 'INTRO' && (
        <IntroScreen
          onConnect={onShowAuth}
          language={language}
          onLanguageChange={onLanguageChange}
        />
      )}

      {flowState === 'AUTH' && (
        <AuthScreen
          onEnterApp={onShowConfig}
          language={language}
          backupConfig={backupConfig}
          onBackupConfigChange={onBackupConfigChange}
          onSelectLocalFile={onSelectLocalFile}
          onImportBackup={onImportBackup}
          onConnectCloud={onConnectCloud}
          onRestoreCloud={onRestoreCloud}
          connectedFileName={connectedFileName}
          onDisconnectLocalFile={onDisconnectLocalFile}
        />
      )}

      {flowState === 'CONFIG' && (
        <AIConfigScreen
          onComplete={onShowApp}
          language={language}
        />
      )}

      <AppConnectingOverlay isOpen={appState === AppState.CONNECTING && flowState === 'APP'} />

      <AppErrorOverlay
        isOpen={appState === AppState.ERROR && flowState === 'APP'}
        onReconfigure={onReconfigure}
      />
    </>
  );
};
