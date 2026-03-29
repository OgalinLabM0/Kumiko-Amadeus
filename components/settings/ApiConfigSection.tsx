import React from 'react';
import { ChevronDown, ChevronUp, ShieldCheck } from 'lucide-react';
import { AIConfig, BackupConfig, Language } from '../../types';
import { AiValidationActions } from './AiValidationActions';
import { ApiSecuritySection } from './ApiSecuritySection';
import { ModelAllocationSection } from './ModelAllocationSection';
import { RagConfigSection } from './RagConfigSection';
import { VisionHelperSection } from './VisionHelperSection';

interface ModelValidationResult {
  main: boolean | null;
  summary: boolean | null;
  vision: boolean | null;
}

interface ApiConfigSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  language: Language;
  t_local: any;
  sectionBorder: string;
  innerCardClass: string;
  inputClass: string;
  labelClass: string;
  localAiConfig: AIConfig;
  backupConfig: BackupConfig;
  ragStatus?: 'IDLE' | 'RECALLING' | 'INDEXING' | 'ERROR' | 'OFF' | 'STALE';
  ragProgressLabel?: string | null;
  modelValidationResult: ModelValidationResult;
  isSecurityOpen: boolean;
  isAllocationOpen: boolean;
  isVisionOpen: boolean;
  isRagOpen: boolean;
  validationStatus: string;
  validationStatusType: 'neutral' | 'success' | 'error';
  searchStatus: string;
  searchStatusType: 'neutral' | 'success' | 'error';
  isValidating: boolean;
  isModelValidating: boolean;
  isSearchValidating: boolean;
  onToggleSecurity: () => void;
  onToggleAllocation: () => void;
  onToggleVision: () => void;
  onToggleRag: () => void;
  onUpdateAiConfig: (key: keyof AIConfig, value: any) => void;
  onToggleRagEnabled: () => void;
  onRequestRebuildRag?: () => void;
  onSave: () => void;
  onValidateAll: () => void;
}

export const ApiConfigSection: React.FC<ApiConfigSectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  language,
  t_local,
  sectionBorder,
  innerCardClass,
  inputClass,
  labelClass,
  localAiConfig,
  backupConfig,
  ragStatus = 'OFF',
  ragProgressLabel = null,
  modelValidationResult,
  isSecurityOpen,
  isAllocationOpen,
  isVisionOpen,
  isRagOpen,
  validationStatus,
  validationStatusType,
  searchStatus,
  searchStatusType,
  isValidating,
  isModelValidating,
  isSearchValidating,
  onToggleSecurity,
  onToggleAllocation,
  onToggleVision,
  onToggleRag,
  onUpdateAiConfig,
  onToggleRagEnabled,
  onRequestRebuildRag,
  onSave,
  onValidateAll
}) => {
  return (
    <div className={`flex flex-col rounded-lg border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between p-4 w-full">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-full ${isDarkMode ? 'bg-teal-900/30 text-teal-400' : 'bg-teal-100 text-teal-700'}`}>
            <ShieldCheck size={20} />
          </div>
          <div className="text-left">
            <h3 className={`font-bold text-sm ${isDarkMode ? 'text-yellow-100' : 'text-gray-900'}`}>{t_local.apiTitle}</h3>
            {!isOpen && <p className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{t_local.apiDesc}</p>}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className="opacity-50" /> : <ChevronDown size={16} className="opacity-50" />}
      </button>

      {isOpen && (
        <div className="p-4 pt-0 animate-in slide-in-from-top-2 space-y-4">
          <p className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{t_local.apiDesc}</p>
          <ApiSecuritySection
            isOpen={isSecurityOpen}
            onToggle={onToggleSecurity}
            isDarkMode={isDarkMode}
            localAiConfig={localAiConfig}
            t_local={t_local}
            inputClass={inputClass}
            onUpdateAiConfig={onUpdateAiConfig}
            innerCardClass={innerCardClass}
          />

          <ModelAllocationSection
            isOpen={isAllocationOpen}
            onToggle={onToggleAllocation}
            isDarkMode={isDarkMode}
            innerCardClass={innerCardClass}
            inputClass={inputClass}
            labelClass={labelClass}
            t_local={t_local}
            localAiConfig={localAiConfig}
            modelValidationResult={modelValidationResult}
            onUpdateAiConfig={onUpdateAiConfig}
          />

          <VisionHelperSection
            isOpen={isVisionOpen}
            onToggle={onToggleVision}
            isDarkMode={isDarkMode}
            language={language}
            t_local={t_local}
            inputClass={inputClass}
            labelClass={labelClass}
            innerCardClass={innerCardClass}
            localAiConfig={localAiConfig}
            modelValidationResult={modelValidationResult}
            onUpdateAiConfig={onUpdateAiConfig}
          />

          <RagConfigSection
            isOpen={isRagOpen}
            onToggle={onToggleRag}
            isDarkMode={isDarkMode}
            language={language}
            innerCardClass={innerCardClass}
            backupConfig={backupConfig}
            ragStatus={ragStatus}
            ragProgressLabel={ragProgressLabel}
            onToggleRagEnabled={onToggleRagEnabled}
            onRequestRebuildRag={onRequestRebuildRag}
          />

          <AiValidationActions
            isDarkMode={isDarkMode}
            language={language}
            t_local={t_local}
            validationStatus={validationStatus}
            validationStatusType={validationStatusType}
            searchStatus={searchStatus}
            searchStatusType={searchStatusType}
            isValidating={isValidating}
            isModelValidating={isModelValidating}
            isSearchValidating={isSearchValidating}
            onSave={onSave}
            onValidateAll={onValidateAll}
          />
        </div>
      )}
    </div>
  );
};
