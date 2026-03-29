import React, { useState } from 'react';

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

  if (!isOpen) return null;

  const defaultConfirm = language === 'zh' ? '确定' : 'OK';
  const defaultCancel = language === 'zh' ? '取消' : 'Cancel';
  const finalConfirmText = confirmText || defaultConfirm;
  const finalCancelText = cancelText || defaultCancel;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center backdrop-blur-sm p-4 animate-in fade-in" style={{ background: 'radial-gradient(circle, rgba(0,0,0,0.5) 30%, rgba(0,0,0,0) 100%)' }}>
      <div className={`w-full max-w-sm rounded-xl shadow-2xl overflow-hidden ${isDarkMode ? 'bg-gray-900 border border-gray-700' : 'bg-white border border-gray-200'}`}>
        <div className="p-5">
          <h3 className={`font-bold text-lg mb-2 ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>{title}</h3>
          <p className={`text-sm whitespace-pre-wrap ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>{message}</p>

          {type === 'prompt' && (
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={inputPlaceholder}
              className={`mt-4 w-full p-2 rounded text-sm border ${isDarkMode ? 'bg-black/50 border-gray-700 text-white placeholder-gray-500' : 'bg-gray-50 border-gray-300 text-gray-900 placeholder-gray-400'}`}
              autoFocus
            />
          )}
        </div>

        <div className={`flex items-center justify-end gap-2 p-3 border-t ${isDarkMode ? 'bg-gray-800/50 border-gray-700' : 'bg-gray-50 border-gray-200'}`}>
          {type !== 'alert' && (
            <button
              onClick={onCancel}
              className={`px-4 py-2 rounded text-sm font-medium transition-colors ${isDarkMode ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-600 hover:bg-gray-200'}`}
            >
              {finalCancelText}
            </button>
          )}
          <button
            onClick={() => {
              onConfirm(type === 'prompt' ? inputValue : undefined);
              setInputValue('');
            }}
            className="px-4 py-2 rounded text-sm font-medium bg-teal-600 text-white hover:bg-teal-700 transition-colors"
          >
            {finalConfirmText}
          </button>
        </div>
      </div>
    </div>
  );
};
