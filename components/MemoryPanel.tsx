
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { X, BrainCircuit, ChevronDown, ChevronUp, Plus, Trash2, ArrowUp, ArrowDown, BookOpen, RotateCcw, Lock, History, Bookmark, Edit2, Check, Clock, ListPlus, GripVertical, EyeOff, Eye, Quote, Pin, StickyNote, Image as ImageIcon, LocateFixed, NotebookPen, Zap, RefreshCw, AlertTriangle, Search, Power, Star } from 'lucide-react';
import { WorldBookEntry, Message, Language, AnchorEntry } from '../types';
import { DEFAULT_WORLD_BOOK, UI_TRANSLATIONS, KUMIKO_EMOTION_IMAGES, LOCALIZED_WORLD_BOOK } from '../constants';

interface MemoryPanelProps {
  isOpen: boolean;
  onClose: () => void;
  memoryContent: string;
  contextLimit: number; 
  messages: Message[]; 
  worldBook: WorldBookEntry[];
  onSave: (newCoreMemory: string, newWorldBook: WorldBookEntry[], newContextLimit: number) => void;
  isDarkMode: boolean;
  turnCount?: number;
  summaryProgressText?: string;
  language?: Language;
  // New Handlers
  onUpdateMessage?: (id: string, newText: string) => void;
  onDeleteMessage?: (id: string) => void;
  onInsertMessage?: (afterId: string | null, role: 'user' | 'model') => void;
  onReorderMessages?: (dragIndex: number, hoverIndex: number) => void;
  onToggleHidden?: (id: string) => void;
  onTogglePin?: (id: string) => void; 
  onJumpToMessage?: (id: string) => void; // New Prop for Jump functionality
  
  // Anchors
  anchors?: AnchorEntry[];
  onDeleteAnchor?: (id: string) => void;

  // Image Viewer
  onImageClick?: (src: string) => void;

  // New: Notebook (Read Only)
  kumikoNotebook?: string;
}

// DEFINITION OF CORE MEMORIES THAT SHOULD BE RECOMMENDED
const CORE_MEMORY_IDS = new Set([
    'rag_hist_middle_school', // Origin of trauma & motivation
    'rag_hist_y3_selection',  // Peak character development (Maturity)
    'rag_char_reina_details', // Essential relationship
    'rag_item_hairpin'        // Romance & grounding
]);

const MindMapSection: React.FC<{ isDarkMode: boolean; textClass: string; language: string }> = ({ isDarkMode, textClass, language }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [entities, setEntities] = useState<Array<{ id: string; name: string; type: string }>>([]);
  const [relations, setRelations] = useState<Array<{ fromId: string; toId: string; relationType: string; emotion?: string }>>([]);

  useEffect(() => {
    if (!isOpen) return;
    const load = async () => {
      try {
        const { db } = await import('../services/db');
        const e = await db.graphEntities.toArray();
        const r = await db.graphRelations.toArray();
        setEntities(e);
        setRelations(r);
      } catch { /* ignore */ }
    };
    load();
  }, [isOpen]);

  const typeColors: Record<string, string> = {
    person: isDarkMode ? 'bg-blue-900/40 text-blue-300 border-blue-500/30' : 'bg-blue-50 text-blue-700 border-blue-200',
    event: isDarkMode ? 'bg-orange-900/40 text-orange-300 border-orange-500/30' : 'bg-orange-50 text-orange-700 border-orange-200',
    place: isDarkMode ? 'bg-green-900/40 text-green-300 border-green-500/30' : 'bg-green-50 text-green-700 border-green-200',
    concept: isDarkMode ? 'bg-purple-900/40 text-purple-300 border-purple-500/30' : 'bg-purple-50 text-purple-700 border-purple-200',
  };

  return (
    <div className={`rounded border overflow-hidden transition-all duration-300 ${isDarkMode ? 'border-yellow-900/30' : 'border-gray-200'}`}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full flex items-center justify-between p-3 font-mono font-bold text-sm transition-colors ${isDarkMode ? 'bg-cyan-900/10 hover:bg-cyan-900/20 text-cyan-400' : 'bg-cyan-50 hover:bg-cyan-100 text-cyan-700'}`}
      >
        <div className="flex items-center gap-2">
          <BrainCircuit size={16} />
          <span>{language === 'zh' ? '心智图谱' : 'Mind Map'}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${isDarkMode ? 'bg-cyan-900/50' : 'bg-cyan-200'}`}>{entities.length}</span>
        </div>
        {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>

      {isOpen && (
        <div className="p-3 animate-in slide-in-from-top-2 duration-200 flex flex-col gap-3">
          <p className={`text-xs font-mono opacity-70 ${textClass}`}>
            {language === 'zh'
              ? '久美子的记忆关系图谱。每天夜间自动整理对话，提取人物、事件和关系。'
              : "Kumiko's memory relationship graph. Conversations are automatically consolidated nightly into entities and relations."}
          </p>

          {entities.length === 0 ? (
            <div className={`text-center py-6 opacity-80 text-xs font-mono border border-dashed rounded ${isDarkMode ? 'border-gray-700 text-gray-400' : 'border-gray-400 text-gray-600'}`}>
              {language === 'zh' ? '图谱为空。对话一天后将自动开始生成。' : 'Graph is empty. It will auto-generate after a day of conversation.'}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {entities.map(e => (
                  <div key={e.id} className={`px-2 py-1 rounded-full border text-[10px] font-mono ${typeColors[e.type] || typeColors.concept}`}>
                    {e.name}
                  </div>
                ))}
              </div>

              {relations.length > 0 && (
                <div className={`text-[10px] font-mono space-y-1 mt-2 p-2 rounded ${isDarkMode ? 'bg-black/30' : 'bg-gray-50'}`}>
                  {relations.slice(-15).map((r, i) => (
                    <div key={i} className="opacity-80">
                      <span className="font-bold">{r.fromId}</span>
                      {' → '}
                      <span className={isDarkMode ? 'text-cyan-400' : 'text-cyan-600'}>[{r.relationType}]</span>
                      {r.emotion && <span className="opacity-60"> ({r.emotion})</span>}
                      {' → '}
                      <span className="font-bold">{r.toId}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
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
  isDarkMode,
  turnCount = 0,
  summaryProgressText = '',
  language = 'zh',
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
  kumikoNotebook = ""
}) => {
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

  const [isReady, setIsReady] = useState(false);
  useEffect(() => {
    if (isOpen) {
      const id = requestAnimationFrame(() => setIsReady(true));
      return () => cancelAnimationFrame(id);
    }
    setIsReady(false);
  }, [isOpen]);

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

  const formatKyotoTime = (timestamp: number) => {
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

  if (!isOpen) return null;

  const bgClass = isDarkMode ? 'bg-black/95 border-yellow-900/50' : 'bg-white/95 border-yellow-500/30';
  const textClass = isDarkMode ? 'text-yellow-100' : 'text-gray-800';
  const titleClass = isDarkMode ? 'text-yellow-500' : 'text-[#b8860b]';
  const inputBgClass = isDarkMode ? 'bg-[#111] border-yellow-900/30' : 'bg-gray-50 border-gray-300';
  const cardHighlightBg = isDarkMode ? 'bg-yellow-900/10 border-yellow-600/30' : 'bg-yellow-50 border-yellow-200';

  const pinnedMessages = sortedMessages.filter(m => m.isPinned && !m.isHidden);
  const cutoffIndex = Math.max(0, sortedMessages.length - localContextLimit);
  const formattedFooter = t.viewerFooter?.replace('{0}', localContextLimit.toString()) || "Showing messages";

  // --- PINNED MODAL ---
  const PinnedModal = () => {
      if (!isPinnedModalOpen) return null;
      return (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 backdrop-blur-sm animate-in fade-in safe-area-padding-modal" style={{ background: 'radial-gradient(circle, rgba(0,0,0,0.6) 30%, rgba(0,0,0,0) 100%)' }}>
             <div className={`w-full max-w-md max-h-[70vh] flex flex-col rounded-lg border shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 ${bgClass}`}>
                <div className={`flex items-center justify-between p-3 border-b ${isDarkMode ? 'border-yellow-900/30' : 'border-gray-200'}`}>
                   <div className="flex items-center gap-2 text-yellow-500">
                      <Pin size={16} className="fill-current" />
                      <span className="font-bold font-mono text-sm tracking-widest uppercase">{t.pinnedMemoriesTitle}</span>
                   </div>
                   <button onClick={() => setIsPinnedModalOpen(false)} className={`p-1 rounded-full hover:bg-white/10 ${textClass}`}>
                      <X size={18} />
                   </button>
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-thin">
                   {pinnedMessages.length === 0 && (
                       <div className="text-center opacity-50 text-xs font-mono py-10">{t.noPinnedMessages}</div>
                   )}
                   {pinnedMessages.map(msg => {
                       const contextIndex = sortedMessages.findIndex(m => m.id === msg.id) + 1;
                       return (
                       <div 
                         key={msg.id} 
                         onClick={() => {
                             if(onJumpToMessage) {
                                 onJumpToMessage(msg.id);
                                 setIsPinnedModalOpen(false);
                                 onClose();
                             }
                         }}
                         className={`p-3 rounded border text-xs relative cursor-pointer transition-all hover:scale-[1.01] ${isDarkMode ? 'bg-black/40 border-yellow-900/20 hover:bg-yellow-900/10' : 'bg-gray-50 border-gray-200 hover:bg-yellow-50'}`}
                         title={t.jumpToContext}
                       >
                           <div className="flex justify-between items-center mb-1 opacity-60 pointer-events-none">
                               <div className="flex items-center gap-2">
                                   <span className="font-bold font-mono text-yellow-500/80">#{contextIndex}</span>
                                   <span className="font-bold font-mono">{msg.role === 'model' ? 'Kumiko' : 'You'}</span>
                               </div>
                               <span className="font-mono text-[10px]">{formatKyotoTime(msg.timestamp)}</span>
                           </div>
                           <p className="whitespace-pre-wrap leading-relaxed pointer-events-none">{msg.text}</p>
                           {onTogglePin && (
                               <button 
                                 onClick={(e) => {
                                     e.stopPropagation();
                                     onTogglePin(msg.id);
                                 }}
                                 className="absolute top-2 right-2 text-yellow-500 hover:text-red-500 transition-colors p-1"
                                 title={t.unpin}
                               >
                                  <Pin size={12} className="fill-current" />
                               </button>
                           )}
                       </div>
                   )})}
                </div>
             </div>
          </div>
      );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm safe-area-padding-modal" style={{ background: 'radial-gradient(circle, rgba(0,0,0,0.5) 30%, rgba(0,0,0,0) 100%)' }}>
      <div className={`w-full max-w-2xl max-h-[85dvh] rounded-lg border shadow-2xl flex flex-col overflow-hidden animate-[breathe_0.3s_ease-out] ${bgClass}`}>
        
        {/* Header */}
        <div className={`flex items-center justify-between px-4 py-3 border-b ${isDarkMode ? 'border-yellow-900/30' : 'border-gray-200'}`}>
          <div className="flex items-center gap-2">
            <BrainCircuit size={20} className={titleClass} />
            <span className={`font-mono font-bold tracking-wider ${titleClass}`}>{t.memoryTitle}</span>
          </div>
          <button 
            onClick={onClose}
            className={`p-1 rounded-full hover:bg-red-500/20 hover:text-red-500 transition-colors ${textClass}`}
          >
            <X size={20} />
          </button>
        </div>

        {/* Scrollable Content Wrapper */}
        <div className="flex-1 overflow-y-auto w-full scrollbar-thin">
          {!isReady ? (
            <div className="flex items-center justify-center h-32 opacity-50">
              <RefreshCw size={20} className="animate-spin" />
            </div>
          ) : (
          <div className="p-4 flex flex-col gap-4">
            
            {/* Section 1: Core Memory */}
            <div className={`rounded border overflow-hidden transition-all duration-300 ${isDarkMode ? 'border-yellow-900/30' : 'border-gray-200'}`}>
              <button 
                onClick={() => setIsCoreOpen(!isCoreOpen)}
                className={`w-full flex items-center justify-between p-3 font-mono font-bold text-sm transition-colors ${isDarkMode ? 'bg-yellow-900/10 hover:bg-yellow-900/20 text-yellow-500' : 'bg-yellow-50 hover:bg-yellow-100 text-[#b8860b]'}`}
              >
                <div className="flex items-center gap-2">
                  <BrainCircuit size={16} />
                  <span>{t.coreMemory}</span>
                </div>
                {isCoreOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
              
              {isCoreOpen && (
                <div className="p-3 animate-in slide-in-from-top-2 duration-200">
                  <div className={`flex flex-col md:flex-row md:justify-between text-xs font-mono mb-2 opacity-70 gap-1 md:gap-0 ${textClass}`}>
                    <span>{t.coreMemoryHelp}</span>
                    <span className="text-yellow-500 font-bold">{t.nextSyncIn} {summaryProgressText}</span>
                  </div>
                  <textarea
                    value={localCoreMemory}
                    onChange={(e) => setLocalCoreMemory(e.target.value)}
                    className={`w-full h-40 p-3 rounded font-mono text-base md:text-sm resize-none scrollbar-thin outline-none focus:ring-1 focus:ring-yellow-600/50 ${inputBgClass} ${textClass}`}
                    placeholder={t.noCoreMemoryPlaceholder}
                  />
                </div>
              )}
            </div>

            {/* Section 2: Kumiko's Notebook */}
            <div className={`rounded border overflow-hidden transition-all duration-300 ${isDarkMode ? 'border-amber-900/30 bg-[#1a1510]' : 'border-amber-200 bg-[#fffdf0]'}`}>
              <button 
                onClick={() => setIsNotebookOpen(!isNotebookOpen)}
                className={`w-full flex items-center justify-between p-3 font-mono font-bold text-sm transition-colors ${isDarkMode ? 'bg-amber-900/20 hover:bg-amber-900/30 text-amber-500' : 'bg-amber-100 hover:bg-amber-200 text-amber-800'}`}
              >
                <div className="flex items-center gap-2">
                  <NotebookPen size={16} />
                  <span>{t.notebookTitle}</span>
                  <Lock size={12} className="opacity-50" />
                </div>
                {isNotebookOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
              
              {isNotebookOpen && (
                <div className="p-3 animate-in slide-in-from-top-2 duration-200 flex flex-col gap-2">
                  <div className={`text-xs font-mono opacity-70 mb-1 ${textClass}`}>
                    {t.notebookDesc}
                  </div>
                  <div className={`relative w-full h-48 p-4 rounded font-mono text-sm leading-relaxed overflow-y-auto scrollbar-thin border-2 border-double ${isDarkMode ? 'bg-[#15100a] border-amber-900/50 text-amber-100' : 'bg-white border-amber-200 text-gray-800'}`}>
                       <div className="absolute inset-0 pointer-events-none opacity-5" style={{ backgroundImage: `repeating-linear-gradient(transparent, transparent 23px, ${isDarkMode ? '#ffffff' : '#000000'} 24px)` }}></div>
                       {kumikoNotebook ? (
                           <div className="relative z-10">
                             {(() => {
                               try {
                                 const parsed = JSON.parse(kumikoNotebook);
                                 return (
                                   <div className="space-y-4">
                                     {parsed.user_profile && (
                                       <div>
                                         <h4 className="font-bold text-amber-600 dark:text-amber-400 mb-1">【用户档案】</h4>
                                         <p className="whitespace-pre-wrap pl-2 border-l-2 border-amber-500/30">{parsed.user_profile}</p>
                                       </div>
                                     )}
                                     {parsed.relationship_dynamics && (
                                       <div>
                                         <h4 className="font-bold text-amber-600 dark:text-amber-400 mb-1">【当前羁绊】</h4>
                                         <p className="whitespace-pre-wrap pl-2 border-l-2 border-amber-500/30">{parsed.relationship_dynamics}</p>
                                       </div>
                                     )}
                                   </div>
                                 );
                               } catch (e) {
                                 return <p className="whitespace-pre-wrap">{kumikoNotebook}</p>;
                               }
                             })()}
                           </div>
                       ) : (
                           <p className="italic opacity-50 relative z-10">{t.notebookPlaceholder}</p>
                       )}
                  </div>
                  <div className={`flex items-start gap-2 mt-1 p-2 rounded text-[10px] border opacity-80 ${isDarkMode ? 'bg-black/20 border-white/5 text-gray-400' : 'bg-black/5 border-black/5 text-gray-600'}`}>
                      <Lock size={12} className="flex-shrink-0 mt-0.5" />
                      <p>{t.notebookFooter}</p>
                  </div>
                </div>
              )}
            </div>

            {/* Section 3: Life Anchors */}
            <div className={`rounded border overflow-hidden transition-all duration-300 ${isDarkMode ? 'border-yellow-900/30' : 'border-gray-200'}`}>
              <button 
                onClick={() => setIsAnchorsOpen(!isAnchorsOpen)}
                className={`w-full flex items-center justify-between p-3 font-mono font-bold text-sm transition-colors ${isDarkMode ? 'bg-pink-900/10 hover:bg-pink-900/20 text-pink-400' : 'bg-pink-50 hover:bg-pink-100 text-pink-700'}`}
              >
                <div className="flex items-center gap-2">
                  <StickyNote size={16} />
                  <span>{t.lifeAnchors}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${isDarkMode ? 'bg-pink-900/50' : 'bg-pink-200'}`}>{anchors.length}</span>
                </div>
                {isAnchorsOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
              
              {isAnchorsOpen && (
                <div className="p-3 animate-in slide-in-from-top-2 duration-200 flex flex-col gap-3">
                  <p className={`text-xs font-mono opacity-70 ${textClass}`}>{t.lifeAnchorsHelp}</p>
                  {anchors.length === 0 && (
                      <div className={`text-center py-6 opacity-80 text-xs font-mono border border-dashed rounded ${isDarkMode ? 'border-gray-700 text-gray-400' : 'border-gray-400 text-gray-600'}`}>
                          {t.noAnchors}
                      </div>
                  )}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {anchors.map((anchor) => (
                          <div 
                            key={anchor.id}
                            className={`relative p-4 rounded shadow-sm group transition-transform hover:scale-[1.01] ${isDarkMode ? 'bg-[#fff9c4] text-gray-800' : 'bg-[#fffde7] text-gray-800'}`}
                            style={{
                                transform: `rotate(${(Math.random() * 2 - 1).toFixed(1)}deg)`,
                                fontFamily: '"Comic Sans MS", "Chalkboard SE", sans-serif'
                            }}
                          >
                              <div className="absolute -top-3 left-1/2 -translate-x-1/2 w-16 h-6 bg-white/40 rotate-1 backdrop-blur-[1px] shadow-sm"></div>
                              <div className="flex justify-between items-start mb-2 opacity-60 text-[10px] font-mono border-b border-black/10 pb-1">
                                  <span>{new Date(anchor.timestamp).toLocaleDateString()}</span>
                                  {anchor.emotion && KUMIKO_EMOTION_IMAGES[anchor.emotion] && (
                                       <img src={KUMIKO_EMOTION_IMAGES[anchor.emotion]} className="w-4 h-4 rounded-full object-cover opacity-80" alt="mood" />
                                  )}
                              </div>
                              <p className="text-sm font-medium leading-relaxed">{anchor.content}</p>
                              {onDeleteAnchor && (
                                  <button
                                    onClick={(e) => handleDeleteAnchorClick(e, anchor.id)}
                                    className={`absolute bottom-2 right-2 p-1 rounded-full transition-all ${confirmAnchorDeleteId === anchor.id ? 'bg-red-500 text-white w-auto px-2 text-[10px] font-bold' : 'text-gray-400 hover:text-red-500 hover:bg-black/5'}`}
                                    title={t.deleteAnchorConfirm}
                                  >
                                      {confirmAnchorDeleteId === anchor.id ? t.deleteAnchorConfirm : <Trash2 size={14} />}
                                  </button>
                              )}
                          </div>
                      ))}
                  </div>
                </div>
              )}
            </div>

            {/* Section: Mind Map / Graph Memory */}
            <MindMapSection isDarkMode={isDarkMode} textClass={textClass} language={language} />

            {/* Section 4: Context History EDITOR */}
            <div className={`rounded border overflow-hidden transition-all duration-300 ${isDarkMode ? 'border-yellow-900/30' : 'border-gray-200'}`}>
              <button 
                onClick={() => setIsHistoryConfigOpen(!isHistoryConfigOpen)}
                className={`w-full flex items-center justify-between p-3 font-mono font-bold text-sm transition-colors ${isDarkMode ? 'bg-purple-900/10 hover:bg-purple-900/20 text-purple-400' : 'bg-purple-50 hover:bg-purple-100 text-purple-700'}`}
              >
                <div className="flex items-center gap-2">
                  <History size={16} />
                  <span>{t.contextWindowWithEditor}</span>
                </div>
                {isHistoryConfigOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
              
              {isHistoryConfigOpen && (
                <div className="p-3 animate-in slide-in-from-top-2 duration-200 flex flex-col gap-4">
                  {/* ... same editor content ... */}
                  <div className="flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-4">
                        <label className={`text-xs font-mono font-bold ${textClass}`}>{t.contextLimit}</label>
                        <input 
                        type="number" 
                        min="1" 
                        max="500"
                        value={localContextLimit}
                        onChange={(e) => setLocalContextLimit(parseInt(e.target.value) || 0)}
                        className={`w-24 px-2 py-1 rounded text-center font-mono outline-none focus:ring-1 focus:ring-purple-500 ${inputBgClass} ${textClass}`}
                        />
                      </div>
                      <button 
                        onClick={() => setIsPinnedModalOpen(true)}
                        className={`flex items-center gap-2 px-3 py-1 rounded text-xs font-bold transition-colors border whitespace-nowrap ${isDarkMode ? 'border-yellow-600/50 text-yellow-500 hover:bg-yellow-600/20' : 'border-yellow-600 text-yellow-700 hover:bg-yellow-50'}`}
                      >
                         <Pin size={12} className="fill-current" />
                         {t.viewPinned}
                      </button>
                  </div>
                  {/* ... rest of history editor ... */}
                  {/* --- HISTORY SEARCH BAR (MOVED HERE & OPTIMIZED FOR MOBILE) --- */}
                  <div className={`flex items-center gap-1.5 p-1.5 rounded border ${isDarkMode ? 'bg-black/20 border-white/10' : 'bg-gray-50 border-gray-200'}`}>
                      <Search size={14} className="opacity-50 flex-shrink-0 ml-1" />
                      <input 
                          value={historySearchQuery}
                          onChange={(e) => setHistorySearchQuery(e.target.value)}
                          placeholder="Search..."
                          className={`flex-1 bg-transparent outline-none text-xs font-mono ${textClass} placeholder:opacity-40 min-w-0`} // Added min-w-0 for flex shrinking
                      />
                      {historySearchMatches.length > 0 && (
                          <div className={`flex items-center gap-1 pl-1.5 border-l ${isDarkMode ? 'border-white/10' : 'border-gray-300'} flex-shrink-0`}>
                              <span className="text-[10px] font-mono opacity-70 whitespace-nowrap min-w-[30px] text-center">
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
                    <button onClick={(e) => { e.stopPropagation(); if(onInsertMessage) onInsertMessage(null, 'model'); }} className={`flex-1 flex items-center justify-center gap-2 py-2 rounded text-xs font-bold border border-dashed transition-colors ${isDarkMode ? 'border-gray-700 text-gray-400 hover:border-yellow-500 hover:text-yellow-500' : 'border-gray-300 text-gray-600 hover:border-yellow-600 hover:text-yellow-700'}`}>
                        <Plus size={14} /> {t.addMessage} ({t.roleModel})
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); if(onInsertMessage) onInsertMessage(null, 'user'); }} className={`flex-1 flex items-center justify-center gap-2 py-2 rounded text-xs font-bold border border-dashed transition-colors ${isDarkMode ? 'border-gray-700 text-gray-400 hover:border-yellow-500 hover:text-yellow-500' : 'border-gray-300 text-gray-600 hover:border-yellow-600 hover:text-yellow-700'}`}>
                        <Plus size={14} /> {t.addMessage} ({t.roleUser})
                    </button>
                  </div>

                  <div className={`rounded flex flex-col h-80 border overflow-hidden ${isDarkMode ? 'bg-black/30 border-white/10' : 'bg-gray-100 border-gray-300'}`}>
                    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto scrollbar-thin p-3">
                        {sortedMessages.length === 0 && <div className="text-center opacity-50 text-xs font-mono pt-10">{t.noHistory}</div>}
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
                                            <span className="text-[10px] font-mono text-purple-500 font-bold uppercase">{t.contextStart}</span>
                                            <div className="h-px flex-1 bg-purple-500/50"></div>
                                        </div>
                                    )}
                                    <div className={`flex items-center justify-center gap-2 mb-1 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
                                       <div className="hidden md:block cursor-grab active:cursor-grabbing opacity-30 hover:opacity-80"><GripVertical size={12} /></div>
                                       <div className="flex md:hidden gap-1">
                                          <button onClick={(e) => { e.stopPropagation(); if (index > 0 && onReorderMessages) onReorderMessages(index, index - 1); }} className={`p-1 rounded bg-black/20 ${textClass} disabled:opacity-20`} disabled={index === 0}><ArrowUp size={10} /></button>
                                          <button onClick={(e) => { e.stopPropagation(); if (index < sortedMessages.length - 1 && onReorderMessages) onReorderMessages(index, index + 1); }} className={`p-1 rounded bg-black/20 ${textClass} disabled:opacity-20`} disabled={index === sortedMessages.length - 1}><ArrowDown size={10} /></button>
                                       </div>
                                       {msg.isHidden && <div className="px-1 bg-red-900/50 text-red-300 rounded text-[10px] font-bold flex items-center gap-1" title={t.hiddenMsgTooltip}><EyeOff size={10} /></div>}
                                       {msg.isPinned && <div className="px-1 bg-yellow-600/50 text-yellow-200 rounded text-[10px] font-bold flex items-center gap-1" title={t.pin}><Pin size={10} className="fill-current" /></div>}
                                       <span className={`text-[10px] font-mono font-bold opacity-30 ${textClass}`}>#{msgNumber}</span>
                                       <Clock size={10} className="opacity-40" />
                                       <span className={`text-[10px] font-mono tracking-wider opacity-50 ${textClass}`}>{formatKyotoTime(msg.timestamp)}</span>
                                    </div>
                                    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
                                        <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold ${isUser ? (isDarkMode ? 'bg-yellow-700 text-yellow-100' : 'bg-yellow-200 text-yellow-800') : (isDarkMode ? 'bg-gray-700 text-white' : 'bg-white border text-gray-800')}`}>{isUser ? 'YOU' : '久'}</div>
                                        <div className={`relative flex-1 min-w-0 max-w-[85%] rounded-lg p-2 text-sm transition-colors ${isEditing ? (isDarkMode ? 'bg-blue-900/20 border border-blue-500/50' : 'bg-blue-50 border border-blue-300') : (isUser ? (isDarkMode ? 'bg-yellow-900/20 text-yellow-100' : 'bg-yellow-100 text-yellow-900') : (isDarkMode ? 'bg-gray-800 text-gray-300' : 'bg-white border text-gray-800'))}`}>
                                            {isEditing ? (
                                                <div className="flex flex-col gap-2">
                                                    <textarea value={editMessageText} onChange={(e) => setEditMessageText(e.target.value)} className={`w-full h-24 p-2 rounded text-base md:text-xs font-mono resize-none outline-none focus:ring-1 focus:ring-blue-500 ${inputBgClass} ${textClass}`} />
                                                    <div className="flex justify-end gap-2"><button onClick={cancelEditingMessage} className={`p-1 px-2 rounded text-xs font-bold border ${isDarkMode ? 'border-gray-600 hover:bg-gray-700' : 'border-gray-300 hover:bg-gray-200'}`}>CANCEL</button><button onClick={saveEditedMessage} className="flex items-center gap-1 p-1 px-2 rounded text-xs font-bold bg-blue-600 text-white hover:bg-blue-500"><Check size={12} /> SAVE</button></div>
                                                </div>
                                            ) : (
                                                <div className="relative group/bubble" onClick={(e) => toggleMobileMenu(e, msg.id)}>
                                                    {msg.quote && <div className={`mb-1 p-1 rounded text-[10px] border-l-2 opacity-70 ${isDarkMode ? 'bg-black/20 border-white/30' : 'bg-black/5 border-black/20'}`}><div className="flex items-center gap-1 font-bold"><Quote size={8} /><span>{msg.quote.role === 'model' ? 'Kumiko' : 'You'}</span></div><p className="truncate italic">{msg.quote.text}</p></div>}
                                                    {msg.image && <button onClick={(e) => { e.stopPropagation(); if (onImageClick) onImageClick(msg.image!); }} className={`mb-1 p-1 rounded text-[10px] border flex items-center gap-1 overflow-hidden cursor-pointer hover:opacity-80 transition-opacity w-full text-left ${isDarkMode ? 'bg-blue-900/20 border-blue-500/30 text-blue-300' : 'bg-blue-50 border-blue-200 text-blue-700'}`} title={language === 'zh' ? '查看图片' : 'View Image'}><ImageIcon size={10} className="flex-shrink-0" /><span className="truncate font-mono opacity-80 underline decoration-dotted">{msg.image}</span></button>}
                                                    <p className="whitespace-pre-wrap leading-relaxed break-words">{msg.text}</p>
                                                    <div className={`absolute -top-9 ${isUser ? '-left-2' : '-right-2'} gap-1 bg-black/90 rounded px-2 py-1.5 shadow-xl z-20 border border-white/10 ${isMenuOpen ? 'flex animate-in zoom-in-95 duration-200' : 'hidden'} md:hidden md:group-hover/bubble:flex after:content-[''] after:absolute after:-bottom-4 after:left-0 after:w-full after:h-4`}>
                                                        {onJumpToMessage && <button onClick={(e) => { e.stopPropagation(); onJumpToMessage(msg.id); }} className="p-1 text-purple-400 hover:text-purple-300 transition-colors" title={t.jumpToContext}><LocateFixed size={12} /></button>}
                                                        <button onClick={(e) => { e.stopPropagation(); startEditingMessage(msg); }} className="p-1 text-blue-400 hover:text-blue-300 transition-colors" title={t.editTooltip}><Edit2 size={12} /></button>
                                                        {onInsertMessage && <button onClick={(e) => handleInsertMsg(e, msg.id)} className="p-1 text-green-400 hover:text-green-300 transition-colors" title={t.insertAfter}><ListPlus size={12} /></button>}
                                                        {onToggleHidden && <button onClick={(e) => { e.stopPropagation(); onToggleHidden(msg.id); }} className="p-1 text-gray-400 hover:text-gray-200 transition-colors" title={msg.isHidden ? t.unhideTooltip : t.hideTooltip}>{msg.isHidden ? <Eye size={12} className="text-yellow-500" /> : <EyeOff size={12} />}</button>}
                                                        {onTogglePin && <button onClick={(e) => { e.stopPropagation(); onTogglePin(msg.id); }} className={`p-1 transition-colors ${msg.isPinned ? 'text-yellow-500' : 'text-gray-400 hover:text-yellow-200'}`} title={msg.isPinned ? t.unpin : t.pin}><Pin size={12} className={msg.isPinned ? "fill-current" : ""} /></button>}
                                                        <div className="w-px bg-white/20 mx-1"></div>
                                                        {onDeleteMessage && <button onClick={(e) => handleDeleteMsgClick(e, msg.id)} className={`p-1 transition-all ${confirmMsgDeleteId === msg.id ? 'bg-red-600 text-white px-2 rounded text-[10px] font-bold w-auto' : 'text-red-400 hover:text-red-300'}`} title={t.hardDeleteTooltip}>{confirmMsgDeleteId === msg.id ? t.confirmDeleteMsg : <Trash2 size={12} />}</button>}
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
                    <div className={`p-2 text-[10px] font-mono flex justify-end items-center ${isDarkMode ? 'bg-black/40 text-gray-500' : 'bg-gray-200 text-gray-600'}`}><span>{formattedFooter}</span></div>
                  </div>
                </div>
              )}
            </div>

            {/* Section 5: Default World Book */}
            <div className={`rounded border overflow-hidden transition-all duration-300 ${isDarkMode ? 'border-yellow-900/30' : 'border-gray-200'}`}>
              <button 
                onClick={() => setIsDefaultBookOpen(!isDefaultBookOpen)}
                className={`w-full flex items-center justify-between p-3 font-mono font-bold text-sm transition-colors ${isDarkMode ? 'bg-yellow-900/20 hover:bg-yellow-900/30 text-yellow-400' : 'bg-yellow-100 hover:bg-yellow-200 text-[#b8860b]'}`}
              >
                <div className="flex items-center gap-2">
                  <BookOpen size={16} />
                  <span>{t.officialLore}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${isDarkMode ? 'bg-yellow-900/50' : 'bg-yellow-200'}`}>{systemEntries.length}</span>
                </div>
                {isDefaultBookOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>

              {isDefaultBookOpen && (
                <div className="p-3 flex flex-col gap-3 animate-in slide-in-from-top-2 duration-200">
                  <p className={`text-xs font-mono opacity-70 ${textClass}`}>{t.officialLoreHelp}</p>
                  {systemEntries.map((entry) => {
                    const isExpanded = expandedEntryIds.has(entry.id);
                    // Determine if this is a recommended Core Entry
                    const isCore = CORE_MEMORY_IDS.has(entry.id);
                    
                    return (
                      <div key={entry.id} className={`rounded border flex flex-col transition-all overflow-hidden ${cardHighlightBg} ${!entry.isActive ? 'opacity-80' : ''}`}>
                          <div className={`flex items-center justify-between p-3 cursor-pointer hover:bg-white/5`} onClick={() => toggleEntryExpansion(entry.id)}>
                            {/* 
                                OPTIMIZATION FOR MOBILE LAYOUT:
                                1. min-w-0 on the left container is CRITICAL for flex truncation to work properly.
                                2. truncate added to title span to cut off long text.
                                3. flex-shrink-0 and whitespace-nowrap on CORE badge prevents it from stacking vertically.
                            */}
                            <div className="flex items-center gap-2 flex-1 mr-2 min-w-0">
                                <Lock size={12} className="opacity-50 flex-shrink-0" />
                                <span className={`text-xs font-mono font-bold uppercase truncate flex-1 ${isDarkMode ? 'text-yellow-500' : 'text-yellow-700'} ${!entry.isActive ? 'line-through opacity-50' : ''}`}>{entry.title || 'Untitled'}</span>
                                {isCore && (
                                    <span className="ml-1 px-1.5 py-0.5 rounded-[2px] bg-yellow-500 text-black text-[8px] md:text-[9px] font-bold font-mono flex items-center gap-1 shadow-sm animate-pulse flex-shrink-0 whitespace-nowrap">
                                        <Star size={8} fill="black" /> {t.coreBadge}
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              {/* TOGGLE BUTTON LOGIC: If Active -> Green Power. If Inactive -> Search Icon (RAG Mode) */}
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
                          {isExpanded && <div className="p-3 pt-0 animate-in slide-in-from-top-1 duration-150">
                              {/* NEW: Full Title Display for Mobile Readability */}
                              <div className={`mb-2 font-mono font-bold text-sm break-words leading-tight ${isDarkMode ? 'text-yellow-100' : 'text-gray-900'}`}>
                                  {entry.title}
                              </div>

                              {isCore && (
                                  <div className={`mb-2 p-2 rounded border border-yellow-500/30 text-[10px] font-mono flex items-center gap-2 ${isDarkMode ? 'bg-yellow-900/20 text-yellow-200' : 'bg-yellow-50 text-yellow-800'}`}>
                                      <Star size={12} className="text-yellow-500 flex-shrink-0" />
                                      <p>{t.coreRecommendation}</p>
                                  </div>
                              )}
                              <textarea 
                                value={entry.content} 
                                readOnly={true} 
                                className={`w-full h-48 p-2 rounded text-base md:text-sm font-mono resize-y scrollbar-thin outline-none ${isDarkMode ? 'bg-black/20 text-yellow-100/70' : 'bg-gray-100 text-gray-600'} cursor-default`} 
                                placeholder={t.contentPlaceholder} 
                              />
                          </div>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Section 6: Custom World Book */}
            <div className={`rounded border overflow-hidden transition-all duration-300 ${isDarkMode ? 'border-yellow-900/30' : 'border-gray-200'}`}>
              <button 
                onClick={() => setIsCustomBookOpen(!isCustomBookOpen)}
                className={`w-full flex items-center justify-between p-3 font-mono font-bold text-sm transition-colors ${isDarkMode ? 'bg-blue-900/10 hover:bg-blue-900/20 text-blue-400' : 'bg-blue-50 hover:bg-blue-100 text-blue-700'}`}
              >
                <div className="flex items-center gap-2">
                  <Bookmark size={16} />
                  <span>{t.customLore}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${isDarkMode ? 'bg-blue-900/50' : 'bg-blue-200'}`}>{customEntries.length}</span>
                </div>
                {isCustomBookOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>

              {isCustomBookOpen && (
                <div className="p-3 flex flex-col gap-3 animate-in slide-in-from-top-2 duration-200">
                  <p className={`text-xs font-mono opacity-70 ${textClass}`}>{t.customLoreHelp}</p>
                  {customEntries.length === 0 && <div className={`text-center py-4 text-xs font-mono border border-dashed rounded ${isDarkMode ? 'border-gray-700 text-gray-400' : 'border-gray-300 text-gray-600'}`}>{t.noCustomEntries}</div>}
                  {customEntries.map((entry) => {
                    const isExpanded = expandedEntryIds.has(entry.id);
                    return (
                      <div key={entry.id} className={`rounded border flex flex-col transition-all overflow-hidden ${isDarkMode ? 'bg-blue-900/5 border-blue-500/30' : 'bg-blue-50 border-blue-200'} ${!entry.isActive ? 'opacity-80' : ''}`}>
                          <div className={`flex items-center justify-between p-3 cursor-pointer hover:bg-white/5`} onClick={() => toggleEntryExpansion(entry.id)}>
                            <div className="flex items-center gap-2 flex-1 mr-2">
                               {entry.isHighPriority ? <Zap size={12} className="text-yellow-500 fill-yellow-500" /> : <Bookmark size={12} className="opacity-50" />}
                               <input value={entry.title} onChange={(e) => updateEntry(entry.id, 'title', e.target.value)} onClick={(e) => e.stopPropagation()} className={`bg-transparent border-b border-transparent focus:border-blue-500 outline-none text-xs font-mono font-bold uppercase truncate ${isDarkMode ? 'text-blue-200' : 'text-blue-800'} ${!entry.isActive ? 'line-through opacity-50' : ''}`} placeholder="Title" />
                            </div>
                            <div className="flex items-center gap-2">
                              {/* TOGGLE BUTTON: RAG MODE */}
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
                          {isExpanded && <div className="p-3 pt-0 animate-in slide-in-from-top-1 duration-150"><textarea value={entry.content} onChange={(e) => updateEntry(entry.id, 'content', e.target.value)} className={`w-full h-32 p-2 rounded text-base md:text-sm font-mono resize-y scrollbar-thin outline-none focus:ring-1 focus:ring-blue-500/50 ${inputBgClass} ${textClass}`} placeholder={t.contentPlaceholder} /></div>}
                      </div>
                    );
                  })}
                  <button onClick={handleAddCustomEntry} className={`w-full py-2 border-2 border-dashed rounded text-xs font-bold transition-all flex items-center justify-center gap-2 ${isDarkMode ? 'border-gray-700 text-gray-400 hover:border-blue-500 hover:text-blue-500' : 'border-gray-300 text-gray-500 hover:border-blue-500 hover:text-blue-600'}`}><Plus size={14} /> {t.addCustomEntry}</button>
                </div>
              )}
            </div>

          </div>
          )}
        </div>

        {/* Footer Status Bar */}
        <div className={`px-4 py-2 border-t flex justify-between items-center text-[10px] font-mono transition-colors duration-300 ${isDarkMode ? 'bg-black/40 border-yellow-900/30' : 'bg-gray-50 border-gray-200'}`}>
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
      <PinnedModal />
    </div>
  );
};
