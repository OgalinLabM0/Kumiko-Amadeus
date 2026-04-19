import { AIConfig, AIProvider, BackupConfig } from '../types';

type LegacyAIConfig = Partial<AIConfig> & {
  apiKey?: string;
};

type LegacyBackupConfig = Partial<BackupConfig>;

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  localEnabled: true,
  ragEnabled: false
};

export const DEFAULT_AI_CONFIG: AIConfig = {
  apiKey_primary: '',
  apiKey_backup: '',
  activeKey: 'primary',
  model_main: 'gemini-3.1-pro-preview',
  model_summary: 'gemini-2.5-flash',
  model_vision: 'gemini-2.5-flash',
  provider: 'gemini'
};

export const getDefaultEndpoint = (provider?: AIProvider): string => {
  switch (provider) {
    case 'openai': return 'https://api.openai.com/v1/chat/completions';
    case 'deepseek': return 'https://api.deepseek.com/chat/completions';
    case 'grok': return 'https://api.x.ai/v1/chat/completions';
    case 'openrouter': return 'https://openrouter.ai/api/v1/chat/completions';
    case 'volcengine': return 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
    case 'dashscope': return 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
    case 'zhipu': return 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
    case 'moonshot': return 'https://api.moonshot.cn/v1/chat/completions';
    case 'qianfan': return 'https://qianfan.baidubce.com/v2/chat/completions';
    case 'hunyuan': return 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions';
    case 'spark': return 'https://spark-api-open.xf-yun.com/v1/chat/completions';
    case 'minimax': return 'https://api.minimaxi.com/v1/chat/completions';
    case 'anthropic': return 'https://api.anthropic.com/v1/messages';
    default: return '';
  }
};

export const getDefaultMainModel = (provider?: AIProvider): string => {
  switch (provider) {
    case 'openai':
      return 'gpt-4o';
    case 'anthropic':
      return 'claude-3-7-sonnet-20250219';
    case 'deepseek':
      return 'deepseek-chat';
    case 'grok':
      return 'grok-2-latest';
    case 'openrouter':
      return 'anthropic/claude-3.7-sonnet';
    case 'volcengine':
      return 'ep-xxxx';
    case 'dashscope':
      return 'qwen-plus';
    case 'zhipu':
      return 'glm-4-plus';
    case 'moonshot':
      return 'moonshot-v1-auto';
    case 'qianfan':
      return 'ernie-4.0-8k';
    case 'hunyuan':
      return 'hunyuan-turbos-latest';
    case 'spark':
      return 'spark-x';
    case 'minimax':
      return 'MiniMax-M2.7';
    default:
      return DEFAULT_AI_CONFIG.model_main;
  }
};

export const getDefaultSummaryModel = (provider?: AIProvider): string => {
  switch (provider) {
    case 'openai':
      return 'gpt-4o-mini';
    case 'anthropic':
      return 'claude-3-5-haiku-20241022';
    case 'deepseek':
      return 'deepseek-chat';
    case 'grok':
      return 'grok-2-latest';
    case 'openrouter':
      return 'anthropic/claude-3.5-haiku';
    case 'volcengine':
      return 'ep-xxxx';
    case 'dashscope':
      return 'qwen-plus';
    case 'zhipu':
      return 'glm-4-flash';
    case 'moonshot':
      return 'moonshot-v1-auto';
    case 'qianfan':
      return 'ernie-speed-8k';
    case 'hunyuan':
      return 'hunyuan-lite';
    case 'spark':
      return 'spark-lite';
    case 'minimax':
      return 'MiniMax-M2.5';
    default:
      return DEFAULT_AI_CONFIG.model_summary;
  }
};

export const getDefaultVisionModel = (provider?: AIProvider): string => {
  switch (provider) {
    case 'openai':
      return 'gpt-4o';
    case 'anthropic':
      return 'claude-3-5-sonnet-20241022';
    case 'openrouter':
      return 'anthropic/claude-3.5-sonnet';
    default:
      return DEFAULT_AI_CONFIG.model_vision || 'gemini-2.5-flash';
  }
};

export const isOpenAICompatibleProvider = (
  provider?: AIProvider
): provider is 'openai' | 'deepseek' | 'grok' | 'openrouter' | 'volcengine' | 'dashscope' | 'zhipu' | 'moonshot' | 'qianfan' | 'hunyuan' | 'spark' | 'minimax' => {
  return provider === 'openai' || provider === 'deepseek' || provider === 'grok' || provider === 'openrouter'
    || provider === 'volcengine' || provider === 'dashscope' || provider === 'zhipu' || provider === 'moonshot'
    || provider === 'qianfan' || provider === 'hunyuan' || provider === 'spark' || provider === 'minimax';
};

export const detectEndpointTransport = (
  endpoint?: string
): 'openai' | 'anthropic' | null => {
  const normalized = (endpoint || '')
    .trim()
    .toLowerCase()
    .split('?')[0]
    .split('#')[0]
    .replace(/\/+$/, '');

  if (!normalized) {
    return null;
  }

  if (normalized.endsWith('/chat/completions')) {
    return 'openai';
  }

  if (normalized.endsWith('/messages')) {
    return 'anthropic';
  }

  return null;
};

export const resolveTransportProvider = (
  provider?: AIProvider,
  endpoint?: string
): AIProvider => {
  const detectedTransport = detectEndpointTransport(endpoint);

  if (detectedTransport === 'openai') {
    return 'openai';
  }

  if (detectedTransport === 'anthropic') {
    return 'anthropic';
  }

  return provider || 'gemini';
};

export const normalizeBackupConfig = (rawConfig?: LegacyBackupConfig | null): BackupConfig => {
  // Cloud-sync-related fields (cloudEnabled, endpointUrl, userId, apiKey) were removed
  // from BackupConfig when cloud sync was dropped from the product. We intentionally
  // ignore those keys if present in legacy Dexie data so user imports still work.
  const parsed: LegacyBackupConfig = rawConfig ? { ...rawConfig } : {};
  return {
    localEnabled: parsed.localEnabled !== false,
    ragEnabled: parsed.ragEnabled === true,
  };
};

export const normalizeAIConfig = (rawConfig?: LegacyAIConfig | null): AIConfig => {
  const parsed: LegacyAIConfig = rawConfig ? { ...rawConfig } : {};

  if (parsed.apiKey && !parsed.apiKey_primary) {
    parsed.apiKey_primary = parsed.apiKey;
  }

  delete parsed.apiKey;

  return {
    ...DEFAULT_AI_CONFIG,
    ...parsed
  };
};
