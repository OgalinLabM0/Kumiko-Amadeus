import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ChatBubble } from '../ChatBubble';
import { Language, Message } from '../../types';
import { isMobileLikeRuntime } from '../../services/environment';

// Mobile perf: cache the mobile-runtime flag once at module load. Keeps
// the runtime check out of the per-frame scroll + resize hot paths.
// A.3: gates on `isMobileLikeRuntime()` (PWA + Capacitor) instead of
// PWA-only — Capacitor APK uses the same touch-screen UX optimisations
// (smaller cards, momentum scrolling tweaks) regardless of whether
// it's paired with a PC.
let _msgListIsMobile: boolean | null = null;
const msgListIsMobile = (): boolean => {
  if (_msgListIsMobile === null) {
    try { _msgListIsMobile = isMobileLikeRuntime(); } catch { _msgListIsMobile = false; }
  }
  return _msgListIsMobile;
};

// Mobile perf: shrink the off-screen render window on phones.
// Desktop keeps the original 420px overscan so fast mouse-wheel scrolls
// don't reveal the measurement gap. Phones flick-scroll more slowly so
// 240px is enough to cover the 1-frame-ahead needs, and halves the
// number of mounted <ChatBubble> instances at any given moment.
//
// Previously this was computed once at module load from `msgListIsMobile()`.
// That baked the answer from the *sync* runtime heuristic — if the async
// probe later upgraded the runtime to desktop-via-Fastify (or vice versa)
// the value stayed stale until the `kumiko:runtime-changed`-triggered
// reload in `index.tsx` kicked in. The reload normally fires, but we
// can't rely on it when this module is re-imported by HMR during
// development or by future code paths that hot-swap the chat panel. So
// OVERSCAN_PX is now derived inside the component via `useMemo` and
// listens to the runtime-changed event to refresh.
const OVERSCAN_PX_DESKTOP = 420;
const OVERSCAN_PX_MOBILE = 240;
const MIN_ESTIMATED_HEIGHT = 84;
const MAX_ESTIMATED_HEIGHT = 460;
const BOTTOM_CLEARANCE_DESKTOP = 72;
const BOTTOM_CLEARANCE_MOBILE = 72;

// Invalidate the cached flag used by the hot paths so the next
// `msgListIsMobile()` call re-reads `isMobileLikeRuntime()`. Invoked from
// the `kumiko:runtime-changed` listener.
const invalidateMsgListIsMobileCache = () => {
  _msgListIsMobile = null;
};

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
  onLongPress?: (message: Message) => void;
}

interface VirtualizedMessageRowProps {
  index: number;
  message: Message;
  top: number;
  onMeasured: (index: number, id: string, height: number) => void;
  children: React.ReactNode;
  // Passed down so the row's style memo invalidates when the async
  // runtime probe flips mobile/desktop mid-session. Previously the
  // memo only depended on `top`, so the `will-change: transform`
  // toggle was frozen to whatever `msgListIsMobile()` answered on the
  // first render.
  isMobileRuntime: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const estimateMessageHeight = (message: Message): number => {
  const text = String(message.text || '');
  const normalizedLength = text.replace(/\s+/g, '').length;
  const estimatedLines = Math.max(1, Math.ceil(normalizedLength / 18));
  const quoteHeight = message.quote ? 58 : 0;
  const imageHeight = message.imageId ? 220 : 0;
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

const parseCssPx = (value: string | null | undefined): number => {
  if (!value) return 0;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const readBottomClearancePx = (isMobileRuntime: boolean): number => {
  const base = isMobileRuntime ? BOTTOM_CLEARANCE_MOBILE : BOTTOM_CLEARANCE_DESKTOP;
  if (typeof window === 'undefined' || typeof document === 'undefined') return base;

  const rootStyle = window.getComputedStyle(document.documentElement);
  const safeAreaBottom = parseCssPx(rootStyle.getPropertyValue('--sab'));
  // AppMainView already uses --kb-inset to shrink the chat column above the
  // keyboard, so do not add any keyboard-derived gap here. This clearance is
  // only the tail room needed for the footer/status line and safe-area bottom.
  return Math.ceil(base + safeAreaBottom);
};

const VirtualizedMessageRow: React.FC<VirtualizedMessageRowProps> = ({
  index,
  message,
  top,
  onMeasured,
  children,
  isMobileRuntime,
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

  // Mobile perf: drop `will-change: transform` on phones. Promoting every
  // visible row to its own compositor layer is a net loss on iOS/Android
  // mid-range devices (layer explosion → VRAM pressure → slower scrolls).
  // Desktop keeps the hint because its compositor budget is much higher
  // and the scroll feel gains more from the layer promotion than it
  // loses from the memory cost.
  const rowStyle = useMemo<React.CSSProperties>(() => (
    isMobileRuntime
      ? {
        position: 'absolute',
        left: 0,
        right: 0,
        transform: `translate3d(0, ${top}px, 0)`,
      }
      : {
        position: 'absolute',
        left: 0,
        right: 0,
        transform: `translate3d(0, ${top}px, 0)`,
        willChange: 'transform',
      }
  ), [top, isMobileRuntime]);

  return (
    <div ref={rowRef} style={rowStyle}>
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
  onWithdraw,
  onLongPress
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sizeCacheRef = useRef<Map<string, number>>(new Map());
  const scrollRafRef = useRef<number | null>(null);
  const pendingScrollTopRef = useRef(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [bottomClearancePx, setBottomClearancePx] = useState(() =>
    readBottomClearancePx(msgListIsMobile()),
  );
  const shouldStickToBottomRef = useRef(true);

  // Track the runtime flag so OVERSCAN_PX stays in sync when the async
  // probe flips mobile/desktop mid-session (usually followed by a reload,
  // but the state tracker here means the first post-reload render already
  // has the right value — and HMR re-renders stay correct without a
  // module reload).
  const [isMobileRuntime, setIsMobileRuntime] = useState<boolean>(() => msgListIsMobile());
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => {
      invalidateMsgListIsMobileCache();
      setIsMobileRuntime(msgListIsMobile());
    };
    window.addEventListener('kumiko:runtime-changed', handler);
    return () => window.removeEventListener('kumiko:runtime-changed', handler);
  }, []);
  const overscanPx = useMemo(
    () => (isMobileRuntime ? OVERSCAN_PX_MOBILE : OVERSCAN_PX_DESKTOP),
    [isMobileRuntime],
  );

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

  const totalMessageHeight = itemOffsets[itemOffsets.length - 1] || 0;
  const totalContentHeight = totalMessageHeight + bottomClearancePx;

  const isNearBottom = useCallback((container: HTMLDivElement) => {
    const distance = totalContentHeight - (container.scrollTop + container.clientHeight);
    return distance <= Math.max(160, bottomClearancePx + 48);
  }, [bottomClearancePx, totalContentHeight]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const container = containerRef.current;
    if (!container) return;
    const desiredTop = Math.max(0, totalContentHeight - container.clientHeight);
    container.scrollTo({ top: desiredTop, behavior });
    pendingScrollTopRef.current = desiredTop;
    setScrollTop((current) => current === desiredTop ? current : desiredTop);
  }, [totalContentHeight]);

  const { startIndex, endIndex } = useMemo(() => {
    if (visibleMessages.length === 0) {
      return { startIndex: 0, endIndex: -1 };
    }

    const overscannedTop = Math.max(0, scrollTop - overscanPx);
    const overscannedBottom = scrollTop + viewportHeight + overscanPx;
    const nextStartIndex = clamp(findClosestItemIndex(itemOffsets, overscannedTop), 0, visibleMessages.length - 1);
    const nextEndIndex = clamp(findClosestItemIndex(itemOffsets, overscannedBottom), nextStartIndex, visibleMessages.length - 1);

    return {
      startIndex: nextStartIndex,
      endIndex: nextEndIndex,
    };
  }, [itemOffsets, scrollTop, viewportHeight, visibleMessages.length, overscanPx]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const syncViewport = () => {
      const nextHeight = container.clientHeight;
      const nextTop = container.scrollTop;
      const nextClearance = readBottomClearancePx(isMobileRuntime);
      setViewportHeight((current) => current === nextHeight ? current : nextHeight);
      setScrollTop((current) => current === nextTop ? current : nextTop);
      setBottomClearancePx((current) => current === nextClearance ? current : nextClearance);
      shouldStickToBottomRef.current = isNearBottom(container);
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
  }, [isMobileRuntime, isNearBottom]);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    pendingScrollTopRef.current = event.currentTarget.scrollTop;
    shouldStickToBottomRef.current = isNearBottom(event.currentTarget);
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      setScrollTop((current) => (
        current === pendingScrollTopRef.current ? current : pendingScrollTopRef.current
      ));
    });
  }, [isNearBottom]);

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

  const lastVisibleMessage = visibleMessages[visibleMessages.length - 1] || null;
  const lastVisibleMessageId = lastVisibleMessage?.id;

  useEffect(() => {
    if (!lastVisibleMessage) return;

    const shouldAutoScroll =
      shouldStickToBottomRef.current ||
      lastVisibleMessage.role === 'user' ||
      pendingMessageIds.has(lastVisibleMessage.id);

    if (!shouldAutoScroll) return;

    let raf1 = 0;
    let raf2 = 0;
    raf1 = window.requestAnimationFrame(() => {
      scrollToBottom('auto');
      raf2 = window.requestAnimationFrame(() => {
        scrollToBottom('auto');
      });
    });

    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [bottomClearancePx, lastVisibleMessage, lastVisibleMessageId, pendingMessageIds, scrollToBottom, totalContentHeight]);

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
              isMobileRuntime={isMobileRuntime}
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
                onLongPress={onLongPress}
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
