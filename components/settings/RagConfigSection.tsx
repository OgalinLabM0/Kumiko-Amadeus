import React from 'react';
import { Database, RefreshCw } from 'lucide-react';
import { BackupConfig, Language } from '../../types';

interface RagConfigSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  language: Language;
  innerCardClass: string;
  backupConfig: BackupConfig;
  ragStatus?: 'IDLE' | 'RECALLING' | 'INDEXING' | 'ERROR' | 'OFF' | 'STALE';
  ragProgressLabel?: string | null;
  onToggleRagEnabled: () => void;
  onRequestRebuildRag?: () => void;
}

export const RagConfigSection: React.FC<RagConfigSectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  language,
  innerCardClass,
  backupConfig,
  ragStatus = 'OFF',
  ragProgressLabel = null,
  onToggleRagEnabled,
  onRequestRebuildRag
}) => {
  const isRebuilding = ragStatus === 'RECALLING' || ragStatus === 'INDEXING';
  return (
    <div className={innerCardClass}>
      <button onClick={onToggle} className="w-full flex items-center justify-between mb-2">
        <div className="text-left">
          <h4 className={`text-xs font-bold flex items-center gap-2 ${isDarkMode ? 'text-purple-400' : 'text-purple-600'}`}>
            <Database size={12} /> {language === 'zh' ? '本地 RAG 记忆' : 'Local RAG Memory'}
          </h4>
          {!isOpen && (
            <div className={`text-[10px] font-mono mt-1 ${backupConfig.ragEnabled ? (isDarkMode ? 'text-purple-300' : 'text-purple-700') : 'opacity-60'}`}>
              {backupConfig.ragEnabled
                ? (language === 'zh' ? '状态: 已启用' : 'Status: Enabled')
                : (language === 'zh' ? '状态: 已关闭' : 'Status: Disabled')}
            </div>
          )}
        </div>
        <span className="text-[10px] opacity-50">{isOpen ? '▼' : '▲'}</span>
      </button>

      {isOpen && (
        <div className="animate-in slide-in-from-top-2">
          <div className="flex items-center justify-between py-2 border-b border-gray-500/10 mb-4">
            <div className="flex items-center gap-3">
              <Database size={18} className={backupConfig.ragEnabled ? (isDarkMode ? 'text-purple-400' : 'text-purple-600') : 'opacity-50'} />
              <div>
                <span className={`text-sm font-bold block ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
                  {language === 'zh' ? '启用本地长期记忆' : 'Enable local long-term memory'}
                </span>
                <span className={`text-[10px] font-bold ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                  {language === 'zh'
                    ? '使用本地 ONNX + SQLite 向量检索，不再依赖外部 Embedding API'
                    : 'Use local ONNX + SQLite vector retrieval without external embedding APIs'}
                </span>
              </div>
            </div>
            <button onClick={onToggleRagEnabled} className={`w-10 h-5 rounded-full relative transition-colors ${backupConfig.ragEnabled ? 'bg-purple-600' : 'bg-gray-600'}`}>
              <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-all ${backupConfig.ragEnabled ? 'left-6' : 'left-1'}`}></div>
            </button>
          </div>

          <div className={`text-[10px] font-mono italic p-3 rounded ${isDarkMode ? 'bg-black/30 text-gray-400' : 'bg-gray-200 text-gray-600'}`}>
            {language === 'zh'
              ? 'RAG 向量模型与接口配置已移除，当前固定使用内置本地模型。'
              : 'RAG model and endpoint inputs have been removed. The built-in local model is now fixed.'}
          </div>

          {onRequestRebuildRag && (
            <div className="mt-4 pt-4 border-t border-gray-500/10">
              <button
                onClick={onRequestRebuildRag}
                disabled={isRebuilding}
                className={`w-full py-2 px-3 rounded flex items-center justify-center gap-2 text-xs font-bold transition-colors disabled:opacity-70 disabled:cursor-not-allowed ${isDarkMode ? 'bg-purple-900/30 hover:bg-purple-900/50 text-purple-400 border border-purple-500/30' : 'bg-purple-50 hover:bg-purple-100 text-purple-600 border border-purple-200'}`}
              >
                <RefreshCw size={14} className={isRebuilding ? 'animate-spin' : ''} /> {isRebuilding ? (language === 'zh' ? '正在重建 RAG 记忆库' : 'Rebuilding RAG Memory') : (language === 'zh' ? '重建 RAG 记忆库' : 'Rebuild RAG Memory')}
              </button>
              <p className={`text-[10px] mt-2 text-center ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                {ragProgressLabel
                  ? ragProgressLabel
                  : language === 'zh'
                    ? '会重新扫描历史消息并生成本地向量索引。'
                    : 'This will rescan message history and regenerate the local vector index.'}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
