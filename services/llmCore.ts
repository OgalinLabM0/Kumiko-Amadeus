
import { GoogleGenAI } from "@google/genai";
import { AIConfig } from "../types";
import { callOpenAI, callAnthropic } from "./llmProviderService";
import { DEFAULT_AI_CONFIG, normalizeAIConfig, resolveTransportProvider, getDefaultEndpoint } from "./appConfig";
import { queueLocalStoragePreferenceSync } from './preferencesSync';
import { assertDataWritesAllowed, getDataRestoreVersion, subscribeDataRestore } from './dataRestoreGate';
import { hasNativeCredentials, invokeCredential } from './nativeCredentials';
import { beginForegroundActivity, endForegroundActivity, MODEL_REVISIONS_KEY, TaskCapacityError, type TaskContext } from './taskRuntime';
import { db } from './db';
import { getMemoryGeneration } from './memoryMaintenanceGate';
import { runTaskTransport } from './taskGateway';
import { configurableModelRoles, resolveRoleConnection, roleConfigurationIdentity, roleConnectionFingerprint, type ConfigurableModelRole } from './taskModelRouter';
import { clearModelSessionCredentials } from './roleProfiles';

const vaultPrefix = 'vault:';
let browserSessionKeys: Pick<AIConfig, 'apiKey_primary' | 'apiKey_backup' | 'visionApiKey'> | null = null;
export function clearBrowserModelCredentials(): void { browserSessionKeys = null; clearModelSessionCredentials(); }
export const geminiEndpoint = (cfg: AIConfig) => cfg.useCustomEndpoint && cfg.customEndpoint
  ? cfg.customEndpoint.trim().replace(/\/v1beta\/?$/, '').replace(/\/v1alpha\/?$/, '').replace(/\/v1\/?$/, '').replace(/\/$/, '') + '/'
  : 'https://generativelanguage.googleapis.com/';
export function createSessionGemini(config: AIConfig, apiKey: string): GoogleGenAI {
  if (apiKey.startsWith(vaultPrefix)) throw new Error('Protected credential is unavailable on this device.');
  const destination = new URL(geminiEndpoint(config));
  if (destination.protocol !== 'https:' || destination.username || destination.password
    || Array.from(destination.searchParams.keys()).some(key => /key|token|secret|authorization/i.test(key))) throw new Error('Invalid credential endpoint.');
  const ai = new GoogleGenAI({ apiKey, httpOptions: { baseUrl: destination.href, retryOptions: { attempts: 1 } } });
  const client = (ai as any).apiClient;
  if (!client || typeof client.apiCall !== 'function') throw new Error('Secure Gemini transport is unavailable.');
  client.apiCall = async (raw: string, options: RequestInit) => {
    const target = new URL(raw), prefix = destination.pathname.endsWith('/') ? destination.pathname : destination.pathname + '/';
    if (target.origin !== destination.origin || !(target.pathname === destination.pathname || target.pathname.startsWith(prefix))
      || target.username || target.password || target.hash || Array.from(target.searchParams.keys()).some(key => /key|token|secret|authorization/i.test(key))) throw new Error('Gemini request endpoint does not match credential binding.');
    return fetch(target.href, { ...options, redirect: 'error', signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
  };
  return ai;
}
const credentialPurpose = (cfg: AIConfig): 'gemini' | 'anthropic' | 'openai' => {
  const transport = resolveTransportProvider(cfg.provider, cfg.useCustomEndpoint ? cfg.customEndpoint : undefined);
  return transport === 'gemini' ? 'gemini' : transport === 'anthropic' ? 'anthropic' : 'openai';
};
const credentialEndpoint = (cfg: AIConfig) => credentialPurpose(cfg) === 'gemini' ? geminiEndpoint(cfg)
  : (cfg.useCustomEndpoint && cfg.customEndpoint ? cfg.customEndpoint.trim().replace(/\/$/, '') : getDefaultEndpoint(cfg.provider));
const visionConfig = (cfg: AIConfig): AIConfig => ({ ...cfg, provider: cfg.visionProvider || cfg.provider,
  useCustomEndpoint: cfg.useVisionCustomEndpoint ?? cfg.useCustomEndpoint,
  customEndpoint: cfg.visionCustomEndpoint ?? cfg.customEndpoint });
export async function protectedGeminiGenerate(key: string, endpoint: string, input: any): Promise<any> {
  if (!key.startsWith(vaultPrefix)) throw new Error('Save the Gemini API key securely first.');
  const signal: AbortSignal | undefined = input.config?.abortSignal;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const { abortSignal: _signal, ...config } = input.config || {};
  const reply = await invokeCredential('gemini', { handle: key.slice(vaultPrefix.length), expectedEndpoint: endpoint, params: { ...input, config } }, signal);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!reply?.success) throw new Error(reply?.error || 'Protected Gemini request failed.');
  return reply.result;
}
// F2B.3: dropped `isCapacitorStandalone` import + the dynamic
// `import('./httpApi')` mobile-PWA branch below. Capacitor is now always
// standalone (PWA gone), and `httpApi.ts` is being deleted.

// Helper: Get Current AI Config from LocalStorage or Defaults
export const getCurrentAIConfig = (): AIConfig => {
    try {
        const saved = localStorage.getItem('kumiko_ai_config');
        if (saved) {
            const normalized = normalizeAIConfig(JSON.parse(saved));
            return browserSessionKeys && !hasNativeCredentials() ? { ...normalized, ...browserSessionKeys } : normalized;
        }
    } catch (e) {
        console.warn("Failed to load AI Config, using defaults", e);
    }
    return browserSessionKeys && !hasNativeCredentials() ? { ...DEFAULT_AI_CONFIG, ...browserSessionKeys } : DEFAULT_AI_CONFIG;
};

export async function getSecureTaskAIConfig(role: ConfigurableModelRole): Promise<AIConfig> {
  let config = getCurrentAIConfig();
  if (hasNativeCredentials() && !config.modelRoleBindings?.[role]?.profileId) {
    const key = config.activeKey === 'backup' ? config.apiKey_backup : config.apiKey_primary;
    if (key && !key.startsWith(vaultPrefix)) {
      const saved = await setAIConfig(config, localStorage.getItem('kumiko_ai_config'));
      if (!saved.ok) throw new Error(saved.error || 'Secure credential migration failed.');
      config = getCurrentAIConfig();
    }
  }
  return config;
}

// F2B.3: simplified the write-side entry for kumiko_ai_config.
//
// v2.14.28 M1: removed the dead `mobile-event-broadcast` IPC ping. The
// preload allowlist dropped that channel in F2B.4 (preload.cjs:103),
// so the call was a silent no-op — the only effect was log noise when
// debugging "why isn't preferences sync firing on the desktop". The
// useful surface is already covered by `queueLocalStoragePreferenceSync`,
// which is the one path the renderer reads back from on next mount.
//
// - Both runtimes: localStorage write through the shared queue; in-
//   process consumers read the value directly via `getCurrentAIConfig`
//   on demand.
//
// Everything that used to call `httpInvoke('ai-config:update-from-mobile', cfg)`
// is dead — the PC HTTP bridge / WebSocket fan-out (Phase 6 Part B) was
// removed in F2B.3, and the receiving renderer (useMobileApiProxy) was
// removed in F2B.2.
export const setAIConfig = async (
    cfg: AIConfig,
    expectedStored?: string | null,
): Promise<{ ok: boolean; error?: string }> => {
    try {
        assertDataWritesAllowed();
        const generation = getDataRestoreVersion();
        const startingStored = localStorage.getItem('kumiko_ai_config');
        // Advanced connections may contain opaque references only. Never let a
        // settings form persist an accidentally supplied plaintext key here.
        for (const profile of cfg.modelConnections || []) {
            for (const key of [profile.credentialRefs?.primary, profile.credentialRefs?.backup]) {
                if (key && !key.startsWith(vaultPrefix) && !(key.startsWith('session:') && !hasNativeCredentials())) throw new Error('Save advanced connection credentials securely before assigning them.');
            }
        }
        const previousConfig = getCurrentAIConfig();
        const profileBindings = (source: AIConfig) => (source.modelConnections || []).map(profile => ({
          config: { ...source, provider: profile.provider, useCustomEndpoint: !!profile.baseUrl, customEndpoint: profile.baseUrl },
          keys: [profile.credentialRefs?.primary, profile.credentialRefs?.backup],
        }));
        const oldBindings = [
            { config: previousConfig, keys: [previousConfig.apiKey_primary, previousConfig.apiKey_backup] },
            { config: visionConfig(previousConfig), keys: [previousConfig.visionApiKey] },
            ...profileBindings(previousConfig),
        ];
        // Legacy plaintext keys are already entrusted to their old service.
        // First migration must not silently rebind them when the settings form
        // changes a provider/address, including moves between key slots.
        for (const next of [
            { config: cfg, keys: [cfg.apiKey_primary, cfg.apiKey_backup] },
            { config: visionConfig(cfg), keys: [cfg.visionApiKey] },
            ...profileBindings(cfg),
        ]) {
            for (const old of oldBindings) {
                if (!next.keys.some(key => key && old.keys.includes(key))) continue;
                if (credentialPurpose(old.config) !== credentialPurpose(next.config)
                    || credentialEndpoint(old.config) !== credentialEndpoint(next.config)) {
                    throw new Error('Endpoint changed. Enter a replacement API key for the new endpoint; existing credentials are preserved.');
                }
            }
        }
        const stored = { ...cfg };
        stored.modelConfigRevisions = { ...previousConfig.modelConfigRevisions };
        for (const role of configurableModelRoles) {
          if (!stored.modelConfigRevisions[role] || roleConfigurationIdentity(previousConfig, role) !== roleConfigurationIdentity(cfg, role)) {
            stored.modelConfigRevisions[role] = crypto.randomUUID();
          }
        }
        let pendingBrowserKeys: typeof browserSessionKeys = null;
        if (!hasNativeCredentials()) {
            let previous: Partial<AIConfig> = {};
            const rawPrevious = localStorage.getItem('kumiko_ai_config');
            try { previous = JSON.parse(rawPrevious || '{}'); } catch { throw new Error('Existing AI configuration cannot be safely preserved.'); }
            if (browserSessionKeys && (previous.provider !== cfg.provider || !!previous.useCustomEndpoint !== !!cfg.useCustomEndpoint
              || (cfg.useCustomEndpoint && previous.customEndpoint !== cfg.customEndpoint))
              && ((browserSessionKeys.apiKey_primary && browserSessionKeys.apiKey_primary === cfg.apiKey_primary)
                || (browserSessionKeys.apiKey_backup && browserSessionKeys.apiKey_backup === cfg.apiKey_backup))) {
                throw new Error('Endpoint changed. Enter replacement API keys for the new endpoint.');
            }
            if (browserSessionKeys?.visionApiKey && browserSessionKeys.visionApiKey === cfg.visionApiKey
              && (previous.visionProvider !== cfg.visionProvider || !!previous.useVisionCustomEndpoint !== !!cfg.useVisionCustomEndpoint
                || previous.visionCustomEndpoint !== cfg.visionCustomEndpoint)) {
                throw new Error('Vision endpoint changed. Enter a replacement vision API key.');
            }
            if (rawPrevious && (previous.apiKey_primary || previous.apiKey_backup || previous.visionApiKey || (previous as any).apiKey)) {
                const archiveKey = 'kumiko_legacy_ai_config_' + crypto.randomUUID();
                localStorage.setItem(archiveKey, rawPrevious);
                if (localStorage.getItem(archiveKey) !== rawPrevious) throw new Error('Existing credentials could not be preserved.');
            }
            pendingBrowserKeys = { apiKey_primary: cfg.apiKey_primary, apiKey_backup: cfg.apiKey_backup, visionApiKey: cfg.visionApiKey };
            stored.apiKey_primary = '';
            stored.apiKey_backup = '';
            stored.visionApiKey = '';
            delete (stored as any).apiKey;
        }
        if (hasNativeCredentials()) {
            const previous = previousConfig;
            if ((credentialEndpoint(previous) !== credentialEndpoint(cfg) || credentialPurpose(previous) !== credentialPurpose(cfg))
              && (['apiKey_primary', 'apiKey_backup'] as const).some(field => stored[field]?.startsWith(vaultPrefix))) {
                throw new Error('Endpoint changed. Enter replacement API keys to bind them to the new endpoint.');
            }
            for (const field of ['apiKey_primary', 'apiKey_backup'] as const) {
                const secret = stored[field];
                if (!secret || secret.startsWith(vaultPrefix)) continue;
                const result = await invokeCredential('store', { purpose: credentialPurpose(cfg), endpoint: credentialEndpoint(cfg), secret });
                if (!result?.success || typeof result.handle !== 'string') throw new Error(result?.error || 'Secure credential storage failed.');
                stored[field] = vaultPrefix + result.handle;
            }
            const vision = visionConfig(cfg), oldVision = visionConfig(previous);
            if (stored.visionApiKey?.startsWith(vaultPrefix)
              && (credentialEndpoint(vision) !== credentialEndpoint(oldVision) || credentialPurpose(vision) !== credentialPurpose(oldVision))) {
                throw new Error('Vision endpoint changed. Enter a replacement vision API key.');
            }
            if (stored.visionApiKey && !stored.visionApiKey.startsWith(vaultPrefix)) {
                const result = await invokeCredential('store', { purpose: credentialPurpose(vision), endpoint: credentialEndpoint(vision), secret: stored.visionApiKey });
                if (!result?.success || typeof result.handle !== 'string') throw new Error(result?.error || 'Secure vision credential storage failed.');
                stored.visionApiKey = vaultPrefix + result.handle;
            }
        }
        assertDataWritesAllowed();
        if (generation !== getDataRestoreVersion()) throw new Error('Data changed while saving credentials.');
        if (localStorage.getItem('kumiko_ai_config') !== (expectedStored !== undefined ? expectedStored : startingStored)) throw new Error('AI settings changed while saving credentials.');
        // `applyToStore: false` — kumiko_ai_config is consumed via direct
        // localStorage reads (`getCurrentAIConfig()`), not a Zustand slice,
        // so the prefs runtime apply has nothing useful to do here.
        // `broadcast: false` — the legacy `ai-config:changed` mobile fan-out
        // is gone (F2B.2); queueing a generic preferences broadcast here
        // would do nothing useful and just spam the IPC channel.
        const nextRaw = JSON.stringify(stored);
        try {
          await db.transaction('rw', db.keyval, async () => {
            if (localStorage.getItem('kumiko_ai_config') !== (expectedStored !== undefined ? expectedStored : startingStored)) throw new Error('AI settings changed while saving credentials.');
            await db.keyval.put({ key: MODEL_REVISIONS_KEY, value: stored.modelConfigRevisions });
            queueLocalStoragePreferenceSync('kumiko_ai_config', nextRaw, { propagateToDesktop: false, applyToStore: false, broadcast: false });
            const rawWritten = localStorage.getItem('kumiko_ai_config');
            if (!rawWritten || JSON.stringify(normalizeAIConfig(JSON.parse(rawWritten))) !== JSON.stringify(normalizeAIConfig(stored))) throw new Error('AI configuration could not be verified after saving.');
          });
        } catch (error) {
          if (localStorage.getItem('kumiko_ai_config') === nextRaw) {
            if (startingStored === null) localStorage.removeItem('kumiko_ai_config');
            else localStorage.setItem('kumiko_ai_config', startingStored);
          }
          throw error;
        }
        if (pendingBrowserKeys) browserSessionKeys = pendingBrowserKeys;
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new Event('kumiko:model-config-changed'));
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
    return { ok: true };
};

// Helper to get a fresh client instance every time to handle dynamic API keys
export const getGenAI = (overrideKey?: string, frozenConfig?: AIConfig): GoogleGenAI => {
  const config = frozenConfig || getCurrentAIConfig();
  if (hasNativeCredentials() && !overrideKey) {
    if (!(config.activeKey === 'backup' ? config.apiKey_backup : config.apiKey_primary)) throw new Error('API_KEY is missing');
    const generateContent = async (input: any) => {
      let current = frozenConfig || getCurrentAIConfig();
      let key = current.activeKey === 'backup' ? current.apiKey_backup : current.apiKey_primary;
      if (!key) throw new Error('API_KEY is missing');
      if (!key.startsWith(vaultPrefix)) {
        if (frozenConfig) throw new Error('Save the API key securely before starting this task.');
        const before = localStorage.getItem('kumiko_ai_config');
        const saved = await setAIConfig(current, before);
        if (!saved.ok) throw new Error(saved.error || 'Secure credential migration failed.');
        current = getCurrentAIConfig();
        key = current.activeKey === 'backup' ? current.apiKey_backup : current.apiKey_primary;
        if (!key?.startsWith(vaultPrefix)) throw new Error('Secure credential migration failed.');
      }
      return protectedGeminiGenerate(key, geminiEndpoint(current), input);
    };
    return { models: { generateContent }, chats: { create({ model, history = [], config: chatConfig }: any) {
      const turns = [...history];
      return { async sendMessage({ message, config: callConfig }: any) {
        const parts = typeof message === 'string' ? [{ text: message }] : Array.isArray(message) ? message : [message];
        const user = { role: 'user', parts };
        const result = await generateContent({ model, contents: [...turns, user], config: callConfig || chatConfig });
        turns.push(user);
        if (result.candidates?.[0]?.content) turns.push(result.candidates[0].content);
        return result;
      } };
    } } } as unknown as GoogleGenAI;
  }
  
  let apiKey = "";
  let source = "UNKNOWN";

  if (overrideKey) {
      apiKey = overrideKey;
      source = "OVERRIDE";
  } else {
      const keyToUse = config.activeKey === 'backup' ? config.apiKey_backup : config.apiKey_primary;
      if (keyToUse && keyToUse.trim() !== "") {
          apiKey = keyToUse.trim();
          source = `CUSTOM_${config.activeKey.toUpperCase()}`;
      }
  }

  // P1 #35: previously we logged the last 4 characters of the API key here as
  // "forensic logging". That combined with the provider name was enough to
  // substantially narrow down a specific key during screen-share or bug reports,
  // which several users actually do. The source alone is plenty for debugging.
  console.log(`[Gemini Init] Source: ${source} | Key: ${apiKey ? 'present' : 'MISSING'}`);

  if (!apiKey) {
    console.error("API_KEY is missing. Please configure it in the Neural Configuration screen.");
    throw new Error("API_KEY is missing");
  }
  return createSessionGemini(config, apiKey);
};

export const startChat = async () => {
  try {
      const config = getCurrentAIConfig();
      const transportProvider = resolveTransportProvider(
          config.provider,
          config.useCustomEndpoint ? config.customEndpoint : undefined
      );

      if (transportProvider === 'gemini') {
          getGenAI();
      }

      return true;
  } catch(e) {
      throw new Error("Gemini Client initialization failed: " + e);
  }
};

/**
 * Lightweight LLM call that bypasses the full Kumiko conversation pipeline.
 * No textParts splitting, no persona injection. Performs up to 2 retries on
 * transient errors (1.5s backoff between attempts). Used for translation,
 * summarization and other utility tasks where raw text output is needed.
 */
export const callLLMRaw = async (
  systemPrompt: string,
  userPrompt: string,
  modelOverride?: string,
  options: { signal?: AbortSignal; maxRetries?: number; timeoutMs?: number; taskContext?: TaskContext; role?: ConfigurableModelRole } = {},
): Promise<string> => {
  assertDataWritesAllowed();
  const restoreVersion = getDataRestoreVersion();
  const role = options.role || 'subject';
  const baseConfig = await getSecureTaskAIConfig(role);
  const resolved = resolveRoleConnection(baseConfig, role);
  const config = resolved.config;
  const provider = config.provider || 'gemini';
  const transportProvider = resolveTransportProvider(
    provider,
    config.useCustomEndpoint ? config.customEndpoint : undefined
  );
  const model = modelOverride || resolved.model;

  let text = '';
  const maxRetries = Math.max(0, Math.min(1, options.maxRetries ?? 1));
  let attempt = 0;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const unsubscribeRestore = subscribeDataRestore(() => {
    if (getDataRestoreVersion() !== restoreVersion) abort();
  });
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = options.timeoutMs === undefined ? undefined : setTimeout(abort, options.timeoutMs);
  const bounded = <T>(work: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('Model task cancelled or timed out'));
    if (controller.signal.aborted) { onAbort(); return; }
    controller.signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(work).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', onAbort));
  });

  let taskContext = options.taskContext;
  let ownsContext = false;
  try {
  if (!taskContext) {
    const id = crypto.randomUUID();
    taskContext = { taskId: id, rootId: id, role, lane: 'foreground', deadlineAt: Date.now() + Math.min(options.timeoutMs ?? 180_000, 180_000),
      signal: controller.signal, epoch: restoreVersion, memoryGeneration: getMemoryGeneration(), modelRevisions: {}, consultedSources: [] };
    await beginForegroundActivity(taskContext);
    ownsContext = true;
  }
  while (attempt <= maxRetries) {
    try {
      const execute = async (requestSignal: AbortSignal) => {
      if (transportProvider !== 'gemini' && transportProvider !== 'anthropic') {
        const result = await bounded(() => callOpenAI(config, model, systemPrompt, [], userPrompt, undefined, { rounds: [], signal: requestSignal }));
        text = result.text || '';
      } else if (transportProvider === 'anthropic') {
        const result = await bounded(() => callAnthropic(config, model, systemPrompt, [], userPrompt, undefined, { rounds: [], signal: requestSignal }));
        text = result.text || '';
      } else {
        const ai = getGenAI(undefined, config);
        const result = await bounded(() => ai.models.generateContent({
          model,
          contents: userPrompt,
          config: {
            systemInstruction: systemPrompt,
            temperature: 0.7,
            abortSignal: requestSignal,
          },
        }));
        text = result.text || '';
      }
      };
      if (taskContext) {
        taskContext.modelRevisions ||= {};
        const signature = roleConnectionFingerprint(resolved);
        await runTaskTransport({ ...taskContext, role, signal: controller.signal }, {
          provider: config.provider || 'gemini', model, operation: 'text',
          connectionId: baseConfig.modelRoleBindings?.[role]?.profileId, configRevision: resolved.revision,
        }, execute, () => {
          if (roleConnectionFingerprint(resolveRoleConnection(getCurrentAIConfig(), role)) !== signature) throw new Error('Model configuration changed during task.');
        });
      } else await execute(controller.signal);
      break; // Success, exit retry loop
    } catch (error) {
      if (controller.signal.aborted || error instanceof TaskCapacityError || String(error).includes('configuration changed')) throw error;
      if (!/\b(429|500|502|503|504)\b|network|fetch failed|load failed|timeout/i.test(String(error))) throw error;
      attempt++;
      console.warn(`[callLLMRaw] Attempt ${attempt} failed:`, error);
      if (attempt > maxRetries) {
        throw error;
      }
      // Wait for 1.5 seconds before retrying
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { controller.signal.removeEventListener('abort', cancel); resolve(); }, 1500);
        const cancel = () => { clearTimeout(timer); reject(new DOMException('Task cancelled', 'AbortError')); };
        controller.signal.addEventListener('abort', cancel, { once: true });
        if (controller.signal.aborted) cancel();
      });
    }
  }

  if (getDataRestoreVersion() !== restoreVersion) throw new Error('Data was restored while this model task was running.');
  return text.trim();
  } finally {
    if (ownsContext && taskContext) await endForegroundActivity(taskContext);
    if (timeout !== undefined) clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
    unsubscribeRestore();
  }
};
