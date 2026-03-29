import React from 'react';
import { AlertTriangle, Check, CheckSquare, Globe, RefreshCw, Save } from 'lucide-react';
import { Language } from '../../types';

type StatusType = 'neutral' | 'success' | 'error';

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
  onSave: () => void;
  onValidateAll: () => void;
}

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
  onSave,
  onValidateAll
}) => {
  return (
    <>
      {validationStatus && (
        <div className={`flex items-center gap-2 text-xs font-bold font-mono p-2 rounded border ${
          validationStatusType === 'error' ? 'text-red-500 bg-red-500/10 border-red-500/20' :
          validationStatusType === 'success' ? 'text-green-500 bg-green-500/10 border-green-500/20' :
          (isDarkMode ? 'text-gray-400 bg-gray-500/10 border-gray-500/20' : 'text-gray-600 bg-gray-200 border-gray-300')
        }`}>
          {validationStatusType === 'error' && <AlertTriangle size={14} />}
          {validationStatusType === 'success' && <Check size={14} />}
          {validationStatus}
        </div>
      )}

      {searchStatus && (
        <div className={`flex items-center gap-2 text-xs font-bold font-mono p-2 rounded border ${
          searchStatusType === 'error' ? 'text-red-500 bg-red-500/10 border-red-500/20' :
          searchStatusType === 'success' ? 'text-green-500 bg-green-500/10 border-green-500/20' :
          (isDarkMode ? 'text-gray-400 bg-gray-500/10 border-gray-500/20' : 'text-gray-600 bg-gray-200 border-gray-300')
        }`}>
          {searchStatusType === 'error' && <AlertTriangle size={14} />}
          {searchStatusType === 'success' && <Globe size={14} />}
          {searchStatus}
        </div>
      )}

      {validationStatusType === 'success' && (
        <div className="flex flex-col gap-2 animate-in fade-in">
          <button onClick={onSave} className="w-full py-3 rounded bg-teal-600 text-white font-bold hover:bg-teal-500 transition-colors shadow-lg flex items-center justify-center gap-2">
            <Save size={16} /> {t_local.saveAndReload}
          </button>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <button
          onClick={onValidateAll}
          disabled={isValidating || isModelValidating || isSearchValidating}
          className={`w-full py-3 rounded font-bold transition-colors flex items-center justify-center gap-2 ${
            isDarkMode
              ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 hover:bg-blue-600/30'
              : 'bg-blue-50 text-blue-600 border border-blue-200 hover:bg-blue-100'
          } disabled:opacity-50`}
        >
          {(isValidating || isModelValidating || isSearchValidating) ? <RefreshCw className="animate-spin" size={16} /> : <CheckSquare size={16} />}
          {language === 'zh' ? '验证所有配置' : 'VALIDATE ALL CONFIGURATIONS'}
        </button>
      </div>
    </>
  );
};
