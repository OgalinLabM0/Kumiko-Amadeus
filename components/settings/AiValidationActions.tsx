import React from 'react';
import { AlertTriangle, Check, CheckSquare, Globe, Key, Brain, Zap, RefreshCw, Save, Loader2, MinusCircle, Eye, Cloud, Database } from 'lucide-react';
import { Language } from '../../types';

type StatusType = 'neutral' | 'success' | 'error';

interface ModelValidationResult {
  main: boolean | null;
  summary: boolean | null;
  vision: boolean | null;
}

// v2.14.6 H.1: extra row inputs surfacing optional-but-relevant config
// state alongside the four core checks (API / main model / summary
// model / search). Previously the user only saw 4 rows even though
// Vision Helper, Cloud Embedding (Android), and RAG can each silently
// break the assistant — vision returns text-only answers, embedding
// failure means RAG never indexes, RAG-off means long-term memory is
// muted. We now surface those three explicitly with an "optional-empty"
// neutral state for things that are off-by-design (vision toggle off,
// RAG toggle off) so they don't read as failures, while keeping a hard
// fail for genuinely broken dependencies (Embedding missing on Android,
// or RAG enabled on Android without a working Embedding test).
export interface ExtraValidationResult {
  visionEnabled: boolean;
  embeddingConfigured: boolean | null;
  embeddingTestPass: boolean | null;
  embeddingChecking: boolean;
  ragEnabled: boolean;
  isCapacitorMobile: boolean;
}

const DEFAULT_EXTRA_RESULT: ExtraValidationResult = {
  visionEnabled: false,
  embeddingConfigured: null,
  embeddingTestPass: null,
  embeddingChecking: false,
  ragEnabled: false,
  isCapacitorMobile: false,
};

interface AiValidationActionsProps {
  isDarkMode: boolean;
  language: Language;
  t_local: any;
  validationStatus: string;
  validationStatusType: StatusType;
  searchStatus: string;
  searchStatusType: StatusType;
  isValidating: boolean;
  isModelValidating: boolean;
  isSearchValidating: boolean;
  modelValidationResult: ModelValidationResult;
  modelMainName?: string;
  modelSummaryName?: string;
  // v2.14.6 H.3: optional so legacy call sites (storybook, tests) keep
  // compiling. Real settings panel now always passes this.
  extraResult?: ExtraValidationResult;
  onSave: () => void;
  onValidateAll: () => void;
}

type CheckStatus = 'idle' | 'checking' | 'pass' | 'fail' | 'optional-empty';

const CheckItem: React.FC<{
  icon: React.ReactNode;
  label: string;
  detail?: string;
  status: CheckStatus;
  isDarkMode: boolean;
}> = ({ icon, label, detail, status, isDarkMode }) => {
  const statusIcon = status === 'checking'
    ? <Loader2 size={14} className="animate-spin text-blue-400 shrink-0" />
    : status === 'pass'
    ? <Check size={14} className="text-green-500 shrink-0" />
    : status === 'fail'
    ? <AlertTriangle size={14} className="text-red-500 shrink-0" />
    : status === 'optional-empty'
    ? <MinusCircle size={14} className={`shrink-0 ${isDarkMode ? 'text-yellow-400/85' : 'text-yellow-600/85'}`} />
    : <div className={`w-3.5 h-3.5 rounded-full border shrink-0 ${isDarkMode ? 'border-gray-600' : 'border-gray-300'}`} />;

  return (
    <div className={`flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors ${
      status === 'fail'
        ? (isDarkMode ? 'bg-red-950/30' : 'bg-red-50')
        : status === 'pass'
        ? (isDarkMode ? 'bg-green-950/20' : 'bg-green-50/60')
        : status === 'optional-empty'
        // soft yellow wash so optional-but-empty rows read as
        // "intentionally off / not configured" rather than "broken"
        ? (isDarkMode ? 'bg-yellow-950/15' : 'bg-yellow-50/60')
        : ''
    }`}>
      <span className={`shrink-0 ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{icon}</span>
      <span className={`flex-1 ka-copy-sm font-semibold truncate ${isDarkMode ? 'text-[#f5ebdc]' : 'text-[#49301f]'}`}>{label}</span>
      {detail && <span className={`ka-micro font-mono truncate max-w-[140px] ${
        status === 'fail'
          ? 'text-red-400'
          : status === 'optional-empty'
          ? (isDarkMode ? 'text-yellow-300/85' : 'text-yellow-700/85')
          : (isDarkMode ? 'text-[#b69f87]' : 'text-[#9e7c51]')
      }`}>{detail}</span>}
      {statusIcon}
    </div>
  );
};

export const AiValidationActions: React.FC<AiValidationActionsProps> = ({
  isDarkMode,
  language,
  t_local,
  validationStatus,
  validationStatusType,
  searchStatus,
  searchStatusType,
  isValidating,
  isModelValidating,
  isSearchValidating,
  modelValidationResult,
  modelMainName,
  modelSummaryName,
  extraResult = DEFAULT_EXTRA_RESULT,
  onSave,
  onValidateAll
}) => {
  const hasAnyResult = validationStatus || searchStatus || modelValidationResult.main !== null || modelValidationResult.summary !== null;

  const apiStatus: CheckStatus =
    isValidating && !validationStatus ? 'checking'
    : validationStatusType === 'success' ? 'pass'
    : validationStatusType === 'error' ? 'fail'
    : 'idle';

  const mainModelStatus: CheckStatus =
    isModelValidating && modelValidationResult.main === null ? 'checking'
    : modelValidationResult.main === true ? 'pass'
    : modelValidationResult.main === false ? 'fail'
    : 'idle';

  const summaryModelStatus: CheckStatus =
    isModelValidating && modelValidationResult.summary === null ? 'checking'
    : modelValidationResult.summary === true ? 'pass'
    : modelValidationResult.summary === false ? 'fail'
    : 'idle';

  const searchItemStatus: CheckStatus =
    isSearchValidating ? 'checking'
    : searchStatusType === 'success' ? 'pass'
    : searchStatusType === 'error' ? 'fail'
    : 'idle';

  // v2.14.6 H.1: Vision row. Mirrors the user's plan-A "minimal set":
  // - if Vision Helper toggle is OFF → optional-empty (yellow MinusCircle)
  // - if Vision Helper toggle is ON → reuse modelValidationResult.vision
  //   from the existing validateModels pipeline, so Validate-All already
  //   covers it without an extra IPC call.
  const visionStatus: CheckStatus = !extraResult.visionEnabled
    ? 'optional-empty'
    : isModelValidating && modelValidationResult.vision === null
      ? 'checking'
      : modelValidationResult.vision === true
        ? 'pass'
        : modelValidationResult.vision === false
          ? 'fail'
          : 'idle';

  // v2.14.6 H.1: Cloud Embedding row — only relevant on Capacitor
  // Android (PC uses local bge-m3 ONNX so embedding is implicit). On
  // Android, an unconfigured Embedding hard-fails because RAG, diary,
  // and psyche all silently break without it.
  const embeddingStatus: CheckStatus = !extraResult.isCapacitorMobile
    ? 'idle' // hidden via render guard below
    : extraResult.embeddingChecking
      ? 'checking'
      : extraResult.embeddingConfigured === false
        ? 'fail'
        : extraResult.embeddingConfigured === true && extraResult.embeddingTestPass === false
          ? 'fail'
          : extraResult.embeddingConfigured === true && extraResult.embeddingTestPass === true
            ? 'pass'
            : extraResult.embeddingConfigured === true && extraResult.embeddingTestPass === null
              ? 'idle' // configured but not yet tested in this Validate-All run
              : 'idle';

  // v2.14.6 H.1: RAG row. OFF → optional-empty (long-term memory is just
  // muted, not broken). ON + Android + Embedding not green → fail
  // (hard dependency). ON otherwise → pass.
  const ragStatus: CheckStatus = !extraResult.ragEnabled
    ? 'optional-empty'
    : extraResult.isCapacitorMobile && extraResult.embeddingTestPass !== true
      ? 'fail'
      : 'pass';

  const visionDetail = !extraResult.visionEnabled
    ? (language === 'zh' ? '未启用' : 'OFF')
    : undefined;
  const embeddingDetail = embeddingStatus === 'fail' && extraResult.embeddingConfigured === false
    ? (language === 'zh' ? '未配置' : 'NOT SET')
    : embeddingStatus === 'fail' && extraResult.embeddingTestPass === false
      ? (language === 'zh' ? '连接失败' : 'FAILED')
      : embeddingStatus === 'pass'
        ? (language === 'zh' ? '已连通' : 'OK')
        : undefined;
  const ragDetail = !extraResult.ragEnabled
    ? (language === 'zh' ? '未启用' : 'OFF')
    : ragStatus === 'fail'
      ? (language === 'zh' ? '需要 Embedding' : 'NEEDS EMBED')
      : undefined;

  // v2.14.6 H.1: extra rows only render once the user actually clicked
  // "Validate All" or made other progress, matching the existing
  // hasAnyResult gate. Avoids a giant 7-row table popping up on every
  // settings panel open before the user does anything.
  const showExtraRows = hasAnyResult;

  return (
    <>
      {hasAnyResult && (
        <div className={`rounded-[1.05rem] border overflow-hidden animate-in fade-in shadow-[inset_0_1px_0_rgba(255,255,255,0.24)] ${
          isDarkMode ? 'border-[#7a5830]/55 bg-[linear-gradient(180deg,rgba(36,26,17,0.84),rgba(26,19,13,0.78))]' : 'border-[#ebe1d3] bg-[rgba(255,255,255,0.9)]'
        }`}>
          <div className={`px-3 py-2 border-b ka-micro font-semibold tracking-wide ${
            isDarkMode ? 'border-[#7a5830]/35 text-[#d7c7b5] bg-[#1f1610]/50' : 'border-[#ebe1d3] text-[#8a6b4e] bg-[#faf3e4]/70'
          }`}>
            {language === 'zh' ? '验证结果' : 'VALIDATION RESULTS'}
          </div>
          <div className="py-1">
            <CheckItem
              icon={<Key size={13} />}
              label={language === 'zh' ? 'API 连接' : 'API Connection'}
              status={apiStatus}
              isDarkMode={isDarkMode}
            />
            <CheckItem
              icon={<Brain size={13} />}
              label={language === 'zh' ? '主对话模型' : 'Main Model'}
              detail={modelMainName}
              status={mainModelStatus}
              isDarkMode={isDarkMode}
            />
            <CheckItem
              icon={<Zap size={13} />}
              label={language === 'zh' ? '摘要模型' : 'Summary Model'}
              detail={modelSummaryName}
              status={summaryModelStatus}
              isDarkMode={isDarkMode}
            />
            {showExtraRows && (
              <CheckItem
                icon={<Eye size={13} />}
                label={language === 'zh' ? '视觉辅助' : 'Vision Helper'}
                detail={visionDetail}
                status={visionStatus}
                isDarkMode={isDarkMode}
              />
            )}
            {showExtraRows && extraResult.isCapacitorMobile && (
              <CheckItem
                icon={<Cloud size={13} />}
                label={language === 'zh' ? '云端 Embedding' : 'Cloud Embedding'}
                detail={embeddingDetail}
                status={embeddingStatus}
                isDarkMode={isDarkMode}
              />
            )}
            {showExtraRows && (
              <CheckItem
                icon={<Database size={13} />}
                label={language === 'zh' ? '长期记忆 (RAG)' : 'Long-term Memory (RAG)'}
                detail={ragDetail}
                status={ragStatus}
                isDarkMode={isDarkMode}
              />
            )}
            {(searchItemStatus !== 'idle' || searchStatus) && (
              <CheckItem
                icon={<Globe size={13} />}
                label={language === 'zh' ? '联网搜索' : 'Web Search'}
                status={searchItemStatus}
                isDarkMode={isDarkMode}
              />
            )}
          </div>
        </div>
      )}

      {validationStatusType === 'success' && (
        <div className="flex flex-col gap-2 animate-in fade-in">
          <button onClick={onSave} className={`w-full py-3 rounded-2xl font-semibold transition-colors flex items-center justify-center gap-2 border ${isDarkMode
            ? 'border-[#c79a2f]/55 bg-[#c79a2f]/12 text-[#f2e5cf] hover:bg-[#c79a2f]/22'
            : 'border-[#c59142]/45 bg-[#c59142]/10 text-[#8a6b4e] hover:bg-[#c59142]/20'}`}>
            <Save size={16} /> {t_local.saveAndReload}
          </button>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <button
          onClick={onValidateAll}
          disabled={isValidating || isModelValidating || isSearchValidating}
          className={`relative w-full py-3 rounded-2xl font-semibold transition-all hover:-translate-y-[1px] active:translate-y-0 active:scale-[0.99] disabled:opacity-50 disabled:hover:translate-y-0 flex items-center justify-center gap-2 ${isDarkMode
            ? 'bg-gradient-to-r from-[#d4a852] via-[#c79a2f] to-[#b8860b] text-[#1b140d] shadow-[0_10px_28px_-12px_rgba(212,168,82,0.55)] hover:shadow-[0_14px_32px_-10px_rgba(212,168,82,0.75)]'
            : 'bg-gradient-to-r from-[#c59142] via-[#b8860b] to-[#a8743a] text-[#faf3e4] shadow-[0_10px_28px_-12px_rgba(197,145,66,0.5)] hover:shadow-[0_14px_32px_-10px_rgba(197,145,66,0.7)]'}`}
        >
          {(isValidating || isModelValidating || isSearchValidating) ? <RefreshCw className="animate-spin" size={16} /> : <CheckSquare size={16} />}
          {language === 'zh' ? '验证所有配置' : 'VALIDATE ALL'}
        </button>
      </div>
    </>
  );
};
