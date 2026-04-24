// components/settings/CloudEmbeddingForm.tsx
//
// F2A.3b: shared form body for the Cloud Embedding configuration.
// Originally lived inside EmbeddingConfigSection.tsx (a Collapse-based
// settings card). Hoisted out so the same form fields can be reused by
// AIConfigScreen.tsx (the first-launch wizard) without duplicating the
// 5-provider grid + model select + key + dimensions + test button.
//
// Visibility: this component itself does NOT gate on isCapacitorNative()
// — it is the bare form. Callers are expected to wrap it in their own
// platform guard (Settings card returns null on non-Capacitor; AIConfig
// screen renders the section only when isCapacitorNative()).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, CheckCircle, AlertTriangle } from 'lucide-react';
import {
  DEFAULT_EMBEDDING_CONFIG,
  EMBEDDING_MODEL_CATALOG,
  type EmbeddingProvider,
  type EmbeddingProviderConfig,
  getEmbeddingConfig,
  setEmbeddingConfig,
  testEmbeddingConfig,
} from '../../services/cloudEmbeddingService';

const PROVIDER_LABELS: Record<EmbeddingProvider, { zh: string; en: string }> = {
  openai: { zh: 'OpenAI', en: 'OpenAI' },
  gemini: { zh: 'Google Gemini', en: 'Google Gemini' },
  zhipu: { zh: '智谱 BigModel', en: 'Zhipu BigModel' },
  tongyi: { zh: '通义千问 / DashScope', en: 'Tongyi Qianwen / DashScope' },
  custom: { zh: '自定义 (OpenAI 兼容)', en: 'Custom (OpenAI-compatible)' },
};

export interface CloudEmbeddingFormProps {
  language: 'zh' | 'en';
  isDarkMode: boolean;
  inputClass: string;
  fieldLabelClass: string;
  helperClass: string;
}

export const CloudEmbeddingForm: React.FC<CloudEmbeddingFormProps> = ({
  language,
  isDarkMode,
  inputClass,
  fieldLabelClass,
  helperClass,
}) => {
  const [config, setConfig] = useState<EmbeddingProviderConfig>(() => getEmbeddingConfig());
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState<string>('');

  useEffect(() => {
    const handler = () => setConfig(getEmbeddingConfig());
    window.addEventListener('kumiko:embedding-config-changed', handler);
    return () => window.removeEventListener('kumiko:embedding-config-changed', handler);
  }, []);

  const modelOptions = useMemo(() => EMBEDDING_MODEL_CATALOG[config.provider] || [], [config.provider]);
  const activeModelPreset = useMemo(
    () => modelOptions.find((m) => m.id === config.model) || modelOptions[0],
    [modelOptions, config.model],
  );

  const update = useCallback((patch: Partial<EmbeddingProviderConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      setEmbeddingConfig(next);
      return next;
    });
    setTestStatus('idle');
    setTestMessage('');
  }, []);

  const handleProviderChange = useCallback((provider: EmbeddingProvider) => {
    const newPresets = EMBEDDING_MODEL_CATALOG[provider] || [];
    const firstModel = newPresets[0];
    update({
      provider,
      model: firstModel?.id || DEFAULT_EMBEDDING_CONFIG.model,
      dimensions: firstModel?.defaultDimensions || DEFAULT_EMBEDDING_CONFIG.dimensions,
    });
  }, [update]);

  const handleModelChange = useCallback((modelId: string) => {
    const preset = modelOptions.find((m) => m.id === modelId);
    update({
      model: modelId,
      dimensions: preset?.defaultDimensions || config.dimensions,
    });
  }, [modelOptions, config.dimensions, update]);

  const handleTest = useCallback(async () => {
    setTestStatus('testing');
    setTestMessage('');
    const result = await testEmbeddingConfig(config);
    if (result.ok) {
      setTestStatus('ok');
      const dimMatch = result.actualDimensions === config.dimensions;
      const note = language === 'zh'
        ? `连接成功！返回维度 ${result.actualDimensions}。${dimMatch ? '' : `（与本地配置 ${config.dimensions} 不一致，建议重建向量库）`}`
        : `Connected. Returned ${result.actualDimensions}d.${dimMatch ? '' : ` (Doesn't match local ${config.dimensions}d — rebuild recommended.)`}`;
      setTestMessage(note);
    } else {
      setTestStatus('error');
      setTestMessage(result.error || (language === 'zh' ? '连接失败' : 'Connection failed'));
    }
  }, [config, language]);

  return (
    <div className="flex flex-col gap-3">

      <div>
        <label className={fieldLabelClass}>{language === 'zh' ? '提供商' : 'Provider'}</label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
          {(Object.keys(PROVIDER_LABELS) as EmbeddingProvider[]).map((p) => (
            <button
              type="button"
              key={p}
              onClick={() => handleProviderChange(p)}
              className={`flex items-center gap-2 px-3 py-2.5 rounded-xl ka-copy-sm font-semibold transition-colors text-left ${
                config.provider === p
                  ? (isDarkMode ? 'bg-[#d4a852] text-[#21150a]' : 'bg-[#fff5e3] text-[#8a6122] border border-[#e0c58f]')
                  : (isDarkMode ? 'bg-[#3e3429] text-[#d8c9b1] hover:bg-[#4a3f31]' : 'bg-white/60 text-[#5b4732] hover:bg-white/80 border border-transparent')
              }`}
            >
              {PROVIDER_LABELS[p][language]}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className={fieldLabelClass}>{language === 'zh' ? '模型' : 'Model'}</label>
        <select
          value={config.model}
          onChange={(e) => handleModelChange(e.target.value)}
          className={`${inputClass} w-full mt-1`}
        >
          {modelOptions.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        {config.provider === 'custom' && (
          <input
            type="text"
            value={config.model}
            onChange={(e) => update({ model: e.target.value })}
            className={`${inputClass} w-full mt-2`}
            placeholder={language === 'zh' ? '自定义模型 ID' : 'Custom model ID'}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        )}
      </div>

      <div>
        <label className={fieldLabelClass}>API Key</label>
        <input
          type="password"
          value={config.apiKey}
          onChange={(e) => update({ apiKey: e.target.value })}
          className={`${inputClass} w-full mt-1`}
          placeholder={config.provider === 'openai' ? 'sk-...' : (config.provider === 'gemini' ? 'AIza...' : '...')}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      </div>

      {config.provider === 'custom' && (
        <div>
          <label className={fieldLabelClass}>{language === 'zh' ? '自定义 endpoint (无 /embeddings 后缀)' : 'Custom endpoint (no /embeddings suffix)'}</label>
          <input
            type="url"
            inputMode="url"
            value={config.customEndpoint || ''}
            onChange={(e) => update({ customEndpoint: e.target.value })}
            className={`${inputClass} w-full mt-1`}
            placeholder="https://example.com/v1"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
      )}

      <div>
        <label className={fieldLabelClass}>
          {language === 'zh' ? '维度 (dimensions)' : 'Dimensions'}
          {activeModelPreset?.supportsDimensionReduction && (
            <span className={`ml-1 ${helperClass}`}>
              {language === 'zh' ? '· 此模型支持服务端降维' : '· This model supports server-side reduction'}
            </span>
          )}
        </label>
        <input
          type="number"
          min={activeModelPreset?.minDimensions || 1}
          max={activeModelPreset?.maxDimensions || 8192}
          value={config.dimensions || 0}
          onChange={(e) => update({ dimensions: parseInt(e.target.value, 10) || 0 })}
          className={`${inputClass} w-full mt-1`}
        />
        <p className={`${helperClass} mt-1`}>
          {language === 'zh'
            ? '改维度后建议在「数据管理」里重建向量库，避免与历史向量混合导致检索精度下降。'
            : 'Rebuild the vector store from "Data" after changing dimensions to avoid mixing with old vectors.'}
        </p>
      </div>

      <div className="flex items-center gap-2 mt-1">
        <button
          type="button"
          onClick={handleTest}
          disabled={testStatus === 'testing' || !config.apiKey}
          className={`px-3 py-2 rounded-lg ka-copy-sm font-semibold transition-colors flex items-center gap-1.5 ${
            testStatus === 'testing' || !config.apiKey
              ? (isDarkMode ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-gray-200 text-gray-400 cursor-not-allowed')
              : (isDarkMode ? 'bg-[#2a3a2b] hover:bg-[#344a35] text-[#c7e6c9] border border-[#4c6a4e]' : 'bg-[#eaf5eb] hover:bg-[#d9ecda] text-[#3e6a42] border border-[#b8d4bb]')
          }`}
        >
          {testStatus === 'testing' && <Loader2 size={14} className="animate-spin" />}
          {testStatus === 'ok' && <CheckCircle size={14} />}
          {testStatus === 'error' && <AlertTriangle size={14} />}
          {testStatus === 'idle'
            ? (language === 'zh' ? '测试连接' : 'Test connection')
            : testStatus === 'testing'
            ? (language === 'zh' ? '测试中…' : 'Testing…')
            : testStatus === 'ok'
            ? (language === 'zh' ? '连接成功' : 'Connected')
            : (language === 'zh' ? '连接失败' : 'Failed')}
        </button>
        {testMessage && (
          <span className={`ka-micro ${testStatus === 'error' ? 'text-red-500' : 'opacity-70'}`}>
            {testMessage}
          </span>
        )}
      </div>

    </div>
  );
};

export default CloudEmbeddingForm;
