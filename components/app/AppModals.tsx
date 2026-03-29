import React from 'react';
import { AlertTriangle, Cloud, CloudDownload, ShieldAlert, Sparkles } from 'lucide-react';
import { Language } from '../../types';

interface SyncConflictModalProps {
  isOpen: boolean;
  isDarkMode: boolean;
  message: string;
  onRestore: () => void;
}

export const SyncConflictModal: React.FC<SyncConflictModalProps> = ({
  isOpen,
  isDarkMode,
  message,
  onRestore
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 backdrop-blur-md"
      style={{ background: 'radial-gradient(circle, rgba(0,0,0,0.8) 30%, rgba(0,0,0,0) 100%)' }}
    >
      <div className={`w-full max-w-sm rounded-lg border-2 border-orange-500/50 shadow-[0_0_50px_rgba(249,115,22,0.3)] flex flex-col animate-[breathe_0.3s_ease-out] overflow-hidden ${isDarkMode ? 'bg-black' : 'bg-white'}`}>
        <div className="flex items-center gap-3 border-b pb-3 border-orange-900/30 p-6 pb-0">
          <AlertTriangle className="text-orange-500" size={24} />
          <h3 className="font-mono font-bold text-xl tracking-widest text-orange-500">SYNC CONFLICT</h3>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin px-6 py-4">
          <p className={`font-mono text-sm leading-relaxed ${isDarkMode ? 'text-gray-300' : 'text-gray-800'}`}>
            {message}
          </p>
        </div>
        <div className="flex gap-3 mt-2 px-6 pb-6">
          <button
            onClick={onRestore}
            className="flex-1 py-3 rounded font-mono font-bold transition-all shadow-lg bg-orange-600 text-white hover:bg-orange-700 flex items-center justify-center gap-2"
          >
            <Cloud size={16} /> PULL LATEST VERSION
          </button>
        </div>
      </div>
    </div>
  );
};

interface DeleteConfirmationModalProps {
  isOpen: boolean;
  isDarkMode: boolean;
  title: string;
  description: string;
  cancelLabel: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export const DeleteConfirmationModal: React.FC<DeleteConfirmationModalProps> = ({
  isOpen,
  isDarkMode,
  title,
  description,
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
      style={{ background: 'radial-gradient(circle, rgba(0,0,0,0.7) 30%, rgba(0,0,0,0) 100%)' }}
    >
      <div className={`w-full max-w-sm max-h-[80vh] flex flex-col rounded border shadow-2xl overflow-hidden animate-[breathe_0.3s_ease-out] ${isDarkMode ? 'bg-black border-red-900/50' : 'bg-white border-red-200'}`}>
        <div className="p-6 pb-0">
          <h3 className={`font-mono font-bold text-lg mb-2 ${isDarkMode ? 'text-red-500' : 'text-red-600'}`}>{title}</h3>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin px-6 mb-6">
          <p className={`${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>{description}</p>
        </div>
        <div className="flex justify-end gap-3 p-6 pt-0">
          <button onClick={onCancel} className={`px-4 py-2 rounded ${isDarkMode ? 'hover:bg-white/10' : 'hover:bg-black/5'}`}>{cancelLabel}</button>
          <button onClick={onConfirm} className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700">{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
};

interface SyncErrorModalProps {
  isOpen: boolean;
  isDarkMode: boolean;
  title: string;
  description: string;
  details: string | null;
  closeLabel: string;
  onClose: () => void;
}

export const SyncErrorModal: React.FC<SyncErrorModalProps> = ({
  isOpen,
  isDarkMode,
  title,
  description,
  details,
  closeLabel,
  onClose
}) => {
  if (!isOpen || !details) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 backdrop-blur-md"
      style={{ background: 'radial-gradient(circle, rgba(0,0,0,0.8) 30%, rgba(0,0,0,0) 100%)' }}
    >
      <div className={`w-full max-w-sm rounded-lg border-2 shadow-[0_0_30px_rgba(220,38,38,0.3)] flex flex-col animate-[shake_0.5s_ease-in-out] overflow-hidden ${isDarkMode ? 'bg-black border-red-500/50' : 'bg-white border-red-600'}`}>
        <div className="flex items-center gap-3 border-b pb-3 border-red-900/30 p-6 pb-0">
          <AlertTriangle className="text-red-500" size={24} />
          <h3 className="font-mono font-bold text-lg tracking-widest text-red-500">{title}</h3>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin px-6 py-4">
          <div className={`font-mono text-xs leading-relaxed whitespace-pre-wrap ${isDarkMode ? 'text-red-200' : 'text-red-800'}`}>
            {description}
          </div>
          <div className={`mt-4 p-3 rounded text-[10px] font-mono border ${isDarkMode ? 'bg-red-900/20 border-red-500/30 text-gray-400' : 'bg-red-50 border-red-200 text-gray-600'}`}>
            <p className="font-bold mb-1">Details:</p>
            <p className="break-all">{details}</p>
          </div>
        </div>
        <div className="flex justify-end gap-3 mt-2 px-6 pb-6">
          <button onClick={onClose} className="w-full py-3 rounded font-mono font-bold transition-all shadow-lg bg-red-600 text-white hover:bg-red-700">
            {closeLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

interface AppUpdateModalProps {
  isOpen: boolean;
  isDarkMode: boolean;
  title: string;
  description: string;
  installLabel: string;
  laterLabel: string;
  onInstall: () => void;
  onClose: () => void;
}

export const AppUpdateModal: React.FC<AppUpdateModalProps> = ({
  isOpen,
  isDarkMode,
  title,
  description,
  installLabel,
  laterLabel,
  onInstall,
  onClose
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 backdrop-blur-md"
      style={{ background: 'radial-gradient(circle, rgba(0,0,0,0.8) 30%, rgba(0,0,0,0) 100%)' }}
    >
      <div className={`w-full max-w-sm rounded-lg border-2 shadow-[0_0_30px_rgba(34,211,238,0.25)] flex flex-col animate-[breathe_0.3s_ease-out] overflow-hidden ${isDarkMode ? 'bg-black border-cyan-500/40' : 'bg-white border-cyan-300'}`}>
        <div className="flex items-center gap-3 border-b pb-3 border-cyan-900/20 p-6 pb-0">
          <CloudDownload className="text-cyan-400" size={24} />
          <h3 className="font-mono font-bold text-lg tracking-widest text-cyan-400">{title}</h3>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin px-6 py-4">
          <div className={`font-mono text-sm leading-relaxed whitespace-pre-wrap ${isDarkMode ? 'text-gray-200' : 'text-gray-700'}`}>
            {description}
          </div>
        </div>
        <div className="flex gap-3 mt-2 px-6 pb-6">
          <button
            onClick={onClose}
            className={`flex-1 py-3 rounded font-mono font-bold border transition-colors ${isDarkMode ? 'border-gray-700 text-gray-300 hover:bg-white/10' : 'border-gray-300 text-gray-700 hover:bg-black/5'}`}
          >
            {laterLabel}
          </button>
          <button
            onClick={onInstall}
            className="flex-1 py-3 rounded font-mono font-bold transition-all shadow-lg bg-cyan-600 text-white hover:bg-cyan-700 flex items-center justify-center gap-2"
          >
            <CloudDownload size={16} /> {installLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ClearAllModalProps {
  isOpen: boolean;
  isDarkMode: boolean;
  title: string;
  description: string;
  cancelLabel: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export const ClearAllModal: React.FC<ClearAllModalProps> = ({
  isOpen,
  isDarkMode,
  title,
  description,
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-md"
      style={{ background: 'radial-gradient(circle, rgba(0,0,0,0.8) 30%, rgba(0,0,0,0) 100%)' }}
    >
      <div className={`w-full max-w-sm rounded-lg border-2 shadow-[0_0_30px_rgba(0,0,0,0.5)] flex flex-col animate-[breathe_0.3s_ease-out] overflow-hidden ${isDarkMode ? 'bg-black border-yellow-500/50' : 'bg-white border-yellow-600'}`}>
        <div className="flex items-center gap-3 border-b pb-3 border-gray-800 p-6 pb-0">
          <ShieldAlert className="text-yellow-500" size={24} />
          <h3 className="font-mono font-bold text-xl tracking-widest text-yellow-500">{title}</h3>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin px-6 py-4">
          <div className={`font-mono text-sm leading-relaxed ${isDarkMode ? 'text-gray-300' : 'text-gray-800'}`}>
            {description.split('\n').map((line, i) => (
              <p key={i} className="mb-2 min-h-[1em]">
                {line.split(/(\*\*.*?\*\*)/g).map((part, j) =>
                  part.startsWith('**') && part.endsWith('**')
                    ? <strong key={j} className={isDarkMode ? 'text-yellow-500' : 'text-red-700'}>{part.slice(2, -2)}</strong>
                    : part
                )}
              </p>
            ))}
          </div>
        </div>
        <div className="flex justify-between gap-3 mt-2 px-6 pb-6">
          <button onClick={onCancel} className={`flex-1 py-3 rounded font-mono font-bold border ${isDarkMode ? 'border-gray-700 hover:bg-white/10 text-gray-400' : 'border-gray-300 hover:bg-black/5 text-gray-600'}`}>{cancelLabel}</button>
          <button onClick={onConfirm} className="flex-1 py-3 rounded font-mono font-bold transition-all shadow-lg bg-red-600 text-white hover:bg-red-700 shadow-red-900/50">{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
};

interface DoubleClearAllModalProps {
  isOpen: boolean;
  isDarkMode: boolean;
  title: string;
  description: string;
  cancelLabel: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export const DoubleClearAllModal: React.FC<DoubleClearAllModalProps> = ({
  isOpen,
  isDarkMode,
  title,
  description,
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-md transition-all duration-500"
      style={{ background: 'radial-gradient(circle, rgba(69,10,10,0.9) 30%, rgba(69,10,10,0) 100%)' }}
    >
      <div className={`relative w-full max-w-sm border-4 shadow-[0_0_80px_rgba(220,38,38,0.8)] flex flex-col animate-[shake_0.5s_ease-in-out] overflow-hidden ${isDarkMode ? 'bg-black border-red-600' : 'bg-white border-red-600'}`}>
        <div className="absolute inset-0 pointer-events-none z-0 opacity-10 bg-[linear-gradient(transparent_50%,rgba(255,0,0,0.5)_50%)] bg-[length:100%_4px]"></div>
        <div className="relative z-10 flex items-center gap-3 border-b-2 pb-4 border-red-600 p-6 pb-2 bg-red-600/10">
          <AlertTriangle className="text-red-600 animate-pulse" size={32} />
          <h3 className="font-mono font-black text-xl tracking-widest text-red-600 uppercase glitch-text">{title}</h3>
        </div>
        <div className="relative z-10 flex-1 px-6 py-6">
          <p className={`font-mono text-sm leading-loose font-bold whitespace-pre-wrap ${isDarkMode ? 'text-red-500' : 'text-red-800'}`}>{description}</p>
        </div>
        <div className="relative z-10 flex justify-between gap-4 mt-2 px-6 pb-6">
          <button onClick={onCancel} className={`flex-1 py-3 font-mono font-bold border-2 transition-all uppercase tracking-wider ${isDarkMode ? 'border-red-900 hover:bg-red-900/30 text-red-700' : 'border-red-200 hover:bg-red-50 text-red-800'}`}>{cancelLabel}</button>
          <button onClick={onConfirm} className="flex-1 py-3 font-mono font-bold transition-all shadow-[0_0_20px_rgba(220,38,38,0.6)] bg-red-600 text-white hover:bg-red-500 uppercase tracking-wider">{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
};

interface CloudRestoreModalProps {
  isOpen: boolean;
  isDarkMode: boolean;
  isIOS: boolean;
  language: Language;
  onConfirm: () => void;
  onDismiss: () => void;
}

export const CloudRestoreModal: React.FC<CloudRestoreModalProps> = ({
  isOpen,
  isDarkMode,
  isIOS,
  language,
  onConfirm,
  onDismiss
}) => {
  if (!isOpen) return null;

  const overlayClass = isIOS ? '' : 'backdrop-blur-[2px]';
  const containerClass = isIOS
    ? 'bg-[#fffaf0] border border-amber-100 shadow-xl'
    : 'bg-gradient-to-br from-[#fffaf0] via-[#fff5e6] to-[#ffe4e1] border border-white/60 shadow-[0_0_40px_rgba(255,228,196,0.6)]';

  return (
    <div className={`fixed inset-0 z-[100] flex items-center justify-center p-4 animate-in fade-in duration-300 ${overlayClass}`} style={{ background: 'radial-gradient(circle, rgba(0,0,0,0.4) 30%, rgba(0,0,0,0) 100%)' }}>
      <div className={`relative w-full max-w-sm rounded-3xl overflow-hidden ${containerClass}`}>
        {!isIOS && (
          <>
            <div className="absolute -top-10 -right-10 w-40 h-40 bg-yellow-200/40 rounded-full blur-3xl animate-pulse"></div>
            <div className="absolute -bottom-10 -left-10 w-40 h-40 bg-pink-200/40 rounded-full blur-3xl animate-pulse delay-1000"></div>
          </>
        )}
        <div className="relative z-10 p-8 flex flex-col items-center text-center">
          <div className="mb-6 relative">
            <div className="absolute inset-[-8px] border-2 border-dashed border-yellow-400/50 rounded-full animate-[spin_12s_linear_infinite]"></div>
            <div className="absolute inset-[-4px] border border-yellow-300/30 rounded-full animate-[spin_8s_linear_infinite_reverse]"></div>
            <div className="relative w-16 h-16 rounded-full bg-gradient-to-tr from-yellow-100 to-white shadow-inner flex items-center justify-center text-yellow-600 border border-white">
              <Sparkles size={28} className="animate-[spin_3s_linear_infinite]" />
            </div>
          </div>
          <h3 className="font-serif text-2xl font-bold text-[#8b5a2b] tracking-widest mb-3">MEMORY SYNC</h3>
          <p className="text-xs font-mono text-[#a67c52] leading-relaxed mb-8 px-4">
            {language === 'zh'
              ? '检测到时间流中的云端记忆碎片。\n是否将其与当前世界线合并？'
              : 'Cloud memory fragments detected in the timeline.\nMerge them with the current world line?'}
          </p>
          <div className="flex w-full gap-4">
            <button
              onClick={onDismiss}
              className="flex-1 py-3.5 rounded-xl border border-[#d4c5b0] bg-white/50 text-[#8b5a2b] text-xs font-bold hover:bg-white hover:border-[#8b5a2b] transition-all"
            >
              {language === 'zh' ? '保持现状 (Local)' : 'KEEP LOCAL'}
            </button>
            <button
              onClick={onConfirm}
              className="flex-1 py-3.5 rounded-xl bg-gradient-to-r from-[#f6d365] to-[#fda085] text-white text-xs font-bold tracking-wider shadow-lg shadow-orange-200 hover:brightness-105 active:scale-95 transition-all flex items-center justify-center gap-2"
            >
              <CloudDownload size={14} />
              {language === 'zh' ? '接受记忆 (Sync)' : 'ACCEPT'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
