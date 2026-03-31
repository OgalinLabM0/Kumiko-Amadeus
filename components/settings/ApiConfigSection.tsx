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
    <div className={`flex flex-col rounded-[1.2rem] border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between px-4 py-[1.05rem] w-full min-h-[3.5rem]">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-2xl border shrink-0 ${isDarkMode ? 'border-teal-500/20 bg-teal-900/20 text-teal-300' : 'border-teal-200 bg-teal-50/90 text-teal-700'}`}>
            <ShieldCheck size={18} />
          </div>
          <div className="text-left">
            <h3 className={`ka-section-title ${isDarkMode ? 'text-[#f5ebdc]' : 'text-[#49301f]'}`}>{t_local.apiTitle}</h3>
            {!isOpen && <p className={`ka-section-desc ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{t_local.apiDesc}</p>}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} /> : <ChevronDown size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />}
      </button>

      {isOpen && (
        <div className="px-4 pb-4 pt-0 animate-in slide-in-from-top-2 space-y-4">
          <p className={`ka-section-desc ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{t_local.apiDesc}</p>
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
