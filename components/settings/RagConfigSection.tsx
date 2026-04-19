import React from 'react';
import { Database, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { BackupConfig, Language } from '../../types';
import { SettingsToggle } from './SettingsToggle';
import { Collapse } from '../Collapse';

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
          <h4 className={`ka-label font-bold flex items-center gap-2 ${isDarkMode ? 'text-purple-300' : 'text-purple-700'}`}>
            <Database size={13} /> {language === 'zh' ? '本地 RAG 记忆' : 'Local RAG Memory'}
          </h4>
          {!isOpen && (
            <div className={`ka-micro mt-1 font-semibold ${backupConfig.ragEnabled ? (isDarkMode ? 'text-purple-400' : 'text-purple-600') : (isDarkMode ? 'text-gray-500' : 'text-gray-400')}`}>
              {backupConfig.ragEnabled
                ? (language === 'zh' ? '状态: 已启用' : 'Status: Enabled')
                : (language === 'zh' ? '状态: 已关闭' : 'Status: Disabled')}
            </div>
          )}
        </div>
        {isOpen ? <ChevronUp size={14} className={isDarkMode ? 'text-gray-500' : 'text-gray-400'} /> : <ChevronDown size={14} className={isDarkMode ? 'text-gray-500' : 'text-gray-400'} />}
      </button>

      <Collapse isOpen={isOpen} duration={180}>
        <div>
          <div className="flex items-center justify-between py-2 border-b border-gray-500/10 mb-4">
            <div className="flex items-center gap-3">
              <Database size={18} className={backupConfig.ragEnabled ? (isDarkMode ? 'text-purple-400' : 'text-purple-600') : 'opacity-50'} />
              <div>
                <span className={`ka-setting-item-title block ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
                  {language === 'zh' ? '启用本地长期记忆' : 'Enable local long-term memory'}
                </span>
                <span className={`ka-copy-sm ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                  {language === 'zh'
                    ? '使用本地 ONNX + SQLite 向量检索，不再依赖外部 Embedding API'
                    : 'Use local ONNX + SQLite vector retrieval without external embedding APIs'}
                </span>
              </div>
            </div>
            <div className="flex-shrink-0">
              <SettingsToggle
                checked={!!backupConfig.ragEnabled}
                onClick={onToggleRagEnabled}
                activeTrackClass="bg-purple-600/95"
                inactiveTrackClass={isDarkMode ? 'bg-[#3e3429]' : 'bg-[#d7d2ca]'}
                ariaLabel={language === 'zh' ? '启用本地长期记忆' : 'Enable local long-term memory'}
              />
            </div>
          </div>

          <div className={`ka-copy-sm italic p-3 rounded ${isDarkMode ? 'bg-black/30 text-gray-400' : 'bg-gray-200 text-gray-600'}`}>
            {language === 'zh'
              ? 'RAG 向量模型与接口配置已移除，当前固定使用内置本地模型。'
              : 'RAG model and endpoint inputs have been removed. The built-in local model is now fixed.'}
          </div>

          {onRequestRebuildRag && (
            <div className="mt-4 pt-4 border-t border-gray-500/10">
              <button
                onClick={onRequestRebuildRag}
                disabled={isRebuilding}
                className={`w-full py-2 px-3 rounded flex items-center justify-center gap-2 ka-label transition-colors disabled:opacity-70 disabled:cursor-not-allowed ${isDarkMode ? 'bg-purple-900/30 hover:bg-purple-900/50 text-purple-400 border border-purple-500/30' : 'bg-purple-50 hover:bg-purple-100 text-purple-600 border border-purple-200'}`}
              >
                <RefreshCw size={14} className={isRebuilding ? 'animate-spin' : ''} /> {isRebuilding ? (language === 'zh' ? '正在重建 RAG 记忆库' : 'Rebuilding RAG Memory') : (language === 'zh' ? '重建 RAG 记忆库' : 'Rebuild RAG Memory')}
              </button>
              <p className={`ka-copy-sm mt-2 text-center ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                {ragProgressLabel
                  ? ragProgressLabel
                  : language === 'zh'
                    ? '会重新扫描历史消息并生成本地向量索引。'
                    : 'This will rescan message history and regenerate the local vector index.'}
              </p>
            </div>
          )}
        </div>
      </Collapse>
    </div>
  );
};
