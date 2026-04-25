// components/settings/ReembedConfirmDialog.tsx
//
// v2.14.3 M.6 — Confirmation + progress dialog for the Android full
// re-embedding flow. Shown when:
//   1. The user changed embedding provider / model / dimensions in the
//      Cloud Embedding form (provider switch path), or
//   2. The user clicked the manual "Re-embed all" button on the Settings →
//      Data Management → Embedding card.
//
// The dialog has three stages:
//   - 'confirm': summarise what's about to happen (vector count, est. API
//                calls, est. cost band), let the user start or cancel.
//   - 'running': stream progress from `rag:reembed:status` every ~600 ms.
//                Shows processed / total, current stage, failed count, and
//                estimated time remaining. Cancel intentionally not offered
//                here — partial reembeds leave Dexie in a mixed-dim state
//                we'd need a separate cleanup flow to handle.
//   - 'done':    finished or terminated by error. Show summary +
//                successCount / failedCount / elapsed and a Close button.
//
// Resume support: if the service reports `cursor > 0` from a previous
// abandoned run, the dialog preselects "resume" instead of "fresh".

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, AlertTriangle, CheckCircle2, X, RefreshCw } from 'lucide-react';
import type { EmbeddingProviderConfig } from '../../services/cloudEmbeddingService';

// We import lazily to avoid pulling Dexie + RAG service into the PWA/PC
// bundle when this module is in scope but the dialog isn't actually opened.
type ReembedSnapshot = {
  jobId: string;
  stage: string;
  processed: number;
  total: number;
  startedAt: number;
  elapsedMs: number;
  failedCount?: number;
  apiCallsCount?: number;
  failedIds?: string[];
  finished: boolean;
  error: string | null;
  resumed?: boolean;
  extra?: string | null;
};

interface ReembedConfirmDialogProps {
  isOpen: boolean;
  language: 'zh' | 'en';
  isDarkMode: boolean;
  onClose: () => void;
  /** Previous applied embedding config (before the user's change). Used
   *  for the "X → Y" diff banner. Null when invoked manually from
   *  DataManagementSection without a provider switch. */
  prevConfig?: EmbeddingProviderConfig | null;
  /** Currently-saved embedding config (the new one). */
  nextConfig: EmbeddingProviderConfig;
  /** Called once the user explicitly cancels at the confirm stage. The
   *  caller is responsible for any rollback (e.g. `setEmbeddingConfig(prevConfig)`).
   *  NOT called on Close after success / error — those use `onClose`. */
  onCancelChange?: () => void;
  /** Called once the dialog is fully closed (success, failure, cancel). */
  onCompleted?: (result: { success: boolean; failedCount: number }) => void;
}

type Stage = 'confirm' | 'running' | 'done' | 'error';

const POLL_INTERVAL_MS = 600;

function tt(zh: string, en: string, lang: 'zh' | 'en'): string {
  return lang === 'zh' ? zh : en;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs ? `${m}m${rs}s` : `${m}m`;
}

/** Rough cost band (in USD) per 1k embeddings, only for guidance. */
function estimateCostBand(provider: string, count: number): { low: number; high: number } {
  const per1k: Record<string, [number, number]> = {
    openai: [0.00002, 0.00013],
    gemini: [0, 0.00001],
    zhipu: [0.00005, 0.00015],
    tongyi: [0.00007, 0.00012],
    custom: [0, 0.0002],
  };
  const range = per1k[provider] || [0, 0.0002];
  const k = count / 1000;
  return { low: range[0] * count, high: range[1] * count };
}

export const ReembedConfirmDialog: React.FC<ReembedConfirmDialogProps> = ({
  isOpen,
  language,
  isDarkMode,
  onClose,
  prevConfig,
  nextConfig,
  onCancelChange,
  onCompleted,
}) => {
  const [stage, setStage] = useState<Stage>('confirm');
  const [vectorCount, setVectorCount] = useState<number>(0);
  const [snapshot, setSnapshot] = useState<ReembedSnapshot | null>(null);
  const [hasResumable, setHasResumable] = useState<boolean>(false);
  const [resumeMode, setResumeMode] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch initial vector count + resume status when the dialog opens.
  useEffect(() => {
    if (!isOpen) {
      setStage('confirm');
      setSnapshot(null);
      setErrorMsg('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { invokeAndroidRag } = await import('../../services/androidRagService');
        const stats = await invokeAndroidRag<{ count?: number }>('rag:stats', {});
        const info = await invokeAndroidRag<{
          hasResumable?: boolean;
          cursor?: number;
          failedCount?: number;
        }>('rag:reembed:info', {});
        if (cancelled) return;
        setVectorCount(typeof stats?.count === 'number' ? stats.count : 0);
        setHasResumable(!!info?.hasResumable);
        setResumeMode(!!info?.hasResumable);
      } catch (e) {
        if (!cancelled) {
          setVectorCount(0);
          setHasResumable(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const startReembed = useCallback(async () => {
    setStage('running');
    setErrorMsg('');
    try {
      const { invokeAndroidRag } = await import('../../services/androidRagService');
      const startResult = await invokeAndroidRag<{
        success: boolean;
        started: boolean;
        alreadyRunning: boolean;
        snapshot: ReembedSnapshot;
      }>('rag:reembed:start', { resume: resumeMode });
      if (!startResult?.success) {
        setStage('error');
        setErrorMsg(tt('启动重新嵌入失败', 'Failed to start re-embed', language));
        return;
      }
      setSnapshot(startResult.snapshot);

      pollRef.current = setInterval(async () => {
        try {
          const status = await invokeAndroidRag<{
            success: boolean;
            running: boolean;
            snapshot: ReembedSnapshot;
          }>('rag:reembed:status', {});
          if (!status?.success) return;
          setSnapshot(status.snapshot);
          if (status.snapshot.finished || !status.running) {
            stopPolling();
            if (status.snapshot.error) {
              setStage('error');
              setErrorMsg(status.snapshot.error);
            } else {
              setStage('done');
              onCompleted?.({
                success: true,
                failedCount: status.snapshot.failedCount || 0,
              });
            }
          }
        } catch (e) {
          // Transient poll error — keep polling, don't tear down.
          console.warn('[ReembedDialog] poll status threw:', e);
        }
      }, POLL_INTERVAL_MS);
    } catch (e) {
      setStage('error');
      setErrorMsg(e instanceof Error ? e.message : 'Unknown error');
    }
  }, [resumeMode, language, stopPolling, onCompleted]);

  const handleCancelConfirm = useCallback(() => {
    onCancelChange?.();
    onClose();
  }, [onCancelChange, onClose]);

  const handleClose = useCallback(() => {
    if (stage === 'running') return; // gate close while running
    stopPolling();
    onClose();
  }, [stage, stopPolling, onClose]);

  const fingerprintChanged = useMemo(() => {
    if (!prevConfig) return false;
    return (
      prevConfig.provider !== nextConfig.provider ||
      prevConfig.model !== nextConfig.model ||
      (prevConfig.dimensions || 0) !== (nextConfig.dimensions || 0)
    );
  }, [prevConfig, nextConfig]);

  if (!isOpen) return null;

  const surface = isDarkMode
    ? 'bg-[#2a221a] text-[#f0e6d2] border-[#5b4732]'
    : 'bg-[#fbf3e3] text-[#3a2e1f] border-[#d8c89a]';
  const subtle = isDarkMode ? 'text-[#b9a482]' : 'text-[#7a6244]';

  const cost = estimateCostBand(nextConfig.provider, vectorCount);

  const progressPct = snapshot && snapshot.total > 0
    ? Math.min(100, Math.floor((snapshot.processed / snapshot.total) * 100))
    : 0;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-4 bg-black/50 backdrop-blur-sm">
      <div className={`relative w-full max-w-lg rounded-2xl border ${surface} shadow-xl`}>
        <button
          type="button"
          onClick={stage === 'running' ? undefined : handleClose}
          disabled={stage === 'running'}
          className={`absolute top-3 right-3 p-1.5 rounded-md transition-opacity ${
            stage === 'running' ? 'opacity-30 cursor-not-allowed' : 'opacity-60 hover:opacity-100'
          }`}
        >
          <X size={16} />
        </button>

        <div className="p-5 sm:p-6">
          <h3 className="ka-h5 font-semibold mb-1">
            {stage === 'done'
              ? tt('重新嵌入完成', 'Re-embedding complete', language)
              : stage === 'error'
                ? tt('重新嵌入失败', 'Re-embedding failed', language)
                : stage === 'running'
                  ? tt('正在重新嵌入向量库…', 'Re-embedding vectors…', language)
                  : tt('需要重新嵌入向量库', 'Re-embedding required', language)}
          </h3>

          {stage === 'confirm' && (
            <>
              <p className={`ka-copy-sm ${subtle} mb-4`}>
                {fingerprintChanged
                  ? tt(
                      '你切换了 embedding 提供商或维度。所有已存在的向量需要用新设置重新嵌入，否则混合维度会破坏检索精度。',
                      'You changed the embedding provider or dimension. Every stored vector must be re-embedded with the new setting, otherwise mixed dimensions will break search accuracy.',
                      language,
                    )
                  : tt(
                      '将用当前 embedding 设置把 Dexie 里的全部向量重新生成一次。',
                      'Will re-generate every vector in Dexie using the current embedding setting.',
                      language,
                    )}
              </p>

              {fingerprintChanged && prevConfig && (
                <div className={`rounded-lg p-3 mb-4 border ${isDarkMode ? 'border-[#5b4732] bg-[#1f1810]' : 'border-[#d8c89a] bg-[#fff8e8]'}`}>
                  <div className={`ka-micro ${subtle} mb-1`}>
                    {tt('变更', 'Change', language)}
                  </div>
                  <div className="ka-copy-sm font-mono">
                    {prevConfig.provider} / {prevConfig.model} / {prevConfig.dimensions || '-'}d
                    <span className="opacity-60 mx-2">→</span>
                    {nextConfig.provider} / {nextConfig.model} / {nextConfig.dimensions || '-'}d
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className={`rounded-lg p-3 border ${isDarkMode ? 'border-[#5b4732] bg-[#1f1810]' : 'border-[#e6d5a8] bg-white/40'}`}>
                  <div className={`ka-micro ${subtle}`}>{tt('待嵌入向量', 'Vectors to embed', language)}</div>
                  <div className="ka-h5 font-semibold">{vectorCount.toLocaleString()}</div>
                </div>
                <div className={`rounded-lg p-3 border ${isDarkMode ? 'border-[#5b4732] bg-[#1f1810]' : 'border-[#e6d5a8] bg-white/40'}`}>
                  <div className={`ka-micro ${subtle}`}>{tt('预计 API 调用', 'Est. API calls', language)}</div>
                  <div className="ka-h5 font-semibold">{vectorCount.toLocaleString()}</div>
                </div>
                <div className={`rounded-lg p-3 border ${isDarkMode ? 'border-[#5b4732] bg-[#1f1810]' : 'border-[#e6d5a8] bg-white/40'} col-span-2`}>
                  <div className={`ka-micro ${subtle}`}>
                    {tt('粗略成本估计 (USD)', 'Rough cost estimate (USD)', language)}
                  </div>
                  <div className="ka-h6 font-semibold">
                    ${cost.low.toFixed(4)} – ${cost.high.toFixed(4)}
                  </div>
                  <div className={`ka-micro ${subtle} mt-1`}>
                    {tt(
                      '仅供参考，按各 provider 公开计费档估算。最终以 API 账单为准。',
                      'Indicative only — estimated against each provider\'s public price tier. Final billing follows your provider\'s invoice.',
                      language,
                    )}
                  </div>
                </div>
              </div>

              {hasResumable && (
                <label className={`flex items-center gap-2 ka-copy-sm mb-3 cursor-pointer ${subtle}`}>
                  <input
                    type="checkbox"
                    checked={resumeMode}
                    onChange={(e) => setResumeMode(e.target.checked)}
                    className="w-4 h-4"
                  />
                  {tt(
                    '续跑：从上次中断的位置继续（不会从头重来）',
                    'Resume from where the last attempt was interrupted (skip already-done rows)',
                    language,
                  )}
                </label>
              )}

              <ul className={`ka-micro ${subtle} mb-5 list-disc list-inside space-y-0.5`}>
                <li>{tt('过程不可回滚，建议先确认 API key + 维度无误', 'Process is irreversible — verify API key + dimensions first', language)}</li>
                <li>{tt('每条失败将重试 3 次后跳过，可在数据管理里查看失败列表', 'Each row retries 3× then is skipped — failed list visible in Data Management', language)}</li>
                <li>{tt('运行中可关闭弹窗，但请保持应用前台直到完成', 'You may close this dialog mid-run, but keep the app foregrounded to completion', language)}</li>
              </ul>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={handleCancelConfirm}
                  className={`px-3 py-2 rounded-lg ka-copy-sm font-semibold ${
                    isDarkMode ? 'bg-[#3e3429] hover:bg-[#4a3f31] text-[#e8d4a8]' : 'bg-white/60 hover:bg-white/80 text-[#5b4732] border border-[#d8c89a]'
                  }`}
                >
                  {tt('取消', 'Cancel', language)}
                </button>
                <button
                  type="button"
                  onClick={startReembed}
                  disabled={vectorCount === 0}
                  className={`px-4 py-2 rounded-lg ka-copy-sm font-semibold flex items-center gap-1.5 ${
                    vectorCount === 0
                      ? (isDarkMode ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-gray-200 text-gray-400 cursor-not-allowed')
                      : (isDarkMode ? 'bg-[#d4a852] hover:bg-[#e0b566] text-[#21150a]' : 'bg-[#e8b34a] hover:bg-[#d9a23a] text-[#3a2710]')
                  }`}
                >
                  <RefreshCw size={14} />
                  {tt('开始重新嵌入', 'Start re-embedding', language)}
                </button>
              </div>
            </>
          )}

          {(stage === 'running' || stage === 'done' || stage === 'error') && (
            <>
              <div className={`rounded-lg p-3 mb-4 border ${isDarkMode ? 'border-[#5b4732] bg-[#1f1810]' : 'border-[#e6d5a8] bg-white/40'}`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    {stage === 'running' && <Loader2 size={14} className="animate-spin" />}
                    {stage === 'done' && <CheckCircle2 size={14} className="text-green-500" />}
                    {stage === 'error' && <AlertTriangle size={14} className="text-red-500" />}
                    <span className="ka-copy-sm font-semibold">
                      {snapshot ? `${snapshot.processed.toLocaleString()} / ${snapshot.total.toLocaleString()}` : '0 / 0'}
                    </span>
                  </div>
                  <span className={`ka-micro ${subtle}`}>{progressPct}%</span>
                </div>
                <div className={`w-full rounded-full overflow-hidden ${isDarkMode ? 'bg-[#3e3429]' : 'bg-[#e8d9b4]'}`} style={{ height: 8 }}>
                  <div
                    className={`h-full ${
                      stage === 'error'
                        ? 'bg-red-500'
                        : stage === 'done'
                          ? 'bg-green-500'
                          : isDarkMode
                            ? 'bg-[#d4a852]'
                            : 'bg-[#e8b34a]'
                    }`}
                    style={{ width: `${progressPct}%`, transition: 'width 0.4s ease' }}
                  />
                </div>
              </div>

              {snapshot && (
                <div className="grid grid-cols-3 gap-3 mb-4">
                  <div>
                    <div className={`ka-micro ${subtle}`}>{tt('API 调用', 'API calls', language)}</div>
                    <div className="ka-copy-sm font-semibold">{(snapshot.apiCallsCount || 0).toLocaleString()}</div>
                  </div>
                  <div>
                    <div className={`ka-micro ${subtle}`}>{tt('失败', 'Failed', language)}</div>
                    <div className="ka-copy-sm font-semibold">{(snapshot.failedCount || 0).toLocaleString()}</div>
                  </div>
                  <div>
                    <div className={`ka-micro ${subtle}`}>{tt('耗时', 'Elapsed', language)}</div>
                    <div className="ka-copy-sm font-semibold">{formatDuration(snapshot.elapsedMs || 0)}</div>
                  </div>
                </div>
              )}

              {snapshot?.extra && stage === 'running' && (
                <div className={`ka-micro ${subtle} mb-4`}>{snapshot.extra}</div>
              )}

              {stage === 'error' && errorMsg && (
                <div className={`rounded-lg p-3 mb-4 border ${isDarkMode ? 'border-red-700 bg-red-950/30 text-red-300' : 'border-red-300 bg-red-50 text-red-700'}`}>
                  <div className="ka-copy-sm">{errorMsg}</div>
                </div>
              )}

              {stage === 'done' && (
                <div className={`rounded-lg p-3 mb-4 border ${isDarkMode ? 'border-green-700 bg-green-950/30 text-green-300' : 'border-green-300 bg-green-50 text-green-700'}`}>
                  <div className="ka-copy-sm">
                    {tt(
                      `成功重新嵌入 ${(snapshot?.processed ?? 0) - (snapshot?.failedCount ?? 0)} 条向量${(snapshot?.failedCount ?? 0) > 0 ? `，跳过 ${snapshot?.failedCount} 条失败项（可在数据管理里重试）。` : '。'}`,
                      `Re-embedded ${(snapshot?.processed ?? 0) - (snapshot?.failedCount ?? 0)} vectors successfully${(snapshot?.failedCount ?? 0) > 0 ? `, skipped ${snapshot?.failedCount} failed (retry from Data Management).` : '.'}`,
                      language,
                    )}
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={handleClose}
                  disabled={stage === 'running'}
                  className={`px-4 py-2 rounded-lg ka-copy-sm font-semibold ${
                    stage === 'running'
                      ? (isDarkMode ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-gray-200 text-gray-400 cursor-not-allowed')
                      : (isDarkMode ? 'bg-[#d4a852] hover:bg-[#e0b566] text-[#21150a]' : 'bg-[#e8b34a] hover:bg-[#d9a23a] text-[#3a2710]')
                  }`}
                >
                  {tt('关闭', 'Close', language)}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default ReembedConfirmDialog;
