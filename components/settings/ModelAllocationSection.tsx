import React from 'react';
import { Brain, Zap, Languages, ChevronDown, ChevronUp } from 'lucide-react';
import { AIConfig } from '../../types';
import { getDefaultMainModel, getDefaultSummaryModel } from '../../services/appConfig';
import { ModelCard } from './ModelCard';
import { Collapse } from '../Collapse';

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
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className={`flex h-9 w-9 items-center justify-center rounded-xl border shrink-0 ${isDarkMode ? 'border-teal-500/20 bg-teal-900/20 text-teal-300' : 'border-teal-200 bg-teal-50/90 text-teal-700'}`}>
            <Brain size={16} />
          </div>
          <div className="flex-1 text-left min-w-0">
            <h4 className={`ka-label font-bold ${isDarkMode ? 'text-[#f5ebdc]' : 'text-[#49301f]'}`}>{t_local.allocation}</h4>
            {!isOpen && t_local.allocation_desc && (
              <p className={`ka-section-desc mt-0.5 ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{t_local.allocation_desc}</p>
            )}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} /> : <ChevronDown size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />}
      </button>

      <Collapse isOpen={isOpen} duration={180}>
        <div className="space-y-3">
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
      </Collapse>
    </div>
  );
};
