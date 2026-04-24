
import { GoogleGenAI } from "@google/genai";
import { AIConfig } from "../types";
import { callOpenAI, callAnthropic } from "./llmProviderService";
import { DEFAULT_AI_CONFIG, normalizeAIConfig, resolveTransportProvider } from "./appConfig";
import { queueLocalStoragePreferenceSync } from './preferencesSync';
// F2B.3: dropped `isCapacitorStandalone` import + the dynamic
// `import('./httpApi')` mobile-PWA branch below. Capacitor is now always
// standalone (PWA gone), and `httpApi.ts` is being deleted.

// Helper: Get Current AI Config from LocalStorage or Defaults
export const getCurrentAIConfig = (): AIConfig => {
    try {
        const saved = localStorage.getItem('kumiko_ai_config');
        if (saved) {
            return normalizeAIConfig(JSON.parse(saved));
        }
    } catch (e) {
        console.warn("Failed to load AI Config, using defaults", e);
    }
    return DEFAULT_AI_CONFIG;
};

// F2B.3: simplified the write-side entry for kumiko_ai_config.
//
// - Desktop Electron: writes localStorage and (best-effort) emits a
//   `mobile-event-broadcast` of `ai-config:changed`. The broadcast is
//   now historical — there are no connected phones to receive it — but
//   we keep the IPC ping so any in-process listener (e.g. an Electron
//   plugin using ipcRenderer) stays informed.
// - Capacitor Android: localStorage write is the source of truth; no
//   remote dispatch.
//
// Everything that used to call `httpInvoke('ai-config:update-from-mobile', cfg)`
// is dead — the PC HTTP bridge / WebSocket fan-out (Phase 6 Part B) was
// removed in F2B.3, and the receiving renderer (useMobileApiProxy) was
// removed in F2B.2.
export const setAIConfig = async (
    cfg: AIConfig,
): Promise<{ ok: boolean; error?: string }> => {
    try {
        // `applyToStore: false` — kumiko_ai_config is consumed via direct
        // localStorage reads (`getCurrentAIConfig()`), not a Zustand slice,
        // so the prefs runtime apply has nothing useful to do here.
        // `broadcast: false` — the legacy `ai-config:changed` mobile fan-out
        // is gone (F2B.2); queueing a generic preferences broadcast here
        // would do nothing useful and just spam the IPC channel.
        queueLocalStoragePreferenceSync('kumiko_ai_config', JSON.stringify(cfg), {
            propagateToDesktop: false,
            applyToStore: false,
            broadcast: false,
        });
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
    const anyWindow = typeof window !== 'undefined' ? (window as unknown as {
        electronAPI?: { send?: (c: string, p: unknown) => void };
        __KUMIKO_ENV__?: { runtime?: string };
    }) : null;
    const runtime = anyWindow?.__KUMIKO_ENV__?.runtime;
    if (runtime === 'electron') {
        try {
            anyWindow?.electronAPI?.send?.('mobile-event-broadcast', { type: 'ai-config:changed' });
        } catch (e) {
            console.warn('[setAIConfig] desktop broadcast failed:', e);
        }
    }
    return { ok: true };
};

// Helper to get a fresh client instance every time to handle dynamic API keys
export const getGenAI = (overrideKey?: string): GoogleGenAI => {
  const config = getCurrentAIConfig();
  
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
  
  const options: any = { apiKey };
  if (config.useCustomEndpoint && config.customEndpoint) {
      options.httpOptions = { baseUrl: config.customEndpoint.trim().replace(/\/v1beta\/?$/, '').replace(/\/v1alpha\/?$/, '').replace(/\/v1\/?$/, '').replace(/\/$/, '') };
  }
  
  return new GoogleGenAI(options);
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
): Promise<string> => {
  const config = getCurrentAIConfig();
  const provider = config.provider || 'gemini';
  const transportProvider = resolveTransportProvider(
    provider,
    config.useCustomEndpoint ? config.customEndpoint : undefined
  );
  const model = modelOverride || config.model_main || 'gemini-3.1-pro-preview';

  let text = '';
  const maxRetries = 2;
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      if (transportProvider === 'openai' || transportProvider === 'deepseek' || transportProvider === 'grok' || transportProvider === 'openrouter') {
        const result = await callOpenAI(config, model, systemPrompt, [], userPrompt);
        text = result.text || '';
      } else if (transportProvider === 'anthropic') {
        const result = await callAnthropic(config, model, systemPrompt, [], userPrompt);
        text = result.text || '';
      } else {
        const ai = getGenAI();
        const result = await ai.models.generateContent({
          model,
          contents: userPrompt,
          config: {
            systemInstruction: systemPrompt,
            temperature: 0.7,
          },
        });
        text = result.text || '';
      }
      break; // Success, exit retry loop
    } catch (error) {
      attempt++;
      console.warn(`[callLLMRaw] Attempt ${attempt} failed:`, error);
      if (attempt > maxRetries) {
        throw error;
      }
      // Wait for 1.5 seconds before retrying
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }

  return text.trim();
};
