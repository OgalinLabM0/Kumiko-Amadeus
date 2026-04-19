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
      <span className={`shrink-0 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{icon}</span>
      <span className={`flex-1 ka-copy-sm font-semibold truncate ${isDarkMode ? 'text-gray-200' : 'text-gray-700'}`}>{label}</span>
      {detail && <span className={`ka-micro font-mono truncate max-w-[120px] ${
        status === 'fail' ? 'text-red-400' : (isDarkMode ? 'text-gray-500' : 'text-gray-400')
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
        <div className={`rounded-xl border overflow-hidden animate-in fade-in ${
          isDarkMode ? 'border-gray-700/50 bg-gray-900/40' : 'border-gray-200 bg-gray-50/60'
        }`}>
          <div className={`px-3 py-1.5 border-b ka-micro font-bold tracking-wide ${
            isDarkMode ? 'border-gray-700/50 text-gray-400 bg-gray-800/30' : 'border-gray-200 text-gray-500 bg-gray-100/60'
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
          <button onClick={onSave} className="w-full py-3 rounded-xl bg-teal-600 text-white font-bold hover:bg-teal-500 transition-colors shadow-lg flex items-center justify-center gap-2">
            <Save size={16} /> {t_local.saveAndReload}
          </button>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <button
          onClick={onValidateAll}
          disabled={isValidating || isModelValidating || isSearchValidating}
          className={`w-full py-3 rounded-xl font-bold transition-colors flex items-center justify-center gap-2 ${
            isDarkMode
              ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 hover:bg-blue-600/30'
              : 'bg-blue-50 text-blue-600 border border-blue-200 hover:bg-blue-100'
          } disabled:opacity-50`}
        >
          {(isValidating || isModelValidating || isSearchValidating) ? <RefreshCw className="animate-spin" size={16} /> : <CheckSquare size={16} />}
          {language === 'zh' ? '验证所有配置' : 'VALIDATE ALL'}
        </button>
      </div>
    </>
  );
};
