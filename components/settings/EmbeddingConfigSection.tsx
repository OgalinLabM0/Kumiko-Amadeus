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
  const headerSub =
    language === 'zh'
      ? 'Android RAG / 日记 / 心理状态使用'
      : 'Used by Android RAG / diary / psyche';

  const accentBg = isDarkMode ? 'bg-[#3a2c1a]' : 'bg-[#fff5e0]';
  const accentText = isDarkMode ? 'text-[#e8d4a8]' : 'text-[#8a6122]';
  const accentBorder = isDarkMode ? 'border-[#5b4732]' : 'border-[#e0c58f]';

  return (
    <div className={`p-4 rounded-2xl border ${sectionBorder}`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <Brain size={16} className={`shrink-0 ${accentText}`} />
          <div>
            <div className={`ka-h6 ${accentText}`}>{headerLabel}</div>
            <div
              className={`ka-micro opacity-70 mt-0.5 ${
                isDarkMode ? 'text-[#b9a482]' : 'text-[#7a6244]'
              }`}
            >
              {headerSub}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {reembedNeeded && (
            <span className={`ka-micro px-2 py-0.5 rounded-full ${accentBg} ${accentText} border ${accentBorder}`}>
              {language === 'zh' ? '需要重嵌入' : 'Reembed needed'}
            </span>
          )}
          {isOpen ? <ChevronUp size={16} className={accentText} /> : <ChevronDown size={16} className={accentText} />}
        </div>
      </button>

      <Collapse isOpen={isOpen}>
        <div className={`${innerCardClass} mt-3 p-4 rounded-[1.15rem]`}>
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
