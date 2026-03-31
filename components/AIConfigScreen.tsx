
import React, { useState, useEffect } from 'react';
import { Settings, Key, Zap, Brain, CheckCircle, RefreshCw, AlertTriangle, Check, ShieldCheck, Activity, Power, Globe, Save, Languages } from 'lucide-react';
import { AIConfig, Language } from '../types';
import { getCurrentAIConfig, validateAIConnection, validateModels, validateSearchCapability } from '../services/geminiService';
import { getDefaultMainModel, getDefaultSummaryModel, getDefaultVisionModel } from '../services/appConfig';

interface AIConfigScreenProps {
  onComplete: () => void;
  language: Language; 
}

const CONFIG_TRANSLATIONS = {
    zh: {
        title: "神经网路配置",
        subtitle: "AMADEUS 系统 // 核心设定",
        security: "安全凭证",
        provider: "API 提供商",
        provider_gemini: "Google Gemini (默认)",
        provider_openai: "OpenAI",
        provider_anthropic: "Anthropic Claude",
        provider_deepseek: "DeepSeek",
        provider_grok: "xAI Grok",
        keyLabel: "主 API KEY (PRIMARY)",
        keyLabel_backup: "备用 API KEY (BACKUP)",
        useEnv: "使用环境变量",
        useEnvDesc: "使用系统环境变量 (process.env.API_KEY)。",
        useCustomEndpoint: "使用自定义接口",
        useCustomEndpointDesc: "覆盖默认的 API 地址 (如使用代理)。",
        customEndpointPlaceholder: "https://generativelanguage.googleapis.com",
        keyPlaceHolder: "请输入您的 API Key...",
        keyLocalDesc: "Key 仅保存在浏览器本地存储中。",
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
        error_missing: "错误：请提供 API Key 或启用环境变量。",
        error_invalid: "连接测试失败：Key无效、模型名称错误或无法连接服务器。",
        error_env_missing: "连接测试失败：环境变量 API_KEY 为空或无效。",
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
        provider_gemini: "Google Gemini (Default)",
        provider_openai: "OpenAI",
        provider_anthropic: "Anthropic Claude",
        provider_deepseek: "DeepSeek",
        provider_grok: "xAI Grok",
        keyLabel: "PRIMARY API KEY",
        keyLabel_backup: "BACKUP API KEY",
        useEnv: "Use Environment Key",
        useEnvDesc: "Using System Environment Variable (process.env.API_KEY).",
        useCustomEndpoint: "Use Custom Endpoint",
        useCustomEndpointDesc: "Override default API URL (e.g., for proxy).",
        customEndpointPlaceholder: "https://generativelanguage.googleapis.com",
        keyPlaceHolder: "Enter your API Key...",
        keyLocalDesc: "Key is stored locally in your browser.",
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
        error_missing: "Error: Please provide an API Key or enable Environment Key.",
        error_invalid: "Connection Failed: Invalid Key, Model Name, or Network Error.",
        error_env_missing: "Connection Failed: Env Variable API_KEY is missing or invalid.",
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
}

const ModelCard: React.FC<ModelCardProps> = ({ title, icon: Icon, desc, defaultModel, validationResult, value, onChange, onReset, t, language, accentColor = '#785A42' }) => (
    <div className="cfg-glass rounded-xl p-[clamp(12px,1.8vw,18px)] flex flex-col gap-[clamp(6px,0.8vw,10px)] transition-all duration-200 hover:shadow-md" style={{ borderLeft: `3px solid ${accentColor}` }}>
        <div className="flex items-center gap-[clamp(6px,1vw,10px)]">
            <div className="p-[clamp(4px,0.6vw,8px)] rounded-lg" style={{ background: `${accentColor}12` }}>
                <Icon size={16} style={{ color: accentColor }} />
            </div>
            <div className="flex-1 min-w-0">
                <h4 className="ka-section-title font-semibold tracking-[0.02em]" style={{ color: accentColor }}>{title}</h4>
                {desc && <p className="ka-copy-sm text-[#785A42]/60 truncate">{desc}</p>}
            </div>
        </div>
        <div className="relative">
            <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={defaultModel}
                className="w-full bg-white/70 border border-[#785A42]/15 rounded-lg cfg-input-text ka-input-copy text-[#785A42] placeholder-[#785A42]/30 focus:outline-none focus:border-[#785A42]/35 focus:shadow-[0_0_0_3px_rgba(120,90,66,0.06)] transition-all px-[clamp(8px,1.2vw,14px)] py-[clamp(6px,1vw,10px)]" />
            {validationResult === true && <span className="absolute right-[clamp(28px,3.5vw,36px)] top-1/2 -translate-y-1/2" title={t.modelAvailable}><CheckCircle size={15} className="text-green-600" /></span>}
            {validationResult === false && <span className="absolute right-[clamp(28px,3.5vw,36px)] top-1/2 -translate-y-1/2" title={t.modelUnavailable}><AlertTriangle size={15} className="text-red-600" /></span>}
            <button onClick={onReset} className="absolute right-1 top-1/2 -translate-y-1/2 ka-micro text-[#785A42]/50 hover:text-[#785A42] px-1.5 transition-colors" title={language === 'zh' ? '重置为推荐值' : 'Reset to Recommended'}>{t.reset}</button>
        </div>
    </div>
);

export const AIConfigScreen: React.FC<AIConfigScreenProps> = ({ onComplete, language = 'zh' }) => {
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

    .bottom-bar {
      background: rgba(249,247,242,0.88);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border-top: 1px solid rgba(120,90,66,0.1);
    }

    /* Scroll fade masks — content fades into edges */
    .scroll-fade-container {
      position: relative;
    }
    .scroll-fade-container::before,
    .scroll-fade-container::after {
      content: '';
      position: absolute;
      left: 0; right: 0;
      height: clamp(24px, 3vw, 40px);
      pointer-events: none;
      z-index: 2;
    }
    .scroll-fade-container::before {
      top: 0;
      background: linear-gradient(to bottom, #f9f7f2, transparent);
    }
    .scroll-fade-container::after {
      bottom: 0;
      background: linear-gradient(to top, #f9f7f2, transparent);
    }

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
  `;

  useEffect(() => { setConfig(getCurrentAIConfig()); }, []);

  const handleValidateAll = async () => {
      localStorage.setItem('kumiko_ai_config', JSON.stringify(config));
      setIsValidating(true);
      setStatus(language === 'zh' ? "正在进行全面验证..." : "Running full validation...");
      setStatusType('neutral');
      setModelValidationResult({ main: null, summary: null, vision: null }); 
      setSearchStatus('');
      if (!config.useEnvKey && !config.apiKey_primary) {
          setStatus(t.error_missing); setStatusType('error'); setIsValidating(false); return;
      }
      const isValid = await validateAIConnection(config);
      if (!isValid) {
          setStatus(config.useEnvKey ? t.error_env_missing : t.error_invalid);
          setStatusType('error'); setIsValidating(false); return;
      }
      setIsModelValidating(true);
      const modelResult = await validateModels(config);
      setModelValidationResult(modelResult);
      setIsModelValidating(false);
      if (!config.provider || config.provider === 'gemini') {
          setIsSearchValidating(true);
          const searchResult = await validateSearchCapability(config);
          setSearchStatus(searchResult.success ? t.searchSuccess : (searchResult.message || t.searchFail));
          setSearchStatusType(searchResult.success ? 'success' : 'error');
          setIsSearchValidating(false);
      }
      setStatus(language === 'zh' ? "全面验证完成。" : "Full validation complete.");
      setStatusType('success'); setIsValidating(false);
  };

  const handleSaveOnly = () => {
      localStorage.setItem('kumiko_ai_config', JSON.stringify(config));
      setStatus(t.saveSuccess); setStatusType('success');
      setTimeout(() => { setStatus(''); setStatusType('neutral'); }, 2000);
  };

  const handleSaveAndLaunch = () => {
      localStorage.setItem('kumiko_ai_config', JSON.stringify(config));
      onComplete();
  };

  const updateConfig = (key: keyof AIConfig, value: any) => {
      setConfig(prev => ({ ...prev, [key]: value }));
      if (statusType !== 'neutral') { setStatus(''); setStatusType('neutral'); }
      if (key === 'model_main' || key === 'model_summary') setModelValidationResult({ main: null, summary: null });
      setSearchStatus(''); setSearchStatusType('neutral');
  };

  const SectionHeader = ({ label, icon: Icon, isOpen, onToggle }: { label: string, icon: any, isOpen: boolean, onToggle: () => void }) => (
    <button onClick={onToggle} className="cfg-section-btn w-full cfg-section-title font-bold flex items-center justify-between">
        <div className="flex items-center gap-[clamp(6px,1vw,10px)] text-[#785A42]">
            <Icon size={16} /> <span className="ka-section-title tracking-[0.02em]">{label}</span>
        </div>
        <span className={`cfg-label-sm opacity-50 transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`}>▾</span>
    </button>
  );

  const ToggleCheck = ({ checked, onClick, label }: { checked: boolean, onClick: () => void, label: string }) => (
    <div className="flex items-center gap-[clamp(4px,0.6vw,8px)] cursor-pointer" onClick={onClick}>
        <div className={`w-[clamp(14px,1.8vw,18px)] h-[clamp(14px,1.8vw,18px)] border rounded flex items-center justify-center transition-all duration-200 ${checked ? 'bg-[#785A42] border-[#785A42]' : 'border-[#785A42]/30 bg-white/60'}`}>
            {checked && <Check size={11} className="text-[#f9f7f2]" />}
        </div>
        {label && <span className="ka-copy-sm text-[#785A42]/80">{label}</span>}
    </div>
  );

  const inputCls = "w-full bg-white/70 border border-[#785A42]/15 rounded-lg cfg-input-text ka-input-copy text-[#785A42] placeholder-[#785A42]/30 focus:outline-none focus:border-[#785A42]/35 focus:shadow-[0_0_0_3px_rgba(120,90,66,0.06)] transition-all px-[clamp(10px,1.4vw,16px)] py-[clamp(8px,1.2vw,12px)]";
  const selectCls = "w-full bg-white/70 border border-[#785A42]/15 rounded-lg cfg-input-text ka-input-copy text-[#785A42] focus:ring-1 focus:ring-[#785A42]/20 outline-none px-[clamp(10px,1.4vw,16px)] py-[clamp(8px,1.2vw,12px)] transition-all";

  return (
    <div className="fixed top-0 left-0 w-full z-[80] config-bg text-[#785A42] flex flex-col font-sans overflow-hidden" style={{ height: 'var(--app-height)' }}>
      <style>{styles}</style>

      {/* HEADER */}
      <div className="flex-shrink-0 px-4 pt-[clamp(20px,4vw,40px)] pb-[clamp(8px,1.5vw,16px)]">
         <div className="mx-auto flex w-full max-w-[34rem] flex-col items-center text-center">
           <div className="relative mb-[clamp(8px,1.2vw,14px)] flex items-center justify-center">
             <div className="p-[clamp(8px,1.2vw,14px)] bg-[#785A42]/8 rounded-full">
               <Settings className="text-[#785A42] gear-icon gear-icon-responsive" />
             </div>
             <div className="absolute inset-[-8px] border border-dashed border-[#c5a059]/25 rounded-full"></div>
           </div>
           <h2 className="cfg-title font-semibold tracking-[0.02em] font-mincho text-[#785A42] title-accent text-center leading-[1.08]">{t.title}</h2>
           <p className="cfg-subtitle ka-copy-sm text-[#785A42]/55 mt-[clamp(10px,1.4vw,16px)] tracking-[0.05em] text-center">{t.subtitle}</p>
         </div>
      </div>

      {/* SCROLLABLE CONTENT */}
      <div className="flex-1 overflow-hidden scroll-fade-container">
      <div className="h-full overflow-y-auto overflow-x-hidden px-[clamp(16px,4vw,40px)] pt-[clamp(12px,2vw,20px)] pb-[clamp(24px,3vw,40px)] touch-scroll">
        <div className="w-[min(100%,42rem)] mx-auto space-y-[clamp(10px,1.6vw,16px)]">

            {/* Security */}
            <div className="space-y-[clamp(6px,1vw,10px)]">
                <SectionHeader label={t.security} icon={Key} isOpen={isSecurityOpen} onToggle={() => setIsSecurityOpen(!isSecurityOpen)} />
                {isSecurityOpen && (
                <div className="cfg-glass rounded-xl p-[clamp(14px,2vw,22px)] animate-in slide-in-from-top-2 duration-200 space-y-[clamp(12px,1.6vw,18px)]">
                    <div>
                        <label className="block ka-label text-[#785A42]/70 mb-[clamp(4px,0.6vw,6px)]">{t.provider}</label>
                        <select value={config.provider || 'gemini'} onChange={(e) => updateConfig('provider', e.target.value)} className={selectCls}>
                            <option value="gemini">{t.provider_gemini}</option>
                            <option value="openai">{t.provider_openai}</option>
                            <option value="anthropic">{t.provider_anthropic}</option>
                            <option value="deepseek">{t.provider_deepseek}</option>
                            <option value="grok">{t.provider_grok}</option>
                            <option value="openrouter">OpenRouter.ai</option>
                        </select>
                    </div>
                    <div className="flex items-center justify-between">
                        <label className="ka-kicker text-[#785A42]/70">API KEYS</label>
                        <ToggleCheck checked={config.useEnvKey} onClick={() => updateConfig('useEnvKey', !config.useEnvKey)} label={t.useEnv} />
                    </div>
                    {!config.useEnvKey ? (
                        <div className="space-y-[clamp(10px,1.4vw,16px)] animate-in slide-in-from-top-1">
                            <div>
                               <label className="block ka-label text-[#785A42]/65 mb-[clamp(3px,0.5vw,5px)]">{t.keyLabel}</label>
                               <input type="password" value={config.apiKey_primary || ''} onChange={(e) => updateConfig('apiKey_primary', e.target.value)} placeholder={t.keyPlaceHolder} className={inputCls} />
                            </div>
                             <div>
                               <label className="block ka-label text-[#785A42]/65 mb-[clamp(3px,0.5vw,5px)]">{t.keyLabel_backup}</label>
                               <input type="password" value={config.apiKey_backup || ''} onChange={(e) => updateConfig('apiKey_backup', e.target.value)} placeholder={t.keyPlaceHolder} className={inputCls} />
                            </div>
                            <p className="ka-copy-sm text-[#785A42]/55 pl-1">{t.keyLocalDesc}</p>
                        </div>
                    ) : (
                        <div className="ka-copy-sm text-[#785A42]/55 italic bg-[#785A42]/5 p-[clamp(8px,1.2vw,12px)] rounded-lg">{t.useEnvDesc}</div>
                    )}
                    <div className="pt-[clamp(8px,1.2vw,12px)] border-t border-[#785A42]/10">
                        <div className="flex items-center justify-between mb-[clamp(6px,0.8vw,10px)]">
                            <label className="ka-label text-[#785A42]/70 flex items-center gap-[clamp(4px,0.6vw,6px)]"><Globe size={14} /> API ENDPOINT</label>
                            <ToggleCheck checked={config.useCustomEndpoint} onClick={() => updateConfig('useCustomEndpoint', !config.useCustomEndpoint)} label={t.useCustomEndpoint} />
                        </div>
                        {config.useCustomEndpoint ? (
                            <div className="animate-in slide-in-from-top-1"><input type="text" value={config.customEndpoint || ''} onChange={(e) => updateConfig('customEndpoint', e.target.value)} placeholder={t.customEndpointPlaceholder} className={inputCls} /></div>
                        ) : (
                            <div className="ka-copy-sm text-[#785A42]/55 italic bg-[#785A42]/5 p-[clamp(8px,1.2vw,12px)] rounded-lg">{t.useCustomEndpointDesc}</div>
                        )}
                    </div>
                </div>
                )}
            </div>

            {/* Cortex Allocation */}
            <div className="space-y-[clamp(6px,1vw,10px)]">
                <SectionHeader label={t.allocation} icon={Brain} isOpen={isAllocationOpen} onToggle={() => setIsAllocationOpen(!isAllocationOpen)} />
                {isAllocationOpen && (
                <div className="space-y-[clamp(6px,1vw,10px)] animate-in slide-in-from-top-2 duration-200">
                    <ModelCard title={t.slotA} slotKey="model_main" icon={Brain} desc={t.slotA_desc} defaultModel={getDefaultMainModel(config.provider)} validationResult={modelValidationResult.main} value={config.model_main as string} onChange={(v) => updateConfig('model_main', v)} onReset={() => updateConfig('model_main', getDefaultMainModel(config.provider))} t={t} language={language} accentColor={SLOT_ACCENTS.main} />
                    <ModelCard title={t.slotB} slotKey="model_summary" icon={Zap} desc={t.slotB_desc} defaultModel={getDefaultSummaryModel(config.provider)} validationResult={modelValidationResult.summary} value={config.model_summary as string} onChange={(v) => updateConfig('model_summary', v)} onReset={() => updateConfig('model_summary', getDefaultSummaryModel(config.provider))} t={t} language={language} accentColor={SLOT_ACCENTS.summary} />
                    <ModelCard title={t.slotC || 'Slot C · TTS Translation'} slotKey="model_translator" icon={Languages} desc={t.slotC_desc || ''} defaultModel="" validationResult={null} value={(config as any).model_translator || ''} onChange={(v) => updateConfig('model_translator' as any, v)} onReset={() => updateConfig('model_translator' as any, '')} t={t} language={language} accentColor={SLOT_ACCENTS.translator} />
                </div>
                )}
            </div>

            {/* Vision Helper */}
            <div className="space-y-[clamp(6px,1vw,10px)]">
                <SectionHeader label={t.visionHelper} icon={Globe} isOpen={isVisionOpen} onToggle={() => setIsVisionOpen(!isVisionOpen)} />
                {isVisionOpen && (
                <div className="cfg-glass rounded-xl p-[clamp(14px,2vw,22px)] animate-in slide-in-from-top-2 duration-200 space-y-[clamp(10px,1.4vw,16px)]">
                    <div className="flex items-center justify-between">
                        <label className="ka-label text-[#785A42]/70">{t.useVisionHelper}</label>
                        <ToggleCheck checked={config.useVisionHelper} onClick={() => updateConfig('useVisionHelper', !config.useVisionHelper)} label="" />
                    </div>
                    {config.useVisionHelper && (
                        <div className="space-y-[clamp(10px,1.4vw,16px)] animate-in slide-in-from-top-1 pt-[clamp(8px,1vw,12px)] border-t border-[#785A42]/10">
                            <p className="ka-copy-sm text-[#785A42]/60">{t.visionHelperDesc}</p>
                            <div>
                                <label className="block ka-label text-[#785A42]/70 mb-[clamp(4px,0.6vw,6px)]">{t.provider}</label>
                                <select value={config.visionProvider || config.provider || 'gemini'} onChange={(e) => updateConfig('visionProvider', e.target.value)} className={selectCls}>
                                    <option value="gemini">{t.provider_gemini}</option>
                                    <option value="openai">{t.provider_openai}</option>
                                    <option value="anthropic">{t.provider_anthropic}</option>
                                    <option value="deepseek">{t.provider_deepseek}</option>
                                    <option value="grok">{t.provider_grok}</option>
                                    <option value="openrouter">OpenRouter.ai</option>
                                </select>
                            </div>
                            <div>
                               <label className="block ka-label text-[#785A42]/65 mb-[clamp(3px,0.5vw,5px)]">{t.visionApiKeyLabel}</label>
                               <input type="password" value={config.visionApiKey || ''} onChange={(e) => updateConfig('visionApiKey', e.target.value)} placeholder={t.keyPlaceHolder} className={inputCls} />
                            </div>
                            <div className="pt-[clamp(8px,1.2vw,12px)] border-t border-[#785A42]/10">
                                <div className="flex items-center justify-between mb-[clamp(6px,0.8vw,10px)]">
                                    <label className="ka-label text-[#785A42]/70 flex items-center gap-[clamp(4px,0.6vw,6px)]"><Globe size={14} /> API ENDPOINT</label>
                                    <ToggleCheck checked={config.useVisionCustomEndpoint ?? config.useCustomEndpoint} onClick={() => updateConfig('useVisionCustomEndpoint', !(config.useVisionCustomEndpoint ?? config.useCustomEndpoint))} label={t.useCustomEndpoint} />
                                </div>
                                {(config.useVisionCustomEndpoint ?? config.useCustomEndpoint) ? (
                                    <div className="animate-in slide-in-from-top-1"><input type="text" value={config.visionCustomEndpoint ?? config.customEndpoint ?? ''} onChange={(e) => updateConfig('visionCustomEndpoint', e.target.value)} placeholder={t.customEndpointPlaceholder} className={inputCls} /></div>
                                ) : (
                                    <div className="ka-copy-sm text-[#785A42]/55 italic bg-[#785A42]/5 p-[clamp(8px,1.2vw,12px)] rounded-lg">{t.useCustomEndpointDesc}</div>
                                )}
                            </div>
                            <ModelCard title={t.visionModelLabel} slotKey="model_vision" icon={Globe} desc={""} defaultModel={getDefaultVisionModel(config.visionProvider || config.provider)} validationResult={modelValidationResult.vision} value={config.model_vision as string || ''} onChange={(v) => updateConfig('model_vision', v)} onReset={() => updateConfig('model_vision', getDefaultVisionModel(config.visionProvider || config.provider))} t={t} language={language} accentColor={SLOT_ACCENTS.vision} />
                        </div>
                    )}
                </div>
                )}
            </div>
        </div>
      </div>
      </div>

      {/* FIXED BOTTOM BAR */}
      <div className="flex-shrink-0 bottom-bar px-[clamp(16px,4vw,40px)] py-[clamp(10px,1.8vw,18px)] safe-area-padding-bottom">
        <div className="w-[min(100%,42rem)] mx-auto space-y-[clamp(6px,1vw,10px)]">
          {(status || searchStatus) && (
            <div className="space-y-1">
              {status && (
                <div className={`flex items-center justify-center gap-[clamp(4px,0.6vw,8px)] ka-label font-semibold ${statusType === 'error' ? 'text-red-600' : statusType === 'success' ? 'text-green-700' : 'text-[#785A42]'}`}>
                    {statusType === 'error' && <span className="status-dot status-dot-err"></span>}
                    {statusType === 'success' && <span className="status-dot status-dot-ok"></span>}
                    {statusType === 'neutral' && <RefreshCw className="animate-spin" size={13} />}
                    {status}
                </div>
              )}
              {searchStatus && (
                <div className={`flex items-center justify-center gap-[clamp(4px,0.6vw,8px)] ka-copy-sm font-semibold ${searchStatusType === 'error' ? 'text-red-600' : searchStatusType === 'success' ? 'text-green-700' : 'text-[#785A42]'}`}>
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
              className="w-full py-[clamp(8px,1.4vw,14px)] border border-[#785A42]/15 text-[#785A42] hover:bg-[#785A42]/5 font-semibold cfg-btn-text rounded-xl transition-all active:scale-[0.98] disabled:opacity-40 flex items-center justify-center gap-[clamp(4px,0.8vw,8px)]">
              {(isValidating || isSearchValidating || isModelValidating) ? <RefreshCw className="animate-spin" size={15} /> : <ShieldCheck size={15} />}
              <span>{language === 'zh' ? '全面验证配置 (VALIDATE ALL)' : 'VALIDATE ALL CONFIGURATIONS'}</span>
          </button>
          <div className="flex gap-[clamp(8px,1.2vw,14px)]">
              <button onClick={handleSaveOnly} disabled={isValidating || isSearchValidating}
                  className="flex-[0.4] py-[clamp(8px,1.4vw,14px)] border border-[#785A42]/15 text-[#785A42] hover:bg-[#785A42]/5 font-semibold cfg-btn-text rounded-xl transition-all active:scale-[0.98] disabled:opacity-40 flex items-center justify-center gap-[clamp(4px,0.6vw,6px)]">
                  <Save size={15} /> <span className="hidden sm:inline">{t.saveConfig}</span>
              </button>
              <button onClick={handleSaveAndLaunch} disabled={isValidating || isModelValidating || isSearchValidating}
                  className="flex-[1] py-[clamp(8px,1.4vw,14px)] bg-[#785A42] hover:bg-[#8c6045] text-[#f9f7f2] font-bold cfg-btn-text rounded-xl btn-launch shadow-[0_4px_16px_rgba(120,90,66,0.18)] disabled:opacity-40 flex items-center justify-center gap-[clamp(4px,0.8vw,8px)]">
                  <Power size={15} /> <span>{t.launchSystem}</span>
              </button>
          </div>
        </div>
      </div>
    </div>
  );
};
