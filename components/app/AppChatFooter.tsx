import React from 'react';
import { Paperclip, Quote, Send, Trash2, Undo2, X } from 'lucide-react';
import { Message } from '../../types';

interface AppChatFooterProps {
  isDarkMode: boolean;
  isSelectionMode: boolean;
  selectedIdsCount: number;
  selectedImage: string | null;
  replyingToMsg: Message | null;
  isListening: boolean;
  isThinking: boolean;
  inputValue: string;
  statusText: string;
  inputAreaBg: string;
  inputShadow: string;
  inputBoxBg: string;
  selectedLabel: string;
  deleteLabel: string;
  replyingToLabel: string;
  roleModelLabel: string;
  roleUserLabel: string;
  recallGlobalTooltip: string;
  uploadTitle: string;
  sendPlaceholder: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onInputChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onImageSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSend: () => void;
  onOpenImagePicker: () => void;
  onRecallPending: () => void;
  onCancelReply: () => void;
  onClearSelectedImage: () => void;
  onDeleteSelected: () => void;
}

export const AppChatFooter: React.FC<AppChatFooterProps> = ({
  isDarkMode,
  isSelectionMode,
  selectedIdsCount,
  selectedImage,
  replyingToMsg,
  isListening,
  isThinking,
  inputValue,
  statusText,
  inputAreaBg,
  inputShadow,
  inputBoxBg,
  selectedLabel,
  deleteLabel,
  replyingToLabel,
  roleModelLabel,
  roleUserLabel,
  recallGlobalTooltip,
  uploadTitle,
  sendPlaceholder,
  inputRef,
  fileInputRef,
  onInputChange,
  onKeyDown,
  onImageSelect,
  onSend,
  onOpenImagePicker,
  onRecallPending,
  onCancelReply,
  onClearSelectedImage,
  onDeleteSelected
}) => {
  return (
    <>
      {selectedImage && (
        <div className={`px-4 pt-2 flex items-center ${isDarkMode ? 'bg-[#141414]/80' : 'bg-gray-100/80'}`}>
          <div className="relative group">
            <img src={selectedImage} alt="Preview" className="h-16 w-16 object-cover rounded border border-yellow-600/50" />
            <button onClick={onClearSelectedImage} className="absolute -top-2 -right-2 bg-red-900/80 text-white rounded-full p-0.5 hover:bg-red-700 transition-colors">
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {isSelectionMode ? (
        <div className={`pt-2 px-3 border-t flex items-center justify-between pb-[max(0.5rem,env(safe-area-inset-bottom))] md:pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] ${isDarkMode ? 'bg-red-900/10 border-red-900/30' : 'bg-red-50 border-red-200'}`}>
          <span className={`font-mono text-sm ${isDarkMode ? 'text-red-400' : 'text-red-600'}`}>{selectedIdsCount} {selectedLabel}</span>
          <button onClick={onDeleteSelected} disabled={selectedIdsCount === 0} className="flex items-center gap-2 px-6 py-2 bg-red-600 text-white font-mono font-bold rounded hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed">
            <Trash2 size={16} /> {deleteLabel}
          </button>
        </div>
      ) : (
        <div className={`pt-2 px-3 border-t transition-colors duration-500 pb-[max(0.25rem,env(safe-area-inset-bottom))] md:pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] ${inputAreaBg} ${inputShadow}`}>
          {replyingToMsg && (
            <div className={`flex items-center justify-between mb-2 p-2 rounded-lg text-xs border-l-2 ${isDarkMode ? 'bg-white/5 border-yellow-500 text-gray-300' : 'bg-black/5 border-yellow-600 text-gray-700'} animate-in slide-in-from-bottom-2`}>
              <div className="flex flex-col overflow-hidden">
                <span className="font-bold flex items-center gap-1 opacity-70">
                  <Quote size={10} /> {replyingToLabel}: {replyingToMsg.role === 'model' ? roleModelLabel : roleUserLabel}
                </span>
                <span className="truncate opacity-90 italic">"{replyingToMsg.text}"</span>
              </div>
              <button onClick={onCancelReply} className="p-1 rounded-full hover:bg-red-500/20 hover:text-red-500 transition-colors">
                <X size={14} />
              </button>
            </div>
          )}

          <div className="relative flex items-center gap-2">
            <div className={`absolute left-0 top-0 bottom-0 w-1 rounded-l ${isDarkMode ? 'bg-yellow-600' : 'bg-[#b8860b]'}`}></div>
            <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={onImageSelect} />
            {isListening && (
              <button onClick={onRecallPending} className={`w-10 h-10 flex-shrink-0 rounded flex items-center justify-center transition-colors animate-in zoom-in duration-200 ${isDarkMode ? 'bg-red-900/20 text-red-500 hover:text-red-400 hover:bg-red-900/40' : 'bg-red-100 text-red-600 hover:bg-red-200'}`} title={recallGlobalTooltip}>
                <Undo2 size={18} />
              </button>
            )}

            <button
              onClick={onOpenImagePicker}
              className={`w-10 h-10 flex-shrink-0 rounded flex items-center justify-center transition-colors ${isDarkMode ? 'bg-yellow-900/10 text-yellow-600 hover:text-yellow-400' : 'bg-yellow-100 text-yellow-800 hover:bg-yellow-200'}`}
              title={uploadTitle}
            >
              <Paperclip size={18} />
            </button>

            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={sendPlaceholder}
              className={`w-full px-3 h-10 rounded outline-none font-mono text-[16px] md:text-sm leading-normal transition-all focus:ring-1 focus:ring-yellow-600/50 ${inputBoxBg}`}
            />
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={onSend}
              disabled={(!inputValue.trim() && !selectedImage) || isThinking}
              className={`w-10 h-10 flex-shrink-0 rounded flex items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${isDarkMode ? 'bg-yellow-900/20 text-yellow-500 hover:bg-yellow-900/40 hover:text-yellow-400' : 'bg-[#b8860b] text-white hover:bg-[#9a7009]'}`}
            >
              <Send size={18} />
            </button>
          </div>

          <div className="hidden md:block text-right mt-1">
            <span className={`text-[10px] font-mono ${isDarkMode ? 'text-yellow-600/60' : 'text-gray-400'}`}>{statusText}</span>
          </div>
        </div>
      )}

    </>
  );
};
