import React, { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronUp, Database, HardDrive, Image, Power, RotateCcw, Trash2, Volume2, FolderOpen, Music, ImageIcon } from 'lucide-react';
import { Language } from '../../types';
import { getVoiceStorageInfo, openVoiceFolder, isVoiceServiceAvailable } from '../../services/voiceFileService';
import { db } from '../../services/db';
import { Collapse } from '../Collapse';

export interface DataDirectoryInfo {
  success: boolean;
  currentPath: string;
  defaultPath: string;
  isCustom: boolean;
  managedFolderName: string;
  migrationError?: string | null;
}

interface DataManagementTranslations {
  dataManagementTitle: string;
  dataManagementDesc: string;
  dataManagementManageLocal: string;
  dataManagementDataDirTitle: string;
  dataManagementDataDirDesc: string;
  dataManagementDataDirCurrent: string;
  dataManagementDataDirDefault: string;
  dataManagementDataDirCustom: string;
  dataManagementDataDirMove: string;
  dataManagementDataDirReset: string;
  dataManagementDataDirError: string;
  dataManagementQuitAppDesc: string;
  dataManagementQuitApp: string;
  dataManagementClearImages: string;
  dataManagementClearAll: string;
}

interface DataManagementSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  language: Language;
  t: DataManagementTranslations;
  sectionBorder: string;
  storageUsage: { usage: number; quota: number } | null;
  formatBytes: (bytes: number) => string;
  refreshStorageEstimate: () => Promise<void>;
  isDesktopElectron: boolean;
  dataDirectoryInfo: DataDirectoryInfo | null;
  formatDataDirectoryError: (error?: string | null) => string;
  onMoveDataDirectory: () => void;
  onResetDataDirectory: () => void;
  onQuitAppCompletely: () => void;
  onClearOldImages: () => void;
  onClearAllData: () => void;
}

export const DataManagementSection: React.FC<DataManagementSectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  language,
  t,
  sectionBorder,
  storageUsage,
  formatBytes,
  refreshStorageEstimate,
  isDesktopElectron,
  dataDirectoryInfo,
  formatDataDirectoryError,
  onMoveDataDirectory,
  onResetDataDirectory,
  onQuitAppCompletely,
  onClearOldImages,
  onClearAllData
}) => {
  const [voiceStorage, setVoiceStorage] = useState<{ count: number; totalBytes: number } | null>(null);
  const [imageStorage, setImageStorage] = useState<{ count: number; totalBytes: number } | null>(null);
  const [ringtoneInfo, setRingtoneInfo] = useState<{ exists: boolean; fileName: string | null; displayName?: string | null; size: number } | null>(null);
  const voiceAvailable = isVoiceServiceAvailable();

  const refreshRingtoneInfo = useCallback(async () => {
    const ipc = (window as any).electronAPI;
    if (!ipc) return;
    const result = await ipc.invoke('ringtone:get-info');
    setRingtoneInfo(result);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    if (voiceAvailable) getVoiceStorageInfo().then(setVoiceStorage);

    // Images now live on the filesystem (userData/images/) with Dexie holding
    // only metadata rows. On desktop we ask the main process for the authoritative
    // byte count; on web we fall back to the old Dexie-base64 reading path.
    (async () => {
      const ipc = (window as any).electronAPI;
      if (ipc && typeof ipc.invoke === 'function') {
        try {
          const result = await ipc.invoke('images:get-storage-info');
          if (result && result.success !== false) {
            setImageStorage({ count: result.count || 0, totalBytes: result.totalBytes || 0 });
            return;
          }
        } catch {
          // Fall through to Dexie path below.
        }
      }
      const count = await db.images.count();
      if (count === 0) { setImageStorage({ count: 0, totalBytes: 0 }); return; }
      const imgs = await db.images.toArray();
      const totalBytes = imgs.reduce((sum, img) => sum + (img.base64Data?.length || 0), 0);
      setImageStorage({ count, totalBytes });
    })();

    refreshRingtoneInfo();

    const handleRingtoneStorageChanged = () => {
      refreshRingtoneInfo();
      refreshStorageEstimate();
    };

    window.addEventListener('kumiko:ringtone-storage-changed', handleRingtoneStorageChanged);
    return () => {
      window.removeEventListener('kumiko:ringtone-storage-changed', handleRingtoneStorageChanged);
    };
  }, [isOpen, refreshRingtoneInfo, refreshStorageEstimate, voiceAvailable]);

  const voiceT = language === 'zh'
    ? { info: '语音文件', desc: '删除语音文件不影响消息文字，仅无法再次播放语音。', open: '打开语音文件夹' }
    : { info: 'Voice Files', desc: 'Deleting voice files does not affect message text; only playback is lost.', open: 'Open Voice Folder' };

  // P1 #36 follow-up: text and button updated. Images now live under
  // userData/images/ as real files; the IndexedDB line was stale, and
  // "Clear Old Images" is superseded by an "Open Folder" affordance matching
  // the ringtone/voice sections (so users can inspect or manually clean up
  // their images via the OS file manager).
  const imageT = isDesktopElectron
    ? (language === 'zh'
      ? { info: '图片文件', desc: '用户发给 Kumiko 的图片以真实文件形式存放在本机「图片」文件夹内，可直接查看或手动清理。', open: '打开图片文件夹' }
      : { info: 'Image Files', desc: 'Images you send to Kumiko are stored as real files under the local images folder — you can browse or clean them up directly.', open: 'Open Image Folder' })
    : (language === 'zh'
      ? { info: '图片文件', desc: '网页环境下图片仍缓存在浏览器 IndexedDB 中；桌面版已切换为文件系统存储。', open: null }
      : { info: 'Image Files', desc: 'In the web build, images remain in the browser IndexedDB; the desktop build uses the filesystem instead.', open: null });

  const ringtoneT = language === 'zh'
    ? { info: '用户铃声', desc: '定时来电提醒播放的自定义铃声。', open: '打开铃声文件夹', none: '未上传自定义铃声', uploaded: '已上传' }
    : { info: 'User Ringtone', desc: 'Custom ringtone for timed call reminders.', open: 'Open Ringtone Folder', none: 'No custom ringtone uploaded', uploaded: 'Uploaded' };

  const handleOpenRingtoneFolder = () => {
    const ipc = (window as any).electronAPI;
    if (ipc) ipc.invoke('ringtone:open-folder');
  };

  const handleOpenImageFolder = () => {
    const ipc = (window as any).electronAPI;
    if (ipc) ipc.invoke('images:open-folder');
  };

  return (
    <div className={`flex flex-col rounded-[1.2rem] border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between px-4 py-[1.05rem] w-full">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-2xl border ${isDarkMode ? 'border-red-500/20 bg-red-900/20 text-red-300' : 'border-red-200 bg-red-50/90 text-red-700'}`}>
            <Database size={18} />
          </div>
          <div className="text-left">
            <h3 className={`ka-section-title ${isDarkMode ? 'text-[#f5ebdc]' : 'text-[#49301f]'}`}>{t.dataManagementTitle}</h3>
            {!isOpen && <p className={`ka-section-desc ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{t.dataManagementDesc}</p>}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} /> : <ChevronDown size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />}
      </button>

      <Collapse isOpen={isOpen}>
        <div className="px-4 pb-4 pt-0 space-y-4">
          <p className={`ka-copy-sm mb-3 ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{t.dataManagementManageLocal}</p>

          {storageUsage && (() => {
            const totalUsage = (storageUsage.usage || 0) + (voiceStorage?.totalBytes || 0) + (ringtoneInfo?.size || 0);
            return (
            <div className={`p-3 rounded-lg mb-3 flex items-center justify-between ${isDarkMode ? 'bg-gray-800/50 border border-gray-700' : 'bg-gray-100 border border-gray-200'}`}>
              <div className="flex items-center gap-2">
                <Database size={16} className={isDarkMode ? 'text-gray-400' : 'text-gray-500'} />
                <span className={`ka-copy-sm font-semibold ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                  {language === 'zh' ? '当前占用空间' : 'Current Storage Usage'}
                </span>
              </div>
              <span className={`ka-label ${isDarkMode ? 'text-yellow-500' : 'text-[#b8860b]'}`}>
                {formatBytes(totalUsage)}
              </span>
            </div>
            );
          })()}

          {voiceAvailable && voiceStorage && voiceStorage.count > 0 && (
            <div className={`p-3 rounded-lg ${isDarkMode ? 'bg-gray-800/50 border border-gray-700' : 'bg-gray-100 border border-gray-200'}`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Volume2 size={16} className={isDarkMode ? 'text-purple-400' : 'text-purple-500'} />
                  <span className={`ka-copy-sm font-semibold ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                    {voiceT.info}
                  </span>
                </div>
                <span className={`ka-label ${isDarkMode ? 'text-purple-400' : 'text-purple-600'}`}>
                  {voiceStorage.count} {language === 'zh' ? '个文件' : 'files'} · {formatBytes(voiceStorage.totalBytes)}
                </span>
              </div>
              <p className={`ka-copy-sm mb-2 ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                {voiceT.desc}
              </p>
              <button onClick={() => openVoiceFolder()}
                className={`w-full py-2 rounded border border-dashed flex items-center justify-center gap-2 ka-label transition-all ${isDarkMode ? 'border-purple-500/50 text-purple-400 hover:bg-purple-500/10' : 'border-purple-600/50 text-purple-600 hover:bg-purple-600/10'}`}>
                <FolderOpen size={13} /> {voiceT.open}
              </button>
            </div>
          )}

          {imageStorage && (
            <div className={`p-3 rounded-lg ${isDarkMode ? 'bg-gray-800/50 border border-gray-700' : 'bg-gray-100 border border-gray-200'}`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Image size={16} className={isDarkMode ? 'text-sky-400' : 'text-sky-500'} />
                  <span className={`ka-copy-sm font-semibold ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                    {imageT.info}
                  </span>
                </div>
                <span className={`ka-label ${isDarkMode ? 'text-sky-400' : 'text-sky-600'}`}>
                  {imageStorage.count} {language === 'zh' ? '张' : 'images'} · {formatBytes(imageStorage.totalBytes)}
                </span>
              </div>
              <p className={`ka-copy-sm mb-2 ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                {imageT.desc}
              </p>
              {imageT.open && (
                <button onClick={handleOpenImageFolder}
                  className={`w-full py-2 rounded border border-dashed flex items-center justify-center gap-2 ka-label transition-all ${isDarkMode ? 'border-sky-500/50 text-sky-400 hover:bg-sky-500/10' : 'border-sky-600/50 text-sky-600 hover:bg-sky-600/10'}`}>
                  <FolderOpen size={13} /> {imageT.open}
                </button>
              )}
            </div>
          )}

          {isDesktopElectron && ringtoneInfo && (
            <div className={`p-3 rounded-lg ${isDarkMode ? 'bg-gray-800/50 border border-gray-700' : 'bg-gray-100 border border-gray-200'}`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Music size={16} className={isDarkMode ? 'text-amber-400' : 'text-amber-500'} />
                  <span className={`ka-copy-sm font-semibold ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                    {ringtoneT.info}
                  </span>
                </div>
                {ringtoneInfo.exists ? (
                  <span className={`ka-label ${isDarkMode ? 'text-amber-400' : 'text-amber-600'}`}>
                    {ringtoneT.uploaded} · {(ringtoneInfo.displayName || ringtoneInfo.fileName)} · {formatBytes(ringtoneInfo.size)}
                  </span>
                ) : (
                  <span className={`ka-copy-sm ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>{ringtoneT.none}</span>
                )}
              </div>
              <p className={`ka-copy-sm mb-2 ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                {ringtoneT.desc}
              </p>
              {ringtoneInfo.exists && ringtoneInfo.displayName && ringtoneInfo.displayName !== ringtoneInfo.fileName && (
                <div className={`ka-copy-sm mb-2 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  {language === 'zh' ? `原文件名：${ringtoneInfo.displayName}` : `Original file name: ${ringtoneInfo.displayName}`}
                </div>
              )}
              <button onClick={handleOpenRingtoneFolder}
                className={`w-full py-2 rounded border border-dashed flex items-center justify-center gap-2 ka-label transition-all ${isDarkMode ? 'border-amber-500/50 text-amber-400 hover:bg-amber-500/10' : 'border-amber-600/50 text-amber-600 hover:bg-amber-600/10'}`}>
                <FolderOpen size={13} /> {ringtoneT.open}
              </button>
            </div>
          )}

          {isDesktopElectron && dataDirectoryInfo && (
            <div className={`p-3 rounded-lg space-y-3 ${isDarkMode ? 'bg-gray-800/50 border border-gray-700' : 'bg-gray-100 border border-gray-200'}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <HardDrive size={16} className={isDarkMode ? 'text-gray-400' : 'text-gray-500'} />
                  <span className={`ka-copy-sm font-semibold ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                    {t.dataManagementDataDirTitle}
                  </span>
                </div>
                {dataDirectoryInfo.isCustom && (
                  <span className={`px-2 py-0.5 rounded-full ka-micro ${isDarkMode ? 'bg-yellow-500/10 text-yellow-400' : 'bg-yellow-100 text-yellow-700'}`}>
                    {t.dataManagementDataDirCustom}
                  </span>
                )}
              </div>

              <p className={`ka-copy-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                {t.dataManagementDataDirDesc}
              </p>

              <div className="space-y-2">
                <div>
                  <div className={`ka-kicker ${isDarkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                    {t.dataManagementDataDirCurrent}
                  </div>
                  <div className={`ka-copy-sm font-mono break-all ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                    {dataDirectoryInfo.currentPath}
                  </div>
                </div>

                <div>
                  <div className={`ka-kicker ${isDarkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                    {t.dataManagementDataDirDefault}
                  </div>
                  <div className={`ka-copy-sm font-mono break-all ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                    {dataDirectoryInfo.defaultPath}
                  </div>
                </div>
              </div>

              {dataDirectoryInfo.migrationError && (
                <div className={`ka-copy-sm p-2 rounded border ${isDarkMode ? 'border-red-500/30 bg-red-500/5 text-red-300' : 'border-red-200 bg-red-50 text-red-700'}`}>
                  <span className="font-bold">{t.dataManagementDataDirError}:</span> {formatDataDirectoryError(dataDirectoryInfo.migrationError)}
                </div>
              )}

              <div className="flex flex-col gap-2">
                <button onClick={onMoveDataDirectory} className={`w-full py-3 rounded border border-dashed flex items-center justify-center gap-2 ka-label transition-all ${isDarkMode ? 'border-sky-500/50 text-sky-400 hover:bg-sky-500/10' : 'border-sky-700/40 text-sky-700 hover:bg-sky-700/10'}`}>
                  <HardDrive size={14} /> {t.dataManagementDataDirMove}
                </button>

                {dataDirectoryInfo.isCustom && (
                  <button onClick={onResetDataDirectory} className={`w-full py-3 rounded border border-dashed flex items-center justify-center gap-2 ka-label transition-all ${isDarkMode ? 'border-blue-500/50 text-blue-400 hover:bg-blue-500/10' : 'border-blue-700/40 text-blue-700 hover:bg-blue-700/10'}`}>
                    <RotateCcw size={14} /> {t.dataManagementDataDirReset}
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <div className={`ka-copy-sm px-1 mb-1 ${isDarkMode ? 'text-gray-500' : 'text-gray-500'}`}>
              {t.dataManagementQuitAppDesc}
            </div>
            <button onClick={onQuitAppCompletely} className={`w-full py-3 rounded border border-dashed flex items-center justify-center gap-2 ka-label transition-all ${isDarkMode ? 'border-yellow-500/50 text-yellow-500 hover:bg-yellow-500/10' : 'border-yellow-700/50 text-yellow-700 hover:bg-yellow-700/10'}`}>
              <Power size={14} /> {t.dataManagementQuitApp}
            </button>

            <button onClick={onClearAllData} className={`w-full py-3 rounded border border-dashed flex items-center justify-center gap-2 ka-label transition-all ${isDarkMode ? 'border-red-500/50 text-red-500 hover:bg-red-500/10' : 'border-red-600/50 text-red-600 hover:bg-red-600/10'}`}>
              <Trash2 size={14} /> {t.dataManagementClearAll}
            </button>
          </div>
        </div>
      </Collapse>
    </div>
  );
};
