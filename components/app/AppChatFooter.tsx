import React from 'react';
import { Paperclip, Quote, Send, Trash2, Undo2, X } from 'lucide-react';
import { useAppStore } from '../../store';

interface AppChatFooterProps {
  inputAreaBg: string;
  inputShadow: string;
  inputBoxBg: string;
  selectedLabel: string;
  deleteLabel: string;
  replyingToLabel: string;
  roleModelLabel: string;
  roleUserLabel: string;
  recallGlobalTooltip: string;
  typingLabel: string;
  uploadTitle: string;
  sendPlaceholder: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onImageSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSend: () => void;
  onOpenImagePicker: () => void;
  onRecallPending: () => void;
  onDeleteSelected: () => void;
}

export const AppChatFooter: React.FC<AppChatFooterProps> = ({
  inputAreaBg,
  inputShadow,
  inputBoxBg,
  selectedLabel,
  deleteLabel,
  replyingToLabel,
  roleModelLabel,
  roleUserLabel,
  recallGlobalTooltip,
  typingLabel,
  uploadTitle,
  sendPlaceholder,
  inputRef,
  fileInputRef,
  onKeyDown,
  onImageSelect,
  onSend,
  onOpenImagePicker,
  onRecallPending,
  onDeleteSelected
}) => {
  const isDarkMode = useAppStore(s => s.isDarkMode);
  const isSelectionMode = useAppStore(s => s.isSelectionMode);
  const selectedIds = useAppStore(s => s.selectedIds);
  const selectedImage = useAppStore(s => s.selectedImage);
  const replyingToMsg = useAppStore(s => s.replyingToMsg);
  const isListening = useAppStore(s => s.isListening);
  const isThinking = useAppStore(s => s.isThinking);
  const inputValue = useAppStore(s => s.inputValue);
  const statusText = useAppStore(s => s.statusText);
  const setInputValue = useAppStore(s => s.setInputValue);
  const setSelectedImage = useAppStore(s => s.setSelectedImage);
  const setReplyingToMsg = useAppStore(s => s.setReplyingToMsg);

  const selectedIdsCount = selectedIds.size;
  return (
    <>
      {selectedImage && (
        <div className={`px-4 pt-2 flex items-center ${isDarkMode ? 'bg-[#141414]/80' : 'bg-gray-100/80'}`}>
          <div className="relative group">
            <img src={selectedImage} alt="Preview" className="h-16 w-16 object-cover rounded border border-yellow-600/50" />
            <button onClick={() => setSelectedImage(null)} className="absolute -top-2 -right-2 bg-red-900/80 text-white rounded-full p-0.5 hover:bg-red-700 transition-colors">
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {isSelectionMode ? (
        <div className={`pt-2.5 pb-[max(0.625rem,var(--sab))] md:pb-[calc(0.625rem+var(--sab,0px))] px-4 border-t flex items-center justify-between gap-3 ${isDarkMode ? 'bg-[#1a1410] border-[#4f3926]/60' : 'bg-[#faf6f0] border-[#e8ddcf]'}`}>
          <div className="flex items-center gap-2.5 min-w-0">
            <span className={`inline-flex items-center justify-center h-7 min-w-[1.75rem] px-2 rounded-full text-xs font-bold tabular-nums ${selectedIdsCount > 0 ? (isDarkMode ? 'bg-red-500/20 text-red-400' : 'bg-red-100 text-red-600') : (isDarkMode ? 'bg-white/8 text-gray-500' : 'bg-black/5 text-gray-400')}`}>
              {selectedIdsCount}
            </span>
            <span className={`ka-label truncate ${isDarkMode ? 'text-[#d8b98b]/80' : 'text-[#9d7230]/80'}`}>{selectedLabel}</span>
          </div>
          <button
            onClick={onDeleteSelected}
            disabled={selectedIdsCount === 0}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-lg ka-label font-semibold transition-all disabled:opacity-30 disabled:cursor-not-allowed ${isDarkMode ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/20' : 'bg-red-50 text-red-600 hover:bg-red-100 border border-red-200'}`}
          >
            <Trash2 size={14} /> {deleteLabel}
          </button>
        </div>
      ) : (
        <>
        {isThinking && (
          <div className={`pl-3 py-0.5 text-xs font-mono ${isDarkMode ? 'text-yellow-600/50' : 'text-yellow-700/50'}`}>
            <span className="animate-pulse">{typingLabel}</span>
          </div>
        )}
        <div className={`pt-2 px-3 border-t transition-colors duration-200 md:duration-500 pb-[var(--sab)] md:pb-[calc(0.5rem+var(--sab,0px))] ${inputAreaBg} ${inputShadow}`}>
          {replyingToMsg && (
            <div className={`flex items-center justify-between mb-2 p-2 rounded-lg ka-copy-sm border-l-2 ${isDarkMode ? 'bg-white/5 border-yellow-500 text-gray-300' : 'bg-black/5 border-yellow-600 text-gray-700'} animate-in slide-in-from-bottom-2`}>
              <div className="flex flex-col overflow-hidden">
                <span className="font-bold flex items-center gap-1 opacity-70">
                  <Quote size={10} /> {replyingToLabel}: {replyingToMsg.role === 'model' ? roleModelLabel : roleUserLabel}
                </span>
                <span className="truncate opacity-90 italic">"{replyingToMsg.text}"</span>
              </div>
              <button onClick={() => setReplyingToMsg(null)} className="p-1 rounded-full hover:bg-red-500/20 hover:text-red-500 transition-colors">
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
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={sendPlaceholder}
              className={`w-full px-3 h-10 rounded outline-none ka-input-copy transition-all focus:ring-1 focus:ring-yellow-600/50 ${inputBoxBg}`}
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

          {/* Phase 7 Part t6_main_shell: statusText is shown on every
              viewport now. On desktop it always rendered here (pre-Phase
              7) AND on the AvatarPanel top-left. Mobile's chat side bar
              is full-width so the AvatarPanel copy is covered — we
              therefore keep the footer copy visible on phones too, but
              truncate to a single line so the composer height is stable. */}
          <div className="text-right mt-0.5 md:mt-1 overflow-hidden">
            <span
              className={`ka-micro block truncate ${isDarkMode ? 'text-yellow-600/60' : 'text-gray-400'}`}
              title={statusText}
            >
              {statusText}
            </span>
          </div>
        </div>
        </>
      )}

    </>
  );
};
