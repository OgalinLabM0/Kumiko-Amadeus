import { AIConfig, Message, WorldBookEntry, LocationConfig, AnchorEntry, Language } from "../types";
import { GoogleGenAI } from "@google/genai";
import { getDefaultVisionModel, isOpenAICompatibleProvider, resolveTransportProvider } from "./appConfig";

export interface ProviderResponse {
    text: string;
    functionCalls?: any[];
    groundingSources?: any[];
    rawToolCall?: any;
    // Transport-only assistant turn, including provider-required tool metadata.
    // Never concatenate this into the displayed answer or memory text.
    rawAssistantTurn?: any;
}

export interface ChatToolOutput {
    call: { id?: string; name: string; args?: any; argumentError?: string };
    result: Record<string, any>;
    image?: { mimeType: string; data: string };
}

export interface ChatToolRound {
    model: ProviderResponse;
    outputs: ChatToolOutput[];
}

export interface ProviderToolContext {
    rounds: ChatToolRound[];
    signal?: AbortSignal;
}

// Google SDK Type enum values are uppercase; the other transports require
// JSON Schema's lowercase type names. Preserve property names and enum values.
const toJsonSchema = (schema: any): any => {
    if (Array.isArray(schema)) return schema.map(toJsonSchema);
    if (!schema || typeof schema !== 'object') return schema;
    return Object.fromEntries(Object.entries(schema).map(([key, value]) => [
        key,
        key === 'type' && typeof value === 'string' ? value.toLowerCase()
            : key === 'type' && Array.isArray(value) ? value.map(item => typeof item === 'string' ? item.toLowerCase() : item)
            : toJsonSchema(value),
    ]));
};

// v2.14.26: many OpenAI-compatible 中转 vendors (DeepSeek-R1 / Qwen-QwQ /
// some GPT-5 wrappers) and Anthropic show-thinking responses leak the
// raw `<think>...</think>` / `<thinking>...</thinking>` block right
// inside `message.content` / `content[].text`. The Gemini path's
// LEAK CLEANUP block already strips these, but OpenAI/Anthropic
// responses go through a different code path that previously trusted
// the provider to give us "final answer only". Apply the same five
// regex passes here so the chat bubble never sees a `</think>`.
const stripThinkingTags = (raw: string): string => {
    if (!raw) return raw;
    let s = raw;
    s = s.replace(/<think[^>]*>[\s\S]*?<\/think\s*>/gi, '');
    s = s.replace(/<thinking[^>]*>[\s\S]*?<\/thinking\s*>/gi, '');
    s = s.replace(/<think[^>]*>[\s\S]*$/gi, '');
    s = s.replace(/<thinking[^>]*>[\s\S]*$/gi, '');
    s = s.replace(/^[\s\S]*?<\/think\s*>\s*/gi, '');
    s = s.replace(/^[\s\S]*?<\/thinking\s*>\s*/gi, '');
    s = s.replace(/<\/?think(?:ing)?[^>]*\/?\s*>/gi, '');
    return s.trim();
};

type AnthropicContentBlock =
    | { type: 'text'; text: string }
    | {
          type: 'image';
          source: {
              type: 'base64';
              media_type: string;
              data: string;
          };
      }
    | { type: 'tool_result'; tool_use_id: string; content: any; is_error?: boolean };

const mapGeminiPartsToOpenAI = (parts: any[]) => {
    const content: any[] = [];
    for (const p of parts) {
        if (typeof p === 'string') {
            content.push({ type: 'text', text: p });
        } else if (p.text) {
            content.push({ type: 'text', text: p.text });
        } else if (p.inlineData) {
            content.push({ type: 'image_url', image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } });
        } else {
            content.push({ type: 'text', text: JSON.stringify(p) });
        }
    }
    // Keep text-only requests compatible; images must remain actual image parts.
    return content.some(p => p.type === 'image_url') ? content : content.map(p => p.text).join('');
};

const mapGeminiPartsToAnthropic = (parts: any[]): AnthropicContentBlock[] => {
    return parts.map(p => {
        if (typeof p === 'string') return { type: 'text', text: p };
        if (p.text) return { type: 'text', text: p.text };
        if (p.inlineData) {
            return {
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: p.inlineData.mimeType,
                    data: p.inlineData.data
                }
            };
        }
        return { type: 'text', text: JSON.stringify(p) };
    });
};

export const callOpenAI = async (
    config: AIConfig,
    model: string,
    systemInstruction: string,
    history: any[],
    message: any,
    tools?: any[],
    toolContext?: ProviderToolContext
): Promise<ProviderResponse> => {
    let apiKey = config.activeKey === 'backup' ? config.apiKey_backup : config.apiKey_primary;
    if (!apiKey) throw new Error("API Key 缺失，请检查配置");

    let defaultEndpoint = 'https://api.openai.com/v1/chat/completions';
    if (config.provider === 'deepseek') {
        defaultEndpoint = 'https://api.deepseek.com/chat/completions';
    } else if (config.provider === 'grok') {
        defaultEndpoint = 'https://api.x.ai/v1/chat/completions';
    } else if (config.provider === 'openrouter') {
        defaultEndpoint = 'https://openrouter.ai/api/v1/chat/completions';
    } else if (config.provider === 'volcengine') {
        defaultEndpoint = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
    } else if (config.provider === 'dashscope') {
        defaultEndpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
    } else if (config.provider === 'zhipu') {
        defaultEndpoint = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
    } else if (config.provider === 'moonshot') {
        defaultEndpoint = 'https://api.moonshot.cn/v1/chat/completions';
    } else if (config.provider === 'qianfan') {
        defaultEndpoint = 'https://qianfan.baidubce.com/v2/chat/completions';
    } else if (config.provider === 'hunyuan') {
        defaultEndpoint = 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions';
    } else if (config.provider === 'spark') {
        defaultEndpoint = 'https://spark-api-open.xf-yun.com/v1/chat/completions';
    } else if (config.provider === 'minimax') {
        defaultEndpoint = 'https://api.minimaxi.com/v1/chat/completions';
    }

    // 清理 Base URL，去掉末尾的斜杠
    let fetchUrl = config.useCustomEndpoint && config.customEndpoint 
        ? config.customEndpoint.replace(/\/$/, '') 
        : defaultEndpoint;

    // 组装消息列表
    const messages = [];
    
    // 如果有系统提示词，才加入 system 角色（有些简陋 API 不支持空的 system）
    if (systemInstruction && systemInstruction.trim() !== '') {
        messages.push({ role: 'system', content: systemInstruction });
    }

    // 压入历史记录
    history.forEach(h => {
        messages.push({
            role: h.role === 'user' ? 'user' : 'assistant',
            content: mapGeminiPartsToOpenAI(h.parts)
        });
    });

    // 压入当前用户的最新消息
    let currentContent: string | any[] = "";
    if (Array.isArray(message)) {
        currentContent = mapGeminiPartsToOpenAI(message);
    } else if (typeof message === 'string') {
        currentContent = message;
    } else {
        currentContent = mapGeminiPartsToOpenAI([message]);
    }
    
    messages.push({ role: 'user', content: currentContent });
    for (const round of toolContext?.rounds || []) {
        messages.push(round.model.rawAssistantTurn);
        // Return every requested ID before adding the image evidence message.
        for (const output of round.outputs) {
            messages.push({ role: 'tool', tool_call_id: output.call.id, content: JSON.stringify(output.result) });
        }
        const images = round.outputs.filter(output => output.image);
        if (images.length) {
            messages.push({ role: 'user', content: images.flatMap(output => [
                { type: 'text', text: `Image evidence for tool ${output.call.id} (${output.call.name})` },
                { type: 'image_url', image_url: { url: `data:${output.image!.mimeType};base64,${output.image!.data}` } },
            ]) });
        }
    }

    // 准备发送的 Payload
    const payload: any = {
        model: model,
        messages: messages,
        temperature: 0.7,
        max_tokens: 4096 // 加上这个以防某些第三方平台严格要求此字段
    };

    // 添加工具支持 (如果提供且不是在处理工具返回结果)
    if (tools && tools.length > 0) {
        payload.tools = tools.map(t => ({
            type: "function",
            function: {
                name: t.name,
                description: t.description,
                parameters: toJsonSchema(t.parameters)
            }
        }));
        payload.tool_choice = "auto";
    }

    console.log(`[OpenAI Call] 正在请求: ${fetchUrl} | 模型: ${model}`);

    const response = await fetch(fetchUrl, {
        method: 'POST',
        signal: toolContext?.signal,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errText = await response.text();
        console.error(`[OpenAI API Error Payload]:`, errText);
        throw new Error(`OpenAI API Error: ${response.status} ${errText}`);
    }

    const data = await response.json();
    const responseMessage = data.choices?.[0]?.message;

    const rawContent = typeof responseMessage?.content === 'string' ? responseMessage.content : '';
    const result: ProviderResponse = {
        text: stripThinkingTags(rawContent),
        rawAssistantTurn: responseMessage,
    };

    if (responseMessage?.tool_calls && responseMessage.tool_calls.length > 0) {
        result.rawToolCall = responseMessage.tool_calls[0];
        result.functionCalls = responseMessage.tool_calls.map((tc: any) => {
            try {
                return { id: tc.id, name: tc.function.name, args: JSON.parse(tc.function.arguments) };
            } catch {
                return { id: tc.id, name: tc.function?.name, argumentError: 'Invalid JSON tool arguments' };
            }
        });
    }

    return result;
};

export const callAnthropic = async (
    config: AIConfig,
    model: string,
    systemInstruction: string,
    history: any[],
    message: any,
    tools?: any[],
    toolContext?: ProviderToolContext
): Promise<ProviderResponse> => {
    let apiKey = config.activeKey === 'backup' ? config.apiKey_backup : config.apiKey_primary;
    if (!apiKey) throw new Error("API Key 缺失，请检查配置");

    let fetchUrl = config.useCustomEndpoint && config.customEndpoint 
        ? config.customEndpoint.replace(/\/$/, '') 
        : 'https://api.anthropic.com/v1/messages';

    const messages: Array<{ role: 'user' | 'assistant'; content: AnthropicContentBlock[] }> = history.map(h => ({
        role: h.role === 'user' ? 'user' : 'assistant',
        content: mapGeminiPartsToAnthropic(h.parts)
    }));

    let currentContent: AnthropicContentBlock[] = [];
    if (Array.isArray(message)) {
        currentContent = mapGeminiPartsToAnthropic(message);
    } else if (typeof message === 'string') {
        currentContent = [{ type: 'text', text: message }];
    } else {
        currentContent = mapGeminiPartsToAnthropic([message]);
    }
    
    messages.push({ role: 'user', content: currentContent });
    for (const round of toolContext?.rounds || []) {
        messages.push({ role: 'assistant', content: round.model.rawAssistantTurn });
        messages.push({ role: 'user', content: round.outputs.map(output => ({
            type: 'tool_result' as const,
            tool_use_id: output.call.id!,
            is_error: output.result.success === false,
            content: [
                { type: 'text', text: JSON.stringify(output.result) },
                ...(output.image ? [{ type: 'image', source: {
                    type: 'base64', media_type: output.image.mimeType, data: output.image.data,
                } }] : []),
            ],
        })) });
    }

    console.log(`[Anthropic Call] 正在请求: ${fetchUrl} | 模型: ${model}`);

    const payload: any = {
        model: model,
        system: systemInstruction, // Anthropic 的 system 是顶层参数，你之前的写法很对
        messages: messages,
        max_tokens: 4096,
        temperature: 0.7,
    };

    if (tools && tools.length > 0) {
        payload.tools = tools.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: toJsonSchema(t.parameters)
        }));
    }

    const response = await fetch(fetchUrl, {
        method: 'POST',
        signal: toolContext?.signal,
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerously-allow-browser': 'true'
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errText = await response.text();
        console.error(`[Anthropic API Error Payload]:`, errText);
        throw new Error(`Anthropic API Error: ${response.status} ${errText}`);
    }

    const data = await response.json();
    
    const result: ProviderResponse = { text: "", rawAssistantTurn: data.content };
    const textBlocks = data.content?.filter((c: any) => c.type === 'text') || [];
    result.text = stripThinkingTags(textBlocks.map((b: any) => b.text).join('\n'));

    const toolBlocks = data.content?.filter((c: any) => c.type === 'tool_use') || [];
    if (toolBlocks.length > 0) {
        result.rawToolCall = toolBlocks[0];
        result.functionCalls = toolBlocks.map((tb: any) => ({ id: tb.id, name: tb.name, args: tb.input }));
    }

    return result;
};

export const callVisionHelper = async (
    config: AIConfig,
    imageBase64: string,
    mimeType: string,
    language: Language
): Promise<string> => {
    const provider = config.visionProvider || config.provider || 'gemini';
    const model = config.model_vision || getDefaultVisionModel(provider);
    
    let apiKey = config.visionApiKey;
    if (!apiKey) {
        apiKey = config.activeKey === 'primary' ? config.apiKey_primary : config.apiKey_backup;
    }
    
    if (!apiKey) throw new Error("Vision Helper API Key is missing");

    const prompt = language === 'zh' 
        ? "请详细描述这张图片的内容，包括人物、场景、动作、文字等细节。你的描述将被转述给一个无法看到图片的AI，所以请尽可能详细和准确。" 
        : "Please describe this image in detail, including characters, scene, actions, text, etc. Your description will be relayed to an AI that cannot see the image, so please be as detailed and accurate as possible.";

    console.log(`[Vision Helper] Calling ${provider} (${model})...`);

    const useCustomEndpoint = config.useVisionCustomEndpoint ?? config.useCustomEndpoint;
    const customEndpoint = config.visionCustomEndpoint ?? config.customEndpoint;
    const transportProvider = resolveTransportProvider(provider, useCustomEndpoint ? customEndpoint : undefined);

    if (transportProvider === 'gemini') {
        const options: any = { apiKey };
        if (useCustomEndpoint && customEndpoint) {
            options.httpOptions = { baseUrl: customEndpoint.trim().replace(/\/v1beta\/?$/, '').replace(/\/v1alpha\/?$/, '').replace(/\/v1\/?$/, '').replace(/\/$/, '') };
        }
        const ai = new GoogleGenAI(options);
        const response = await ai.models.generateContent({
            model: model,
            contents: [
                { text: prompt },
                { inlineData: { mimeType, data: imageBase64 } }
            ]
        });
        return response.text || "[Vision Helper returned no description]";
    } else if (isOpenAICompatibleProvider(transportProvider)) {
        let fetchUrl = (useCustomEndpoint && customEndpoint) ? customEndpoint.replace(/\/$/, '') : 'https://api.openai.com/v1/chat/completions';
        if (!useCustomEndpoint && transportProvider === 'openrouter') {
            fetchUrl = 'https://openrouter.ai/api/v1/chat/completions';
        }
        
        const response = await fetch(fetchUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
                        ]
                    }
                ],
                max_tokens: 1000
            })
        });
        
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Vision Helper OpenAI Error: ${response.status} ${errText}`);
        }
        const data = await response.json();
        // v2.14.28 M21: vision helper output goes straight into the main
        // model's prompt context. Strip thinking tags so a vision model
        // that emits `<think>...</think>` along with its description doesn't
        // pollute the main chat turn with reasoning fragments.
        const visionContent = data.choices?.[0]?.message?.content || "[Vision Helper returned no description]";
        return stripThinkingTags(visionContent);

    } else if (transportProvider === 'anthropic') {
        let fetchUrl = (useCustomEndpoint && customEndpoint) ? customEndpoint.replace(/\/$/, '') : 'https://api.anthropic.com/v1/messages';
        
        const response = await fetch(fetchUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerously-allow-browser': 'true'
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            { 
                                type: 'image', 
                                source: { type: 'base64', media_type: mimeType, data: imageBase64 } 
                            }
                        ]
                    }
                ],
                max_tokens: 1000
            })
        });
        
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Vision Helper Anthropic Error: ${response.status} ${errText}`);
        }
        const data = await response.json();
        return data.content?.[0]?.text || "[Vision Helper returned no description]";
    }
    
    throw new Error(`Unsupported Vision Provider: ${provider}`);
};
