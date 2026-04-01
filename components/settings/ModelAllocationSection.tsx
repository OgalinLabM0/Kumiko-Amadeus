import React from 'react';
import { Brain, Zap, Languages } from 'lucide-react';
import { AIConfig } from '../../types';
import { getDefaultMainModel, getDefaultSummaryModel } from '../../services/appConfig';
import { ModelCard } from './ModelCard';

interface AllocationValidationResult {
  main: boolean | null;
  summary: boolean | null;
}

interface ModelAllocationSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  innerCardClass: string;
  inputClass: string;
  labelClass: string;
  t_local: any;
  localAiConfig: AIConfig;
  modelValidationResult: AllocationValidationResult;
  onUpdateAiConfig: (key: keyof AIConfig, value: any) => void;
}

export const ModelAllocationSection: React.FC<ModelAllocationSectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  innerCardClass,
  inputClass,
  labelClass,
  t_local,
  localAiConfig,
  modelValidationResult,
  onUpdateAiConfig
}) => {
  return (
    <div className={innerCardClass}>
      <button onClick={onToggle} className="w-full flex items-center justify-between mb-2">
        <h4 className={`ka-label flex items-center gap-2 ${isDarkMode ? 'text-teal-400' : 'text-teal-600'}`}>
          <Brain size={12} /> {t_local.allocation}
        </h4>
        <span className="ka-micro opacity-50">{isOpen ? '▼' : '▲'}</span>
      </button>
      {t_local.allocation_desc && (
        <p className={`ka-micro mb-3 leading-relaxed ${isDarkMode ? 'text-[#b9c8c7]' : 'text-[#5d7f7b]'}`}>
          {t_local.allocation_desc}
        </p>
      )}

      {isOpen && (
        <div className="space-y-3 animate-in slide-in-from-top-2">
          <ModelCard
            title={t_local.slotA}
            slotKey="model_main"
            icon={Brain}
            desc=""
            defaultModel={getDefaultMainModel(localAiConfig.provider)}
            validationResult={modelValidationResult.main}
            value={localAiConfig.model_main}
            onChange={(val) => onUpdateAiConfig('model_main', val)}
            onReset={() => onUpdateAiConfig('model_main', getDefaultMainModel(localAiConfig.provider))}
            t_local={t_local}
            isDarkMode={isDarkMode}
            inputClass={inputClass}
            labelClass={labelClass}
          />
          <ModelCard
            title={t_local.slotB}
            slotKey="model_summary"
            icon={Zap}
            desc=""
            defaultModel={getDefaultSummaryModel(localAiConfig.provider)}
            validationResult={modelValidationResult.summary}
            value={localAiConfig.model_summary}
            onChange={(val) => onUpdateAiConfig('model_summary', val)}
            onReset={() => onUpdateAiConfig('model_summary', getDefaultSummaryModel(localAiConfig.provider))}
            t_local={t_local}
            isDarkMode={isDarkMode}
            inputClass={inputClass}
            labelClass={labelClass}
          />
          <ModelCard
            title={t_local.slotC || 'Slot C · TTS Translation'}
            slotKey="model_translator"
            icon={Languages}
            desc={t_local.slotC_desc || ''}
            defaultModel=""
            validationResult={null}
            value={localAiConfig.model_translator || ''}
            onChange={(val) => onUpdateAiConfig('model_translator', val)}
            onReset={() => onUpdateAiConfig('model_translator', '')}
            t_local={t_local}
            isDarkMode={isDarkMode}
            inputClass={inputClass}
            labelClass={labelClass}
          />
        </div>
      )}
    </div>
  );
};
