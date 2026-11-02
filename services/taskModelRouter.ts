import type { AIConfig } from '../types';
import { getDefaultMainModel } from './appConfig';
import { resolveModelSessionCredential } from './roleProfiles';

export type TaskModelRole =
  | 'subject'
  | 'understanding'
  | 'memory'
  | 'verification'
  | 'diary'
  | 'recall'
  | 'translation';

export type ConfigurableModelRole = TaskModelRole | 'vision';
export const configurableModelRoles: ConfigurableModelRole[] = ['subject', 'understanding', 'memory', 'verification', 'diary', 'recall', 'translation', 'vision'];

/** Equality material stays in memory and is never logged or persisted. */
export const roleConfigurationIdentity = (config: AIConfig, role: ConfigurableModelRole): string => {
  const binding = config.modelRoleBindings?.[role];
  const profile = binding?.profileId ? config.modelConnections?.find(item => item.id === binding.profileId) : undefined;
  if (binding?.profileId) return JSON.stringify([binding, profile]);
  const model = role === 'vision' ? config.model_vision : resolveTaskModel(config, role);
  return JSON.stringify([config.provider, config.useCustomEndpoint, config.customEndpoint, config.apiKey_primary,
    config.apiKey_backup, config.activeKey, binding?.model, model,
    ...(role === 'vision' ? [config.visionProvider, config.useVisionCustomEndpoint, config.visionCustomEndpoint, config.visionApiKey] : [])]);
};

export const roleConnectionFingerprint = (resolved: ReturnType<typeof resolveRoleConnection>, includeVision = false): string => {
  const { config, model, revision } = resolved;
  return JSON.stringify([config.provider, config.useCustomEndpoint, config.customEndpoint,
    config.apiKey_primary, config.apiKey_backup, config.activeKey, model, revision,
    ...(includeVision ? [config.visionProvider, config.useVisionCustomEndpoint, config.visionCustomEndpoint, config.visionApiKey, config.model_vision] : [])]);
};

/** Resolve one immutable request target. A connection never inherits another
 * connection's credential; native credential references remain opaque. */
export const resolveRoleConnection = (config: AIConfig, role: ConfigurableModelRole): { config: AIConfig; model: string; revision: string } => {
  const binding = config.modelRoleBindings?.[role];
  const profile = binding?.profileId
    ? config.modelConnections?.find(item => item.id === binding.profileId)
    : undefined;
  if (binding?.profileId && !profile) throw new Error('Configured model connection is unavailable.');
  const inheritedModel = role === 'vision' ? (config.model_vision || resolveTaskModel(config, 'subject')) : resolveTaskModel(config, role);
  if (!profile) return { config: { ...config }, model: binding?.model?.trim() || inheritedModel, revision: config.modelConfigRevisions?.[role] || `legacy:${binding?.revision || 0}` };
  if (!binding?.model?.trim()) throw new Error('Choose a model for the selected connection.');
  const refs = [profile.credentialRefs?.primary || '', profile.credentialRefs?.backup || ''];
  if (refs.some(key => key && !key.startsWith('vault:') && !key.startsWith('session:'))) throw new Error('Model connection credentials must be protected references.');
  const [primary, backup] = refs.map(key => resolveModelSessionCredential(key, profile.provider, profile.baseUrl));
  const selected = profile.activeKey === 'backup' ? backup : primary;
  if (!selected) throw new Error('Model connection has no active credential.');
  const resolved: AIConfig = {
    ...config,
    provider: profile.provider,
    useCustomEndpoint: !!profile.baseUrl?.trim(),
    customEndpoint: profile.baseUrl?.trim() || undefined,
    apiKey_primary: primary,
    apiKey_backup: backup,
    activeKey: profile.activeKey,
  };
  return { config: resolved, model: binding?.model?.trim() || inheritedModel, revision: config.modelConfigRevisions?.[role] || `${profile.id}:${profile.revision}:${binding?.revision || 0}` };
};

// Resolve only the model name. Provider, endpoint, credentials and retry policy
// remain with the caller; a background task is not automatically a cheap task.
export const resolveTaskModel = (config: AIConfig, role: TaskModelRole): string => {
  const mainModel = config.model_main?.trim() || getDefaultMainModel(config.provider);
  switch (role) {
    case 'memory':
    case 'diary':
      return config.model_summary?.trim() || mainModel;
    case 'translation':
      return config.model_translator?.trim() || mainModel;
    case 'subject':
    case 'understanding':
    case 'verification':
    case 'recall':
      return mainModel;
  }
};
