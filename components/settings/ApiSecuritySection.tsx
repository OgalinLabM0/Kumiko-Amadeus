import React from 'react';
import { Check, Globe, ChevronDown, ChevronUp } from 'lucide-react';
import { AIConfig, AIProvider } from '../../types';
import { getDefaultEndpoint } from '../../services/appConfig';
import { Collapse } from '../Collapse';

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

interface ApiSecuritySectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  localAiConfig: AIConfig;
  t_local: any;
  inputClass: string;
  onUpdateAiConfig: (key: keyof AIConfig, value: any) => void;
  innerCardClass: string;
}

export const ApiSecuritySection: React.FC<ApiSecuritySectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  localAiConfig,
  t_local,
  inputClass,
  onUpdateAiConfig,
  innerCardClass
}) => {
  const handleProviderChange = (newProvider: AIProvider) => {
    onUpdateAiConfig('provider', newProvider);
    if (newProvider === 'gemini') {
      onUpdateAiConfig('useCustomEndpoint', false);
      onUpdateAiConfig('customEndpoint', '');
    } else {
      const endpoint = getDefaultEndpoint(newProvider);
      onUpdateAiConfig('useCustomEndpoint', true);
      onUpdateAiConfig('customEndpoint', endpoint);
    }
  };

  const currentProvider = localAiConfig.provider || 'gemini';
  const currentLabel = PROVIDER_OPTIONS.find(p => p.value === currentProvider)?.label || currentProvider;

  return (
    <div className={innerCardClass}>
      <button onClick={onToggle} className="w-full flex items-center justify-between mb-2">
        <div className="text-left">
          <label className={`ka-label font-bold ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>API KEYS</label>
          <div className={`ka-micro font-mono font-semibold ${localAiConfig.activeKey === 'primary' ? 'text-green-500' : 'text-blue-500'}`}>
            {`ACTIVE: ${localAiConfig.activeKey.toUpperCase()}`}
          </div>
        </div>
        {isOpen ? <ChevronUp size={14} className={isDarkMode ? 'text-gray-500' : 'text-gray-400'} /> : <ChevronDown size={14} className={isDarkMode ? 'text-gray-500' : 'text-gray-400'} />}
      </button>

      <Collapse isOpen={isOpen} duration={180}>
        <div>
          {/* Provider Selector */}
          <div className="mb-4">
            <label className={`block ka-label mb-1.5 ${isDarkMode ? 'text-gray-400' : 'text-gray-700'}`}>
              {t_local.providerLabel || 'AI PROVIDER'}
            </label>
            <div className="relative">
              <select
                value={currentProvider}
                onChange={(e) => handleProviderChange(e.target.value as AIProvider)}
                className={`${inputClass} appearance-none pr-8 cursor-pointer`}
              >
                <optgroup label={t_local.providerGroup_intl || '── International ──'}>
                  {PROVIDER_OPTIONS.filter(p => p.group === 'intl').map(p => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </optgroup>
                <optgroup label={t_local.providerGroup_cn || '── 中国平台 ──'}>
                  {PROVIDER_OPTIONS.filter(p => p.group === 'cn').map(p => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </optgroup>
              </select>
              <ChevronDown size={14} className={`absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`} />
            </div>
            <p className={`ka-micro mt-1 font-mono ${isDarkMode ? 'text-teal-400/60' : 'text-teal-600/60'}`}>
              {currentProvider !== 'gemini' && `Endpoint: ${getDefaultEndpoint(currentProvider)}`}
            </p>
          </div>

          <div className="space-y-3">
            <div>
              <label className={`block ka-label ${isDarkMode ? 'text-gray-400' : 'text-gray-700'}`}>{t_local.keyLabel}</label>
              <input type="password" value={localAiConfig.apiKey_primary || ''} onChange={(e) => onUpdateAiConfig('apiKey_primary', e.target.value)} placeholder={t_local.keyPlaceHolder} className={inputClass} />
            </div>
            <div>
              <label className={`block ka-label ${isDarkMode ? 'text-gray-400' : 'text-gray-700'}`}>{t_local.keyLabel_backup}</label>
              <input type="password" value={localAiConfig.apiKey_backup || ''} onChange={(e) => onUpdateAiConfig('apiKey_backup', e.target.value)} placeholder={t_local.keyPlaceHolder} className={inputClass} />
            </div>
          </div>

          <div className="mt-4 pt-4 border-t border-gray-500/10">
            <div className="flex items-center justify-between mb-2">
              <label className={`ka-label flex items-center gap-1 ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
                <Globe size={10} /> API ENDPOINT
              </label>
              <div className="flex items-center gap-1.5 cursor-pointer" onClick={() => onUpdateAiConfig('useCustomEndpoint', !localAiConfig.useCustomEndpoint)}>
                <div className={`w-3 h-3 border rounded-sm flex items-center justify-center transition-colors ${localAiConfig.useCustomEndpoint ? 'bg-teal-500 border-teal-500' : (isDarkMode ? 'border-gray-500' : 'border-gray-400')}`}>
                  {localAiConfig.useCustomEndpoint && <Check size={10} className="text-white" />}
                </div>
                <span className="ka-micro font-mono">{t_local.useCustomEndpoint}</span>
              </div>
            </div>

            {localAiConfig.useCustomEndpoint ? (
              <div className="space-y-2 animate-in slide-in-from-top-1">
                <input
                  type="text"
                  value={localAiConfig.customEndpoint || ''}
                  onChange={(e) => onUpdateAiConfig('customEndpoint', e.target.value)}
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
        </div>
      </Collapse>
    </div>
  );
};
