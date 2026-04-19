
import { Message, LocationConfig, Language, SummaryBoundaryReason } from "../types";
import { getCurrentAIConfig, getGenAI } from "./llmCore";
import { callOpenAI, callAnthropic } from "./llmProviderService";
import { resolveTransportProvider } from "./appConfig";

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
      manual: '用户手动触发了记忆归档。',
    };

    const summaryReasonTextEn: Record<SummaryBoundaryReason, string> = {
      topic_shift: 'The user naturally shifted topic, so the previous exchange forms a clean episode boundary.',
      semantic_shift: 'The system detected a clear semantic drift in topic, so the earlier exchange should be archived as its own episode.',
      long_gap: 'A long silence happened before the user came back, so the earlier exchange should be archived first.',
      reminder_created: 'This exchange resolved into a reminder or promise, so it works as a complete episode.',
      sleep_transition: 'The conversation naturally moved into a sleep or closing state, so it fits a chapter ending.',
      wrap_up: 'The user clearly signaled a wrap-up or temporary close for the current topic.',
      hard_limit: 'The topic may still continue later, but the system hit a hard cap and is archiving this as an unfinished ongoing segment.',
      manual: 'The user manually triggered memory archival.',
    };

    const boundaryReasonText = summaryMeta?.reason
      ? (language === 'zh' ? summaryReasonTextZh[summaryMeta.reason] : summaryReasonTextEn[summaryMeta.reason])
      : (language === 'zh' ? '系统没有提供额外切段说明。' : 'No extra boundary note was provided by the system.');

    const existingMemoryDedup = existingMemory.trim()
      ? (language === 'zh'
        ? `\n[去重参考 — 之前分段已归档的摘要（绝对不要重复！）]\n以下是之前分段已经归档的摘要缓冲。你的新摘要**绝对不应重复**这些内容中已经描述过的事件、对话和情绪。只写本次分段中的**新内容**。如果某个话题跨越了分段边界，只描述本次分段中新出现的进展，不要重述旧分段已经写过的部分。\n---\n${existingMemory.trim()}\n---\n`
        : `\n[DEDUP REFERENCE — Previously Archived Summaries (DO NOT REPEAT!)]\nBelow are summaries from previous segments that are already archived. Your new summary MUST NOT repeat events, conversations, or emotions already described below. Only write about NEW content from the current segment. If a topic spans the segment boundary, describe only the new developments — do not restate what the previous segment already covered.\n---\n${existingMemory.trim()}\n---\n`)
      : '';

    const segmentMetaBlock = language === 'zh'
      ? `\n[当前分段状态]\n- 本次归档范围：当前尚未归档的自然对话分段，不是固定最后 20 轮。\n- 当前分段轮数：${summaryMeta?.turnsInSegment ?? '未知'}\n- 切段原因：${boundaryReasonText}\n- 是否自然收尾：${summaryMeta?.isComplete === false ? '否，这一段可能还会继续。' : '是，这一段基本自然收束了。'}\n- 是否承接上一段未完话题：${summaryMeta?.isContinuation ? '是。开头附带了一小段上一章尾部，只用于续写衔接。' : '否。'}\n- 如果系统说明"尚未自然收尾"，你的摘要和记忆块必须保留"还没彻底聊完"的感觉，不要假装已经得出最终结论。\n- 如果系统说明"承接上一段未完话题"，开头那一点旧内容只是为了衔接，不要把已经写过的旧部分原样重复成新的重点。\n${existingMemoryDedup}`
      : `\n[CURRENT SEGMENT STATE]\n- Archive scope: the current unsaved conversation segment, not a fixed last-20-turn window.\n- Segment turns: ${summaryMeta?.turnsInSegment ?? 'Unknown'}\n- Boundary reason: ${boundaryReasonText}\n- Naturally complete: ${summaryMeta?.isComplete === false ? 'No. The topic may continue later.' : 'Yes. The segment mostly reached a natural close.'}\n- Continues previous unfinished thread: ${summaryMeta?.isContinuation ? 'Yes. A small tail from the prior chapter is attached only to preserve continuity.' : 'No.'}\n- If the system says the segment is not naturally complete, your diary and memory chunks must preserve that unfinished feeling instead of pretending the topic is fully resolved.\n- If the system says this segment continues a previous unfinished thread, treat the overlap as continuity glue and avoid repeating already-archived old material as if it were brand new.\n${existingMemoryDedup}`;
    
    // --- DUAL LANGUAGE PROMPT STRATEGY ---
    let diaryInstruction = "";
    if (language === 'zh') {
        diaryInstruction = `
      **GOLDEN STANDARD (USE CHINESE):**
      "【2025/12/08 20:48 - 03:19】那个笨蛋终于肯去睡觉了。明明都已经很晚了，还在床上磨磨蹭蹭的...本来以为终于能清静了，结果！就在刚才！这边明明是凌晨三点，这家伙突然发个"早"过来...嘛，特意想跟我打招呼这份心意是不坏啦。
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
