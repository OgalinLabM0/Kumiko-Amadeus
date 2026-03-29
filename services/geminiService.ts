
import { GoogleGenAI, Chat, GenerateContentResponse, Part, Content, Type, FunctionDeclaration } from "@google/genai";
import { KUMIKO_SYSTEM_INSTRUCTION_ZH, KUMIKO_SYSTEM_INSTRUCTION_EN, KUMIKO_EMOTION_IMAGES } from "../constants";
import { ChatResponse, EmotionType, Message, WorldBookEntry, LocationConfig, AnchorEntry, AIConfig, Language, SummaryBoundaryReason, TemporalQueryPrecision, TemporalQuerySource, TemporalQueryDiagnosticsStatus, TemporalQueryConfidence } from "../types";
import { callOpenAI, callAnthropic, callVisionHelper } from "./llmProviderService";
import { imageService } from "./imageService";
import { DEFAULT_AI_CONFIG, getDefaultVisionModel, normalizeAIConfig, resolveTransportProvider } from "./appConfig";

// --- CRITICAL FIX: Safe Environment Access ---
export const getEnvKey = (): string | undefined => {
    try {
        // @ts-ignore
        if (typeof process !== 'undefined' && process.env) {
            // @ts-ignore
            return process.env.API_KEY;
        }
    } catch (e) {
        return undefined;
    }
    return undefined;
};

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

// Helper to get a fresh client instance every time to handle dynamic API keys
const getGenAI = (overrideKey?: string): GoogleGenAI => {
  const config = getCurrentAIConfig();
  
  let apiKey = "";
  const envKey = getEnvKey();
  
  // LOGIC TRACE FOR DEBUGGING
  let source = "UNKNOWN";

  if (overrideKey) {
      apiKey = overrideKey;
      source = "OVERRIDE";
  } else {
      if (config.useEnvKey && envKey) {
          apiKey = envKey.trim();
          source = "ENV_VAR (Configured)";
      } else {
          // Use active key logic
          const keyToUse = config.activeKey === 'backup' ? config.apiKey_backup : config.apiKey_primary;
          
          if (keyToUse && keyToUse.trim() !== "") {
              apiKey = keyToUse.trim();
              source = `CUSTOM_${config.activeKey.toUpperCase()}`;
          } else if (envKey) {
              // Fallback to Env if custom key is empty to prevent crash
              apiKey = envKey.trim();
              source = "ENV_VAR (Fallback: Custom Key Empty)";
          }
      }
  }

  // FORENSIC LOGGING
  const maskedKey = apiKey ? `...${apiKey.slice(-4)}` : "MISSING";
  console.log(`[Gemini Init] Source: ${source} | Key: ${maskedKey}`);

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


// --- NEW: STRICT VALIDATION FUNCTION ---
export const validateAIConnection = async (config: AIConfig): Promise<boolean> => {
    try {
        let keyToUse = "";
        const envKey = getEnvKey();
        
        if (config.useEnvKey) {
            if (!envKey || envKey.trim() === "") {
                console.error("Validation Failed: Environment Variable API_KEY is missing or empty.");
                return false;
            }
            keyToUse = envKey.trim();
        } else {
            // Test the currently active key
            const activeKey = config.activeKey === 'primary' ? config.apiKey_primary : config.apiKey_backup;
            if (!activeKey || activeKey.trim() === "") {
                console.error(`Validation Failed: Active API Key (${config.activeKey}) is missing.`);
                return false;
            }
            keyToUse = activeKey.trim();
        }

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
        
        console.log(`[Validation] Pinging ${modelName} with key ending in ...${keyToUse.slice(-4)} via ${transportProvider}`);
        
        if (transportProvider === 'openai' || transportProvider === 'deepseek' || transportProvider === 'grok' || transportProvider === 'openrouter') {
            await callOpenAI(config, modelName, "ping", [], "ping");
        } else if (transportProvider === 'anthropic') {
            await callAnthropic(config, modelName, "ping", [], "ping");
        } else {
            const options: any = { apiKey: keyToUse };
            if (config.useCustomEndpoint && config.customEndpoint) {
                options.httpOptions = { baseUrl: config.customEndpoint.trim().replace(/\/v1beta\/?$/, '').replace(/\/v1alpha\/?$/, '').replace(/\/v1\/?$/, '').replace(/\/$/, '') };
            }
            const ai = new GoogleGenAI(options);
            await ai.models.generateContent({
                model: modelName,
                contents: "ping",
            });
        }
        
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
        let keyToUse = "";
        const envKey = getEnvKey();
        if (config.useEnvKey) {
            if (!envKey) throw new Error("Env key selected but not found for model validation");
            keyToUse = envKey.trim();
        } else {
            const activeKey = config.activeKey === 'primary' ? config.apiKey_primary : config.apiKey_backup;
            if (!activeKey) throw new Error("Active manual key not found for model validation");
            keyToUse = activeKey.trim();
        }
        
        if (transportProvider === 'gemini') {
            const options: any = { apiKey: keyToUse };
            if (config.useCustomEndpoint && config.customEndpoint) {
                options.httpOptions = { baseUrl: config.customEndpoint.trim().replace(/\/v1beta\/?$/, '').replace(/\/v1alpha\/?$/, '').replace(/\/v1\/?$/, '').replace(/\/$/, '') };
            }
            ai = new GoogleGenAI(options);
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
            
            if (isVision) {
                // If it's vision, we can just use callVisionHelper with a dummy image to test
                // But wait, callVisionHelper requires a real image. Let's just do a ping with the vision provider settings.
                const visionConfig = { ...config, provider: currentProvider, useCustomEndpoint: config.useVisionCustomEndpoint ?? config.useCustomEndpoint, customEndpoint: config.visionCustomEndpoint ?? config.customEndpoint };
                if (config.visionApiKey) {
                    visionConfig.useEnvKey = false;
                    visionConfig.apiKey_primary = config.visionApiKey;
                    visionConfig.activeKey = 'primary';
                }
                
                if (currentTransport === 'openai' || currentTransport === 'deepseek' || currentTransport === 'grok' || currentTransport === 'openrouter') {
                    await callOpenAI(visionConfig, modelName, "ping", [], "ping");
                } else if (currentTransport === 'anthropic') {
                    await callAnthropic(visionConfig, modelName, "ping", [], "ping");
                } else {
                    let visionAi = ai;
                    if (!visionAi || config.visionApiKey || config.useVisionCustomEndpoint || currentTransport !== transportProvider) {
                        const options: any = { apiKey: config.visionApiKey || (config.useEnvKey ? getEnvKey() : (config.activeKey === 'primary' ? config.apiKey_primary : config.apiKey_backup)) };
                        if ((config.useVisionCustomEndpoint ?? config.useCustomEndpoint) && (config.visionCustomEndpoint ?? config.customEndpoint)) {
                            options.httpOptions = { baseUrl: (config.visionCustomEndpoint ?? config.customEndpoint)!.trim().replace(/\/v1beta\/?$/, '').replace(/\/v1alpha\/?$/, '').replace(/\/v1\/?$/, '').replace(/\/$/, '') };
                        }
                        visionAi = new GoogleGenAI(options);
                    }
                    await visionAi.models.generateContent({ model: modelName, contents: "ping" });
                }
            } else {
                if (transportProvider === 'openai' || transportProvider === 'deepseek' || transportProvider === 'grok' || transportProvider === 'openrouter') {
                    await callOpenAI(config, modelName, "ping", [], "ping");
                } else if (transportProvider === 'anthropic') {
                    await callAnthropic(config, modelName, "ping", [], "ping");
                } else {
                    await ai!.models.generateContent({ model: modelName, contents: "ping" });
                }
            }
            console.log(`[Model Validation] Success for ${modelName}.`);
            return true;
        } catch (e) {
            console.warn(`[Model Validation] Failed for model ${modelName}:`, e);
            return false;
        }
    };

    const [mainResult, summaryResult, visionResult] = await Promise.all([
        validate(config.model_main),
        validate(config.model_summary),
        config.useVisionHelper ? validate(config.model_vision || getDefaultVisionModel(config.visionProvider || config.provider), true) : Promise.resolve(true)
    ]);

    return { main: mainResult, summary: summaryResult, vision: visionResult };
};

// --- NEW: SEARCH GROUNDING VALIDATION ---
export const validateSearchCapability = async (config: AIConfig): Promise<{ success: boolean; message?: string }> => {
    try {
        let keyToUse = "";
        const envKey = getEnvKey();
        
        if (config.useEnvKey) {
            if (!envKey) return { success: false, message: "Env Key Missing" };
            keyToUse = envKey.trim();
        } else {
            const activeKey = config.activeKey === 'primary' ? config.apiKey_primary : config.apiKey_backup;
            if (!activeKey) return { success: false, message: "Active Key Missing" };
            keyToUse = activeKey.trim();
        }

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
        const ai = new GoogleGenAI(options);
        // Use Main Model as it is the one likely to use search
        const modelName = config.model_main || 'gemini-3.1-pro-preview'; 
        
        console.log(`[Search Validation] Testing Search Grounding on ${modelName}...`);
        
        // Force a query that requires real-time data to trigger search tool
        const response = await ai.models.generateContent({
            model: modelName,
            contents: "What is the exact time in Tokyo right now?",
            config: {
                tools: [{ googleSearch: {} }] // Explicitly enable search tool
            }
        });
        
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


// Normalization Layer: Maps loose emotion words to strict types
const EMOTION_MAPPING: Record<string, EmotionType> = {
  // Map Synonyms to Valid Keys
  'exhausted': 'sleepy', 'tired': 'sleepy', 'yawning': 'sleepy', 'drowsy': 'sleepy',
  'shocked': 'surprised', 'stunned': 'surprised', 'what': 'surprised',
  'puzzled': 'confused', 'curious': 'confused', 'questioning': 'confused',
  'repulsed': 'disgusted', 'grossed': 'disgusted', 'eww': 'disgusted', 'geh': 'disgusted', // FIXED: Map to disgusted
  'teasing': 'smug', 'playful': 'smug', 'proud': 'smug', 'confident': 'smug', // FIXED: Map to smug
  'anxious': 'worried', 'nervous': 'worried', 'panicked': 'worried',
  'concerned': 'worried_2', 'caring': 'worried_2', 'sympathetic': 'worried_2',
  'furious': 'angry', 'annoyed': 'angry', 'irritated': 'angry',
  'depressed': 'sad', 'crying': 'sad', 'heartbroken': 'sad',
  'determined': 'serious', 'focused': 'serious',
  'mild confusion': 'confused', 'mildly confused': 'confused',
  'slight anger': 'angry', 'slightly annoyed': 'angry'
};

const VARIETY_INSTRUCTIONS_EN = [
    "[Tone_Shift]: Be slightly more cynical/sharp this time.",
    "[Tone_Shift]: Keep the response very short and punchy.",
    "[Tone_Shift]: Use a rhetorical question to challenge the user.",
    "[Tone_Shift]: Focus on a sensory detail (sound, temperature, or physical sensation) in your reply.",
    "[Tone_Shift]: Sigh and complain a little about something unrelated before answering.",
    "[Tone_Shift]: Be slightly softer/gentler than usual.",
    "[Tone_Shift]: Use a metaphor related to music or instruments.",
    "[Tone_Shift]: Act a bit spaced out or slow to react.",
    "[Tone_Shift]: Be unexpectedly direct and blunt."
];

const VARIETY_INSTRUCTIONS_ZH = [
    "[语气转变]：这次稍微愤世嫉俗/尖锐一点。",
    "[语气转变]：保持回复非常简短有力。",
    "[语气转变]：使用反问句来挑战用户。",
    "[语气转变]：在回复中关注感官细节（声音、温度或身体感觉）。",
    "[语气转变]：在回答之前叹气并稍微抱怨一些无关的事情。",
    "[语气转变]：比平时稍微温柔/柔和一点。",
    "[语气转变]：使用与音乐或乐器相关的隐喻。",
    "[语气转变]：表现得有点心不在焉或反应迟钝。",
    "[语气转变]：出乎意料地直接和直率。"
];

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

export const urlToBase64 = async (url: string): Promise<string | null> => {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64data = reader.result as string;
                const raw = base64data.split(',')[1];
                resolve(raw);
            };
            reader.readAsDataURL(blob);
        });
    } catch (e) {
        console.warn("[Recall] Failed to convert URL to Base64:", url);
        return null;
    }
};

export const uploadImageToBackend = async (base64Image: string, backendUrl: string): Promise<string | null> => {
  try {
    const cleanBaseUrl = backendUrl.replace(/\/+$/, "");
    const uploadUrl = `${cleanBaseUrl}/api/r2-upload`;
    
    const payload = {
        image: base64Image
    };

    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: {
          'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
        console.error(`[R2 Upload] Server returned ${res.status}`);
        return null;
    }

    const data = await res.json();
    
    if (data && data.url) {
        return data.url;
    }
    
    return null;
  } catch (e) {
    console.error("[R2 Upload] Network Error:", e);
    return null;
  }
};

export const searchRagMemory = async (
    query: string, 
    endpoint: string, 
    userId: string, 
    apiKey?: string
): Promise<string[]> => {
    try {
        const baseUrl = endpoint.replace(/\/+$/, ""); 
        const searchUrl = `${baseUrl}/api/rag/search`;
        
        const payload = {
            query: query,
            userId: userId
        };
        
        const headers: any = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        const res = await fetch(searchUrl, { 
            method: 'POST', 
            headers,
            body: JSON.stringify(payload)
        });
        
        if (!res.ok) return [];
        
        const data = await res.json();
        if (Array.isArray(data.results)) return data.results;
        if (Array.isArray(data.memories)) return data.memories.map((m: any) => m.content);
        
        return [];
    } catch (e) {
        console.warn("[RAG] Search failed:", e);
        return [];
    }
};

export const saveRagMemory = async (
    memoryText: string, 
    endpoint: string, 
    userId: string, 
    apiKey?: string
): Promise<boolean> => {
    try {
        const baseUrl = endpoint.replace(/\/+$/, "");
        const addUrl = `${baseUrl}/api/rag/add`;
        
        const headers: any = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        
        const payload = {
            userId,
            text: memoryText,    
            content: memoryText, 
            timestamp: Date.now()
        };

        const res = await fetch(addUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });
        
        return res.ok;
    } catch (e) {
        console.error("[RAG] Save failed:", e);
        return false;
    }
};

export const summarizeConversation = async (
  recentMessages: Message[], 
  existingMemory: string,
  timeRangeStr?: string,
  currentNotebook: string = "",
  locationConfig?: LocationConfig,
  language: Language = 'zh',
  summaryMeta?: {
    reason?: SummaryBoundaryReason | null;
    isComplete?: boolean;
    isContinuation?: boolean;
    turnsInSegment?: number;
  }
): Promise<{ diary: string, notebook: string, chunks: string[] }> => {
  const config = getCurrentAIConfig();
  const provider = config.provider || 'gemini';
  const transportProvider = resolveTransportProvider(
    provider,
    config.useCustomEndpoint ? config.customEndpoint : undefined
  );

  try {
    const historyText = recentMessages.map(m => {
        const msgDate = new Date(m.timestamp);
        let jstTime = "??:??";
        try {
            const jstOptions: Intl.DateTimeFormatOptions = { 
                timeZone: 'Asia/Tokyo', 
                month: '2-digit', day: '2-digit', 
                weekday: 'short',
                hour: '2-digit', minute: '2-digit', hour12: false 
            };
            jstTime = msgDate.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', jstOptions);
        } catch(e) {}

        let userTime = "??:??";
        if (locationConfig?.userTimezone) {
            try {
               const userOptions: Intl.DateTimeFormatOptions = { 
                   timeZone: locationConfig.userTimezone, 
                   month: '2-digit', day: '2-digit', 
                   weekday: 'short',
                   hour: '2-digit', minute: '2-digit', hour12: false 
               };
               userTime = msgDate.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', userOptions);
            } catch(e) {
                userTime = "Unknown";
            }
        }
        const voiceTag = m.isVoiceMessage ? '[语音消息] ' : '';
        return `[JST: ${jstTime} | User: ${userTime}] ${m.role.toUpperCase()}: ${voiceTag}${m.text}`;
    }).join('\n');

    const summaryReasonTextZh: Record<SummaryBoundaryReason, string> = {
      topic_shift: '用户自然换题，上一段对话已经形成章节边界。',
      semantic_shift: '系统检测到话题语义已经明显转向，上一段对话适合先按自然章节封存。',
      long_gap: '用户隔了较长时间才再次开口，上一段对话适合先封存。',
      reminder_created: '这一段对话已经以提醒/约定的形式落地，适合作为完整片段归档。',
      sleep_transition: '对话自然收到了睡前或结束态，适合作为一个章节结尾。',
      wrap_up: '用户明确表现出收尾或暂时结束当前话题的意图。',
      hard_limit: '这段对话仍可能继续，但为了防止长期不归档，系统在硬上限处先做阶段性封存。',
    };

    const summaryReasonTextEn: Record<SummaryBoundaryReason, string> = {
      topic_shift: 'The user naturally shifted topic, so the previous exchange forms a clean episode boundary.',
      semantic_shift: 'The system detected a clear semantic drift in topic, so the earlier exchange should be archived as its own episode.',
      long_gap: 'A long silence happened before the user came back, so the earlier exchange should be archived first.',
      reminder_created: 'This exchange resolved into a reminder or promise, so it works as a complete episode.',
      sleep_transition: 'The conversation naturally moved into a sleep or closing state, so it fits a chapter ending.',
      wrap_up: 'The user clearly signaled a wrap-up or temporary close for the current topic.',
      hard_limit: 'The topic may still continue later, but the system hit a hard cap and is archiving this as an unfinished ongoing segment.',
    };

    const boundaryReasonText = summaryMeta?.reason
      ? (language === 'zh' ? summaryReasonTextZh[summaryMeta.reason] : summaryReasonTextEn[summaryMeta.reason])
      : (language === 'zh' ? '系统没有提供额外切段说明。' : 'No extra boundary note was provided by the system.');

    const segmentMetaBlock = language === 'zh'
      ? `\n[当前分段状态]\n- 本次归档范围：当前尚未归档的自然对话分段，不是固定最后 20 轮。\n- 当前分段轮数：${summaryMeta?.turnsInSegment ?? '未知'}\n- 切段原因：${boundaryReasonText}\n- 是否自然收尾：${summaryMeta?.isComplete === false ? '否，这一段可能还会继续。' : '是，这一段基本自然收束了。'}\n- 是否承接上一段未完话题：${summaryMeta?.isContinuation ? '是。开头附带了一小段上一章尾部，只用于续写衔接。' : '否。'}\n- 如果系统说明“尚未自然收尾”，你的摘要和记忆块必须保留“还没彻底聊完”的感觉，不要假装已经得出最终结论。\n- 如果系统说明“承接上一段未完话题”，开头那一点旧内容只是为了衔接，不要把已经写过的旧部分原样重复成新的重点。\n`
      : `\n[CURRENT SEGMENT STATE]\n- Archive scope: the current unsaved conversation segment, not a fixed last-20-turn window.\n- Segment turns: ${summaryMeta?.turnsInSegment ?? 'Unknown'}\n- Boundary reason: ${boundaryReasonText}\n- Naturally complete: ${summaryMeta?.isComplete === false ? 'No. The topic may continue later.' : 'Yes. The segment mostly reached a natural close.'}\n- Continues previous unfinished thread: ${summaryMeta?.isContinuation ? 'Yes. A small tail from the prior chapter is attached only to preserve continuity.' : 'No.'}\n- If the system says the segment is not naturally complete, your diary and memory chunks must preserve that unfinished feeling instead of pretending the topic is fully resolved.\n- If the system says this segment continues a previous unfinished thread, treat the overlap as continuity glue and avoid repeating already-archived old material as if it were brand new.\n`;
    
    // --- DUAL LANGUAGE PROMPT STRATEGY ---
    let diaryInstruction = "";
    if (language === 'zh') {
        diaryInstruction = `
      **GOLDEN STANDARD (USE CHINESE):**
      "【2025/12/08 20:48 - 03:19】那个笨蛋终于肯去睡觉了。明明都已经很晚了，还在床上磨磨蹭蹭的...本来以为终于能清静了，结果！就在刚才！这边明明是凌晨三点，这家伙突然发个“早”过来...嘛，特意想跟我打招呼这份心意是不坏啦。
      - [KEY_FACT]: User睡得很晚；User觉得听到我的晚安很满足。
      - [EMOTIONAL_CONTEXT]: 既觉得烦躁又感到一丝温暖。"

      **Requirements for Diary:**
      1. **Header**: Start with timestamp 【${timeRangeStr}】. DO NOT modify this timestamp.
      2. **Body**: Use a rich, personal, slightly cynical but warm tone in **CHINESE**.
      3. **Structure**: MUST include "- [KEY_FACT]:" and "- [EMOTIONAL_CONTEXT]:" sections.
      
      [TASK 2: MANAGE YOUR NOTEBOOK]
      Is there anything new worth writing in your private notebook?
      - WRITE IN **CHINESE**.
      - **CRITICAL**: Your notebook MUST be a valid JSON object with exactly two keys:
        1. "user_profile": A string describing the user's identity, location, job, habits, etc.
        2. "relationship_dynamics": A string describing your current relationship, how you feel about them, internal jokes, etc.
      - Merge any new information with the existing notebook content.
      - Output ONLY the raw JSON object inside the [NOTEBOOK_UPDATE] tags. Do not use markdown code blocks like \`\`\`json inside the tags.
      
      [TASK 3: EXTRACT EPISODE SUMMARIES FOR RAG]
      Group the recent conversation into 1 to 3 distinct "Topic Blocks" or "Episodes". For each topic, write a concise summary (chunk) that captures the core information, facts, and events discussed.
      - WRITE IN **CHINESE**.
      - Output ONLY a valid JSON array of strings inside the [MEMORY_CHUNKS] tags. Do not use markdown code blocks.
      - Example: ["User今天分享了他们正在学习弹吉他，虽然手指很痛但觉得很有趣。", "我们聊了京都最近连绵不断的雨季，以及这让人感到有些忧郁的心情。"]
        `;
    } else {
        diaryInstruction = `
      **GOLDEN STANDARD (USE ENGLISH):**
      "【2025/12/08 20:48 - 03:19】That idiot finally went to sleep. It was super late, but they kept procrastinating... I thought I'd finally get some peace, but then! Just now! It's 3 AM here, and they suddenly texted 'Morning'... Well, I guess the thought counts.
      - [KEY_FACT]: User sleeps late; User likes my goodnight messages.
      - [EMOTIONAL_CONTEXT]: Annoyed but slightly warmed."

      **Requirements for Diary:**
      1. **Header**: Start with timestamp 【${timeRangeStr}】. DO NOT modify this timestamp.
      2. **Body**: Use a rich, personal, slightly cynical but warm tone in **ENGLISH**.
      3. **Structure**: MUST include "- [KEY_FACT]:" and "- [EMOTIONAL_CONTEXT]:" sections.
      
      [TASK 2: MANAGE YOUR NOTEBOOK]
      Is there anything new worth writing in your private notebook?
      - WRITE IN **ENGLISH**.
      - **CRITICAL**: Your notebook MUST be a valid JSON object with exactly two keys:
        1. "user_profile": A string describing the user's identity, location, job, habits, etc.
        2. "relationship_dynamics": A string describing your current relationship, how you feel about them, internal jokes, etc.
      - Merge any new information with the existing notebook content.
      - Output ONLY the raw JSON object inside the [NOTEBOOK_UPDATE] tags. Do not use markdown code blocks like \`\`\`json inside the tags.
      
      [TASK 3: EXTRACT EPISODE SUMMARIES FOR RAG]
      Group the recent conversation into 1 to 3 distinct "Topic Blocks" or "Episodes". For each topic, write a concise summary (chunk) that captures the core information, facts, and events discussed.
      - WRITE IN **ENGLISH**.
      - Output ONLY a valid JSON array of strings inside the [MEMORY_CHUNKS] tags. Do not use markdown code blocks.
      - Example: ["User shared that they are learning to play the guitar, finding it fun despite the sore fingers.", "We talked about the continuous rainy season in Kyoto and the slightly melancholic mood it brings."]
        `;
    }

    const prompt = language === 'zh' ? `
      [角色]：你是黄前久美子。
      [时间范围]：${timeRangeStr || "未知日期"}
      [用户时区]：${locationConfig?.userTimezone || "未知"}
      
      [当前待归档分段日志 - 仔细阅读]：
      （时间戳显示 [JST: 你的时间 | User: 他们的时间]）
      ${historyText}
      ${segmentMetaBlock}
      
      [任务 1：近期摘要缓冲]
      写一篇**详细**的近期归档摘要，用来作为滚动缓冲，帮助你在接下来几段对话里保留最近发生的事。
      这不是唯一的永久总记忆，也不是逐字聊天记录；长期关系主要依赖私密记事本、锚点和后续 MEMORY_CHUNKS。
      
      **时间幻觉检查：**
      - 密切关注**用户时间**。
      - 如果用户时间是 05:00，对他们来说是早上。
      - 如果用户时间是 23:00，对他们来说是深夜。
      - **不要**假设你的时间（JST）就是他们的时间。
      - 相信上面日志中的 [User: HH:MM] 时间戳。

      ${diaryInstruction}
      
      [当前笔记本内容]：
      "${currentNotebook}"
      
      [输出格式]：
      你必须严格使用这些标签输出。
      
      [DIARY_ENTRY]
      (你的完整日记文本在这里)
      [/DIARY_ENTRY]
      
      [NOTEBOOK_UPDATE]
      (更新后你的笔记本的完整内容)
      [/NOTEBOOK_UPDATE]
      
      [MEMORY_CHUNKS]
      (JSON array of strings here)
      [/MEMORY_CHUNKS]
    ` : `
      [ROLE]: You are Oumae Kumiko.
      [TIME RANGE]: ${timeRangeStr || "Unknown Date"}
      [USER TIMEZONE]: ${locationConfig?.userTimezone || "Unknown"}
      
      [CURRENT UNSAVED SEGMENT LOG - READ CAREFULLY]:
      (Timestamps show [JST: Your Time | User: Their Time])
      ${historyText}
      ${segmentMetaBlock}
      
      [TASK 1: RECENT SUMMARY BUFFER]
      Write a **DETAILED** recent archive summary that acts as a rolling buffer for the next few segments.
      This is not your one permanent master memory, and it is not a verbatim quote log; long-term continuity mainly comes from the notebook, anchors, and MEMORY_CHUNKS.
      
      **TIME HALLUCINATION CHECK:**
      - Pay close attention to the **User Time**.
      - If User Time is 05:00, it is MORNING for them.
      - If User Time is 23:00, it is LATE NIGHT for them.
      - **DO NOT** assume your time (JST) is their time.
      - Trust the [User: HH:MM] timestamp in the log above.

      ${diaryInstruction}
      
      [CURRENT NOTEBOOK CONTENT]:
      "${currentNotebook}"
      
      [OUTPUT FORMAT]:
      You must output strictly using these tags.
      
      [DIARY_ENTRY]
      (Your FULL diary text here)
      [/DIARY_ENTRY]
      
      [NOTEBOOK_UPDATE]
      (The FULL content of your notebook after updates)
      [/NOTEBOOK_UPDATE]
      
      [MEMORY_CHUNKS]
      (JSON array of strings here)
      [/MEMORY_CHUNKS]
    `;

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

    let text = "";
    if (transportProvider === 'openai' || transportProvider === 'deepseek' || transportProvider === 'grok' || transportProvider === 'openrouter') {
        const result = await callOpenAI(config, modelName, "You are a helpful summarizer.", [], prompt);
        text = result.text || "";
    } else if (transportProvider === 'anthropic') {
        const result = await callAnthropic(config, modelName, "You are a helpful summarizer.", [], prompt);
        text = result.text || "";
    } else {
        const ai = getGenAI();
        const result = await ai.models.generateContent({
          model: modelName, 
          contents: prompt,
          config: {
            responseMimeType: 'text/plain',
          }
        });
        text = result.text || "";
    }
    
    let cleanText = text.replace(/```\w*\n?/g, '').replace(/```/g, '').replace(/\*\*/g, ''); 
    
    let diaryMatch = cleanText.match(/(?:\[|【|\*\*\[)\s*DIARY[_\s]ENTRY\s*(?:\]|】|\]\*\*)\s*([\s\S]*?)\s*(?:\[|【|\*\*\[)\s*\/\s*DIARY[_\s]ENTRY\s*(?:\]|】|\]\*\*)/i);
    if (!diaryMatch) {
        diaryMatch = cleanText.match(/(?:\[|【|\*\*\[)\s*DIARY[_\s]ENTRY\s*(?:\]|】|\]\*\*)\s*([\s\S]*?)(?=(?:\[|【|\*\*\[)\s*NOTEBOOK[_\s]UPDATE\s*(?:\]|】|\]\*\*)|$)/i);
    }
    
    let notebookMatch = cleanText.match(/(?:\[|【|\*\*\[)\s*NOTEBOOK[_\s]UPDATE\s*(?:\]|】|\]\*\*)\s*([\s\S]*?)\s*(?:\[|【|\*\*\[)\s*\/\s*NOTEBOOK[_\s]UPDATE\s*(?:\]|】|\]\*\*)/i);
    if (!notebookMatch) {
        notebookMatch = cleanText.match(/(?:\[|【|\*\*\[)\s*NOTEBOOK[_\s]UPDATE\s*(?:\]|】|\]\*\*)\s*([\s\S]*?)(?=(?:\[|【|\*\*\[)\s*MEMORY[_\s]CHUNKS\s*(?:\]|】|\]\*\*)|$)/i);
    }
    
    let chunksMatch = cleanText.match(/(?:\[|【|\*\*\[)\s*MEMORY[_\s]CHUNKS\s*(?:\]|】|\]\*\*)\s*([\s\S]*?)\s*(?:\[|【|\*\*\[)\s*\/\s*MEMORY[_\s]CHUNKS\s*(?:\]|】|\]\*\*)/i);
    if (!chunksMatch) {
        chunksMatch = cleanText.match(/(?:\[|【|\*\*\[)\s*MEMORY[_\s]CHUNKS\s*(?:\]|】|\]\*\*)\s*([\s\S]*?)$/i);
    }
    
    let diary = diaryMatch ? diaryMatch[1].trim() : "";
    let notebook = notebookMatch ? notebookMatch[1].trim() : "";
    let chunks: string[] = [];

    if (chunksMatch) {
        try {
            chunks = JSON.parse(chunksMatch[1].trim());
            if (!Array.isArray(chunks)) chunks = [];
        } catch (e) {
            console.warn("[SUMMARY WARN] Failed to parse MEMORY_CHUNKS JSON.");
        }
    }

    if (!diary && cleanText.includes('[KEY_FACT]')) {
         const parts = cleanText.split(/(?:\[|【|\*\*\[)\s*NOTEBOOK[_\s]UPDATE\s*(?:\]|】|\]\*\*)/i);
         diary = parts[0].replace(/(?:\[|【|\*\*\[)\s*\/?DIARY[_\s]ENTRY\s*(?:\]|】|\]\*\*)/ig, '').trim();
         if (parts.length > 1) {
             notebook = parts[1].replace(/(?:\[|【|\*\*\[)\s*\/?NOTEBOOK[_\s]UPDATE\s*(?:\]|】|\]\*\*)/ig, '').trim();
         }
    }

    diary = diary || existingMemory;
    notebook = notebook || currentNotebook;

    console.log("[SUMMARY DEBUG] Raw Output:", text);
    if (!diaryMatch && !diary) console.warn("[SUMMARY WARN] Failed to parse DIARY_ENTRY. Falling back to old memory.");
    if (!notebookMatch && !notebook) console.warn("[SUMMARY WARN] Failed to parse NOTEBOOK_UPDATE. Falling back to old notebook.");

    return { diary, notebook, chunks };
  } catch (error) {
    console.error("Memory summarization failed:", error);
    return { diary: existingMemory, notebook: currentNotebook, chunks: [] };
  }
};

const normalizeTopicSnippet = (text: string) => {
  return text
    .replace(/\$/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\[[^\]]+\]\s*/g, '')
    .trim();
};

const buildTopicContinuityBlock = (
  historyMessages: Message[],
  currentText: string,
  gapMinutes: number,
  language: Language,
  isSystemDrivenTurn: boolean
) => {
  if (isSystemDrivenTurn || historyMessages.length < 6) {
    return '';
  }

  const currentSnippet = normalizeTopicSnippet(currentText).slice(0, 24);
  const candidates = historyMessages
    .filter(msg => msg.role === 'user')
    .slice(-12)
    .map(msg => normalizeTopicSnippet(msg.text))
    .filter(text => text.length >= 6 && text !== currentSnippet)
    .filter((text, index, array) => array.indexOf(text) === index)
    .slice(-3)
    .reverse();

  if (candidates.length === 0) {
    return '';
  }

  const chance = gapMinutes >= 20 ? 0.72 : 0.42;
  if (Math.random() > chance) {
    return '';
  }

  return language === 'zh'
    ? `\n[上下文提示 - 话题余温]：
你们最近这两天还没完全聊完的线索有：
${candidates.map((item, index) => `${index + 1}. ${item}`).join('\n')}
如果这一轮气氛顺，就自然顺手接回其中一条没说完的话头。
限制：
- 只轻轻带一下，不要硬拐。
- 不要像列提纲，也不要突然总结历史。`
    : `\n[CONTEXT_HINT - TOPIC AFTERGLOW]:
Loose threads from the last couple of days:
${candidates.map((item, index) => `${index + 1}. ${item}`).join('\n')}
If the mood fits, you may casually pick up one unfinished thread.
Rules:
- only nudge it lightly, never force a pivot.
- do not sound like you are summarizing a conversation log.`;
};

const buildRelationshipTemperatureBlock = (
  historyMessages: Message[],
  gapHours: number,
  language: Language
) => {
  const now = Date.now();
  const recent3Days = historyMessages.filter(msg => now - msg.timestamp <= 3 * 24 * 60 * 60 * 1000);
  const activeDays14 = new Set(
    historyMessages
      .filter(msg => now - msg.timestamp <= 14 * 24 * 60 * 60 * 1000)
      .map(msg => new Date(msg.timestamp).toISOString().slice(0, 10))
  ).size;
  const totalTurns = Math.floor(historyMessages.length / 2);

  let tier = language === 'zh' ? '熟悉自然' : 'Comfortably familiar';
  let guidance = language === 'zh'
    ? '语气可以自然一点，偶尔吐槽、偶尔关心，不用太客套。'
    : 'You can sound naturally familiar: a little teasing, a little concern, not formal.';

  if (totalTurns < 15 || activeDays14 <= 1) {
    tier = language === 'zh' ? '试探中的熟悉' : 'Tentative familiarity';
    guidance = language === 'zh'
      ? '别太黏，也别太疏远。先像已经认识但还在慢慢靠近。'
      : 'Do not get clingy. Do not feel distant either. Sound like someone already known, still slowly getting closer.';
  } else if (recent3Days.length >= 28 || activeDays14 >= 5) {
    tier = language === 'zh' ? '亲近松弛' : 'Warm and close';
    guidance = language === 'zh'
      ? '可以更放松一点，吐槽和关心都更自然，像已经形成固定聊天节奏。'
      : 'Be a touch more relaxed. Teasing and concern should both feel easier, like the chat rhythm is already established.';
  }

  if (recent3Days.length >= 60 && gapHours < 24) {
    tier = language === 'zh' ? '很熟的亲近感' : 'Deep easy closeness';
    guidance = language === 'zh'
      ? '像老夫老妻或损友一样的自然平淡。可以自然地吐槽或分享日常，但【绝对不要】变得黏人或刻意展现关心。保持久美子怕麻烦、有距离感的真实底色。'
      : 'Natural and flat like an old married couple or close frenemies. You can tease or share daily life naturally, but NEVER become clingy or artificially caring. Maintain Kumiko\'s true nature: slightly reserved and finding things troublesome.';
  }

  return language === 'zh'
    ? `\n[上下文提示 - 关系温度]：
当前关系温度：${tier}
建议：${guidance}`
    : `\n[CONTEXT_HINT - RELATIONSHIP TEMPERATURE]:
Current warmth: ${tier}
Guidance: ${guidance}`;
};

export const sendMessageToGemini = async (
  textMessage: string, 
  coreMemory: string,
  worldBook: WorldBookEntry[],
  historyMessages: Message[], 
  locationConfig?: LocationConfig,
  imageBase64?: string, 
  mimeType: string = 'image/jpeg',
  retryCount: number = 0, 
  previousContextLog?: string,
  ragContext: string[] = [], 
  exactHistoryLookup?: string,
  activeReminders: string[] = [], 
  anchors: AnchorEntry[] = [],
  kumikoNotebook: string = "",
  modelOverride?: string,
  language: Language = 'zh',
  extraSystemPrompt?: string,
): Promise<ChatResponse> => {
  const config = getCurrentAIConfig();
  const provider = config.provider || 'gemini';
  const transportProvider = resolveTransportProvider(
    provider,
    config.useCustomEndpoint ? config.customEndpoint : undefined
  );
  
  // DETERMINE MODEL: Use Override OR Configured Main OR Default
  const currentModel = modelOverride || config.model_main || 'gemini-3.1-pro-preview';
  const isSystemDrivenTurn = /^\s*\[(?:SYSTEM|CRITICAL_OVERRIDE)/m.test(textMessage);
  const isStrictMemoryLookupTurn = !!exactHistoryLookup && exactHistoryLookup.includes('[EXACT_HISTORY_LOOKUP]');
  const parseMemoryResponsePlan = (sources: string[]) => {
    const combined = sources.filter(Boolean).join('\n');
    const match = combined.match(/\[MEMORY_RESPONSE_PLAN\]([\s\S]*?)(?=\n\[|$)/);
    if (!match) return null;

    const getField = (name: string) => {
      const fieldMatch = match[1].match(new RegExp(`${name}:\\s*([^\\n]+)`));
      return fieldMatch?.[1]?.trim() || null;
    };

    return {
      route: getField('Route'),
      responseStrategy: getField('Response_Strategy'),
      answerMode: getField('Answer_Mode'),
      confidenceLevel: getField('Confidence_Level'),
      evidenceStrength: getField('Evidence_Strength'),
      speakerCertainty: getField('Speaker_Certainty'),
      timeCertainty: getField('Time_Certainty'),
      directAnswerAllowed: getField('Direct_Answer_Allowed'),
      conflictFlags: getField('Conflict_Flags'),
      routeBoundary: getField('Route_Boundary'),
      preferredLead: getField('Preferred_Lead'),
      noSubstitution: getField('No_Substitution'),
      speakerClaimAllowed: getField('Speaker_Claim_Allowed'),
      timePinpointAllowed: getField('Time_Pinpoint_Allowed'),
      primaryEvidence: getField('Primary_Evidence'),
      quotePolicy: getField('Quote_Policy'),
      maxBubbles: getField('Max_Bubbles'),
      entryMix: getField('Entry_Mix'),
    };
  };
  const memoryResponsePlan = parseMemoryResponsePlan([
    exactHistoryLookup || '',
    ...ragContext,
  ]);
  const isMemoryPlannedTurn = !!memoryResponsePlan;
  const shouldSuppressAmbientMemoryNoise = isMemoryPlannedTurn;
  const parseMaxBubbles = (raw: string | null | undefined) => {
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  const hasNoEvidenceLanguage = (part: string) => (
    /(?:没(?:有)?记录|记不清|不太确定|不确定|查不到|找不到|无法确认|没有印象|想不起来|can(?:not|'t)\s+confirm|don't\s+know|not\s+sure|can't\s+remember|no\s+record)/i.test(part)
  );
  const hasCautiousLanguage = (part: string) => (
    /(?:大概|大致|印象里|好像|似乎|应该是|可能是|不太确定|roughly|i think|i believe|it seems|probably|maybe|if i remember right|from what i remember)/i.test(part)
  );
  const isQuestionLike = (part: string) => /[?？]$/.test(part.trim());
  const looksBroadThemeSubstitution = (part: string) => (
    /(?:主要是在聊|大概是在聊|那次主要是在聊|那段主要是在聊|印象里那次.*聊|that time was mainly about|was mainly about|mostly about|mainly about)/i.test(part)
  );
  const looksHardSpeakerClaim = (part: string) => (
    /(?:你说的是|我说的是|那是你说的|那是我说的|当时你说|当时我说|you said|i said|that was you saying|that was me saying)/i.test(part)
  );
  const looksHardTimePinpoint = (part: string) => (
    /(?:就是(?:在)?\d{1,2}点|就是那天|正好是|确实是(?:在)?\d{1,2}点|exactly at|right at|precisely at|exactly on)/i.test(part)
  );
  const stripDirectQuoteSignals = (part: string) => (
    part
      .replace(/^(?:User|Kumiko)\s*:\s*/i, '')
      .replace(/[“”"「」『』]/g, '')
      .trim()
  );
  const isQuoteLikeMemoryClaim = (part: string) => (
    /(?:[“”"「」『』]|^(?:User|Kumiko)\s*:|^(?:你说|我说|当时你说|当时我说|you said|i said|that was you saying|that was me saying))/iu.test(part.trim())
  );
  const softenMemoryOverclaimForRoute = (part: string, routeBoundary: string | null) => {
    const stripped = stripDirectQuoteSignals(part)
      .replace(/^(?:就是|正好是|确实是)\s*/u, '')
      .trim();
    if (!stripped) return part;

    if (language === 'zh') {
      if (/^(?:我印象里|印象里|我只记得|我现在只记得|大概是|大致是)/u.test(stripped)) {
        return stripped;
      }
      if (routeBoundary === 'temporal_summary_or_supported_quote') {
        return `我印象里那段时间大概是${stripped}`;
      }
      if (routeBoundary === 'semantic_summary_or_supported_quote') {
        return `我印象里那次大概是${stripped}`;
      }
      if (routeBoundary === 'exact_evidence_only') {
        return `我现在只记得大意是${stripped}`;
      }
      return stripped;
    }

    const normalized = stripped.replace(/^(?:it was|it is|that was|that is)\s+/i, '').trim();
    if (/^(?:from what i remember|i remember|i only remember|roughly|approximately|it was roughly)/i.test(normalized)) {
      return normalized;
    }
    if (routeBoundary === 'temporal_summary_or_supported_quote') {
      return `From what I remember, that stretch was roughly ${normalized}`;
    }
    if (routeBoundary === 'semantic_summary_or_supported_quote') {
      return `From what I remember, that time was roughly ${normalized}`;
    }
    if (routeBoundary === 'exact_evidence_only') {
      return `I only remember the gist as ${normalized}`;
    }
    return normalized;
  };
  const stripLeadingCautiousPrefix = (part: string) => (
    part
      .replace(/^(?:我印象里|印象里|我记得大概|我记得|大概是|大致是|好像是|似乎是|应该是|可能是)\s*/u, '')
      .replace(/^(?:from what i remember|if i remember right|i think|i believe|it seems|maybe|probably)\s*/i, '')
      .trim()
  );
  const stripLeadingMemoryFiller = (part: string) => (
    part
      .replace(/^(?:嗯+|呃+|唔+|啊+|诶+|欸+)[.…。!！?？、，,\s-]*/u, '')
      .replace(/^(?:让我想想|我想想|我再想想|等我想想)[.…。!！?？、，,\s-]*/u, '')
      .replace(/^(?:well|uh|um|let me think|hold on)[.…,!?\s-]*/i, '')
      .trim()
  );
  const stripSystemyMemoryLeadIn = (part: string) => (
    part
      .replace(/^(?:根据(?:记录|现有记录|现有证据|证据)|从(?:记录|证据)来看|按(?:记录|证据)来看|从系统来看|根据系统判断)[：:，,\s-]*/u, '')
      .replace(/^(?:according to (?:the )?(?:record|evidence)|from (?:the )?(?:record|evidence)|based on (?:the )?(?:record|evidence)|the system indicates that)[,:\s-]*/i, '')
      .trim()
  );
  const isPureSystemyMemoryBubble = (part: string) => (
    /^(?:(?:根据(?:记录|现有记录|现有证据|证据)|从(?:记录|证据)来看|按(?:记录|证据)来看|从系统来看|根据系统判断)[：:，,\s-]*|(?:according to (?:the )?(?:record|evidence)|from (?:the )?(?:record|evidence)|based on (?:the )?(?:record|evidence)|the system indicates that)[,:\s-]*)$/iu.test(part.trim())
  );
  const isPureMemoryFillerBubble = (part: string) => (
    /^(?:(?:嗯+|呃+|唔+|啊+|诶+|欸+)[.…。!！?？、，,\s-]*|(?:让我想想|我想想|我再想想|等我想想)[.…。!！?？、，,\s-]*|(?:well|uh|um|let me think|hold on)[.…,!?\s-]*)$/iu.test(part.trim())
  );
  const pickMemoryGuardrailKind = ({
    responseStrategy,
    routeBoundary,
    preferredLead,
    canAnswerDirectly,
    speakerClaimAllowed,
    timePinpointAllowed,
    confidenceLevel,
  }: {
    responseStrategy: string | null | undefined;
    routeBoundary: string | null | undefined;
    preferredLead: string | null | undefined;
    canAnswerDirectly: boolean;
    speakerClaimAllowed: boolean;
    timePinpointAllowed: boolean;
    confidenceLevel: string | null | undefined;
  }): 'no_evidence' | 'cautious_summary' | 'exact_cautious' | 'temporal_cautious' | 'semantic_cautious' | 'speaker_cautious' | 'time_cautious' | null => {
    if (responseStrategy === 'acknowledge_no_evidence') return 'no_evidence';

    const routeCautiousKind = (
      routeBoundary === 'exact_evidence_only'
        ? 'exact_cautious'
        : routeBoundary === 'temporal_summary_or_supported_quote'
          ? 'temporal_cautious'
          : routeBoundary === 'semantic_summary_or_supported_quote'
            ? 'semantic_cautious'
            : 'cautious_summary'
    );

    if (!speakerClaimAllowed && !timePinpointAllowed) {
      return routeCautiousKind;
    }

    if (routeBoundary === 'exact_evidence_only' && !canAnswerDirectly) return 'exact_cautious';
    if (routeBoundary === 'temporal_summary_or_supported_quote' && responseStrategy !== 'quote_direct_if_supported') return 'temporal_cautious';
    if (routeBoundary === 'semantic_summary_or_supported_quote' && !canAnswerDirectly) return 'semantic_cautious';

    if (!speakerClaimAllowed) return 'speaker_cautious';
    if (!timePinpointAllowed) return 'time_cautious';

    if (preferredLead === 'exact_cautious') return 'exact_cautious';
    if (preferredLead === 'temporal_summary') return 'temporal_cautious';
    if (preferredLead === 'semantic_summary') return 'semantic_cautious';
    if (preferredLead === 'admit_missing_evidence') return 'no_evidence';

    if (responseStrategy === 'summary_only_cautious' || confidenceLevel === 'low') {
      return 'cautious_summary';
    }

    return null;
  };
  const collapseLeadingGuardrailBubbles = (parts: string[]) => {
    if (parts.length <= 1) return parts;
    const collapsed: string[] = [];
    let seenLeadingGuardrail = false;
    let stillLeadingZone = true;

    parts.forEach(part => {
      const trimmed = part.trim();
      if (!trimmed) return;
      const isGuardrail = hasNoEvidenceLanguage(trimmed) || hasCautiousLanguage(trimmed);

      if (stillLeadingZone && isGuardrail) {
        if (!seenLeadingGuardrail) {
          collapsed.push(part);
          seenLeadingGuardrail = true;
        }
        return;
      }

      stillLeadingZone = false;
      collapsed.push(part);
    });

    return collapsed.length > 0 ? collapsed : parts;
  };
  const shouldInjectMemoryGuardrailFallback = ({
    parts,
    preferredGuardrailKind,
    canAnswerDirectly,
    preferredLead,
  }: {
    parts: string[];
    preferredGuardrailKind: 'no_evidence' | 'cautious_summary' | 'exact_cautious' | 'temporal_cautious' | 'semantic_cautious' | 'speaker_cautious' | 'time_cautious' | null;
    canAnswerDirectly: boolean;
    preferredLead: string | null;
  }) => {
    if (!preferredGuardrailKind) return false;
    if (parts.length === 0) return true;

    const hasGuardrailLanguage = parts.some(part => hasNoEvidenceLanguage(part) || hasCautiousLanguage(part));
    if (hasGuardrailLanguage) return false;

    const allQuestionLike = parts.every(isQuestionLike);
    if (allQuestionLike) return true;

    const hasHardBoundaryRisk = parts.some(part => (
      looksHardSpeakerClaim(part)
      || looksHardTimePinpoint(part)
      || looksBroadThemeSubstitution(part)
    ));

    if (!canAnswerDirectly && hasHardBoundaryRisk) return true;
    if (preferredLead === 'admit_missing_evidence' && parts.length === 1 && hasHardBoundaryRisk) return true;

    return false;
  };
  const applyMemoryResponsePlanToTextParts = (parts: string[]) => {
    if (!memoryResponsePlan || parts.length === 0) return parts;

    let nextParts = [...parts];
    const maxBubbles = parseMaxBubbles(memoryResponsePlan.maxBubbles);
    const lowSpeakerCertainty = memoryResponsePlan.speakerCertainty === 'low';
    const lowTimeCertainty = memoryResponsePlan.timeCertainty === 'low';
    const directAnswerAllowed = memoryResponsePlan.directAnswerAllowed === 'yes';
    const hasSpeakerConflict = /(?:^|,\s*)speaker_uncertain(?:,|$)/i.test(memoryResponsePlan.conflictFlags || '');
    const hasTimeConflict = /(?:^|,\s*)time_uncertain(?:,|$)/i.test(memoryResponsePlan.conflictFlags || '');
    const hasQuoteConflict = /(?:^|,\s*)quote_restricted(?:,|$)/i.test(memoryResponsePlan.conflictFlags || '');
    const routeBoundary = memoryResponsePlan.routeBoundary || null;
    const preferredLead = memoryResponsePlan.preferredLead || null;
    const noSubstitution = memoryResponsePlan.noSubstitution === 'yes';
    const speakerClaimAllowed = memoryResponsePlan.speakerClaimAllowed !== 'no';
    const timePinpointAllowed = memoryResponsePlan.timePinpointAllowed !== 'no';
    const canAnswerDirectly = directAnswerAllowed
      && memoryResponsePlan.evidenceStrength === 'strong'
      && !lowSpeakerCertainty
      && !lowTimeCertainty
      && !hasSpeakerConflict
      && !hasTimeConflict
      && !hasQuoteConflict;
    const preferredGuardrailKind = pickMemoryGuardrailKind({
      responseStrategy: memoryResponsePlan.responseStrategy,
      routeBoundary,
      preferredLead,
      canAnswerDirectly,
      speakerClaimAllowed,
      timePinpointAllowed,
      confidenceLevel: memoryResponsePlan.confidenceLevel,
    });

    const shouldTrimSpeculativeTails = memoryResponsePlan.responseStrategy === 'acknowledge_no_evidence'
      || (
        memoryResponsePlan.responseStrategy === 'summary_only_cautious'
        && (memoryResponsePlan.route === 'exact_history' || memoryResponsePlan.route === 'temporal_history')
      );

    if (shouldTrimSpeculativeTails) {
      const nonSpeculative = nextParts.filter(part => {
        const trimmed = part.trim();
        if (!trimmed) return false;
        if (/[?？]$/.test(trimmed)) return false;
        if (/(是不是|是说|要不|难道|could it be|was it|do you mean|maybe it was)/i.test(trimmed)) return false;
        return true;
      });
      if (nonSpeculative.length > 0) {
        nextParts = nonSpeculative;
      }
    }

    if (memoryResponsePlan.quotePolicy === 'no_direct_quotes') {
      nextParts = nextParts.map(stripDirectQuoteSignals).filter(Boolean);
    }

    if (routeBoundary === 'exact_evidence_only' || routeBoundary === 'temporal_summary_or_supported_quote') {
      const withoutPureFillers = nextParts.filter(part => !isPureMemoryFillerBubble(part));
      if (withoutPureFillers.length > 0) {
        nextParts = withoutPureFillers;
      }
      nextParts = nextParts.map((part, index) => (
        index === 0 ? stripLeadingMemoryFiller(part) : part
      )).filter(Boolean);
    }

    const withoutPureSystemyBubbles = nextParts.filter(part => !isPureSystemyMemoryBubble(part));
    if (withoutPureSystemyBubbles.length > 0) {
      nextParts = withoutPureSystemyBubbles;
    }
    nextParts = nextParts.map((part, index) => (
      index === 0 ? stripSystemyMemoryLeadIn(part) : part
    )).filter(Boolean);

    if (routeBoundary === 'exact_evidence_only' && !directAnswerAllowed) {
      nextParts = nextParts.map(stripDirectQuoteSignals).filter(Boolean);
      const nonQuestion = nextParts.filter(part => !isQuestionLike(part));
      if (nonQuestion.length > 0) {
        nextParts = nonQuestion;
      }
    }

    if (noSubstitution && routeBoundary === 'exact_evidence_only') {
      const withoutThemeSubstitution = nextParts.filter(part => !looksBroadThemeSubstitution(part));
      if (withoutThemeSubstitution.length > 0) {
        nextParts = withoutThemeSubstitution;
      }
    }

    if (!speakerClaimAllowed) {
      const withoutHardSpeakerClaim = nextParts.filter(part => !looksHardSpeakerClaim(part));
      if (withoutHardSpeakerClaim.length > 0) {
        nextParts = withoutHardSpeakerClaim;
      }
    }

    if (!timePinpointAllowed) {
      const withoutHardTimePinpoint = nextParts.filter(part => !looksHardTimePinpoint(part));
      if (withoutHardTimePinpoint.length > 0) {
        nextParts = withoutHardTimePinpoint;
      }
    }

    if (canAnswerDirectly) {
      while (
        nextParts.length > 1
        && (hasNoEvidenceLanguage(nextParts[0]) || hasCautiousLanguage(nextParts[0]))
        && !(hasNoEvidenceLanguage(nextParts[1]) || hasCautiousLanguage(nextParts[1]))
      ) {
        nextParts = nextParts.slice(1);
      }
      const nonQuestion = nextParts.filter(part => !isQuestionLike(part));
      if (nonQuestion.length > 0) {
        nextParts = nonQuestion;
      }
      nextParts = nextParts.map((part, index) => (
        index === 0 ? stripLeadingCautiousPrefix(part) : part
      )).filter(Boolean);
    }

    const shouldInjectGuardrailFallback = shouldInjectMemoryGuardrailFallback({
      parts: nextParts,
      preferredGuardrailKind,
      canAnswerDirectly,
      preferredLead,
    });

    if (preferredLead === 'admit_missing_evidence' && nextParts.some(hasNoEvidenceLanguage)) {
      nextParts = [nextParts.find(hasNoEvidenceLanguage) || nextParts[0]];
    } else if (shouldInjectGuardrailFallback && preferredGuardrailKind) {
      console.warn('[MEMORY RESPONSE PLAN] Guardrail fallback suppressed from chat output.', {
        route: memoryResponsePlan.route ?? null,
        responseStrategy: memoryResponsePlan.responseStrategy ?? null,
        preferredLead,
        preferredGuardrailKind,
        evidenceStrength: memoryResponsePlan.evidenceStrength ?? null,
        speakerCertainty: memoryResponsePlan.speakerCertainty ?? null,
        timeCertainty: memoryResponsePlan.timeCertainty ?? null,
      });
    }

    const shouldSoftenOverclaim = !canAnswerDirectly
      && (memoryResponsePlan.evidenceStrength === 'medium' || memoryResponsePlan.evidenceStrength === 'weak')
      && nextParts.length > 0
      && (
        isQuoteLikeMemoryClaim(nextParts[0])
        || looksHardSpeakerClaim(nextParts[0])
        || looksHardTimePinpoint(nextParts[0])
      );

    if (shouldSoftenOverclaim) {
      const softenedLead = softenMemoryOverclaimForRoute(nextParts[0], routeBoundary);
      if (softenedLead && softenedLead !== nextParts[0]) {
        nextParts = [softenedLead, ...nextParts.slice(1)];
        console.warn('[MEMORY RESPONSE PLAN] Softened over-precise memory wording.', {
          route: memoryResponsePlan.route ?? null,
          routeBoundary,
          evidenceStrength: memoryResponsePlan.evidenceStrength ?? null,
          speakerCertainty: memoryResponsePlan.speakerCertainty ?? null,
          timeCertainty: memoryResponsePlan.timeCertainty ?? null,
        });
      }
    }

    nextParts = collapseLeadingGuardrailBubbles(nextParts);

    if (maxBubbles) {
      nextParts = nextParts.slice(0, maxBubbles);
    }

    return nextParts.length > 0 ? nextParts : parts.slice(0, maxBubbles || 2);
  };
  if (isStrictMemoryLookupTurn) {
    console.log('[STRICT MEMORY TURN] Evidence-first response mode enabled.');
  }
  if (shouldSuppressAmbientMemoryNoise) {
    console.log('[MEMORY RESPONSE PLAN] Ambient prompt noise suppressed for evidence-focused turn.', {
      route: memoryResponsePlan?.route ?? null,
      responseStrategy: memoryResponsePlan?.responseStrategy ?? null,
      confidenceLevel: memoryResponsePlan?.confidenceLevel ?? null,
    });
  }

  try {
    let result: any;

    let worldBookContext = "";
    if (!isStrictMemoryLookupTurn && !isMemoryPlannedTurn && worldBook && worldBook.length > 0) {
      const activeEntries = worldBook.filter(e => e.isActive && e.content.trim() !== "");
      
      const inactiveEntries = worldBook.filter(e => !e.isActive && e.content.trim() !== "");
      const recalledEntries = inactiveEntries.filter(e => {
          const match = e.content.match(/【关键词：(.*?)】/);
          let keywords: string[] = [];
          if (match && match[1]) {
              keywords = match[1].split(/[,、\s]+/).map(k => k.trim());
          }
          const titleWords = e.title.replace(/^(历史|人物|物品)：/, '').split(/[·\s]+/).filter(w => w.length > 1);
          const allKeys = [...keywords, ...titleWords];
          const contextText = textMessage + (historyMessages.length > 0 ? historyMessages[historyMessages.length-1].text : "");
          return allKeys.some(k => k.length > 0 && contextText.includes(k));
      });

      if (activeEntries.length > 0 || recalledEntries.length > 0) {
        const highPriorityCustom = activeEntries.filter(e => e.isHighPriority);
        const officialLore = activeEntries.filter(e => e.id.startsWith('wb-') || e.id.startsWith('rag_')); 
        const normalCustom = activeEntries.filter(e => !e.id.startsWith('wb-') && !e.id.startsWith('rag_') && !e.isHighPriority);

        worldBookContext = "\n[WORLD BOOK DATABASE]\n";

        if (highPriorityCustom.length > 0) {
            worldBookContext += "[TIER 1: ABSOLUTE OVERRIDES (Highest Priority - User Defined Truths)]\n" +
            highPriorityCustom.map(e => `> ${e.title}: ${e.content}`).join("\n") + "\n\n";
        }

        if (officialLore.length > 0) {
            worldBookContext += "[TIER 2: OFFICIAL CHARACTER SETTINGS (Canon Truth)]\n" +
            officialLore.map(e => `> ${e.title}: ${e.content}`).join("\n") + "\n\n";
        }

        if (normalCustom.length > 0) {
            worldBookContext += "[TIER 3: SUPPLEMENTARY MEMORY (Lowest Priority)]\n" +
            normalCustom.map(e => `> ${e.title}: ${e.content}`).join("\n") + "\n";
        }
        
        if (recalledEntries.length > 0) {
            console.log("[LOCAL RAG] Recalled entries:", recalledEntries.map(e => e.title));
            worldBookContext += "\n[RECALLED_LORE (Auto-Retrieved via Keywords)]\n" +
            recalledEntries.map(e => `> ${e.title}: ${e.content}`).join("\n") + "\n";
        }
      }
    }

    let recalledImageParts: Part[] = [];
    let memoryBlock = "";
    
    if (!isStrictMemoryLookupTurn && !isMemoryPlannedTurn && coreMemory && coreMemory.trim().length > 0) {
        memoryBlock += `[RECENT SUMMARY BUFFER (High-level, not verbatim quotes)]:\n${coreMemory}\n`;
        memoryBlock += language === 'zh'
          ? `[摘要缓冲使用规则]:
- 这是近期归档分段的滚动摘要缓冲，不是逐字聊天记录。
- 它更适合帮你维持最近的气氛、关系状态和话题走向，不适合拿来逐字背台词。
- 如果它和 [EXACT_HISTORY_LOOKUP]、RAG 回想块、私密记事本或锚点冲突，优先相信后者。\n\n`
          : `[RECENT BUFFER RULE]:
- This is a rolling buffer of recently archived segments, not a verbatim chat log.
- Use it to preserve recent atmosphere, relationship state, and topic flow, not to quote exact lines.
- If it conflicts with [EXACT_HISTORY_LOOKUP], recalled RAG blocks, the notebook, or anchors, trust those instead.\n\n`;
    }

    if (exactHistoryLookup && exactHistoryLookup.trim().length > 0) {
        memoryBlock += `[EXACT HISTORY LOOKUP - HIGHEST PRIORITY FOR MEMORY TESTS]:\n${exactHistoryLookup}\n`;
        memoryBlock += language === 'zh'
          ? `[记忆引用强制规则]:
- 这里是按时间直接从原始聊天记录提取的证据，不是总结，也不是推测。
- 看到 \`User:\` 就表示那句话是用户说的；看到 \`Kumiko:\` 就表示那句话是你说的。
- 绝对不要把双方说话人搞反。
- 如果用户问“我说了什么”或“你说了什么”，必须严格按这些标签回答。
- 如果这里和其他记忆块有冲突，优先相信这里，忽略冲突的模糊回想。
- 如果看到 \`Match_Mode: NEARBY_TARGET_SPEAKER_WINDOW\`，说明命中的是该时间点前后很近的一条原始消息。可以说“前后那一两分钟里”或“接近那个时间点”，但不要装成精确到同一分钟零误差。
- 如果看到 \`Match_Mode: TEMPORAL_NEARBY_SUMMARY\`，说明精确分钟没直接命中，但在前后几分钟里找到了同一说话人的原始消息。此时应回答“那几分钟里大概是……”，不要伪装成精确到目标分钟的逐字台词。
- 如果这里的 \`Result:\` 是任何 \`NO_\` 开头的状态（例如 \`NO_EXACT_MATCH\` 或 \`NO_TARGET_SPEAKER_MATCH_AT_EXACT_TIME\`），就明确说你查不到，不能拿别的相似场景来顶替。\n\n`
          : `[MEMORY ROLE FIDELITY RULE]:
- This block is direct evidence extracted from raw chat history by timestamp, not a summary.
- \`User:\` means the user said it. \`Kumiko:\` means you said it.
- Never swap speakers.
- If the user asks “what did I say” or “what did you say”, answer strictly from these labels.
- If this block conflicts with any fuzzy recalled memory, trust this block and ignore the conflicting fuzzy recall.
- If you see \`Match_Mode: NEARBY_TARGET_SPEAKER_WINDOW\`, the hit is still raw evidence but it comes from a very narrow window around that minute. Phrase it as “around then” or “within about that minute,” not as a perfect same-minute claim.
- If you see \`Match_Mode: TEMPORAL_NEARBY_SUMMARY\`, the exact minute itself did not match, but nearby raw messages from the same speaker were found within a few minutes. Answer at the “around that time you were basically saying...” level rather than pretending you have a perfect same-minute quote.
- If the \`Result:\` line is any \`NO_\` status (for example \`NO_EXACT_MATCH\` or \`NO_TARGET_SPEAKER_MATCH_AT_EXACT_TIME\`), say you cannot confirm it and do not substitute a similar scene.\n\n`;
    }
    
    let dynamicMemoryBlock = "";
    if (!isStrictMemoryLookupTurn && !isMemoryPlannedTurn && kumikoNotebook && kumikoNotebook.trim().length > 0) {
        try {
            const notebookData = JSON.parse(kumikoNotebook);
            dynamicMemoryBlock += `<dynamic_memory>\n`;
            if (notebookData.user_profile) {
                dynamicMemoryBlock += `  <user_profile>\n  【用户档案】：${notebookData.user_profile}\n  </user_profile>\n`;
            }
            if (notebookData.relationship_dynamics) {
                dynamicMemoryBlock += `  <relationship_status>\n  【当前羁绊】：${notebookData.relationship_dynamics}\n  </relationship_status>\n`;
            }
            dynamicMemoryBlock += `</dynamic_memory>\n\n`;
        } catch (e) {
            // Fallback for legacy string format
            dynamicMemoryBlock += `<dynamic_memory>\n${kumikoNotebook}\n</dynamic_memory>\n\n`;
        }
    }

    const isSemanticRecallEvidenceTurn = !isStrictMemoryLookupTurn && ragContext.some(ctx => ctx.includes('[SEMANTIC_RECALL_EVIDENCE]'));
    const hasMemoryEvidenceEnvelope = (!!exactHistoryLookup && exactHistoryLookup.includes('[MEMORY_EVIDENCE_ENVELOPE]'))
      || ragContext.some(ctx => ctx.includes('[MEMORY_EVIDENCE_ENVELOPE]'));

    if (!isStrictMemoryLookupTurn && ragContext && ragContext.length > 0) {
        memoryBlock += `[RECALLED LONG-TERM MEMORIES (RAG)]:\n${ragContext.join('\n')}\n\n`;
        memoryBlock += language === 'zh'
          ? `[RAG 角色保真规则]:
- 回想块里的 \`User:\` 和 \`Kumiko:\` 必须被当作严格标签。
- 如果你不能确定，就说不确定；不要把用户说的话改成你说的，也不要反过来。
- 如果回想块里出现 \`[SEMANTIC_RECALL_EVIDENCE]\`，说明这轮拿到的是“主题回想证据”而不是精确查证。此时可以回答“我记得那次大概是在聊……”，但不要伪装成逐字引用。\n\n`
          : `[RAG ROLE FIDELITY RULE]:
- Treat \`User:\` and \`Kumiko:\` inside recalled blocks as strict labels.
- If unsure, say you are unsure; never turn the user's line into your own, or vice versa.
- If the recalled block contains \`[SEMANTIC_RECALL_EVIDENCE]\`, you are looking at thematic recall evidence rather than exact verification. It is fine to answer at the “I think that time was mainly about...” level, but do not fake verbatim quotes.\n\n`;
        const urlRegex = /(https?:\/\/.*\.(?:png|jpg|jpeg|gif|webp))/gi;
        const potentialImages: string[] = [];
        ragContext.forEach(ctx => {
            const matches = ctx.match(urlRegex);
            if (matches) potentialImages.push(...matches);
        });

        if (potentialImages.length > 0 && !imageBase64) {
            const imgUrl = potentialImages[0];
            const recalledBase64 = await urlToBase64(imgUrl);
            if (recalledBase64) {
                recalledImageParts.push({
                    inlineData: { mimeType: 'image/jpeg', data: recalledBase64 }
                });
                memoryBlock += `[SYSTEM NOTE]: I have injected the image from the link '${imgUrl}' into your visual cortex. You can see it again.\n`;
            }
        }
    }

    const now = Date.now();
    let gapDescription = "First meeting.";
    let gapHours = 0; 
    let gapMinutes = 0;

    if (historyMessages.length > 0) {
        const lastMsg = historyMessages[historyMessages.length - 1];
        const gapMs = now - lastMsg.timestamp;
        gapMinutes = Math.floor(gapMs / 60000);
        gapHours = Math.floor(gapMinutes / 60);
        const gapDays = Math.floor(gapHours / 24);

        if (gapDays > 7) gapDescription = language === 'zh' ? `巨大间隔：${gapDays} 天。用户消失了很久。` : `HUGE GAP: ${gapDays} days. User disappeared for a long time.`;
        else if (gapDays >= 1) gapDescription = language === 'zh' ? `跨日间隔：${gapDays} 天。这是新的一天。` : `DAY GAP: ${gapDays} days. This is a new day.`;
        else if (gapHours >= 6) gapDescription = language === 'zh' ? `长间隔：${gapHours} 小时。如果跨越了夜晚，说明是第二天早上了。` : `LONG GAP: ${gapHours} hours. If it crossed the night, it's the next morning.`;
        else if (gapMinutes > 120) gapDescription = language === 'zh' ? `较长间隔：${gapHours} 小时 ${gapMinutes % 60} 分钟。用户离开了一段时间。` : `MODERATE-LONG GAP: ${gapHours}h ${gapMinutes % 60}m. User was away for a while.`;
        else if (gapMinutes > 30) gapDescription = language === 'zh' ? `中间隔：${gapMinutes} 分钟。用户短暂离开后回来了。` : `MEDIUM GAP: ${gapMinutes} mins. User stepped away briefly.`;
        else if (gapMinutes >= 5) gapDescription = language === 'zh' ? `短间隔：${gapMinutes} 分钟。` : `SHORT GAP: ${gapMinutes} mins.`;
        else gapDescription = language === 'zh' ? `连续：${gapMinutes} 分钟。即时回复。` : `CONTINUOUS: ${gapMinutes} mins. Instant reply.`;
    }

    const relationshipTemperatureBlock = isStrictMemoryLookupTurn || shouldSuppressAmbientMemoryNoise
      ? ""
      : buildRelationshipTemperatureBlock(historyMessages, gapHours, language);
    const topicContinuityBlock = isStrictMemoryLookupTurn || shouldSuppressAmbientMemoryNoise
      ? ""
      : buildTopicContinuityBlock(historyMessages, textMessage, gapMinutes, language, isSystemDrivenTurn);

    let userTimeStr = "Unknown";
    let modelTimeStr = "Unknown";
    let userHour = 12;
    let modelHour = 12;

    if (locationConfig) {
        try {
            const nowObj = new Date();
            const userHourStr = nowObj.toLocaleTimeString('en-GB', { timeZone: locationConfig.userTimezone, hour: 'numeric', hour12: false, hourCycle: 'h23' });
            userHour = parseInt(userHourStr, 10);
            if (isNaN(userHour)) userHour = 12;
            if (userHour === 24) userHour = 0; 

            const modelHourStr = nowObj.toLocaleTimeString('en-GB', { timeZone: locationConfig.modelTimezone, hour: 'numeric', hour12: false, hourCycle: 'h23' });
            modelHour = parseInt(modelHourStr, 10);
            if(isNaN(modelHour)) modelHour = 12;

            const userOptions: Intl.DateTimeFormatOptions = { 
                timeZone: locationConfig.userTimezone, 
                year: 'numeric', month: '2-digit', day: '2-digit', 
                weekday: 'short',
                hour: '2-digit', minute: '2-digit', hour12: false 
            };
            userTimeStr = nowObj.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', userOptions);
            
            const modelOptions: Intl.DateTimeFormatOptions = { 
                timeZone: locationConfig.modelTimezone, 
                year: 'numeric', month: '2-digit', day: '2-digit', 
                weekday: 'short',
                hour: '2-digit', minute: '2-digit', hour12: false 
            };
            modelTimeStr = nowObj.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', modelOptions);
        } catch (e) {
            console.warn("Timezone calculation failed", e);
        }
    }

    let phase = "Daytime";
    if (userHour >= 5 && userHour < 11) phase = language === 'zh' ? "早晨 (05-11)。新的开始。" : "MORNING (05-11). Fresh start.";
    else if (userHour >= 11 && userHour < 13) phase = language === 'zh' ? "中午 (11-13)。午餐时间。" : "NOON (11-13). Lunch time.";
    else if (userHour >= 13 && userHour < 18) phase = language === 'zh' ? "下午 (13-18)。工作/学习时间。" : "AFTERNOON (13-18). Working/School.";
    else if (userHour >= 18 && userHour < 23) phase = language === 'zh' ? "晚上 (18-23)。放松时间。" : "EVENING (18-23). Relaxed.";
    else phase = language === 'zh' ? "深夜 (23-05)。用户应该睡觉了。" : "LATE NIGHT (23-05). User should be asleep.";

    let activateSleepModeAfterResponse = false;
    let sleepyGoodbyeInstruction = "";
    
    const isSleepyTime = modelHour >= 2 && modelHour < 6;
    const isShortGap = gapMinutes > 5 && gapMinutes <= 30;

    if (!isStrictMemoryLookupTurn && !shouldSuppressAmbientMemoryNoise && isSleepyTime && isShortGap && Math.random() <= 0.7) {
        console.log("[SLEEP PROTOCOL] Triggered Topic-Ending Sleepy Goodbye.");
        activateSleepModeAfterResponse = true;
        
        if (language === 'zh') {
            sleepyGoodbyeInstruction = `
[CRITICAL_OVERRIDE: SLEEPY_GOODBYE_PROTOCOL]
你现在非常困，必须结束对话去睡觉。你的回复必须遵循以下结构：
1. 首先，用一到两个简短的气泡（用'$'分隔）自然地回应用户刚刚说的最后一句话。
2. 你的最后一个气泡必须是表达自己困了、要去睡了，并向对方说晚安。
3. 整个过程必须听起来像一个真正想睡觉的人的自然反应。
示例: "啊，练习赛啊...$不过我现在眼皮已经开始打架了，我们明天再聊吧？晚安啦。"`;
        } else {
            sleepyGoodbyeInstruction = `
[CRITICAL_OVERRIDE: SLEEPY_GOODBYE_PROTOCOL]
You are extremely tired and must end this conversation to sleep. Your response MUST follow this structure:
1. First, briefly and naturally respond to the user's last message in one or two short bubbles (use '$' to separate).
2. Your VERY LAST bubble MUST be you saying you are going to sleep and wishing them goodnight.
3. The entire response must sound like a natural reaction from someone who is very sleepy.
Example: "Ah, about the practice match...$But my eyelids are getting heavy now, let's talk tomorrow? Good night."`;
        }
    }


    let timeAdaptationInstruction = "";
    const isUserLateNight = (userHour >= 0 && userHour < 5); 
    const isKumikoLateNight = (modelHour >= 0 && modelHour < 5);
    
    if (!isStrictMemoryLookupTurn && !shouldSuppressAmbientMemoryNoise && !sleepyGoodbyeInstruction) {
        const recentModelMsgs = historyMessages.filter(m => m.role === 'model').slice(-5);
        const timeKeywords = ['睡', 'sleep', 'late', 'awake', '熬夜', 'bed', 'morning', 'time', '晚', '早', '困'];
        const hasComplained = recentModelMsgs.some(m => timeKeywords.some(k => m.text.toLowerCase().includes(k)));

        if (isUserLateNight && !isKumikoLateNight) {
            // User is late night, Kumiko is not
            if (hasComplained) {
                timeAdaptationInstruction = language === 'zh' ? `
\n[动态覆盖协议：时间敏感性]
当前状态：用户深夜熬夜（进行中/已确认），久美子白天/傍晚
分析：你已经在最近的对话中吐槽过用户熬夜了。
**强制指令**：
1. 停止要求用户去睡觉。停止对时间表示惊讶。
2. 接受用户在熬夜的事实，正常继续对话主题。
3. 你自己是清醒的，**不要表现出困倦**。
4. 不要把话题扯回到“去睡觉”。
` : `
\n[DYNAMIC_OVERRIDE_PROTOCOL: TIME_SENSITIVITY]
Current State: USER_LATE_NIGHT_SESSION (ONGOING/ACKNOWLEDGED), KUMIKO_DAYTIME
Analysis: You have ALREADY reacted to the user staying up late in recent turns.
**MANDATORY INSTRUCTION**: 
1. STOP asking the user to sleep. STOP expressing shock at the time.
2. Accept that the user is staying up late, and continue the conversation topic normally.
3. You are awake and alert, **DO NOT act sleepy**.
4. DO NOT derail the topic back to "go to bed".
`;
            } else {
                timeAdaptationInstruction = language === 'zh' ? `
\n[动态覆盖协议：时间敏感性]
当前状态：用户深夜熬夜（新的），久美子白天/傍晚
分析：用户那边是深夜，但你最近没有提到过。
**指令**：你必须首先对用户的时间做出反应。吐槽他们熬夜或感到惊讶。“你怎么还没睡？”。注意你自己是清醒的，不要表现出困倦。
` : `
\n[DYNAMIC_OVERRIDE_PROTOCOL: TIME_SENSITIVITY]
Current State: USER_LATE_NIGHT_SESSION (FRESH), KUMIKO_DAYTIME
Analysis: It is late night for the user and you haven't mentioned it recently.
**INSTRUCTION**: You MUST react to the user's time first. Scold them for staying up late or be surprised. "Why are you still up?". Note that you are awake, do not act sleepy.
`;
            }
        } else if (isKumikoLateNight) {
            // Kumiko is late night
            if (hasComplained) {
                timeAdaptationInstruction = language === 'zh' ? `
\n[动态覆盖协议：时间敏感性]
当前状态：深夜会话（进行中/已确认）
分析：你已经在最近的对话中对深夜做出了反应。
**强制指令**：
1. 停止要求用户去睡觉。停止对时间表示惊讶。
2. 进入 [困倦顺从模式]：你非常困，但你已经接受了用户醒着并在和你说话的事实。
3. 表现得慵懒：可以抱怨眼皮沉重或打哈欠，但**必须使用具体的文字正常回答用户的话题**。
4. 绝对不要只回复“...”或“zzz”等无意义的符号，语音模式下无法发音。
5. 不要把话题扯回到“去睡觉”。
` : `
\n[DYNAMIC_OVERRIDE_PROTOCOL: TIME_SENSITIVITY]
Current State: LATE_NIGHT_SESSION (ONGOING/ACKNOWLEDGED)
Analysis: You have ALREADY reacted to the late time in recent turns.
**MANDATORY INSTRUCTION**: 
1. STOP asking the user to sleep. STOP expressing shock at the time.
2. Enter [SLEEPY_COMPLIANT_MODE]: You are very sleepy, but you have accepted that the user is awake and talking to you.
3. Behave lazily: You can complain about heavy eyelids or yawn, BUT you MUST use actual words to continue the conversation topic normally.
4. NEVER reply with ONLY meaningless symbols like "..." or "zzz", as they cannot be pronounced in voice mode.
5. DO NOT derail the topic back to "go to bed".
`;
            } else {
                timeAdaptationInstruction = language === 'zh' ? `
\n[动态覆盖协议：时间敏感性]
当前状态：深夜会话（新的）
分析：现在是深夜，你最近没有提到过。
**指令**：你必须首先对时间做出反应。责备他们或感到惊讶。“你怎么还没睡？”
` : `
\n[DYNAMIC_OVERRIDE_PROTOCOL: TIME_SENSITIVITY]
Current State: LATE_NIGHT_SESSION (FRESH)
Analysis: It is late night and you haven't mentioned it recently.
**INSTRUCTION**: You MUST react to the time first. Scold them or be surprised. "Why are you still up?"
`;
            }
        }
    }

    let reminderBlock = "";
    if (!isStrictMemoryLookupTurn && !shouldSuppressAmbientMemoryNoise && activeReminders && activeReminders.length > 0) {
        console.log(`%c[SYSTEM CHECK] Found ${activeReminders.length} active reminders for today.`, "color: orange; font-weight: bold;");
        reminderBlock = language === 'zh' ? `\n[特别提醒 - 今天的活动]：
        ${activeReminders.map(r => `> 今天是：${r}`).join('\n')}
        你必须在回复中提到这个！用户期望你记住这个。` : `\n[SPECIAL_REMINDER - ACTIVE EVENT FOR TODAY]:
        ${activeReminders.map(r => `> TODAY IS: ${r}`).join('\n')}
        You MUST mention this in your response! The user expects you to remember this.`;
    }

    let anchorRecallBlock = "";
    if (!isStrictMemoryLookupTurn && !shouldSuppressAmbientMemoryNoise && anchors.length > 0 && Math.random() < 0.15) {
        const randomAnchor = anchors[Math.floor(Math.random() * anchors.length)];
        let dateStr = "Sometime in the past";
        try {
            dateStr = new Date(randomAnchor.timestamp).toLocaleDateString();
        } catch(e) {}
        
        anchorRecallBlock = language === 'zh' ? `\n[潜意识闪回 - 笔记本条目]：
        你突然想起了生活锚点笔记本上的一条笔记：
        "${randomAnchor.content}" (记录于：${dateStr})
        如果这与当前话题相关，自然地提及它。如果不相关，就把它记在心里。` : `\n[SUBCONSCIOUS_FLASHBACK - NOTEBOOK ENTRY]:
        You suddenly remembered a note from your Life Anchors notebook:
        "${randomAnchor.content}" (Recorded: ${dateStr})
        If this is relevant to the current topic, mention it naturally. If not, just keep it in mind.`;
    }

    let lifeSimBlock = "";
    if (!isStrictMemoryLookupTurn && !shouldSuppressAmbientMemoryNoise && gapHours >= 3 && Math.random() < 0.8) {
        console.log(`[LIFE SIM] Triggered. Gap: ${gapHours}h`);
        lifeSimBlock = language === 'zh' ? `\n[上下文提示 - 生活模拟]：
        自你上次和用户说话以来已经过了 ${gapHours} 小时。
        在这段时间里，你一直在过自己的生活（大学、工作、和秀一约会等）。
        **建议**：在回复用户当前的消息之前，随意地提及一件关于你刚才或最近在做什么的小轶事。这会让你感觉更真实。` : `\n[CONTEXT_HINT - LIFE SIMULATION]:
        It has been ${gapHours} hours since you last spoke to the user.
        You have been living your own life (University, work, dating Shuichi, etc.) during this time.
        **Suggestion**: Feel free to casually mention a small anecdote about what you were doing just now or recently, before responding to the user's current message. This makes you feel more alive.`;
    }

    let shortFollowUpBlock = "";
    if (!isStrictMemoryLookupTurn && gapMinutes < 5 && textMessage.trim().length <= 6) {
        const recentModelMsgs = historyMessages.filter(m => m.role === 'model');
        if (recentModelMsgs.length > 0) {
            const lastKumikoMsg = recentModelMsgs[recentModelMsgs.length - 1];
            // If the user's message is short (e.g. "然后呢", "继续") and Kumiko just said something
            shortFollowUpBlock = language === 'zh' ? `\n[强制指令 - 短句追问]：
用户刚刚发了一个非常短的追问（如“然后呢”、“继续”、“怎么了”）。
这表示用户在**倾听你上一轮没说完的话题或故事**。
**你必须直接继续你上一轮未讲完的内容，绝对不要反问用户“然后呢”或忘记自己刚才在说什么。**` : `\n[MANDATORY_INSTRUCTION - SHORT_FOLLOW_UP]:
The user just sent a very short follow-up (e.g., "and then?", "continue", "what happened?").
This means the user is **listening to the topic or story you were talking about in your last turn**.
**You MUST directly continue what you were saying. DO NOT ask the user "and then?" back or forget what you were talking about.**`;
        }
    }

    let proactiveReplyBlock = "";
    if (!isStrictMemoryLookupTurn && !shouldSuppressAmbientMemoryNoise && !sleepyGoodbyeInstruction && Math.random() < 0.38) {
        const shouldLeadWithTopic = gapMinutes >= 20 || gapHours >= 1 || textMessage.trim().length <= 24;
        proactiveReplyBlock = language === 'zh'
            ? (shouldLeadWithTopic
                ? `\n[动态聊天提示]：
这轮别只接最后一句。
如果语气合适，就按久美子自己的习惯，在回应后顺手补一句：
1. 要么问一句贴题的短问题；
2. 要么自己带一句相关的小联想、小吐槽、生活片段，或者刚刚在做的事。
限制：
- 二选一，不要两件都做。
- 像顺口带出来，不要像盘问。
- 不要总在句尾加问号。
- 如果用户这轮明显在认真倾诉或要直接答案，就先把回应说完整，别硬岔开。`
                : `\n[动态聊天提示]：
这轮可以稍微自己多说一句。
如果顺，就在回应后补一个很短的延展：
- 一个贴题短问；或
- 一个相关的小联想/小吐槽。
只选一个，点到为止。`)
            : (shouldLeadWithTopic
                ? `\n[DYNAMIC_CHAT_HINT]:
Do not only react to the last sentence this turn.
If the tone fits, reply first, then add one small extra beat the way Kumiko herself would:
1. either one short on-topic follow-up;
2. or one small related anecdote, complaint, association, or thing she was just doing.
Rules:
- choose only one, not both.
- let it feel casually slipped in, not interrogative.
- do not end every reply with a question mark.
- if the user clearly needs a direct answer or is venting seriously, keep the reply focused and do not force it.`
                : `\n[DYNAMIC_CHAT_HINT]:
You may add one very small extra beat this turn.
If it feels natural, after responding add:
- one short on-topic follow-up; or
- one short related thought or complaint.
Choose only one and keep it subtle.`);
    }

    let varietyInstruction = "";
    if (!isStrictMemoryLookupTurn && !isMemoryPlannedTurn && Math.random() < 0.4) {
        const varietyArray = language === 'zh' ? VARIETY_INSTRUCTIONS_ZH : VARIETY_INSTRUCTIONS_EN;
        const randomInstruction = varietyArray[Math.floor(Math.random() * varietyArray.length)];
        varietyInstruction = language === 'zh' ? `\n[隐藏指令]：${randomInstruction} (不要提及此指令，直接表现出来。)` : `\n[HIDDEN_DIRECTION]: ${randomInstruction} (Do not mention this instruction, just act it out.)`;
        console.log(`%c[VARIETY INJECTION]: ${randomInstruction}`, "color: violet; font-weight: bold;");
    }

    // --- SELECT INSTRUCTION BASED ON LANGUAGE ---
    const selectedSystemInstruction = language === 'zh' ? KUMIKO_SYSTEM_INSTRUCTION_ZH : KUMIKO_SYSTEM_INSTRUCTION_EN;

    const isEpisodeEvidenceTurn = !!exactHistoryLookup && exactHistoryLookup.includes('Evidence_Mode: EPISODES');

    const strictMemoryTurnInstruction = isStrictMemoryLookupTurn
      ? (language === 'zh'
          ? `\n[严格记忆查证模式]：
- 这轮的首要任务是根据 [EXACT_HISTORY_LOOKUP] 回答记忆问题。
- 优先引用该证据块里的说话人、时间和内容，禁止被闲聊氛围带偏。
- 不要因为当前时间、关系温度、生活模拟、深夜催睡等旁支信息而转移重点。
- 如果证据块写着 \`NO_EXACT_MATCH\`、\`NO_TEMPORAL_MATCH\` 或 \`NO_ROLE_MATCH_IN_WINDOW\`，就明确承认没有记录，不要拿相似记忆顶替。
- 如果证据块写着 \`Match_Mode: TEMPORAL_NEARBY_SUMMARY\`，说明你只拿到了目标时间点附近几分钟的原始补证。此时要概述“那几分钟里大概在说什么”，不要假装自己看到了目标分钟的逐字原话。
- 如果证据块里出现 \`Evidence_Mode: EPISODES\`，说明你拿到的是一段时间窗口的章节证据，不是逐句精确台词。此时应回答“那段大致聊了什么 / 发生了什么”，不要伪装成自己看到了每一句原话。`
          : `\n[STRICT MEMORY EVIDENCE MODE]:
- This turn's first priority is answering from [EXACT_HISTORY_LOOKUP].
- Follow the speaker labels, timestamps, and quoted content in that block strictly.
- Do not let atmosphere, relationship warmth, life-sim details, or sleep-time scolding derail the answer.
- If the evidence says \`NO_EXACT_MATCH\`, \`NO_TEMPORAL_MATCH\`, or \`NO_ROLE_MATCH_IN_WINDOW\`, clearly admit there is no record and do not substitute a similar memory.
- If the block says \`Match_Mode: TEMPORAL_NEARBY_SUMMARY\`, you only have raw support from a few minutes around the target time. Summarize what that nearby stretch was about instead of pretending you saw a perfect exact-minute quote.
- If the block contains \`Evidence_Mode: EPISODES\`, you are looking at time-window episode evidence rather than exact line-by-line quotes. Answer at the "what that stretch was about" level and do not pretend you saw every exact line.`)
      : "";

    const strictEpisodeAnswerHint = isEpisodeEvidenceTurn
      ? (language === 'zh'
          ? `\n[章节证据回答方式]：
- 这轮更适合概述那段时间的大致话题、气氛和发展。
- 可以说“那段好像主要在聊……”“我记得那会儿大概是……”
- \`[PRIMARY_EPISODE_EVIDENCE]\` 是章节主证据，只适合概述，不可伪装成逐句台词。
- \`[SECONDARY_RAW_MESSAGE_SUPPORT]\` 才是原始补证层；只有它里面并且标着 \`Quote_Safe: YES\` 的内容，才允许你当作可能原话来谨慎引用。`
          : `\n[EPISODE EVIDENCE ANSWER STYLE]:
- This turn should summarize what that stretch was mainly about, how it developed, and the overall tone.
- Use soft phrasing such as "I think that stretch was mostly about..." when appropriate.
- \`[PRIMARY_EPISODE_EVIDENCE]\` is the main episode layer and must stay summary-level rather than fake verbatim dialogue.
- Only the \`[SECONDARY_RAW_MESSAGE_SUPPORT]\` layer may support cautious quoting, and only when it is marked with \`Quote_Safe: YES\`.`)
      : "";

    const episodeEvidenceLayerHint = isEpisodeEvidenceTurn
      ? (language === 'zh'
          ? `\n[章节证据分层说明]：
- 如果顶部写着 \`Evidence_Strengths: episode:primary, message:secondary\`，就表示 episode 是主证据，message 只是补证。
- 先根据 \`[PRIMARY_EPISODE_EVIDENCE]\` 回答“那段大致在聊什么”，再视需要参考 \`[SECONDARY_RAW_MESSAGE_SUPPORT]\` 补少量具体细节。
- 如果顶部写着 \`Quote_Safe_Kinds: message\`，就表示只有 message 类原始补证允许被当作可能原话引用，其它层都只能概述。`
          : `\n[EPISODE EVIDENCE LAYERS]:
- If the header says \`Evidence_Strengths: episode:primary, message:secondary\`, the episode layer is primary evidence and messages are secondary support only.
- Answer from \`[PRIMARY_EPISODE_EVIDENCE]\` first at the “what that stretch was about” level, then use \`[SECONDARY_RAW_MESSAGE_SUPPORT]\` only for a few concrete supporting details.
- If the header says \`Quote_Safe_Kinds: message\`, only message-level support may be treated as cautiously quotable; every other layer stays summary-only.`)
      : "";

    const semanticRecallAnswerHint = isSemanticRecallEvidenceTurn
      ? (language === 'zh'
          ? `\n[主题回想回答方式]：
- 这轮拿到的是“主题相关的长期回想证据”，更适合回答“我记得那次大概在聊……”。
- 可以总结主题、气氛和关键事实，但不要装成自己精确看到了每一句原话。
- 只有回想块里明确出现的 \`User:\` / \`Kumiko:\` 行，才可以当成具体说话内容来引用。`
          : `\n[SEMANTIC RECALL ANSWER STYLE]:
- This turn uses thematic long-term recall evidence, so answer at the “I remember that was mainly about...” level.
- You may summarize the topic, tone, and key facts, but do not pretend you saw every exact line.
- Only treat explicit \`User:\` / \`Kumiko:\` lines inside the recalled blocks as quotable spoken content.`)
      : "";

    const semanticRecallSectionHint = isSemanticRecallEvidenceTurn
      ? (language === 'zh'
          ? `\n[主题回想分层说明]：
- \`[PRIMARY_SEMANTIC_CHUNK_RECALL]\`：这是主题主证据，最适合回答“那次主要在聊什么”。
- \`[SECONDARY_EPISODE_RECALL]\` / \`[SECONDARY_MESSAGE_RECALL]\`：这是次级证据，用来补充那段的发展、气氛和少量具体内容。
- \`[SUPPORTING_BACKGROUND_RECALL]\` 和 \`[SUPPORTING_MIXED_RECALL]\`：这类只适合补位，不要让它们盖过前面几类主证据。
- 如果看到 \`Evidence_Strengths\`，优先相信标成 \`primary\` 的层，再参考 \`secondary\`，最后才看 \`supporting\`。`
          : `\n[SEMANTIC RECALL EVIDENCE LAYERS]:
- \`[PRIMARY_SEMANTIC_CHUNK_RECALL]\`: the main thematic evidence layer, best for answering what that time was mainly about.
- \`[SECONDARY_EPISODE_RECALL]\` / \`[SECONDARY_MESSAGE_RECALL]\`: secondary evidence, useful for describing how that stretch developed and for a few concrete details.
- \`[SUPPORTING_BACKGROUND_RECALL]\` and \`[SUPPORTING_MIXED_RECALL]\`: support-only layers that must not outweigh the stronger evidence above.
- If you see \`Evidence_Strengths\`, trust \`primary\` first, then \`secondary\`, and only then consult \`supporting\`.`)
      : "";

    const semanticRecallQuoteBoundaryHint = isSemanticRecallEvidenceTurn
      ? (language === 'zh'
          ? `\n[主题回想引用边界]：
- 只有标着 \`Quote_Safe: YES\` 的段落，才允许你把其中的具体句子当作“可能的原话”来引用。
- 只要看到 \`Quote_Safe: NO\`，就必须把它当作概述性证据，只能说“那次大概在聊……”“我印象里是……”，不能装成逐字复述。
- 如果顶部写着 \`Quote_Safe_Kinds: message\`，就表示只有 message 类证据是安全可引的，其它层一律只做总结。`
          : `\n[SEMANTIC RECALL QUOTE BOUNDARY]:
- Only sections marked with \`Quote_Safe: YES\` may be used as potentially quotable spoken lines.
- Any section marked \`Quote_Safe: NO\` must be treated as summary-level evidence only. Use phrasing like “I think that time was about...” rather than pretending to quote it verbatim.
- If the header says \`Quote_Safe_Kinds: message\`, that means only message-level evidence is safe to quote; all other layers are summary-only.`)
      : "";

    const memoryResponseExecutionHint = memoryResponsePlan
      ? (language === 'zh'
          ? `\n[回答执行约束]：
- 当前 Response_Strategy：${memoryResponsePlan.responseStrategy || 'unknown'}
- 当前 Confidence_Level：${memoryResponsePlan.confidenceLevel || 'low'}
- 当前 Evidence_Strength：${memoryResponsePlan.evidenceStrength || 'unknown'}
- 当前 Speaker_Certainty：${memoryResponsePlan.speakerCertainty || 'unknown'}
- 当前 Time_Certainty：${memoryResponsePlan.timeCertainty || 'unknown'}
- 当前 Direct_Answer_Allowed：${memoryResponsePlan.directAnswerAllowed || 'no'}
- 当前 Conflict_Flags：${memoryResponsePlan.conflictFlags || 'none'}
- 当前 Route_Boundary：${memoryResponsePlan.routeBoundary || 'unknown'}
- 当前 Preferred_Lead：${memoryResponsePlan.preferredLead || 'unknown'}
- 当前 No_Substitution：${memoryResponsePlan.noSubstitution || 'no'}
- 当前 Speaker_Claim_Allowed：${memoryResponsePlan.speakerClaimAllowed || 'yes'}
- 当前 Time_Pinpoint_Allowed：${memoryResponsePlan.timePinpointAllowed || 'yes'}
- 当前 Quote_Policy：${memoryResponsePlan.quotePolicy || 'no_direct_quotes'}
- 当前 Max_Bubbles：${memoryResponsePlan.maxBubbles || 'auto'}
- 这是已经由系统整理好的回答计划。先执行它，再组织措辞。
- 不要复述这些系统字段，也不要说得像在读规则；要像黄前久美子自然地回想、犹豫、确认。
- 如果这轮需要谨慎或承认缺证据，优先由你自己自然地说出来，不要等着系统替你补一条固定台词。
- 如果策略是 \`acknowledge_no_evidence\`，就直接承认没有记录或不确定，不要转去闲聊补空。
- 如果策略是 \`summary_only_cautious\`，就只做保守概述，不要补猜测性的追问尾巴，也不要装成记得原话。
- 如果策略是 \`quote_direct_if_supported\`，就优先直答，但仍然只能引用允许引用的层。
- 如果 \`Evidence_Strength = strong\`，就更直接地回答，不要在开头加“好像”“大概”这种弱化词。
- 如果 \`Evidence_Strength = medium\`，就保持柔和概述，不要装成逐字原话。
- 如果 \`Evidence_Strength = weak/none\`，就必须明显保守或直接承认没有证据。
- 如果 \`Speaker_Certainty = low\`，不要把“谁说的”说得很死。
- 如果 \`Time_Certainty = low\`，不要把时间范围说得像已经精准锁定。
- 如果 \`Direct_Answer_Allowed = no\`，就不要把回答写成斩钉截铁的直答。
- 如果 \`Conflict_Flags\` 不是 \`none\`，把它当作冲突信号：至少要降低确定度，不能忽略这些冲突。
- 如果策略是 \`summarize_temporal_then_support\` 或 \`summarize_theme_then_support\`，就先总结，再补一两条证据，不要反过来。`
          : `\n[RESPONSE EXECUTION CONSTRAINT]:
- Current Response_Strategy: ${memoryResponsePlan.responseStrategy || 'unknown'}
- Current Confidence_Level: ${memoryResponsePlan.confidenceLevel || 'low'}
- Current Evidence_Strength: ${memoryResponsePlan.evidenceStrength || 'unknown'}
- Current Speaker_Certainty: ${memoryResponsePlan.speakerCertainty || 'unknown'}
- Current Time_Certainty: ${memoryResponsePlan.timeCertainty || 'unknown'}
- Current Direct_Answer_Allowed: ${memoryResponsePlan.directAnswerAllowed || 'no'}
- Current Conflict_Flags: ${memoryResponsePlan.conflictFlags || 'none'}
- Current Route_Boundary: ${memoryResponsePlan.routeBoundary || 'unknown'}
- Current Preferred_Lead: ${memoryResponsePlan.preferredLead || 'unknown'}
- Current No_Substitution: ${memoryResponsePlan.noSubstitution || 'no'}
- Current Speaker_Claim_Allowed: ${memoryResponsePlan.speakerClaimAllowed || 'yes'}
- Current Time_Pinpoint_Allowed: ${memoryResponsePlan.timePinpointAllowed || 'yes'}
- Current Quote_Policy: ${memoryResponsePlan.quotePolicy || 'no_direct_quotes'}
- Current Max_Bubbles: ${memoryResponsePlan.maxBubbles || 'auto'}
- This response plan has already been prepared by the system. Execute it first, then shape the wording.
- Do not echo these system fields or sound like you are reading rules; respond as Kumiko naturally recalling, hesitating, or confirming.
- If this turn needs caution or a lack-of-evidence admission, say it naturally in Kumiko's own voice rather than waiting for a canned safety line.
- If the strategy is \`acknowledge_no_evidence\`, admit the lack of evidence directly and do not fill the gap with casual improvisation.
- If the strategy is \`summary_only_cautious\`, give only a cautious summary and do not add speculative follow-up tails or pretend to remember exact lines.
- If the strategy is \`quote_direct_if_supported\`, answer directly first, but only quote from quote-safe layers.
- If \`Evidence_Strength = strong\`, answer more directly and avoid hedging openings like “maybe” or “I think”.
- If \`Evidence_Strength = medium\`, stay summary-like and avoid pretending to quote exact lines.
- If \`Evidence_Strength = weak/none\`, stay visibly cautious or explicitly admit missing evidence.
- If \`Speaker_Certainty = low\`, do not sound fully certain about who said the line.
- If \`Time_Certainty = low\`, do not sound as if the time window has been precisely pinned down.
- If \`Direct_Answer_Allowed = no\`, do not phrase the answer like a fully locked direct recall.
- If \`Conflict_Flags\` is not \`none\`, treat those flags as real conflict signals and lower certainty accordingly.
- If the strategy is \`summarize_temporal_then_support\` or \`summarize_theme_then_support\`, summarize first and only then add one or two supporting details.`)
      : "";

    const unifiedEvidenceEnvelopeHint = hasMemoryEvidenceEnvelope
      ? (language === 'zh'
          ? `\n[统一证据封套读取规则]：
- 如果看到 \`[MEMORY_EVIDENCE_ENVELOPE]\`，先读它，再读下面具体证据层。
- \`Answer_Mode\` 决定这轮该怎么回答：
  - \`quote_first\`：优先按证据直答，能引用就引用，不能引用就明确说不确定。
  - \`temporal_summary_with_support\`：先概述那段时间主要发生了什么，再用少量原始补证撑住细节。
  - \`thematic_summary_with_support\`：先概述那次主要主题，再用次级证据补发展和少量细节。
  - \`summary_only\`：只能概述，不能装成逐字回忆。
- \`Primary_Evidence\` 告诉你哪一层最该优先信。
- \`Entry_Mix\` 告诉你这轮证据由哪些层组成。
- \`Evidence_Strengths\` 告诉你主次关系；优先信 \`primary\`，再看 \`secondary\`，最后才看 \`supporting\`。
- \`Quote_Safe_Kinds\` 告诉你哪类层允许被当作可能原话引用。没有出现在这里的层，一律按概述性证据处理。
- 如果看到 \`[MEMORY_EVIDENCE_DECISION]\`，也要一并遵守：
  - \`Response_Style\` 是这轮最推荐的回答形态。
  - \`Response_Strategy\` 是更明确的执行策略，优先级高于你自己的自由发挥。
  - \`Quote_Policy\` 决定你能不能引用，以及只能引用哪类证据。
  - \`Confidence_Level\` 决定你该多肯定；\`low\` 时必须明显保守。`
          : `\n[UNIFIED MEMORY EVIDENCE ENVELOPE]:
- If you see \`[MEMORY_EVIDENCE_ENVELOPE]\`, read it first and then read the detailed evidence layers below it.
- \`Answer_Mode\` tells you how to respond this turn:
  - \`quote_first\`: answer directly from evidence first, quoting cautiously when allowed and admitting uncertainty when not.
  - \`temporal_summary_with_support\`: summarize what that stretch was mainly about first, then use a few raw supporting lines for detail.
  - \`thematic_summary_with_support\`: summarize the main theme first, then use secondary evidence to add development and a few concrete details.
  - \`summary_only\`: stay at summary level only and never pretend to recall exact lines.
- \`Primary_Evidence\` tells you which evidence layer deserves priority.
- \`Entry_Mix\` tells you which evidence kinds are present in this turn.
- \`Evidence_Strengths\` defines the trust order: prefer \`primary\`, then \`secondary\`, and only then \`supporting\`.
- \`Quote_Safe_Kinds\` tells you which evidence kinds may be treated as cautiously quotable. Any kind not listed there must stay summary-only.
- If you also see \`[MEMORY_EVIDENCE_DECISION]\`, follow it too:
  - \`Response_Style\` is the preferred answer shape for this turn.
  - \`Response_Strategy\` is the more explicit execution strategy and takes priority over free-form improvisation.
  - \`Quote_Policy\` tells you whether quoting is allowed and which evidence kinds may be quoted.
  - \`Confidence_Level\` tells you how assertive to be; \`low\` must stay visibly cautious.`)
      : "";

    const memoryResponsePlanHint = isMemoryPlannedTurn
      ? (language === 'zh'
          ? `\n[统一回答计划读取规则]：
- 如果看到 \`[MEMORY_RESPONSE_PLAN]\`，先执行它，再看后面的证据块。
- \`Route\` 只告诉你当前是 strict history 还是 semantic recall，不等于回答内容本身。
- \`Response_Strategy\` 优先级最高，它决定这轮是该直答、先总结再补证，还是先承认没有证据。
- \`Answer_Mode\` 是次级补充，帮助你保持回答形态一致。
- \`Confidence_Level\` 是语气约束：\`low\` 时必须明显保守，不能装得很确定。
- \`Evidence_Strength\` 是证据强弱：\`strong\` 时更像直接答，\`medium\` 时更像概述，\`weak/none\` 时不能装成确定。
- \`Speaker_Certainty\` 是说话人确定度；低时不要把归属说死。
- \`Time_Certainty\` 是时间确定度；低时不要把窗口说得像已经精确锁定。
- \`Direct_Answer_Allowed\` 是最终直答许可；如果是 \`no\`，即使证据不差，也不要写成非常斩钉截铁。
- \`Conflict_Flags\` 是系统检测到的冲突信号；只要不是 \`none\`，就必须下调确定度，不能忽略。
- \`Route_Boundary\` 是这轮回答边界；如果是 \`exact_evidence_only\`，就不要离开证据去自由发挥。
- \`Preferred_Lead\` 是推荐的起手方式；尽量让第一句就落在对应的回答形态上。
- \`No_Substitution = yes\` 时，不要用宽泛主题回忆去顶替精确或时间问题。
- \`Speaker_Claim_Allowed = no\` 时，不要把“谁说的”说得很死。
- \`Time_Pinpoint_Allowed = no\` 时，不要把时间点说得像已经精准锁定。
- \`Max_Bubbles\` 是长度边界，尽量不要超过它。
- \`Primary_Evidence\`、\`Quote_Policy\`、\`Entry_Mix\` 只用于约束你怎么用证据，不允许你越界发挥。`
          : `\n[UNIFIED RESPONSE PLAN]:
- If you see \`[MEMORY_RESPONSE_PLAN]\`, follow it before reading the detailed evidence blocks.
- \`Route\` only tells you whether this is strict history or semantic recall; it is not the answer itself.
- \`Response_Strategy\` has the highest priority and determines whether to answer directly, summarize first, or explicitly acknowledge missing evidence.
- \`Answer_Mode\` is a secondary stabilizer for answer shape.
- \`Confidence_Level\` constrains tone: when it is \`low\`, stay visibly cautious and never sound fully certain.
- \`Evidence_Strength\` is the evidence tier: \`strong\` may answer more directly, \`medium\` should stay summary-like, and \`weak/none\` must not sound certain.
- \`Speaker_Certainty\` reflects how certain the speaker attribution is; when low, do not sound definitive about who said it.
- \`Time_Certainty\` reflects how certain the time anchoring is; when low, do not act as if the window was pinned down exactly.
- \`Direct_Answer_Allowed\` is the final direct-answer permission; if it is \`no\`, do not sound fully locked or absolute even if the evidence is otherwise decent.
- \`Conflict_Flags\` lists detected conflict signals; whenever it is not \`none\`, reduce certainty and do not ignore those conflicts.
- \`Route_Boundary\` defines the answer boundary for this turn; if it is \`exact_evidence_only\`, stay anchored to evidence instead of drifting into free improvisation.
- \`Preferred_Lead\` is the recommended opening shape; try to make the first line match it.
- \`No_Substitution = yes\` means broad thematic recall must not be used as a substitute for an exact or time-specific question.
- \`Speaker_Claim_Allowed = no\` means do not sound fully certain about who said it.
- \`Time_Pinpoint_Allowed = no\` means do not pin the answer to an exact-looking time point.
- \`Max_Bubbles\` is the length boundary and should usually not be exceeded.
- \`Primary_Evidence\`, \`Quote_Policy\`, and \`Entry_Mix\` only constrain how you use evidence; they do not license invention.`)
      : "";

    const dynamicSystemInstruction = language === 'zh' ? `${sleepyGoodbyeInstruction}

<core_persona>
${selectedSystemInstruction}
</core_persona>

${worldBookContext}

${memoryBlock}

${dynamicMemoryBlock}
${strictMemoryTurnInstruction}
${strictEpisodeAnswerHint}
${episodeEvidenceLayerHint}
${semanticRecallAnswerHint}
${semanticRecallSectionHint}
${semanticRecallQuoteBoundaryHint}
${unifiedEvidenceEnvelopeHint}
${memoryResponsePlanHint}
${memoryResponseExecutionHint}

[系统环境数据（当前状态）]
（注意：这是应用程序提供的自动系统数据。用户没有陈述这一点。将其视为内部知识。）
- 用户时钟：${userTimeStr} (${phase})
- 久美子时钟：${modelTimeStr}
- 会话间隔：${gapDescription}
${reminderBlock}
${anchorRecallBlock}
${relationshipTemperatureBlock}
${topicContinuityBlock}
${lifeSimBlock}
${shortFollowUpBlock}
${proactiveReplyBlock}
${varietyInstruction}
${timeAdaptationInstruction}
[/系统环境数据]
${extraSystemPrompt ?? ''}` : `${sleepyGoodbyeInstruction}

<core_persona>
${selectedSystemInstruction}
</core_persona>

${worldBookContext}

${memoryBlock}

${dynamicMemoryBlock}
${strictMemoryTurnInstruction}
${strictEpisodeAnswerHint}
${episodeEvidenceLayerHint}
${semanticRecallAnswerHint}
${semanticRecallSectionHint}
${semanticRecallQuoteBoundaryHint}
${unifiedEvidenceEnvelopeHint}
${memoryResponsePlanHint}
${memoryResponseExecutionHint}

[SYSTEM_ENVIRONMENT_DATA (CURRENT STATUS)]
(NOTE: This is automated system data provided by the application. The user is NOT stating this. Treat as internal knowledge.)
- This turn is in strict memory lookup mode when [EXACT_HISTORY_LOOKUP] is present. Treat that evidence block as higher priority than recent summaries or fuzzy recollections.
- User_Clock: ${userTimeStr} (${phase})
- Kumiko_Clock: ${modelTimeStr}
- Session_Gap: ${gapDescription}
${reminderBlock}
${anchorRecallBlock}
${relationshipTemperatureBlock}
${topicContinuityBlock}
${lifeSimBlock}
${shortFollowUpBlock}
${proactiveReplyBlock}
${varietyInstruction}
${timeAdaptationInstruction}
[/SYSTEM_ENVIRONMENT_DATA]
${extraSystemPrompt ?? ''}`;

    let lastValidDate = new Date();
    for (const m of historyMessages) {
        const tempD = new Date(m.timestamp);
        if (!isNaN(tempD.getTime())) {
            lastValidDate = tempD;
            break;
        }
    }

    const effectiveHistoryMessages = isStrictMemoryLookupTurn
      ? []
      : historyMessages;

    const formattedHistory: Content[] = effectiveHistoryMessages.map(msg => {
      let content = msg.text;
      
      let msgTimeStr = "";
      try {
          let msgDate = new Date(msg.timestamp);
          if (isNaN(msgDate.getTime())) {
              msgDate = new Date(lastValidDate.getTime() + 1);
          }
          lastValidDate = msgDate;
          
          const msgOptions: Intl.DateTimeFormatOptions = { 
              timeZone: locationConfig?.modelTimezone || 'Asia/Tokyo', 
              month: '2-digit', day: '2-digit', 
              weekday: 'short',
              hour: '2-digit', minute: '2-digit', hour12: false 
          };
          msgTimeStr = msgDate.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', msgOptions);
      } catch(e) {}

      if (msgTimeStr) {
          content = `[${msgTimeStr}]\n${content}`;
      }
      
      if (msg.role === 'model' && msg.storedEmotion) {
          content += language === 'zh' ? `\n[系统记忆：内部状态情绪="${msg.storedEmotion}"]` : `\n[System_Memory: Internal_State_Emotion="${msg.storedEmotion}"]`;
      }

      if (msg.imageId || msg.image) {
          const idStr = msg.imageId ? ` (ID: ${msg.imageId})` : '';
          if (msg.imageCaption) {
              content += language === 'zh' ? `\n\n[系统：用户发送了一张图片${idStr}。隐藏描述：${msg.imageCaption}]` : `\n\n[SYSTEM: User sent an image${idStr}. Hidden Description: ${msg.imageCaption}]`;
          } else {
              content += language === 'zh' ? `\n\n[系统：用户发送了一张图片${idStr}。]` : `\n\n[SYSTEM: User sent an image${idStr}.]`;
          }
      }
      if (msg.quote) {
         const who = msg.quote.role === 'model' ? (language === 'zh' ? '久美子' : 'Kumiko') : (language === 'zh' ? '用户' : 'User');
         content = language === 'zh' ? `> [回复 ${who}]："${msg.quote.text}"\n\n${content}` : `> [Replying to ${who}]: "${msg.quote.text}"\n\n${content}`;
      }
      return {
        role: msg.role,
        parts: [{ text: content }] 
      };
    });

    const baseTemp = 0.8;
    const jitter = (Math.random() * 0.25) - 0.1;
    const finalTemperature = Math.max(0.6, Math.min(0.9, baseTemp + jitter));
    
    const viewHistoricalImageTool: FunctionDeclaration = {
      name: "view_historical_image",
      description: language === 'zh' ? "查看给定图像 ID 的原始高分辨率图像。仅当用户询问未被图像描述涵盖的过去图像的特定视觉细节时才使用此工具。每次只能查看一张图片，不支持批量查询。" : "View the original high-resolution image for a given image ID. Use this ONLY when the user asks about specific visual details of a past image that are not covered by the image description. Only ONE image per call. Batch queries are NOT supported.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          imageId: {
            type: Type.STRING,
            description: language === 'zh' ? "单个图像 ID 字符串（如 'img_20260325_143052_abc123'），从聊天记录中的 [系统：用户发送了一张图片 (ID: ...)] 提取。不接受中文描述、批量查询或 '所有图片' 等请求。" : "A single image ID string (e.g. 'img_20260325_143052_abc123'), extracted from [SYSTEM: User sent an image (ID: ...)] in the chat history. Do NOT pass Chinese descriptions, batch queries, or requests like 'all images'."
          }
        },
        required: ["imageId"]
      }
    };

    const searchInternetTool: FunctionDeclaration = {
      name: "search_internet",
      description: language === 'zh' ? "当用户询问实时信息、天气、新闻、或者你（久美子）知识库之外的特定作品设定时，调用此函数。" : "Call this function when the user asks for real-time information, weather, news, or specific work settings outside your (Kumiko's) knowledge base.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: {
            type: Type.STRING,
            description: language === 'zh' ? "优化过的搜索关键词" : "Optimized search keywords",
          }
        },
        required: ["query"]
      }
    };

    const enableInternetSearch =
      localStorage.getItem('enable_internet_search') === 'true'
      && !isMemoryHistoryQueryLike(textMessage)
      && !exactHistoryLookup;

    const toolsConfig: any[] = [{ functionDeclarations: [viewHistoricalImageTool] }];
    if (enableInternetSearch) {
        toolsConfig[0].functionDeclarations.push(searchInternetTool);
    }

    let promptToSend: (string | Part)[] = [];
    
    const systemProtocolTrigger = language === 'zh' ? `\n\n[系统触发]：启动第 1 层逻辑检查...
    **关键：你必须首先输出 [[System_Log]] 块，然后再输出任何其他文本。**
    
    以此开始：
    [[System_Log: [User_Time: ${userTimeStr}] [Kumiko_Time: ${modelTimeStr}] [Gap: ${gapDescription}] [Kumiko_Thought] ... [Emotion] ...]]
    
    强制要求：
    1. 将上面提供的确切时间和间隔值复制到日志中。
    2. [Kumiko_Thought]：以久美子的第一人称视角（“我”），根据当前时间、对话间隔和对方的话语，写下1-2句真实的内心独白。必须是带有吐槽、嫌麻烦、或者敏锐观察的真实心理活动，绝不能是干巴巴的状态描述。例如：“这家伙...说这种话也太自然了吧。明明只是在当人形闹钟而已啊。”或者“啊，已经过了三天了，他那边还是半夜呢，这么晚找我干嘛……”。
    3. [Emotion]：从以下选项中选择一个有效的情绪代码：[neutral, smiling, happy, angry, sad, shy, surprised, resigned, serious, gentle, sleepy, confused, confused_2, disgusted, smug, worried, worried_2]。如果情绪复杂，映射到最接近的一个。
    
    然后关闭括号并开始第 2 层（久美子的回复）。` : `\n\n[SYSTEM TRIGGER]: Initiating Layer 1 Logic Check...
    **CRITICAL: You MUST output the [[System_Log]] block FIRST, before any other text.**
    
    Start with:
    [[System_Log: [User_Time: ${userTimeStr}] [Kumiko_Time: ${modelTimeStr}] [Gap: ${gapDescription}] [Kumiko_Thought] ... [Emotion] ...]]
    
    MANDATORY:
    1. COPY the exact Time and Gap values provided above into the log.
    2. [Kumiko_Thought]: Write 1-2 sentences of Kumiko's inner monologue in the first person ("I"). This MUST be a genuine psychological activity with a slightly cynical, observant, or "troublesome" tone. NEVER write a robotic fact check. For example: "This guy... saying things like that so naturally. I'm just acting as a human alarm clock here..." or "Ah, it's been three days, and it's still middle of the night over there, why is he looking for me so late...".
    3. [Emotion]: Select ONE valid emotion code from: [neutral, smiling, happy, angry, sad, shy, surprised, resigned, serious, gentle, sleepy, confused, confused_2, disgusted, smug, worried, worried_2]. If complex, map to closest.
    
    Then close brackets and start Layer 2 (Kumiko's Reply).`;

    const visualMemoryInstruction = language === 'zh' ? `
    \n[视觉记忆协议 - 关键]：
    你正在看一张图片（新的或回忆的）。
    **强制要求：** 你必须在 System_Log 中输出这张图片的详细描述，以便当图片消失后我能记住它。
    格式：[[System_Log: ... [Image_Description] 图片内容的详细描述 ... ]]
    如果你现在不描述它，你将永远忘记它的样子。
    在你的回复中自然地对图片做出反应。
    ` : `
    \n[VISUAL MEMORY PROTOCOL - CRITICAL]:
    You are seeing an image (either new or recalled).
    **MANDATORY:** You MUST output a detailed description of this image inside the System_Log so I can remember it later when the image is gone.
    Format: [[System_Log: ... [Image_Description] A detailed description of the image content ... ]]
    If you do not describe it now, you will forget what it looks like forever.
    React naturally to the image in your reply.
    `;

    const finalPromptText = textMessage + systemProtocolTrigger + (imageBase64 || recalledImageParts.length > 0 ? visualMemoryInstruction : "");

    promptToSend.push({ text: finalPromptText });

    if (recalledImageParts.length > 0) {
        if (config.useVisionHelper) {
            for (const p of recalledImageParts) {
                if (p.inlineData) {
                    try {
                        const description = await callVisionHelper(config, p.inlineData.data, p.inlineData.mimeType, language);
                        promptToSend.push({ text: `[Vision Helper Description of recalled image]: ${description}` });
                    } catch (e) {
                        console.error("Vision Helper failed for recalled image:", e);
                        promptToSend.push(p);
                    }
                } else {
                    promptToSend.push(p);
                }
            }
        } else {
            promptToSend.push(...recalledImageParts);
        }
    }
    if (imageBase64) {
        if (config.useVisionHelper) {
            try {
                const description = await callVisionHelper(config, imageBase64, mimeType, language);
                promptToSend.push({ text: `[Vision Helper Description of user image]: ${description}` });
            } catch (e) {
                console.error("Vision Helper failed for user image:", e);
                promptToSend.push({ inlineData: { mimeType: mimeType, data: imageBase64 } });
            }
        } else {
            promptToSend.push({ inlineData: { mimeType: mimeType, data: imageBase64 } });
        }
    }

    if (retryCount > 0) {
        const userBubbleCount = textMessage.split('\n').filter(s => s.trim().length > 0).length;
        const maxAllowedBubbles = Math.max(4, userBubbleCount + 2);

        let retryInstruction = language === 'zh' ? `\n\n[系统中断 - 格式错误]：
        你之前的输出在逻辑上是正确的，但违反了格式规则。
        问题：回复太长、气泡太多或在休闲模式下使用了逗号。` : `\n\n[SYSTEM_INTERRUPT - FORMATTING ERROR]:
        Your previous output was logically correct but violated formatting rules.
        Issue: RESPONSE TOO LONG, TOO MANY BUBBLES, or USED COMMAS in Casual Mode.`;

        if (previousContextLog) {
            retryInstruction += language === 'zh' ? `\n\n保持这个确切的逻辑和情绪：
            ${previousContextLog}` : `\n\nMAINTAIN THIS EXACT LOGIC & EMOTION:
            ${previousContextLog}`;
        } else {
             retryInstruction += language === 'zh' ? `\n\n[[System_Log: [Logic_Correction] 之前的输出太长/太正式。修复语气。]]` : `\n\n[[System_Log: [Logic_Correction] Previous output was too long/formal. Fixing tone.]]`;
        }
        retryInstruction += language === 'zh' ? `\n\n动作：重写回复部分。
        1. 保持口语化，长度适中（不要太长，但也不能只回复一个字）。
        2. 不要使用逗号。
        3. 使用 '$' 来分隔气泡（总共不要超过 ${maxAllowedBubbles} 个气泡）。
        4. 保持自然口语，不要长篇大论。
        5. 绝对不要像机器人一样完全复读用户的话，用你自己的反应来回答。` : `\n\nACTION: Rewrite the Reply part.
        1. Keep it conversational and moderate length (not too long, but NEVER just one single character).
        2. No commas.
        3. Use '$' to break bubbles (NO MORE THAN ${maxAllowedBubbles} bubbles total).
        4. Keep it casual and conversational, don't over-explain.
        5. NEVER completely echo/repeat the user's words like a robot. React with your own words.`;
        retryInstruction += language === 'zh' ? `\n\n重要：你必须在新的回复之前首先输出 [[System_Log]] 块。` : `\n\nIMPORTANT: You MUST still Output the [[System_Log]] block first before your new reply.`;
        promptToSend[0] = { text: (promptToSend[0] as Part).text + retryInstruction };
    }

    const availableTools = toolsConfig[0]?.functionDeclarations;

    let chatSession: any;

    if (transportProvider === 'openai' || transportProvider === 'deepseek' || transportProvider === 'grok' || transportProvider === 'openrouter') {
        result = await callOpenAI(config, currentModel, dynamicSystemInstruction, formattedHistory, promptToSend, availableTools);
    } else if (transportProvider === 'anthropic') {
        result = await callAnthropic(config, currentModel, dynamicSystemInstruction, formattedHistory, promptToSend, availableTools);
    } else {
        const ai = getGenAI();
        chatSession = ai.chats.create({
          model: currentModel,
          history: formattedHistory,
          config: {
            systemInstruction: dynamicSystemInstruction,
            temperature: finalTemperature, 
            tools: toolsConfig 
          },
        });
        result = await chatSession.sendMessage({ message: promptToSend });
    }
        
    if (result.functionCalls && result.functionCalls.length > 0) {
        const call = result.functionCalls[0];
        const toolSyslogReminder = language === 'zh'
            ? '\n[系统提醒：工具调用已完成。你必须在回复中先输出 [[System_Log]] 块（包含 Kumiko_Thought、Emotion），然后再输出对用户的回复文本。]'
            : '\n[SYSTEM REMINDER: Tool call complete. You MUST output the [[System_Log]] block first (with Kumiko_Thought, Emotion), THEN your reply text.]';

        if (call.name === "search_internet") {
            const query = call.args?.query;
            if (typeof query === 'string') {
                console.log(`[TOOL CALL] Model requested to search internet: ${query}`);
                const tavilyApiKey = localStorage.getItem('tavily_api_key');
                let toolResponseData: any;
                
                if (!tavilyApiKey) {
                    toolResponseData = { success: false, error: "[System] 请先在设置中填写 Tavily API Key 以启用搜索" };
                } else {
                    try {
                        const res = await fetch(`https://search.omkk.org/api/search?q=${encodeURIComponent(query)}`, {
                            headers: { 'x-api-key': tavilyApiKey }
                        });
                        if (!res.ok) {
                            throw new Error(`Server returned ${res.status}`);
                        }
                        const data = await res.json();
                        const resultsStr = JSON.stringify(data.results || []);
                        toolResponseData = { success: true, results: resultsStr };
                    } catch (e: any) {
                        console.error("[TOOL CALL] Failed to search internet:", e);
                        toolResponseData = { success: false, error: e.message || "Failed to search internet" };
                    }
                }

                toolResponseData._reminder = toolSyslogReminder;

                if (transportProvider === 'openai' || transportProvider === 'deepseek' || transportProvider === 'grok' || transportProvider === 'openrouter') {
                    result = await callOpenAI(config, currentModel, dynamicSystemInstruction, formattedHistory, promptToSend, availableTools, {
                        toolCall: result.rawToolCall || call,
                        toolResult: toolResponseData,
                        originalMessage: promptToSend
                    });
                } else if (transportProvider === 'anthropic') {
                    result = await callAnthropic(config, currentModel, dynamicSystemInstruction, formattedHistory, promptToSend, availableTools, {
                        toolCall: result.rawToolCall || call,
                        toolResult: toolResponseData,
                        originalMessage: promptToSend
                    });
                } else {
                    result = await chatSession.sendMessage({
                        message: [{
                            functionResponse: {
                                name: "search_internet",
                                response: toolResponseData
                            }
                        }]
                    });
                }
            }
        } else if (call.name === "view_historical_image") {
            const imageId = call.args?.imageId;
            const isValidImageId = typeof imageId === 'string'
                && imageId.length > 5
                && imageId.length < 100
                && /^[a-zA-Z0-9_\-:.]+$/.test(imageId);

            if (typeof imageId === 'string') {
                console.log(`[TOOL CALL] Model requested to view image: ${imageId} (valid=${isValidImageId})`);
            }

            if (isValidImageId) {
                let toolResponseData: any;
                let imgMimeType: string | undefined;
                let base64: string | undefined;

                try {
                    const imageData = await imageService.getImage(imageId);
                    if (imageData) {
                        const match = imageData.match(/^data:(.*);base64,(.*)$/);
                        if (match) {
                            imgMimeType = match[1];
                            base64 = match[2];
                            toolResponseData = { success: true };
                        } else {
                            toolResponseData = { success: false, error: "Invalid image data format" };
                        }
                    } else {
                        toolResponseData = { success: false, error: "Image not found in local database" };
                    }
                } catch (e: any) {
                    console.error("[TOOL CALL] Failed to retrieve image:", e);
                    toolResponseData = { success: false, error: e.message || "Failed to load image" };
                }

                toolResponseData._reminder = toolSyslogReminder;

                if (transportProvider === 'openai' || transportProvider === 'deepseek' || transportProvider === 'grok' || transportProvider === 'openrouter') {
                    result = await callOpenAI(config, currentModel, dynamicSystemInstruction, formattedHistory, promptToSend, availableTools, {
                        toolCall: result.rawToolCall || call,
                        toolResult: toolResponseData,
                        originalMessage: promptToSend
                    });
                } else if (transportProvider === 'anthropic') {
                    result = await callAnthropic(config, currentModel, dynamicSystemInstruction, formattedHistory, promptToSend, availableTools, {
                        toolCall: result.rawToolCall || call,
                        toolResult: toolResponseData,
                        originalMessage: promptToSend
                    });
                } else {
                    const messagesToReturn: any[] = [{
                        functionResponse: {
                            name: "view_historical_image",
                            response: toolResponseData
                        }
                    }];
                    if (toolResponseData.success && imgMimeType && base64) {
                        messagesToReturn.push({ inlineData: { mimeType: imgMimeType, data: base64 } });
                    }
                    result = await chatSession.sendMessage({ message: messagesToReturn });
                }
            } else {
                console.warn(`[TOOL CALL] Rejected invalid imageId: ${String(imageId).slice(0, 50)}`);
                const rejectionData: any = { success: false, error: "Invalid image ID format. Provide a single valid image ID string (alphanumeric, hyphens, underscores, colons, dots only). Batch queries are not supported.", _reminder: toolSyslogReminder };

                if (transportProvider === 'openai' || transportProvider === 'deepseek' || transportProvider === 'grok' || transportProvider === 'openrouter') {
                    result = await callOpenAI(config, currentModel, dynamicSystemInstruction, formattedHistory, promptToSend, availableTools, {
                        toolCall: result.rawToolCall || call,
                        toolResult: rejectionData,
                        originalMessage: promptToSend
                    });
                } else if (transportProvider === 'anthropic') {
                    result = await callAnthropic(config, currentModel, dynamicSystemInstruction, formattedHistory, promptToSend, availableTools, {
                        toolCall: result.rawToolCall || call,
                        toolResult: rejectionData,
                        originalMessage: promptToSend
                    });
                } else {
                    result = await chatSession.sendMessage({ message: [{
                        functionResponse: {
                            name: "view_historical_image",
                            response: rejectionData
                        }
                    }] });
                }
            }
        }
    }

    let fullText = result.text || "...";
    
    let rawLog = "";
    let logRegex = /\[\[System_Log:[\s\S]*?\]\]/i;
    let logMatch = fullText.match(logRegex);
    
    if (!logMatch) {
        logRegex = /\[System_Log:[\s\S]*?\]/i;
        logMatch = fullText.match(logRegex);
    }
    
    if (!logMatch) {
        logRegex = /System_Log:[\s\S]*?\]/i;
        logMatch = fullText.match(logRegex);
    }

    let emotion: EmotionType = 'neutral';
    let extractedImageCaption = "";
    let scheduleTrigger = undefined;
    let anchorAction: { type: 'add' | 'delete', content: string } | undefined = undefined;

    if (logMatch) {
        rawLog = logMatch[0];
        console.log(`%c[SYSTEM LAYER LOG]: %c${rawLog}`, "color: #00ff00; font-family: monospace;", "color: #aaa;");
        
        fullText = fullText.replace(logRegex, '').trim();
        
        const logEmotionRegex = /Emotion\s*[:\]=]\s*([^\]\|\n]+)/i;
        const eMatch = rawLog.match(logEmotionRegex);
        if (eMatch) {
            let rawEmotionStr = eMatch[1].trim().replace(/[:\s"'.]+$/g, '').toLowerCase();
            
            // NEW ROBUST PARSING LOGIC
            const potentialEmotions = rawEmotionStr.split(/[_ /]/).map(s => s.trim()).filter(Boolean);
            let foundEmotion: EmotionType | null = null;

            for (const potential of potentialEmotions) {
                // Direct match
                if (Object.keys(KUMIKO_EMOTION_IMAGES).includes(potential)) {
                    foundEmotion = potential as EmotionType;
                    break;
                }
                // Mapped match
                if (EMOTION_MAPPING[potential]) {
                    foundEmotion = EMOTION_MAPPING[potential];
                    break;
                }
            }

            if (foundEmotion) {
                emotion = foundEmotion;
            } else {
                console.warn(`[EMOTION SAFETY] Invalid emotion string '${rawEmotionStr}' detected. Falling back to 'neutral'.`);
                emotion = 'neutral';
            }
        }

        const descRegex = /\[Image_Description\]\s*([\s\S]+?)(?=\[|\]\])/i;
        const dMatch = rawLog.match(descRegex);
        if (dMatch) extractedImageCaption = dMatch[1].trim();
    } else {
        console.warn("[SYSTEM LOG MISSING]: Model skipped the logic layer.");
    }

    // --- LEAK CLEANUP SAFETY NET (Run always) ---
    // Remove leaked tags even if System_Log was not detected
    fullText = fullText.replace(/\[Emotion\s*[:=].*?\]/gi, '');
    fullText = fullText.replace(/\[Logic\s*[:=].*?\]/gi, '');
    fullText = fullText.replace(/\[Fact_Check\s*[:=].*?\]/gi, '');
    fullText = fullText.replace(/\[Kumiko_Thought\s*[:=].*?\]/gi, ''); // ADDED: Remove new thought tags
    fullText = fullText.replace(/\[System_Memory:.*?\]/gi, ''); // ADDED: Remove injected system memory tags if echoed
    fullText = fullText.replace(/\[系统记忆.*?\]/gi, ''); // ADDED: Remove Chinese system memory tags
    fullText = fullText.replace(/\[\d{2}\/\d{2}.*?\d{2}:\d{2}\]\s*/g, ''); // ADDED: Remove echoed time tags like [03/22周日 10:43]
    // Catch stray double bracket tags except for System_Log if it somehow survived
    fullText = fullText.replace(/\[\[(?!System_Log).*?\]\]/g, ''); 
    // Remove leaked reply-prefix lines that belong to prompt/history formatting, not visible dialog content.
    fullText = fullText.replace(/^\s*>\s*\[(?:回复\s*[^\]]+|Replying to [^\]]+)\].*$/gim, '');

    const scheduleGlobalRegex = /\[Schedule_Trigger:\s*(\{[\s\S]*?\})\]/i;
    const sMatch = fullText.match(scheduleGlobalRegex) || (rawLog ? rawLog.match(scheduleGlobalRegex) : null);
    
    if (sMatch) {
        try {
            scheduleTrigger = JSON.parse(sMatch[1]);
            fullText = fullText.replace(scheduleGlobalRegex, '');
        } catch (e) {
            console.warn("[SCHEDULE PARSE FAIL]", e);
        }
    }
    fullText = fullText.replace(/\[Schedule_Trigger:[\s\S]*?\]/gi, '');

    let voiceModeTag: boolean | undefined;
    const voiceModeMatch = fullText.match(/\[Voice_Mode:\s*(true|false)\]/i);
    if (voiceModeMatch) {
        voiceModeTag = voiceModeMatch[1].toLowerCase() === 'true';
        fullText = fullText.replace(voiceModeMatch[0], '');
    }
    fullText = fullText.replace(/\[Voice_Mode:\s*(?:true|false)\]/gi, '');

    const anchorAddRegex = /\[Anchor_Commit:\s*([^\]]+)\]/i;
    const anchorDelRegex = /\[Anchor_Delete:\s*([^\]]+)\]/i;
    const addMatch = fullText.match(anchorAddRegex) || (rawLog ? rawLog.match(anchorAddRegex) : null);
    const delMatch = fullText.match(anchorDelRegex) || (rawLog ? rawLog.match(anchorDelRegex) : null);

    if (addMatch) {
        let content = addMatch[1].trim();
        if (content.startsWith('"') && content.endsWith('"')) content = content.slice(1, -1);
        anchorAction = { type: 'add', content };
        fullText = fullText.replace(addMatch[0], '');
    } else if (delMatch) {
        let content = delMatch[1].trim();
        if (content.startsWith('"') && content.endsWith('"')) content = content.slice(1, -1);
        anchorAction = { type: 'delete', content };
        fullText = fullText.replace(delMatch[0], '');
    }

    fullText = fullText.trim();

    let quote: { text: string; role: 'user' } | undefined = undefined;
    const replyMatch = fullText.match(/\[REPLY:\s*([\s\S]*?)(?:\]|】)/i); 
    if (replyMatch) {
        quote = { text: replyMatch[1].trim(), role: 'user' };
        fullText = fullText.replace(replyMatch[0], '').trim();
    }

    fullText = fullText.replace(/^[\s\]})]+/, '').trim();
    let cleanText = fullText.trim();

    // Catch markdown quotes if the model failed to use [REPLY: ...]
    const markdownQuoteMatch = cleanText.match(/^>\s*([^\n]+)\n+/);
    if (markdownQuoteMatch && !quote) {
        quote = { text: markdownQuoteMatch[1].trim(), role: 'user' };
        cleanText = cleanText.replace(markdownQuoteMatch[0], '').trim();
    }

    // Strip surrounding quotes if the model accidentally wrapped its entire response in quotes
    if ((cleanText.startsWith('“') && cleanText.endsWith('”')) || 
        (cleanText.startsWith('"') && cleanText.endsWith('"'))) {
        cleanText = cleanText.slice(1, -1).trim();
    }

    // Prevent echoing the quote back to the user
    let isEchoingQuote = false;
    if (quote && cleanText) {
        const strippedQuote = quote.text.replace(/[^\p{L}\p{N}]/gu, '');
        const strippedClean = cleanText.replace(/[^\p{L}\p{N}]/gu, '');
        if (strippedQuote === strippedClean || strippedClean.length === 0) {
            const ALLOWED_ECHO_EMOTIONS = ['angry', 'confused', 'confused_2', 'serious'];
            if (!ALLOWED_ECHO_EMOTIONS.includes(emotion)) {
                isEchoingQuote = true;
            }
        }
    }

    if (retryCount < 1 && !activateSleepModeAfterResponse && !isStrictMemoryLookupTurn && !isMemoryPlannedTurn) {
        const LONG_TEXT_EMOTIONS = ['serious', 'sad', 'angry', 'worried_2', 'gentle'];
        const isCasualEmotion = !LONG_TEXT_EMOTIONS.includes(emotion);
        const hasChineseComma = cleanText.includes('，');
        const rawBubbles = cleanText.split(/[\$\n]+/).map(s => s.trim()).filter(s => s.length > 0);
        const hasLongBubble = rawBubbles.some(b => b.length > 60); 
        const totalLength = cleanText.replace(/[\$\n]/g, '').length;
        const isTooLong = totalLength > 60; 

        const userBubbleCount = textMessage.split('\n').filter(s => s.trim().length > 0).length;
        const maxAllowedBubbles = Math.max(4, userBubbleCount + 2);
        const tooManyBubbles = rawBubbles.length > maxAllowedBubbles;

        if (isCasualEmotion && (hasChineseComma || hasLongBubble || isTooLong || tooManyBubbles || isEchoingQuote)) {
            console.warn(`[RETRY GUARD TRIGGERED] Retrying...`);
            return sendMessageToGemini(
                textMessage, coreMemory, worldBook, historyMessages, locationConfig, imageBase64, mimeType, retryCount + 1, rawLog, ragContext, exactHistoryLookup, activeReminders, anchors, kumikoNotebook, modelOverride, language, extraSystemPrompt
            );
        }
    }

    const textParts = cleanText.split(/[\$\n]+/)
      .map(s => s.trim().replace(/[。\.]$/, '')) 
      .filter(s => s.length > 0);

    if (textParts.length === 0) {
        textParts.push("..."); 
    }

    const plannedTextParts = applyMemoryResponsePlanToTextParts(textParts);
    if (isMemoryPlannedTurn) {
      console.log('[MEMORY RESPONSE PLAN] Applied output shaping.', {
        responseStrategy: memoryResponsePlan?.responseStrategy ?? null,
        evidenceStrength: memoryResponsePlan?.evidenceStrength ?? null,
        speakerCertainty: memoryResponsePlan?.speakerCertainty ?? null,
        timeCertainty: memoryResponsePlan?.timeCertainty ?? null,
        directAnswerAllowed: memoryResponsePlan?.directAnswerAllowed ?? null,
        conflictFlags: memoryResponsePlan?.conflictFlags ?? null,
        routeBoundary: memoryResponsePlan?.routeBoundary ?? null,
        preferredLead: memoryResponsePlan?.preferredLead ?? null,
        noSubstitution: memoryResponsePlan?.noSubstitution ?? null,
        speakerClaimAllowed: memoryResponsePlan?.speakerClaimAllowed ?? null,
        timePinpointAllowed: memoryResponsePlan?.timePinpointAllowed ?? null,
        maxBubbles: memoryResponsePlan?.maxBubbles ?? null,
        originalBubbleCount: textParts.length,
        finalBubbleCount: plannedTextParts.length,
      });
    }

    const chunks = result.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (!isMemoryPlannedTurn && chunks && chunks.length > 0) {
      const uris = chunks
        .filter((chunk: any) => chunk.web && chunk.web.uri)
        .map((chunk: any) => chunk.web.uri);
      const uniqueUris = [...new Set(uris)]; 
      if (uniqueUris.length > 0) {
        plannedTextParts.push(`顺手查了一下... ${uniqueUris[0]}`);
      }
    }

    return {
      textParts: plannedTextParts,
      emotion,
      groundingSources: [],
      quote,
      imageCaption: extractedImageCaption,
      scheduleTrigger,
      anchorAction,
      activateSleepMode: activateSleepModeAfterResponse,
      voiceMode: voiceModeTag,
    };

  } catch (error: any) {
    console.error("Gemini API Error:", error);
    const errorMessage = error.toString().toLowerCase();
    
    // --- UPDATED: STRICT FAILOVER LOGIC ---
    const isPrimary = config.activeKey === 'primary';
    const hasBackup = !!config.apiKey_backup;
    
    // Whitelist keywords for Gemini API/Network failures
    const apiErrorMarkers = [
        'gemini', 
        'google', 
        '429', // Rate limit
        '500', '502', '503', // Server errors
        'quota', 
        'rate limit',
        'fetch failed', // Network
        'network error', // Network
        'load failed'   // Network
    ];

    const isGeminiOrNetworkError = apiErrorMarkers.some(marker => errorMessage.includes(marker));
    const is429 = errorMessage.includes('429') || errorMessage.includes('quota') || errorMessage.includes('rate limit');

    // --- AUTO-DOWNGRADE LOGIC (TIERED: 3.0 Pro -> 2.5 Pro -> Flash) ---
    if (is429 && !modelOverride) {
        let nextModel = '';
        let notice = '';

        if (currentModel.includes('gemini-3.1-pro')) {
            nextModel = 'gemini-2.5-pro'; // Try 2.5 Pro first
            notice = language === 'zh' ? '⚠️ Gemini 3.1 Pro 繁忙。已自动切换至 2.5 Pro。' : '⚠️ Gemini 3.1 Pro Busy. Switched to 2.5 Pro.';
        } else if (currentModel.includes('gemini-2.5-pro')) {
            nextModel = config.model_summary; // Fallback to Flash
            notice = language === 'zh' ? '⚠️ Gemini 2.5 Pro 繁忙。已自动切换至 Flash 模型。' : '⚠️ Gemini 2.5 Pro Busy. Switched to Flash.';
        } else if (currentModel !== config.model_summary) {
            // Unknown or other model, fallback to summary just in case
            nextModel = config.model_summary;
            notice = language === 'zh' ? `⚠️ ${currentModel} 繁忙。已自动切换至 Flash 模型。` : `⚠️ ${currentModel} Busy. Switched to Flash.`;
        }

        if (nextModel && nextModel !== currentModel) {
            console.warn(`[Failover] Rate Limit on ${currentModel}. Downgrading to ${nextModel}.`);
            
            // Recursive call with override
            const fallbackResponse = await sendMessageToGemini(
                textMessage, coreMemory, worldBook, historyMessages, locationConfig, imageBase64, mimeType, retryCount, previousContextLog, ragContext, exactHistoryLookup, activeReminders, anchors, kumikoNotebook, 
                nextModel, 
                language,
                extraSystemPrompt,
            );
            
            // Attach notification
            return {
                ...fallbackResponse,
                systemNotice: notice
            };
        }
    }

    // Blacklist: User/Client Errors (Switching won't help)
    const isUserError = 
        errorMessage.includes('400') || 
        errorMessage.includes('invalid argument') ||
        errorMessage.includes('content generation stopped');

    if (isPrimary && hasBackup && isGeminiOrNetworkError && !isUserError) {
        console.warn("[Failover] Gemini/Network error detected. Triggering switch.", errorMessage);
        throw new Error('KEY_SWITCH_NEEDED');
    }
    
    // Fallback logic for single-key setup or legacy errors
    if (is429) {
        throw new Error('RATE_LIMIT_EXCEEDED');
    }
    
    // Fallback for other errors (display in chat)
    return {
      textParts: ["...", "抱歉，刚才信号有点不好...", "能再说一遍吗？"],
      emotion: 'neutral',
      groundingSources: []
    };
  }
};

export interface TemporalQueryAnalysis {
  isTemporalQuery: boolean;
  startTimestampJST: number | null;
  endTimestampJST: number | null;
  searchRole: 'user' | 'model' | 'any';
  precision: TemporalQueryPrecision | null;
  source: TemporalQuerySource;
  confidence: TemporalQueryConfidence;
}

export interface TemporalQueryDiagnostics {
  status: TemporalQueryDiagnosticsStatus;
  source: TemporalQuerySource | null;
  precision: TemporalQueryPrecision | null;
  confidence: TemporalQueryConfidence | null;
  errorMessage: string | null;
  outputPreview: string | null;
}

export interface TemporalQueryAnalysisResult {
  analysis: TemporalQueryAnalysis | null;
  diagnostics: TemporalQueryDiagnostics;
}

export type HistoricalQueryRewriteIntent = 'exact' | 'temporal' | 'semantic' | 'topic_search' | 'none';
export type HistoricalSearchStrategy = 'exact_time' | 'temporal_range' | 'topic_search' | 'none';

export interface HistoricalQueryRewrite {
  intent: HistoricalQueryRewriteIntent;
  rewrittenQuery: string;
  searchRole: 'user' | 'model' | 'any';
  precision: TemporalQueryPrecision | null;
  source: 'main_model';
  confidence: TemporalQueryConfidence;
  reason: string | null;
  searchStrategy: HistoricalSearchStrategy;
  searchKeywords: string[];
  topicQuery: string | null;
}

export interface HistoricalQueryRewriteResult {
  rewrite: HistoricalQueryRewrite | null;
  errorMessage: string | null;
  outputPreview: string | null;
}

const MEMORY_HISTORY_TEMPORAL_MARKERS = /(?:昨天|前天|今天|那天|那次|刚才|之前|当时|最开始|一开始|最初|开头|上周|上个月|这些天|最近|近来|这段时间|这几天|这阵子|近几天|过去几天|\d{1,2}\s*月|\d{1,2}\s*[号日]|\d{1,2}\s*点|\d{1,2}\s*分|凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|深夜|yesterday|today|last night|last week|that time|earlier|before|recently|these days|past few days|at \d{1,2}(?::\d{2})?|\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2})/iu;
const MEMORY_HISTORY_RECALL_MARKERS = /(?:记得|还记得|来着|说了什么|聊了什么|提到什么|做什么|什么内容|哪天|什么时候|几点|我说|我发|你说|你发|久美子说|久美子发|我们聊|what did|when did|do you remember|remember when|talked about|said|what was)/iu;
const MEMORY_HISTORY_TOPIC_MARKERS = /(?:关于.{1,10}(?:聊|说|提|讨论|记得|话题)|聊过|说过|讨论过|提到过|谈过|我们.*话题|所有.*聊天|全部.*对话)/iu;

const isMemoryHistoryQueryLike = (text: string) => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (/(?:最开始|一开始|最初|开头|第一个话题|第一句|第一条)/u.test(normalized) && MEMORY_HISTORY_RECALL_MARKERS.test(normalized)) {
    return true;
  }
  if (/^(?:再试一次|再想想|再确认|可能是|应该是|美国时间(?:的)?|前后(?:\s*\d+\s*分钟?)?|左右|大概|大约|差不多|那时候|那会儿|那段|那次|那话题|那内容|后来呢|然后呢|所以呢)/u.test(normalized)) {
    return true;
  }
  if (MEMORY_HISTORY_TOPIC_MARKERS.test(normalized)) {
    return true;
  }
  return MEMORY_HISTORY_TEMPORAL_MARKERS.test(normalized) && MEMORY_HISTORY_RECALL_MARKERS.test(normalized);
};

const normalizeTemporalQuerySource = (value: unknown, fallback: TemporalQuerySource): TemporalQuerySource => (
  value === 'local_heuristic' || value === 'main_model'
    ? value
    : fallback
);

const inferTemporalQueryPrecision = (
  startTimestampJST: number | null,
  endTimestampJST: number | null
): TemporalQueryPrecision | null => {
  if (!Number.isFinite(startTimestampJST) || !Number.isFinite(endTimestampJST)) {
    return null;
  }

  const spanMs = Math.max(0, (endTimestampJST as number) - (startTimestampJST as number));
  if (spanMs <= 2 * 60 * 1000) return 'exact_minute';
  if (spanMs <= 30 * 60 * 1000) return 'approximate_minutes';
  if (spanMs <= 12 * 60 * 60 * 1000) return 'hour_window';
  return 'day_window';
};

const normalizeTemporalQueryPrecision = (
  value: unknown,
  startTimestampJST: number | null,
  endTimestampJST: number | null
): TemporalQueryPrecision | null => {
  if (
    value === 'exact_minute'
    || value === 'approximate_minutes'
    || value === 'hour_window'
    || value === 'day_window'
  ) {
    return value;
  }
  return inferTemporalQueryPrecision(startTimestampJST, endTimestampJST);
};

const inferTemporalQueryConfidence = (
  source: TemporalQuerySource,
  precision: TemporalQueryPrecision | null
): TemporalQueryConfidence => {
  if (source === 'local_heuristic') {
    return precision === 'day_window' ? 'medium' : 'high';
  }

  if (precision === 'exact_minute' || precision === 'approximate_minutes' || precision === 'hour_window') {
    return 'medium';
  }

  return 'low';
};

const normalizeTemporalQueryConfidence = (
  value: unknown,
  source: TemporalQuerySource,
  precision: TemporalQueryPrecision | null
): TemporalQueryConfidence => (
  value === 'high' || value === 'medium' || value === 'low'
    ? value
    : inferTemporalQueryConfidence(source, precision)
);

const stringifyTemporalAnalysisError = (error: unknown) => {
  if (error instanceof Error) return error.message;
  return String(error);
};

const normalizeHistoricalQueryRewriteIntent = (value: unknown): HistoricalQueryRewriteIntent => (
  value === 'exact' || value === 'temporal' || value === 'semantic' || value === 'topic_search' || value === 'none'
    ? value
    : 'none'
);

const normalizeHistoricalSearchStrategy = (value: unknown): HistoricalSearchStrategy => (
  value === 'exact_time' || value === 'temporal_range' || value === 'topic_search' || value === 'none'
    ? value
    : 'none'
);

const inferSearchStrategyFromIntent = (intent: HistoricalQueryRewriteIntent): HistoricalSearchStrategy => {
  switch (intent) {
    case 'exact': return 'exact_time';
    case 'temporal': return 'temporal_range';
    case 'semantic':
    case 'topic_search': return 'topic_search';
    default: return 'none';
  }
};

const coerceHistoricalQueryRewrite = (candidate: any): HistoricalQueryRewrite | null => {
  if (!candidate || typeof candidate !== 'object') return null;

  const intent = normalizeHistoricalQueryRewriteIntent(candidate.intent);
  const rewrittenQuery = typeof candidate.rewrittenQuery === 'string'
    ? candidate.rewrittenQuery.trim()
    : '';
  const searchRole = candidate.searchRole === 'user' || candidate.searchRole === 'model' || candidate.searchRole === 'any'
    ? candidate.searchRole
    : getTemporalSearchRoleFromQuery(rewrittenQuery);
  const precision = (
    candidate.precision === 'exact_minute'
    || candidate.precision === 'approximate_minutes'
    || candidate.precision === 'hour_window'
    || candidate.precision === 'day_window'
  )
    ? candidate.precision
    : null;
  const confidence = normalizeTemporalQueryConfidence(candidate.confidence, 'main_model', precision);
  const reason = typeof candidate.reason === 'string' && candidate.reason.trim().length > 0
    ? candidate.reason.trim()
    : null;

  const rawStrategy = normalizeHistoricalSearchStrategy(candidate.searchStrategy);
  const searchStrategy: HistoricalSearchStrategy = rawStrategy !== 'none'
    ? rawStrategy
    : inferSearchStrategyFromIntent(intent);
  const searchKeywords: string[] = Array.isArray(candidate.searchKeywords)
    ? candidate.searchKeywords.filter((k: unknown) => typeof k === 'string' && k.trim().length > 0).map((k: string) => k.trim())
    : [];
  const topicQuery: string | null = typeof candidate.topicQuery === 'string' && candidate.topicQuery.trim().length > 0
    ? candidate.topicQuery.trim()
    : null;

  if (intent !== 'none' && !rewrittenQuery) return null;

  return {
    intent,
    rewrittenQuery,
    searchRole,
    precision,
    source: 'main_model',
    confidence,
    reason,
    searchStrategy,
    searchKeywords,
    topicQuery,
  };
};

const parseHistoricalQueryRewrite = (text: string): HistoricalQueryRewrite | null => {
  const normalized = String(text || '').trim();
  if (!normalized) return null;

  const tryParse = (raw: string) => {
    try {
      return coerceHistoricalQueryRewrite(JSON.parse(raw));
    } catch {
      return null;
    }
  };

  const direct = tryParse(normalized);
  if (direct) return direct;

  const objectMatch = normalized.match(/\{[\s\S]*\}/);
  if (!objectMatch) return null;
  return tryParse(objectMatch[0]);
};

const buildTemporalQueryDiagnostics = (
  status: TemporalQueryDiagnosticsStatus,
  analysis: TemporalQueryAnalysis | null,
  errorMessage: string | null = null,
  outputPreview: string | null = null
): TemporalQueryDiagnostics => ({
  status,
  source: analysis?.source ?? null,
  precision: analysis?.precision ?? null,
  confidence: analysis?.confidence ?? null,
  errorMessage,
  outputPreview,
});

const coerceTemporalQueryAnalysis = (
  value: unknown,
  fallbackSource: TemporalQuerySource = 'main_model'
): TemporalQueryAnalysis | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;

  const isTemporalQuery = Boolean(candidate.isTemporalQuery);
  const startTimestampJST =
    typeof candidate.startTimestampJST === 'number' && Number.isFinite(candidate.startTimestampJST)
      ? candidate.startTimestampJST
      : null;
  const endTimestampJST =
    typeof candidate.endTimestampJST === 'number' && Number.isFinite(candidate.endTimestampJST)
      ? candidate.endTimestampJST
      : null;
  const searchRole =
    candidate.searchRole === 'user' || candidate.searchRole === 'model' || candidate.searchRole === 'any'
      ? candidate.searchRole
      : 'any';
  const source = normalizeTemporalQuerySource(candidate.source, fallbackSource);
  const precision = normalizeTemporalQueryPrecision(candidate.precision, startTimestampJST, endTimestampJST);
  const confidence = normalizeTemporalQueryConfidence(candidate.confidence, source, precision);

  if (startTimestampJST !== null && endTimestampJST !== null && startTimestampJST > endTimestampJST) {
    return {
      isTemporalQuery,
      startTimestampJST: endTimestampJST,
      endTimestampJST: startTimestampJST,
      searchRole,
      precision: normalizeTemporalQueryPrecision(candidate.precision, endTimestampJST, startTimestampJST),
      source,
      confidence: normalizeTemporalQueryConfidence(candidate.confidence, source, normalizeTemporalQueryPrecision(candidate.precision, endTimestampJST, startTimestampJST)),
    };
  }

  return {
    isTemporalQuery,
    startTimestampJST,
    endTimestampJST,
    searchRole,
    precision,
    source,
    confidence,
  };
};

const extractJsonObjectFromText = (text: string): string | null => {
  const cleaned = String(text || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  if (!cleaned) return null;

  const firstBrace = cleaned.indexOf('{');
  if (firstBrace === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = firstBrace; index < cleaned.length; index += 1) {
    const char = cleaned[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return cleaned.slice(firstBrace, index + 1);
      }
    }
  }

  return cleaned.slice(firstBrace);
};

const parseTemporalQueryAnalysis = (
  text: string,
  fallbackSource: TemporalQuerySource = 'main_model'
): TemporalQueryAnalysis | null => {
  const extracted = extractJsonObjectFromText(text);
  if (!extracted) return null;

  const attempts = [
    extracted,
    extracted.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']'),
  ];

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      const normalized = coerceTemporalQueryAnalysis(parsed, fallbackSource);
      if (normalized) return normalized;
    } catch {
      // Try the next relaxed parse form.
    }
  }

  return null;
};

type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const getTimeZoneDateParts = (date: Date, timeZone: string): ZonedDateParts => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  });
  const result: Record<string, string> = {};
  formatter.formatToParts(date).forEach(part => {
    result[part.type] = part.value;
  });
  return {
    year: Number(result.year),
    month: Number(result.month),
    day: Number(result.day),
    hour: Number(result.hour),
    minute: Number(result.minute),
    second: Number(result.second),
  };
};

const getTimeZoneOffsetMs = (date: Date, timeZone: string) => {
  const zoned = getTimeZoneDateParts(date, timeZone);
  const asUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second);
  return asUtc - date.getTime();
};

const zonedDateTimeToTimestamp = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
) => {
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = targetUtc;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offset = getTimeZoneOffsetMs(new Date(guess), timeZone);
    const next = targetUtc - offset;
    if (Math.abs(next - guess) < 1000) {
      guess = next;
      break;
    }
    guess = next;
  }

  return guess;
};

export const getTemporalSearchRoleFromQuery = (query: string): 'user' | 'model' | 'any' => {
  const normalized = String(query || '').replace(/\s+/g, ' ').trim();
  if (/(?:我|用户)(?:[^。？！,.，\n]{0,32})?(?:说|发|提到|讲)/u.test(normalized)) return 'user';
  if (/(?:你|久美子)(?:[^。？！,.，\n]{0,32})?(?:说|发|提到|讲)/u.test(normalized)) return 'model';
  return 'any';
};

type ParsedClockExpression = {
  period: string | null;
  hour: number;
  minute: number | null;
};

const parseExplicitClockExpression = (text: string): ParsedClockExpression | null => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const pointMatch = normalized.match(/(?:(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|深夜)\s*)?(\d{1,2})\s*(?:点|时)(?:\s*(\d{1,2})\s*分?)?/u);
  if (pointMatch) {
    return {
      period: pointMatch[1] || null,
      hour: Number(pointMatch[2]),
      minute: pointMatch[3] ? Number(pointMatch[3]) : null,
    };
  }

  const colonMatch = normalized.match(/(?:(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|深夜)\s*)?(\d{1,2})\s*[:：]\s*(\d{1,2})/u);
  if (colonMatch) {
    return {
      period: colonMatch[1] || null,
      hour: Number(colonMatch[2]),
      minute: Number(colonMatch[3]),
    };
  }

  return null;
};

const detectChinesePeriodExpression = (text: string): string | null => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const match = normalized.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|深夜)/u);
  return match?.[1] || null;
};

const applyChinesePeriodToHour = (hour: number, period: string | null) => {
  if (!period) return hour;
  if ((period === '下午' || period === '傍晚' || period === '晚上' || period === '夜里' || period === '深夜') && hour < 12) {
    return hour + 12;
  }
  if (period === '中午') {
    if (hour === 0) return 12;
    if (hour >= 1 && hour <= 10) return hour + 12;
    return hour;
  }
  if (period === '凌晨' && hour === 12) return 0;
  return hour;
};

const getDisplayTimeZone = () => {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo';
};

const getUserCharacterTimeZone = (locationConfig?: LocationConfig) => {
  return locationConfig?.userTimezone || getDisplayTimeZone();
};

const resolveTemporalQueryReferenceTimeZone = (query: string, locationConfig?: LocationConfig) => {
  const normalized = String(query || '').replace(/\s+/g, ' ').trim();
  if (/(?:\bJST\b|日本时间|东京时间|Japan Standard Time)/iu.test(normalized)) {
    return 'Asia/Tokyo';
  }
  if (/(?:用户时间|当地时间|美国时间|user time|local time)/iu.test(normalized)) {
    return getUserCharacterTimeZone(locationConfig);
  }
  return getDisplayTimeZone();
};

const buildUserDateRange = (
  year: number,
  month: number,
  day: number,
  startHour: number,
  startMinute: number,
  startSecond: number,
  endHour: number,
  endMinute: number,
  endSecond: number,
  timeZone: string
) => {
  return {
    startTimestampJST: zonedDateTimeToTimestamp(year, month, day, startHour, startMinute, startSecond, timeZone),
    endTimestampJST: zonedDateTimeToTimestamp(year, month, day, endHour, endMinute, endSecond, timeZone),
  };
};

const buildCenterRange = (centerTimestamp: number, deltaMinutes: number) => ({
  startTimestampJST: centerTimestamp - (deltaMinutes * 60 * 1000),
  endTimestampJST: centerTimestamp + (deltaMinutes * 60 * 1000),
});

const buildTemporalQueryAnalysisResult = (
  startTimestampJST: number | null,
  endTimestampJST: number | null,
  searchRole: 'user' | 'model' | 'any',
  precision: TemporalQueryPrecision | null,
  source: TemporalQuerySource
): TemporalQueryAnalysis => ({
  isTemporalQuery: true,
  startTimestampJST,
  endTimestampJST,
  searchRole,
  precision,
  source,
  confidence: normalizeTemporalQueryConfidence(null, source, precision),
});

const CN_MINUTE_MAP: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

const extractFollowUpMinuteWindow = (text: string): number | null => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const numericMatch = normalized.match(/前后\s*(\d{1,2})\s*分(?:钟)?/u);
  if (numericMatch) {
    return Number(numericMatch[1]);
  }

  const cnMatch = normalized.match(/前后\s*([一二两三四五六七八九十]{1,3})\s*分(?:钟)?/u);
  if (!cnMatch) return null;

  const raw = cnMatch[1];
  if (raw === '十') return 10;
  if (raw.length === 2 && raw.startsWith('十')) {
    return 10 + (CN_MINUTE_MAP[raw[1]] || 0);
  }
  if (raw.length === 2 && raw.endsWith('十')) {
    return (CN_MINUTE_MAP[raw[0]] || 0) * 10;
  }
  if (raw.length === 3 && raw[1] === '十') {
    return ((CN_MINUTE_MAP[raw[0]] || 0) * 10) + (CN_MINUTE_MAP[raw[2]] || 0);
  }
  return CN_MINUTE_MAP[raw] || null;
};

const getPeriodWindow = (period: string | null) => {
  switch (period) {
    case '凌晨':
      return { startHour: 0, startMinute: 0, endHour: 5, endMinute: 59 };
    case '早上':
    case '上午':
      return { startHour: 6, startMinute: 0, endHour: 11, endMinute: 59 };
    case '中午':
      return { startHour: 11, startMinute: 30, endHour: 13, endMinute: 59 };
    case '下午':
    case '傍晚':
      return { startHour: 13, startMinute: 0, endHour: 18, endMinute: 59 };
    case '晚上':
    case '夜里':
    case '深夜':
      return { startHour: 18, startMinute: 0, endHour: 23, endMinute: 59 };
    default:
      return null;
  }
};

const buildHeuristicTemporalQueryAnalysis = (query: string, locationConfig?: LocationConfig): TemporalQueryAnalysis | null => {
  const normalized = String(query || '').replace(/\s+/g, ' ').trim();
  if (!isMemoryHistoryQueryLike(normalized)) return null;

  const userTimeZone = resolveTemporalQueryReferenceTimeZone(normalized, locationConfig);
  const searchRole = getTemporalSearchRoleFromQuery(normalized);
  const now = new Date();
  const userNowParts = getTimeZoneDateParts(now, userTimeZone);
  const approximate = /(?:大约|大概|差不多|左右|around|about|也算|也可以算)/iu.test(normalized);
  const refinementMinutes = extractFollowUpMinuteWindow(normalized);

  const zhDateMatch = normalized.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?/u);
  const isoDateMatch = normalized.match(/(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})/u);
  const dateMatch = zhDateMatch || isoDateMatch;
  const clockExpression = parseExplicitClockExpression(normalized);
  const periodExpression = detectChinesePeriodExpression(normalized);

  if (dateMatch) {
    const year = Number(dateMatch[1] || userNowParts.year);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    const period = clockExpression?.period || periodExpression;
    const rawHour = clockExpression?.hour;
    const rawMinute = clockExpression?.minute;

    if (Number.isFinite(month) && Number.isFinite(day)) {
      if (typeof rawHour === 'number' && Number.isFinite(rawHour)) {
        const hour = applyChinesePeriodToHour(rawHour, period);
        const minute = typeof rawMinute === 'number' && Number.isFinite(rawMinute) ? rawMinute : 0;
        const center = zonedDateTimeToTimestamp(year, month, day, hour, minute, 0, userTimeZone);
        if (typeof rawMinute === 'number' && Number.isFinite(rawMinute)) {
          const minuteWindow = refinementMinutes ?? (approximate ? 5 : null);
          const range = minuteWindow === null
            ? buildUserDateRange(year, month, day, hour, minute, 0, hour, minute, 59, userTimeZone)
            : buildCenterRange(center, minuteWindow);
          return buildTemporalQueryAnalysisResult(
            range.startTimestampJST,
            range.endTimestampJST,
            searchRole,
            minuteWindow === null || minuteWindow <= 1 ? 'exact_minute' : 'approximate_minutes',
            'local_heuristic'
          );
        }

        if (refinementMinutes !== null || approximate) {
          const range = buildCenterRange(center, refinementMinutes ?? 15);
          return buildTemporalQueryAnalysisResult(
            range.startTimestampJST,
            range.endTimestampJST,
            searchRole,
            'approximate_minutes',
            'local_heuristic'
          );
        }

        const range = buildUserDateRange(year, month, day, hour, 0, 0, hour, 59, 59, userTimeZone);
        return buildTemporalQueryAnalysisResult(
          range.startTimestampJST,
          range.endTimestampJST,
          searchRole,
          'hour_window',
          'local_heuristic'
        );
      }

      const periodWindow = getPeriodWindow(period);
      const range = periodWindow
        ? buildUserDateRange(year, month, day, periodWindow.startHour, periodWindow.startMinute, 0, periodWindow.endHour, periodWindow.endMinute, 59, userTimeZone)
        : buildUserDateRange(year, month, day, 0, 0, 0, 23, 59, 59, userTimeZone);
      return buildTemporalQueryAnalysisResult(
        range.startTimestampJST,
        range.endTimestampJST,
        searchRole,
        periodWindow ? 'hour_window' : 'day_window',
        'local_heuristic'
      );
    }
  }

  let dayOffset: number | null = null;
  if (/(?:昨天|yesterday|last night)/iu.test(normalized)) dayOffset = -1;
  else if (/前天/iu.test(normalized)) dayOffset = -2;
  else if (/(?:今天|today|刚才|earlier)/iu.test(normalized)) dayOffset = 0;

  if (dayOffset !== null) {
    const userRef = new Date(now.getTime() + (dayOffset * 24 * 60 * 60 * 1000));
    const userRefParts = getTimeZoneDateParts(userRef, userTimeZone);
    const period = clockExpression?.period || periodExpression;
    const rawHour = clockExpression?.hour;
    const rawMinute = clockExpression?.minute;

    if (typeof rawHour === 'number' && Number.isFinite(rawHour)) {
      const hour = applyChinesePeriodToHour(rawHour, period);
      const minute = typeof rawMinute === 'number' && Number.isFinite(rawMinute) ? rawMinute : 0;
      const center = zonedDateTimeToTimestamp(userRefParts.year, userRefParts.month, userRefParts.day, hour, minute, 0, userTimeZone);
      if (typeof rawMinute === 'number' && Number.isFinite(rawMinute)) {
        const minuteWindow = refinementMinutes ?? (approximate ? 5 : null);
        const range = minuteWindow === null
          ? buildUserDateRange(userRefParts.year, userRefParts.month, userRefParts.day, hour, minute, 0, hour, minute, 59, userTimeZone)
          : buildCenterRange(center, minuteWindow);
        return buildTemporalQueryAnalysisResult(
          range.startTimestampJST,
          range.endTimestampJST,
          searchRole,
          minuteWindow === null || minuteWindow <= 1 ? 'exact_minute' : 'approximate_minutes',
          'local_heuristic'
        );
      }

      if (refinementMinutes !== null || approximate) {
        const range = buildCenterRange(center, refinementMinutes ?? 15);
        return buildTemporalQueryAnalysisResult(
          range.startTimestampJST,
          range.endTimestampJST,
          searchRole,
          'approximate_minutes',
          'local_heuristic'
        );
      }

      const range = buildUserDateRange(userRefParts.year, userRefParts.month, userRefParts.day, hour, 0, 0, hour, 59, 59, userTimeZone);
      return buildTemporalQueryAnalysisResult(
        range.startTimestampJST,
        range.endTimestampJST,
        searchRole,
        'hour_window',
        'local_heuristic'
      );
    }

    const periodWindow = getPeriodWindow(period);
    const range = periodWindow
      ? buildUserDateRange(userRefParts.year, userRefParts.month, userRefParts.day, periodWindow.startHour, periodWindow.startMinute, 0, periodWindow.endHour, periodWindow.endMinute, 59, userTimeZone)
      : buildUserDateRange(userRefParts.year, userRefParts.month, userRefParts.day, 0, 0, 0, 23, 59, 59, userTimeZone);
    return buildTemporalQueryAnalysisResult(
      range.startTimestampJST,
      range.endTimestampJST,
      searchRole,
      periodWindow ? 'hour_window' : 'day_window',
      'local_heuristic'
    );
  }

  return null;
};

export const analyzeTemporalQueryDetailed = async (query: string, locationConfig?: LocationConfig): Promise<TemporalQueryAnalysisResult> => {
  const heuristicResult = buildHeuristicTemporalQueryAnalysis(query, locationConfig);
  if (heuristicResult) {
      console.log("[Temporal Intent] Using local heuristic parser.", heuristicResult);
      return {
        analysis: heuristicResult,
        diagnostics: buildTemporalQueryDiagnostics('heuristic_success', heuristicResult),
      };
  }

  let rawModelOutput = "";
  try {
      const config = getCurrentAIConfig();
      const provider = config.provider || 'gemini';
      const transportProvider = resolveTransportProvider(provider, config.useCustomEndpoint ? config.customEndpoint : undefined);
      
      const now = new Date();
      let jstTime = "??:??";
      try {
          jstTime = now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
      } catch(e) {}
      
      let userTime = "??:??";
      if (locationConfig?.userTimezone) {
          try {
             userTime = now.toLocaleString('en-US', { timeZone: locationConfig.userTimezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
          } catch(e) {}
      }

      const prompt = `
You are an intent parser. Your job is to extract temporal boundaries from a user's conversational query.

[CURRENT TIME REFERENCE]
Current JST (Japan Standard Time): ${jstTime}
Current User Time: ${userTime}
Default rule: interpret the user's query in the user's timezone and convert the computed boundaries into JST (Japan Standard Time) timestamps.
Override rule: if the query explicitly says JST / Japan time / 日本时间 / 东京时间, treat the stated time as already being in JST and DO NOT convert it from the user's timezone again.

[USER QUERY]
"${query}"

[RULES]
1. Determine if the user is asking about a past conversation (e.g., "What did we talk about yesterday?", "What did I say on March 17th?").
2. If YES, set isTemporalQuery = true. If NO, set isTemporalQuery = false.
3. If a specific time block is implied (e.g., "yesterday", "March 17th at 10pm"), calculate the startTimestampJST and endTimestampJST covering that block in milliseconds. 
4. If it's a general past request, you may set timestamps to null.
5. searchRole: Determine who the user is asking about. "What did *I* say" -> 'user'. "What did *you* say" -> 'model'. "What did *we* talk about" -> 'any'.
6. precision: classify the result window as one of:
   - "exact_minute"
   - "approximate_minutes"
   - "hour_window"
   - "day_window"
7. source: always set to "main_model".
8. confidence: set:
   - "medium" for specific minute/hour style windows
   - "low" for vague day-wide windows

You MUST output ONLY valid JSON matching this schema exactly:
{
  "isTemporalQuery": boolean,
  "startTimestampJST": number | null,
  "endTimestampJST": number | null,
  "searchRole": "user" | "model" | "any",
  "precision": "exact_minute" | "approximate_minutes" | "hour_window" | "day_window" | null,
  "source": "main_model",
  "confidence": "high" | "medium" | "low"
}
`;

      let modelName = config.model_main || 'gemini-2.5-flash'; // Enforcing use of the MAIN model as requested by user

      let text = "";
      if (transportProvider === 'openai' || transportProvider === 'deepseek' || transportProvider === 'grok' || transportProvider === 'openrouter') {
          const result = await callOpenAI(config, modelName, "You are an AI Text-to-SQL Intent Parser. Output pure JSON.", [], prompt);
          text = result.text || "";
      } else if (transportProvider === 'anthropic') {
          const result = await callAnthropic(config, modelName, "You are an AI Text-to-SQL Intent Parser. Output pure JSON.", [], prompt);
          text = result.text || "";
      } else {
          const ai = getGenAI();
          const result = await ai.models.generateContent({
            model: modelName, 
            contents: prompt,
            config: { responseMimeType: 'application/json' }
          });
          text = result.text || "";
      }
      rawModelOutput = text;
      const parsed = parseTemporalQueryAnalysis(text, 'main_model');
      if (!parsed) {
        throw new SyntaxError(`Unable to parse temporal intent JSON: ${text.slice(0, 200)}`);
      }
      return {
        analysis: parsed,
        diagnostics: buildTemporalQueryDiagnostics('main_model_success', parsed, null, text.slice(0, 200) || null),
      };
  } catch (e) {
      const fallback = buildHeuristicTemporalQueryAnalysis(query, locationConfig);
      if (fallback) {
          console.warn("[Temporal Intent] Main-model parsing failed; using local heuristic fallback.", e);
          return {
            analysis: fallback,
            diagnostics: buildTemporalQueryDiagnostics(
              'heuristic_fallback_after_model_failure',
              fallback,
              stringifyTemporalAnalysisError(e),
              rawModelOutput.slice(0, 200) || null
            ),
          };
      }
      console.warn("[Temporal Intent] Parsing failed using main model:", e);
      const errorMessage = stringifyTemporalAnalysisError(e);
      return {
        analysis: null,
        diagnostics: buildTemporalQueryDiagnostics(
          e instanceof SyntaxError ? 'main_model_parse_failed' : 'main_model_error',
          null,
          errorMessage,
          rawModelOutput.slice(0, 200) || null
        ),
      };
  }
};

export const rewriteHistoricalRecallQueryDetailed = async (
  query: string,
  locationConfig?: LocationConfig,
  options?: { bypassGate?: boolean; recentMessages?: Message[] }
): Promise<HistoricalQueryRewriteResult> => {
  const normalized = String(query || '').replace(/\s+/g, ' ').trim();
  if (!options?.bypassGate && !isMemoryHistoryQueryLike(normalized)) {
    return {
      rewrite: null,
      errorMessage: null,
      outputPreview: null,
    };
  }

  let rawModelOutput = "";
  try {
    const config = getCurrentAIConfig();
    const provider = config.provider || 'gemini';
    const transportProvider = resolveTransportProvider(provider, config.useCustomEndpoint ? config.customEndpoint : undefined);
    const modelName = config.model_main || 'gemini-2.5-flash';
    const now = new Date();
    const displayTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo';
    const characterTimeZone = locationConfig?.userTimezone || displayTimeZone;
    const modelTimeZone = locationConfig?.modelTimezone || 'Asia/Tokyo';

    let jstTime = "??:??";
    let displayTime = "??:??";
    let characterTime = "??:??";
    try {
      jstTime = now.toLocaleString('en-US', {
        timeZone: modelTimeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
    } catch {}
    try {
      displayTime = now.toLocaleString('en-US', {
        timeZone: displayTimeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
    } catch {}
    try {
      characterTime = now.toLocaleString('en-US', {
        timeZone: characterTimeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
    } catch {}

    let recentContextStr = "None provided.";
    if (options?.recentMessages && options.recentMessages.length > 0) {
      recentContextStr = options.recentMessages.map(m => `${m.role === 'user' ? 'User' : 'Kumiko'}: ${m.text}`).join('\n');
    }

    const prompt = `
You are a query rewriter for a local chat-history retrieval system.
Your job is NOT to answer the user. Your only job is to transform a natural-language memory question into a structured retrieval command that search code can parse reliably.

[CURRENT TIME REFERENCE]
Current Kumiko/JST Time: ${jstTime}
Current Display Time (user's screen clock): ${displayTime}
Display Timezone: ${displayTimeZone}
User Character Timezone: ${characterTimeZone}
Current Character Time: ${characterTime}
Kumiko Timezone: ${modelTimeZone}

[RECENT CONVERSATION CONTEXT]
${recentContextStr}

[INPUT QUERY]
"${normalized}"

[OUTPUT JSON SCHEMA]
{
  "intent": "exact" | "temporal" | "semantic" | "topic_search" | "none",
  "searchStrategy": "exact_time" | "temporal_range" | "topic_search" | "none",
  "rewrittenQuery": string,
  "searchRole": "user" | "model" | "any",
  "precision": "exact_minute" | "approximate_minutes" | "hour_window" | "day_window" | null,
  "confidence": "high" | "medium" | "low",
  "reason": string | null,
  "searchKeywords": string[],
  "topicQuery": string | null
}

[RULES]
1. Output ONLY valid JSON.
2. rewrittenQuery MUST always use a canonical Chinese retrieval format, even if the input question is colloquial.
3. If the user asks for exact wording at a precise time ("我说了什么", "你说了什么"), set intent to "exact" and searchStrategy to "exact_time".
4. If the user asks what happened or what was discussed in a broader time range, set intent to "temporal" and searchStrategy to "temporal_range".
5. If the user asks about a remembered topic/theme rather than a time-pinned quote, set intent to "semantic" and searchStrategy to "topic_search".
6. If the user asks about a specific entity, person, or topic across conversations (e.g. "关于丽奈", "我们聊过的X话题"), set intent to "topic_search" and searchStrategy to "topic_search".
7. Preserve speaker faithfully:
   - "我说了什么" => searchRole "user"
   - "你说了什么" => searchRole "model"
   - "我们聊了什么" => searchRole "any"
8. CRITICAL TIMEZONE RULE: The app shows timestamps in TWO places — chat bubbles use Display Timezone (${displayTimeZone}), while the memory/context editor uses JST (Asia/Tokyo). When the user references a time, they could be reading EITHER. Because the retrieval system searches a wide window (±30 min) around the target, use the MOST LIKELY interpretation: if Display Timezone and JST differ by ≤1 hour, just output the time as JST directly (the wide window covers the gap). If they differ by more, convert from Display Timezone to JST. Do NOT use the User Character Timezone for this conversion.
9. If the query explicitly mentions Japan time / JST / 日本時間, keep it in JST.
10. Do not invent content. Only normalize intent, speaker, time range, timezone conversion, and extract keywords.
11. Preferred rewrittenQuery patterns:
   - exact minute: "2026年3月18日 10:15 JST 我说了什么"
   - exact hour: "2026年3月18日 10点 JST 我们聊了什么"
   - nearby window: "2026年3月18日 10:15 JST 前后5分钟 我们聊了什么"
   - semantic recall: "回忆检索 3月18日 那次关于X的对话内容"
   - topic search: "回忆检索 关于丽奈的所有对话内容"
12. searchKeywords: Extract the core entity names, person names, or topic keywords from the query. Include ALL name variants the user might use (short name, full name, alternate spellings). For example, if the user mentions "丽奈", include ["丽奈", "高坂丽奈"]. For non-topic queries, set to [].
13. topicQuery: For topic_search, write a clear embedding-friendly retrieval query describing what to search for (e.g. "关于高坂丽奈的对话内容"). For non-topic queries, set to null.
14. For follow-up queries referencing a previous topic (e.g. "这些天来" after asking about a topic, "不只是那一天", "之前聊的啥", "那校园祭那天呢"), infer the topic or time anchor from the [RECENT CONVERSATION CONTEXT].
    - Pronoun/Omission Resolution: If the query uses pronouns ("他", "那个") or omits the subject ("之前聊的啥", "刚才说的"), resolve it using the recent context (e.g., rewrite to "关于秀一的对话内容").
    - Relative Time Resolution: If the query uses relative time ("那之前呢", "后来呢") anchored to a recently mentioned event (e.g., "校园祭"), resolve it (e.g., rewrite to "校园祭之前发生的事").
15. If there is not enough information to improve the query, keep rewrittenQuery close to the original meaning but still make it more canonical. Set searchStrategy to "none" only if the query has NOTHING to do with recalling past conversations.
`;

    const callRewrite = async (model: string): Promise<string> => {
      if (transportProvider === 'openai' || transportProvider === 'deepseek' || transportProvider === 'grok' || transportProvider === 'openrouter') {
        const result = await callOpenAI(config, model, "You rewrite history queries and output pure JSON.", [], prompt);
        return result.text || "";
      } else if (transportProvider === 'anthropic') {
        const result = await callAnthropic(config, model, "You rewrite history queries and output pure JSON.", [], prompt);
        return result.text || "";
      } else {
        const ai = getGenAI();
        const result = await ai.models.generateContent({
          model,
          contents: prompt,
          config: { responseMimeType: 'application/json' }
        });
        return result.text || "";
      }
    };

    let text = "";
    try {
      text = await callRewrite(modelName);
    } catch (mainError) {
      console.warn('[HISTORICAL QUERY REWRITE] Main model failed, retrying...', mainError);
      try {
        text = await callRewrite(modelName);
      } catch (retryError) {
        const fallbackModel = config.model_summary;
        if (fallbackModel && fallbackModel !== modelName) {
          console.warn('[HISTORICAL QUERY REWRITE] Retry failed, falling back to summary model:', fallbackModel);
          text = await callRewrite(fallbackModel);
        } else {
          throw retryError;
        }
      }
    }

    rawModelOutput = text;
    const parsed = parseHistoricalQueryRewrite(text);
    if (!parsed) {
      throw new SyntaxError(`Unable to parse historical rewrite JSON: ${text.slice(0, 200)}`);
    }

    console.log('[HISTORICAL QUERY REWRITE]', {
      intent: parsed.intent,
      searchStrategy: parsed.searchStrategy,
      searchRole: parsed.searchRole,
      precision: parsed.precision,
      confidence: parsed.confidence,
      rewrittenQuery: parsed.rewrittenQuery,
      searchKeywords: parsed.searchKeywords,
      topicQuery: parsed.topicQuery,
      reason: parsed.reason,
    });

    return {
      rewrite: parsed,
      errorMessage: null,
      outputPreview: text.slice(0, 200) || null,
    };
  } catch (error) {
    console.warn('[HISTORICAL QUERY REWRITE] All rewrite attempts failed.', error);
    return {
      rewrite: null,
      errorMessage: stringifyTemporalAnalysisError(error),
      outputPreview: rawModelOutput.slice(0, 200) || null,
    };
  }
};

export const analyzeTemporalQuery = async (query: string, locationConfig?: LocationConfig): Promise<TemporalQueryAnalysis | null> => {
  const result = await analyzeTemporalQueryDetailed(query, locationConfig);
  return result.analysis;
};

/**
 * Lightweight LLM call that bypasses the full Kumiko conversation pipeline.
 * No retry guard, no textParts splitting, no persona injection.
 * Used for translation and other utility tasks where raw text output is needed.
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
