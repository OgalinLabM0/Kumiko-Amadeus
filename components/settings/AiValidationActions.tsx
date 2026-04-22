import React from 'react';
import { AlertTriangle, Check, CheckSquare, Globe, Key, Brain, Zap, RefreshCw, Save, Loader2 } from 'lucide-react';
import { Language } from '../../types';

type StatusType = 'neutral' | 'success' | 'error';

interface ModelValidationResult {
  main: boolean | null;
  summary: boolean | null;
  vision: boolean | null;
}

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
  onSave: () => void;
  onValidateAll: () => void;
}

const CheckItem: React.FC<{
  icon: React.ReactNode;
  label: string;
  detail?: string;
  status: 'idle' | 'checking' | 'pass' | 'fail';
  isDarkMode: boolean;
}> = ({ icon, label, detail, status, isDarkMode }) => {
  const statusIcon = status === 'checking'
    ? <Loader2 size={14} className="animate-spin text-blue-400 shrink-0" />
    : status === 'pass'
    ? <Check size={14} className="text-green-500 shrink-0" />
    : status === 'fail'
    ? <AlertTriangle size={14} className="text-red-500 shrink-0" />
    : <div className={`w-3.5 h-3.5 rounded-full border shrink-0 ${isDarkMode ? 'border-gray-600' : 'border-gray-300'}`} />;

  return (
    <div className={`flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors ${
      status === 'fail'
        ? (isDarkMode ? 'bg-red-950/30' : 'bg-red-50')
        : status === 'pass'
        ? (isDarkMode ? 'bg-green-950/20' : 'bg-green-50/60')
        : ''
    }`}>
      <span className={`shrink-0 ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{icon}</span>
      <span className={`flex-1 ka-copy-sm font-semibold truncate ${isDarkMode ? 'text-[#f5ebdc]' : 'text-[#49301f]'}`}>{label}</span>
      {detail && <span className={`ka-micro font-mono truncate max-w-[120px] ${
        status === 'fail' ? 'text-red-400' : (isDarkMode ? 'text-[#b69f87]' : 'text-[#9e7c51]')
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
  onSave,
  onValidateAll
}) => {
  const hasAnyResult = validationStatus || searchStatus || modelValidationResult.main !== null || modelValidationResult.summary !== null;

  const apiStatus: 'idle' | 'checking' | 'pass' | 'fail' =
    isValidating && !validationStatus ? 'checking'
    : validationStatusType === 'success' ? 'pass'
    : validationStatusType === 'error' ? 'fail'
    : 'idle';

  const mainModelStatus: 'idle' | 'checking' | 'pass' | 'fail' =
    isModelValidating && modelValidationResult.main === null ? 'checking'
    : modelValidationResult.main === true ? 'pass'
    : modelValidationResult.main === false ? 'fail'
    : 'idle';

  const summaryModelStatus: 'idle' | 'checking' | 'pass' | 'fail' =
    isModelValidating && modelValidationResult.summary === null ? 'checking'
    : modelValidationResult.summary === true ? 'pass'
    : modelValidationResult.summary === false ? 'fail'
    : 'idle';

  const searchItemStatus: 'idle' | 'checking' | 'pass' | 'fail' =
    isSearchValidating ? 'checking'
    : searchStatusType === 'success' ? 'pass'
    : searchStatusType === 'error' ? 'fail'
    : 'idle';

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
