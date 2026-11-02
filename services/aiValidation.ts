
import { GoogleGenAI } from "@google/genai";
import { AIConfig } from "../types";
import { callOpenAI, callAnthropic } from "./llmProviderService";
import { getDefaultVisionModel, resolveTransportProvider } from "./appConfig";
import { createSessionGemini, geminiEndpoint, getCurrentAIConfig, protectedGeminiGenerate } from './llmCore';
import { hasNativeCredentials } from './nativeCredentials';
import { getDataRestoreVersion } from './dataRestoreGate';
import { getMemoryGeneration } from './memoryMaintenanceGate';
import { beginForegroundActivity, endForegroundActivity, type TaskContext } from './taskRuntime';
import { runTaskTransport } from './taskGateway';

async function validationRequest<T>(config: AIConfig, model: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const id = crypto.randomUUID();
    const context: TaskContext = { taskId: id, rootId: id, role: 'validation', lane: 'foreground', deadlineAt: Date.now() + 180_000,
      epoch: getDataRestoreVersion(), memoryGeneration: getMemoryGeneration(), modelRevisions: {} };
    const original = JSON.stringify(getCurrentAIConfig());
    await beginForegroundActivity(context);
    try {
      return await runTaskTransport(context, { provider: config.provider || 'gemini', model, operation: 'validation', configRevision: 'captured' }, work, () => {
        if (JSON.stringify(getCurrentAIConfig()) !== original) throw new Error('Model configuration changed during validation.');
      });
    } finally { await endForegroundActivity(context); }
}

function assertSavedBrowserBinding(config: AIConfig): void {
    if (hasNativeCredentials()) return;
    const saved = getCurrentAIConfig();
    if (saved.provider !== config.provider || !!saved.useCustomEndpoint !== !!config.useCustomEndpoint
      || (config.useCustomEndpoint && saved.customEndpoint !== config.customEndpoint)
      || saved.apiKey_primary !== config.apiKey_primary || saved.apiKey_backup !== config.apiKey_backup
      || saved.visionApiKey !== config.visionApiKey || saved.visionProvider !== config.visionProvider
      || !!saved.useVisionCustomEndpoint !== !!config.useVisionCustomEndpoint
      || saved.visionCustomEndpoint !== config.visionCustomEndpoint) throw new Error('Save credential settings before validation.');
}

function geminiClient(config: AIConfig, key: string, options: any): GoogleGenAI {
    const endpoint = new URL(geminiEndpoint(config));
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
      || Array.from(endpoint.searchParams.keys()).some(name => /key|token|secret|authorization/i.test(name))) throw new Error('Invalid credential endpoint.');
    if (!hasNativeCredentials()) return createSessionGemini(config, key);
    if (!key.startsWith('vault:')) throw new Error('Save the Gemini API key securely before validation.');
    return { models: { generateContent: (input: any) => protectedGeminiGenerate(key, geminiEndpoint(config), input) } } as unknown as GoogleGenAI;
}

// --- NEW: STRICT VALIDATION FUNCTION ---
export const validateAIConnection = async (config: AIConfig): Promise<boolean> => {
    try {
        assertSavedBrowserBinding(config);
        let keyToUse = "";
        const activeKey = config.activeKey === 'primary' ? config.apiKey_primary : config.apiKey_backup;
        if (!activeKey || activeKey.trim() === "") {
            console.error(`Validation Failed: Active API Key (${config.activeKey}) is missing.`);
            return false;
        }
        keyToUse = activeKey.trim();

        const provider = config.provider || 'gemini';
        const transportProvider = resolveTransportProvider(
            provider,
            config.useCustomEndpoint ? config.customEndpoint : undefined
        );
        let modelName = config.model_summary;
        if (!modelName) {
            switch (provider) {
                case 'openai': modelName = 'gpt-4o-mini'; break;
                case 'anthropic': modelName = 'claude-3-5-haiku-20241022'; break;
                case 'deepseek': modelName = 'deepseek-chat'; break;
                case 'grok': modelName = 'grok-2-latest'; break;
                default: modelName = 'gemini-2.5-flash';
            }
        }
        
        console.log(`[Validation] Pinging ${modelName} via ${transportProvider}`);
        
        await validationRequest(config, modelName, async signal => {
        if (transportProvider !== 'gemini' && transportProvider !== 'anthropic') {
            await callOpenAI(config, modelName, "ping", [], "ping", undefined, { rounds: [], signal });
        } else if (transportProvider === 'anthropic') {
            await callAnthropic(config, modelName, "ping", [], "ping", undefined, { rounds: [], signal });
        } else {
            const options: any = { apiKey: keyToUse };
            if (config.useCustomEndpoint && config.customEndpoint) {
                options.httpOptions = { baseUrl: config.customEndpoint.trim().replace(/\/v1beta\/?$/, '').replace(/\/v1alpha\/?$/, '').replace(/\/v1\/?$/, '').replace(/\/$/, '') };
            }
            const ai = geminiClient(config, keyToUse, options);
            await ai.models.generateContent({
                model: modelName,
                contents: "ping",
                config: { abortSignal: signal },
            });
        }
        });
        
        return true;
    } catch (e) {
        console.error("Validation Failed with Error:", e);
        return false;
    }
};

// --- NEW: MODEL-SPECIFIC VALIDATION FUNCTION ---
export const validateModels = async (config: AIConfig): Promise<{ main: boolean; summary: boolean; vision: boolean }> => {
    let ai: GoogleGenAI | undefined;
    const provider = config.provider || 'gemini';
    const transportProvider = resolveTransportProvider(
        provider,
        config.useCustomEndpoint ? config.customEndpoint : undefined
    );
    try {
        assertSavedBrowserBinding(config);
        let keyToUse = "";
        const activeKey = config.activeKey === 'primary' ? config.apiKey_primary : config.apiKey_backup;
        if (!activeKey) throw new Error("Active API key not found for model validation");
        keyToUse = activeKey.trim();
        
        if (transportProvider === 'gemini') {
            const options: any = { apiKey: keyToUse };
            if (config.useCustomEndpoint && config.customEndpoint) {
                options.httpOptions = { baseUrl: config.customEndpoint.trim().replace(/\/v1beta\/?$/, '').replace(/\/v1alpha\/?$/, '').replace(/\/v1\/?$/, '').replace(/\/$/, '') };
            }
            ai = geminiClient(config, keyToUse, options);
        }
    } catch (e) {
        console.error("Failed to initialize GenAI for model validation:", e);
        return { main: false, summary: false, vision: false };
    }

    const validate = async (modelName: string, isVision: boolean = false) => {
        if (!modelName || !modelName.trim()) return false;
        try {
            const currentProvider = isVision ? (config.visionProvider || config.provider || 'gemini') : provider;
            const currentEndpoint = isVision
                ? ((config.useVisionCustomEndpoint ?? config.useCustomEndpoint) ? (config.visionCustomEndpoint ?? config.customEndpoint) : undefined)
                : (config.useCustomEndpoint ? config.customEndpoint : undefined);
            const currentTransport = resolveTransportProvider(currentProvider, currentEndpoint);
            console.log(`[Model Validation] Pinging ${modelName} via ${currentTransport}...`);
            
            await validationRequest(config, modelName, async signal => { if (isVision) {
                if (!hasNativeCredentials() && !config.visionApiKey
                  && (currentProvider !== provider || currentEndpoint !== (config.useCustomEndpoint ? config.customEndpoint : undefined))) {
                    throw new Error('Configure a separate vision credential for a different endpoint.');
                }
                // If it's vision, we can just use callVisionHelper with a dummy image to test
                // But wait, callVisionHelper requires a real image. Let's just do a ping with the vision provider settings.
                const visionConfig = { ...config, provider: currentProvider, useCustomEndpoint: config.useVisionCustomEndpoint ?? config.useCustomEndpoint, customEndpoint: config.visionCustomEndpoint ?? config.customEndpoint };
                if (config.visionApiKey) {
                    visionConfig.apiKey_primary = config.visionApiKey;
                    visionConfig.activeKey = 'primary';
                }
                
                if (currentTransport !== 'gemini' && currentTransport !== 'anthropic') {
                    await callOpenAI(visionConfig, modelName, "ping", [], "ping", undefined, { rounds: [], signal });
                } else if (currentTransport === 'anthropic') {
                    await callAnthropic(visionConfig, modelName, "ping", [], "ping", undefined, { rounds: [], signal });
                } else {
                    let visionAi = ai;
                    if (!visionAi || config.visionApiKey || config.useVisionCustomEndpoint || currentTransport !== transportProvider) {
                        const options: any = { apiKey: config.visionApiKey || (config.activeKey === 'primary' ? config.apiKey_primary : config.apiKey_backup) };
                        if ((config.useVisionCustomEndpoint ?? config.useCustomEndpoint) && (config.visionCustomEndpoint ?? config.customEndpoint)) {
                            options.httpOptions = { baseUrl: (config.visionCustomEndpoint ?? config.customEndpoint)!.trim().replace(/\/v1beta\/?$/, '').replace(/\/v1alpha\/?$/, '').replace(/\/v1\/?$/, '').replace(/\/$/, '') };
                        }
                        visionAi = geminiClient(visionConfig, options.apiKey, options);
                    }
                    await visionAi.models.generateContent({ model: modelName, contents: "ping", config: { abortSignal: signal } });
                }
            } else {
                if (transportProvider !== 'gemini' && transportProvider !== 'anthropic') {
                    await callOpenAI(config, modelName, "ping", [], "ping", undefined, { rounds: [], signal });
                } else if (transportProvider === 'anthropic') {
                    await callAnthropic(config, modelName, "ping", [], "ping", undefined, { rounds: [], signal });
                } else {
                    await ai!.models.generateContent({ model: modelName, contents: "ping", config: { abortSignal: signal } });
                }
            }
            });
            console.log(`[Model Validation] Success for ${modelName}.`);
            return true;
        } catch (e) {
            console.warn(`[Model Validation] Failed for model ${modelName}:`, e);
            return false;
        }
    };

    const mainResult = await validate(config.model_main);
    const summaryResult = await validate(config.model_summary);
    const visionResult = config.useVisionHelper ? await validate(config.model_vision || getDefaultVisionModel(config.visionProvider || config.provider), true) : true;

    return { main: mainResult, summary: summaryResult, vision: visionResult };
};

// --- NEW: SEARCH GROUNDING VALIDATION ---
export const validateSearchCapability = async (config: AIConfig): Promise<{ success: boolean; message?: string }> => {
    try {
        assertSavedBrowserBinding(config);
        let keyToUse = "";
        const activeKey = config.activeKey === 'primary' ? config.apiKey_primary : config.apiKey_backup;
        if (!activeKey) return { success: false, message: "Active Key Missing" };
        keyToUse = activeKey.trim();

        const transportProvider = resolveTransportProvider(
            config.provider,
            config.useCustomEndpoint ? config.customEndpoint : undefined
        );

        if (transportProvider !== 'gemini') {
            return { success: false, message: "Current endpoint is not Gemini-native; search grounding validation is skipped." };
        }

        const options: any = { apiKey: keyToUse };
        if (config.useCustomEndpoint && config.customEndpoint) {
            options.httpOptions = { baseUrl: config.customEndpoint.trim().replace(/\/v1beta\/?$/, '').replace(/\/v1alpha\/?$/, '').replace(/\/v1\/?$/, '').replace(/\/$/, '') };
        }
        const ai = geminiClient(config, keyToUse, options);
        // Use Main Model as it is the one likely to use search
        const modelName = config.model_main || 'gemini-3.1-pro-preview'; 
        
        console.log(`[Search Validation] Testing Search Grounding on ${modelName}...`);
        
        // Force a query that requires real-time data to trigger search tool
        const response = await validationRequest(config, modelName, signal => ai.models.generateContent({
            model: modelName,
            contents: "What is the exact time in Tokyo right now?",
            config: {
                tools: [{ googleSearch: {} }], abortSignal: signal // Explicitly enable search tool
            }
        }));
        
        // If request succeeds (200 OK), permission is likely granted.
        // If permission is missing, API usually throws 403 or "PermissionDenied".
        console.log(`[Search Validation] Success. Response received.`);
        return { success: true };

    } catch (e: any) {
        console.error("Search Validation Failed:", e);
        const msg = e.message || "Unknown Error";
        if (msg.includes("permission") || msg.includes("disabled")) {
            return { success: false, message: "Permission Denied: Search not enabled for this project." };
        }
        return { success: false, message: msg };
    }
};
