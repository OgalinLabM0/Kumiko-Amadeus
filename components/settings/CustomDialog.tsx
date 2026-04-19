import React, { useEffect, useState } from 'react';
import { useModalKeyboard } from '../../hooks/useModalKeyboard';

interface CustomDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  type: 'alert' | 'confirm' | 'prompt';
  inputPlaceholder?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: (inputValue?: string) => void;
  onCancel: () => void;
  isDarkMode: boolean;
  language?: 'en' | 'zh';
}

export const CustomDialog: React.FC<CustomDialogProps> = ({
  isOpen,
  title,
  message,
  type,
  inputPlaceholder,
  confirmText,
  cancelText,
  onConfirm,
  onCancel,
  isDarkMode,
  language = 'en'
}) => {
  const [inputValue, setInputValue] = useState('');

  // P2 #42: close on Esc. Also reset the input each time the dialog opens
  // so stale text from a previous invocation doesn't carry over.
  useModalKeyboard({ isOpen, onClose: onCancel });
  useEffect(() => {
    if (isOpen) setInputValue('');
  }, [isOpen]);

  if (!isOpen) return null;

  const defaultConfirm = language === 'zh' ? '确定' : 'OK';
  const defaultCancel = language === 'zh' ? '取消' : 'Cancel';
  const finalConfirmText = confirmText || defaultConfirm;
  const finalCancelText = cancelText || defaultCancel;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center backdrop-blur-sm p-4 animate-in fade-in"
      style={{
        background: isDarkMode
          ? 'radial-gradient(circle, rgba(8,6,5,0.82) 28%, rgba(6,5,4,0.92) 100%)'
          : 'radial-gradient(circle, rgba(0,0,0,0.5) 30%, rgba(0,0,0,0) 100%)'
      }}
    >
      <div className={`w-full max-w-sm rounded-xl shadow-2xl overflow-hidden ${isDarkMode ? 'bg-[#17120e] border border-[#5a4635]' : 'bg-white border border-gray-200'}`}>
        <div className="p-5">
          <h3 className={`font-bold text-lg mb-2 ${isDarkMode ? 'text-[#ead8c1]' : 'text-gray-900'}`}>{title}</h3>
          <p className={`text-sm whitespace-pre-wrap ${isDarkMode ? 'text-[#cdb89f]' : 'text-gray-600'}`}>{message}</p>

          {type === 'prompt' && (
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={inputPlaceholder}
              className={`mt-4 w-full p-2 rounded text-sm border ${isDarkMode ? 'bg-[#120d0a] border-[#5a4635] text-[#ead8c1] placeholder-[#8d7760]' : 'bg-gray-50 border-gray-300 text-gray-900 placeholder-gray-400'}`}
              autoFocus
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
            className={`px-4 py-2 rounded text-sm font-medium transition-colors ${isDarkMode ? 'bg-[linear-gradient(180deg,#9f7449,#7e5c3b)] text-[#fffaf2] hover:brightness-105' : 'bg-[#785A42] text-white hover:bg-[#6a4e39]'}`}
          >
            {finalConfirmText}
          </button>
        </div>
      </div>
    </div>
  );
};
