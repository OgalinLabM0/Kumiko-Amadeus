
// ... existing imports ...
import React, { memo, useState } from 'react';
import { Message, Language } from '../types';
import { Circle, CheckCircle, Undo2, Reply, Quote, Link as LinkIcon, ImageOff } from 'lucide-react';
import { UI_TRANSLATIONS } from '../constants';
import { VoiceBubble } from './VoiceBubble';

interface ChatBubbleProps {
  message: Message;
  isDarkMode?: boolean;
  isSelectionMode?: boolean;
  isSelected?: boolean;
  onSelect?: () => void;
  language?: Language;
  isPending?: boolean;
  onRecall?: (id: string) => void;
  onReply?: (msg: Message) => void;
  isHighlighted?: boolean;
  onImageClick?: (src: string) => void; 
  onRegenerateVoice?: (msg: Message) => void;
  isRegeneratingVoice?: boolean;
}

// WRAP IN MEMO TO PREVENT RE-RENDERS ON INPUT CHANGE
export const ChatBubble: React.FC<ChatBubbleProps> = memo(({ 
  message, 
  isDarkMode = true,
  isSelectionMode = false,
  isSelected = false,
  onSelect,
  language = 'zh',
  isPending = false,
  onRecall,
  onReply,
  isHighlighted = false,
  onImageClick,
  onRegenerateVoice,
  isRegeneratingVoice = false
}) => {
  const isUser = message.role === 'user';
  const t = UI_TRANSLATIONS[language];
  const [imgError, setImgError] = useState(false);

  // SAFETY CHECK
  if (!isUser && (message.text.startsWith('[[System_Log:') || message.text.startsWith('(System_Log:'))) {
     return null; 
  }

  if (!isUser && (message.id.startsWith('recall-') || /撤回了一条消息|recalled a message/i.test(message.text))) {
    const cleanText = message.text.replace(/[【】\[\]]/g, '');
    return (
      <div className="flex justify-center py-1.5">
        <span className={`text-[11px] ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
          {cleanText}
        </span>
      </div>
    );
  }

  // Format Time
  const formatTime = (ts: number) => {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  // Helper to convert URLs in text to clickable links with cleanup logic
  const renderTextWithLinks = (text: string) => {
    if (!text) return null;
    const sanitizedText = text.replace(/\$/g, ' ');
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    
    const parts = sanitizedText.split(urlRegex);
    
    return parts.map((part, i) => {
      if (part.match(urlRegex)) {
        let cleanUrl = part;
        let suffix = '';
        const trailingChars = [']', ')', '}', '.', ',', '!', '?', '。', '，', '！', '？'];

        while (cleanUrl.length > 0 && trailingChars.includes(cleanUrl.slice(-1))) {
            const char = cleanUrl.slice(-1);
            cleanUrl = cleanUrl.slice(0, -1);
            suffix = char + suffix;
        }

        let displayText = cleanUrl;
        const isGoogleGrounding = cleanUrl.includes('google.com/grounding') || cleanUrl.includes('vertexaisearch');

        if (isGoogleGrounding) {
            displayText = language === 'zh' ? '搜索来源' : 'Source Link';
        } else if (cleanUrl.length > 35) {
            displayText = cleanUrl.substring(0, 25) + '...';
        }

        return (
          <React.Fragment key={i}>
            <a 
              href={cleanUrl} 
              target="_blank" 
              rel="noopener noreferrer" 
              className={`
                inline-flex items-center gap-1 mx-1
                underline underline-offset-4 decoration-dotted 
                transition-colors duration-200
                ${isDarkMode 
                  ? 'text-yellow-500 hover:text-yellow-300 decoration-yellow-500/50' 
                  : 'text-blue-600 hover:text-blue-800 decoration-blue-400/50'}
              `}
              title={cleanUrl}
              onClick={(e) => e.stopPropagation()}
            >
              {isGoogleGrounding && <LinkIcon size={12} />}
              {displayText}
            </a>
            {suffix}
          </React.Fragment>
        );
      }
      return <span key={i}>{part}</span>;
    });
  };

  // Dynamic classes
  // PERFORMANCE OPTIMIZATION (IOS SPECIFIC):
  // Removed backdrop-blur on mobile, only applying it on md+ screens.
  // Increased base opacity on mobile to compensate for readability.
  let bubbleClasses = "";
  if (isUser) {
    if (isDarkMode) {
      bubbleClasses = "bg-yellow-900/60 md:bg-yellow-900/40 md:backdrop-blur-[1px] border-yellow-600/50 text-yellow-100";
    } else {
      bubbleClasses = "bg-yellow-100/80 md:bg-yellow-100/60 md:backdrop-blur-[1px] border-yellow-400/50 text-yellow-900";
    }
    bubbleClasses += " rounded-tr-none";
  } else {
    if (isDarkMode) {
      bubbleClasses = "bg-gray-800/60 md:bg-gray-800/40 md:backdrop-blur-[1px] border-gray-600/50 text-white";
    } else {
      // Light Mode Model Bubble: 70% white on mobile, 50% on desktop
      bubbleClasses = "bg-white/70 md:bg-white/50 md:backdrop-blur-[1px] border-gray-200/50 text-gray-800 shadow-sm";
    }
    bubbleClasses += " rounded-tl-none";
  }

  const imageBorderClass = isUser 
    ? (isDarkMode ? 'border-yellow-600/50' : 'border-yellow-400/50')
    : (isDarkMode ? 'border-gray-600/50' : 'border-gray-300');

  const quoteBgClass = isDarkMode ? 'bg-black/20 border-white/10' : 'bg-black/5 border-black/5';

  const highlightClass = isHighlighted 
    ? (isDarkMode ? 'ring-2 ring-yellow-400 shadow-[0_0_20px_rgba(250,204,21,0.5)]' : 'ring-2 ring-yellow-500 shadow-[0_0_20px_rgba(234,179,8,0.5)]') 
    : '';

  // --- DYNAMIC GREETING LOCALIZATION ---
  let displayContent = message.text;
  if (message.id === 'greeting-1') {
      displayContent = language === 'zh' ? '嗯？怎么了？' : 'Hm? What is it?';
  } else if (message.id === 'greeting-2') {
      displayContent = language === 'zh' ? '突然联系我干啥' : 'Why call me all of a sudden?';
  }

  return (
    <div 
      id={`message-${message.id}`}
      className={`flex w-full mb-3 group ${isSelectionMode ? 'cursor-pointer hover:bg-black/5' : ''}`}
      onClick={isSelectionMode ? onSelect : undefined}
    >
      {/* Selection Checkbox */}
      {isSelectionMode && (
        <div className={`flex items-center justify-center mr-3 pl-2 transition-all duration-200 ${isSelected ? (isDarkMode ? 'text-yellow-500' : 'text-[#b8860b]') : 'text-gray-400 opacity-50'}`}>
          {isSelected ? <CheckCircle size={20} fill={isDarkMode ? "#333" : "#fff"} /> : <Circle size={20} />}
        </div>
      )}

      {/* Main Container */}
      <div className={`flex flex-1 ${isUser ? 'justify-end items-end' : 'justify-start items-end'} gap-2`}>
        
        {/* === USER MESSAGE LAYOUT === */}
        {isUser && (
          <>
             {/* Meta Data Column */}
             <div className="flex flex-col items-end justify-end gap-1 min-w-[60px] flex-shrink-0 pb-1">
                {/* Actions */}
                {!isSelectionMode && (
                  <div className="flex flex-col gap-1 items-end">
                    {isPending && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onRecall && onRecall(message.id);
                        }}
                        className={`
                          flex items-center gap-1 px-2 py-1 rounded-full 
                          ka-micro font-bold transition-all duration-300 
                          hover:scale-105 shadow-sm
                          animate-in fade-in slide-in-from-right-2
                          ${isDarkMode ? 'bg-red-900/40 text-red-400 hover:bg-red-900/80' : 'bg-red-100 text-red-600 hover:bg-red-200'}
                        `}
                        title={t.recallMsgTooltip}
                      >
                        <Undo2 size={12} /> {t.recall}
                      </button>
                    )}
                    
                    <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onReply && onReply(message);
                          }}
                          className={`
                            p-1.5 rounded-full transition-all duration-200
                            ${isDarkMode ? 'text-gray-500 hover:text-yellow-500 hover:bg-white/10' : 'text-gray-400 hover:text-yellow-600 hover:bg-black/5'}
                          `}
                          title={t.reply}
                        >
                          <Reply size={14} />
                        </button>
                    </div>
                  </div>
                )}

                {/* Status Line - UPDATED COLOR FOR DARK MODE (gray-500 -> gray-300) */}
                <div className={`flex flex-col items-end ka-micro leading-tight ${isDarkMode ? 'text-gray-300' : 'text-gray-400'}`}>
                   <span className={isPending ? (isDarkMode ? 'text-yellow-500/80' : 'text-yellow-700/80') : ''}>
                      {isPending ? t.unread : (message.isRead ? t.read : t.unread)}
                   </span>
                   <span className="opacity-70">{formatTime(message.timestamp)}</span>
                </div>
             </div>

             {/* The Bubble */}
             <div className="flex flex-col items-end max-w-[85%] md:max-w-[75%]">
                {message.image && (
                  <div className={`mb-1 w-full rounded-lg overflow-hidden border ${imageBorderClass} cursor-pointer hover:opacity-90 transition-opacity bg-black/10`}>
                    {!imgError ? (
                        <img 
                            src={message.image} 
                            alt="uploaded" 
                            className="w-full h-auto object-cover" 
                            onClick={(e) => {
                                e.stopPropagation();
                                onImageClick && onImageClick(message.image!);
                            }}
                            onError={() => setImgError(true)}
                        />
                    ) : (
                        <div className="flex flex-col items-center justify-center py-4 text-gray-500">
                            <ImageOff size={24} />
                            <span className="ka-micro mt-1">Image Load Failed</span>
                        </div>
                    )}
                  </div>
                )}
                <div
                  className={`
                    relative w-fit px-4 py-2 rounded-lg border 
                    transition-all duration-500
                    ${bubbleClasses} 
                    ${isSelectionMode && isSelected ? 'ring-2 ring-offset-1 ring-yellow-500/50' : ''}
                    ${isPending ? 'border-dashed opacity-90' : ''} 
                    ${highlightClass}
                  `}
                >
                  {/* QUOTE RENDER */}
                  {message.quote && (
                    <div className={`mb-2 p-2 rounded ka-copy-sm border-l-2 ${isDarkMode ? 'border-yellow-600/50' : 'border-yellow-500/50'} ${quoteBgClass}`}>
                       <div className="flex items-center gap-1 opacity-70 mb-0.5">
                          <Quote size={10} />
                          <span className="font-bold">{message.quote.role === 'model' ? 'Kumiko' : 'You'}</span>
                       </div>
                       <p className="opacity-80 line-clamp-2 italic">{message.quote.text}</p>
                    </div>
                  )}

                  <p className="ka-chat-copy whitespace-pre-wrap break-words">
                    {renderTextWithLinks(displayContent)}
                  </p>
                </div>
             </div>
          </>
        )}

        {/* === MODEL MESSAGE LAYOUT === */}
        {!isUser && (
          <>
             {/* The Bubble */}
             {message.isVoiceMessage ? (
               <VoiceBubble 
                 messageId={message.id}
                 text={displayContent}
                 voiceFileId={message.voiceFileId}
                 voiceDuration={message.voiceDuration}
                 isDarkMode={isDarkMode}
                 language={language}
                 onRegenerate={onRegenerateVoice ? () => onRegenerateVoice(message) : undefined}
                 isRegenerating={isRegeneratingVoice}
               />
             ) : (
             <div className="flex flex-col items-start max-w-[90%] md:max-w-[75%]">
                <div
                  className={`
                    relative w-fit px-4 py-2 rounded-lg border 
                    transition-all duration-500
                    ${bubbleClasses} 
                    ${isSelectionMode && isSelected ? 'ring-2 ring-offset-1 ring-yellow-500/50' : ''}
                    ${highlightClass}
                  `}
                >
                  {/* QUOTE RENDER */}
                  {message.quote && (
                    <div className={`mb-2 p-2 rounded ka-copy-sm border-l-2 ${isDarkMode ? 'border-gray-500/50' : 'border-gray-400/50'} ${quoteBgClass}`}>
                       <div className="flex items-center gap-1 opacity-70 mb-0.5">
                          <Quote size={10} />
                          <span className="font-bold">
                             User
                          </span>
                       </div>
                       <p className="opacity-80 line-clamp-2 italic">{message.quote.text}</p>
                    </div>
                  )}

                  <p className="ka-chat-copy whitespace-pre-wrap break-words">
                    {renderTextWithLinks(displayContent)}
                  </p>
                </div>
             </div>
             )}

             {/* Right Meta Column - UPDATED COLOR FOR DARK MODE (gray-500 -> gray-300) */}
             <div className={`flex flex-col justify-end items-start gap-1 pb-1 min-w-[40px] ka-micro opacity-50 ${isDarkMode ? 'text-gray-300' : 'text-gray-400'}`}>
                {!isSelectionMode && (
                    <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200 mb-1">
                        <button
                            onClick={(e) => {
                            e.stopPropagation();
                            onReply && onReply(message);
                            }}
                            className={`
                            p-1.5 rounded-full transition-all duration-200
                            ${isDarkMode ? 'hover:text-yellow-500 hover:bg-white/10' : 'hover:text-yellow-600 hover:bg-black/5'}
                            `}
                            title={t.reply}
                        >
                            <Reply size={14} />
                        </button>
                    </div>
                )}
                <span>{formatTime(message.timestamp)}</span>
             </div>
          </>
        )}

      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  // Custom comparison function for performance
  return (
    prevProps.message.id === nextProps.message.id &&
    prevProps.message.text === nextProps.message.text && // Check if text changed (edit)
    prevProps.message.image === nextProps.message.image && // CRITICAL: Check if image URL changed
    prevProps.message.isRead === nextProps.message.isRead && // Check if read status changed
    prevProps.message.isHidden === nextProps.message.isHidden &&
    prevProps.message.isPinned === nextProps.message.isPinned &&
    prevProps.message.isVoiceMessage === nextProps.message.isVoiceMessage &&
    prevProps.message.voiceFileId === nextProps.message.voiceFileId &&
    prevProps.isDarkMode === nextProps.isDarkMode &&
    prevProps.isSelectionMode === nextProps.isSelectionMode &&
    prevProps.isSelected === nextProps.isSelected &&
    prevProps.isPending === nextProps.isPending &&
    prevProps.isHighlighted === nextProps.isHighlighted &&
    prevProps.language === nextProps.language
  );
});
