import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ChatBubble } from '../ChatBubble';
import { Language, Message } from '../../types';

const OVERSCAN_PX = 420;
const MIN_ESTIMATED_HEIGHT = 84;
const MAX_ESTIMATED_HEIGHT = 460;

interface AppMessageListProps {
  messages: Message[];
  isDarkMode: boolean;
  isSelectionMode: boolean;
  selectedIds: Set<string>;
  pendingMessageIds: Set<string>;
  language: Language;
  highlightedMessageId: string | null;
  isListening: boolean;
  isThinking: boolean;
  timeLeft: number;
  listeningLabel: string;
  typingLabel: string;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  onBackgroundClick: () => void;
  onSelectMessage: (id: string) => void;
  onRecall: (id: string) => void;
  onReply: (message: Message) => void;
  onImageClick: (src: string) => void;
  onRegenerateVoice?: (message: Message) => void;
  regeneratingVoiceIds?: Set<string>;
  onResend?: (id: string) => void;
  onWithdraw?: (id: string) => void;
}

interface VirtualizedMessageRowProps {
  index: number;
  message: Message;
  top: number;
  onMeasured: (index: number, id: string, height: number) => void;
  children: React.ReactNode;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const estimateMessageHeight = (message: Message): number => {
  const text = String(message.text || '');
  const normalizedLength = text.replace(/\s+/g, '').length;
  const estimatedLines = Math.max(1, Math.ceil(normalizedLength / 18));
  const quoteHeight = message.quote ? 58 : 0;
  const imageHeight = message.image ? 220 : 0;
  const metaHeight = message.role === 'user' ? 16 : 10;
  const estimated = 46 + (estimatedLines * 24) + quoteHeight + imageHeight + metaHeight;
  return clamp(estimated, MIN_ESTIMATED_HEIGHT, MAX_ESTIMATED_HEIGHT);
};

const findClosestItemIndex = (offsets: number[], targetOffset: number) => {
  let low = 0;
  let high = offsets.length - 1;

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (offsets[mid] <= targetOffset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return low;
};

const VirtualizedMessageRow: React.FC<VirtualizedMessageRowProps> = ({
  index,
  message,
  top,
  onMeasured,
  children,
}) => {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const element = rowRef.current;
    if (!element) return;

    const reportHeight = () => {
      const nextHeight = Math.ceil(element.getBoundingClientRect().height);
      if (nextHeight > 0) {
        onMeasured(index, message.id, nextHeight);
      }
    };

    reportHeight();

    if (typeof ResizeObserver !== 'function') return;

    let rafId = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (document.documentElement.hasAttribute('data-resizing')) return;
        reportHeight();
      });
    });
    observer.observe(element);
    return () => { cancelAnimationFrame(rafId); observer.disconnect(); };
  }, [index, message.id, onMeasured]);

  return (
    <div
      ref={rowRef}
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        transform: `translate3d(0, ${top}px, 0)`,
        willChange: 'transform',
      }}
    >
      {children}
    </div>
  );
};

export const AppMessageList: React.FC<AppMessageListProps> = ({
  messages,
  isDarkMode,
  isSelectionMode,
  selectedIds,
  pendingMessageIds,
  language,
  highlightedMessageId,
  isListening,
  isThinking,
  timeLeft,
  listeningLabel,
  typingLabel,
  messagesEndRef,
  onBackgroundClick,
  onSelectMessage,
  onRecall,
  onReply,
  onImageClick,
  onRegenerateVoice,
  regeneratingVoiceIds,
  onResend,
  onWithdraw
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sizeCacheRef = useRef<Map<string, number>>(new Map());
  const scrollRafRef = useRef<number | null>(null);
  const pendingScrollTopRef = useRef(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [layoutVersion, setLayoutVersion] = useState(0);

  const visibleMessages = useMemo(
    () => messages.filter((msg) => !msg.isHidden),
    [messages]
  );

  const itemHeights = useMemo(
    () => visibleMessages.map((message) => sizeCacheRef.current.get(message.id) ?? estimateMessageHeight(message)),
    [visibleMessages, layoutVersion]
  );

  const itemOffsets = useMemo(() => {
    const offsets = new Array<number>(itemHeights.length + 1);
    offsets[0] = 0;
    for (let index = 0; index < itemHeights.length; index += 1) {
      offsets[index + 1] = offsets[index] + itemHeights[index];
    }
    return offsets;
  }, [itemHeights]);

  const totalContentHeight = itemOffsets[itemOffsets.length - 1] || 0;

  const { startIndex, endIndex } = useMemo(() => {
    if (visibleMessages.length === 0) {
      return { startIndex: 0, endIndex: -1 };
    }

    const overscannedTop = Math.max(0, scrollTop - OVERSCAN_PX);
    const overscannedBottom = scrollTop + viewportHeight + OVERSCAN_PX;
    const nextStartIndex = clamp(findClosestItemIndex(itemOffsets, overscannedTop), 0, visibleMessages.length - 1);
    const nextEndIndex = clamp(findClosestItemIndex(itemOffsets, overscannedBottom), nextStartIndex, visibleMessages.length - 1);

    return {
      startIndex: nextStartIndex,
      endIndex: nextEndIndex,
    };
  }, [itemOffsets, scrollTop, viewportHeight, visibleMessages.length]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const syncViewport = () => {
      const nextHeight = container.clientHeight;
      const nextTop = container.scrollTop;
      setViewportHeight((current) => current === nextHeight ? current : nextHeight);
      setScrollTop((current) => current === nextTop ? current : nextTop);
    };

    syncViewport();

    if (typeof ResizeObserver === 'function') {
      let rafId = 0;
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          if (document.documentElement.hasAttribute('data-resizing')) return;
          syncViewport();
        });
      });
      observer.observe(container);
      return () => { cancelAnimationFrame(rafId); observer.disconnect(); };
    }
  }, []);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    pendingScrollTopRef.current = event.currentTarget.scrollTop;
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      setScrollTop((current) => (
        current === pendingScrollTopRef.current ? current : pendingScrollTopRef.current
      ));
    });
  }, []);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  const handleMeasured = useCallback((index: number, id: string, height: number) => {
    const previousHeight = sizeCacheRef.current.get(id);
    if (previousHeight === height) return;

    sizeCacheRef.current.set(id, height);
    setLayoutVersion((current) => current + 1);

    if (!containerRef.current || previousHeight === undefined || index >= startIndex) return;

    const delta = height - previousHeight;
    if (delta !== 0) {
      containerRef.current.scrollTop += delta;
    }
  }, [startIndex]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !highlightedMessageId) return;

    const targetIndex = visibleMessages.findIndex(message => message.id === highlightedMessageId);
    if (targetIndex === -1) return;

    const targetTop = itemOffsets[targetIndex] || 0;
    const desiredTop = Math.max(0, targetTop - Math.max(120, viewportHeight * 0.35));
    container.scrollTo({ top: desiredTop, behavior: 'smooth' });

    const rafId = window.requestAnimationFrame(() => {
      const targetElement = document.getElementById(`message-${highlightedMessageId}`);
      if (targetElement) {
        targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [highlightedMessageId, itemOffsets, viewportHeight, visibleMessages]);

  const renderedSlice = endIndex >= startIndex
    ? visibleMessages.slice(startIndex, endIndex + 1)
    : [];

  return (
    <div
      ref={containerRef}
      data-resize-heavy
      className="flex-1 overflow-y-auto p-4 md:p-6 no-scrollbar touch-scroll"
      onClick={onBackgroundClick}
      onScroll={handleScroll}
    >
      <div style={{ position: 'relative', height: totalContentHeight }}>
        {renderedSlice.map((message, localIndex) => {
          const absoluteIndex = startIndex + localIndex;
          return (
            <VirtualizedMessageRow
              key={message.id}
              index={absoluteIndex}
              message={message}
              top={itemOffsets[absoluteIndex] || 0}
              onMeasured={handleMeasured}
            >
              <ChatBubble
                message={message}
                isDarkMode={isDarkMode}
                isSelectionMode={isSelectionMode}
                isSelected={selectedIds.has(message.id)}
                onSelect={() => onSelectMessage(message.id)}
                language={language}
                isPending={pendingMessageIds.has(message.id)}
                onRecall={onRecall}
                onReply={onReply}
                isHighlighted={highlightedMessageId === message.id}
                onImageClick={onImageClick}
                onRegenerateVoice={onRegenerateVoice}
                isRegeneratingVoice={regeneratingVoiceIds?.has(message.id)}
                onResend={onResend}
                onWithdraw={onWithdraw}
              />
            </VirtualizedMessageRow>
          );
        })}
      </div>
      <div className="flex flex-col gap-2 items-end mr-3 mt-2">
        {isListening && (
          <div className={`flex items-center gap-2 text-xs font-mono animate-pulse ${isDarkMode ? 'text-yellow-600/70' : 'text-yellow-700'}`}>
            <Loader2 size={12} className="animate-spin" />
            <span>{listeningLabel} {timeLeft}s...</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
};
