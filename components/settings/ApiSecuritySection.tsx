import React, { useMemo } from 'react';
import { Check, Globe, ChevronDown, ChevronUp, Key } from 'lucide-react';
import { AIConfig, AIProvider } from '../../types';
import { getDefaultEndpoint } from '../../services/appConfig';
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

  const providerOptions = useMemo<ThemedSelectItem[]>(
    () => [
      {
        label: t_local.providerGroup_intl || '── International ──',
        options: PROVIDER_OPTIONS.filter(p => p.group === 'intl').map(p => ({
          value: p.value,
          label: p.label,
        })),
      },
      {
        label: t_local.providerGroup_cn || '── 中国平台 ──',
        options: PROVIDER_OPTIONS.filter(p => p.group === 'cn').map(p => ({
          value: p.value,
          label: p.label,
        })),
      },
    ],
    [t_local.providerGroup_intl, t_local.providerGroup_cn],
  );

  return (
    <div className={innerCardClass}>
      <button onClick={onToggle} className="w-full flex items-center justify-between mb-2">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className={`flex h-9 w-9 items-center justify-center rounded-xl border shrink-0 ${isDarkMode ? 'border-amber-500/20 bg-amber-900/20 text-amber-300' : 'border-amber-200 bg-amber-50/90 text-amber-700'}`}>
            <Key size={16} />
          </div>
          <div className="flex-1 text-left min-w-0">
            <h4 className={`ka-label font-bold ${isDarkMode ? 'text-[#f5ebdc]' : 'text-[#49301f]'}`}>API KEYS</h4>
            {!isOpen && (
              <span className={`inline-flex items-center gap-1.5 mt-1 px-2 py-0.5 rounded-full border ${localAiConfig.activeKey === 'primary'
                ? (isDarkMode ? 'bg-emerald-900/25 border-emerald-500/25 text-emerald-300' : 'bg-emerald-50 border-emerald-200 text-emerald-700')
                : (isDarkMode ? 'bg-sky-900/25 border-sky-500/25 text-sky-300' : 'bg-sky-50 border-sky-200 text-sky-700')}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${localAiConfig.activeKey === 'primary' ? 'bg-emerald-500' : 'bg-sky-500'}`} />
                <span className="ka-micro font-semibold">ACTIVE: {localAiConfig.activeKey.toUpperCase()}</span>
              </span>
            )}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} /> : <ChevronDown size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />}
      </button>

      <Collapse isOpen={isOpen} duration={180}>
        <div>
          {/* Provider Selector */}
          <div className="mb-4">
            <label className={`block ka-label mb-1.5 ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>
              {t_local.providerLabel || 'AI PROVIDER'}
            </label>
            <ThemedSelect
              value={currentProvider}
              onChange={(val) => handleProviderChange(val as AIProvider)}
              options={providerOptions}
              isDarkMode={isDarkMode}
              className={`${inputClass} cursor-pointer`}
              ariaLabel={t_local.providerLabel || 'AI PROVIDER'}
            />
            {/* Phase 7 Part t13_settings_sections: long provider endpoints
                (https://generativelanguage.googleapis.com/v1beta/...) were
                overflowing on 360px phones. `break-all` allows the URL to
                wrap mid-path instead of pushing the layout wider. */}
            <p className={`ka-micro mt-1 font-mono break-all ${isDarkMode ? 'text-[#b69f87]/70' : 'text-[#9e7c51]/70'}`}>
              {currentProvider !== 'gemini' && `Endpoint: ${getDefaultEndpoint(currentProvider)}`}
            </p>
          </div>

          <div className="space-y-3">
            <div>
              <label className={`block ka-label ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{t_local.keyLabel}</label>
              <ComposableInput type="password" value={localAiConfig.apiKey_primary || ''} onChange={(e) => onUpdateAiConfig('apiKey_primary', e.target.value)} placeholder={t_local.keyPlaceHolder} className={inputClass} />
            </div>
            <div>
              <label className={`block ka-label ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{t_local.keyLabel_backup}</label>
              <ComposableInput type="password" value={localAiConfig.apiKey_backup || ''} onChange={(e) => onUpdateAiConfig('apiKey_backup', e.target.value)} placeholder={t_local.keyPlaceHolder} className={inputClass} />
            </div>
          </div>

          <div className={`mt-4 pt-4 border-t ${isDarkMode ? 'border-[#8c6a3c]/30' : 'border-[#ebe1d3]'}`}>
            <div className="flex items-center justify-between mb-2">
              <label className={`ka-label flex items-center gap-1.5 ${isDarkMode ? 'text-[#e8d4ba]' : 'text-[#49301f]'}`}>
                <Globe size={12} /> API ENDPOINT
              </label>
              <div className="flex items-center gap-1.5 cursor-pointer" onClick={() => onUpdateAiConfig('useCustomEndpoint', !localAiConfig.useCustomEndpoint)}>
                <div className={`w-3 h-3 border rounded-sm flex items-center justify-center transition-colors ${localAiConfig.useCustomEndpoint ? 'bg-[#c59142] border-[#c59142]' : (isDarkMode ? 'border-[#8c6a3c]/70' : 'border-[#c5a98a]')}`}>
                  {localAiConfig.useCustomEndpoint && <Check size={10} className={isDarkMode ? 'text-[#1b140d]' : 'text-white'} />}
                </div>
                <span className={`ka-micro font-mono ${isDarkMode ? 'text-[#d7c7b5]' : 'text-[#8a6b4e]'}`}>{t_local.useCustomEndpoint}</span>
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
              <div className={`ka-micro font-mono italic p-2 rounded break-words ${isDarkMode ? 'bg-[#211811]/60 text-[#b69f87]' : 'bg-[#f5ebd9] text-[#8f7458]'}`}>
                {t_local.useCustomEndpointDesc}
              </div>
            )}
          </div>
        </div>
      </Collapse>
    </div>
  );
};
