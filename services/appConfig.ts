import { AIConfig, AIProvider, BackupConfig } from '../types';

type LegacyAIConfig = Partial<AIConfig> & {
  apiKey?: string;
};

type LegacyBackupConfig = Partial<BackupConfig>;

export const CLOUD_SYNC_AVAILABLE = false;
const DEFAULT_CLOUD_USER_ID = 'default_user';

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  localEnabled: true,
  cloudEnabled: false,
  endpointUrl: '',
  userId: DEFAULT_CLOUD_USER_ID,
  apiKey: '',
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
): provider is 'openai' | 'deepseek' | 'grok' | 'openrouter' => {
  return provider === 'openai' || provider === 'deepseek' || provider === 'grok' || provider === 'openrouter';
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
  const parsed: LegacyBackupConfig = rawConfig ? { ...rawConfig } : {};
  const normalized: BackupConfig = {
    ...DEFAULT_BACKUP_CONFIG,
    ...parsed
  };

  normalized.localEnabled = normalized.localEnabled !== false;
  normalized.ragEnabled = normalized.ragEnabled === true;
  normalized.endpointUrl = (normalized.endpointUrl || '').trim();
  normalized.apiKey = (normalized.apiKey || '').trim();
  normalized.userId = (normalized.userId || DEFAULT_CLOUD_USER_ID).trim() || DEFAULT_CLOUD_USER_ID;

  if (!CLOUD_SYNC_AVAILABLE || !normalized.endpointUrl) {
    normalized.cloudEnabled = false;
  }

  if (!CLOUD_SYNC_AVAILABLE) {
    normalized.endpointUrl = '';
    normalized.apiKey = '';
    normalized.userId = DEFAULT_CLOUD_USER_ID;
  }

  return normalized;
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
