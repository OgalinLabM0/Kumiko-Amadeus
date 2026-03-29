import React from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Cloud,
  Download,
  FileJson,
  FilePlus,
  FileSearch,
  HardDrive,
  Link as LinkIcon,
  Lock,
  RefreshCw,
  RotateCcw,
  Server,
  Upload,
  UserCircle
} from 'lucide-react';
import { BackupConfig } from '../../types';

interface BackupSectionTranslations {
  backupTitle: string;
  backupDesc: string;
  localBackup: string;
  localStorageHelp: string;
  advancedLocalSync: string;
  btnCreateFile: string;
  btnOpenFile: string;
  changeFile: string;
  iframeWarning: string;
  savingTo: string;
  lastAutoSave: string;
  manualSave: string;
  manualLoad: string;
  fsSyncDesc: string;
  backendService: string;
  backendDesc: string;
  backendUrl: string;
  userId: string;
  connectingBucket: string;
  connectBucket: string;
  bucketConnected: string;
  autoSavePaused: string;
  disconnect: string;
  overwriteCloud: string;
  cloudPush: string;
  restoreCloud: string;
  cloudRestore: string;
  cloudFeatureDisabledTitle: string;
  cloudFeatureDisabled: string;
  manualBackup: string;
  export: string;
  import: string;
  autoZipBackup: string;
  autoZipBackupDesc: string;
  localBackupStatusOn: string;
  localBackupStatusOff: string;
}

interface BackupSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  t: BackupSectionTranslations;
  sectionBorder: string;
  cloudSyncAvailable: boolean;
  backupConfig: BackupConfig;
  connectedFileName: string | null;
  lastBackupTime: number | null;
  isInIframe: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  connectionError: string | null;
  isCloudSynced: boolean;
  formatLastBackup: (timestamp: number) => string;
  onToggleLocalBackup: () => void;
  onToggleCloudBackup: () => void;
  onSelectLocalFile: () => void;
  onOpenLocalFile?: () => void;
  onManualLocalSave?: () => void;
  onManualLocalLoad?: () => void;
  onUpdateCloudConfig: (key: keyof BackupConfig, value: string) => void;
  onTestConnection: () => void;
  onDisconnect: () => void;
  onCloudPush: () => void;
  onCloudRestore: () => void;
  onExportBackup?: () => void;
  onOpenImportDialog: () => void;
  autoZipEnabled: boolean;
  onToggleAutoZip: () => void;
  onDisconnectLocalFile?: () => void;
}

export const BackupSection: React.FC<BackupSectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  t,
  sectionBorder,
  cloudSyncAvailable,
  backupConfig,
  connectedFileName,
  lastBackupTime,
  isInIframe,
  isConnected,
  isConnecting,
  connectionError,
  isCloudSynced,
  formatLastBackup,
  onToggleLocalBackup,
  onToggleCloudBackup,
  onSelectLocalFile,
  onOpenLocalFile,
  onManualLocalSave,
  onManualLocalLoad,
  onUpdateCloudConfig,
  onTestConnection,
  onDisconnect,
  onCloudPush,
  onCloudRestore,
  onExportBackup,
  onOpenImportDialog,
  autoZipEnabled,
  onToggleAutoZip,
  onDisconnectLocalFile
}) => {
  return (
    <div className={`flex flex-col rounded-lg border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between p-4 w-full">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-full ${isDarkMode ? 'bg-blue-900/30 text-blue-400' : 'bg-blue-100 text-blue-700'}`}>
            <Server size={20} />
          </div>
          <div className="text-left">
            <h3 className={`font-bold text-sm ${isDarkMode ? 'text-yellow-100' : 'text-gray-900'}`}>{t.backupTitle}</h3>
            {!isOpen && <p className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{t.backupDesc}</p>}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className="opacity-50" /> : <ChevronDown size={16} className="opacity-50" />}
      </button>

      {isOpen && (
        <div className="p-4 pt-0 animate-in slide-in-from-top-2 max-h-[400px] overflow-y-auto scrollbar-thin">
          <p className={`text-xs mb-3 font-mono ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>{t.backupDesc}</p>

          <div className="flex flex-col py-2 border-t border-gray-500/10">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-3">
                <HardDrive size={18} className={backupConfig.localEnabled ? (isDarkMode ? 'text-green-400' : 'text-green-600') : 'opacity-50'} />
                <div>
                  <span className={`text-sm font-bold block ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>{t.localBackup}</span>
                  <span className={`text-[10px] font-bold ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>{t.localStorageHelp}</span>
                </div>
              </div>
              <button onClick={onToggleLocalBackup} className={`w-10 h-5 rounded-full relative transition-colors ${backupConfig.localEnabled ? 'bg-green-600' : 'bg-gray-600'}`}>
                <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-all ${backupConfig.localEnabled ? 'left-6' : 'left-1'}`}></div>
              </button>
            </div>
            
            {/* Status feedback for Local Backup */}
            <div className="ml-8 flex items-center gap-1.5 p-1.5 rounded bg-black/5 dark:bg-white/5">
              {backupConfig.localEnabled ? (
                <>
                  <Check size={12} className="text-green-500" />
                  <span className={`text-[10px] font-mono ${isDarkMode ? 'text-green-400' : 'text-green-600'}`}>
                    {t.localBackupStatusOn}
                  </span>
                </>
              ) : (
                <>
                  <AlertCircle size={12} className="text-gray-400" />
                  <span className={`text-[10px] font-mono ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                    {t.localBackupStatusOff}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className={`mt-2 mb-2 p-3 rounded border border-dashed transition-all ${connectedFileName ? (isDarkMode ? 'border-green-500/30 bg-green-500/5' : 'border-green-500/30 bg-green-50') : (isDarkMode ? 'border-gray-700 bg-black/20' : 'border-gray-300 bg-gray-50')}`}>
            <div className="flex items-center gap-2 mb-2">
              <FileJson size={16} className={connectedFileName ? (isDarkMode ? 'text-green-400' : 'text-green-600') : (isDarkMode ? 'text-gray-400' : 'text-gray-600')} />
              <span className={`text-xs font-bold font-mono ${isDarkMode ? 'text-gray-300' : 'text-gray-800'}`}>{t.advancedLocalSync}</span>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-2">
                {!connectedFileName ? (
                  <div className="flex gap-2">
                    <button onClick={onSelectLocalFile} className={`flex-1 py-2 px-1 rounded text-[10px] font-bold border transition-colors flex items-center justify-center gap-1 ${isDarkMode ? 'border-gray-600 text-gray-400 hover:border-green-500 hover:text-green-500' : 'border-gray-300 text-gray-600 hover:border-green-600 hover:text-green-600'}`}>
                      <FilePlus size={12} /> {t.btnCreateFile}
                    </button>
                    {onOpenLocalFile && (
                      <button onClick={onOpenLocalFile} className={`flex-1 py-2 px-1 rounded text-[10px] font-bold border transition-colors flex items-center justify-center gap-1 ${isDarkMode ? 'border-gray-600 text-gray-400 hover:border-blue-500 hover:text-blue-500' : 'border-gray-300 text-gray-600 hover:border-blue-600 hover:text-blue-600'}`}>
                        <FileSearch size={12} /> {t.btnOpenFile}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button onClick={onSelectLocalFile} className={`flex-1 py-1.5 px-3 rounded text-xs font-bold border transition-colors ${connectedFileName ? 'border-green-500/50 text-green-500 hover:bg-green-500/10' : ''}`}>
                      {t.changeFile} (Create New)
                    </button>
                    <button onClick={onOpenLocalFile} className={`flex-1 py-1.5 px-3 rounded text-xs font-bold border transition-colors ${connectedFileName ? 'border-blue-500/50 text-blue-500 hover:bg-blue-500/10' : ''}`}>
                      {t.btnOpenFile}
                    </button>
                  </div>
                )}
              </div>

              {!connectedFileName && isInIframe && (
                <div className="flex items-start gap-2 p-2 rounded bg-orange-500/10 border border-orange-500/20 text-orange-500">
                  <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                  <p className="text-[10px] font-mono leading-tight">{t.iframeWarning}</p>
                </div>
              )}

              {connectedFileName ? (
                <div className={`text-[10px] font-mono space-y-1 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-green-500 truncate pr-2">
                      <Check size={10} className="flex-shrink-0" /> 
                      <span className="truncate">{t.savingTo}<span className="underline">{connectedFileName}</span></span>
                    </div>
                    {onDisconnectLocalFile && (
                      <button 
                        onClick={onDisconnectLocalFile}
                        className={`flex-shrink-0 px-2 py-0.5 rounded text-[9px] font-bold flex items-center gap-1 transition-colors ${isDarkMode ? 'bg-red-900/40 hover:bg-red-800/60 text-red-400' : 'bg-red-50 hover:bg-red-100 text-red-500 border border-red-200'}`}
                      >
                        <RotateCcw size={10} /> {t.disconnect}
                      </button>
                    )}
                  </div>
                  {lastBackupTime && <div className="opacity-80">{t.lastAutoSave}{formatLastBackup(lastBackupTime)}</div>}
                  <div className="flex gap-2 mt-2 pt-2 border-t border-dashed border-gray-500/30">
                    {onManualLocalSave && (
                      <button onClick={onManualLocalSave} className={`flex-1 py-1.5 rounded flex items-center justify-center gap-1.5 text-[10px] font-bold transition-colors shadow-sm ${isDarkMode ? 'bg-green-800/50 hover:bg-green-700 text-green-100' : 'bg-green-100 hover:bg-green-200 text-green-800'}`} title="Force Save to Local File">
                        <Upload size={12} /> {t.manualSave}
                      </button>
                    )}
                    {onManualLocalLoad && (
                      <button onClick={onManualLocalLoad} className={`flex-1 py-1.5 rounded flex items-center justify-center gap-1.5 text-[10px] font-bold transition-colors shadow-sm ${isDarkMode ? 'bg-blue-800/50 hover:bg-blue-700 text-blue-100' : 'bg-blue-100 hover:bg-blue-200 text-blue-800'}`} title="Reload from Local File">
                        <Download size={12} /> {t.manualLoad}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className={`flex items-start gap-2 text-[10px] ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  <AlertTriangle size={12} className="mt-0.5" />
                  <p>{t.fsSyncDesc}</p>
                </div>
              )}
            </div>
          </div>

          {/* Cloud sync section removed - feature permanently disabled */}

          <div className="mt-4 pt-3 border-t border-gray-500/20 flex flex-col gap-2">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-3">
                <div className="text-left">
                  <span className={`text-sm font-bold block ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>{t.autoZipBackup}</span>
                  <span className={`text-[10px] font-bold ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{t.autoZipBackupDesc}</span>
                </div>
              </div>
              <button onClick={onToggleAutoZip} className={`w-10 h-5 rounded-full relative transition-colors ${autoZipEnabled ? 'bg-green-600' : 'bg-gray-600'}`}>
                <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-all ${autoZipEnabled ? 'left-6' : 'left-1'}`}></div>
              </button>
            </div>
            <span className={`text-[10px] font-mono font-bold mb-1 ${isDarkMode ? 'text-yellow-500' : 'text-[#b8860b]'}`}>{t.manualBackup}</span>
            <div className="flex gap-2">
              <button onClick={onExportBackup} className={`flex-1 py-2 px-3 rounded flex items-center justify-center gap-2 text-xs font-bold transition-colors ${isDarkMode ? 'bg-gray-700 hover:bg-gray-600 text-white' : 'bg-gray-200 hover:bg-gray-300 text-gray-800'}`}>
                <Upload size={14} /> {t.export}
              </button>
              <button onClick={onOpenImportDialog} className={`flex-1 py-2 px-3 rounded flex items-center justify-center gap-2 text-xs font-bold transition-colors ${isDarkMode ? 'bg-gray-700 hover:bg-gray-600 text-white' : 'bg-gray-200 hover:bg-gray-300 text-gray-800'}`}>
                <Download size={14} /> {t.import}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
