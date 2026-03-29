
import React, { useState, useEffect } from 'react';
import { Settings, Key, Zap, Brain, CheckCircle, RefreshCw, AlertTriangle, Check, ShieldCheck, Activity, Power, Globe, Save, Languages } from 'lucide-react';
import { AIConfig, Language } from '../types';
import { getCurrentAIConfig, validateAIConnection, validateModels, validateSearchCapability } from '../services/geminiService';
import { getDefaultMainModel, getDefaultSummaryModel, getDefaultVisionModel } from '../services/appConfig';

interface AIConfigScreenProps {
  onComplete: () => void;
  language: Language; 
}

// LOCAL TRANSLATIONS FOR CONFIG SCREEN
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

// --- EXTRACTED COMPONENT (Critical for Input Stability) ---
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
}

const ModelCard: React.FC<ModelCardProps> = ({ 
    title, 
    icon: Icon, 
    desc, 
    defaultModel,
    validationResult,
    value,
    onChange,
    onReset,
    t
}) => (
    <div className="bg-white/5 border border-[#785A42]/20 rounded-lg p-4 flex flex-col gap-2 hover:bg-white/10 transition-colors">
        <div className="flex items-center gap-2 mb-1">
            <div className="p-1.5 bg-[#785A42]/10 rounded text-[#785A42]">
                <Icon size={16} />
            </div>
            <div>
                <h4 className="text-xs font-bold text-[#785A42] uppercase tracking-wider">{title}</h4>
                <p className="text-[9px] text-[#785A42]/60 font-mono">{desc}</p>
            </div>
        </div>
        <div className="relative">
            <input 
                type="text" 
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={defaultModel}
                className="w-full bg-[#f9f7f2] border border-[#785A42]/30 rounded px-2 py-1.5 text-xs font-mono text-[#785A42] placeholder-[#785A42]/30 focus:outline-none focus:border-[#785A42]"
            />
            {validationResult === true && <span className="absolute right-8 top-1/2 -translate-y-1/2" title={t.modelAvailable}><CheckCircle size={14} className="text-green-600" /></span>}
            {validationResult === false && <span className="absolute right-8 top-1/2 -translate-y-1/2" title={t.modelUnavailable}><AlertTriangle size={14} className="text-red-600" /></span>}
            <button 
                onClick={onReset}
                className="absolute right-1 top-1/2 -translate-y-1/2 text-[9px] text-[#785A42]/50 hover:text-[#785A42] px-1"
                title={language === 'zh' ? '重置为推荐值' : 'Reset to Recommended'}
            >
                {t.reset}
            </button>
        </div>
    </div>
);

export const AIConfigScreen: React.FC<AIConfigScreenProps> = ({ onComplete, language = 'zh' }) => {
  const t = CONFIG_TRANSLATIONS[language];
  const [config, setConfig] = useState<AIConfig>(getCurrentAIConfig());
  const [isValidating, setIsValidating] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [statusType, setStatusType] = useState<'neutral' | 'success' | 'error'>('neutral');

  // Search Validation State
  const [isSearchValidating, setIsSearchValidating] = useState(false);
  const [searchStatus, setSearchStatus] = useState<string>('');
  const [searchStatusType, setSearchStatusType] = useState<'neutral' | 'success' | 'error'>('neutral');

  // New states for model validation
  const [isModelValidating, setIsModelValidating] = useState(false);
  const [modelValidationResult, setModelValidationResult] = useState<{ main: boolean | null, summary: boolean | null, vision: boolean | null }>({ main: null, summary: null, vision: null });

  // Collapsible sections state
  const [isSecurityOpen, setIsSecurityOpen] = useState(true);
  const [isAllocationOpen, setIsAllocationOpen] = useState(false);
  const [isVisionOpen, setIsVisionOpen] = useState(false);

  useEffect(() => {
      // Force reload from disk on mount to ensure we aren't showing stale state
      const fresh = getCurrentAIConfig();
      setConfig(fresh);
  }, []);

  const handleTestConnection = async () => {
      // FORCE SAVE immediately upon testing to prevent data loss
      localStorage.setItem('kumiko_ai_config', JSON.stringify(config));
      
      setIsValidating(true);
      setStatus(t.validating);
      setStatusType('neutral');
      setModelValidationResult({ main: null, summary: null, vision: null }); 
      setSearchStatus(''); // Reset search status on general test
      
      if (!config.useEnvKey && !config.apiKey_primary) {
          setStatus(t.error_missing);
          setStatusType('error');
          setIsValidating(false);
          return;
      }

      const isValid = await validateAIConnection(config);

      if (!isValid) {
          if (config.useEnvKey) {
             setStatus(t.error_env_missing);
          } else {
             setStatus(t.error_invalid);
          }
          setStatusType('error');
      } else {
          setStatus(t.success);
          setStatusType('success');
      }
      setIsValidating(false);
  };

  const handleSearchValidation = async () => {
      // Auto-save before test
      localStorage.setItem('kumiko_ai_config', JSON.stringify(config));

      setIsSearchValidating(true);
      setSearchStatus(t.validatingSearch);
      setSearchStatusType('neutral');

      const result = await validateSearchCapability(config);

      if (result.success) {
          setSearchStatus(t.searchSuccess);
          setSearchStatusType('success');
      } else {
          setSearchStatus(result.message || t.searchFail);
          setSearchStatusType('error');
      }
      setIsSearchValidating(false);
  };

  const handleModelValidation = async () => {
    setIsModelValidating(true);
    setModelValidationResult({ main: null, summary: null, vision: null });
    const result = await validateModels(config);
    const nextResult = { main: result.main, summary: result.summary, vision: result.vision };
    setModelValidationResult(nextResult);
    setIsModelValidating(false);
    return nextResult;
  };

  const handleValidateAll = async () => {
      // FORCE SAVE immediately upon testing to prevent data loss
      localStorage.setItem('kumiko_ai_config', JSON.stringify(config));
      
      setIsValidating(true);
      setStatus(language === 'zh' ? "正在进行全面验证..." : "Running full validation...");
      setStatusType('neutral');
      setModelValidationResult({ main: null, summary: null, vision: null }); 
      setSearchStatus('');
      
      if (!config.useEnvKey && !config.apiKey_primary) {
          setStatus(t.error_missing);
          setStatusType('error');
          setIsValidating(false);
          return;
      }

      // 1. Test Connection
      const isValid = await validateAIConnection(config);
      if (!isValid) {
          if (config.useEnvKey) {
             setStatus(t.error_env_missing);
          } else {
             setStatus(t.error_invalid);
          }
          setStatusType('error');
          setIsValidating(false);
          return;
      }

      // 2. Test Models
      setIsModelValidating(true);
      const modelResult = await validateModels(config);
      setModelValidationResult(modelResult);
      setIsModelValidating(false);

      // 3. Test Search (if applicable)
      if (!config.provider || config.provider === 'gemini') {
          setIsSearchValidating(true);
          const searchResult = await validateSearchCapability(config);
          if (searchResult.success) {
              setSearchStatus(t.searchSuccess);
              setSearchStatusType('success');
          } else {
              setSearchStatus(searchResult.message || t.searchFail);
              setSearchStatusType('error');
          }
          setIsSearchValidating(false);
      }

      setStatus(language === 'zh' ? "全面验证完成。" : "Full validation complete.");
      setStatusType('success');
      setIsValidating(false);
  };

  const handleSaveOnly = () => {
      localStorage.setItem('kumiko_ai_config', JSON.stringify(config));
      setStatus(t.saveSuccess);
      setStatusType('success');
      // Clear status after 2 seconds
      setTimeout(() => {
          setStatus('');
          setStatusType('neutral');
      }, 2000);
  };

  const handleSaveAndLaunch = () => {
      localStorage.setItem('kumiko_ai_config', JSON.stringify(config));
      onComplete();
  };

  const updateConfig = (key: keyof AIConfig, value: any) => {
      setConfig(prev => ({ ...prev, [key]: value }));
      if (statusType !== 'neutral') {
          setStatus('');
          setStatusType('neutral');
      }
      if (key === 'model_main' || key === 'model_summary') {
          setModelValidationResult({ main: null, summary: null });
      }
      // Reset search status on config change
      setSearchStatus('');
      setSearchStatusType('neutral');
  };

  return (
    <div className="fixed top-0 left-0 w-full z-[80] bg-[#f9f7f2] text-[#785A42] flex flex-col items-center justify-center font-sans overflow-y-auto overflow-x-hidden safe-area-padding" style={{ height: 'var(--app-height)' }}>
      
      <div className="absolute inset-0 z-0 opacity-10 pointer-events-none fixed" 
           style={{ backgroundImage: `repeating-linear-gradient(45deg, #785A42 0, #785A42 1px, transparent 0, transparent 50%)`, backgroundSize: '30px 30px' }}>
      </div>

      <div className="relative z-10 w-[min(92vw,36rem)] px-[clamp(1rem,2vh,1.5rem)] py-[clamp(1rem,2vh,1.5rem)] flex flex-col min-h-full md:min-h-0 md:h-auto md:max-h-[90vh]">
        
        <div className="text-center mb-[clamp(1rem,2.2vh,1.5rem)] mt-10 md:mt-0">
           <div className="inline-flex items-center justify-center p-3 bg-[#785A42]/10 rounded-full mb-3 animate-[spin_10s_linear_infinite]">
               <Settings size={24} className="text-[#785A42]" />
           </div>
           <h2 className="text-[clamp(1.8rem,3.4vh,2.3rem)] font-bold tracking-[0.2em] font-serif text-[#785A42]">
             {t.title}
           </h2>
           <p className="text-[10px] font-mono opacity-60 tracking-widest mt-1">{t.subtitle}</p>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin pr-1 space-y-4 mb-4 touch-scroll">
            
            <div className="space-y-2">
                <button 
                    onClick={() => setIsSecurityOpen(!isSecurityOpen)}
                    className="w-full text-xs font-bold border-b border-[#785A42]/20 pb-1 flex items-center justify-between"
                >
                    <div className="flex items-center gap-2">
                        <Key size={12} /> {t.security}
                    </div>
                    <span className="text-[10px] opacity-50">{isSecurityOpen ? '▼' : '▲'}</span>
                </button>
                
                {isSecurityOpen && (
                <div className="bg-white/50 border border-[#785A42]/20 rounded-lg p-3 animate-in slide-in-from-top-2">
                    <div className="mb-4">
                        <label className="block text-[10px] font-bold opacity-70 mb-1">{t.provider}</label>
                        <select 
                            value={config.provider || 'gemini'}
                            onChange={(e) => updateConfig('provider', e.target.value)}
                            className="w-full bg-white border border-[#785A42]/30 rounded px-2 py-1.5 text-xs font-mono text-[#785A42] focus:ring-1 focus:ring-[#785A42] outline-none"
                        >
                            <option value="gemini">{t.provider_gemini}</option>
                            <option value="openai">{t.provider_openai}</option>
                            <option value="anthropic">{t.provider_anthropic}</option>
                            <option value="deepseek">{t.provider_deepseek}</option>
                            <option value="grok">{t.provider_grok}</option>
                            <option value="openrouter">OpenRouter.ai</option>
                        </select>
                    </div>
                    <div className="flex items-center justify-between mb-2">
                        <label className="text-[10px] font-bold opacity-70">API KEYS</label>
                        <div className="flex items-center gap-1.5 cursor-pointer" onClick={() => updateConfig('useEnvKey', !config.useEnvKey)}>
                            <div className={`w-3 h-3 border rounded-sm flex items-center justify-center transition-colors ${config.useEnvKey ? 'bg-[#785A42] border-[#785A42]' : 'border-[#785A42]/50'}`}>
                                {config.useEnvKey && <CheckCircle size={10} className="text-[#f9f7f2]" />}
                            </div>
                            <span className="text-[10px] font-mono">{t.useEnv}</span>
                        </div>
                    </div>
                    
                    {!config.useEnvKey ? (
                        <div className="space-y-3 animate-in slide-in-from-top-1">
                            <div>
                               <label className="block text-[10px] font-bold opacity-60 mb-1">{t.keyLabel}</label>
                               <input 
                                   type="password" 
                                   value={config.apiKey_primary || ''}
                                   onChange={(e) => updateConfig('apiKey_primary', e.target.value)}
                                   placeholder={t.keyPlaceHolder}
                                   className="w-full bg-white border border-[#785A42]/30 rounded px-3 py-2 text-xs font-mono text-[#785A42] focus:ring-1 focus:ring-[#785A42] outline-none"
                               />
                            </div>
                             <div>
                               <label className="block text-[10px] font-bold opacity-60 mb-1">{t.keyLabel_backup}</label>
                               <input 
                                   type="password" 
                                   value={config.apiKey_backup || ''}
                                   onChange={(e) => updateConfig('apiKey_backup', e.target.value)}
                                   placeholder={t.keyPlaceHolder}
                                   className="w-full bg-white border border-[#785A42]/30 rounded px-3 py-2 text-xs font-mono text-[#785A42] focus:ring-1 focus:ring-[#785A42] outline-none"
                               />
                            </div>
                            <p className="text-[9px] opacity-50 pl-1">{t.keyLocalDesc}</p>
                        </div>
                    ) : (
                        <div className="text-[10px] font-mono opacity-50 italic pl-1 bg-[#785A42]/5 p-2 rounded">
                            {t.useEnvDesc}
                        </div>
                    )}

                    <div className="mt-4 pt-4 border-t border-[#785A42]/10">
                        <div className="flex items-center justify-between mb-2">
                            <label className="text-[10px] font-bold opacity-70 flex items-center gap-1">
                                <Globe size={10} /> API ENDPOINT
                            </label>
                            <div className="flex items-center gap-1.5 cursor-pointer" onClick={() => updateConfig('useCustomEndpoint', !config.useCustomEndpoint)}>
                                <div className={`w-3 h-3 border rounded-sm flex items-center justify-center transition-colors ${config.useCustomEndpoint ? 'bg-[#785A42] border-[#785A42]' : 'border-[#785A42]/50'}`}>
                                    {config.useCustomEndpoint && <CheckCircle size={10} className="text-[#f9f7f2]" />}
                                </div>
                                <span className="text-[10px] font-mono">{t.useCustomEndpoint}</span>
                            </div>
                        </div>
                        
                        {config.useCustomEndpoint ? (
                            <div className="space-y-2 animate-in slide-in-from-top-1">
                                <input 
                                    type="text" 
                                    value={config.customEndpoint || ''}
                                    onChange={(e) => updateConfig('customEndpoint', e.target.value)}
                                    placeholder={t.customEndpointPlaceholder}
                                    className="w-full bg-white border border-[#785A42]/30 rounded px-3 py-2 text-xs font-mono text-[#785A42] focus:ring-1 focus:ring-[#785A42] outline-none"
                                />
                            </div>
                        ) : (
                            <div className="text-[10px] font-mono opacity-50 italic pl-1 bg-[#785A42]/5 p-2 rounded">
                                {t.useCustomEndpointDesc}
                            </div>
                        )}
                    </div>
                </div>
                )}
            </div>

            <div className="space-y-2">
                <button 
                    onClick={() => setIsAllocationOpen(!isAllocationOpen)}
                    className="w-full text-xs font-bold border-b border-[#785A42]/20 pb-1 flex items-center justify-between"
                >
                    <div className="flex items-center gap-2">
                        <Brain size={12} /> {t.allocation}
                    </div>
                    <span className="text-[10px] opacity-50">{isAllocationOpen ? '▼' : '▲'}</span>
                </button>
                
                {isAllocationOpen && (
                <div className="space-y-3 animate-in slide-in-from-top-2">
                    <ModelCard 
                        title={t.slotA}
                        slotKey="model_main" 
                        icon={Brain} 
                        desc={t.slotA_desc}
                        defaultModel={getDefaultMainModel(config.provider)}
                        validationResult={modelValidationResult.main}
                        value={config.model_main as string}
                        onChange={(val) => updateConfig('model_main', val)}
                        onReset={() => updateConfig('model_main', getDefaultMainModel(config.provider))}
                        t={t}
                    />

                    <ModelCard 
                        title={t.slotB}
                        slotKey="model_summary" 
                        icon={Zap} 
                        desc={t.slotB_desc}
                        defaultModel={getDefaultSummaryModel(config.provider)}
                        validationResult={modelValidationResult.summary}
                        value={config.model_summary as string}
                        onChange={(val) => updateConfig('model_summary', val)}
                        onReset={() => updateConfig('model_summary', getDefaultSummaryModel(config.provider))}
                        t={t}
                    />

                    <ModelCard 
                        title={t.slotC || 'Slot C · TTS Translation'}
                        slotKey="model_translator" 
                        icon={Languages} 
                        desc={t.slotC_desc || ''}
                        defaultModel=""
                        validationResult={null}
                        value={(config as any).model_translator || ''}
                        onChange={(val) => updateConfig('model_translator' as any, val)}
                        onReset={() => updateConfig('model_translator' as any, '')}
                        t={t}
                    />
                </div>
                )}
            </div>

            <div className="space-y-2 mt-4">
                <button 
                    onClick={() => setIsVisionOpen(!isVisionOpen)}
                    className="w-full text-xs font-bold border-b border-[#785A42]/20 pb-1 flex items-center justify-between"
                >
                    <div className="flex items-center gap-2">
                        <Globe size={12} /> {t.visionHelper}
                    </div>
                    <span className="text-[10px] opacity-50">{isVisionOpen ? '▼' : '▲'}</span>
                </button>
                
                {isVisionOpen && (
                <div className="bg-white/50 border border-[#785A42]/20 rounded-lg p-3 animate-in slide-in-from-top-2">
                    <div className="flex items-center justify-between mb-3">
                        <label className="text-[10px] font-bold opacity-70">{t.useVisionHelper}</label>
                        <div className="flex items-center gap-1.5 cursor-pointer" onClick={() => updateConfig('useVisionHelper', !config.useVisionHelper)}>
                            <div className={`w-3 h-3 border rounded-sm flex items-center justify-center transition-colors ${config.useVisionHelper ? 'bg-[#785A42] border-[#785A42]' : 'border-[#785A42]/50'}`}>
                                {config.useVisionHelper && <CheckCircle size={10} className="text-[#f9f7f2]" />}
                            </div>
                        </div>
                    </div>
                    
                    {config.useVisionHelper && (
                        <div className="space-y-3 animate-in slide-in-from-top-1 pt-2 border-t border-[#785A42]/10">
                            <p className="text-[10px] opacity-80 font-mono mb-2 text-[#785A42]">{t.visionHelperDesc}</p>
                            
                            <div className="mb-4">
                                <label className="block text-[10px] font-bold opacity-70 mb-1">{t.provider}</label>
                                <select 
                                    value={config.visionProvider || config.provider || 'gemini'}
                                    onChange={(e) => updateConfig('visionProvider', e.target.value)}
                                    className="w-full bg-white border border-[#785A42]/30 rounded px-2 py-1.5 text-xs font-mono text-[#785A42] focus:ring-1 focus:ring-[#785A42] outline-none"
                                >
                                    <option value="gemini">{t.provider_gemini}</option>
                                    <option value="openai">{t.provider_openai}</option>
                                    <option value="anthropic">{t.provider_anthropic}</option>
                                    <option value="deepseek">{t.provider_deepseek}</option>
                                    <option value="grok">{t.provider_grok}</option>
                                    <option value="openrouter">OpenRouter.ai</option>
                                </select>
                            </div>

                            <div>
                               <label className="block text-[10px] font-bold opacity-60 mb-1">{t.visionApiKeyLabel}</label>
                               <input 
                                   type="password" 
                                   value={config.visionApiKey || ''}
                                   onChange={(e) => updateConfig('visionApiKey', e.target.value)}
                                   placeholder={t.keyPlaceHolder}
                                   className="w-full bg-white border border-[#785A42]/30 rounded px-3 py-2 text-xs font-mono text-[#785A42] focus:ring-1 focus:ring-[#785A42] outline-none"
                               />
                            </div>

                            <div className="mt-4 pt-4 border-t border-[#785A42]/10">
                                <div className="flex items-center justify-between mb-2">
                                    <label className="text-[10px] font-bold opacity-70 flex items-center gap-1">
                                        <Globe size={10} /> API ENDPOINT
                                    </label>
                                    <div className="flex items-center gap-1.5 cursor-pointer" onClick={() => updateConfig('useVisionCustomEndpoint', !(config.useVisionCustomEndpoint ?? config.useCustomEndpoint))}>
                                        <div className={`w-3 h-3 border rounded-sm flex items-center justify-center transition-colors ${(config.useVisionCustomEndpoint ?? config.useCustomEndpoint) ? 'bg-[#785A42] border-[#785A42]' : 'border-[#785A42]/50'}`}>
                                            {(config.useVisionCustomEndpoint ?? config.useCustomEndpoint) && <CheckCircle size={10} className="text-[#f9f7f2]" />}
                                        </div>
                                        <span className="text-[10px] font-mono">{t.useCustomEndpoint}</span>
                                    </div>
                                </div>
                                
                                {(config.useVisionCustomEndpoint ?? config.useCustomEndpoint) ? (
                                    <div className="space-y-2 animate-in slide-in-from-top-1">
                                        <input 
                                            type="text" 
                                            value={config.visionCustomEndpoint ?? config.customEndpoint ?? ''}
                                            onChange={(e) => updateConfig('visionCustomEndpoint', e.target.value)}
                                            placeholder={t.customEndpointPlaceholder}
                                            className="w-full bg-white border border-[#785A42]/30 rounded px-3 py-2 text-xs font-mono text-[#785A42] focus:ring-1 focus:ring-[#785A42] outline-none"
                                        />
                                    </div>
                                ) : (
                                    <div className="text-[10px] font-mono opacity-50 italic pl-1 bg-[#785A42]/5 p-2 rounded">
                                        {t.useCustomEndpointDesc}
                                    </div>
                                )}
                            </div>

                            <ModelCard 
                                title={t.visionModelLabel}
                                slotKey="model_vision" 
                                icon={Globe} 
                                desc={""}
                                defaultModel={getDefaultVisionModel(config.visionProvider || config.provider)}
                                validationResult={modelValidationResult.vision}
                                value={config.model_vision as string || ''}
                                onChange={(val) => updateConfig('model_vision', val)}
                                onReset={() => updateConfig('model_vision', getDefaultVisionModel(config.visionProvider || config.provider))}
                                t={t}
                            />
                        </div>
                    )}
                </div>
                )}
            </div>

        </div>

        {status && (
            <div className={`flex items-center justify-center gap-2 text-xs font-bold font-mono mb-3 ${
                statusType === 'error' ? 'text-red-600' : 
                statusType === 'success' ? 'text-green-700' : 'text-[#785A42]'
            }`}>
                {statusType === 'error' && <AlertTriangle size={14} />}
                {statusType === 'success' && <Check size={14} />}
                {status}
            </div>
        )}

        {/* SEARCH GROUNDING VALIDATION RESULT UI */}
        {searchStatus && (
            <div className={`flex items-center justify-center gap-2 text-xs font-bold font-mono mb-3 animate-in fade-in ${
                searchStatusType === 'error' ? 'text-red-600' : 
                searchStatusType === 'success' ? 'text-green-700' : 'text-[#785A42]'
            }`}>
                {searchStatusType === 'error' && <AlertTriangle size={14} />}
                {searchStatusType === 'success' && <Globe size={14} />}
                {searchStatus}
            </div>
        )}

        {statusType === 'success' && (
            <div className="flex flex-col gap-2 mb-3 animate-in fade-in">
                {(modelValidationResult.main === false || modelValidationResult.summary === false || modelValidationResult.vision === false) && (
                    <p className="text-xs text-red-600 font-mono text-center">{t.modelValidationWarning}</p>
                )}
            </div>
        )}

        {/* Action Buttons Row 1 - STACKED FOR SAFETY */}
        <div className="flex flex-col gap-3 mb-3">
            <button 
                onClick={handleValidateAll}
                disabled={isValidating || isSearchValidating || isModelValidating}
                className={`w-full py-3 border-2 border-[#785A42]/20 text-[#785A42] hover:bg-[#785A42]/10 font-bold tracking-wider text-xs rounded-sm transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2`}
            >
                {(isValidating || isSearchValidating || isModelValidating) ? <RefreshCw className="animate-spin" size={14} /> : <ShieldCheck size={14} />}
                <span>{language === 'zh' ? '全面验证配置 (VALIDATE ALL)' : 'VALIDATE ALL CONFIGURATIONS'}</span>
            </button>
        </div>

        {/* Action Buttons Row 2 */}
        <div className="flex gap-3 mb-6 md:mb-0">
            <button 
                onClick={handleSaveOnly}
                disabled={isValidating || isSearchValidating}
                className={`flex-[0.5] py-3 border border-[#785A42]/30 text-[#785A42] hover:bg-[#785A42]/5 font-bold tracking-wider text-xs rounded-sm transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2`}
            >
                <Save size={14} />
                <span className="hidden md:inline">{t.saveConfig}</span>
            </button>

            <button 
                onClick={handleSaveAndLaunch}
                disabled={isValidating || isModelValidating || isSearchValidating}
                className={`flex-[1.5] py-3 bg-[#785A42] hover:bg-[#8c6045] text-[#f9f7f2] font-bold tracking-[0.1em] text-xs rounded-sm transition-all shadow-lg active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2`}
            >
                <Power size={14} />
                <span>{t.launchSystem}</span>
            </button>
        </div>

      </div>
    </div>
  );
};
