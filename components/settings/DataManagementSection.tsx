import React, { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronUp, Database, HardDrive, Image, Power, RotateCcw, Trash2, Volume2, FolderOpen, Music } from 'lucide-react';
import { Language } from '../../types';
import {
  getVoiceStorageInfo,
  openVoiceFolder,
  isVoiceServiceAvailable,
  clearAllVoices,
  clearRingtone,
  loadRingtoneFileWithName,
} from '../../services/voiceFileService';
import { clearAllImages } from '../../services/imageService';
import { isCapacitorNative } from '../../services/environment';
import { dialogService } from '../../services/dialogService';
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
  const isCapacitor = isCapacitorNative();

  const refreshVoiceStorage = useCallback(async () => {
    if (!voiceAvailable) return;
    const info = await getVoiceStorageInfo();
    setVoiceStorage(info);
  }, [voiceAvailable]);

  const refreshImageStorage = useCallback(async () => {
    const ipc = (window as any).electronAPI;
    if (ipc && typeof ipc.invoke === 'function') {
      try {
        const result = await ipc.invoke('images:get-storage-info');
        if (result && result.success !== false) {
          setImageStorage({ count: result.count || 0, totalBytes: result.totalBytes || 0 });
          return;
        }
      } catch {
        /* fall through */
      }
    }
    const count = await db.images.count();
    if (count === 0) { setImageStorage({ count: 0, totalBytes: 0 }); return; }
    const imgs = await db.images.toArray();
    const totalBytes = imgs.reduce((sum, img) => sum + (img.base64Data?.length || 0), 0);
    setImageStorage({ count, totalBytes });
  }, []);

  const refreshRingtoneInfo = useCallback(async () => {
    const ipc = (window as any).electronAPI;
    if (ipc) {
      const result = await ipc.invoke('ringtone:get-info');
      setRingtoneInfo(result);
      return;
    }
    // v2.14.1 E.4: Capacitor branch — synthesize the same shape from
    // the Dexie keyval row so the existing UI doesn't need a parallel
    // code path. The PC ipc result is { exists, fileName, displayName,
    // size }; we read the ringtone via loadRingtoneFileWithName which
    // already returns displayName + a buffer we can size-check.
    if (isCapacitor) {
      try {
        const loaded = await loadRingtoneFileWithName();
        if (loaded) {
          setRingtoneInfo({
            exists: true,
            fileName: loaded.fileName,
            displayName: loaded.displayName,
            size: loaded.buffer.byteLength,
          });
        } else {
          setRingtoneInfo({ exists: false, fileName: null, displayName: null, size: 0 });
        }
      } catch {
        setRingtoneInfo({ exists: false, fileName: null, displayName: null, size: 0 });
      }
    }
  }, [isCapacitor]);

  useEffect(() => {
    if (!isOpen) return;
    refreshVoiceStorage();
    refreshImageStorage();
    refreshRingtoneInfo();

    const handleRingtoneStorageChanged = () => {
      refreshRingtoneInfo();
      refreshStorageEstimate();
    };

    window.addEventListener('kumiko:ringtone-storage-changed', handleRingtoneStorageChanged);
    return () => {
      window.removeEventListener('kumiko:ringtone-storage-changed', handleRingtoneStorageChanged);
    };
  }, [isOpen, refreshRingtoneInfo, refreshStorageEstimate, refreshVoiceStorage, refreshImageStorage]);

  // v2.14.1 E.4: per-platform copy. Android can't expose a "open folder"
  // affordance because scoped storage hides app-private dirs from the
  // file manager (and surfacing them via SAF would require a confusing
  // picker UX detour). So Android shows a "Clear N MB" button + a quiet
  // location hint instead. PC keeps its existing "open folder" behaviour
  // unchanged.
  const voiceT = isCapacitor
    ? (language === 'zh'
      ? {
          info: '语音文件',
          desc: '删除语音文件不影响消息文字，仅无法再次播放语音。Android 上路径在系统文件管理器中不可见。',
          location: '存放位置：APK 私有 Files 目录 /Android/data/com.kumiko.amadeus.app/files/voices/',
          actionLabel: '清理全部语音文件',
          confirmTitle: '清理语音文件',
          confirmBody: '将删除 APK 内全部已生成的语音音频文件，原始消息文字会保留，下次重新播放时需要重新合成。确定继续？',
          confirmOk: '清理',
          confirmCancel: '取消',
          successPrefix: '已清理',
          successSuffix: '个语音文件',
          empty: '当前没有可清理的语音文件',
          failed: '清理语音文件失败',
        }
      : {
          info: 'Voice Files',
          desc: 'Deleting voice files does not affect message text; only playback is lost. The folder is not visible in the Android file manager.',
          location: 'Stored in: APK private files dir /Android/data/com.kumiko.amadeus.app/files/voices/',
          actionLabel: 'Clear All Voice Files',
          confirmTitle: 'Clear Voice Files',
          confirmBody: 'This deletes every generated voice audio file in the APK. Message text is preserved; playback will require re-synthesizing. Continue?',
          confirmOk: 'Clear',
          confirmCancel: 'Cancel',
          successPrefix: 'Cleared ',
          successSuffix: ' voice files',
          empty: 'No voice files to clear',
          failed: 'Failed to clear voice files',
        })
    : (language === 'zh'
      ? { info: '语音文件', desc: '删除语音文件不影响消息文字，仅无法再次播放语音。', open: '打开语音文件夹' }
      : { info: 'Voice Files', desc: 'Deleting voice files does not affect message text; only playback is lost.', open: 'Open Voice Folder' });

  // P1 #36 follow-up + v2.14.1 E.4: image card now has three branches:
  //   - Desktop: real files under userData/images/ → "Open Folder".
  //   - Capacitor (Android): app-private IndexedDB → "Clear All Images"
  //     because the OS file manager can't reach the WebView sandbox.
  //   - Web: dev preview only → metadata note, no actionable button.
  const imageT = isDesktopElectron
    ? (language === 'zh'
      ? { info: '图片文件', desc: '用户发给 Kumiko 的图片以真实文件形式存放在本机「图片」文件夹内，可直接查看或手动清理。', open: '打开图片文件夹', location: null, actionLabel: null }
      : { info: 'Image Files', desc: 'Images you send to Kumiko are stored as real files under the local images folder — you can browse or clean them up directly.', open: 'Open Image Folder', location: null, actionLabel: null })
    : isCapacitor
      ? (language === 'zh'
        ? {
            info: '图片文件',
            desc: 'Android 上图片以 base64 形式存放在 APK 私有 IndexedDB 中（与浏览器实现一致），系统文件管理器中不可见。',
            location: '存放位置：APK 私有 IndexedDB / Library/WebView/IndexedDB/',
            actionLabel: '清理全部图片',
            confirmTitle: '清理图片',
            confirmBody: '将删除 APK 内全部图片文件 (含历史消息中已发送的图片，文字内容保留)。确定继续？',
            confirmOk: '清理',
            confirmCancel: '取消',
            successPrefix: '已清理',
            successSuffix: '张图片',
            empty: '当前没有可清理的图片',
            failed: '清理图片失败',
            open: null,
          }
        : {
            info: 'Image Files',
            desc: 'On Android, images live as base64 in the APK\'s private IndexedDB (same as web), invisible to the OS file manager.',
            location: 'Stored in: APK private IndexedDB / Library/WebView/IndexedDB/',
            actionLabel: 'Clear All Images',
            confirmTitle: 'Clear Images',
            confirmBody: 'This deletes every image stored inside the APK (history image references will lose their picture; the message text is preserved). Continue?',
            confirmOk: 'Clear',
            confirmCancel: 'Cancel',
            successPrefix: 'Cleared ',
            successSuffix: ' images',
            empty: 'No images to clear',
            failed: 'Failed to clear images',
            open: null,
          })
      : (language === 'zh'
        ? { info: '图片文件', desc: '当前为开发预览或浏览器环境，图片缓存在浏览器 IndexedDB 中，仅用于本机调试。', open: null, location: null, actionLabel: null }
        : { info: 'Image Files', desc: 'In dev preview / browser, images stay in the browser\'s IndexedDB for local debugging only.', open: null, location: null, actionLabel: null });

  const ringtoneT = isCapacitor
    ? (language === 'zh'
      ? {
          info: '用户铃声',
          desc: '定时来电提醒播放的自定义铃声。Android 路径不对外可见，可在 TTS 设置中重新上传。',
          location: '存放位置：APK 私有 Dexie keyval (CAPACITOR_RINGTONE_KEY)',
          actionLabel: '清理自定义铃声',
          confirmTitle: '清理自定义铃声',
          confirmBody: '将删除当前已上传的自定义铃声，铃声会回退到内置选项。确定继续？',
          confirmOk: '清理',
          confirmCancel: '取消',
          successWithRingtone: '已清理自定义铃声',
          successWithoutRingtone: '当前没有自定义铃声可清理',
          failed: '清理自定义铃声失败',
          none: '未上传自定义铃声',
          uploaded: '已上传',
        }
      : {
          info: 'User Ringtone',
          desc: 'Custom ringtone for timed call reminders. Path isn\'t reachable from the Android file manager — re-upload from TTS settings if needed.',
          location: 'Stored in: APK private Dexie keyval (CAPACITOR_RINGTONE_KEY)',
          actionLabel: 'Clear Custom Ringtone',
          confirmTitle: 'Clear Custom Ringtone',
          confirmBody: 'This deletes the uploaded custom ringtone; the app will revert to a built-in tone. Continue?',
          confirmOk: 'Clear',
          confirmCancel: 'Cancel',
          successWithRingtone: 'Custom ringtone cleared',
          successWithoutRingtone: 'No custom ringtone to clear',
          failed: 'Failed to clear custom ringtone',
          none: 'No custom ringtone uploaded',
          uploaded: 'Uploaded',
        })
    : (language === 'zh'
      ? { info: '用户铃声', desc: '定时来电提醒播放的自定义铃声。', open: '打开铃声文件夹', none: '未上传自定义铃声', uploaded: '已上传' }
      : { info: 'User Ringtone', desc: 'Custom ringtone for timed call reminders.', open: 'Open Ringtone Folder', none: 'No custom ringtone uploaded', uploaded: 'Uploaded' });

  const handleOpenRingtoneFolder = () => {
    const ipc = (window as any).electronAPI;
    if (ipc) ipc.invoke('ringtone:open-folder');
  };

  const handleOpenImageFolder = () => {
    const ipc = (window as any).electronAPI;
    if (ipc) ipc.invoke('images:open-folder');
  };

  // v2.14.1 E.4: Capacitor "clear" handlers. Each one runs the
  // confirmation dialog first, fires the new clear* API from
  // voiceFileService / imageService, then re-reads the storage info so
  // the UI count drops to 0 without waiting for the user to re-toggle
  // the section. The success / empty / failure messages all surface
  // through the existing dialogService.alert path so the look matches
  // the rest of the data-management warnings.
  const handleClearVoices = useCallback(async () => {
    if (!('actionLabel' in voiceT)) return;
    const ok = await dialogService.confirm({
      title: voiceT.confirmTitle,
      message: voiceT.confirmBody,
      confirmText: voiceT.confirmOk,
      cancelText: voiceT.confirmCancel,
      variant: 'danger',
      icon: 'warning',
    });
    if (!ok) return;
    const result = await clearAllVoices();
    if (result.success) {
      const msg = result.cleared > 0
        ? `${voiceT.successPrefix}${result.cleared}${voiceT.successSuffix}`
        : voiceT.empty;
      await dialogService.alert({ title: voiceT.confirmTitle, message: msg, icon: 'info' });
    } else {
      await dialogService.alert({
        title: voiceT.confirmTitle,
        message: `${voiceT.failed}: ${result.error || 'unknown'}`,
        icon: 'warning',
      });
    }
    refreshVoiceStorage();
    refreshStorageEstimate();
  }, [voiceT, refreshVoiceStorage, refreshStorageEstimate]);

  const handleClearImages = useCallback(async () => {
    if (!('actionLabel' in imageT) || !imageT.actionLabel) return;
    const ok = await dialogService.confirm({
      title: imageT.confirmTitle as string,
      message: imageT.confirmBody as string,
      confirmText: imageT.confirmOk as string,
      cancelText: imageT.confirmCancel as string,
      variant: 'danger',
      icon: 'warning',
    });
    if (!ok) return;
    const result = await clearAllImages();
    if (result.success) {
      const msg = result.cleared > 0
        ? `${(imageT as any).successPrefix}${result.cleared}${(imageT as any).successSuffix}`
        : (imageT as any).empty;
      await dialogService.alert({ title: imageT.confirmTitle as string, message: msg, icon: 'info' });
    } else {
      await dialogService.alert({
        title: imageT.confirmTitle as string,
        message: `${(imageT as any).failed}: ${result.error || 'unknown'}`,
        icon: 'warning',
      });
    }
    refreshImageStorage();
    refreshStorageEstimate();
  }, [imageT, refreshImageStorage, refreshStorageEstimate]);

  const handleClearRingtone = useCallback(async () => {
    if (!('actionLabel' in ringtoneT)) return;
    const ok = await dialogService.confirm({
      title: ringtoneT.confirmTitle,
      message: ringtoneT.confirmBody,
      confirmText: ringtoneT.confirmOk,
      cancelText: ringtoneT.confirmCancel,
      variant: 'danger',
      icon: 'warning',
    });
    if (!ok) return;
    const result = await clearRingtone();
    if (result.success) {
      const msg = result.hadRingtone ? ringtoneT.successWithRingtone : ringtoneT.successWithoutRingtone;
      await dialogService.alert({ title: ringtoneT.confirmTitle, message: msg, icon: 'info' });
    } else {
      await dialogService.alert({
        title: ringtoneT.confirmTitle,
        message: `${ringtoneT.failed}: ${result.error || 'unknown'}`,
        icon: 'warning',
      });
    }
    refreshRingtoneInfo();
    refreshStorageEstimate();
    // Notify other parts of the app (TtsConfigSection ringtone preview, etc.)
    // that the ringtone changed.
    try { window.dispatchEvent(new Event('kumiko:ringtone-storage-changed')); } catch { /* ignore */ }
  }, [ringtoneT, refreshRingtoneInfo, refreshStorageEstimate]);

  return (
    <div className={`flex flex-col rounded-[1.2rem] border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between px-4 py-[1.05rem] w-full">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-2xl border shrink-0 ${isDarkMode ? 'border-red-500/20 bg-red-900/20 text-red-300' : 'border-red-200 bg-red-50/90 text-red-700'}`}>
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
              {isCapacitor ? (
                <>
                  <p className={`ka-copy-sm mb-2 font-mono break-all ${isDarkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                    {(voiceT as any).location}
                  </p>
                  <button onClick={handleClearVoices}
                    className={`w-full py-2 rounded border border-dashed flex items-center justify-center gap-2 ka-label transition-all ${isDarkMode ? 'border-purple-500/50 text-purple-400 hover:bg-purple-500/10' : 'border-purple-600/50 text-purple-600 hover:bg-purple-600/10'}`}>
                    <Trash2 size={13} /> {(voiceT as any).actionLabel}
                  </button>
                </>
              ) : (
                <button onClick={() => openVoiceFolder()}
                  className={`w-full py-2 rounded border border-dashed flex items-center justify-center gap-2 ka-label transition-all ${isDarkMode ? 'border-purple-500/50 text-purple-400 hover:bg-purple-500/10' : 'border-purple-600/50 text-purple-600 hover:bg-purple-600/10'}`}>
                  <FolderOpen size={13} /> {(voiceT as any).open}
                </button>
              )}
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
              {isCapacitor && (imageT as any).location && (
                <p className={`ka-copy-sm mb-2 font-mono break-all ${isDarkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                  {(imageT as any).location}
                </p>
              )}
              {isCapacitor && (imageT as any).actionLabel ? (
                <button onClick={handleClearImages}
                  className={`w-full py-2 rounded border border-dashed flex items-center justify-center gap-2 ka-label transition-all ${isDarkMode ? 'border-sky-500/50 text-sky-400 hover:bg-sky-500/10' : 'border-sky-600/50 text-sky-600 hover:bg-sky-600/10'}`}>
                  <Trash2 size={13} /> {(imageT as any).actionLabel}
                </button>
              ) : (imageT as any).open ? (
                <button onClick={handleOpenImageFolder}
                  className={`w-full py-2 rounded border border-dashed flex items-center justify-center gap-2 ka-label transition-all ${isDarkMode ? 'border-sky-500/50 text-sky-400 hover:bg-sky-500/10' : 'border-sky-600/50 text-sky-600 hover:bg-sky-600/10'}`}>
                  <FolderOpen size={13} /> {(imageT as any).open}
                </button>
              ) : null}
            </div>
          )}

          {(isDesktopElectron || isCapacitor) && ringtoneInfo && (
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
              {isCapacitor ? (
                <>
                  <p className={`ka-copy-sm mb-2 font-mono break-all ${isDarkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                    {(ringtoneT as any).location}
                  </p>
                  <button
                    onClick={handleClearRingtone}
                    disabled={!ringtoneInfo.exists}
                    className={`w-full py-2 rounded border border-dashed flex items-center justify-center gap-2 ka-label transition-all ${
                      ringtoneInfo.exists
                        ? (isDarkMode ? 'border-amber-500/50 text-amber-400 hover:bg-amber-500/10' : 'border-amber-600/50 text-amber-600 hover:bg-amber-600/10')
                        : (isDarkMode ? 'border-gray-700 text-gray-500' : 'border-gray-300 text-gray-400')
                    }`}
                  >
                    <Trash2 size={13} /> {(ringtoneT as any).actionLabel}
                  </button>
                </>
              ) : (
                <button onClick={handleOpenRingtoneFolder}
                  className={`w-full py-2 rounded border border-dashed flex items-center justify-center gap-2 ka-label transition-all ${isDarkMode ? 'border-amber-500/50 text-amber-400 hover:bg-amber-500/10' : 'border-amber-600/50 text-amber-600 hover:bg-amber-600/10'}`}>
                  <FolderOpen size={13} /> {(ringtoneT as any).open}
                </button>
              )}
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
            {/* v2.14.1 G.2: "彻底退出" button is desktop-only — on Android the
                only "quit completely" semantic is `System.exit(0)` which Google
                explicitly discourages, and Capacitor lifecycle (back-pressed →
                onPause → finish) already handles app termination cleanly. The
                button + helper copy used to render unconditionally and confused
                users who tapped it expecting it to clear cached data. PC behaviour
                unchanged. */}
            {!isCapacitor && (
              <>
                <div className={`ka-copy-sm px-1 mb-1 ${isDarkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                  {t.dataManagementQuitAppDesc}
                </div>
                <button onClick={onQuitAppCompletely} className={`w-full py-3 rounded border border-dashed flex items-center justify-center gap-2 ka-label transition-all ${isDarkMode ? 'border-yellow-500/50 text-yellow-500 hover:bg-yellow-500/10' : 'border-yellow-700/50 text-yellow-700 hover:bg-yellow-700/10'}`}>
                  <Power size={14} /> {t.dataManagementQuitApp}
                </button>
              </>
            )}

            <button onClick={onClearAllData} className={`w-full py-3 rounded border border-dashed flex items-center justify-center gap-2 ka-label transition-all ${isDarkMode ? 'border-red-500/50 text-red-500 hover:bg-red-500/10' : 'border-red-600/50 text-red-600 hover:bg-red-600/10'}`}>
              <Trash2 size={14} /> {t.dataManagementClearAll}
            </button>
          </div>
        </div>
      </Collapse>
    </div>
  );
};
