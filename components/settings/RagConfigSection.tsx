import React, { useState } from 'react';
import { Database, RefreshCw, ChevronDown, ChevronUp, Info } from 'lucide-react';
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
  // v2.14.6 F: gate the long pipeline-explanation paragraph behind an Info
  // toggle so the card stays visually clean. While a rebuild is running the
  // <Collapse> below is forced open via `|| !!ragProgressLabel` regardless
  // of this state, so the user always sees the live progress text.
  const [showRagDetail, setShowRagDetail] = useState(false);
  // v2.14.2 J.6: split the RAG description by platform.
  // - PC: ONNX bge-m3 + sqlite-vec, fully local, no network needed for embeddings.
  // - Android: cloud embeddings + Dexie persistence + hnswlib-wasm HNSW index;
  //   HNSW grows on demand and falls back to brute-force only if WASM fails.
  //   The previous unified copy claimed local ONNX, which was a lie on Android.
  const isCapacitor = isCapacitorNative();
  const ragDescription = isCapacitor
    ? (language === 'zh'
        ? '云端 Embedding（OpenAI / Gemini / 智谱 / 通义 / 自定义）+ Dexie 持久化 + hnswlib-wasm HNSW 索引（按需扩容，WASM 失败时自动降级为暴力余弦检索），完全在 app 内运行。'
        : 'Cloud embeddings (OpenAI / Gemini / Zhipu / Tongyi / Custom) + Dexie persistence + hnswlib-wasm HNSW index (grows on demand, auto-fallback to brute-force cosine if WASM fails). Runs entirely on-device.')
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

          {/* v2.14.5 C → v2.14.6 E: lock-hint helper text. v2.14.5 used the
              brown helper palette which collided with the toggle's brown
              sub-copy above; v2.14.6 drops to neutral gray + ka-micro so
              it reads as secondary "system status" rather than primary
              copy that competes with the toggle row.
              The class is a className expression so we can swap the gray
              shade per dark/light mode without re-render churn. */}
          <p className={`ka-micro ${isDarkMode ? 'text-gray-400/85' : 'text-gray-500/85'}`}>
            {ragLockedHint}
          </p>

          {onRequestRebuildRag && (
            <div className="mt-3">
              {/* v2.14.6 F: button-row layout splits into [main rebuild button | ⓘ
                  toggle button]. Previously the long pipeline-explanation paragraph
                  always rendered below the button, which the user complained made the
                  card feel cluttered ("大量文字加上重建按钮，你这美观吗？？").
                  v2.14.6 collapses that paragraph behind an Info button right of the
                  rebuild button — clicking it toggles `showRagDetail`, which gates
                  the <Collapse> below. While a rebuild is in progress
                  (`ragProgressLabel` is non-empty), the collapse is forced open so
                  the user sees the live progress text without having to click ⓘ. */}
              <div className="flex items-center gap-2">
                <button
                  onClick={onRequestRebuildRag}
                  disabled={isRebuilding}
                  className={`flex-1 py-2 px-3 rounded-lg flex items-center justify-center gap-2 ka-copy-sm font-semibold transition-colors disabled:opacity-70 disabled:cursor-not-allowed ${isDarkMode ? 'bg-purple-900/30 hover:bg-purple-900/50 text-purple-300 border border-purple-500/30' : 'bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200'}`}
                >
                  <RefreshCw size={13} className={isRebuilding ? 'animate-spin' : ''} /> {isRebuilding ? (language === 'zh' ? '正在重建 RAG 记忆库' : 'Rebuilding RAG Memory') : (language === 'zh' ? '重建 RAG 记忆库' : 'Rebuild RAG Memory')}
                </button>
                <button
                  type="button"
                  onClick={() => setShowRagDetail((v) => !v)}
                  aria-label={language === 'zh' ? '查看重建说明' : 'Show rebuild details'}
                  aria-expanded={showRagDetail || isRebuilding}
                  title={language === 'zh' ? '查看重建说明' : 'Show rebuild details'}
                  className={`shrink-0 h-9 w-9 rounded-full flex items-center justify-center border transition-colors ${
                    (showRagDetail || isRebuilding)
                      ? (isDarkMode
                          ? 'bg-purple-900/40 text-purple-200 border-purple-500/40'
                          : 'bg-purple-100 text-purple-700 border-purple-300')
                      : (isDarkMode
                          ? 'bg-[#2a1f16]/40 text-[#9a8065] border-[#7a5830]/30 hover:text-purple-300 hover:border-purple-500/30'
                          : 'bg-white text-[#8a6b4e] border-[#d7c7b5] hover:text-purple-700 hover:border-purple-300')
                  }`}
                >
                  <Info size={14} />
                </button>
              </div>

              {/* v2.14.5 B → v2.14.6 E + F:
                  - E: split the description by platform (PC has no
                    Android-only "second rebuild button", so the
                    cross-reference paragraph is hidden on PC); switched
                    text style to ka-micro + neutral gray so the long
                    paragraph reads as secondary docs, not primary copy.
                  - F: wrap the description in a <Collapse> gated on
                    `showRagDetail || isRebuilding`. While idle, the long
                    explanation is hidden behind ⓘ; while a rebuild is in
                    progress, `ragProgressLabel` displaces the static copy
                    AND forces the panel open so the user always sees
                    progress.
                  whitespace-pre-line preserves the \n\n paragraph break. */}
              <Collapse isOpen={showRagDetail || !!ragProgressLabel} duration={180}>
                <p className={`ka-micro mt-2 whitespace-pre-line ${isDarkMode ? 'text-gray-400/85' : 'text-gray-500/85'}`}>
                  {ragProgressLabel
                    ? ragProgressLabel
                    : isCapacitor
                      ? (language === 'zh'
                          ? '完整流水线（Android）：清空当前 turn_pair 向量 → 重扫历史消息 → 重新分组 → 调用云端 embedding → 写入 Dexie + hnswlib-wasm。耗时较长（按消息量计，几分钟到十几分钟）。\n\n如果只想用新的 embedding 设置重新生成已有向量（不重扫消息、不改变向量数量与分组），请去「数据清理 → 嵌入向量库」用「重嵌入向量库」。'
                          : 'Full pipeline (Android): clears current turn_pair vectors → rescans message history → regroups → calls cloud embedding → writes back to Dexie + hnswlib-wasm. Takes a few to ~15 minutes depending on message volume.\n\nIf you just want to regenerate existing vectors with the current embedding settings (no message rescan, no count change), go to "Data Management → Embedding Vector Store → Re-embed Vector Store".')
                      : (language === 'zh'
                          ? '完整流水线（PC）：清空当前 turn_pair 向量 → 重扫历史消息 → 重新分组 → 调用本地 ONNX embedding → 写入 sqlite-vec。耗时较长（按消息量计，几分钟到十几分钟）。'
                          : 'Full pipeline (PC): clears current turn_pair vectors → rescans message history → regroups → runs local ONNX embedding → writes back to sqlite-vec. Takes a few to ~15 minutes depending on message volume.')}
                </p>
              </Collapse>
            </div>
          )}
        </div>
      </Collapse>
    </div>
  );
};
