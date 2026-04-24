import React from 'react';
import { Database, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { BackupConfig, Language } from '../../types';
import { SettingsToggle } from './SettingsToggle';
import { Collapse } from '../Collapse';
import { isCapacitorNative } from '../../services/environment';

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
  // v2.14.1 G.3: split the RAG description by platform.
  // - PC: ONNX bge-m3 + sqlite-vec, fully local, no network needed for embeddings.
  // - Android: cloud embeddings (OpenAI/Gemini/Zhipu/Tongyi/Custom) feed into a
  //   Dexie-backed vector store with brute-force cosine retrieval (USearch HNSW
  //   queued for v2.14.2). The previous unified copy claimed local ONNX, which
  //   was a lie on Android — the WebView has no ONNX runtime.
  const isCapacitor = isCapacitorNative();
  const ragDescription = isCapacitor
    ? (language === 'zh'
        ? '使用云端 Embedding（OpenAI / Gemini / 智谱 / 通义 / 自定义）+ Dexie 向量持久化，完全在 app 内运行，无需 PC。'
        : 'Uses cloud embeddings (OpenAI / Gemini / Zhipu / Tongyi / Custom) with Dexie-backed vector persistence — runs entirely on-device, no PC required.')
    : (language === 'zh'
        ? '使用本地 ONNX + SQLite 向量检索，不再依赖外部 Embedding API'
        : 'Use local ONNX + SQLite vector retrieval without external embedding APIs');
  const ragLockedHint = isCapacitor
    ? (language === 'zh'
        ? 'Android 通过云端 Embedding 模型生成向量，需先在「云端 Embedding」面板里配置好 API。'
        : 'Android generates vectors through a cloud embedding model — set up the provider in the "Cloud Embedding" panel first.')
    : (language === 'zh'
        ? 'RAG 向量模型与接口配置已移除，当前固定使用内置本地模型。'
        : 'RAG model and endpoint inputs have been removed. The built-in local model is now fixed.');
  return (
    <div className={innerCardClass}>
      <button onClick={onToggle} className="w-full flex items-center justify-between mb-2">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className={`flex h-9 w-9 items-center justify-center rounded-xl border shrink-0 ${isDarkMode ? 'border-purple-500/20 bg-purple-900/20 text-purple-300' : 'border-purple-200 bg-purple-50/90 text-purple-700'}`}>
            <Database size={16} />
          </div>
          <div className="flex-1 text-left min-w-0">
            <h4 className={`ka-label font-bold ${isDarkMode ? 'text-[#f5ebdc]' : 'text-[#49301f]'}`}>{language === 'zh' ? '本地 RAG 记忆' : 'Local RAG Memory'}</h4>
            {!isOpen && (
              <span className={`inline-flex items-center gap-1.5 mt-1 px-2 py-0.5 rounded-full border ${backupConfig.ragEnabled
                ? (isDarkMode ? 'bg-purple-900/25 border-purple-500/25 text-purple-300' : 'bg-purple-50 border-purple-200 text-purple-700')
                : (isDarkMode ? 'bg-[#2a1f16]/60 border-[#7a5830]/40 text-[#9a8065]' : 'bg-[#f1e8d9] border-[#d7c7b5] text-[#8a6b4e]')}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${backupConfig.ragEnabled ? 'bg-purple-500' : (isDarkMode ? 'bg-[#8a6b4e]' : 'bg-[#b8a38c]')}`} />
                <span className="ka-micro font-semibold">{backupConfig.ragEnabled ? (language === 'zh' ? '已启用' : 'ENABLED') : (language === 'zh' ? '已关闭' : 'DISABLED')}</span>
              </span>
            )}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} /> : <ChevronDown size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />}
      </button>

      <Collapse isOpen={isOpen} duration={180}>
        <div>
          <div className={`flex items-center justify-between py-2 border-b mb-4 ${isDarkMode ? 'border-[#8c6a3c]/30' : 'border-[#ebe1d3]'}`}>
            <div className="flex-1 min-w-0">
              <span className={`ka-setting-item-title block ${isDarkMode ? 'text-[#f5ebdc]' : 'text-[#49301f]'}`}>
                {language === 'zh' ? '启用本地长期记忆' : 'Enable local long-term memory'}
              </span>
              <span className={`ka-copy-sm ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>
                {ragDescription}
              </span>
            </div>
            <div className="flex-shrink-0 ml-3">
              <SettingsToggle
                checked={!!backupConfig.ragEnabled}
                onClick={onToggleRagEnabled}
                activeTrackClass="bg-purple-600/95"
                inactiveTrackClass={isDarkMode ? 'bg-[#3e3429]' : 'bg-[#d7d2ca]'}
                ariaLabel={language === 'zh' ? '启用本地长期记忆' : 'Enable local long-term memory'}
              />
            </div>
          </div>

          <div className={`ka-copy-sm italic p-3 rounded-lg ${isDarkMode ? 'bg-[#211811]/60 text-[#b69f87]' : 'bg-[#f5ebd9] text-[#8f7458]'}`}>
            {ragLockedHint}
          </div>

          {onRequestRebuildRag && (
            <div className={`mt-4 pt-4 border-t ${isDarkMode ? 'border-[#8c6a3c]/30' : 'border-[#ebe1d3]'}`}>
              <button
                onClick={onRequestRebuildRag}
                disabled={isRebuilding}
                className={`w-full py-3 px-4 rounded-xl flex items-center justify-center gap-2 ka-label font-semibold transition-colors disabled:opacity-70 disabled:cursor-not-allowed ${isDarkMode ? 'bg-purple-900/30 hover:bg-purple-900/50 text-purple-300 border border-purple-500/30' : 'bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200'}`}
              >
                <RefreshCw size={14} className={isRebuilding ? 'animate-spin' : ''} /> {isRebuilding ? (language === 'zh' ? '正在重建 RAG 记忆库' : 'Rebuilding RAG Memory') : (language === 'zh' ? '重建 RAG 记忆库' : 'Rebuild RAG Memory')}
              </button>
              <p className={`ka-copy-sm mt-2 text-center ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>
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
