import React, { useEffect, useRef, useState } from 'react';
import { Info, AlertTriangle, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useModalKeyboard } from '../../hooks/useModalKeyboard';
import { useModalPortal } from '../../hooks/useModalPortal';

export type CustomDialogVariant = 'default' | 'danger';
export type CustomDialogIcon = 'info' | 'warning' | 'error' | 'success';

export interface CustomDialogProps {
  isOpen: boolean;
  title?: string;
  message: string;
  type: 'alert' | 'confirm' | 'prompt';
  inputPlaceholder?: string;
  inputDefaultValue?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: CustomDialogVariant;
  icon?: CustomDialogIcon;
  onConfirm: (inputValue?: string) => void;
  onCancel: () => void;
  isDarkMode: boolean;
  language?: 'en' | 'zh';
}

const ICON_MAP: Record<CustomDialogIcon, React.ComponentType<{ size?: number; className?: string }>> = {
  info: Info,
  warning: AlertTriangle,
  error: AlertCircle,
  success: CheckCircle2,
};

const ICON_TINT_LIGHT: Record<CustomDialogIcon, string> = {
  info: 'text-[#5c6f8a]',
  warning: 'text-[#b07f28]',
  error: 'text-[#b84545]',
  success: 'text-[#2f8a4f]',
};
const ICON_TINT_DARK: Record<CustomDialogIcon, string> = {
  info: 'text-[#8eaac8]',
  warning: 'text-[#e8c078]',
  error: 'text-[#e8848a]',
  success: 'text-[#7cc29a]',
};

export const CustomDialog: React.FC<CustomDialogProps> = ({
  isOpen,
  title,
  message,
  type,
  inputPlaceholder,
  inputDefaultValue,
  confirmText,
  cancelText,
  variant = 'default',
  icon,
  onConfirm,
  onCancel,
  isDarkMode,
  language = 'en'
}) => {
  const [inputValue, setInputValue] = useState(inputDefaultValue ?? '');
  const renderPortal = useModalPortal();
  const inputRef = useRef<HTMLInputElement | null>(null);

  // P2 #42: close on Esc. Also reset the input each time the dialog opens
  // so stale text from a previous invocation doesn't carry over.
  useModalKeyboard({ isOpen, onClose: onCancel });
  useEffect(() => {
    if (isOpen) setInputValue(inputDefaultValue ?? '');
  }, [isOpen, inputDefaultValue]);

  // The dialog is now permanently mounted (preload, no first-paint jank),
  // so `autoFocus` would never re-fire. Explicitly focus the prompt input
  // each time the dialog transitions into the open state.
  useEffect(() => {
    if (isOpen && type === 'prompt') {
      const t = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => window.clearTimeout(t);
    }
  }, [isOpen, type]);

  const defaultConfirm = language === 'zh' ? '确定' : 'OK';
  const defaultCancel = language === 'zh' ? '取消' : 'Cancel';
  const finalConfirmText = confirmText || defaultConfirm;
  const finalCancelText = cancelText || defaultCancel;

  const IconComp = icon ? ICON_MAP[icon] : null;
  const iconTint = icon
    ? (isDarkMode ? ICON_TINT_DARK[icon] : ICON_TINT_LIGHT[icon])
    : '';

  const confirmClass = variant === 'danger'
    ? (isDarkMode
        ? 'bg-[linear-gradient(180deg,#b85a5a,#8a4040)] text-white hover:brightness-110'
        : 'bg-[#c64545] text-white hover:bg-[#b03838]')
    : (isDarkMode
        ? 'bg-[linear-gradient(180deg,#9f7449,#7e5c3b)] text-[#fffaf2] hover:brightness-105'
        : 'bg-[#785A42] text-white hover:bg-[#6a4e39]');

  // Phase 7 Part t5_a2_custom_dialog: portal into <body> so DiaryPanel /
  // SettingsPanel shell / other hijacked hosts no longer clip the backdrop.
  return renderPortal(
    // Phase 7 Part t11_modal_toast: the `p-4` padding assumed no device
    // notch/home-indicator. On iOS landscape the confirm button could
    // slip under the home bar. env(safe-area-inset-*) bumps the min
    // padding. Desktop gets the original 1rem minimum.
    <div
      className="fixed inset-0 z-[999999] flex items-center justify-center backdrop-blur-sm"
      style={{
        background: isDarkMode
          ? 'radial-gradient(circle, rgba(8,6,5,0.82) 28%, rgba(6,5,4,0.92) 100%)'
          : 'radial-gradient(circle, rgba(0,0,0,0.5) 30%, rgba(0,0,0,0) 100%)',
        paddingTop: 'max(1rem, var(--sat))',
        paddingBottom: 'max(1rem, var(--sab))',
        paddingLeft: 'max(1rem, var(--sal))',
        paddingRight: 'max(1rem, var(--sar))',
        opacity: isOpen ? 1 : 0,
        visibility: isOpen ? 'visible' : 'hidden',
        pointerEvents: isOpen ? 'auto' : 'none',
        transition: isOpen ? 'opacity 200ms ease-out, visibility 0s 0s' : 'opacity 180ms ease-in, visibility 0s 180ms',
      }}
      aria-hidden={!isOpen}
      inert={!isOpen}
    >
      <div className={`w-full max-w-sm rounded-xl shadow-2xl overflow-hidden ${isDarkMode ? 'bg-[#17120e] border border-[#5a4635]' : 'bg-white border border-gray-200'}`}>
        <div className="p-5">
          {title && (
            <div className="flex items-start gap-2 mb-2">
              {IconComp && (
                <span className={`flex-shrink-0 mt-0.5 ${iconTint}`}>
                  <IconComp size={18} />
                </span>
              )}
              <h3 className={`font-bold text-lg leading-snug ${isDarkMode ? 'text-[#ead8c1]' : 'text-gray-900'}`}>{title}</h3>
            </div>
          )}
          {!title && IconComp && (
            <div className="flex items-center gap-2 mb-2">
              <span className={`flex-shrink-0 ${iconTint}`}>
                <IconComp size={18} />
              </span>
            </div>
          )}
          <p className={`text-sm whitespace-pre-wrap leading-relaxed ${isDarkMode ? 'text-[#cdb89f]' : 'text-gray-600'}`}>{message}</p>

          {type === 'prompt' && (
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={inputPlaceholder}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onConfirm(inputValue);
                  setInputValue('');
                }
              }}
              className={`mt-4 w-full p-2 rounded text-sm border outline-none focus:ring-1 ${isDarkMode ? 'bg-[#120d0a] border-[#5a4635] text-[#ead8c1] placeholder-[#8d7760] focus:ring-[#9f7449]' : 'bg-gray-50 border-gray-300 text-gray-900 placeholder-gray-400 focus:ring-[#785A42]'}`}
            />
          )}
        </div>

        <div className={`flex items-center justify-end gap-2 p-3 border-t ${isDarkMode ? 'bg-[#211a14] border-[#5a4635]' : 'bg-gray-50 border-gray-200'}`}>
          {type !== 'alert' && (
            <button
              onClick={onCancel}
              className={`px-4 py-2 rounded text-sm font-medium transition-colors ${isDarkMode ? 'text-[#cdb89f] hover:bg-white/6' : 'text-gray-600 hover:bg-gray-200'}`}
            >
              {finalCancelText}
            </button>
          )}
          <button
            onClick={() => {
              onConfirm(type === 'prompt' ? inputValue : undefined);
              setInputValue('');
            }}
            className={`px-4 py-2 rounded text-sm font-medium transition-colors ${confirmClass}`}
          >
            {finalConfirmText}
          </button>
        </div>
      </div>
    </div>
  );
};
