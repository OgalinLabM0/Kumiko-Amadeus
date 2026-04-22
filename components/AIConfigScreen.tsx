
import React, { useState, useEffect, useMemo } from 'react';
import { Settings, Key, Zap, Brain, CheckCircle, RefreshCw, AlertTriangle, Check, ShieldCheck, Activity, Power, Globe, Save, Languages, Eye } from 'lucide-react';
import { AIConfig, AIProvider, Language } from '../types';
import { Collapse } from './Collapse';
import { ThemedSelect, type ThemedSelectItem } from './common/ThemedSelect';
import { getCurrentAIConfig, validateAIConnection, validateModels, validateSearchCapability } from '../services/geminiService';
import { getDefaultMainModel, getDefaultSummaryModel, getDefaultVisionModel, getDefaultEndpoint } from '../services/appConfig';
import { setAIConfig } from '../services/llmCore';
import { isMobilePwa } from '../services/environment';
import { httpInvoke } from '../services/httpApi';

// Phase 6 Part B: mobile PWAs never talk to the LLM provider directly.
// Every validate* call proxies through the PC so API keys + provider
// choices stay on the desktop, and the save/launch path routes through
// `ai-config:update-from-mobile` so the PC's localStorage remains the
// single source of truth. Failures fall back to showing an error status
// in the existing status line; we never silently persist mobile-only
// drift — the phone always gets whatever the PC currently thinks is
// the config on the next `ai-config:changed` broadcast.
async function validateConnectionUnified(cfg: AIConfig): Promise<boolean> {
    if (!isMobilePwa()) return validateAIConnection(cfg);
    try {
        return await httpInvoke<boolean>('ai-config:validate-from-mobile', cfg);
    } catch (e) {
        console.warn('[AIConfig] mobile validate-connection failed:', e);
        return false;
    }
}

async function validateModelsUnified(cfg: AIConfig): Promise<{ main: boolean; summary: boolean; vision: boolean }> {
    if (!isMobilePwa()) return validateModels(cfg);
    try {
        return await httpInvoke<{ main: boolean; summary: boolean; vision: boolean }>(
            'ai-config:validate-models-from-mobile', cfg,
        );
    } catch (e) {
        console.warn('[AIConfig] mobile validate-models failed:', e);
        return { main: false, summary: false, vision: false };
    }
}

async function validateSearchUnified(cfg: AIConfig): Promise<{ success: boolean; message?: string }> {
    if (!isMobilePwa()) return validateSearchCapability(cfg);
    try {
        return await httpInvoke<{ success: boolean; message?: string }>(
            'ai-config:validate-search-from-mobile', cfg,
        );
    } catch (e) {
        return { success: false, message: (e as Error).message };
    }
}

async function persistAIConfig(cfg: AIConfig): Promise<{ ok: boolean; error?: string }> {
    return setAIConfig(cfg);
}

interface AIConfigScreenProps {
  onComplete: () => void;
  language: Language;
  isDarkMode?: boolean;
}

const CONFIG_TRANSLATIONS = {
    zh: {
        title: "神经网路配置",
        subtitle: "AMADEUS 系统 // 核心设定",
        security: "安全凭证",
        provider: "API 供应商",
        providerGroup_intl: "── 国际平台 ──",
        providerGroup_cn: "── 中国平台 ──",
        keyLabel: "主 API KEY (PRIMARY)",
        keyLabel_backup: "备用 API KEY (BACKUP)",
        useCustomEndpoint: "使用自定义接口",
        useCustomEndpointDesc: "覆盖默认的 API 地址 (如使用代理)。",
        customEndpointPlaceholder: "https://generativelanguage.googleapis.com",
        keyPlaceHolder: "请输入您的 API Key...",
        keyLocalDesc: "Key 仅保存在本机本地配置中，不会上传到服务器。",
        allocation: "皮层分配",
        slotA: "SLOT A: 主核心 (MAIN CORE)",
        slotA_desc: "负责主要对话逻辑与人格引擎。",
        slotB: "SLOT B: 记忆核心 (MEMORY CORE)",
        slotB_desc: "后台负责记忆摘要与日记生成。",
        slotC: "SLOT C: TTS翻译",
        slotC_desc: "语音翻译模型（可选）：将中文翻译为久美子风格的日文。留空则使用主模型。",
        reset: "重置",
        testConnection: "测试连接 (并保存)",
        validateSearch: "验证搜索 (Grounding)",
        saveConfig: "仅保存配置",
        launchSystem: "启动系统",
        validating: "正在测试连接...",
        validatingSearch: "正在验证搜索权限...",
        success: "连接测试通过。",
        searchSuccess: "搜索权限已确认。",
        searchFail: "搜索权限未启用或被拒绝。",
        error_missing: "错误：请提供 API Key。",
        error_invalid: "连接测试失败：Key无效、模型名称错误或无法连接服务器。",
        saveSuccess: "配置已保存。",
        validateModels: "验证模型可用性",
        validatingModels: "正在验证模型...",
        modelValidationWarning: "一个或多个模型当前可能不可用，建议更换。",
        modelAvailable: "模型可用",
        modelUnavailable: "模型不可用或资源耗尽",
        visionHelper: "视觉辅助模型 (VISION HELPER)",
        visionHelperDesc: "当主模型无视觉能力时，用于解析图片并转述给主模型。",
        useVisionHelper: "启用视觉辅助",
        visionModelLabel: "视觉模型名称",
        visionApiKeyLabel: "视觉 API KEY (可选，默认使用主配置)",
    },
    en: {
        title: "NEURAL CONFIGURATION",
        subtitle: "AMADEUS SYSTEM // CORE SETUP",
        security: "SECURITY CREDENTIALS",
        provider: "API Provider",
        providerGroup_intl: "── International ──",
        providerGroup_cn: "── China Platforms ──",
        keyLabel: "PRIMARY API KEY",
        keyLabel_backup: "BACKUP API KEY",
        useCustomEndpoint: "Use Custom Endpoint",
        useCustomEndpointDesc: "Override default API URL (e.g., for proxy).",
        customEndpointPlaceholder: "https://generativelanguage.googleapis.com",
        keyPlaceHolder: "Enter your API Key...",
        keyLocalDesc: "Key is stored locally on this device. Nothing is uploaded.",
        allocation: "CORTEX ALLOCATION",
        slotA: "SLOT A: MAIN CORE",
        slotA_desc: "Primary conversation & personality engine.",
        slotB: "SLOT B: MEMORY CORE",
        slotB_desc: "Background summarization & diary generation.",
        slotC: "SLOT C: TTS TRANSLATION",
        slotC_desc: "Voice translation model (optional): translates Chinese to Kumiko-style Japanese. Falls back to main model if empty.",
        reset: "RESET",
        testConnection: "TEST & SAVE",
        validateSearch: "Verify Grounding (Search)",
        saveConfig: "SAVE CONFIG ONLY",
        launchSystem: "LAUNCH SYSTEM",
        validating: "Testing Connection...",
        validatingSearch: "Verifying Search...",
        success: "Connection Verified.",
        searchSuccess: "Search Capability Verified.",
        searchFail: "Search Permission Denied.",
        error_missing: "Error: Please provide an API Key.",
        error_invalid: "Connection Failed: Invalid Key, Model Name, or Network Error.",
        saveSuccess: "Config Saved.",
        validateModels: "Verify Model Availability",
        validatingModels: "Verifying models...",
        modelValidationWarning: "One or more models may be unavailable. Consider switching.",
        modelAvailable: "Model is available",
        modelUnavailable: "Model is unavailable or exhausted",
        visionHelper: "VISION HELPER",
        visionHelperDesc: "Used to parse images and describe them to the main model if it lacks vision capabilities.",
        useVisionHelper: "Enable Vision Helper",
        visionModelLabel: "Vision Model Name",
        visionApiKeyLabel: "VISION API KEY (Optional, fallback to main)",
    }
};

const SLOT_ACCENTS: Record<string, string> = {
    main: '#785A42',
    summary: '#b8860b',
    translator: '#9e2a2b',
    vision: '#4a7c7c',
};

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

interface ModelCardProps {
    title: string;
    slotKey: keyof AIConfig;
    icon: any;
    desc: string;
    defaultModel: string;
    validationResult: boolean | null;
    value: string;
    onChange: (val: string) => void;
    onReset: () => void;
    t: any;
    language: string;
    accentColor?: string;
    isDarkMode?: boolean;
}

const ModelCard: React.FC<ModelCardProps> = ({ title, icon: Icon, desc, defaultModel, validationResult, value, onChange, onReset, t, language, accentColor = '#785A42', isDarkMode = false }) => {
    const descClass = isDarkMode ? 'ka-copy-sm text-[#b69f87] truncate' : 'ka-copy-sm text-[#785A42]/60 truncate';
    const inputClass = isDarkMode
        ? "w-full bg-[#211811] border border-[#8c6a3c] rounded-lg cfg-input-text ka-input-copy text-[#f2e5cf] placeholder-[#8e7659] focus:outline-none focus:border-yellow-500/80 focus:shadow-[0_0_0_3px_rgba(234,179,8,0.08)] transition-all px-[clamp(8px,1.2vw,14px)] py-[clamp(6px,1vw,10px)]"
        : "w-full bg-white/70 border border-[#785A42]/15 rounded-lg cfg-input-text ka-input-copy text-[#785A42] placeholder-[#785A42]/30 focus:outline-none focus:border-[#785A42]/35 focus:shadow-[0_0_0_3px_rgba(120,90,66,0.06)] transition-all px-[clamp(8px,1.2vw,14px)] py-[clamp(6px,1vw,10px)]";
    const resetBtnClass = isDarkMode
        ? 'absolute right-1 top-1/2 -translate-y-1/2 ka-micro text-[#b69f87] hover:text-[#f2e5cf] px-1.5 transition-colors'
        : 'absolute right-1 top-1/2 -translate-y-1/2 ka-micro text-[#785A42]/50 hover:text-[#785A42] px-1.5 transition-colors';
    return (
        <div className="cfg-glass rounded-xl p-[clamp(12px,1.8vw,18px)] flex flex-col gap-[clamp(6px,0.8vw,10px)] transition-all duration-200 hover:shadow-md" style={{ borderLeft: `3px solid ${accentColor}` }}>
            <div className="flex items-center gap-[clamp(6px,1vw,10px)]">
                <div className="p-[clamp(4px,0.6vw,8px)] rounded-lg" style={{ background: `${accentColor}${isDarkMode ? '22' : '12'}` }}>
                    <Icon size={16} style={{ color: accentColor }} />
                </div>
                <div className="flex-1 min-w-0">
                    <h4 className="ka-section-title font-semibold tracking-[0.02em]" style={{ color: accentColor }}>{title}</h4>
                    {desc && <p className={descClass}>{desc}</p>}
                </div>
            </div>
            <div className="relative">
                <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={defaultModel}
                    className={inputClass} />
                {validationResult === true && <span className="absolute right-[clamp(28px,3.5vw,36px)] top-1/2 -translate-y-1/2" title={t.modelAvailable}><CheckCircle size={15} className="text-green-600" /></span>}
                {validationResult === false && <span className="absolute right-[clamp(28px,3.5vw,36px)] top-1/2 -translate-y-1/2" title={t.modelUnavailable}><AlertTriangle size={15} className="text-red-600" /></span>}
                <button onClick={onReset} className={resetBtnClass} title={language === 'zh' ? '重置为推荐值' : 'Reset to Recommended'}>{t.reset}</button>
            </div>
        </div>
    );
};

export const AIConfigScreen: React.FC<AIConfigScreenProps> = ({ onComplete, language = 'zh', isDarkMode = false }) => {
  const t = CONFIG_TRANSLATIONS[language];
  const [config, setConfig] = useState<AIConfig>(getCurrentAIConfig());
  const [isValidating, setIsValidating] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [statusType, setStatusType] = useState<'neutral' | 'success' | 'error'>('neutral');
  const [isSearchValidating, setIsSearchValidating] = useState(false);
  const [searchStatus, setSearchStatus] = useState<string>('');
  const [searchStatusType, setSearchStatusType] = useState<'neutral' | 'success' | 'error'>('neutral');
  const [isModelValidating, setIsModelValidating] = useState(false);
  const [modelValidationResult, setModelValidationResult] = useState<{ main: boolean | null, summary: boolean | null, vision: boolean | null }>({ main: null, summary: null, vision: null });
  const [isSecurityOpen, setIsSecurityOpen] = useState(true);
  const [isAllocationOpen, setIsAllocationOpen] = useState(false);
  const [isVisionOpen, setIsVisionOpen] = useState(false);

  const providerSelectOptions = useMemo<ThemedSelectItem[]>(
    () => [
      {
        label: t.providerGroup_intl,
        options: PROVIDER_OPTIONS.filter(p => p.group === 'intl').map(p => ({
          value: p.value,
          label: p.label,
        })),
      },
      {
        label: t.providerGroup_cn,
        options: PROVIDER_OPTIONS.filter(p => p.group === 'cn').map(p => ({
          value: p.value,
          label: p.label,
        })),
      },
    ],
    [t.providerGroup_intl, t.providerGroup_cn],
  );

  const styles = `
    .font-elegant { font-family: var(--font-elegant); }
    .font-mincho { font-family: var(--font-display); }

    .config-bg {
      background-color: #f9f7f2;
      background-image: 
        linear-gradient(rgba(120,90,66,0.035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(120,90,66,0.035) 1px, transparent 1px);
      background-size: clamp(28px, 4vw, 48px) clamp(28px, 4vw, 48px);
    }

    .cfg-glass {
      background: rgba(255,255,255,0.5);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      border: 1px solid rgba(120,90,66,0.12);
    }

    /* === RESPONSIVE TEXT SCALE === */
    .cfg-title { font-size: clamp(24px, 3.3vw, 38px); }
    .cfg-subtitle { font-size: clamp(12px, 1.2vw, 14px); }
    .cfg-section-title { font-size: clamp(15px, 1.6vw, 18px); }
    .cfg-label-md { font-size: clamp(12px, 1.3vw, 15px); }
    .cfg-label-sm { font-size: clamp(11px, 1.05vw, 13px); }
    .cfg-input-text { font-size: clamp(15px, 1.4vw, 18px); }
    .cfg-btn-text { font-size: clamp(13px, 1.05vw, 15px); }
    .cfg-hint-text { font-size: clamp(11px, 1.05vw, 13px); }

    .cfg-section-btn {
      background: rgba(255,255,255,0.35);
      border: 1px solid rgba(120,90,66,0.1);
      border-radius: clamp(8px, 1vw, 12px);
      padding: clamp(10px, 1.4vw, 16px) clamp(12px, 1.6vw, 20px);
      transition: all 0.2s ease;
    }
    .cfg-section-btn:hover {
      background: rgba(255,255,255,0.55);
      border-color: rgba(120,90,66,0.18);
    }

    @keyframes gear-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .gear-icon { animation: gear-spin 12s linear infinite; }
    .gear-icon-responsive { width: clamp(20px, 2.5vw, 28px); height: clamp(20px, 2.5vw, 28px); }

    .status-dot {
      width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0;
    }
    .status-dot-ok { background: #16a34a; box-shadow: 0 0 8px rgba(22,163,74,0.4); }
    .status-dot-err { background: #dc2626; box-shadow: 0 0 8px rgba(220,38,38,0.4); }

    .btn-launch {
      position: relative; overflow: hidden; transition: all 0.3s ease;
    }
    .btn-launch::before {
      content: ''; position: absolute; top: 0; left: -100%; width: 100%; height: 100%;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent);
      transition: left 0.6s ease;
    }
    .btn-launch:hover::before { left: 100%; }
    .btn-launch:hover { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(120,90,66,0.25); }
    .btn-launch:active { transform: translateY(0); }

    /* Decorative accent line under title */
    .title-accent {
      position: relative; display: inline-block;
    }
    .title-accent::after {
      content: ''; position: absolute; bottom: -6px; left: 15%; width: 70%; height: 2px;
      background: linear-gradient(90deg, transparent, #c5a059, transparent);
      border-radius: 1px;
    }

    /* === DARK MODE (html.ka-dark) === */
    html.ka-dark .config-bg {
      background-color: #1b140d;
      background-image:
        linear-gradient(rgba(242,217,156,0.04) 1px, transparent 1px),
        linear-gradient(90deg, rgba(242,217,156,0.04) 1px, transparent 1px);
    }
    html.ka-dark .cfg-glass {
      background: rgba(36,26,17,0.72);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      border: 1px solid rgba(168,130,71,0.35);
    }
    html.ka-dark .cfg-section-btn {
      background: rgba(36,26,17,0.55);
      border: 1px solid rgba(168,130,71,0.28);
    }
    html.ka-dark .cfg-section-btn:hover {
      background: rgba(46,34,22,0.7);
      border-color: rgba(201,165,90,0.45);
    }
    html.ka-dark .title-accent::after {
      background: linear-gradient(90deg, transparent, #d4a852, transparent);
    }
    html.ka-dark .btn-launch:hover {
      box-shadow: 0 8px 24px rgba(212,168,82,0.25);
    }
  `;

  useEffect(() => { setConfig(getCurrentAIConfig()); }, []);

  const handleValidateAll = async () => {
      const save = await persistAIConfig(config);
      if (!save.ok) {
          setStatus((language === 'zh' ? '保存到 PC 失败：' : 'Save to PC failed: ') + (save.error || ''));
          setStatusType('error');
          return;
      }
      setIsValidating(true);
      setStatus(language === 'zh' ? "正在进行全面验证..." : "Running full validation...");
      setStatusType('neutral');
      setModelValidationResult({ main: null, summary: null, vision: null }); 
      setSearchStatus('');
      if (!config.apiKey_primary) {
          setStatus(t.error_missing); setStatusType('error'); setIsValidating(false); return;
      }
      const isValid = await validateConnectionUnified(config);
      if (!isValid) {
          setStatus(t.error_invalid);
          setStatusType('error'); setIsValidating(false); return;
      }
      setIsModelValidating(true);
      const modelResult = await validateModelsUnified(config);
      setModelValidationResult(modelResult);
      setIsModelValidating(false);
      if (!config.provider || config.provider === 'gemini') {
          setIsSearchValidating(true);
          const searchResult = await validateSearchUnified(config);
          setSearchStatus(searchResult.success ? t.searchSuccess : (searchResult.message || t.searchFail));
          setSearchStatusType(searchResult.success ? 'success' : 'error');
          setIsSearchValidating(false);
      }
      setStatus(language === 'zh' ? "全面验证完成。" : "Full validation complete.");
      setStatusType('success'); setIsValidating(false);
  };

  const handleSaveOnly = async () => {
      const result = await persistAIConfig(config);
      if (!result.ok) {
          setStatus((language === 'zh' ? '保存到 PC 失败：' : 'Save to PC failed: ') + (result.error || ''));
          setStatusType('error');
          return;
      }
      setStatus(t.saveSuccess); setStatusType('success');
      setTimeout(() => { setStatus(''); setStatusType('neutral'); }, 2000);
  };

  const handleSaveAndLaunch = async () => {
      const result = await persistAIConfig(config);
      if (!result.ok) {
          setStatus((language === 'zh' ? '保存到 PC 失败：' : 'Save to PC failed: ') + (result.error || ''));
          setStatusType('error');
          return;
      }
      onComplete();
  };

  const updateConfig = (key: keyof AIConfig, value: any) => {
      setConfig(prev => ({ ...prev, [key]: value }));
      if (statusType !== 'neutral') { setStatus(''); setStatusType('neutral'); }
      if (key === 'model_main' || key === 'model_summary') setModelValidationResult(prev => ({ ...prev, main: null, summary: null }));
      if (key === 'model_vision' || key === 'visionProvider') setModelValidationResult(prev => ({ ...prev, vision: null }));
      setSearchStatus(''); setSearchStatusType('neutral');
  };

  const SectionHeader = ({ label, icon: Icon, isOpen, onToggle }: { label: string, icon: any, isOpen: boolean, onToggle: () => void }) => (
    <button onClick={onToggle} className="cfg-section-btn w-full cfg-section-title font-bold flex items-center justify-between">
        <div className={`flex items-center gap-[clamp(6px,1vw,10px)] ${textPrimary}`}>
            <Icon size={16} /> <span className="ka-section-title tracking-[0.02em]">{label}</span>
        </div>
        <span className={`cfg-label-sm opacity-50 transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`}>▾</span>
    </button>
  );

  const ToggleCheck = ({ checked, onClick, label }: { checked: boolean, onClick: () => void, label: string }) => (
    <div className="flex items-center gap-[clamp(4px,0.6vw,8px)] cursor-pointer" onClick={onClick}>
        <div className={`w-[clamp(14px,1.8vw,18px)] h-[clamp(14px,1.8vw,18px)] border rounded flex items-center justify-center transition-all duration-200 ${checked ? toggleCheckedBoxCls : toggleUncheckedBoxCls}`}>
            {checked && <Check size={11} className={toggleCheckedIconCls} />}
        </div>
        {label && <span className={`ka-copy-sm ${text80}`}>{label}</span>}
    </div>
  );

  const inputCls = isDarkMode
    ? "w-full bg-[#211811] border border-[#8c6a3c] rounded-lg cfg-input-text ka-input-copy text-[#f2e5cf] placeholder-[#8e7659] focus:outline-none focus:border-yellow-500/80 focus:shadow-[0_0_0_3px_rgba(234,179,8,0.08)] transition-all px-[clamp(10px,1.4vw,16px)] py-[clamp(8px,1.2vw,12px)]"
    : "w-full bg-white/70 border border-[#785A42]/15 rounded-lg cfg-input-text ka-input-copy text-[#785A42] placeholder-[#785A42]/30 focus:outline-none focus:border-[#785A42]/35 focus:shadow-[0_0_0_3px_rgba(120,90,66,0.06)] transition-all px-[clamp(10px,1.4vw,16px)] py-[clamp(8px,1.2vw,12px)]";
  const selectCls = isDarkMode
    ? "w-full bg-[#211811] border border-[#8c6a3c] rounded-lg cfg-input-text ka-input-copy text-[#f2e5cf] focus:ring-1 focus:ring-yellow-500/40 outline-none px-[clamp(10px,1.4vw,16px)] py-[clamp(8px,1.2vw,12px)] transition-all"
    : "w-full bg-white/70 border border-[#785A42]/15 rounded-lg cfg-input-text ka-input-copy text-[#785A42] focus:ring-1 focus:ring-[#785A42]/20 outline-none px-[clamp(10px,1.4vw,16px)] py-[clamp(8px,1.2vw,12px)] transition-all";

  const textPrimary = isDarkMode ? 'text-[#f2e5cf]' : 'text-[#785A42]';
  const text90 = isDarkMode ? 'text-[#e8d4ba]' : 'text-[#785A42]/90';
  const text80 = isDarkMode ? 'text-[#d8beA1]' : 'text-[#785A42]/80';
  const text70 = isDarkMode ? 'text-[#b69f87]' : 'text-[#785A42]/70';
  const text65 = isDarkMode ? 'text-[#ac9478]' : 'text-[#785A42]/65';
  const text60 = isDarkMode ? 'text-[#a38a6f]' : 'text-[#785A42]/60';
  const text55 = isDarkMode ? 'text-[#998067]' : 'text-[#785A42]/55';
  const borderFaint = isDarkMode ? 'border-[#8c6a3c]/30' : 'border-[#785A42]/10';
  const fill5 = isDarkMode ? 'bg-[#d4a852]/10' : 'bg-[#785A42]/5';
  const fill8 = isDarkMode ? 'bg-[#d4a852]/12' : 'bg-[#785A42]/8';
  const secondaryBtnCls = isDarkMode
    ? 'border-[#8c6a3c]/55 text-[#f2e5cf] hover:bg-[#d4a852]/10'
    : 'border-[#785A42]/15 text-[#785A42] hover:bg-[#785A42]/5';
  const launchBtnCls = isDarkMode
    ? 'bg-[#c79a2f] hover:bg-[#d4a852] text-[#1b140d] shadow-[0_4px_16px_rgba(212,168,82,0.22)]'
    : 'bg-[#785A42] hover:bg-[#8c6045] text-[#f9f7f2] shadow-[0_4px_16px_rgba(120,90,66,0.18)]';
  const toggleCheckedBoxCls = isDarkMode ? 'bg-[#c79a2f] border-[#c79a2f]' : 'bg-[#785A42] border-[#785A42]';
  const toggleUncheckedBoxCls = isDarkMode ? 'border-[#8c6a3c]/55 bg-[#211811]/60' : 'border-[#785A42]/30 bg-white/60';
  const toggleCheckedIconCls = isDarkMode ? 'text-[#1b140d]' : 'text-[#f9f7f2]';

  return (
    <div className={`fixed top-0 left-0 w-full z-[80] config-bg ${textPrimary} font-sans overflow-hidden`} style={{ height: 'var(--app-height)' }}>
      <style>{styles}</style>
      <div className="relative z-10 w-full min-h-full h-full overflow-y-auto touch-scroll">
        <div className="w-full min-h-full flex flex-col items-center justify-center px-[clamp(16px,4vw,40px)] pt-[calc(var(--sat)+1rem)] pb-[calc(var(--sab)+1rem)]">
          <div className="w-[min(100%,42rem)] flex flex-col space-y-[clamp(12px,1.8vw,20px)]">

            {/* HEADER */}
            <div className="mx-auto flex w-full max-w-[34rem] flex-col items-center text-center">
              <div className="relative mb-[clamp(8px,1.2vw,14px)] flex items-center justify-center">
                <div className={`p-[clamp(8px,1.2vw,14px)] ${fill8} rounded-full`}>
                  <Settings className={`${textPrimary} gear-icon gear-icon-responsive`} />
                </div>
                <div className="absolute inset-[-8px] border border-dashed border-[#c5a059]/25 rounded-full"></div>
              </div>
              <h2 className={`cfg-title font-semibold tracking-[0.02em] font-mincho ${textPrimary} title-accent text-center leading-[1.08]`}>{t.title}</h2>
              <p className={`cfg-subtitle ka-copy-sm ${text55} mt-[clamp(10px,1.4vw,16px)] tracking-[0.05em] text-center`}>{t.subtitle}</p>
            </div>

            {/* Security */}
            <div className="space-y-[clamp(6px,1vw,10px)]">
                <SectionHeader label={t.security} icon={Key} isOpen={isSecurityOpen} onToggle={() => setIsSecurityOpen(!isSecurityOpen)} />
                <Collapse isOpen={isSecurityOpen} duration={180}>
                <div className="cfg-glass rounded-xl p-[clamp(14px,2vw,22px)] space-y-[clamp(12px,1.6vw,18px)]">
                    <div>
                        <label className={`block ka-label ${text70} mb-[clamp(4px,0.6vw,6px)]`}>{t.provider}</label>
                        <ThemedSelect
                            value={config.provider || 'gemini'}
                            onChange={(val) => {
                                const p = val as AIProvider;
                                updateConfig('provider', p);
                                if (p === 'gemini') {
                                    updateConfig('useCustomEndpoint', false);
                                    updateConfig('customEndpoint', '');
                                } else {
                                    updateConfig('useCustomEndpoint', true);
                                    updateConfig('customEndpoint', getDefaultEndpoint(p));
                                }
                            }}
                            options={providerSelectOptions}
                            isDarkMode={isDarkMode}
                            className={selectCls}
                            ariaLabel={t.provider}
                        />
                    </div>
                    <label className={`ka-kicker ${text70}`}>API KEYS</label>
                    <div className="space-y-[clamp(10px,1.4vw,16px)]">
                        <div>
                           <label className={`block ka-label ${text65} mb-[clamp(3px,0.5vw,5px)]`}>{t.keyLabel}</label>
                           <input type="password" value={config.apiKey_primary || ''} onChange={(e) => updateConfig('apiKey_primary', e.target.value)} placeholder={t.keyPlaceHolder} className={inputCls} />
                        </div>
                         <div>
                           <label className={`block ka-label ${text65} mb-[clamp(3px,0.5vw,5px)]`}>{t.keyLabel_backup}</label>
                           <input type="password" value={config.apiKey_backup || ''} onChange={(e) => updateConfig('apiKey_backup', e.target.value)} placeholder={t.keyPlaceHolder} className={inputCls} />
                        </div>
                        <p className={`ka-copy-sm ${text55} pl-1`}>{t.keyLocalDesc}</p>
                    </div>
                    <div className={`pt-[clamp(8px,1.2vw,12px)] border-t ${borderFaint}`}>
                        <div className="flex items-center justify-between mb-[clamp(6px,0.8vw,10px)]">
                            <label className={`ka-label ${text70} flex items-center gap-[clamp(4px,0.6vw,6px)]`}><Globe size={14} /> API ENDPOINT</label>
                            <ToggleCheck checked={config.useCustomEndpoint} onClick={() => updateConfig('useCustomEndpoint', !config.useCustomEndpoint)} label={t.useCustomEndpoint} />
                        </div>
                        {config.useCustomEndpoint ? (
                            <div className="animate-in slide-in-from-top-1"><input type="text" value={config.customEndpoint || ''} onChange={(e) => updateConfig('customEndpoint', e.target.value)} placeholder={t.customEndpointPlaceholder} className={inputCls} /></div>
                        ) : (
                            <div className={`ka-copy-sm ${text55} italic ${fill5} p-[clamp(8px,1.2vw,12px)] rounded-lg`}>{t.useCustomEndpointDesc}</div>
                        )}
                    </div>
                </div>
                </Collapse>
            </div>

            {/* Cortex Allocation */}
            <div className="space-y-[clamp(6px,1vw,10px)]">
                <SectionHeader label={t.allocation} icon={Brain} isOpen={isAllocationOpen} onToggle={() => setIsAllocationOpen(!isAllocationOpen)} />
                <Collapse isOpen={isAllocationOpen} duration={180}>
                <div className="space-y-[clamp(6px,1vw,10px)]">
                    <ModelCard title={t.slotA} slotKey="model_main" icon={Brain} desc={t.slotA_desc} defaultModel={getDefaultMainModel(config.provider)} validationResult={modelValidationResult.main} value={config.model_main as string} onChange={(v) => updateConfig('model_main', v)} onReset={() => updateConfig('model_main', getDefaultMainModel(config.provider))} t={t} language={language} accentColor={SLOT_ACCENTS.main} isDarkMode={isDarkMode} />
                    <ModelCard title={t.slotB} slotKey="model_summary" icon={Zap} desc={t.slotB_desc} defaultModel={getDefaultSummaryModel(config.provider)} validationResult={modelValidationResult.summary} value={config.model_summary as string} onChange={(v) => updateConfig('model_summary', v)} onReset={() => updateConfig('model_summary', getDefaultSummaryModel(config.provider))} t={t} language={language} accentColor={SLOT_ACCENTS.summary} isDarkMode={isDarkMode} />
                    <ModelCard title={t.slotC || 'Slot C · TTS Translation'} slotKey="model_translator" icon={Languages} desc={t.slotC_desc || ''} defaultModel="" validationResult={null} value={(config as any).model_translator || ''} onChange={(v) => updateConfig('model_translator' as any, v)} onReset={() => updateConfig('model_translator' as any, '')} t={t} language={language} accentColor={SLOT_ACCENTS.translator} isDarkMode={isDarkMode} />
                </div>
                </Collapse>
            </div>

            {/* Vision Helper */}
            <div className="space-y-[clamp(6px,1vw,10px)]">
                <SectionHeader label={t.visionHelper} icon={Eye} isOpen={isVisionOpen} onToggle={() => setIsVisionOpen(!isVisionOpen)} />
                {!isVisionOpen && <p className={`ka-copy-sm ${text55} mt-[clamp(2px,0.4vw,4px)] ml-[clamp(22px,2.6vw,30px)]`}>{t.visionHelperDesc}</p>}
                <Collapse isOpen={isVisionOpen} duration={180}>
                <div className="cfg-glass rounded-xl p-[clamp(14px,2vw,22px)] space-y-[clamp(10px,1.4vw,16px)]">
                    <div className="flex items-center justify-between">
                        <label className={`ka-label ${text90}`}>{t.useVisionHelper}</label>
                        <ToggleCheck checked={config.useVisionHelper} onClick={() => updateConfig('useVisionHelper', !config.useVisionHelper)} label="" />
                    </div>
                    {config.useVisionHelper && (
                        <div className={`space-y-[clamp(10px,1.4vw,16px)] animate-in slide-in-from-top-1 pt-[clamp(8px,1vw,12px)] border-t ${borderFaint}`}>
                            <p className={`ka-copy-sm ${text60}`}>{t.visionHelperDesc}</p>
                            <div>
                                <label className={`block ka-label ${text70} mb-[clamp(4px,0.6vw,6px)]`}>{t.provider}</label>
                                <ThemedSelect
                                    value={config.visionProvider || config.provider || 'gemini'}
                                    onChange={(val) => updateConfig('visionProvider', val)}
                                    options={providerSelectOptions}
                                    isDarkMode={isDarkMode}
                                    className={selectCls}
                                    ariaLabel={t.provider}
                                />
                            </div>
                            <div>
                               <label className={`block ka-label ${text65} mb-[clamp(3px,0.5vw,5px)]`}>{t.visionApiKeyLabel}</label>
                               <input type="password" value={config.visionApiKey || ''} onChange={(e) => updateConfig('visionApiKey', e.target.value)} placeholder={t.keyPlaceHolder} className={inputCls} />
                            </div>
                            <div className={`pt-[clamp(8px,1.2vw,12px)] border-t ${borderFaint}`}>
                                <div className="flex items-center justify-between mb-[clamp(6px,0.8vw,10px)]">
                                    <label className={`ka-label ${text70} flex items-center gap-[clamp(4px,0.6vw,6px)]`}><Globe size={14} /> API ENDPOINT</label>
                                    <ToggleCheck checked={config.useVisionCustomEndpoint ?? config.useCustomEndpoint} onClick={() => updateConfig('useVisionCustomEndpoint', !(config.useVisionCustomEndpoint ?? config.useCustomEndpoint))} label={t.useCustomEndpoint} />
                                </div>
                                {(config.useVisionCustomEndpoint ?? config.useCustomEndpoint) ? (
                                    <div className="animate-in slide-in-from-top-1"><input type="text" value={config.visionCustomEndpoint ?? config.customEndpoint ?? ''} onChange={(e) => updateConfig('visionCustomEndpoint', e.target.value)} placeholder={t.customEndpointPlaceholder} className={inputCls} /></div>
                                ) : (
                                    <div className={`ka-copy-sm ${text55} italic ${fill5} p-[clamp(8px,1.2vw,12px)] rounded-lg`}>{t.useCustomEndpointDesc}</div>
                                )}
                            </div>
                            <ModelCard title={t.visionModelLabel} slotKey="model_vision" icon={Eye} desc={""} defaultModel={getDefaultVisionModel(config.visionProvider || config.provider)} validationResult={modelValidationResult.vision} value={config.model_vision as string || ''} onChange={(v) => updateConfig('model_vision', v)} onReset={() => updateConfig('model_vision', getDefaultVisionModel(config.visionProvider || config.provider))} t={t} language={language} accentColor={SLOT_ACCENTS.vision} isDarkMode={isDarkMode} />
                        </div>
                    )}
                </div>
                </Collapse>
            </div>

            {/* Status + buttons (no longer a fixed bottom bar; flows with the centered column to mirror IntroScreen / AuthScreen) */}
            <div className="space-y-[clamp(6px,1vw,10px)]">
              {(status || searchStatus) && (
                <div className="space-y-1">
                  {status && (
                    <div className={`flex items-center justify-center gap-[clamp(4px,0.6vw,8px)] ka-label font-semibold ${statusType === 'error' ? 'text-red-600' : statusType === 'success' ? 'text-green-700' : textPrimary}`}>
                        {statusType === 'error' && <span className="status-dot status-dot-err"></span>}
                        {statusType === 'success' && <span className="status-dot status-dot-ok"></span>}
                        {statusType === 'neutral' && <RefreshCw className="animate-spin" size={13} />}
                        {status}
                    </div>
                  )}
                  {searchStatus && (
                    <div className={`flex items-center justify-center gap-[clamp(4px,0.6vw,8px)] ka-copy-sm font-semibold ${searchStatusType === 'error' ? 'text-red-600' : searchStatusType === 'success' ? 'text-green-700' : textPrimary}`}>
                        {searchStatusType === 'success' && <span className="status-dot status-dot-ok"></span>}
                        {searchStatusType === 'error' && <span className="status-dot status-dot-err"></span>}
                        {searchStatus}
                    </div>
                  )}
                  {statusType === 'success' && (modelValidationResult.main === false || modelValidationResult.summary === false || modelValidationResult.vision === false) && (
                      <p className="ka-copy-sm text-red-600 text-center">{t.modelValidationWarning}</p>
                  )}
                </div>
              )}
              <button onClick={handleValidateAll} disabled={isValidating || isSearchValidating || isModelValidating}
                  className={`w-full py-[clamp(8px,1.4vw,14px)] min-h-[44px] border ${secondaryBtnCls} font-semibold cfg-btn-text rounded-xl transition-all active:scale-[0.98] disabled:opacity-40 flex items-center justify-center gap-[clamp(4px,0.8vw,8px)]`}>
                  {(isValidating || isSearchValidating || isModelValidating) ? <RefreshCw className="animate-spin" size={15} /> : <ShieldCheck size={15} />}
                  <span>{language === 'zh' ? '全面验证配置 (VALIDATE ALL)' : 'VALIDATE ALL CONFIGURATIONS'}</span>
              </button>
              <div className="flex gap-[clamp(8px,1.2vw,14px)]">
                  <button onClick={handleSaveOnly} disabled={isValidating || isSearchValidating}
                      className={`flex-[0.4] py-[clamp(8px,1.4vw,14px)] min-h-[44px] border ${secondaryBtnCls} font-semibold cfg-btn-text rounded-xl transition-all active:scale-[0.98] disabled:opacity-40 flex items-center justify-center gap-[clamp(4px,0.6vw,6px)]`}>
                      <Save size={15} /> <span className="hidden sm:inline">{t.saveConfig}</span>
                  </button>
                  <button onClick={handleSaveAndLaunch} disabled={isValidating || isModelValidating || isSearchValidating}
                      className={`flex-[1] py-[clamp(8px,1.4vw,14px)] min-h-[48px] ${launchBtnCls} font-bold cfg-btn-text rounded-xl btn-launch disabled:opacity-40 flex items-center justify-center gap-[clamp(4px,0.8vw,8px)]`}>
                      <Power size={15} /> <span>{t.launchSystem}</span>
                  </button>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
};
