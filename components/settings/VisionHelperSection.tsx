import React from 'react';
import { Check, Eye, Globe, ChevronDown, ChevronUp } from 'lucide-react';
import { AIConfig, Language } from '../../types';
import { getDefaultVisionModel } from '../../services/appConfig';
import { ModelCard } from './ModelCard';
import { Collapse } from '../Collapse';

interface VisionValidationResult {
  vision: boolean | null;
}

interface VisionHelperSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  language: Language;
  t_local: any;
  inputClass: string;
  labelClass: string;
  innerCardClass: string;
  localAiConfig: AIConfig;
  modelValidationResult: VisionValidationResult;
  onUpdateAiConfig: (key: keyof AIConfig, value: any) => void;
}

export const VisionHelperSection: React.FC<VisionHelperSectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  language,
  t_local,
  inputClass,
  labelClass,
  innerCardClass,
  localAiConfig,
  modelValidationResult,
  onUpdateAiConfig
}) => {
  return (
    <div className={innerCardClass}>
      <button onClick={onToggle} className="w-full flex items-center justify-between mb-2">
        <h4 className={`ka-label font-bold flex items-center gap-2 ${isDarkMode ? 'text-teal-300' : 'text-teal-700'}`}>
          <Eye size={13} /> {language === 'zh' ? '视觉辅助模型 (VISION HELPER)' : 'VISION HELPER'}
        </h4>
        {isOpen ? <ChevronUp size={14} className={isDarkMode ? 'text-gray-500' : 'text-gray-400'} /> : <ChevronDown size={14} className={isDarkMode ? 'text-gray-500' : 'text-gray-400'} />}
      </button>
      {!isOpen && (
        <p className={`ka-micro mb-1 leading-relaxed ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
          {language === 'zh' ? '当主模型无视觉能力时，用于解析图片并转述给主模型。' : 'Used to parse images and describe them to the main model if it lacks vision capabilities.'}
        </p>
      )}

      <Collapse isOpen={isOpen} duration={180}>
        <div>
          <div className="flex items-center justify-end mb-2">
            <div className="flex items-center gap-1.5 cursor-pointer" onClick={() => onUpdateAiConfig('useVisionHelper', !localAiConfig.useVisionHelper)}>
              <div className={`w-3 h-3 border rounded-sm flex items-center justify-center transition-colors ${localAiConfig.useVisionHelper ? 'bg-teal-500 border-teal-500' : (isDarkMode ? 'border-gray-500' : 'border-gray-400')}`}>
                {localAiConfig.useVisionHelper && <Check size={10} className="text-white" />}
              </div>
              <span className={`ka-micro font-mono ${isDarkMode ? 'text-gray-200' : 'text-gray-700'}`}>{language === 'zh' ? '启用视觉辅助' : 'Enable Vision Helper'}</span>
            </div>
          </div>

          {localAiConfig.useVisionHelper && (
            <div className="space-y-3 pt-2 border-t border-gray-500/10">
              <p className={`ka-micro font-mono mb-2 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                {language === 'zh' ? '当主模型无视觉能力时，用于解析图片并转述给主模型。' : 'Used to parse images and describe them to the main model if it lacks vision capabilities.'}
              </p>

              <div className="mb-4">
                <label className={labelClass}>{language === 'zh' ? 'API 提供商' : 'API Provider'}</label>
                <select
                  value={localAiConfig.visionProvider || localAiConfig.provider || 'gemini'}
                  onChange={(e) => onUpdateAiConfig('visionProvider', e.target.value)}
                  className={inputClass}
                >
                  <option value="gemini">Google Gemini</option>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic Claude</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="grok">xAI Grok</option>
                  <option value="openrouter">OpenRouter.ai</option>
                </select>
              </div>

              <div>
                <label className={labelClass}>{language === 'zh' ? '视觉 API KEY (可选，默认使用主配置)' : 'VISION API KEY (Optional, fallback to main)'}</label>
                <input
                  type="password"
                  value={localAiConfig.visionApiKey || ''}
                  onChange={(e) => onUpdateAiConfig('visionApiKey', e.target.value)}
                  placeholder={t_local.keyPlaceHolder}
                  className={inputClass}
                />
              </div>

              <div className="mt-4 pt-4 border-t border-gray-500/10">
                <div className="flex items-center justify-between mb-2">
                  <label className={`${labelClass} flex items-center gap-1`}>
                    <Globe size={10} /> API ENDPOINT
                  </label>
                  <div className="flex items-center gap-1.5 cursor-pointer" onClick={() => onUpdateAiConfig('useVisionCustomEndpoint', !(localAiConfig.useVisionCustomEndpoint ?? localAiConfig.useCustomEndpoint))}>
                    <div className={`w-3 h-3 border rounded-sm flex items-center justify-center transition-colors ${(localAiConfig.useVisionCustomEndpoint ?? localAiConfig.useCustomEndpoint) ? 'bg-teal-500 border-teal-500' : (isDarkMode ? 'border-gray-500' : 'border-gray-400')}`}>
                      {(localAiConfig.useVisionCustomEndpoint ?? localAiConfig.useCustomEndpoint) && <Check size={10} className="text-white" />}
                    </div>
                    <span className="ka-micro font-mono">{t_local.useCustomEndpoint}</span>
                  </div>
                </div>

                {(localAiConfig.useVisionCustomEndpoint ?? localAiConfig.useCustomEndpoint) ? (
                  <div className="space-y-2 animate-in slide-in-from-top-1">
                    <input
                      type="text"
                      value={localAiConfig.visionCustomEndpoint ?? localAiConfig.customEndpoint ?? ''}
                      onChange={(e) => onUpdateAiConfig('visionCustomEndpoint', e.target.value)}
                      placeholder={t_local.customEndpointPlaceholder}
                      className={inputClass}
                    />
                  </div>
                ) : (
                  <div className={`ka-micro font-mono italic p-2 rounded ${isDarkMode ? 'bg-black/30 text-gray-400' : 'bg-gray-200 text-gray-600'}`}>
                    {t_local.useCustomEndpointDesc}
                  </div>
                )}
              </div>

              <ModelCard
                title={language === 'zh' ? '视觉模型' : 'Vision Model'}
                slotKey="model_vision"
                icon={Eye}
                desc=""
                defaultModel={getDefaultVisionModel(localAiConfig.visionProvider || localAiConfig.provider)}
                validationResult={modelValidationResult.vision}
                value={localAiConfig.model_vision || ''}
                onChange={(val) => onUpdateAiConfig('model_vision', val)}
                onReset={() => onUpdateAiConfig('model_vision', getDefaultVisionModel(localAiConfig.visionProvider || localAiConfig.provider))}
                t_local={t_local}
                isDarkMode={isDarkMode}
                inputClass={inputClass}
                labelClass={labelClass}
              />
            </div>
          )}
        </div>
      </Collapse>
    </div>
  );
};
