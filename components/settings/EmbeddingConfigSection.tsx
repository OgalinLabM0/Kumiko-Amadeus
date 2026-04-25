// components/settings/EmbeddingConfigSection.tsx
//
// A5.0 + v2.14.3: settings UI shell for the cloud embedding provider used
// by Android's RAG search.
//
// v2.14.3 M.6 — Watches for provider / model / dimensions drift between the
// current Cloud Embedding config and the fingerprint that was applied at
// the last successful re-embed. When they diverge AND there are vectors
// stored, shows a "重新嵌入向量库" banner inside the Collapse body that
// opens `ReembedConfirmDialog`. Cancellation rolls the form back to the
// last-applied config so the user is never left in a half-applied state.
//
// v2.14.3 N.5 — Cloud Embedding section now defaults to collapsed (handled
// by the parent SettingsPanel via `isOpen` initial state). The shell color
// scheme uses the canonical ka tokens so it doesn't read as "all gray".

import React, { useCallback, useEffect, useState } from 'react';
import { Brain, ChevronDown, ChevronUp, RefreshCw, AlertTriangle } from 'lucide-react';
import { Collapse } from '../Collapse';
import { isCapacitorNative } from '../../services/environment';
import { CloudEmbeddingForm } from './CloudEmbeddingForm';
import {
  getEmbeddingConfig,
  setEmbeddingConfig,
  type EmbeddingProviderConfig,
} from '../../services/cloudEmbeddingService';
import ReembedConfirmDialog from './ReembedConfirmDialog';

interface EmbeddingConfigSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  language: 'zh' | 'en';
  sectionBorder: string;
  innerCardClass: string;
  inputClass: string;
  fieldLabelClass: string;
  helperClass: string;
}

function fingerprint(cfg: EmbeddingProviderConfig): string {
  return `${cfg.provider}|${cfg.model}|${cfg.dimensions ?? 0}`;
}

export const EmbeddingConfigSection: React.FC<EmbeddingConfigSectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  language,
  sectionBorder,
  innerCardClass,
  inputClass,
  fieldLabelClass,
  helperClass,
}) => {
  if (!isCapacitorNative()) return null;

  const [currentConfig, setCurrentConfig] = useState<EmbeddingProviderConfig>(() => getEmbeddingConfig());
  const [lastAppliedFingerprint, setLastAppliedFingerprint] = useState<string>('');
  const [vectorCount, setVectorCount] = useState<number>(0);
  const [hasResumable, setHasResumable] = useState<boolean>(false);
  const [dialogOpen, setDialogOpen] = useState<boolean>(false);
  const [prevConfigForRollback, setPrevConfigForRollback] =
    useState<EmbeddingProviderConfig | null>(null);

  const refreshReembedInfo = useCallback(async () => {
    try {
      const { invokeAndroidRag } = await import('../../services/androidRagService');
      const stats = await invokeAndroidRag<{ count?: number }>('rag:stats', {});
      const info = await invokeAndroidRag<{
        hasResumable?: boolean;
        cursor?: number;
        failedCount?: number;
        lastFingerprint?: string;
      }>('rag:reembed:info', {});
      setVectorCount(typeof stats?.count === 'number' ? stats.count : 0);
      setHasResumable(!!info?.hasResumable);
      setLastAppliedFingerprint(typeof info?.lastFingerprint === 'string' ? info.lastFingerprint : '');
    } catch {
      // Service not initialised / Dexie unavailable — leave defaults.
    }
  }, []);

  useEffect(() => {
    void refreshReembedInfo();
  }, [refreshReembedInfo]);

  useEffect(() => {
    const handler = () => setCurrentConfig(getEmbeddingConfig());
    window.addEventListener('kumiko:embedding-config-changed', handler);
    return () => window.removeEventListener('kumiko:embedding-config-changed', handler);
  }, []);

  // Refresh reembed info every time the section is opened so the banner
  // reflects the freshest cursor / fingerprint state without needing a
  // full settings panel remount.
  useEffect(() => {
    if (isOpen) void refreshReembedInfo();
  }, [isOpen, refreshReembedInfo]);

  const currentFingerprint = fingerprint(currentConfig);
  const fingerprintChanged =
    !!lastAppliedFingerprint && currentFingerprint !== lastAppliedFingerprint;
  const reembedNeeded = fingerprintChanged && vectorCount > 0;

  const handleOpenDialog = useCallback(() => {
    // Snapshot the last-applied config so cancellation can roll back.
    let prev: EmbeddingProviderConfig | null = null;
    if (lastAppliedFingerprint) {
      const [provider, model, dimsRaw] = lastAppliedFingerprint.split('|');
      const dims = parseInt(dimsRaw, 10) || 0;
      prev = {
        ...currentConfig,
        provider: provider as EmbeddingProviderConfig['provider'],
        model: model || currentConfig.model,
        dimensions: dims || currentConfig.dimensions,
      };
    }
    setPrevConfigForRollback(prev);
    setDialogOpen(true);
  }, [lastAppliedFingerprint, currentConfig]);

  const handleDialogClose = useCallback(() => {
    setDialogOpen(false);
    void refreshReembedInfo();
  }, [refreshReembedInfo]);

  const handleCancelChange = useCallback(() => {
    if (prevConfigForRollback) {
      setEmbeddingConfig(prevConfigForRollback);
      setCurrentConfig(prevConfigForRollback);
    }
  }, [prevConfigForRollback]);

  const headerLabel = language === 'zh' ? '云端 Embedding' : 'Cloud Embedding';

  // v2.14.6 G.1: status-pill copy for the collapsed header. Mirrors
  // VisionHelperSection's pattern (启用中 / 未启用 + a sub-line). Cloud
  // Embedding is special because there's no on/off toggle — instead we
  // surface "已配置" (provider+model+key all present) vs "未配置".
  const isConfigured = !!(currentConfig.apiKey && currentConfig.model);
  const statusLabel = !isConfigured
    ? (language === 'zh' ? '未配置' : 'NOT CONFIGURED')
    : reembedNeeded
      ? (language === 'zh' ? '需重嵌入' : 'REEMBED NEEDED')
      : (language === 'zh' ? '已配置' : 'CONFIGURED');
  const statusOk = isConfigured && !reembedNeeded;
  const statusWarn = isConfigured && reembedNeeded;
  // Banner accent used by the inline reembed warning inside the body —
  // kept on amber so it visually pairs with the new amber header chip.
  const accentBg = isDarkMode ? 'bg-[#3a2c1a]' : 'bg-[#fff5e0]';
  const accentText = isDarkMode ? 'text-[#e8d4a8]' : 'text-[#8a6122]';
  const accentBorder = isDarkMode ? 'border-[#5b4732]' : 'border-[#e0c58f]';

  return (
    // v2.14.6 G.1: outer shell rewritten to match VisionHelperSection /
    // ModelAllocationSection visual language. Previously this card was a
    // p-4 rounded-2xl border using sectionBorder + a Brain icon next to
    // ka-h6 amber text — none of which lined up with the other AI-config
    // sub-cards (which all use innerCardClass + a 9×9 rounded-xl gradient
    // icon box + status pill + chevron). The user reported "你都改两次了
    // 怎么还是这样" after v2.14.4/5 didn't fully align it; v2.14.6 finally
    // brings the wrapper, icon box, status pill, and chevron in line.
    //
    // The body inside <Collapse> is now a plain wrapper <div> instead of
    // a nested innerCardClass card — the outer shell IS the card, and a
    // second card-in-card was the visual stutter the user complained about.
    <div className={innerCardClass}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between mb-2"
      >
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div
            className={`flex h-9 w-9 items-center justify-center rounded-xl border shrink-0 ${
              isDarkMode
                ? 'border-amber-500/20 bg-amber-900/20 text-amber-300'
                : 'border-amber-200 bg-amber-50/90 text-amber-700'
            }`}
          >
            <Brain size={16} />
          </div>
          <div className="flex-1 text-left min-w-0">
            <h4 className={`ka-label font-bold ${isDarkMode ? 'text-[#f5ebdc]' : 'text-[#49301f]'}`}>
              {headerLabel}
            </h4>
            {!isOpen && (
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <span
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border ${
                    statusOk
                      ? (isDarkMode
                          ? 'bg-amber-900/25 border-amber-500/25 text-amber-300'
                          : 'bg-amber-50 border-amber-200 text-amber-700')
                      : statusWarn
                        ? (isDarkMode
                            ? 'bg-yellow-900/30 border-yellow-500/30 text-yellow-300'
                            : 'bg-yellow-50 border-yellow-300 text-yellow-700')
                        : (isDarkMode
                            ? 'bg-[#2a1f16]/60 border-[#7a5830]/40 text-[#9a8065]'
                            : 'bg-[#f1e8d9] border-[#d7c7b5] text-[#8a6b4e]')
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      statusOk
                        ? 'bg-amber-500'
                        : statusWarn
                          ? 'bg-yellow-500'
                          : (isDarkMode ? 'bg-[#8a6b4e]' : 'bg-[#b8a38c]')
                    }`}
                  />
                  <span className="ka-micro font-semibold">{statusLabel}</span>
                </span>
                <span className={`ka-section-desc ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>
                  {language === 'zh' ? 'Android RAG / 日记 / 心理状态用' : 'Powers Android RAG / diary / psyche'}
                </span>
              </div>
            )}
          </div>
        </div>
        {isOpen
          ? <ChevronUp size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />
          : <ChevronDown size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />}
      </button>

      <Collapse isOpen={isOpen} duration={180}>
        <div>
          {(reembedNeeded || hasResumable) && (
            <div
              className={`mb-3 p-3 rounded-xl border flex items-start gap-3 ${accentBg} ${accentBorder} ${accentText}`}
            >
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <div className="flex-1">
                <div className="ka-copy-sm font-semibold mb-1">
                  {hasResumable
                    ? language === 'zh'
                      ? '上次重新嵌入未完成'
                      : 'Last re-embedding was interrupted'
                    : language === 'zh'
                      ? '当前 embedding 配置与已存向量不一致'
                      : 'Embedding config diverges from stored vectors'}
                </div>
                <div className="ka-micro opacity-90">
                  {hasResumable
                    ? language === 'zh'
                      ? `点击下方按钮可从中断处续跑（已嵌入 ${vectorCount.toLocaleString()} 条向量）。`
                      : `Click the button below to resume where it left off (${vectorCount.toLocaleString()} vectors total).`
                    : language === 'zh'
                      ? `检测到 ${vectorCount.toLocaleString()} 条向量需要用新 provider/维度重新嵌入，否则混合维度会破坏检索。`
                      : `${vectorCount.toLocaleString()} vectors need re-embedding with the new provider/dimensions, otherwise mixed dimensions will break search.`}
                </div>
                <button
                  type="button"
                  onClick={handleOpenDialog}
                  className={`mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg ka-copy-sm font-semibold ${
                    isDarkMode
                      ? 'bg-[#d4a852] hover:bg-[#e0b566] text-[#21150a]'
                      : 'bg-[#e8b34a] hover:bg-[#d9a23a] text-[#3a2710]'
                  }`}
                >
                  <RefreshCw size={13} />
                  {hasResumable
                    ? language === 'zh'
                      ? '继续重新嵌入'
                      : 'Resume re-embedding'
                    : language === 'zh'
                      ? '重新嵌入向量库'
                      : 'Re-embed vectors'}
                </button>
              </div>
            </div>
          )}

          <CloudEmbeddingForm
            language={language}
            isDarkMode={isDarkMode}
            inputClass={inputClass}
            fieldLabelClass={fieldLabelClass}
            helperClass={helperClass}
          />
        </div>
      </Collapse>

      <ReembedConfirmDialog
        isOpen={dialogOpen}
        language={language}
        isDarkMode={isDarkMode}
        onClose={handleDialogClose}
        prevConfig={prevConfigForRollback}
        nextConfig={currentConfig}
        onCancelChange={handleCancelChange}
      />
    </div>
  );
};

export default EmbeddingConfigSection;
