import React from 'react';
import { Check, Globe } from 'lucide-react';
import { AIConfig } from '../../types';

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
  return (
    <div className={innerCardClass}>
      <button onClick={onToggle} className="w-full flex items-center justify-between mb-2">
        <div className="text-left">
          <label className={`text-[10px] font-bold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>API KEYS</label>
          <div className={`text-[10px] font-mono opacity-50 ${localAiConfig.activeKey === 'primary' ? 'text-green-500' : 'text-blue-500'}`}>
            {`ACTIVE: ${localAiConfig.activeKey.toUpperCase()}`}
          </div>
        </div>
        <span className="text-[10px] opacity-50">{isOpen ? '▼' : '▲'}</span>
      </button>

      {isOpen && (
        <div className="animate-in slide-in-from-top-2">
          <div className="flex items-center justify-end mb-2">
            <div className="flex items-center gap-1.5 cursor-pointer" onClick={() => onUpdateAiConfig('useEnvKey', !localAiConfig.useEnvKey)}>
              <div className={`w-3 h-3 border rounded-sm flex items-center justify-center transition-colors ${localAiConfig.useEnvKey ? 'bg-teal-500 border-teal-500' : (isDarkMode ? 'border-gray-500' : 'border-gray-400')}`}>
                {localAiConfig.useEnvKey && <Check size={10} className="text-white" />}
              </div>
              <span className="text-[10px] font-mono">{t_local.useEnv}</span>
            </div>
          </div>

          {!localAiConfig.useEnvKey ? (
            <div className="space-y-3">
              <div>
                <label className={`block text-[10px] font-bold ${isDarkMode ? 'text-gray-400' : 'text-gray-700'}`}>{t_local.keyLabel}</label>
                <input type="password" value={localAiConfig.apiKey_primary || ''} onChange={(e) => onUpdateAiConfig('apiKey_primary', e.target.value)} placeholder={t_local.keyPlaceHolder} className={inputClass} />
              </div>
              <div>
                <label className={`block text-[10px] font-bold ${isDarkMode ? 'text-gray-400' : 'text-gray-700'}`}>{t_local.keyLabel_backup}</label>
                <input type="password" value={localAiConfig.apiKey_backup || ''} onChange={(e) => onUpdateAiConfig('apiKey_backup', e.target.value)} placeholder={t_local.keyPlaceHolder} className={inputClass} />
              </div>
            </div>
          ) : (
            <div className={`text-[10px] font-mono italic p-2 rounded ${isDarkMode ? 'bg-black/30 text-gray-400' : 'bg-gray-200 text-gray-600'}`}>{t_local.useEnvDesc}</div>
          )}

          <div className="mt-4 pt-4 border-t border-gray-500/10">
            <div className="flex items-center justify-between mb-2">
              <label className={`text-[10px] font-bold flex items-center gap-1 ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
                <Globe size={10} /> API ENDPOINT
              </label>
              <div className="flex items-center gap-1.5 cursor-pointer" onClick={() => onUpdateAiConfig('useCustomEndpoint', !localAiConfig.useCustomEndpoint)}>
                <div className={`w-3 h-3 border rounded-sm flex items-center justify-center transition-colors ${localAiConfig.useCustomEndpoint ? 'bg-teal-500 border-teal-500' : (isDarkMode ? 'border-gray-500' : 'border-gray-400')}`}>
                  {localAiConfig.useCustomEndpoint && <Check size={10} className="text-white" />}
                </div>
                <span className="text-[10px] font-mono">{t_local.useCustomEndpoint}</span>
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
              <div className={`text-[10px] font-mono italic p-2 rounded ${isDarkMode ? 'bg-black/30 text-gray-400' : 'bg-gray-200 text-gray-600'}`}>
                {t_local.useCustomEndpointDesc}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
