
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { X, BrainCircuit, ChevronDown, ChevronUp, Plus, Trash2, ArrowUp, ArrowDown, BookOpen, RotateCcw, Lock, History, Bookmark, Edit2, Check, Clock, ListPlus, GripVertical, EyeOff, Eye, Quote, Pin, StickyNote, Image as ImageIcon, LocateFixed, NotebookPen, Zap, RefreshCw, AlertTriangle, Search, Power, Star, Code2 } from 'lucide-react';
import { WorldBookEntry, Message, AnchorEntry } from '../types';
import { resolveMessageImageSync } from './app/useMessageImage';
import { Collapse } from './Collapse';
import { DEFAULT_WORLD_BOOK, UI_TRANSLATIONS, KUMIKO_EMOTION_IMAGES, LOCALIZED_WORLD_BOOK } from '../constants';
import { useAppStore } from '../store';

interface MemoryPanelProps {
  isOpen: boolean;
  onClose: () => void;
  memoryContent: string;
  contextLimit: number; 
  messages: Message[]; 
  worldBook: WorldBookEntry[];
  onSave: (newCoreMemory: string, newWorldBook: WorldBookEntry[], newContextLimit: number) => void;
  turnCount?: number;
  summaryProgressText?: string;
  onManualSummary?: () => Promise<void>;
  onUpdateMessage?: (id: string, newText: string) => void;
  onDeleteMessage?: (id: string) => void;
  onInsertMessage?: (afterId: string | null, role: 'user' | 'model') => void;
  onReorderMessages?: (dragIndex: number, hoverIndex: number) => void;
  onToggleHidden?: (id: string) => void;
  onTogglePin?: (id: string) => void; 
  onJumpToMessage?: (id: string) => void;
  anchors?: AnchorEntry[];
  onDeleteAnchor?: (id: string) => void;
  onImageClick?: (src: string) => void;
  kumikoNotebook?: string;
}

// DEFINITION OF CORE MEMORIES THAT SHOULD BE RECOMMENDED
const CORE_MEMORY_IDS = new Set([
    'rag_item_hairpin',        // Romance core symbol
    'rag_hist_middle_school',  // Personality origin
    'rag_char_reina_details',  // Most important relationship
    'rag_char_shuichi_details', // Romantic partner
    'rag_char_others'          // Daily companions circle
]);

// Pure formatter — module-level so PinnedModal (also module-level now) can reuse it
// without needing to close over component-scope helpers.
const formatKyotoTime = (timestamp: number): string => {
  try {
    return new Intl.DateTimeFormat('ja-JP', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZone: 'Asia/Tokyo', hour12: false
    }).format(new Date(timestamp));
  } catch (e) {
    return new Date(timestamp).toLocaleString();
  }
};

// --- PINNED MODAL (module-level) ---
// Previously defined inside MemoryPanel, which caused the modal to unmount and
// remount on every parent re-render — users saw scroll positions reset, animations
// re-play, and focus jump whenever the parent updated (e.g. virtualized list scroll
// or worldBook edits). Defining it here gives it a stable component identity.
interface PinnedModalProps {
  isOpen: boolean;
  onCloseModal: () => void;
  onClosePanel: () => void;
  pinnedMessages: Message[];
  sortedMessages: Message[];
  onJumpToMessage?: (id: string) => void;
  onTogglePin?: (id: string) => void;
  isDarkMode: boolean;
  t: typeof UI_TRANSLATIONS[keyof typeof UI_TRANSLATIONS];
}

const PinnedModal: React.FC<PinnedModalProps> = ({
  isOpen, onCloseModal, onClosePanel,
  pinnedMessages, sortedMessages,
  onJumpToMessage, onTogglePin,
  isDarkMode, t,
}) => {
  if (!isOpen) return null;
  const bgClass = isDarkMode ? 'bg-[#161412]/96 border-[#2a2522]/60' : 'bg-[rgba(255,255,255,0.98)] border-[#e6ded3]';
  const textClass = isDarkMode ? 'text-[#f0e6d8]' : 'text-[#4c3a2b]';
  const titleClass = isDarkMode ? 'text-[#e5c992]' : 'text-[#a97832]';
  const closeButtonClass = isDarkMode ? 'hover:bg-red-500/10 hover:text-red-400' : 'hover:bg-red-500/10 hover:text-red-500';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 backdrop-blur-sm animate-in fade-in safe-area-padding-modal" style={{ background: 'radial-gradient(circle, rgba(10,8,6,0.54) 24%, rgba(10,8,6,0.08) 100%)' }}>
      <div className={`w-full max-w-md max-h-[70vh] flex flex-col rounded-lg border shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 ${bgClass}`}>
        <div className={`flex items-center justify-between p-3 border-b ${isDarkMode ? 'border-[#4f3926]' : 'border-[#ece3d8]'}`}>
          <div className={`flex items-center gap-2 ${titleClass}`}>
            <Pin size={16} className="fill-current" />
            <span className="font-mincho font-semibold ka-floating-title tracking-[0.04em] uppercase">{t.pinnedMemoriesTitle}</span>
          </div>
          <button onClick={onCloseModal} className={`p-1.5 rounded-full transition-colors ${textClass} ${closeButtonClass}`}>
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-thin">
          {pinnedMessages.length === 0 && (
            <div className="text-center opacity-50 ka-copy-sm py-10">{t.noPinnedMessages}</div>
          )}
          {pinnedMessages.map(msg => {
            const contextIndex = sortedMessages.findIndex(m => m.id === msg.id) + 1;
            return (
              <div
                key={msg.id}
                onClick={() => {
                  if (onJumpToMessage) {
                    onJumpToMessage(msg.id);
                    onCloseModal();
                    onClosePanel();
                  }
                }}
                className={`p-3 rounded border text-xs relative cursor-pointer transition-all hover:scale-[1.01] ${isDarkMode ? 'bg-[#18130f] border-[#4e3928]/40 hover:bg-[#1e1712]' : 'bg-[#fffdf9] border-[#ebe2d6] hover:bg-[#faf6ef]'}`}
                title={t.jumpToContext}
              >
                <div className="flex justify-between items-center mb-1 opacity-60 pointer-events-none">
                  <div className="flex items-center gap-2">
                    <span className={`ka-micro font-semibold ${isDarkMode ? 'text-[#d0b180]/80' : 'text-[#b18645]/80'}`}>#{contextIndex}</span>
                    <span className="ka-micro font-semibold">{msg.role === 'model' ? 'Kumiko' : 'You'}</span>
                  </div>
                  <span className="ka-micro">{formatKyotoTime(msg.timestamp)}</span>
                </div>
                <p className="whitespace-pre-wrap leading-relaxed pointer-events-none">{msg.text}</p>
                {onTogglePin && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onTogglePin(msg.id); }}
                    className={`absolute top-2 right-2 transition-colors p-1 ${isDarkMode ? 'text-[#d0b180] hover:text-red-400' : 'text-[#b18645] hover:text-red-500'}`}
                    title={t.unpin}
                  >
                    <Pin size={12} className="fill-current" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export const MemoryPanel: React.FC<MemoryPanelProps> = ({ 
  isOpen, 
  onClose, 
  memoryContent, 
  contextLimit,
  messages,
  worldBook,
  onSave, 
  turnCount = 0,
  summaryProgressText = '',
  onManualSummary,
  onUpdateMessage,
  onDeleteMessage,
  onInsertMessage,
  onReorderMessages,
  onToggleHidden,
  onTogglePin,
  onJumpToMessage,
  anchors = [],
  onDeleteAnchor,
  onImageClick,
  kumikoNotebook = "",
}) => {
  const isDarkMode = useAppStore(s => s.isDarkMode);
  const language = useAppStore(s => s.language);
  const t = UI_TRANSLATIONS[language];
  const [localCoreMemory, setLocalCoreMemory] = useState(memoryContent);
  const [localWorldBook, setLocalWorldBook] = useState<WorldBookEntry[]>([]);
  const [localContextLimit, setLocalContextLimit] = useState(contextLimit);
  
  // UI State - DEFAULT ALL COLLAPSED
  const [isCoreOpen, setIsCoreOpen] = useState(false);
  const [isNotebookOpen, setIsNotebookOpen] = useState(false); // NEW
  const [isHistoryConfigOpen, setIsHistoryConfigOpen] = useState(false); 
  const [isDefaultBookOpen, setIsDefaultBookOpen] = useState(false);
  const [isCustomBookOpen, setIsCustomBookOpen] = useState(false);
  const [isAnchorsOpen, setIsAnchorsOpen] = useState(false); 
  
  // New: Pinned Modal State
  const [isPinnedModalOpen, setIsPinnedModalOpen] = useState(false);
  const [isCoreSourceOpen, setIsCoreSourceOpen] = useState(false);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  
  // Track expanded state for individual entries by ID
  const [expandedEntryIds, setExpandedEntryIds] = useState<Set<string>>(new Set());

  // Deletion Confirmation State for specific items
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  
  // Message Deletion Confirmation (Separate state)
  const [confirmMsgDeleteId, setConfirmMsgDeleteId] = useState<string | null>(null);

  // Anchor Deletion Confirmation
  const [confirmAnchorDeleteId, setConfirmAnchorDeleteId] = useState<string | null>(null);

  // --- MESSAGE EDITING STATE ---
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editMessageText, setEditMessageText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  
  // Mobile Menu State
  const [mobileMenuOpenId, setMobileMenuOpenId] = useState<string | null>(null);
  
  // Drag State
  const [draggedItemIndex, setDraggedItemIndex] = useState<number | null>(null);

  // Dirty State for Unsaved Changes indicator
  const [isDirty, setIsDirty] = useState(false);

  // --- HISTORY SEARCH STATE ---
  const [historySearchQuery, setHistorySearchQuery] = useState('');
  const [historySearchMatches, setHistorySearchMatches] = useState<string[]>([]);
  const [historySearchIndex, setHistorySearchIndex] = useState(0);

  const sortedMessages = useMemo(() => {
      if (!isHistoryConfigOpen) return [] as Message[];
      return [...messages].sort((a, b) => a.timestamp - b.timestamp);
  }, [messages, isHistoryConfigOpen]);

  const rowVirtualizer = useVirtualizer({
    count: sortedMessages.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 100,
    overscan: 5,
  });

  useEffect(() => {
    setLocalCoreMemory(memoryContent);
    setLocalContextLimit(contextLimit);
    setLocalWorldBook(worldBook && worldBook.length > 0 ? worldBook.map(e => ({...e, title: e.title || ''})) : []);
  }, [memoryContent, worldBook, contextLimit, isOpen]);

  // Dirty Check Logic
  useEffect(() => {
      const processedWorldBook = worldBook && worldBook.length > 0 ? worldBook.map(e => ({...e, title: e.title || ''})) : [];
      const dirty = 
          localCoreMemory !== memoryContent ||
          localContextLimit !== contextLimit ||
          JSON.stringify(localWorldBook) !== JSON.stringify(processedWorldBook);
      setIsDirty(dirty);
  }, [localCoreMemory, localWorldBook, localContextLimit, memoryContent, worldBook, contextLimit]);

  // Auto-Save Effect (Debounced)
  useEffect(() => {
      const timer = setTimeout(() => {
          onSave(localCoreMemory, localWorldBook, localContextLimit);
      }, 500);
      return () => clearTimeout(timer);
  }, [localCoreMemory, localWorldBook, localContextLimit, onSave]);

  // Watch for Panel Close to Force Save (Fix for fast-close data loss)
  const prevIsOpen = useRef(isOpen);
  useEffect(() => {
    if (prevIsOpen.current && !isOpen) {
        // Just closed. Flush state immediately.
        onSave(localCoreMemory, localWorldBook, localContextLimit);
    }
    prevIsOpen.current = isOpen;
  }, [isOpen, localCoreMemory, localWorldBook, localContextLimit, onSave]);

  // Scroll to bottom of history when opened
  useEffect(() => {
    if (isHistoryConfigOpen && sortedMessages.length > 0) {
        const timer = setTimeout(() => {
            rowVirtualizer.scrollToIndex(sortedMessages.length - 1, { align: 'end' });
        }, 150);
        return () => clearTimeout(timer);
    }
  }, [isHistoryConfigOpen]);

  // --- SEARCH LOGIC ---
  useEffect(() => {
      if (!historySearchQuery.trim()) {
          setHistorySearchMatches([]);
          setHistorySearchIndex(0);
          return;
      }
      // Simple text match
      const lowerQuery = historySearchQuery.toLowerCase();
      const matches = sortedMessages
          .filter(m => m.text && m.text.toLowerCase().includes(lowerQuery))
          .map(m => m.id);
      
      setHistorySearchMatches(matches);
      // Reset index if matches changed
      setHistorySearchIndex(0);
  }, [historySearchQuery, sortedMessages]);

  // Scroll to match logic
  useEffect(() => {
      if (historySearchMatches.length > 0 && isHistoryConfigOpen) {
          const targetId = historySearchMatches[historySearchIndex];
          const targetIndex = sortedMessages.findIndex(m => m.id === targetId);
          if (targetIndex >= 0) {
              rowVirtualizer.scrollToIndex(targetIndex, { align: 'center', behavior: 'smooth' });
          }
      }
  }, [historySearchIndex, historySearchMatches, isHistoryConfigOpen, sortedMessages, rowVirtualizer]);

  const handleNextMatch = () => {
      if (historySearchMatches.length === 0) return;
      setHistorySearchIndex(prev => (prev + 1) % historySearchMatches.length);
  };

  const handlePrevMatch = () => {
      if (historySearchMatches.length === 0) return;
      setHistorySearchIndex(prev => (prev - 1 + historySearchMatches.length) % historySearchMatches.length);
  };

  // --- Helpers to split data ---
  const defaultIds = useMemo(() => {
    const lore = LOCALIZED_WORLD_BOOK[language] || DEFAULT_WORLD_BOOK;
    return new Set(lore.map(d => d.id));
  }, [language]);
  
  const systemEntries = localWorldBook.filter(e => defaultIds.has(e.id));
  const customEntries = localWorldBook.filter(e => !defaultIds.has(e.id));

  // --- Handlers ---

  const toggleEntryExpansion = (id: string) => {
    setExpandedEntryIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const handleAddCustomEntry = () => {
    const newId = Date.now().toString();
    const newEntry: WorldBookEntry = {
      id: newId,
      title: 'New Entry',
      content: '',
      isActive: true,
      isHighPriority: false
    };
    // Append to end
    setLocalWorldBook([...localWorldBook, newEntry]);
    setIsCustomBookOpen(true);
    // Auto expand new entry
    setExpandedEntryIds(prev => new Set(prev).add(newId));
  };

  const updateEntry = (id: string, field: keyof WorldBookEntry, value: any) => {
    setLocalWorldBook(prev => prev.map(entry => 
      entry.id === id ? { ...entry, [field]: value } : entry
    ));
  };

  const handleDeleteEntry = (id: string) => {
    if (confirmDeleteId === id) {
      setLocalWorldBook(prev => prev.filter(entry => entry.id !== id));
      setConfirmDeleteId(null);
    } else {
      setConfirmDeleteId(id);
      setTimeout(() => setConfirmDeleteId(null), 3000);
    }
  };

  const handleResetEntry = (id: string) => {
      const defaultEntry = DEFAULT_WORLD_BOOK.find(d => d.id === id);
      
      const confirmMsg = defaultEntry 
        ? `Reset this official entry to original system values?`
        : `Clear content of this entry?`;

      if (confirm(confirmMsg)) {
          if (defaultEntry) {
             setLocalWorldBook(prev => prev.map(entry => 
                entry.id === id ? { ...defaultEntry } : entry
             ));
             setExpandedEntryIds(prev => new Set(prev).add(id));
          } else {
             setLocalWorldBook(prev => prev.map(entry => 
                entry.id === id ? { ...entry, title: 'New Entry', content: '' } : entry
             ));
          }
      }
  };

  // --- Message Editing Handlers ---
  const startEditingMessage = (msg: Message) => {
    setEditingMessageId(msg.id);
    setEditMessageText(msg.text);
    setMobileMenuOpenId(null); // Close menu when editing starts
  };

  const saveEditedMessage = () => {
    if (editingMessageId && onUpdateMessage) {
      onUpdateMessage(editingMessageId, editMessageText);
      setEditingMessageId(null);
      setEditMessageText('');
    }
  };

  const cancelEditingMessage = () => {
    setEditingMessageId(null);
    setEditMessageText('');
  };
  
  const handleDeleteMsgClick = (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      if (confirmMsgDeleteId === id) {
          if (onDeleteMessage) onDeleteMessage(id);
          setConfirmMsgDeleteId(null);
      } else {
          setConfirmMsgDeleteId(id);
          setTimeout(() => setConfirmMsgDeleteId(null), 3000);
      }
  };

  const handleDeleteAnchorClick = (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      if (confirmAnchorDeleteId === id) {
          if (onDeleteAnchor) onDeleteAnchor(id);
          setConfirmAnchorDeleteId(null);
      } else {
          setConfirmAnchorDeleteId(id);
          setTimeout(() => setConfirmAnchorDeleteId(null), 3000);
      }
  };

  const handleInsertMsg = (e: React.MouseEvent, afterId: string | null) => {
      e.stopPropagation();
      if (onInsertMessage) {
          let role: 'user' | 'model' = 'model';
          if (afterId) {
             const prevMsg = messages.find(m => m.id === afterId);
             if (prevMsg) role = prevMsg.role;
          }
          onInsertMessage(afterId, role);
          setMobileMenuOpenId(null); // Close menu
      }
  };

  const toggleMobileMenu = (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      setMobileMenuOpenId(prev => prev === id ? null : id);
  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedItemIndex(index);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    if (draggedItemIndex !== null && draggedItemIndex !== dropIndex && onReorderMessages) {
       onReorderMessages(draggedItemIndex, dropIndex);
    }
    setDraggedItemIndex(null);
  };

  // formatKyotoTime is now defined at module scope (needed by the extracted PinnedModal).

  const bgClass = isDarkMode ? 'bg-[#161412]/96 border-[#2a2522]/60' : 'bg-[rgba(255,255,255,0.98)] border-[#e6ded3]';
  const textClass = isDarkMode ? 'text-[#f0e6d8]' : 'text-[#4c3a2b]';
  const titleClass = isDarkMode ? 'text-[#e5c992]' : 'text-[#a97832]';
  const inputBgClass = isDarkMode ? 'bg-[#221d18] border-[#433428]' : 'bg-[#fbfaf8] border-[#e2d9cf]';
  const cardHighlightBg = isDarkMode ? 'bg-[#1f1b17] border-[#47372b]/60' : 'bg-[#fffdfa] border-[#ebe2d6]';
  const memorySectionMeta = {
    core: {
      note: language === 'zh' ? 'RAG Buffer / 本地缓存' : 'RAG Buffer / Local Cache',
      shell: isDarkMode ? 'border-[#5b4431]/55 bg-[#1f1a15]' : 'border-[#e7ddd0] bg-[#fffdfa]',
      header: isDarkMode ? 'border-b border-[#3e3024] bg-[#241e18] hover:bg-[#2a231b] text-[#f5e0b0]' : 'border-b border-[#eee4d7] bg-[#fffdfa] hover:bg-[#fcf7f0] text-[#8f6a2f]',
      chip: isDarkMode ? 'border-[#866242]/50 bg-[#2e2319] text-[#f5e0b0]' : 'border-[#ecd9b7] bg-[#fff8ea] text-[#b07b1e]',
      chipShape: 'rounded-[1rem]',
      badge: isDarkMode ? 'bg-[#d4a853]/25 text-[#f5e0b0]' : 'bg-[#f5e9d1] text-[#946526]',
      accentStrip: isDarkMode ? 'bg-[#d4a853]' : 'bg-[linear-gradient(180deg,#ddb979,#c9983f)]',
      ornamentLabel: language === 'zh' ? 'RAG' : 'RAG',
      ornamentClass: isDarkMode ? 'rounded-full border border-[#7c5a37]/70 bg-[#2a2117] text-[#f5e0b0]' : 'rounded-full border border-[#ead7b6] bg-[#fff7e9] text-[#a16f2b]'
    },
    notebook: {
      note: language === 'zh' ? '用户画像 / 关系动态' : 'User Profile / Bonds',
      shell: isDarkMode ? 'border-[#6b5030]/55 bg-[#1f1a17]' : 'border-[#e5ddd3] bg-[#fcfaf7]',
      header: isDarkMode ? 'border-b border-[#6b5030] bg-[#2a2017] hover:bg-[#32281f] text-[#f5c878]' : 'border-b border-[#eee6dc] bg-[#fcfbf8] hover:bg-[#f8f4ee] text-[#8d6b40]',
      chip: isDarkMode ? 'border-[#8a6a42]/50 bg-[#302818] text-[#f5c878]' : 'border-[#e0d3c1] bg-[#fcfaf6] text-[#9c7343]',
      chipShape: 'rounded-[1.25rem] rounded-bl-[0.75rem]',
      badge: isDarkMode ? 'bg-[#e8a040]/25 text-[#f5c878]' : 'bg-[#f5e9d1] text-[#8d6b40]',
      accentStrip: isDarkMode ? 'bg-[#e8a040]' : 'bg-[linear-gradient(180deg,#f5c878,#e8a040)]',
      ornamentLabel: language === 'zh' ? '档案' : 'PROFILE',
      ornamentClass: isDarkMode ? 'rounded-[0.85rem] rounded-bl-[0.3rem] border border-[#6b5030]/70 bg-[#2a2017] text-[#f5c878]' : 'rounded-[0.85rem] rounded-bl-[0.3rem] border border-[#e2d6c6] bg-[#fbf7f1] text-[#926b3e]'
    },
    anchors: {
      note: language === 'zh' ? '关键片段 / 情感锚点' : 'Scenes / Emotional Anchors',
      shell: isDarkMode ? 'border-[#5a3b41]/45 bg-[#1d1818]' : 'border-[#efdee4] bg-[#fffafc]',
      header: isDarkMode ? 'border-b border-[#3f2a2f] bg-[#251b1c] hover:bg-[#2d2124] text-[#f5d8e0]' : 'border-b border-[#f0e4e7] bg-[#fffafb] hover:bg-[#fff3f6] text-[#ab6475]',
      chip: isDarkMode ? 'border-[#855661]/50 bg-[#302022] text-[#f5d0d8]' : 'border-[#f0ced6] bg-[#fff7f9] text-[#bb5d74]',
      chipShape: 'rounded-[1rem] rounded-tr-[0.35rem]',
      badge: isDarkMode ? 'bg-[#d47a9a]/25 text-[#f5d8e0]' : 'bg-[#fdeaf0] text-[#b75573]',
      accentStrip: isDarkMode ? 'bg-[#d47a9a]' : 'bg-[linear-gradient(180deg,#e8a0b5,#d4708d)]',
      ornamentLabel: language === 'zh' ? '锚点' : 'ANCHOR',
      ornamentClass: isDarkMode ? 'rounded-[0.6rem] border border-[#84515b]/70 bg-[#2a1a1e] text-[#f5d8e0]' : 'rounded-[0.6rem] border border-[#f0ced6] bg-[#fff5f8] text-[#b96077]'
    },
    history: {
      note: language === 'zh' ? '上下文窗口 / 对话编辑' : 'Context Window / Editor',
      shell: isDarkMode ? 'border-[#2a3530]/50 bg-[#141816]' : 'border-[#d0e8e0] bg-[#f5faf8]',
      header: isDarkMode ? 'border-b border-[#2a3530] bg-[#1a1e1c] hover:bg-[#212826] text-[#6dbba8]' : 'border-b border-[#c8e4dc] bg-[#f5faf8] hover:bg-[#e8f4ef] text-[#3d8e7a]',
      chip: isDarkMode ? 'border-[#3d8e7a]/50 bg-[#1a2422] text-[#6dbba8]' : 'border-[#a8d4c8] bg-[#f0fff8] text-[#3d8e7a]',
      chipShape: 'rounded-[0.95rem]',
      badge: isDarkMode ? 'bg-[#3d8e7a]/25 text-[#6dbba8]' : 'bg-[#d4ede8] text-[#3d8e7a]',
      accentStrip: isDarkMode ? 'bg-[#6dbba8]' : 'bg-[linear-gradient(180deg,#6dbba8,#3d8e7a)]',
      ornamentLabel: language === 'zh' ? '窗口' : 'LEDGER',
      ornamentClass: isDarkMode ? 'rounded-[0.5rem] border border-[#3d8e7a]/70 bg-[#141816] text-[#6dbba8]' : 'rounded-[0.5rem] border border-[#a8d4c8] bg-[#f0fff8] text-[#3d8e7a]'
    },
    official: {
      note: language === 'zh' ? '官方设定 / 只读档案' : 'Official Lore / Read-only',
      shell: isDarkMode ? 'border-[#2a2830]/50 bg-[#18161c]' : 'border-[#e0d8ec] bg-[#f8f5fc]',
      header: isDarkMode ? 'border-b border-[#2a2830] bg-[#1e1c22] hover:bg-[#252328] text-[#b0a0d0]' : 'border-b border-[#e0d8ec] bg-[#f8f5fc] hover:bg-[#f2eef8] text-[#8a7ab5]',
      chip: isDarkMode ? 'border-[#8a7ab5]/50 bg-[#1e1c22] text-[#b0a0d0]' : 'border-[#d4c0e8] bg-[#f8f4ff] text-[#8a7ab5]',
      chipShape: 'rounded-[1.15rem] rounded-br-[0.5rem]',
      badge: isDarkMode ? 'bg-[#8a7ab5]/25 text-[#b0a0d0]' : 'bg-[#e8d8f0] text-[#8a7ab5]',
      accentStrip: isDarkMode ? 'bg-[#b0a0d0]' : 'bg-[linear-gradient(180deg,#b0a0d0,#8a7ab5)]',
      ornamentLabel: language === 'zh' ? '馆藏' : 'ARCHIVE',
      ornamentClass: isDarkMode ? 'rounded-full border border-dashed border-[#8a7ab5]/70 bg-[#18161c] text-[#b0a0d0]' : 'rounded-full border border-dashed border-[#d4c0e8] bg-[#f8f4ff] text-[#8a7ab5]'
    },
    custom: {
      note: language === 'zh' ? '用户补充 / 可编辑' : 'User Lore / Editable',
      shell: isDarkMode ? 'border-[#252a34]/50 bg-[#14161c]' : 'border-[#d5e0ec] bg-[#f7f9fc]',
      header: isDarkMode ? 'border-b border-[#252a34] bg-[#1a1c24] hover:bg-[#21232c] text-[#8eaac8]' : 'border-b border-[#d5e0ec] bg-[#f7f9fc] hover:bg-[#eff3f9] text-[#6882a8]',
      chip: isDarkMode ? 'border-[#6882a8]/50 bg-[#1a1c24] text-[#8eaac8]' : 'border-[#c0d4e8] bg-[#f7f9fc] text-[#6882a8]',
      chipShape: 'rounded-[1rem] rounded-tl-[0.35rem]',
      badge: isDarkMode ? 'bg-[#6882a8]/25 text-[#8eaac8]' : 'bg-[#e0eaf4] text-[#6882a8]',
      accentStrip: isDarkMode ? 'bg-[#8eaac8]' : 'bg-[linear-gradient(180deg,#8eaac8,#6882a8)]',
      ornamentLabel: language === 'zh' ? '用户' : 'CUSTOM',
      ornamentClass: isDarkMode ? 'rounded-[0.55rem] border border-[#6882a8]/70 bg-[#14161c] text-[#8eaac8]' : 'rounded-[0.55rem] border border-[#c0d4e8] bg-[#f7f9fc] text-[#6882a8]'
    }
  };

  const pinnedMessages = sortedMessages.filter(m => m.isPinned && !m.isHidden);
  const cutoffIndex = Math.max(0, sortedMessages.length - localContextLimit);
  const formattedFooter = t.viewerFooter?.replace('{0}', localContextLimit.toString()) || "Showing messages";

  // Close button class统一为与MessageCenterPanel一致
  const closeButtonClass = isDarkMode
    ? 'hover:bg-red-500/10 hover:text-red-400'
    : 'hover:bg-red-500/10 hover:text-red-500';

  // PinnedModal is now a module-level component to keep its identity stable across
  // parent renders. See the PinnedModal definition + comment near the top of this file.

  return (
    <div className="ka-mobile-fullbleed-backdrop fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm safe-area-padding-modal" style={{ background: 'radial-gradient(circle, rgba(10,8,6,0.48) 24%, rgba(10,8,6,0.08) 100%)', opacity: isOpen ? 1 : 0, pointerEvents: isOpen ? 'auto' : 'none', visibility: isOpen ? 'visible' : 'hidden', transition: isOpen ? 'opacity 300ms ease-out, visibility 0s 0s' : 'opacity 200ms ease-in, visibility 0s 200ms', willChange: 'opacity' }}>
      <div className={`ka-mobile-fullbleed-sheet w-full max-w-2xl max-h-[85dvh] rounded-lg border shadow-2xl flex flex-col overflow-hidden ${bgClass}`} style={{ opacity: isOpen ? 1 : 0, transform: isOpen ? 'translateY(0)' : 'translateY(10px)', transition: isOpen ? 'opacity 300ms ease-out, transform 300ms ease-out' : 'opacity 200ms ease-in, transform 200ms ease-in', willChange: 'transform, opacity', contain: 'layout style paint' }}>
        
        {/* Header */}
        <div className={`flex items-center justify-between px-4 py-3 border-b ${isDarkMode ? 'border-[#4f3926]' : 'border-[#ece3d8]'}`}>
          <div className="flex items-center gap-2">
            <BrainCircuit size={20} className={titleClass} />
            <span className={`font-mincho ka-overlay-title font-semibold tracking-[0.03em] ${titleClass}`}>{t.memoryTitle}</span>
          </div>
          <button 
            onClick={onClose}
            className={`p-1.5 rounded-full transition-colors ${textClass} ${closeButtonClass}`}
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable Content Wrapper */}
        <div data-resize-heavy className="flex-1 overflow-y-auto w-full scrollbar-thin">
          <div className="p-4 flex flex-col gap-4">
            
            {/* Section 1: Core Memory */}
            <div className={`relative rounded-[1.1rem] border overflow-hidden transition-all duration-300 shadow-[0_10px_24px_rgba(0,0,0,0.04)] ${memorySectionMeta.core.shell}`}>
              <div className={`pointer-events-none absolute inset-y-0 left-0 w-[3px] ${memorySectionMeta.core.accentStrip}`} />
              <div className={`pointer-events-none absolute right-4 top-3 z-[1] px-2.5 py-1 ka-micro font-semibold tracking-[0.12em] ${memorySectionMeta.core.ornamentClass}`}>
                {memorySectionMeta.core.ornamentLabel}
              </div>
              <button 
                onClick={() => setIsCoreOpen(!isCoreOpen)}
                className={`relative z-10 w-full flex items-center justify-between p-3.5 font-semibold text-sm transition-colors ${memorySectionMeta.core.header}`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center border ${memorySectionMeta.core.chip} ${memorySectionMeta.core.chipShape}`}>
                    <BrainCircuit size={16} />
                  </div>
                  <div className="min-w-0 text-left">
                    <div className="truncate">{t.coreMemory}</div>
                    <div className={`ka-micro font-medium tracking-[0.08em] uppercase ${isDarkMode ? 'text-[#bfa483]' : 'text-[#b08957]'}`}>{memorySectionMeta.core.note}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`px-2 py-0.5 rounded-full ka-micro font-semibold ${memorySectionMeta.core.badge}`}>RAG</span>
                  {isCoreOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </div>
              </button>
              
              <Collapse isOpen={isCoreOpen}>
                <div className="p-3 flex flex-col gap-3">
                  <div className={`flex items-start gap-2 p-2 rounded text-[10px] border ${isDarkMode ? 'bg-black/20 border-white/5 text-gray-400' : 'bg-black/5 border-black/5 text-gray-600'}`}>
                    <BrainCircuit size={12} className="flex-shrink-0 mt-0.5 opacity-60" />
                    <p>{t.coreMemoryHelp}</p>
                  </div>
                  {/* Structured card view */}
                  {localCoreMemory.trim() ? (
                    <div className="flex flex-col gap-2">
                      {localCoreMemory.trim().split(/\n\n+/).filter(Boolean).map((block, i) => {
                        const headerMatch = block.match(/^【(.+?)】/);
                        return (
                          <div key={i} className={`relative rounded-lg border pl-3 pr-3 py-2.5 text-sm leading-relaxed ${isDarkMode ? 'bg-[#14100c] border-[#5d4731]/40 text-[#eadfce]' : 'bg-[#fffefd] border-[#e8ddcf] text-[#4b3a2a]'}`}>
                            <div className={`absolute left-0 top-0 bottom-0 w-[3px] rounded-l-lg ${isDarkMode ? 'bg-[#d7bb88]/40' : 'bg-[#c9983f]/40'}`} />
                            {headerMatch ? (
                              <>
                                <div className={`text-[10px] font-mono font-semibold mb-1 ${isDarkMode ? 'text-[#d7bb88]/70' : 'text-[#b08957]/70'}`}>{headerMatch[1]}</div>
                                <p className="whitespace-pre-wrap ka-copy-sm">{block.slice(headerMatch[0].length).trim()}</p>
                              </>
                            ) : (
                              <p className="whitespace-pre-wrap ka-copy-sm">{block}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className={`text-center py-8 text-sm opacity-50 border border-dashed rounded-lg ${isDarkMode ? 'border-gray-700 text-gray-400' : 'border-gray-300 text-gray-500'}`}>
                      {t.noCoreMemoryPlaceholder}
                    </div>
                  )}
                  {/* Source text toggle */}
                  <button
                    onClick={() => setIsCoreSourceOpen(!isCoreSourceOpen)}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[10px] font-mono transition-colors ${isDarkMode ? 'text-[#d7bb88]/60 hover:text-[#d7bb88] hover:bg-white/5' : 'text-[#b08957]/60 hover:text-[#b08957] hover:bg-black/5'}`}
                  >
                    <Code2 size={11} />
                    {language === 'zh' ? '源文本' : 'Source'}
                    {isCoreSourceOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  </button>
                  <Collapse isOpen={isCoreSourceOpen}>
                    <div className={`relative w-full p-3 rounded border-2 border-double ${isDarkMode ? 'bg-[#14100c] border-[#5d4731]/55 text-[#eadfce]' : 'bg-[#fffefd] border-[#e8ddcf] text-[#4b3a2a]'}`}>
                      <textarea
                        value={localCoreMemory}
                        onChange={(e) => setLocalCoreMemory(e.target.value)}
                        className={`w-full h-32 p-1 rounded ka-input-copy text-base md:text-sm resize-none scrollbar-thin outline-none bg-transparent ${textClass}`}
                        placeholder={t.noCoreMemoryPlaceholder}
                      />
                    </div>
                  </Collapse>
                  <div className={`flex items-center justify-between text-[10px] ${isDarkMode ? 'text-[#bfa483]' : 'text-[#b08957]'}`}>
                    <div className="flex items-center gap-1.5">
                      <div className={`h-1.5 w-1.5 rounded-full ${isDarkMode ? 'bg-[#d7bb88]/60' : 'bg-[#c9983f]/60'}`}></div>
                      <span>{t.nextSyncIn} {summaryProgressText}</span>
                      {onManualSummary && (
                        <button
                          onClick={() => setShowArchiveConfirm(true)}
                          className={`ml-2 px-2.5 py-1 rounded-md text-[10px] font-semibold tracking-wide transition-all cursor-pointer ${isDarkMode ? 'bg-[#d7bb88]/15 hover:bg-[#d7bb88]/30 text-[#d7bb88] border border-[#d7bb88]/20' : 'bg-[#c9983f]/10 hover:bg-[#c9983f]/25 text-[#b08957] border border-[#c9983f]/25'} disabled:opacity-40 disabled:cursor-wait`}
                          title={language === 'zh' ? '将当前对话总结并归档到记忆系统（核心记忆、笔记本、RAG 记忆块）' : 'Summarize and archive current conversation to memory system (core memory, notebook, RAG chunks)'}
                        >
                          <RefreshCw className="inline w-3 h-3 mr-1 -mt-px" />
                          {language === 'zh' ? '立即归档' : 'Archive Now'}
                        </button>
                      )}
                    </div>
                    <span className="opacity-50 font-mono">RAG BUFFER</span>
                  </div>
                </div>
              </Collapse>
            </div>

            {/* Section 2: Kumiko's Notebook */}
            <div className={`relative rounded-[1.1rem] border overflow-hidden transition-all duration-300 shadow-[0_10px_24px_rgba(0,0,0,0.04)] ${memorySectionMeta.notebook.shell}`}>
              <div className={`pointer-events-none absolute inset-y-0 left-0 w-[3px] ${memorySectionMeta.notebook.accentStrip}`} />
              <div className={`pointer-events-none absolute right-4 top-3 z-[1] px-2.5 py-1 ka-micro font-semibold tracking-[0.12em] ${memorySectionMeta.notebook.ornamentClass}`}>
                {memorySectionMeta.notebook.ornamentLabel}
              </div>
              <button 
                onClick={() => setIsNotebookOpen(!isNotebookOpen)}
                className={`relative z-10 w-full flex items-center justify-between p-3.5 font-semibold text-sm transition-colors ${memorySectionMeta.notebook.header}`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center border ${memorySectionMeta.notebook.chip} ${memorySectionMeta.notebook.chipShape}`}>
                    <NotebookPen size={16} />
                  </div>
                  <div className="min-w-0 text-left">
                    <div className="truncate flex items-center gap-1.5">
                      <span>{t.notebookTitle}</span>
                      <Lock size={12} className="opacity-55 shrink-0" />
                    </div>
                    <div className={`ka-micro font-medium tracking-[0.08em] uppercase ${isDarkMode ? 'text-[#baa287]' : 'text-[#a78a68]'}`}>{memorySectionMeta.notebook.note}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`px-2 py-0.5 rounded-full ka-micro font-semibold ${memorySectionMeta.notebook.badge}`}>{language === 'zh' ? '只读' : 'READ'}</span>
                  {isNotebookOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </div>
              </button>
              
              <Collapse isOpen={isNotebookOpen}>
                <div className="p-3 flex flex-col gap-3">
                  <div className={`ka-copy-sm opacity-70 mb-1 ${textClass}`}>
                    {t.notebookDesc}
                  </div>
                  {kumikoNotebook ? (
                    <div className="flex flex-col gap-2">
                      {(() => {
                        try {
                          const parsed = JSON.parse(kumikoNotebook);
                          const nbCards: { label: string; content: string }[] = [];
                          if (parsed.user_profile) nbCards.push({ label: language === 'zh' ? '用户档案' : 'User Profile', content: parsed.user_profile });
                          if (parsed.relationship_dynamics) nbCards.push({ label: language === 'zh' ? '当前羁绊' : 'Relationship Dynamics', content: parsed.relationship_dynamics });
                          return nbCards.map((card, i) => (
                            <div key={i} className={`relative rounded-lg border pl-3 pr-3 py-2.5 text-sm leading-relaxed ${isDarkMode ? 'bg-[#18140f] border-[#6b5030]/40 text-[#eadfce]' : 'bg-[#fffdfb] border-[#e5ddd3] text-[#4b392a]'}`}>
                              <div className={`absolute left-0 top-0 bottom-0 w-[3px] rounded-l-lg ${isDarkMode ? 'bg-[#baa287]/40' : 'bg-[#a78a68]/40'}`} />
                              <div className={`text-[10px] font-mono font-semibold mb-1 ${isDarkMode ? 'text-[#baa287]/70' : 'text-[#a78a68]/70'}`}>{card.label}</div>
                              <p className="whitespace-pre-wrap ka-copy-sm">{card.content}</p>
                            </div>
                          ));
                        } catch {
                          return (
                            <div className={`relative rounded-lg border pl-3 pr-3 py-2.5 text-sm leading-relaxed ${isDarkMode ? 'bg-[#18140f] border-[#6b5030]/40 text-[#eadfce]' : 'bg-[#fffdfb] border-[#e5ddd3] text-[#4b392a]'}`}>
                              <div className={`absolute left-0 top-0 bottom-0 w-[3px] rounded-l-lg ${isDarkMode ? 'bg-[#baa287]/40' : 'bg-[#a78a68]/40'}`} />
                              <p className="whitespace-pre-wrap ka-copy-sm">{kumikoNotebook}</p>
                            </div>
                          );
                        }
                      })()}
                    </div>
                  ) : (
                    <div className={`text-center py-8 text-sm opacity-50 border border-dashed rounded-lg ${isDarkMode ? 'border-gray-700 text-gray-400' : 'border-gray-300 text-gray-500'}`}>
                      {t.notebookPlaceholder}
                    </div>
                  )}
                  <div className={`flex items-start gap-2 mt-1 p-2 rounded text-[10px] border opacity-80 ${isDarkMode ? 'bg-black/20 border-white/5 text-gray-400' : 'bg-black/5 border-black/5 text-gray-600'}`}>
                      <Lock size={12} className="flex-shrink-0 mt-0.5" />
                      <p>{t.notebookFooter}</p>
                  </div>
                </div>
              </Collapse>
            </div>

            {/* Section 3: Life Anchors */}
            <div className={`relative rounded-[1.1rem] border overflow-hidden transition-all duration-300 shadow-[0_10px_24px_rgba(0,0,0,0.04)] ${memorySectionMeta.anchors.shell}`}>
              <div className={`pointer-events-none absolute inset-y-0 left-0 w-[3px] ${memorySectionMeta.anchors.accentStrip}`} />
              <div className={`pointer-events-none absolute right-4 top-3 z-[1] px-2.5 py-1 ka-micro font-semibold tracking-[0.12em] ${memorySectionMeta.anchors.ornamentClass}`}>
                {memorySectionMeta.anchors.ornamentLabel}
              </div>
              <button 
                onClick={() => setIsAnchorsOpen(!isAnchorsOpen)}
                className={`relative z-10 w-full flex items-center justify-between p-3.5 font-semibold text-sm transition-colors ${memorySectionMeta.anchors.header}`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center border ${memorySectionMeta.anchors.chip} ${memorySectionMeta.anchors.chipShape}`}>
                    <StickyNote size={16} />
                  </div>
                  <div className="min-w-0 text-left">
                    <div className="truncate">{t.lifeAnchors}</div>
                    <div className={`ka-micro font-medium tracking-[0.08em] uppercase ${isDarkMode ? 'text-[#d6b0b9]' : 'text-[#b87588]'}`}>{memorySectionMeta.anchors.note}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${memorySectionMeta.anchors.badge}`}>{anchors.length}</span>
                  {isAnchorsOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </div>
              </button>
              
              <Collapse isOpen={isAnchorsOpen}>
                <div className="p-3 flex flex-col gap-3">
                  <p className={`ka-copy-sm opacity-70 ${textClass}`}>{t.lifeAnchorsHelp}</p>
                  {anchors.length === 0 && (
                      <div className={`text-center py-6 opacity-80 text-xs font-mono border border-dashed rounded ${isDarkMode ? 'border-gray-700 text-gray-400' : 'border-gray-400 text-gray-600'}`}>
                          {t.noAnchors}
                      </div>
                  )}
                  <div className="grid grid-cols-1 gap-2.5">
                      {anchors.map((anchor) => (
                          <div
                            key={anchor.id}
                            className={`relative p-4 rounded-[1rem] border shadow-sm group transition-all hover:-translate-y-0.5 overflow-hidden ${isDarkMode ? 'bg-[#1a1215] border-[#6a4b51]/35 text-[#eadfce]' : 'bg-[#fffdfb] border-[#ecdce0] text-[#4b392a]'}`}
                          >
                              <div className={`absolute left-0 top-0 h-full w-1 ${isDarkMode ? 'bg-gradient-to-b from-[#d47a9a] to-[#9a5a7a]' : 'bg-gradient-to-b from-[#d58da1] to-[#b87a8a]'}`} />
                              <div className={`absolute top-3 right-3 h-2.5 w-2.5 rounded-full ${isDarkMode ? 'bg-[#d47a9a]/70 shadow-[0_0_10px_rgba(212,122,154,0.25)]' : 'bg-[#d58da1]/70 shadow-[0_0_10px_rgba(213,141,161,0.2)]'}`}></div>
                              <div className={`flex justify-between items-start mb-2 text-[10px] font-mono border-b pb-2 ${isDarkMode ? 'border-white/8 text-[#c8a0a8]' : 'border-black/8 text-[#8a6a7a]'}`}>
                                  <span>{new Date(anchor.timestamp).toLocaleDateString()}</span>
                                  {anchor.emotion && KUMIKO_EMOTION_IMAGES[anchor.emotion] && (
                                       <img src={KUMIKO_EMOTION_IMAGES[anchor.emotion]} className="w-4 h-4 rounded-full object-cover opacity-80" alt="mood" />
                                  )}
                              </div>
                              <p className="text-sm font-medium leading-relaxed">{anchor.content}</p>
                              {onDeleteAnchor && (
                                  <button
                                    onClick={(e) => handleDeleteAnchorClick(e, anchor.id)}
                                    className={`absolute bottom-2 right-2 p-1 rounded-full transition-all opacity-0 group-hover:opacity-100 ${confirmAnchorDeleteId === anchor.id ? 'bg-red-500 text-white w-auto px-2 text-[10px] font-bold' : (isDarkMode ? 'text-[#b7a08a] hover:text-red-400 hover:bg-white/5' : 'text-[#a08b75] hover:text-red-500 hover:bg-black/5')}`}
                                    title={t.deleteAnchorConfirm}
                                  >
                                      {confirmAnchorDeleteId === anchor.id ? t.deleteAnchorConfirm : <Trash2 size={14} />}
                                  </button>
                              )}
                          </div>
                      ))}
                  </div>
                </div>
              </Collapse>
            </div>

            {/* Section 4: Context History EDITOR */}
            <div className={`relative rounded-[1.1rem] border overflow-hidden transition-all duration-300 shadow-[0_10px_24px_rgba(0,0,0,0.04)] ${memorySectionMeta.history.shell}`}>
              <div className={`pointer-events-none absolute inset-y-0 left-0 w-[3px] ${memorySectionMeta.history.accentStrip}`} />
              <div className={`pointer-events-none absolute right-4 top-3 z-[1] px-2.5 py-1 ka-micro font-semibold tracking-[0.12em] ${memorySectionMeta.history.ornamentClass}`}>
                {memorySectionMeta.history.ornamentLabel}
              </div>
              <button 
                onClick={() => setIsHistoryConfigOpen(!isHistoryConfigOpen)}
                className={`relative z-10 w-full flex items-center justify-between p-3.5 font-semibold text-sm transition-colors ${memorySectionMeta.history.header}`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center border ${memorySectionMeta.history.chip} ${memorySectionMeta.history.chipShape}`}>
                    <History size={16} />
                  </div>
                  <div className="min-w-0 text-left">
                    <div className="truncate">{t.contextWindowWithEditor}</div>
                    <div className={`ka-micro font-medium tracking-[0.08em] uppercase ${isDarkMode ? 'text-[#6dbba8]' : 'text-[#3d8e7a]'}`}>{memorySectionMeta.history.note}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`px-2 py-0.5 rounded-full ka-micro font-semibold ${memorySectionMeta.history.badge}`}>{localContextLimit}</span>
                  {isHistoryConfigOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </div>
              </button>
              
              <Collapse isOpen={isHistoryConfigOpen}>
                <div className="p-3 flex flex-col gap-4">
                  {/* P1 #37: the editable "Context Limit" input moved to Settings >
                      Memory & Context. We still show the current value read-only
                      so users know at a glance how the history list is sliced. */}
                  <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-4">
                        <label className={`ka-label ${textClass}`}>{t.contextLimit}</label>
                        <span className={`ka-value font-semibold ${textClass}`}>{localContextLimit}</span>
                        <span className={`ka-copy-xs opacity-60 ${textClass}`}>
                          {language === 'zh' ? '（在设置 → 记忆与上下文中修改）' : '(edit in Settings → Memory & Context)'}
                        </span>
                      </div>
                      <button 
                        onClick={() => setIsPinnedModalOpen(true)}
                      className={`flex items-center gap-2 px-3 py-1 rounded ka-label font-semibold transition-colors border whitespace-nowrap ${isDarkMode ? 'border-[#6b5238]/50 text-[#d8b98b] hover:bg-white/6' : 'border-[#d4c1a5] text-[#9d7230] hover:bg-[#faf5ed]'}`}
                      >
                         <Pin size={12} className="fill-current" />
                         {t.viewPinned}
                      </button>
                  </div>
                  {/* ... rest of history editor ... */}
                  {/* --- HISTORY SEARCH BAR (MOVED HERE & OPTIMIZED FOR MOBILE) --- */}
                  <div className={`flex items-center gap-1.5 p-1.5 rounded border ${isDarkMode ? 'bg-[#111413] border-[#2a3530]/40' : 'bg-[#f5f8f6] border-[#d0e8e0]'}`}>
                      <Search size={14} className="opacity-50 flex-shrink-0 ml-1" />
                      <input 
                          value={historySearchQuery}
                          onChange={(e) => setHistorySearchQuery(e.target.value)}
                          placeholder="Search..."
                          className={`flex-1 bg-transparent outline-none ka-copy-sm ${textClass} placeholder:opacity-40 min-w-0`} // Added min-w-0 for flex shrinking
                      />
                      {historySearchMatches.length > 0 && (
                          <div className={`flex items-center gap-1 pl-1.5 border-l ${isDarkMode ? 'border-white/10' : 'border-gray-300'} flex-shrink-0`}>
                              <span className="ka-micro opacity-70 whitespace-nowrap min-w-[30px] text-center">
                                  {historySearchIndex + 1}/{historySearchMatches.length}
                              </span>
                              <div className="flex items-center">
                                <button onClick={handlePrevMatch} className={`p-1 hover:bg-black/10 rounded transition-colors ${textClass}`} title={language === 'zh' ? '上一个匹配' : 'Previous Match'}>
                                    <ArrowUp size={14}/>
                                </button>
                                <button onClick={handleNextMatch} className={`p-1 hover:bg-black/10 rounded transition-colors ${textClass}`} title={language === 'zh' ? '下一个匹配' : 'Next Match'}>
                                    <ArrowDown size={14}/>
                                </button>
                              </div>
                          </div>
                      )}
                  </div>
                  
                  <div className="flex gap-2">
                    <button onClick={(e) => { e.stopPropagation(); if(onInsertMessage) onInsertMessage(null, 'model'); }} className={`flex-1 flex items-center justify-center gap-2 py-2 rounded ka-label font-semibold border border-dashed transition-colors ${isDarkMode ? 'border-[#2a3530] text-[#6dbba8]/60 hover:border-[#3d8e7a] hover:text-[#6dbba8]' : 'border-[#d0e8e0] text-[#3d8e7a]/60 hover:border-[#3d8e7a] hover:text-[#3d8e7a]'}`}>
                        <Plus size={14} /> {t.addMessage} ({t.roleModel})
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); if(onInsertMessage) onInsertMessage(null, 'user'); }} className={`flex-1 flex items-center justify-center gap-2 py-2 rounded ka-label font-semibold border border-dashed transition-colors ${isDarkMode ? 'border-[#2a3530] text-[#6dbba8]/60 hover:border-[#3d8e7a] hover:text-[#6dbba8]' : 'border-[#d0e8e0] text-[#3d8e7a]/60 hover:border-[#3d8e7a] hover:text-[#3d8e7a]'}`}>
                        <Plus size={14} /> {t.addMessage} ({t.roleUser})
                    </button>
                  </div>

                  <div className={`rounded flex flex-col h-80 border overflow-hidden ${isDarkMode ? 'bg-[#111413] border-[#2a3530]/40' : 'bg-[#f5f8f6] border-[#d0e8e0]'}`}>
                    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto scrollbar-thin p-3">
                        {sortedMessages.length === 0 && <div className="text-center opacity-50 ka-copy-sm pt-10">{t.noHistory}</div>}
                        {sortedMessages.length > 0 && (
                          <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
                            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                              const index = virtualRow.index;
                              const msg = sortedMessages[index];
                              const isIncludedInContext = index >= cutoffIndex;
                              const isEditing = editingMessageId === msg.id;
                              const isUser = msg.role === 'user';
                              const msgNumber = index + 1;
                              const isDragging = draggedItemIndex === index;
                              const isMenuOpen = mobileMenuOpenId === msg.id;
                              const isSearchMatch = historySearchMatches[historySearchIndex] === msg.id;

                              return (
                                <div
                                    key={msg.id}
                                    data-index={index}
                                    ref={rowVirtualizer.measureElement}
                                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)` }}
                                >
                                  <div
                                    id={`ctx-editor-item-${msg.id}`}
                                    className={`group relative flex flex-col gap-1 pb-4 transition-all duration-300 ${!isIncludedInContext ? 'opacity-40 grayscale' : ''} ${isDragging ? 'opacity-20' : ''} ${isSearchMatch ? (isDarkMode ? 'ring-2 ring-yellow-500/50 bg-yellow-900/20 rounded p-1 -m-1' : 'ring-2 ring-yellow-400 bg-yellow-50 rounded p-1 -m-1') : ''}`}
                                    draggable={!!onReorderMessages}
                                    onDragStart={(e) => handleDragStart(e, index)}
                                    onDragOver={(e) => handleDragOver(e, index)}
                                    onDrop={(e) => handleDrop(e, index)}
                                  >
                                    {index === cutoffIndex && index > 0 && (
                                        <div className="flex items-center gap-2 my-2 opacity-100">
                                            <div className="h-px flex-1 bg-purple-500/50"></div>
                                            <span className="ka-micro text-purple-500 font-semibold uppercase">{t.contextStart}</span>
                                            <div className="h-px flex-1 bg-purple-500/50"></div>
                                        </div>
                                    )}
                                    <div className={`flex items-center justify-center gap-2 mb-1 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
                                       <div className="hidden md:block cursor-grab active:cursor-grabbing opacity-30 hover:opacity-80"><GripVertical size={12} /></div>
                                       <div className="flex md:hidden gap-1">
                                          <button onClick={(e) => { e.stopPropagation(); if (index > 0 && onReorderMessages) onReorderMessages(index, index - 1); }} className={`p-1 rounded bg-black/20 ${textClass} disabled:opacity-20`} disabled={index === 0}><ArrowUp size={10} /></button>
                                          <button onClick={(e) => { e.stopPropagation(); if (index < sortedMessages.length - 1 && onReorderMessages) onReorderMessages(index, index + 1); }} className={`p-1 rounded bg-black/20 ${textClass} disabled:opacity-20`} disabled={index === sortedMessages.length - 1}><ArrowDown size={10} /></button>
                                       </div>
                                       {msg.isHidden && <div className="px-1 bg-red-900/50 text-red-300 rounded ka-micro font-semibold flex items-center gap-1" title={t.hiddenMsgTooltip}><EyeOff size={10} /></div>}
                                       {msg.isPinned && <div className="px-1 bg-yellow-600/50 text-yellow-200 rounded ka-micro font-semibold flex items-center gap-1" title={t.pin}><Pin size={10} className="fill-current" /></div>}
                                       <span className={`ka-micro font-semibold opacity-30 ${textClass}`}>#{msgNumber}</span>
                                       <Clock size={10} className="opacity-40" />
                                       <span className={`ka-micro tracking-[0.14em] opacity-50 ${textClass}`}>{formatKyotoTime(msg.timestamp)}</span>
                                    </div>
                                    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
                                        <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold ${isUser ? (isDarkMode ? 'bg-yellow-700 text-yellow-100' : 'bg-yellow-200 text-yellow-800') : (isDarkMode ? 'bg-gray-700 text-white' : 'bg-white border text-gray-800')}`}>{isUser ? 'YOU' : '久'}</div>
                                        <div className={`relative flex-1 min-w-0 max-w-[85%] rounded-lg p-2 text-sm transition-colors ${isEditing ? (isDarkMode ? 'bg-blue-900/20 border border-blue-500/50' : 'bg-blue-50 border border-blue-300') : (isUser ? (isDarkMode ? 'bg-yellow-900/20 text-yellow-100' : 'bg-yellow-100 text-yellow-900') : (isDarkMode ? 'bg-[#1a1e1c] text-gray-300' : 'bg-white border text-gray-800'))}`}>
                                            {isEditing ? (
                                                <div className="flex flex-col gap-2">
                                                    <textarea value={editMessageText} onChange={(e) => setEditMessageText(e.target.value)} className={`w-full h-24 p-2 rounded text-base md:text-sm ka-input-copy resize-none outline-none focus:ring-1 focus:ring-blue-500 ${inputBgClass} ${textClass}`} />
                                                    <div className="flex justify-end gap-2"><button onClick={cancelEditingMessage} className={`p-1 px-2 rounded ka-label font-semibold border ${isDarkMode ? 'border-gray-600 hover:bg-gray-700' : 'border-gray-300 hover:bg-gray-200'}`}>CANCEL</button><button onClick={saveEditedMessage} className="flex items-center gap-1 p-1 px-2 rounded ka-label font-semibold bg-blue-600 text-white hover:bg-blue-500"><Check size={12} /> SAVE</button></div>
                                                </div>
                                            ) : (
                                                <div className="relative group/bubble" onClick={(e) => toggleMobileMenu(e, msg.id)}>
                                                    {msg.quote && <div className={`mb-1 p-1 rounded ka-micro border-l-2 opacity-70 ${isDarkMode ? 'bg-black/20 border-white/30' : 'bg-black/5 border-black/20'}`}><div className="flex items-center gap-1 font-semibold"><Quote size={8} /><span>{msg.quote.role === 'model' ? 'Kumiko' : 'You'}</span></div><p className="truncate italic">{msg.quote.text}</p></div>}
                                                    {(() => {
                                                      // P2 #6 Phase 1: route through shared resolver so imageId-based
                                                      // messages (post-migration) render the same button.
                                                      const msgImageUrl = resolveMessageImageSync(msg);
                                                      if (!msgImageUrl) return null;
                                                      return (
                                                        <button onClick={(e) => { e.stopPropagation(); if (onImageClick) onImageClick(msgImageUrl); }} className={`mb-1 p-1 rounded ka-micro border flex items-center gap-1 overflow-hidden cursor-pointer hover:opacity-80 transition-opacity w-full text-left ${isDarkMode ? 'bg-blue-900/20 border-blue-500/30 text-blue-300' : 'bg-blue-50 border-blue-200 text-blue-700'}`} title={language === 'zh' ? '查看图片' : 'View Image'}><ImageIcon size={10} className="flex-shrink-0" /><span className="truncate opacity-80 underline decoration-dotted">{msgImageUrl}</span></button>
                                                      );
                                                    })()}
                                                    <p className="whitespace-pre-wrap leading-relaxed break-words">{msg.text}</p>
                                                    <div className={`absolute -top-9 ${isUser ? '-left-2' : '-right-2'} gap-1 bg-black/90 rounded px-2 py-1.5 shadow-xl z-20 border border-white/10 ${isMenuOpen ? 'flex animate-in zoom-in-95 duration-200' : 'hidden'} md:hidden md:group-hover/bubble:flex after:content-[''] after:absolute after:-bottom-4 after:left-0 after:w-full after:h-4`}>
                                                        {onJumpToMessage && <button onClick={(e) => { e.stopPropagation(); onJumpToMessage(msg.id); }} className="p-1 text-purple-400 hover:text-purple-300 transition-colors" title={t.jumpToContext}><LocateFixed size={12} /></button>}
                                                        <button onClick={(e) => { e.stopPropagation(); startEditingMessage(msg); }} className="p-1 text-blue-400 hover:text-blue-300 transition-colors" title={t.editTooltip}><Edit2 size={12} /></button>
                                                        {onInsertMessage && <button onClick={(e) => handleInsertMsg(e, msg.id)} className="p-1 text-green-400 hover:text-green-300 transition-colors" title={t.insertAfter}><ListPlus size={12} /></button>}
                                                        {onToggleHidden && <button onClick={(e) => { e.stopPropagation(); onToggleHidden(msg.id); }} className="p-1 text-gray-400 hover:text-gray-200 transition-colors" title={msg.isHidden ? t.unhideTooltip : t.hideTooltip}>{msg.isHidden ? <Eye size={12} className="text-yellow-500" /> : <EyeOff size={12} />}</button>}
                                                        {onTogglePin && <button onClick={(e) => { e.stopPropagation(); onTogglePin(msg.id); }} className={`p-1 transition-colors ${msg.isPinned ? 'text-yellow-500' : 'text-gray-400 hover:text-yellow-200'}`} title={msg.isPinned ? t.unpin : t.pin}><Pin size={12} className={msg.isPinned ? "fill-current" : ""} /></button>}
                                                        <div className="w-px bg-white/20 mx-1"></div>
                                                        {onDeleteMessage && <button onClick={(e) => handleDeleteMsgClick(e, msg.id)} className={`p-1 transition-all ${confirmMsgDeleteId === msg.id ? 'bg-red-600 text-white px-2 rounded ka-micro font-semibold w-auto' : 'text-red-400 hover:text-red-300'}`} title={t.hardDeleteTooltip}>{confirmMsgDeleteId === msg.id ? t.confirmDeleteMsg : <Trash2 size={12} />}</button>}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                    </div>
                    <div className={`p-2 ka-micro flex justify-end items-center ${isDarkMode ? 'bg-[#111413] text-[#6dbba8]/50' : 'bg-[#f0f5f3] text-[#3d8e7a]/60'}`}><span>{formattedFooter}</span></div>
                  </div>
                </div>
              </Collapse>
            </div>

            {/* Section 5: Default World Book */}
            <div className={`relative rounded-[1.1rem] border overflow-hidden transition-all duration-300 shadow-[0_10px_24px_rgba(0,0,0,0.04)] ${memorySectionMeta.official.shell}`}>
              <div className={`pointer-events-none absolute inset-y-0 left-0 w-[3px] ${memorySectionMeta.official.accentStrip}`} />
              <div className={`pointer-events-none absolute right-4 top-3 z-[1] px-2.5 py-1 ka-micro font-semibold tracking-[0.12em] ${memorySectionMeta.official.ornamentClass}`}>
                {memorySectionMeta.official.ornamentLabel}
              </div>
              <button 
                onClick={() => setIsDefaultBookOpen(!isDefaultBookOpen)}
                className={`relative z-10 w-full flex items-center justify-between p-3.5 font-semibold text-sm transition-colors ${memorySectionMeta.official.header}`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center border ${memorySectionMeta.official.chip} ${memorySectionMeta.official.chipShape}`}>
                    <BookOpen size={16} />
                  </div>
                  <div className="min-w-0 text-left">
                    <div className="truncate">{t.officialLore}</div>
                    <div className={`ka-micro font-medium tracking-[0.08em] uppercase ${isDarkMode ? 'text-[#b0a0d0]' : 'text-[#8a7ab5]'}`}>{memorySectionMeta.official.note}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${memorySectionMeta.official.badge}`}>{systemEntries.length}</span>
                  {isDefaultBookOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </div>
              </button>

              <Collapse isOpen={isDefaultBookOpen}>
                <div className="p-3 flex flex-col gap-3">
                  <p className={`ka-copy-sm opacity-70 ${textClass}`}>{t.officialLoreHelp}</p>
                  {systemEntries.map((entry) => {
                    const isExpanded = expandedEntryIds.has(entry.id);
                    // Determine if this is a recommended Core Entry
                    const isCore = CORE_MEMORY_IDS.has(entry.id);
                    
                    return (
                      <div key={entry.id} className={`relative rounded border flex flex-col transition-all overflow-hidden ${isDarkMode ? 'bg-[#1c1a20] border-[#2a2830]/60' : 'bg-[#fcfaff] border-[#e0d8ec]'} ${!entry.isActive ? 'opacity-80' : ''}`}>
                          <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l bg-gradient-to-b from-[#b0a0d0] to-[#8a7ab5]" />
                          <div className={`flex items-center justify-between p-3 pl-4 cursor-pointer ${isDarkMode ? 'hover:bg-white/4' : 'hover:bg-black/[0.02]'}`} onClick={() => toggleEntryExpansion(entry.id)}>
                            <div className="flex items-center gap-2 flex-1 mr-2 min-w-0">
                                <Lock size={12} className="opacity-50 flex-shrink-0" />
                                <span className={`ka-label font-semibold uppercase truncate flex-1 ${isDarkMode ? 'text-[#b0a0d0]' : 'text-[#7a5fb5]'} ${!entry.isActive ? 'line-through opacity-50' : ''}`}>{entry.title || 'Untitled'}</span>
                                {isCore && (
                                    <span className={`ml-1 px-1.5 py-0.5 rounded-[2px] text-[8px] md:text-[9px] font-bold font-mono flex items-center gap-1 shadow-sm animate-pulse flex-shrink-0 whitespace-nowrap ${isDarkMode ? 'bg-[#d7bb88] text-[#20160b]' : 'bg-[#e8d3ae] text-[#6b4c1d]'}`}>
                                        <Star size={8} fill="black" /> {t.coreBadge}
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <button 
                                onClick={(e) => { e.stopPropagation(); updateEntry(entry.id, 'isActive', !entry.isActive); }} 
                                className={`p-1.5 rounded-full transition-all flex items-center gap-1 ${entry.isActive ? 'bg-green-500/10 text-green-500 hover:bg-green-500/20' : 'bg-blue-500/10 text-blue-500 hover:bg-blue-500/20'}`} 
                                title={entry.isActive ? (language === 'zh' ? '常驻激活 (上下文)' : 'Always Active (Context)') : (language === 'zh' ? '自动搜索 (RAG 模式)' : 'Auto-Search (RAG Mode)')}
                              >
                                  {entry.isActive ? <Power size={14} /> : <Search size={14} />}
                                  {!entry.isActive && <span className="text-[9px] font-bold">RAG</span>}
                              </button>
                              {isExpanded ? <ChevronUp size={14} className="opacity-50" /> : <ChevronDown size={14} className="opacity-50" />}
                            </div>
                          </div>
                          <Collapse isOpen={isExpanded} duration={180}>
                            <div className="p-3 pl-4 pt-0">
                              <div className={`mb-2 font-mincho font-semibold text-sm break-words leading-tight ${isDarkMode ? 'text-[#e8e0f0]' : 'text-[#3a3248]'}`}>
                                  {entry.title}
                              </div>

                              {isCore && (
                                  <div className={`mb-2 p-2 rounded border ka-micro flex items-center gap-2 ${isDarkMode ? 'border-[#d8b98b]/25 bg-[#2a2118] text-[#eadbc4]' : 'border-[#e8d8b9] bg-[#fffaf1] text-[#8f6631]'}`}>
                                      <Star size={12} className={`${isDarkMode ? 'text-[#d8b98b]' : 'text-[#b88a42]'} flex-shrink-0`} />
                                      <p>{t.coreRecommendation}</p>
                                  </div>
                              )}
                              <div className={`w-full max-h-48 p-2 rounded text-base md:text-sm ka-input-copy overflow-y-auto scrollbar-thin whitespace-pre-wrap ${isDarkMode ? 'bg-[#16141a] text-[#cfc4db]' : 'bg-[#f5f2f8] text-[#524866]'}`}>
                                {entry.content || t.contentPlaceholder}
                              </div>
                            </div>
                          </Collapse>
                      </div>
                    );
                  })}
                </div>
              </Collapse>
            </div>

            {/* Section 6: Custom World Book */}
            <div className={`relative rounded-[1.1rem] border overflow-hidden transition-all duration-300 shadow-[0_10px_24px_rgba(0,0,0,0.04)] ${memorySectionMeta.custom.shell}`}>
              <div className={`pointer-events-none absolute inset-y-0 left-0 w-[3px] ${memorySectionMeta.custom.accentStrip}`} />
              <div className={`pointer-events-none absolute right-4 top-3 z-[1] px-2.5 py-1 ka-micro font-semibold tracking-[0.12em] ${memorySectionMeta.custom.ornamentClass}`}>
                {memorySectionMeta.custom.ornamentLabel}
              </div>
              <button 
                onClick={() => setIsCustomBookOpen(!isCustomBookOpen)}
                className={`relative z-10 w-full flex items-center justify-between p-3.5 font-semibold text-sm transition-colors ${memorySectionMeta.custom.header}`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center border ${memorySectionMeta.custom.chip} ${memorySectionMeta.custom.chipShape}`}>
                    <Bookmark size={16} />
                  </div>
                  <div className="min-w-0 text-left">
                    <div className="truncate">{t.customLore}</div>
                    <div className={`ka-micro font-medium tracking-[0.08em] uppercase ${isDarkMode ? 'text-[#8eaac8]' : 'text-[#6882a8]'}`}>{memorySectionMeta.custom.note}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${memorySectionMeta.custom.badge}`}>{customEntries.length}</span>
                  {isCustomBookOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </div>
              </button>

              <Collapse isOpen={isCustomBookOpen}>
                <div className="p-3 flex flex-col gap-3">
                  <p className={`ka-copy-sm opacity-70 ${textClass}`}>{t.customLoreHelp}</p>
                  {customEntries.length === 0 && <div className={`text-center py-4 ka-copy-sm border border-dashed rounded ${isDarkMode ? 'border-[#252a34] text-[#8eaac8]/50' : 'border-[#d5e0ec] text-[#6882a8]/60'}`}>{t.noCustomEntries}</div>}
                  {customEntries.map((entry) => {
                    const isExpanded = expandedEntryIds.has(entry.id);
                    return (
                      <div key={entry.id} className={`relative rounded border flex flex-col transition-all overflow-hidden ${isDarkMode ? 'bg-[#14161c] border-[#252a34]/50' : 'bg-[#f7f9fc] border-[#d5e0ec]'} ${!entry.isActive ? 'opacity-80' : ''}`}>
                          <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l bg-gradient-to-b from-[#8eaac8] to-[#6882a8]" />
                          <div className={`flex items-center justify-between p-3 pl-4 cursor-pointer ${isDarkMode ? 'hover:bg-white/4' : 'hover:bg-black/[0.02]'}`} onClick={() => toggleEntryExpansion(entry.id)}>
                            <div className="flex items-center gap-2 flex-1 mr-2">
                               {entry.isHighPriority ? <Zap size={12} className="text-yellow-500 fill-yellow-500" /> : <Bookmark size={12} className="opacity-50" />}
                               <input value={entry.title} onChange={(e) => updateEntry(entry.id, 'title', e.target.value)} onClick={(e) => e.stopPropagation()} className={`bg-transparent border-b border-transparent focus:border-[#6882a8] outline-none ka-label font-semibold uppercase truncate ${isDarkMode ? 'text-[#8eaac8]' : 'text-[#4a6080]'} ${!entry.isActive ? 'line-through opacity-50' : ''}`} placeholder="Title" />
                            </div>
                            <div className="flex items-center gap-2">
                              <button 
                                onClick={(e) => { e.stopPropagation(); updateEntry(entry.id, 'isActive', !entry.isActive); }} 
                                className={`p-1.5 rounded-full transition-all flex items-center gap-1 ${entry.isActive ? 'bg-green-500/10 text-green-500 hover:bg-green-500/20' : 'bg-blue-500/10 text-blue-500 hover:bg-blue-500/20'}`} 
                                title={entry.isActive ? (language === 'zh' ? '常驻激活 (上下文)' : 'Always Active (Context)') : (language === 'zh' ? '自动搜索 (RAG 模式)' : 'Auto-Search (RAG Mode)')}
                              >
                                  {entry.isActive ? <Power size={14} /> : <Search size={14} />}
                                  {!entry.isActive && <span className="text-[9px] font-bold">RAG</span>}
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); updateEntry(entry.id, 'isHighPriority', !entry.isHighPriority); }} className={`p-1 rounded hover:bg-white/10 ${entry.isHighPriority ? 'text-yellow-500' : 'text-gray-500'}`} title={entry.isHighPriority ? t.highPriorityTooltip : t.normalPriorityTooltip}><Zap size={14} /></button>
                              <button onClick={(e) => { e.stopPropagation(); handleDeleteEntry(entry.id); }} className={`p-1 rounded hover:bg-red-900/50 ${confirmDeleteId === entry.id ? 'text-red-500' : 'text-gray-500'}`}><Trash2 size={14} /></button>
                              {isExpanded ? <ChevronUp size={14} className="opacity-50" /> : <ChevronDown size={14} className="opacity-50" />}
                            </div>
                          </div>
                          <Collapse isOpen={isExpanded} duration={180}><div className="p-3 pl-4 pt-0"><textarea value={entry.content} onChange={(e) => updateEntry(entry.id, 'content', e.target.value)} className={`w-full h-32 p-2 rounded text-base md:text-sm ka-input-copy resize-y scrollbar-thin outline-none focus:ring-1 focus:ring-[#6882a8]/40 ${isDarkMode ? 'bg-[#12141a] border-[#252a34]' : 'bg-[#f5f7fb] border-[#d5e0ec]'} border ${textClass}`} placeholder={t.contentPlaceholder} /></div></Collapse>
                      </div>
                    );
                  })}
                  <button onClick={handleAddCustomEntry} className={`w-full py-2 border-2 border-dashed rounded text-xs font-bold transition-all flex items-center justify-center gap-2 ${isDarkMode ? 'border-[#252a34] text-[#8eaac8]/60 hover:border-[#6882a8] hover:text-[#8eaac8]' : 'border-[#d5e0ec] text-[#6882a8]/60 hover:border-[#6882a8] hover:text-[#6882a8]'}`}><Plus size={14} /> {t.addCustomEntry}</button>
                </div>
              </Collapse>
            </div>

          </div>
        </div>

        {/* Footer Status Bar */}
        <div className={`px-4 py-2 border-t flex justify-between items-center ka-micro transition-colors duration-300 ${isDarkMode ? 'bg-[#1e1a15] border-[#4f3926]' : 'bg-[#fbf9f5] border-[#ece3d8]'}`}>
           <div className="flex items-center gap-2">
              {isDirty ? (
                  <div className="flex items-center gap-1.5 text-orange-500 animate-pulse font-bold">
                      <AlertTriangle size={12} />
                      <span>{t.unsaved || "Unsaved Changes"}</span>
                  </div>
              ) : (
                  <div className="flex items-center gap-1.5 text-green-600 font-bold opacity-80">
                      <Check size={12} />
                      <span>{t.allNominal || "System Nominal"}</span>
                  </div>
              )}
           </div>
           <span className={`opacity-40 tracking-widest ${textClass}`}>AMADEUS MEMORY BANK</span>
        </div>

      </div>
      <PinnedModal
        isOpen={isPinnedModalOpen}
        onCloseModal={() => setIsPinnedModalOpen(false)}
        onClosePanel={onClose}
        pinnedMessages={pinnedMessages}
        sortedMessages={sortedMessages}
        onJumpToMessage={onJumpToMessage}
        onTogglePin={onTogglePin}
        isDarkMode={isDarkMode}
        t={t}
      />
      {showArchiveConfirm && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setShowArchiveConfirm(false)}>
          <div className={`mx-4 max-w-sm w-full rounded-2xl p-5 shadow-2xl border ${isDarkMode ? 'bg-[#1e1a15] border-[#4f3926] text-[#eadfce]' : 'bg-white border-[#e8ddcf] text-[#4b3a2a]'}`} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <RefreshCw size={16} className={isDarkMode ? 'text-[#d7bb88]' : 'text-[#b08957]'} />
              <h3 className="font-semibold text-sm">{language === 'zh' ? '确认归档' : 'Confirm Archive'}</h3>
            </div>
            <p className={`text-xs leading-relaxed mb-4 ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              {language === 'zh' ? '将当前未归档的对话总结并写入记忆系统。此操作会影响：核心记忆缓冲、久美子笔记本、RAG 记忆块。需要消耗一次 LLM 调用。' : 'Summarize and archive the current unsaved conversation. This will update: core memory buffer, Kumiko\'s notebook, and RAG memory chunks. Requires one LLM call.'}
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowArchiveConfirm(false)} className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${isDarkMode ? 'text-gray-400 hover:bg-white/5' : 'text-gray-500 hover:bg-black/5'}`}>
                {language === 'zh' ? '取消' : 'Cancel'}
              </button>
              <button onClick={async () => { setShowArchiveConfirm(false); if (onManualSummary) await onManualSummary(); }} className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors ${isDarkMode ? 'bg-[#d7bb88]/20 text-[#d7bb88] hover:bg-[#d7bb88]/30' : 'bg-[#c9983f]/15 text-[#b08957] hover:bg-[#c9983f]/30'}`}>
                {language === 'zh' ? '确认归档' : 'Archive'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
