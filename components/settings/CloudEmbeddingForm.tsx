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
  testEmbeddingConfig,
} from '../../services/cloudEmbeddingService';
import { useAppStore } from '../../store';
import { ThemedSelect, type ThemedSelectItem } from '../common/ThemedSelect';
import { ComposableInput } from '../common/ComposableInput';

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

interface DimensionsFieldProps {
  inputClass: string;
  min: number;
  max: number;
  configDimensions?: number;
  fallbackDimensions: number;
  onCommit: (dims: number) => void;
}

// v2.14.12 dimensions-input subcomponent. See the inline comment at the call
// site for why we split it out (mainly: a `dimDraft` string state local to
// this component is the cleanest way to allow temporary empty-string display
// without persisting 0 to the upstream config).
const DimensionsField: React.FC<DimensionsFieldProps> = ({
  inputClass,
  min,
  max,
  configDimensions,
  fallbackDimensions,
  onCommit,
}) => {
  const [dimDraft, setDimDraft] = useState<string>(() =>
    configDimensions ? String(configDimensions) : '',
  );

  // External config.dimensions changes (handleProviderChange picks a new
  // preset, an event/sync from another tab, the user opens the form again
  // after switching providers in another instance, etc.) flow back into the
  // local draft. Skip when the values already agree to avoid clobbering an
  // in-progress edit on a re-render.
  useEffect(() => {
    const incoming = configDimensions ? String(configDimensions) : '';
    if (incoming !== dimDraft && (configDimensions ?? 0) !== parseInt(dimDraft, 10)) {
      setDimDraft(incoming);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-key on configDimensions only
  }, [configDimensions]);

  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      value={dimDraft}
      onChange={(e) => {
        // Strip any non-digit the IME might inject (e.g. composition residue).
        const raw = e.target.value.replace(/[^0-9]/g, '');
        setDimDraft(raw);
        const n = parseInt(raw, 10);
        if (!isNaN(n) && n >= min && n <= max) {
          onCommit(n);
        }
      }}
      onBlur={() => {
        const n = parseInt(dimDraft, 10);
        if (!dimDraft || isNaN(n) || n < min || n > max) {
          setDimDraft(String(fallbackDimensions));
          onCommit(fallbackDimensions);
        }
      }}
      className={`${inputClass} w-full mt-1`}
    />
  );
};

export const CloudEmbeddingForm: React.FC<CloudEmbeddingFormProps> = ({
  language,
  isDarkMode,
  inputClass,
  fieldLabelClass,
  helperClass,
}) => {
  // v2.14.12: subscribe directly to the Zustand-backed embeddingConfig.
  // Both this form (rendered inside AIConfigScreen + EmbeddingConfigSection)
  // and any other instance share the same reactive state — no more dual
  // useState mirrors, no more `kumiko:embedding-config-changed` event channel.
  const config = useAppStore((s) => s.embeddingConfig);
  const setEmbeddingConfig = useAppStore((s) => s.setEmbeddingConfig);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState<string>('');

  const modelOptions = useMemo(() => EMBEDDING_MODEL_CATALOG[config.provider] || [], [config.provider]);
  const activeModelPreset = useMemo(
    () => modelOptions.find((m) => m.id === config.model) || modelOptions[0],
    [modelOptions, config.model],
  );
  const modelSelectOptions = useMemo<ThemedSelectItem[]>(
    () => modelOptions.map((m) => ({ value: m.id, label: m.label })),
    [modelOptions],
  );

  const update = useCallback((patch: Partial<EmbeddingProviderConfig>) => {
    // v2.14.12: side-effect-free dispatch (slice setter writes Zustand + localStorage).
    // No more setState updater with side-effects; no more cross-form custom event.
    const prev = useAppStore.getState().embeddingConfig;
    setEmbeddingConfig({ ...prev, ...patch });
    setTestStatus('idle');
    setTestMessage('');
  }, [setEmbeddingConfig]);

  const handleProviderChange = useCallback((provider: EmbeddingProvider) => {
    const newPresets = EMBEDDING_MODEL_CATALOG[provider] || [];
    const firstModel = newPresets[0];
    // v2.14.19 issue 1 修复: provider==='custom' 时把 model 清空,
    // 让用户接下来自己填的模型 ID 不被任何下拉框默认值 (原本是 catalog
    // 第一项 'custom-model' 占位) 在切到 custom 那一刻就先覆盖一次。
    // 配合下面 model 字段的三元渲染 (custom 时只渲染 ComposableInput,
    // 其他 provider 只渲染 ThemedSelect),彻底消除字段冲突。
    update({
      provider,
      model: provider === 'custom'
        ? ''
        : (firstModel?.id || DEFAULT_EMBEDDING_CONFIG.model),
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

  // v2.14.6 G.2: convert the 5-button provider grid (which the user
  // flagged as visually inconsistent with VisionHelperSection's API
  // Provider control) into a ThemedSelect dropdown so Cloud Embedding
  // matches the Vision / Allocation / Diary form vocabulary. Single
  // ungrouped list — only 5 entries, grouping would be visual noise.
  const providerOptions = useMemo<ThemedSelectItem[]>(
    () =>
      (Object.keys(PROVIDER_LABELS) as EmbeddingProvider[]).map((p) => ({
        value: p,
        label: PROVIDER_LABELS[p][language],
      })),
    [language],
  );

  return (
    <div className="flex flex-col gap-3">

      <div>
        <label className={fieldLabelClass}>{language === 'zh' ? '提供商' : 'Provider'}</label>
        <div className="mt-1">
          <ThemedSelect
            value={config.provider}
            onChange={(val) => handleProviderChange(val as EmbeddingProvider)}
            options={providerOptions}
            isDarkMode={isDarkMode}
            className={`${inputClass} w-full`}
            ariaLabel={language === 'zh' ? '选择 Embedding 提供商' : 'Select embedding provider'}
          />
        </div>
      </div>

      <div>
        <label className={fieldLabelClass}>{language === 'zh' ? '模型' : 'Model'}</label>
        <div className="mt-1">
          {/*
            v2.14.19 issue 1 修复: provider==='custom' 时只渲染 ComposableInput
            文本框 (用户自填模型 ID), 其他 provider 只渲染 ThemedSelect 下拉框
            (从 catalog 选)。原本两个并存且都绑 config.model, 导致用户输入立刻
            被下拉框的默认 onChange 反向覆盖, 自定义模型 ID 永远存不住。
          */}
          {config.provider === 'custom' ? (
            <ComposableInput
              type="text"
              value={config.model}
              onChange={(e) => update({ model: e.target.value })}
              className={`${inputClass} w-full`}
              placeholder={language === 'zh' ? '自定义模型 ID,如 text-embedding-3-large' : 'Custom model ID, e.g. text-embedding-3-large'}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          ) : (
            <ThemedSelect
              value={config.model}
              onChange={handleModelChange}
              options={modelSelectOptions}
              isDarkMode={isDarkMode}
              className={`${inputClass} w-full`}
              ariaLabel={language === 'zh' ? '选择 Embedding 模型' : 'Select embedding model'}
            />
          )}
        </div>
      </div>

      <div>
        <label className={fieldLabelClass}>API Key</label>
        <ComposableInput
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
          <ComposableInput
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
        {/* v2.14.12 dimensions input UX:
            - type="text" + inputMode="numeric": pops the numeric keyboard on
              Android without inheriting <input type="number">'s spin buttons,
              forced-min-clamp, or scroll-to-change quirks.
            - dimDraft local string: the previous "value={config.dimensions || 0}"
              + "parseInt(...) || 0" combo turned an empty field into a sticky
              "0" the user had to delete before re-typing. The draft holds the
              raw string, only valid positive integers flow through to config,
              and onBlur restores the model preset default if the field is left
              empty/invalid (so we never persist 0 by accident).
            - external config.dimensions changes (e.g. handleProviderChange picks
              a new preset) sync back into the draft via the useEffect below. */}
        <DimensionsField
          inputClass={inputClass}
          min={activeModelPreset?.minDimensions || 1}
          max={activeModelPreset?.maxDimensions || 8192}
          configDimensions={config.dimensions}
          fallbackDimensions={activeModelPreset?.defaultDimensions || DEFAULT_EMBEDDING_CONFIG.dimensions || 768}
          onCommit={(dims) => update({ dimensions: dims })}
        />
        {/* v2.14.6 G.2: dimensions hint switched from helperClass (warm
            ka-brown body copy) to ka-micro + neutral gray to match the
            new "subdued helper" voice introduced in RagConfigSection
            (Task E). Avoids competing with the amber section accent. */}
        <p className={`ka-micro mt-1 ${isDarkMode ? 'text-gray-400/85' : 'text-gray-500/85'}`}>
          {language === 'zh'
            ? '改维度后建议在「数据管理」里重建向量库，避免与历史向量混合导致检索精度下降。'
            : 'Rebuild the vector store from "Data" after changing dimensions to avoid mixing with old vectors.'}
        </p>
      </div>

      {/* v2.14.6 G.2: Test connection button — drop the green-on-success /
          gold-on-idle saturated palette that clashed with the amber
          section header. Button stays in the cream + amber-border
          neutral state across idle / ok / error; only the inline icon
          (CheckCircle / AlertTriangle) and the ka-micro message to its
          right convey status. Disabled state keeps the warm ka muted
          brown so it still reads as "waiting on input". */}
      <div className="flex items-center gap-2 mt-1 flex-wrap">
        <button
          type="button"
          onClick={handleTest}
          disabled={testStatus === 'testing' || !config.apiKey}
          className={`px-3 py-2 rounded-lg ka-copy-sm font-semibold transition-colors flex items-center gap-1.5 ${
            testStatus === 'testing' || !config.apiKey
              ? (isDarkMode
                  ? 'bg-[#2c241a] text-[#7a6a52] cursor-not-allowed border border-[#3d3023]'
                  : 'bg-[#f3eada] text-[#a0896a] cursor-not-allowed border border-[#e0d4bd]')
              : (isDarkMode
                  ? 'bg-amber-900/20 hover:bg-amber-900/30 text-amber-300 border border-amber-500/30'
                  : 'bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200')
          }`}
        >
          {testStatus === 'testing' && <Loader2 size={14} className="animate-spin" />}
          {testStatus === 'ok' && <CheckCircle size={14} className={isDarkMode ? 'text-emerald-300' : 'text-emerald-600'} />}
          {testStatus === 'error' && <AlertTriangle size={14} className={isDarkMode ? 'text-red-300' : 'text-red-600'} />}
          {testStatus === 'testing'
            ? (language === 'zh' ? '测试中…' : 'Testing…')
            : (language === 'zh' ? '测试连接' : 'Test connection')}
        </button>
        {testMessage && (
          <span
            className={`ka-micro ${
              testStatus === 'error'
                ? (isDarkMode ? 'text-red-300' : 'text-red-600')
                : testStatus === 'ok'
                ? (isDarkMode ? 'text-emerald-300' : 'text-emerald-700')
                : (isDarkMode ? 'text-gray-400/85' : 'text-gray-500/85')
            }`}
          >
            {testMessage}
          </span>
        )}
      </div>

    </div>
  );
};

export default CloudEmbeddingForm;
