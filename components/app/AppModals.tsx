import React from 'react';
import { AlertTriangle, Cloud, CloudDownload, ShieldAlert } from 'lucide-react';
import { useModalPortal } from '../../hooks/useModalPortal';
// `Language` and `Sparkles` were only used by the removed CloudRestoreModal (P0 #6).

// Phase 7 Part t11_modal_toast: shared safe-area padding so every modal
// in this file clears iOS notch/home-indicator on phones without
// touching Electron (env() === 0). Kept as module constant instead of
// a CSS class so the minimum (`1rem`) survives `max()` on old Safari.
const MODAL_SAFE_AREA_STYLE = {
  paddingTop: 'max(1rem, var(--sat))',
  paddingBottom: 'max(1rem, var(--sab))',
  paddingLeft: 'max(1rem, var(--sal))',
  paddingRight: 'max(1rem, var(--sar))',
} as const;

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
  const renderPortal = useModalPortal();

  return renderPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center backdrop-blur-md"
      style={{
        background: 'radial-gradient(circle, rgba(0,0,0,0.8) 30%, rgba(0,0,0,0) 100%)',
        ...MODAL_SAFE_AREA_STYLE,
        opacity: isOpen ? 1 : 0,
        visibility: isOpen ? 'visible' : 'hidden',
        pointerEvents: isOpen ? 'auto' : 'none',
        transition: isOpen ? 'opacity 200ms ease-out, visibility 0s 0s' : 'opacity 180ms ease-in, visibility 0s 180ms',
      }}
      aria-hidden={!isOpen}
      inert={!isOpen}
    >
      <div className={`w-full max-w-sm rounded-lg border-2 border-orange-500/50 shadow-[0_0_50px_rgba(249,115,22,0.3)] flex flex-col animate-[breathe_0.3s_ease-out] overflow-hidden ${isDarkMode ? 'bg-black' : 'bg-white'}`}>
        <div className="flex items-center gap-3 border-b pb-3 border-orange-900/30 p-6 pb-0">
          <AlertTriangle className="text-orange-500" size={24} />
          <h3 className="font-mincho font-semibold ka-floating-title tracking-[0.04em] text-orange-500">SYNC CONFLICT</h3>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin px-6 py-4">
          <p className={`ka-copy-sm leading-relaxed ${isDarkMode ? 'text-gray-300' : 'text-gray-800'}`}>
            {message}
          </p>
        </div>
        <div className="flex gap-3 mt-2 px-6 pb-6">
          <button
            onClick={onRestore}
            className="flex-1 py-3 rounded ka-label font-semibold transition-all shadow-lg bg-orange-600 text-white hover:bg-orange-700 flex items-center justify-center gap-2"
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
  const renderPortal = useModalPortal();

  return renderPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
      style={{
        background: 'radial-gradient(circle, rgba(0,0,0,0.7) 30%, rgba(0,0,0,0) 100%)',
        ...MODAL_SAFE_AREA_STYLE,
        opacity: isOpen ? 1 : 0,
        visibility: isOpen ? 'visible' : 'hidden',
        pointerEvents: isOpen ? 'auto' : 'none',
        transition: isOpen ? 'opacity 200ms ease-out, visibility 0s 0s' : 'opacity 180ms ease-in, visibility 0s 180ms',
      }}
      aria-hidden={!isOpen}
      inert={!isOpen}
    >
      <div className={`w-full max-w-sm max-h-[80vh] max-h-[80dvh] flex flex-col rounded border shadow-2xl overflow-hidden animate-[breathe_0.3s_ease-out] ${isDarkMode ? 'bg-black border-red-900/50' : 'bg-white border-red-200'}`}>
        <div className="p-6 pb-0">
          <h3 className={`font-mincho font-semibold ka-floating-title mb-2 ${isDarkMode ? 'text-red-500' : 'text-red-600'}`}>{title}</h3>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin px-6 mb-6">
          <p className={`ka-copy-sm ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>{description}</p>
        </div>
        <div className="flex justify-end gap-3 p-6 pt-0">
          <button onClick={onCancel} className={`px-4 py-2 rounded ka-label ${isDarkMode ? 'hover:bg-white/10' : 'hover:bg-black/5'}`}>{cancelLabel}</button>
          <button onClick={onConfirm} className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 ka-label">{confirmLabel}</button>
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
  const renderPortal = useModalPortal();
  const shouldShow = isOpen && !!details;

  return renderPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center backdrop-blur-md"
      style={{
        background: 'radial-gradient(circle, rgba(0,0,0,0.8) 30%, rgba(0,0,0,0) 100%)',
        ...MODAL_SAFE_AREA_STYLE,
        opacity: shouldShow ? 1 : 0,
        visibility: shouldShow ? 'visible' : 'hidden',
        pointerEvents: shouldShow ? 'auto' : 'none',
        transition: shouldShow ? 'opacity 200ms ease-out, visibility 0s 0s' : 'opacity 180ms ease-in, visibility 0s 180ms',
      }}
      aria-hidden={!shouldShow}
      inert={!shouldShow}
    >
      <div className={`w-full max-w-sm rounded-lg border-2 shadow-[0_0_30px_rgba(220,38,38,0.3)] flex flex-col animate-[shake_0.5s_ease-in-out] overflow-hidden ${isDarkMode ? 'bg-black border-red-500/50' : 'bg-white border-red-600'}`}>
        <div className="flex items-center gap-3 border-b pb-3 border-red-900/30 p-6 pb-0">
          <AlertTriangle className="text-red-500" size={24} />
          <h3 className="font-mincho font-semibold ka-floating-title tracking-[0.04em] text-red-500">{title}</h3>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin px-6 py-4">
          <div className={`ka-copy-sm leading-relaxed whitespace-pre-wrap ${isDarkMode ? 'text-red-200' : 'text-red-800'}`}>
            {description}
          </div>
          <div className={`mt-4 p-3 rounded text-[10px] font-mono border ${isDarkMode ? 'bg-red-900/20 border-red-500/30 text-gray-400' : 'bg-red-50 border-red-200 text-gray-600'}`}>
            <p className="font-bold mb-1">Details:</p>
            <p className="break-all">{details}</p>
          </div>
        </div>
        <div className="flex justify-end gap-3 mt-2 px-6 pb-6">
          <button onClick={onClose} className="w-full py-3 rounded ka-label font-semibold transition-all shadow-lg bg-red-600 text-white hover:bg-red-700">
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
  const renderPortal = useModalPortal();

  return renderPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center backdrop-blur-md"
      style={{
        background: 'radial-gradient(circle, rgba(0,0,0,0.8) 30%, rgba(0,0,0,0) 100%)',
        ...MODAL_SAFE_AREA_STYLE,
        opacity: isOpen ? 1 : 0,
        visibility: isOpen ? 'visible' : 'hidden',
        pointerEvents: isOpen ? 'auto' : 'none',
        transition: isOpen ? 'opacity 200ms ease-out, visibility 0s 0s' : 'opacity 180ms ease-in, visibility 0s 180ms',
      }}
      aria-hidden={!isOpen}
      inert={!isOpen}
    >
      <div className={`w-full max-w-sm rounded-lg border-2 shadow-[0_0_30px_rgba(34,211,238,0.25)] flex flex-col animate-[breathe_0.3s_ease-out] overflow-hidden ${isDarkMode ? 'bg-black border-cyan-500/40' : 'bg-white border-cyan-300'}`}>
        <div className="flex items-center gap-3 border-b pb-3 border-cyan-900/20 p-6 pb-0">
          <CloudDownload className="text-cyan-400" size={24} />
          <h3 className="font-mincho font-semibold ka-floating-title tracking-[0.04em] text-cyan-400">{title}</h3>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin px-6 py-4">
          <div className={`ka-copy-sm leading-relaxed whitespace-pre-wrap ${isDarkMode ? 'text-gray-200' : 'text-gray-700'}`}>
            {description}
          </div>
        </div>
        <div className="flex gap-3 mt-2 px-6 pb-6">
          <button
            onClick={onClose}
            className={`flex-1 py-3 rounded ka-label font-semibold border transition-colors ${isDarkMode ? 'border-gray-700 text-gray-300 hover:bg-white/10' : 'border-gray-300 text-gray-700 hover:bg-black/5'}`}
          >
            {laterLabel}
          </button>
          <button
            onClick={onInstall}
            className="flex-1 py-3 rounded ka-label font-semibold transition-all shadow-lg bg-cyan-600 text-white hover:bg-cyan-700 flex items-center justify-center gap-2"
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
  const renderPortal = useModalPortal();

  return renderPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-md"
      style={{
        background: 'radial-gradient(circle, rgba(0,0,0,0.8) 30%, rgba(0,0,0,0) 100%)',
        ...MODAL_SAFE_AREA_STYLE,
        opacity: isOpen ? 1 : 0,
        visibility: isOpen ? 'visible' : 'hidden',
        pointerEvents: isOpen ? 'auto' : 'none',
        transition: isOpen ? 'opacity 200ms ease-out, visibility 0s 0s' : 'opacity 180ms ease-in, visibility 0s 180ms',
      }}
      aria-hidden={!isOpen}
      inert={!isOpen}
    >
      <div className={`w-full max-w-sm rounded-lg border-2 shadow-[0_0_30px_rgba(0,0,0,0.5)] flex flex-col animate-[breathe_0.3s_ease-out] overflow-hidden ${isDarkMode ? 'bg-black border-yellow-500/50' : 'bg-white border-yellow-600'}`}>
        <div className="flex items-center gap-3 border-b pb-3 border-gray-800 p-6 pb-0">
          <ShieldAlert className="text-yellow-500" size={24} />
          <h3 className="font-mincho font-semibold ka-floating-title tracking-[0.04em] text-yellow-500">{title}</h3>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin px-6 py-4">
          <div className={`ka-copy-sm leading-relaxed ${isDarkMode ? 'text-gray-300' : 'text-gray-800'}`}>
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
          <button onClick={onCancel} className={`flex-1 py-3 rounded ka-label font-semibold border ${isDarkMode ? 'border-gray-700 hover:bg-white/10 text-gray-400' : 'border-gray-300 hover:bg-black/5 text-gray-600'}`}>{cancelLabel}</button>
          <button onClick={onConfirm} className="flex-1 py-3 rounded ka-label font-semibold transition-all shadow-lg bg-red-600 text-white hover:bg-red-700 shadow-red-900/50">{confirmLabel}</button>
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
  const renderPortal = useModalPortal();

  return renderPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-md"
      style={{
        background: 'radial-gradient(circle, rgba(69,10,10,0.9) 30%, rgba(69,10,10,0) 100%)',
        ...MODAL_SAFE_AREA_STYLE,
        opacity: isOpen ? 1 : 0,
        visibility: isOpen ? 'visible' : 'hidden',
        pointerEvents: isOpen ? 'auto' : 'none',
        transition: isOpen ? 'opacity 200ms ease-out, visibility 0s 0s' : 'opacity 180ms ease-in, visibility 0s 180ms',
      }}
      aria-hidden={!isOpen}
      inert={!isOpen}
    >
      <div className={`relative w-full max-w-sm border-4 shadow-[0_0_80px_rgba(220,38,38,0.8)] flex flex-col animate-[shake_0.5s_ease-in-out] overflow-hidden ${isDarkMode ? 'bg-black border-red-600' : 'bg-white border-red-600'}`}>
        <div className="absolute inset-0 pointer-events-none z-0 opacity-10 bg-[linear-gradient(transparent_50%,rgba(255,0,0,0.5)_50%)] bg-[length:100%_4px]"></div>
        <div className="relative z-10 flex items-center gap-3 border-b-2 pb-4 border-red-600 p-6 pb-2 bg-red-600/10">
          <AlertTriangle className="text-red-600 animate-pulse" size={32} />
          <h3 className="font-mincho font-semibold ka-floating-title tracking-[0.05em] text-red-600 uppercase glitch-text">{title}</h3>
        </div>
        <div className="relative z-10 flex-1 px-6 py-6">
          <p className={`ka-copy-sm leading-loose font-semibold whitespace-pre-wrap ${isDarkMode ? 'text-red-500' : 'text-red-800'}`}>{description}</p>
        </div>
        <div className="relative z-10 flex justify-between gap-4 mt-2 px-6 pb-6">
          <button onClick={onCancel} className={`flex-1 py-3 ka-label font-semibold border-2 transition-all uppercase tracking-[0.14em] ${isDarkMode ? 'border-red-900 hover:bg-red-900/30 text-red-700' : 'border-red-200 hover:bg-red-50 text-red-800'}`}>{cancelLabel}</button>
          <button onClick={onConfirm} className="flex-1 py-3 ka-label font-semibold transition-all shadow-[0_0_20px_rgba(220,38,38,0.6)] bg-red-600 text-white hover:bg-red-500 uppercase tracking-[0.14em]">{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
};

// CloudRestoreModal removed along with the cloud-sync feature (P0 #6).
