
import React, { memo, useState, useRef, useEffect } from 'react';
import { Message, Language } from '../types';
import { Circle, CheckCircle, Undo2, Reply, Quote, Link as LinkIcon, ImageOff, AlertCircle, RotateCcw, PenLine } from 'lucide-react';
import { UI_TRANSLATIONS } from '../constants';
import { VoiceBubble } from './VoiceBubble';
import { useMessageImage } from './app/useMessageImage';
import { useLongPress } from '../hooks/useLongPress';

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
  onResend?: (id: string) => void | Promise<void>;
  onWithdraw?: (id: string) => void;
  onLongPress?: (msg: Message) => void;
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
  isRegeneratingVoice = false,
  onResend,
  onWithdraw,
  onLongPress
}) => {
  // CRITICAL: Compute early-return conditions BEFORE calling any hooks.
  // If hooks were placed before these early returns, a message transitioning
  // between "system log" and "normal" states (or recall pill / normal bubble)
  // would change the number of hooks rendered per turn and trip
  // React's "Rendered fewer hooks than expected" check, crashing the whole list.
  const isUser = message.role === 'user';
  const messageText = typeof message.text === 'string' ? message.text : String(message.text ?? '');
  const isSystemLog = !isUser && (messageText.startsWith('[[System_Log:') || messageText.startsWith('(System_Log:'));
  const isRecallLine = !isUser && (message.id.startsWith('recall-') || /撤回了一条消息|recalled a message/i.test(messageText));

  if (isSystemLog) {
    return null;
  }
  if (isRecallLine) {
    const cleanText = messageText.replace(/[【】\[\]]/g, '');
    return (
      <div className="flex justify-center py-1.5">
        <span className={`text-[11px] ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
          {cleanText}
        </span>
      </div>
    );
  }

  // Hooks below are only reached for normal bubbles, so they always run the same
  // number of times for a given component instance.
  const t = UI_TRANSLATIONS[language];
  const [imgError, setImgError] = useState(false);
  const [showFailPopover, setShowFailPopover] = useState(false);
  const [popoverDir, setPopoverDir] = useState<'up' | 'down'>('up');
  // v2.14.23: per-action busy flags. The Resend handler is async (it
  // awaits validateAIConnection + getImageBase64), and Withdraw schedules
  // a focus on the next frame. If the user double-taps either button -
  // common on slow networks because the popover stays open until they
  // pick - we used to fire two resends/two withdraws back-to-back. We
  // now disable the button while its handler is in flight, and make the
  // popover dismiss only after the handler resolves.
  const [resendBusy, setResendBusy] = useState(false);
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const failPopoverRef = useRef<HTMLDivElement>(null);
  const failBtnRef = useRef<HTMLButtonElement>(null);
  // Single source of truth for the message image URL. Desktop returns
  // `kumiko-image://<id>` synchronously with no first-paint flicker; web
  // resolves the imageId via an async Dexie read inside the hook.
  const displayUrl = useMessageImage(message);

  useEffect(() => {
    if (!showFailPopover) return;
    const handler = (e: MouseEvent) => {
      if (failPopoverRef.current && !failPopoverRef.current.contains(e.target as Node)) {
        setShowFailPopover(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showFailPopover]);

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

  const displayContent = messageText;
  const isFailed = isUser && message.sendStatus === 'failed';
  const isSending = isUser && message.sendStatus === 'sending';

  const longPressHandlers = useLongPress({
    threshold: 500,
    onLongPress: () => {
      if (isSelectionMode) return;
      onLongPress?.(message);
    },
  });

  return (
    <div 
      id={`message-${message.id}`}
      className={`flex w-full mb-3 group ${isSelectionMode ? 'cursor-pointer hover:bg-black/5' : ''}`}
      onClick={isSelectionMode ? onSelect : undefined}
      onTouchStart={isSelectionMode ? undefined : longPressHandlers.onTouchStart}
      onTouchMove={isSelectionMode ? undefined : longPressHandlers.onTouchMove}
      onTouchEnd={isSelectionMode ? undefined : longPressHandlers.onTouchEnd}
      onTouchCancel={isSelectionMode ? undefined : longPressHandlers.onTouchCancel}
      onContextMenu={isSelectionMode ? undefined : longPressHandlers.onContextMenu}
      style={{ WebkitTouchCallout: 'none' }}
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
                    
                    {/* Phase 7 Part t10_chat_voice: give the reply icon
                        a 32×32 hit target on phones (Apple HIG = 44pt,
                        this is a compromise to stay within the existing
                        meta column), plus an `active:scale-95` for
                        tactile feedback. Desktop keeps the `p-1.5`
                        (~28px) footprint. */}
                    <div className="flex gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-200">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onReply && onReply(message);
                          }}
                          className={`
                            p-1.5 rounded-full transition-all duration-200 active:scale-95 min-w-[32px] min-h-[32px] flex items-center justify-center
                            ${isDarkMode ? 'text-gray-500 hover:text-yellow-500 hover:bg-white/10' : 'text-gray-400 hover:text-yellow-600 hover:bg-black/5'}
                          `}
                          title={t.reply}
                        >
                          <Reply size={14} />
                        </button>
                    </div>
                  </div>
                )}

                {/* Failed / Sending indicator */}
                {isFailed && (
                  <div className="relative" ref={failPopoverRef}>
                    <button
                      ref={failBtnRef}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (failBtnRef.current) {
                          const rect = failBtnRef.current.getBoundingClientRect();
                          setPopoverDir(window.innerHeight - rect.bottom >= 100 ? 'down' : 'up');
                        }
                        setShowFailPopover(prev => !prev);
                      }}
                      className="p-0.5 animate-pulse"
                      title={message.failReason || (language === 'zh' ? '发送失败' : 'Send failed')}
                    >
                      <AlertCircle size={20} className="text-red-500 drop-shadow-sm" />
                    </button>
                    {showFailPopover && (
                      <div className={`
                        absolute right-0 w-36 rounded-lg border shadow-xl z-50 overflow-hidden
                        ${popoverDir === 'down' ? 'top-full mt-1.5' : 'bottom-full mb-1.5'}
                        ${isDarkMode ? 'bg-gray-900/95 border-gray-700 backdrop-blur-md' : 'bg-white/95 border-gray-200 backdrop-blur-md shadow-lg'}
                      `}>
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (resendBusy || withdrawBusy) return;
                            setResendBusy(true);
                            try {
                              await onResend?.(message.id);
                            } finally {
                              setResendBusy(false);
                              setShowFailPopover(false);
                            }
                          }}
                          disabled={resendBusy || withdrawBusy}
                          aria-busy={resendBusy}
                          className={`flex items-center gap-2 w-full px-3 py-2.5 ka-copy-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-wait
                            ${isDarkMode ? 'text-gray-200 hover:bg-white/10' : 'text-gray-700 hover:bg-gray-50'}`}
                        >
                          <RotateCcw size={13} className={resendBusy ? 'animate-spin' : ''} />
                          {resendBusy
                            ? (language === 'zh' ? '正在重发…' : 'Resending…')
                            : (language === 'zh' ? '重新发送' : 'Resend')}
                        </button>
                        <div className={`h-px ${isDarkMode ? 'bg-gray-700/50' : 'bg-gray-200'}`} />
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (resendBusy || withdrawBusy) return;
                            setWithdrawBusy(true);
                            try {
                              onWithdraw?.(message.id);
                            } finally {
                              setShowFailPopover(false);
                              // Withdraw is synchronous on the JS side
                              // but schedules a focus on the next tick;
                              // release the busy flag after a short
                              // delay so the button doesn't flicker.
                              setTimeout(() => setWithdrawBusy(false), 200);
                            }
                          }}
                          disabled={resendBusy || withdrawBusy}
                          aria-busy={withdrawBusy}
                          className={`flex items-center gap-2 w-full px-3 py-2.5 ka-copy-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-wait
                            ${isDarkMode ? 'text-gray-200 hover:bg-white/10' : 'text-gray-700 hover:bg-gray-50'}`}
                        >
                          <PenLine size={13} />
                          {language === 'zh' ? '撤回编辑' : 'Withdraw & Edit'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {/* Status Line */}
                <div className={`flex flex-col items-end ka-micro leading-tight ${isDarkMode ? 'text-gray-300' : 'text-gray-400'}`}>
                   {isFailed ? (
                     <span className="text-red-500 font-semibold">
                       {language === 'zh' ? '发送失败' : 'Failed'}
                     </span>
                   ) : isSending ? (
                     <span className="opacity-80">{t.sending}</span>
                   ) : isPending ? (
                     <span className="opacity-0">.</span>
                   ) : (
                     <span>{message.isRead ? t.read : t.unread}</span>
                   )}
                   <span className="opacity-70">{formatTime(message.timestamp)}</span>
                </div>
             </div>

             {/* The Bubble */}
             <div className="flex flex-col items-end max-w-[85%] md:max-w-[75%]">
                {displayUrl && (
                  <div className={`mb-1 w-full rounded-lg overflow-hidden border ${imageBorderClass} cursor-pointer hover:opacity-90 transition-opacity bg-black/10`}>
                    {!imgError ? (
                        <img 
                            src={displayUrl} 
                            alt="uploaded" 
                            className="w-full h-auto object-cover" 
                            onClick={(e) => {
                                e.stopPropagation();
                                onImageClick && onImageClick(displayUrl);
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
                    transition-colors duration-200 md:duration-500
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
                    transition-colors duration-200 md:duration-500
                    ${bubbleClasses} 
                    ${isSelectionMode && isSelected ? 'ring-2 ring-offset-1 ring-yellow-500/50' : ''}
                    ${highlightClass}
                  `}
                >
                  {/* QUOTE RENDER */}
                  {/* P1 #32: previously the label was hard-coded to "User" on model bubbles,
                      which was wrong whenever the model quoted its own earlier line (user saw
                      Kumiko's reply quoted under the heading "User"). Mirror the user-bubble
                      branch above — pick the label from quote.role. */}
                  {message.quote && (
                    <div className={`mb-2 p-2 rounded ka-copy-sm border-l-2 ${isDarkMode ? 'border-gray-500/50' : 'border-gray-400/50'} ${quoteBgClass}`}>
                       <div className="flex items-center gap-1 opacity-70 mb-0.5">
                          <Quote size={10} />
                          <span className="font-bold">
                             {message.quote.role === 'model' ? 'Kumiko' : (language === 'zh' ? '你' : 'You')}
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

             {/* Right Meta Column - UPDATED COLOR FOR DARK MODE (gray-500 -> gray-300)
                 Phase 7 Part t10_chat_voice: used to set `opacity-50`
                 on the whole column, which meant the `opacity-100`
                 override on the reply button still compounded to
                 ~0.5 on phones, rendering it nearly invisible.
                 We move the fade onto the timestamp span so the
                 button gets its full opacity. Desktop looks identical
                 (same cascade), the button still ghosts in via
                 `md:group-hover:opacity-100`. */}
             <div className={`flex flex-col justify-end items-start gap-1 pb-1 min-w-[40px] ka-micro ${isDarkMode ? 'text-gray-300' : 'text-gray-400'}`}>
                {!isSelectionMode && (
                    <div className="flex gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-200 mb-1">
                        <button
                            onClick={(e) => {
                            e.stopPropagation();
                            onReply && onReply(message);
                            }}
                            className={`
                            p-1.5 rounded-full transition-all duration-200 active:scale-95 min-w-[32px] min-h-[32px] flex items-center justify-center
                            ${isDarkMode ? 'hover:text-yellow-500 hover:bg-white/10' : 'hover:text-yellow-600 hover:bg-black/5'}
                            `}
                            title={t.reply}
                        >
                            <Reply size={14} />
                        </button>
                    </div>
                )}
                <span className="opacity-50">{formatTime(message.timestamp)}</span>
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
    prevProps.message.imageId === nextProps.message.imageId && // imageId drives displayUrl
    prevProps.message.isRead === nextProps.message.isRead && // Check if read status changed
    prevProps.message.isHidden === nextProps.message.isHidden &&
    prevProps.message.isPinned === nextProps.message.isPinned &&
    prevProps.message.isVoiceMessage === nextProps.message.isVoiceMessage &&
    prevProps.message.voiceFileId === nextProps.message.voiceFileId &&
    prevProps.message.sendStatus === nextProps.message.sendStatus &&
    prevProps.message.failReason === nextProps.message.failReason &&
    prevProps.isDarkMode === nextProps.isDarkMode &&
    prevProps.isSelectionMode === nextProps.isSelectionMode &&
    prevProps.isSelected === nextProps.isSelected &&
    prevProps.isPending === nextProps.isPending &&
    prevProps.isHighlighted === nextProps.isHighlighted &&
    prevProps.language === nextProps.language
  );
});
