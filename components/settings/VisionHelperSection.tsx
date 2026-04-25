import React, { useMemo } from 'react';
import { Check, Eye, Globe, ChevronDown, ChevronUp } from 'lucide-react';
import { AIConfig, AIProvider, Language } from '../../types';
import { getDefaultEndpoint, getDefaultVisionModel } from '../../services/appConfig';
import { ModelCard } from './ModelCard';
import { Collapse } from '../Collapse';
import { ThemedSelect, type ThemedSelectItem } from '../common/ThemedSelect';
import { ComposableInput } from '../common/ComposableInput';

const PROVIDER_OPTIONS: { value: AIProvider; label: string; group: 'intl' | 'cn' }[] = [
  { value: 'gemini', label: 'Google Gemini', group: 'intl' },
  { value: 'openai', label: 'OpenAI', group: 'intl' },
  { value: 'anthropic', label: 'Anthropic Claude', group: 'intl' },
  { value: 'deepseek', label: 'DeepSeek', group: 'intl' },
  { value: 'grok', label: 'xAI Grok', group: 'intl' },
  { value: 'openrouter', label: 'OpenRouter', group: 'intl' },
  { value: 'volcengine', label: '火山方舟 (Volcengine)', group: 'cn' },
  { value: 'dashscope', label: '阿里百炼 (DashScope)', group: 'cn' },
  { value: 'zhipu', label: '智谱 GLM (Zhipu)', group: 'cn' },
  { value: 'moonshot', label: 'Moonshot / Kimi', group: 'cn' },
  { value: 'qianfan', label: '百度千帆 (Qianfan)', group: 'cn' },
  { value: 'hunyuan', label: '腾讯混元 (Hunyuan)', group: 'cn' },
  { value: 'spark', label: '讯飞星火 (Spark)', group: 'cn' },
  { value: 'minimax', label: 'MiniMax', group: 'cn' },
];

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
  const providerOptions = useMemo<ThemedSelectItem[]>(
    () => [
      {
        label: language === 'zh' ? '── 国际平台 ──' : '── International ──',
        options: PROVIDER_OPTIONS.filter(p => p.group === 'intl').map(p => ({
          value: p.value,
          label: p.label,
        })),
      },
      {
        label: language === 'zh' ? '── 中国平台 ──' : '── China Platforms ──',
        options: PROVIDER_OPTIONS.filter(p => p.group === 'cn').map(p => ({
          value: p.value,
          label: p.label,
        })),
      },
    ],
    [language],
  );

  const handleVisionProviderChange = (newProvider: AIProvider) => {
    onUpdateAiConfig('visionProvider', newProvider);
    if (newProvider === 'gemini') {
      onUpdateAiConfig('useVisionCustomEndpoint', false);
      onUpdateAiConfig('visionCustomEndpoint', '');
    } else {
      const endpoint = getDefaultEndpoint(newProvider);
      onUpdateAiConfig('useVisionCustomEndpoint', true);
      onUpdateAiConfig('visionCustomEndpoint', endpoint);
    }
  };

  const effectiveVisionProvider = (localAiConfig.visionProvider || localAiConfig.provider || 'gemini') as AIProvider;

  return (
    <div className={innerCardClass}>
      <button onClick={onToggle} className="w-full flex items-center justify-between mb-2">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className={`flex h-9 w-9 items-center justify-center rounded-xl border shrink-0 ${isDarkMode ? 'border-indigo-500/20 bg-indigo-900/20 text-indigo-300' : 'border-indigo-200 bg-indigo-50/90 text-indigo-700'}`}>
            <Eye size={16} />
          </div>
          <div className="flex-1 text-left min-w-0">
            <h4 className={`ka-label font-bold ${isDarkMode ? 'text-[#f5ebdc]' : 'text-[#49301f]'}`}>{language === 'zh' ? '视觉辅助模型 (VISION HELPER)' : 'VISION HELPER'}</h4>
            {!isOpen && (
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border ${localAiConfig.useVisionHelper
                  ? (isDarkMode ? 'bg-indigo-900/25 border-indigo-500/25 text-indigo-300' : 'bg-indigo-50 border-indigo-200 text-indigo-700')
                  : (isDarkMode ? 'bg-[#2a1f16]/60 border-[#7a5830]/40 text-[#9a8065]' : 'bg-[#f1e8d9] border-[#d7c7b5] text-[#8a6b4e]')}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${localAiConfig.useVisionHelper ? 'bg-indigo-500' : (isDarkMode ? 'bg-[#8a6b4e]' : 'bg-[#b8a38c]')}`} />
                  <span className="ka-micro font-semibold">{localAiConfig.useVisionHelper ? (language === 'zh' ? '启用中' : 'ENABLED') : (language === 'zh' ? '未启用' : 'DISABLED')}</span>
                </span>
                <span className={`ka-section-desc ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{language === 'zh' ? '辅助解析图片' : 'Parses images for main model'}</span>
              </div>
            )}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} /> : <ChevronDown size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />}
      </button>

      <Collapse isOpen={isOpen} duration={180}>
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className={`ka-setting-item-title font-semibold ${isDarkMode ? 'text-[#e8d4ba]' : 'text-[#49301f]'}`}>
              {language === 'zh' ? '启用视觉辅助' : 'Enable Vision Helper'}
            </label>
            <div className="flex items-center gap-1.5 cursor-pointer" onClick={() => onUpdateAiConfig('useVisionHelper', !localAiConfig.useVisionHelper)}>
              <div className={`w-3.5 h-3.5 border rounded-sm flex items-center justify-center transition-colors ${localAiConfig.useVisionHelper ? 'bg-[#c59142] border-[#c59142]' : (isDarkMode ? 'border-[#8c6a3c]/70' : 'border-[#c5a98a]')}`}>
                {localAiConfig.useVisionHelper && <Check size={10} className={isDarkMode ? 'text-[#1b140d]' : 'text-white'} />}
              </div>
            </div>
          </div>

          {localAiConfig.useVisionHelper && (
            <div className={`space-y-3 pt-3 border-t ${isDarkMode ? 'border-[#8c6a3c]/30' : 'border-[#ebe1d3]'}`}>
              <p className={`ka-copy-sm mb-2 leading-relaxed ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>
                {language === 'zh' ? '当主模型无视觉能力时，用于解析图片并转述给主模型。' : 'Used to parse images and describe them to the main model if it lacks vision capabilities.'}
              </p>

              <div className="mb-4">
                <label className={labelClass}>{language === 'zh' ? 'API 提供商' : 'API Provider'}</label>
                <ThemedSelect
                  value={effectiveVisionProvider}
                  onChange={(val) => handleVisionProviderChange(val as AIProvider)}
                  options={providerOptions}
                  isDarkMode={isDarkMode}
                  className={inputClass}
                  ariaLabel={language === 'zh' ? 'API 提供商' : 'API Provider'}
                />
                <p className={`ka-micro mt-1 font-mono break-all ${isDarkMode ? 'text-[#b69f87]/70' : 'text-[#9e7c51]/70'}`}>
                  {effectiveVisionProvider !== 'gemini' && `Endpoint: ${getDefaultEndpoint(effectiveVisionProvider)}`}
                </p>
              </div>

              <div>
                <label className={labelClass}>{language === 'zh' ? '视觉 API KEY (可选，默认使用主配置)' : 'VISION API KEY (Optional, fallback to main)'}</label>
                <ComposableInput
                  type="password"
                  value={localAiConfig.visionApiKey || ''}
                  onChange={(e) => onUpdateAiConfig('visionApiKey', e.target.value)}
                  placeholder={t_local.keyPlaceHolder}
                  className={inputClass}
                />
              </div>

              <div className={`mt-4 pt-4 border-t ${isDarkMode ? 'border-[#8c6a3c]/30' : 'border-[#ebe1d3]'}`}>
                <div className="flex items-center justify-between mb-2">
                  <label className={`ka-label flex items-center gap-1.5 ${isDarkMode ? 'text-[#e8d4ba]' : 'text-[#49301f]'}`}>
                    <Globe size={12} /> API ENDPOINT
                  </label>
                  <div className="flex items-center gap-1.5 cursor-pointer" onClick={() => onUpdateAiConfig('useVisionCustomEndpoint', !(localAiConfig.useVisionCustomEndpoint ?? localAiConfig.useCustomEndpoint))}>
                    <div className={`w-3 h-3 border rounded-sm flex items-center justify-center transition-colors ${(localAiConfig.useVisionCustomEndpoint ?? localAiConfig.useCustomEndpoint) ? 'bg-[#c59142] border-[#c59142]' : (isDarkMode ? 'border-[#8c6a3c]/70' : 'border-[#c5a98a]')}`}>
                      {(localAiConfig.useVisionCustomEndpoint ?? localAiConfig.useCustomEndpoint) && <Check size={10} className={isDarkMode ? 'text-[#1b140d]' : 'text-white'} />}
                    </div>
                    <span className={`ka-micro font-mono ${isDarkMode ? 'text-[#d7c7b5]' : 'text-[#8a6b4e]'}`}>{t_local.useCustomEndpoint}</span>
                  </div>
                </div>

                {(localAiConfig.useVisionCustomEndpoint ?? localAiConfig.useCustomEndpoint) ? (
                  <div className="space-y-2 animate-in slide-in-from-top-1">
                    <ComposableInput
                      type="text"
                      value={localAiConfig.visionCustomEndpoint ?? localAiConfig.customEndpoint ?? ''}
                      onChange={(e) => onUpdateAiConfig('visionCustomEndpoint', e.target.value)}
                      placeholder={t_local.customEndpointPlaceholder}
                      className={inputClass}
                    />
                  </div>
                ) : (
                  <div className={`ka-micro font-mono italic p-2 rounded ${isDarkMode ? 'bg-[#211811]/60 text-[#b69f87]' : 'bg-[#f5ebd9] text-[#8f7458]'}`}>
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
