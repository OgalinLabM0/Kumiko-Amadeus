import React from 'react';
import { ChevronDown, ChevronUp, ShieldCheck } from 'lucide-react';
import { AIConfig, BackupConfig, Language } from '../../types';
import { AiValidationActions, type ExtraValidationResult } from './AiValidationActions';
import { ApiSecuritySection } from './ApiSecuritySection';
import { ModelAllocationSection } from './ModelAllocationSection';
import { RagConfigSection } from './RagConfigSection';
import { VisionHelperSection } from './VisionHelperSection';
import { EmbeddingConfigSection } from './EmbeddingConfigSection';
import { Collapse } from '../Collapse';

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
  // v2.14.6 H.3: minimal-set "extra" validation row state (Vision toggle,
  // Cloud Embedding probe on Android, RAG enable + dependency).
  // Optional so older test harnesses keep compiling — passed through to
  // AiValidationActions.extraResult.
  extraValidationResult?: ExtraValidationResult;
  isSecurityOpen: boolean;
  isAllocationOpen: boolean;
  isVisionOpen: boolean;
  isEmbeddingOpen: boolean;
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
  onToggleEmbedding: () => void;
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
  extraValidationResult,
  isSecurityOpen,
  isAllocationOpen,
  isVisionOpen,
  isEmbeddingOpen,
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
  onToggleEmbedding,
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

      <Collapse isOpen={isOpen}>
        <div className="px-4 pb-4 pt-0 space-y-4">
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

          {/* F2A.3c: Cloud Embedding sits right above RAG since it is RAG's
              upstream dependency on Capacitor (Android RAG retrieves via
              cloud embedding API; without a key configured RAG can never
              run). On Electron / PWA EmbeddingConfigSection renders null
              internally (PC's local bge-m3 ONNX is the embedding backend),
              so this slot is invisible there with zero layout impact. */}
          <EmbeddingConfigSection
            isOpen={isEmbeddingOpen}
            onToggle={onToggleEmbedding}
            isDarkMode={isDarkMode}
            language={language}
            sectionBorder={sectionBorder}
            innerCardClass={innerCardClass}
            inputClass={inputClass}
            fieldLabelClass={`${isDarkMode ? 'text-gray-400' : 'text-gray-700'} ka-label`}
            helperClass={`${isDarkMode ? 'text-gray-500' : 'text-gray-500'} ka-micro`}
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
            modelValidationResult={modelValidationResult}
            extraResult={extraValidationResult}
            modelMainName={localAiConfig.model_main}
            modelSummaryName={localAiConfig.model_summary}
            onSave={onSave}
            onValidateAll={onValidateAll}
          />
        </div>
      </Collapse>
    </div>
  );
};
