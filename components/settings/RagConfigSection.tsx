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
  // v2.14.2 J.6: split the RAG description by platform.
  // - PC: ONNX bge-m3 + sqlite-vec, fully local, no network needed for embeddings.
  // - Android: cloud embeddings + Dexie persistence + hnswlib-wasm HNSW index;
  //   above 50 000 vectors we auto-fall-back to brute-force cosine over Dexie.
  //   The previous unified copy claimed local ONNX, which was a lie on Android.
  const isCapacitor = isCapacitorNative();
  const ragDescription = isCapacitor
    ? (language === 'zh'
        ? '云端 Embedding（OpenAI / Gemini / 智谱 / 通义 / 自定义）+ Dexie 持久化 + hnswlib-wasm HNSW 索引（>5 万向量自动降级为暴力余弦检索），完全在 app 内运行。'
        : 'Cloud embeddings (OpenAI / Gemini / Zhipu / Tongyi / Custom) + Dexie persistence + hnswlib-wasm HNSW index (auto-fallback to brute-force cosine above 50 000 vectors). Runs entirely on-device.')
    : (language === 'zh'
        ? '使用本地 ONNX + SQLite 向量检索，不再依赖外部 Embedding API'
        : 'Use local ONNX + SQLite vector retrieval without external embedding APIs');
  const ragLockedHint = isCapacitor
    ? (language === 'zh'
        ? 'Android 通过云端 Embedding 模型生成向量，需先在「云端 Embedding」面板里配置好 API。索引文件持久化在 IndexedDB（IDBFS）里，切换 Embedding 维度后请手动重建。'
        : 'Android generates vectors through a cloud embedding model — set up the provider in the "Cloud Embedding" panel first. The HNSW index is persisted in IndexedDB (IDBFS); rebuild manually after switching embedding dimensions.')
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
          <div className="flex items-center justify-between py-2 mb-3">
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

          {/* v2.14.5 C: previously this lock-hint was a gold italic banner
              with its own background colour, which made the card feel
              entirely unlike the other AI-config sub-cards (Cloud Embedding
              / Vision Helper / Cortex Allocation all use plain helperClass
              hint text). Switched to standard helper-text for visual
              parity. */}
          <p className={`ka-copy-sm ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>
            {ragLockedHint}
          </p>

          {onRequestRebuildRag && (
            <div className="mt-3">
              <button
                onClick={onRequestRebuildRag}
                disabled={isRebuilding}
                className={`w-full py-2 px-3 rounded-lg flex items-center justify-center gap-2 ka-copy-sm font-semibold transition-colors disabled:opacity-70 disabled:cursor-not-allowed ${isDarkMode ? 'bg-purple-900/30 hover:bg-purple-900/50 text-purple-300 border border-purple-500/30' : 'bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200'}`}
              >
                <RefreshCw size={13} className={isRebuilding ? 'animate-spin' : ''} /> {isRebuilding ? (language === 'zh' ? '正在重建 RAG 记忆库' : 'Rebuilding RAG Memory') : (language === 'zh' ? '重建 RAG 记忆库' : 'Rebuild RAG Memory')}
              </button>
              {/* v2.14.5 B: explain what this button does + when to use it
                  + where the *other* RAG-related button lives, so users
                  who see two "rebuild" buttons (this one + DataManagement
                  → Embedding Vector Store → "Re-embed Vector Store") know
                  the difference instead of randomly trying both.
                  whitespace-pre-line keeps the \n\n paragraph break
                  visible (ka-copy-sm uses default white-space). */}
              <p className={`ka-copy-sm mt-2 whitespace-pre-line ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>
                {ragProgressLabel
                  ? ragProgressLabel
                  : language === 'zh'
                    ? '完整流水线（PC + Android）：清空当前 turn_pair 向量 → 重扫历史消息 → 重新分组 → 重新调用 embedding → 写入向量库。耗时较长（按消息量计，几分钟到十几分钟）。\n\n如果只想用新的 embedding 设置重新生成已有向量（不重扫消息、不改变向量数量与分组），请去「数据清理 → 嵌入向量库」用「重嵌入向量库」（仅 Android）。'
                    : 'Full pipeline (PC + Android): clears current turn_pair vectors → rescans message history → regroups → re-runs embedding → writes back. Takes a few to ~15 minutes depending on message volume.\n\nIf you just want to regenerate existing vectors with the current embedding settings (no message rescan, no count change), go to "Data Management → Embedding Vector Store → Re-embed Vector Store" (Android only).'}
              </p>
            </div>
          )}
        </div>
      </Collapse>
    </div>
  );
};
