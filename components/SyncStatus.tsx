
import React from 'react';
import { Wifi, AlertTriangle, RefreshCw, Database, Signal } from 'lucide-react';
import { SyncStatus } from '../hooks/useAutoSave';
import { UI_TRANSLATIONS } from '../constants';
import { Language } from '../types';

// Extended type to include RAG statuses handled in App.tsx but passed as prop
export type ExtendedSyncStatus = SyncStatus | 'RAG_RECALLING' | 'RAG_INDEXING';

interface SyncStatusIndicatorProps {
  status: ExtendedSyncStatus;
  onClick?: () => void;
  isDarkMode: boolean;
  language?: Language;
  isLocalEnabled: boolean;
}

export const SyncStatusIndicator: React.FC<SyncStatusIndicatorProps> = ({ 
  status, 
  onClick, 
  isDarkMode, 
  language = 'zh',
  isLocalEnabled
}) => {
  const t = UI_TRANSLATIONS[language];

  // LOCAL ONLY MODE -> Signal Icon
  if (isLocalEnabled) {
      // Yellow Steady: Local Backup Active
      return (
        <button 
            className="relative hover:text-yellow-500 transition-colors"
            title={t.localBackupActive}
            onClick={onClick}
        >
            <Signal size={18} />
        </button>
      );
  } else {
      // Gray: Local Backup Inactive
      return (
        <button 
            className={`relative transition-colors cursor-default opacity-50 ${isDarkMode ? 'text-gray-600' : 'text-gray-400'}`}
            title={t.localBackupInactive}
        >
            <Signal size={18} />
        </button>
      );
  }
};

// --- RAG STATUS INDICATOR (UNCHANGED) ---
interface RagStatusIndicatorProps {
    status: 'IDLE' | 'RECALLING' | 'INDEXING' | 'ERROR' | 'OFF' | 'STALE';
    isDarkMode: boolean;
    language?: Language;
    detail?: string | null;
}

export const RagStatusIndicator: React.FC<RagStatusIndicatorProps> = ({ status, isDarkMode, language = 'zh', detail }) => {
    const t = UI_TRANSLATIONS[language];
    const withDetail = (base: string) => detail ? `${base} · ${detail}` : base;
    
    if (status === 'OFF') {
        return (
            <button 
                className="text-gray-500 opacity-30 cursor-default" 
                title={withDetail(language === 'zh' ? "RAG 记忆已禁用" : "RAG Memory Disabled")}
            >
                <Database size={18} />
            </button>
        );
    }

    if (status === 'IDLE') {
        return (
            <button 
                className="hover:text-yellow-500 transition-colors" 
                title={withDetail(t.ragIdle)}
            >
                <Database size={18} />
            </button>
        );
    }

    if (status === 'STALE') {
        return (
            <button
                className="relative text-amber-500 hover:text-amber-400 transition-colors"
                title={withDetail(language === 'zh' ? 'RAG 记忆索引需要重建' : 'RAG memory index needs rebuild')}
            >
                <Database size={18} />
                <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-amber-500 rounded-full"></div>
            </button>
        );
    }

    if (status === 'RECALLING') {
        return (
            <button 
                className="relative text-yellow-500 animate-pulse" 
                title={withDetail(t.ragRecalling)}
            >
                <Database size={18} />
                <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-yellow-500 rounded-full animate-ping"></div>
            </button>
        );
    }

    if (status === 'INDEXING') {
        return (
            <button 
                className="relative text-yellow-500 animate-[pulse_2s_infinite]" 
                title={withDetail(t.ragIndexing)}
            >
                <Database size={18} />
            </button>
        );
    }

    if (status === 'ERROR') {
        return (
            <button 
                className="relative text-red-500" 
                title={withDetail(t.ragError)}
            >
                <Database size={18} />
                <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-red-600 rounded-full"></div>
            </button>
        );
    }

    // Unknown status fallback. Historically this silently rendered null,
    // meaning any future RAG state added to the state machine would make
    // the indicator vanish entirely. Surface the unknown value as a muted
    // debug badge + single console.warn (ref + dedupe) so the next state
    // gets noticed during development without spamming production logs.
    if (typeof (globalThis as any).__kaUnknownRagStatuses === 'undefined') {
        (globalThis as any).__kaUnknownRagStatuses = new Set<string>();
    }
    const seenSet: Set<string> = (globalThis as any).__kaUnknownRagStatuses;
    if (!seenSet.has(status as string)) {
        seenSet.add(status as string);
        console.warn('[SYNC STATUS] Unhandled RAG status value, rendering fallback badge:', status);
    }
    return (
        <button
            className={`relative opacity-40 cursor-default ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}
            title={withDetail(`RAG: ${String(status)}`)}
        >
            <Database size={18} />
            <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-gray-400 rounded-full"></div>
        </button>
    );
};
