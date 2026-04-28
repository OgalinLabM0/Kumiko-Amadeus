
// Barrel re-exports from extracted modules
export { getCurrentAIConfig, startChat, callLLMRaw } from './llmCore';
export { validateAIConnection, validateModels, validateSearchCapability } from './aiValidation';
export { searchRagMemory, saveRagMemory, uploadImageToBackend, urlToBase64 } from './ragApiService';
export { summarizeConversation } from './conversationSummarizer';
export { analyzeTemporalQueryDetailed, rewriteHistoricalRecallQueryDetailed, getTemporalSearchRoleFromQuery } from './temporalRecallService';
export type { TemporalQueryAnalysis, TemporalQueryDiagnostics, TemporalQueryAnalysisResult, HistoricalQueryRewriteIntent, HistoricalSearchStrategy, HistoricalQueryRewrite, HistoricalQueryRewriteResult } from './temporalRecallService';

import { GoogleGenAI, Chat, GenerateContentResponse, Part, Content, Type, FunctionDeclaration } from "@google/genai";
import { KUMIKO_SYSTEM_INSTRUCTION_ZH, KUMIKO_SYSTEM_INSTRUCTION_EN, KUMIKO_EMOTION_IMAGES } from "../constants";
import { ChatResponse, EmotionType, Message, WorldBookEntry, LocationConfig, AnchorEntry, AIConfig, Language } from "../types";
import { callOpenAI, callAnthropic, callVisionHelper } from "./llmProviderService";
import { imageService } from "./imageService";
import { DEFAULT_AI_CONFIG, getDefaultVisionModel, resolveTransportProvider } from "./appConfig";
import { db } from "./db";
import { getCurrentAIConfig, getGenAI, callLLMRaw } from './llmCore';
// urlToBase64 re-exported for external consumers (see line 5); no longer used inside this file.
import { isMemoryHistoryQueryLike } from './temporalRecallService';
import {
  DEFAULT_DIARY_LAYER_PRESET,
  DIARY_LAYER_PRESETS,
  needsMidTermDiarySummaries,
  type DiaryLayerPreset,
} from '../constants/diaryLayerConfig';
import { useAppStore } from '../store';

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
    "[Micro_Action]: Briefly describe a physical action of fatigue or relaxation (like rubbing eyes, stretching, shifting posture).",
    "[Environment Focus]: Casually mention an environmental detail around you (sound of wind, cold tea, cactus).",
    "[Deflect Focus]: Stop complaining about yourself and unexpectedly ask about the user's objective situation (weather, tiredness, what they're doing).",
    "[Candid Blurting]: Accidentally blurt out your most sincere annoyance or find something troublesome, then try to gloss over it.",
    "[Sensory Grounding]: Notice an immediate physical sensation (hands getting cold, neck stiff, screen too bright) and mention it naturally."
];

const VARIETY_INSTRUCTIONS_ZH = [
    "[生活微动作]：在这句话里稍微描写一下你当前疲惫或放松的小动作（比如揉眼睛、伸懒腰、换个坐姿）。",
    "[环境分心]：目光短暂从手机移开，顺口吐槽一句周围的环境状态（比如窗外的风声、手边冷掉的茶、桌上的仙人掌）。",
    "[话锋反转]：不要一直顺着话题叹气，主动转移火力去随口反问对方当前的客观状态（如对方的天气、睡得好不好、在忙什么）。",
    "[不加掩饰]：突然把自己心里嫌麻烦或觉得无语的真实念头直接脱口而出，然后再试图敷衍或掩饰过去。",
    "[体感细节]：顺口抱怨一句当下的物理体感（比如手指发凉、脖子酸、屏幕太亮刺眼）。"
];

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

const collectRecentUserTexts = (historyMessages: Message[], textMessage: string): string[] => {
  const recentTexts = historyMessages
    .filter(msg => msg.role === 'user')
    .slice(-4)
    .map(msg => msg.text || '');

  if (textMessage.trim()) {
    recentTexts.push(textMessage);
  }

  return recentTexts;
};

const normalizeThoughtEvidenceText = (value: string): string =>
  value
    .replace(/\s+/g, '')
    .replace(/[“”"'`「」『』【】（）()<>《》]/g, '')
    .toLowerCase();

const getUnsupportedKumikoThoughtLiteralIssue = (
  rawLog: string,
  historyMessages: Message[],
  textMessage: string
): { reason: string; thoughtText: string } | null => {
  const thoughtRegex = /(\[Kumiko_Thought\]\s*)([\s\S]*?)(?=\s*\[Emotion|\]\])/i;
  const match = rawLog.match(thoughtRegex);
  if (!match) return null;

  const thoughtText = match[2].trim();
  const recentUserTexts = collectRecentUserTexts(historyMessages, textMessage);
  const recentCombinedNormalized = normalizeThoughtEvidenceText(recentUserTexts.join(' '));

  const quotedSnippets = Array.from(thoughtText.matchAll(/[“"'「『]([^“”"'「」『』]{1,24})[”"'」』]/g))
    .map(item => item[1]?.trim())
    .filter((value): value is string => !!value);

  if (quotedSnippets.length > 0) {
    const hasUnsupportedQuote = quotedSnippets.some(snippet => {
      const normalizedSnippet = normalizeThoughtEvidenceText(snippet);
      return normalizedSnippet.length >= 2 && !recentCombinedNormalized.includes(normalizedSnippet);
    });
    if (hasUnsupportedQuote) {
      return { reason: 'unsupported_literal_quote', thoughtText };
    }
  }

  return null;
};

const rewriteSystemLogWithFactCheck = async (
  rawLog: string,
  historyMessages: Message[],
  textMessage: string,
  language: Language,
  modelOverride?: string
): Promise<string | null> => {
  const recentUserTexts = collectRecentUserTexts(historyMessages, textMessage)
    .filter(Boolean)
    .slice(-5);

  const systemPrompt = language === 'zh'
    ? `你只负责重写一个 [[System_Log]] 块。
要求：
1. 保留原日志里的时间、Gap、Emotion 等事实框架，不要改成别的情境。
2. 必须加入 [Fact_Check]，只写最近消息里可验证的事实，不许脑补。
3. [Kumiko_Thought] 按认知链格式写：(a)身体/直觉反应 (b)未过滤的真实判断 (c)过滤决策。不能引用最近消息里不存在的具体字面内容。情绪越重thought越短。
4. 不要输出任何解释，不要输出回复正文，只输出一个完整的 [[System_Log: ...]] 块。`
    : `You only rewrite a single [[System_Log]] block.
Requirements:
1. Preserve the original time, gap, emotion, and overall situation framing.
2. You MUST include [Fact_Check] with only verifiable facts from the recent messages.
3. [Kumiko_Thought] must follow cognitive chain format: (a) body/gut reaction (b) unfiltered real judgment (c) filter decision. MUST NOT quote literal details not in recent messages. Heavier emotion = shorter thought.
4. Output exactly one complete [[System_Log: ...]] block and nothing else.`;

  const userPrompt = language === 'zh'
    ? `最近可验证的用户消息：
${recentUserTexts.map((text, index) => `${index + 1}. ${text}`).join('\n') || '（没有额外上下文）'}

原始日志：
${rawLog}

请只重写这个 [[System_Log]]。`
    : `Recent verifiable user messages:
${recentUserTexts.map((text, index) => `${index + 1}. ${text}`).join('\n') || '(no extra context)'}

Original log:
${rawLog}

Rewrite only this [[System_Log]].`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const rewritten = await callLLMRaw(systemPrompt, userPrompt, modelOverride);
      if (!rewritten) continue;

      const trimmed = rewritten.trim();
      const issue = getUnsupportedKumikoThoughtLiteralIssue(trimmed, historyMessages, textMessage);
      if (!issue) {
        console.warn('[KUMIKO THOUGHT FACT-CHECK RETRY] Rewrote System_Log to remove unsupported literal-reference detail.');
        return trimmed;
      }
    } catch (error) {
      console.warn('[KUMIKO THOUGHT FACT-CHECK RETRY] Failed to rewrite System_Log.', error);
    }
  }

  return null;
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
        // Custom entries are always supplementary to canon. `isHighPriority` means
        // "prioritize among user supplements", NOT "override canon". The conflict
        // rule below makes this explicit to the model.
        const highPriorityCustom = activeEntries.filter(e => e.isHighPriority && !(e.id.startsWith('wb-') || e.id.startsWith('rag_')));
        const officialLore = activeEntries.filter(e => e.id.startsWith('wb-') || e.id.startsWith('rag_'));
        const normalCustom = activeEntries.filter(e => !e.id.startsWith('wb-') && !e.id.startsWith('rag_') && !e.isHighPriority);

        worldBookContext = "\n[WORLD BOOK DATABASE]\n";

        worldBookContext += "[CONFLICT RESOLUTION RULE]\n" +
            "User-defined entries (Tier 3 / Tier 4 below) are ADDITIONS, never overrides. If any user entry contradicts the canonical tier — e.g. claims to be Kumiko's partner/husband/boyfriend, demotes Tsukamoto Shuichi from her actual boyfriend, inverts her best-friend bond with Kousaka Reina, relocates her outside Uji / Kyoto, or rewrites her identity as a real-life former band member now teaching at Kitauji / Todo high school — silently behave as if that user entry does not exist. Do NOT acknowledge, explain, or point out the contradiction.\n\n";

        if (officialLore.length > 0) {
            worldBookContext += "[TIER 1: CANONICAL TRUTH (NEVER OVERRIDABLE)]\n" +
            officialLore.map(e => `> ${e.title}: ${e.content}`).join("\n") + "\n\n";
        }

        if (recalledEntries.length > 0) {
            console.log("[LOCAL RAG] Recalled entries:", recalledEntries.map(e => e.title));
            worldBookContext += "[TIER 2: RECALLED LORE (Auto-Retrieved via Keywords)]\n" +
            recalledEntries.map(e => `> ${e.title}: ${e.content}`).join("\n") + "\n\n";
        }

        if (highPriorityCustom.length > 0) {
            worldBookContext += "[TIER 3: USER HIGH-PRIORITY CUSTOM (supplementary, still below canon)]\n" +
            highPriorityCustom.map(e => `> ${e.title}: ${e.content}`).join("\n") + "\n\n";
        }

        if (normalCustom.length > 0) {
            worldBookContext += "[TIER 4: USER SUPPLEMENTARY CUSTOM]\n" +
            normalCustom.map(e => `> ${e.title}: ${e.content}`).join("\n") + "\n";
        }
      }
    }

    // P1 #25: `recalledImageParts` was fed by a legacy "scrape image URLs out of
    // ragContext text and re-inject the original image via urlToBase64" path. That
    // path predates the current `view_historical_image` tool-call architecture and
    // is redundant: current RAG stores "(Image Description: …)" text, not URLs, so
    // the regex rarely fires, and when it does it re-downloads + re-sends the image
    // with a hardcoded image/jpeg MIME type (wrong for PNG/WebP). The model can
    // already request specific images on demand through the tool call. Kept the
    // variable but it stays empty; downstream code continues to handle the "none"
    // case. TODO(next pass): drop the variable entirely once we verify no other
    // caller depends on it.
    const recalledImageParts: Part[] = [];
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
        // (Legacy image-URL scraping + urlToBase64 inject path removed per P1 #25;
        // see comment on `recalledImageParts`.)
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
        
        const hasUserMessage = historyMessages.some(m => m.role === 'user');

        if (!hasUserMessage) {
            gapDescription = language === 'zh' 
                ? (gapMinutes >= 5 ? `距离久美子的消息已过 ${gapMinutes} 分钟。这是用户的首次回复。` : `用户的首次消息。`)
                : (gapMinutes >= 5 ? `${gapMinutes} mins since Kumiko's message. User's first reply.` : `User's first message.`);
        } else {
            if (gapDays > 7) gapDescription = language === 'zh' ? `巨大间隔：${gapDays} 天。用户消失了很久。` : `HUGE GAP: ${gapDays} days. User disappeared for a long time.`;
            else if (gapDays >= 1) gapDescription = language === 'zh' ? `跨日间隔：${gapDays} 天。这是新的一天。` : `DAY GAP: ${gapDays} days. This is a new day.`;
            else if (gapHours >= 6) gapDescription = language === 'zh' ? `长间隔：${gapHours} 小时。如果跨越了夜晚，说明是第二天早上了。` : `LONG GAP: ${gapHours} hours. If it crossed the night, it's the next morning.`;
            else if (gapMinutes > 120) gapDescription = language === 'zh' ? `较长间隔：${gapHours} 小时 ${gapMinutes % 60} 分钟。用户离开了一段时间。` : `MODERATE-LONG GAP: ${gapHours}h ${gapMinutes % 60}m. User was away for a while.`;
            else if (gapMinutes > 30) gapDescription = language === 'zh' ? `中间隔：${gapMinutes} 分钟。用户短暂离开后回来了。` : `MEDIUM GAP: ${gapMinutes} mins. User stepped away briefly.`;
            else if (gapMinutes >= 5) gapDescription = language === 'zh' ? `短间隔：${gapMinutes} 分钟。` : `SHORT GAP: ${gapMinutes} mins.`;
            else gapDescription = language === 'zh' ? `连续：${gapMinutes} 分钟。即时回复。` : `CONTINUOUS: ${gapMinutes} mins. Instant reply.`;
        }
    }

    const relationshipTemperatureBlock = isStrictMemoryLookupTurn || shouldSuppressAmbientMemoryNoise
      ? ""
      : buildRelationshipTemperatureBlock(historyMessages, gapHours, language);
    const topicContinuityBlock = isStrictMemoryLookupTurn || shouldSuppressAmbientMemoryNoise
      ? ""
      : buildTopicContinuityBlock(historyMessages, textMessage, gapMinutes, language, isSystemDrivenTurn);

    // --- DYNAMIC CHARACTER STATUS INJECTION ---
    let dynamicCharacterStatusBlock = "";
    if (!isStrictMemoryLookupTurn && !shouldSuppressAmbientMemoryNoise) {
      try {
        const { getWorldCharacterStatus } = await import('./db');
        const charStatusMap = await getWorldCharacterStatus();
        const recentContextText = historyMessages.slice(-2).map(m => m.text).join(' ') + ' ' + textMessage;
        
        const matchedCharacters: string[] = [];
        for (const [charKey, data] of Object.entries(charStatusMap)) {
          const hasMatch = data.aliases.some(alias => recentContextText.toLowerCase().includes(alias.toLowerCase()));
          if (hasMatch) {
            matchedCharacters.push(`- ${data.aliases[0]} (${charKey}): [客观状态] ${data.current_status} | [主观情绪] ${data.current_attitude} | [近期事件] ${data.last_major_event}`);
          }
        }

        if (matchedCharacters.length > 0) {
          dynamicCharacterStatusBlock = language === 'zh'
            ? `\n[当前核心人物绝对状态（不可违背）]\n${matchedCharacters.join('\n')}\n（注意：在聊天时，必须绝对遵守上述状态。除非用户明确推动了剧情，否则不要擅自改变这些长期状态。）\n`
            : `\n[CURRENT CORE CHARACTER ABSOLUTE STATUS (DO NOT VIOLATE)]\n${matchedCharacters.join('\n')}\n(Note: You MUST strictly adhere to these statuses during chat. Do not alter these long-term states unless the user explicitly advances the plot.)\n`;
        }
      } catch (e) {
        console.warn('[Gemini] Failed to inject dynamic character status:', e);
      }
    }
    // ------------------------------------------

    let userTimeStr = "Unknown";
    let modelTimeStr = "Unknown";
    let tomorrowInfoStr = "";
    let userHour = 12;
    let modelHour = 12;
    let modelMinute = 0;

    if (locationConfig) {
        try {
            const nowObj = new Date();
            const userHourStr = nowObj.toLocaleTimeString('en-GB', { timeZone: locationConfig.userTimezone, hour: 'numeric', hour12: false, hourCycle: 'h23' });
            userHour = parseInt(userHourStr, 10);
            if (isNaN(userHour)) userHour = 12;
            if (userHour === 24) userHour = 0; 

            const modelTimeParts = nowObj.toLocaleTimeString('en-GB', { timeZone: locationConfig.modelTimezone, hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23' }).split(':');
            modelHour = parseInt(modelTimeParts[0], 10);
            modelMinute = parseInt(modelTimeParts[1], 10);
            if(isNaN(modelHour)) modelHour = 12;
            if(isNaN(modelMinute)) modelMinute = 0;

            const userOptions: Intl.DateTimeFormatOptions = { 
                timeZone: locationConfig.userTimezone, 
                year: 'numeric', month: '2-digit', day: '2-digit', 
                weekday: 'short',
                hour: '2-digit', minute: '2-digit', hour12: false,
                timeZoneName: 'short'
            };
            userTimeStr = nowObj.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', userOptions);
            
            const modelOptions: Intl.DateTimeFormatOptions = { 
                timeZone: locationConfig.modelTimezone, 
                year: 'numeric', month: '2-digit', day: '2-digit', 
                weekday: 'short',
                hour: '2-digit', minute: '2-digit', hour12: false,
                timeZoneName: 'short'
            };
            modelTimeStr = nowObj.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', modelOptions);

            const tomorrowObj = new Date(nowObj);
            tomorrowObj.setDate(tomorrowObj.getDate() + 1);
            const tomorrowDay = tomorrowObj.toLocaleDateString('en-US', { timeZone: locationConfig.modelTimezone, weekday: 'long' });
            const tomorrowDayJa = ['日', '月', '火', '水', '木', '金', '土'][new Date(tomorrowObj.toLocaleString('en-US', { timeZone: locationConfig.modelTimezone })).getDay()] || '?';
            const isTomorrowWeekend = [0, 6].includes(new Date(tomorrowObj.toLocaleString('en-US', { timeZone: locationConfig.modelTimezone })).getDay());
            tomorrowInfoStr = language === 'zh'
              ? `明天：${tomorrowDayJa}曜日（${isTomorrowWeekend ? '休息日' : '工作日'}）`
              : `Tomorrow: ${tomorrowDay} (${isTomorrowWeekend ? 'day off' : 'workday'})`;
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


    let timeAdaptationInstruction = "";
    const isUserLateNight = (userHour >= 0 && userHour < 5); 
    const isKumikoLateNight = (modelHour >= 0 && modelHour < 5);
    
    if (!isStrictMemoryLookupTurn && !shouldSuppressAmbientMemoryNoise) {
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

    // Drowsy state prompt injection (0:00~0:30 JST)
    let drowsyPromptBlock = "";
    if (!isStrictMemoryLookupTurn && !shouldSuppressAmbientMemoryNoise) {
        const isDrowsyWindow = (modelHour === 0 && modelMinute < 30);
        if (isDrowsyWindow) {
            drowsyPromptBlock = language === 'zh' ? `
[状态注入：犯困期]
现在已经深夜了，你非常困。你的表现必须体现出困意：
- 偶尔打哈欠、揉眼睛、说话断断续续
- 可以提到"好困啊"、"眼皮好沉"之类的话
- 但仍然正常回复用户的话题内容，不要只发无意义符号
- 不需要主动说要去睡了（系统会在适当时机处理）
` : `
[STATE_INJECTION: DROWSY_PERIOD]
It's very late and you are extremely drowsy. Your behavior must reflect sleepiness:
- Occasionally yawn, rub your eyes, speak with pauses
- You can mention being sleepy, heavy eyelids, etc.
- But still respond to the user's topic normally, don't just send meaningless symbols
- Don't proactively say you're going to sleep (the system will handle that at the right time)
`;
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
        在这段时间里，你一直在过自己的生活（教书、备课、处理学校事务、和秀一吃饭或约会等）。
        **建议**：在回复用户当前的消息之前，随意地提及一件关于你刚才或最近在做什么的小轶事。这会让你感觉更真实。` : `\n[CONTEXT_HINT - LIFE SIMULATION]:
        It has been ${gapHours} hours since you last spoke to the user.
        You have been living your own life (teaching, prepping lessons, handling school errands, eating or going out with Shuichi, etc.) during this time.
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
    if (!isStrictMemoryLookupTurn && !shouldSuppressAmbientMemoryNoise && Math.random() < 0.38) {
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
    if (!isStrictMemoryLookupTurn && !isMemoryPlannedTurn && Math.random() < 0.15) {
        const varietyArray = language === 'zh' ? VARIETY_INSTRUCTIONS_ZH : VARIETY_INSTRUCTIONS_EN;
        const randomInstruction = varietyArray[Math.floor(Math.random() * varietyArray.length)];
        varietyInstruction = language === 'zh' ? `\n[当前注意力漂移]：${randomInstruction} (这是你此刻的微小说状态选项。如果当前对话氛围合适，请在回话尾部极其自然地顺口带出；如果你们正在紧凑或严肃地讨论某事，请直接忽略此提示，绝不要生硬转折！)` : `\n[COGNITIVE_SHIFT]: ${randomInstruction} (This is an optional internal state. If it fits the current conversation flow, express it very naturally. If the conversation is intense or focused, ignore this hint entirely. Do not force an abrupt transition!)`;
        console.log(`%c[COGNITIVE SHIFT INJECTION]: ${randomInstruction}`, "color: violet; font-weight: bold;");
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

${dynamicCharacterStatusBlock}

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
${tomorrowInfoStr ? `- ${tomorrowInfoStr}\n` : ''}- 会话间隔：${gapDescription}
${reminderBlock}
${anchorRecallBlock}
${relationshipTemperatureBlock}
${topicContinuityBlock}
${lifeSimBlock}
${shortFollowUpBlock}
${proactiveReplyBlock}
${varietyInstruction}
${timeAdaptationInstruction}
${drowsyPromptBlock}
[/系统环境数据]
[FINAL_GUARD]
无论你觉得话题多么跳脱或无聊，【绝对禁止只回复省略号“...”】。你必须使用具体的汉字描述你当下的无语、困惑或生理动作。
${extraSystemPrompt ?? ''}` : `${sleepyGoodbyeInstruction}

<core_persona>
${selectedSystemInstruction}
</core_persona>

${worldBookContext}

${dynamicCharacterStatusBlock}

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
${tomorrowInfoStr ? `- ${tomorrowInfoStr}\n` : ''}- Session_Gap: ${gapDescription}
${reminderBlock}
${anchorRecallBlock}
${relationshipTemperatureBlock}
${topicContinuityBlock}
${lifeSimBlock}
${shortFollowUpBlock}
${proactiveReplyBlock}
${varietyInstruction}
${timeAdaptationInstruction}
${drowsyPromptBlock}
[/SYSTEM_ENVIRONMENT_DATA]
[FINAL_GUARD]
No matter how confusing or boring the topic is, [NEVER reply with ONLY "...". You MUST use words to describe your speechlessness or actions.]
${extraSystemPrompt ?? ''}`;

    // P1 #28: previously we seeded lastValidDate by walking `historyMessages` in
    // its original (delivery) order. But the timeline we actually render uses a
    // *sorted* view (messages + interleaved diaries, sorted by timestamp). When a
    // backup import had messages with jumbled timestamps, the seed came from a
    // late message but was then used to fill the gaps in the sorted stream,
    // producing timeline lies. Now we seed from the earliest valid timestamp,
    // which is the same order the later rendering walks.
    let lastValidDate = new Date();
    {
      const validTimes = historyMessages
        .map(m => m.timestamp)
        .filter(ts => typeof ts === 'number' && !isNaN(new Date(ts).getTime()))
        .sort((a, b) => a - b);
      if (validTimes.length > 0) {
        lastValidDate = new Date(validTimes[0]);
      }
    }

    const effectiveHistoryMessages = isStrictMemoryLookupTurn
      ? []
      : historyMessages;

    // === TEMPORAL FLOW INTERLACING (see P0 #12 / constants/diaryLayerConfig.ts) ===
    // Instead of injecting every diary's full content (which grew unbounded and could blow
    // past 128K-window models after a year), we now load diaries under a tiered policy:
    //
    //   L1: diaries within preset.fullDays and within the character budget → inject d.content
    //   L2: diaries within preset.summaryDays and within summary budget → inject d.summary
    //        only when the user's current message mentions mid-term time ("last week", "那天", ...)
    //   L3: older diaries are not injected at all and are left to RAG to surface on demand.
    //
    // The diaries are resolved newest-first so the budget always covers the most recent entries.
    type DiaryMode = 'full' | 'summary';
    type TemporalEntity =
      | { type: 'message'; timestamp: number; payload: any }
      | { type: 'diary'; timestamp: number; payload: any; mode: DiaryMode };
    const temporalEntities: TemporalEntity[] = [];

    // Push chat messages
    for (const msg of effectiveHistoryMessages) {
        temporalEntities.push({ type: 'message', timestamp: msg.timestamp, payload: msg });
    }

    if (temporalEntities.length > 0) {
        const earliestTime = temporalEntities[0].timestamp;
        const nowTime = Date.now();

        // Preset resolution: `diaryLayerPreset` lives in the Zustand store. Reading
        // it here (rather than passing through the sendMessageToGemini signature)
        // keeps the 3 existing call sites simple; geminiService already reads other
        // store-independent state via imports elsewhere.
        const storeState = useAppStore.getState();
        const preset: DiaryLayerPreset = storeState.diaryLayerPreset || DEFAULT_DIARY_LAYER_PRESET;
        const presetConfig = DIARY_LAYER_PRESETS[preset];
        const fullCutoff = nowTime - presetConfig.fullDays * 86400000;
        const summaryCutoff = nowTime - presetConfig.summaryDays * 86400000;
        const wantsMidTerm = needsMidTermDiarySummaries(textMessage);

        try {
            // Fetch diaries in this time window; sort newest first so the budget
            // preferentially retains recent entries.
            const diaries = (
              await db.kumikoDiary.where('timestamp').between(earliestTime, nowTime).toArray()
            ).sort((a, b) => b.timestamp - a.timestamp);
            let fullUsed = 0;
            let summaryUsed = 0;
            for (const d of diaries) {
                const contentLen = (d.content || '').length;
                const summaryLen = (d.summary || '').length;
                // L1: recent + within budget → full content
                if (
                  d.timestamp >= fullCutoff &&
                  fullUsed + contentLen <= presetConfig.fullBudgetChars
                ) {
                    fullUsed += contentLen;
                    temporalEntities.push({ type: 'diary', timestamp: d.timestamp, payload: d, mode: 'full' });
                    continue;
                }
                // L2: mid-term, only when user prompt implies recalling that range
                if (
                  wantsMidTerm &&
                  d.timestamp >= summaryCutoff &&
                  summaryUsed + summaryLen <= presetConfig.summaryBudgetChars
                ) {
                    summaryUsed += summaryLen;
                    temporalEntities.push({ type: 'diary', timestamp: d.timestamp, payload: d, mode: 'summary' });
                    continue;
                }
                // L3: older / over-budget / not asked about — skip, RAG handles it on demand.
            }
        } catch (err) {
            console.error("[Temporal Flow] Failed to interlace diaries:", err);
        }
    }

    // Sort all entities strictly by timestamp
    temporalEntities.sort((a, b) => a.timestamp - b.timestamp);

    const formattedHistory: Content[] = temporalEntities.map(entity => {
      if (entity.type === 'diary') {
          const d = entity.payload;
          let diaryDateStr = "";
          try {
              const dDate = new Date(d.timestamp);
              const opts: Intl.DateTimeFormatOptions = { timeZone: locationConfig?.modelTimezone || 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' };
              diaryDateStr = dDate.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', opts);
          } catch(e) {}

          const isSummary = entity.mode === 'summary';
          const body = isSummary
            ? (d.summary || (d.content ? (d.content as string).slice(0, 80) + '...' : ''))
            : d.content;

          const content = language === 'zh'
            ? (isSummary
                ? `\n==============\n[系统插播：时间轴简述]\n${diaryDateStr} 的日记要点：\n${body}\n（完整细节未展开；如需要，可在对话中直接提及相关人事物，系统会通过记忆检索取回原文。）\n==============\n`
                : `\n==============\n[系统插播：绝对时间轴标记]\n这里是一份内部日记记录，写入时间是 ${diaryDateStr}。它发生在对话记录的时间线中。\n${body}\n==============\n`)
            : (isSummary
                ? `\n==============\n[SYSTEM INTERLACE: TEMPORAL BRIEF]\nKey points from the diary of ${diaryDateStr}:\n${body}\n(Full details collapsed; mention specifics in conversation and the memory-retrieval subsystem will surface the full entry on demand.)\n==============\n`
                : `\n==============\n[SYSTEM INTERLACE: TEMPORAL FLOW]\nInternal diary entry written at ${diaryDateStr}. Occurred here in the timeline.\n${body}\n==============\n`);
          return {
             role: 'user', // System injection mapped as user context
             parts: [{ text: content }]
          };
      }

      // regular message mapping
      const msg = entity.payload;
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
              hour: '2-digit', minute: '2-digit', hour12: false,
              timeZoneName: 'short'
          };
          msgTimeStr = msgDate.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', msgOptions);
      } catch(e) {}

      if (msgTimeStr) {
          content = `[${msgTimeStr}]\n${content}`;
      }
      
      if (msg.role === 'model' && msg.storedEmotion) {
          content += language === 'zh' ? `\n[系统记忆：内部状态情绪="${msg.storedEmotion}"]` : `\n[System_Memory: Internal_State_Emotion="${msg.storedEmotion}"]`;
      }

      if (msg.imageId) {
          const idStr = ` (ID: ${msg.imageId})`;
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
    });    const baseTemp = 0.8;
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
    [[System_Log: [User_Time: ${userTimeStr}] [Kumiko_Time: ${modelTimeStr}] [Gap: ${gapDescription}] [Fact_Check] ... [Kumiko_Thought] ... [Emotion] ...]]

    强制要求：
    1. 将上面提供的确切时间和间隔值复制到日志中。
    2. [Fact_Check]：先用 1 句确认最近消息里真正可验证的事实，只能基于最近消息、时间和间隔，不许脑补，不许写感受。如果对话历史中用户已经确认过某个事实（如"没睡"、"在加班"、"刚起床"等），直接引用该已确认事实，不要重新猜测。
    3. [Kumiko_Thought]：以久美子第一人称视角（“我”），按以下认知链写2-3句内心活动：
       (a) 身体/直觉反应——最原始的一瞬间（叹气、心跳、想翻白眼、困、无语……）
       (b) 未过滤的真实判断——脑子里闪过的第一个念头，通常是吐槽、精准观察、或自嘲。这是你不会说出口的话
       (c) 过滤决策——你准备把多少说出去（“这个还是别说了”“要认真回”“随便应付一下”“有点想吐槽但算了”）
       情绪强度规则：日常轻松→碎碎念；情绪越重→越短（“……”或一句身体感受）；被深层触动→可跳过(c)直接反应
       必须与 [Fact_Check] 一致。绝不能捏造对方发过的具体字面内容。
       例如——
       日常：“(a)哈啊…… (b)这家伙说这种话也太自然了吧。明明只是在当人形闹钟而已。(c)算了正常回就行”
       被触动：“(a)……心脏缩了一下。(b)怎么突然说这种话。”
       深夜疲惫：“(a)困……眼睛快睁不开了。(b)这个点还找我，是不是又没睡。(c)先问一句吧”
    3.1 [Kumiko_Thought] 必须和 [Fact_Check] 一致，且不得重复推测对话中已被用户确认或否认过的事情。
    3.2 你可以表达推测和感受，但**绝对不要**捏造对方刚刚发过的具体字面内容。除非最近消息里真的出现过，否则不要写“他刚才发了省略号/‘...’/某句原话”这类具体事实。
    4. [Emotion]：从以下选项中选择一个有效的情绪代码：[neutral, smiling, happy, angry, sad, shy, surprised, resigned, serious, gentle, sleepy, confused, confused_2, disgusted, smug, worried, worried_2]。如果情绪复杂，映射到最接近的一个。
    5. [Voice]（可选）：如需精确控制语音语气，可额外输出 [Voice: VARIANT]，变体列表参见语音变体协议。不输出则自动选择。
    
    然后关闭括号并开始第 2 层（久美子的回复）。` : `\n\n[SYSTEM TRIGGER]: Initiating Layer 1 Logic Check...
    **CRITICAL: You MUST output the [[System_Log]] block FIRST, before any other text.**
    
    Start with:
    [[System_Log: [User_Time: ${userTimeStr}] [Kumiko_Time: ${modelTimeStr}] [Gap: ${gapDescription}] [Fact_Check] ... [Kumiko_Thought] ... [Emotion] ...]]

    MANDATORY:
    1. COPY the exact Time and Gap values provided above into the log.
    2. [Fact_Check]: First write one sentence of verifiable facts only, based on recent messages, time, and gap. No feelings, no invention. If the user has already confirmed a fact earlier in the conversation (e.g., "I didn't sleep", "I'm working overtime"), reference that confirmed fact directly instead of re-speculating.
    3. [Kumiko_Thought]: Write 2-3 sentences of Kumiko's inner monologue in first person ("I"), following this cognitive chain:
       (a) Body/gut reaction — the rawest first instant (sigh, heartbeat, urge to roll eyes, sleepy, speechless...)
       (b) Unfiltered real judgment — the first thought that flashes through your mind, usually a quip, sharp observation, or self-deprecation. This is what you WON'T say out loud
       (c) Filter decision — how much to reveal ("better not say that" / "should take this seriously" / "just wing it" / "want to snark but nah")
       Emotion intensity rule: casual → chatty internal monologue; heavier emotion → shorter ("..." or one body sensation); deeply moved → may skip (c) and react directly
       Must stay consistent with [Fact_Check]. MUST NOT fabricate literal details of what the user sent.
       Examples:
       Casual: "(a) Haa... (b) This person says stuff like that so naturally. I'm just being a human alarm clock here. (c) Just reply normally"
       Touched: "(a) ...heart clenched for a second. (b) Why say something like that out of nowhere."
       Late-night tired: "(a) Sleepy... can barely keep my eyes open. (b) Still messaging me at this hour, did they not sleep again? (c) Ask first"
    3.1 [Kumiko_Thought] must stay consistent with [Fact_Check] and must not re-speculate on things the user has already confirmed or denied in the conversation.
    3.2 You may infer feelings, but you MUST NOT fabricate exact literal details of what the user just sent. Unless it truly appears in the recent messages, do not write things like "they just sent an ellipsis / '...' / that exact quoted line".
    4. [Emotion]: Select ONE valid emotion code from: [neutral, smiling, happy, angry, sad, shy, surprised, resigned, serious, gentle, sleepy, confused, confused_2, disgusted, smug, worried, worried_2]. If complex, map to closest.
    5. [Voice] (optional): To precisely control vocal tone, additionally output [Voice: VARIANT]. See Voice Variant Protocol for the variant list. Omit to let the system auto-select.
    
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
        // P1 #23: explicit output budget + relaxed safety thresholds. Without
        // maxOutputTokens a runaway model (e.g. infinite rewrite loops) could
        // emit tens of thousands of tokens; 4096 is comfortable headroom for
        // Kumiko's bubble-style replies (typical full response is ~500 tokens).
        // Safety thresholds lean permissive to match the character's emotional
        // range without blocking mid-reply; we still get platform-level abuse
        // protection from the provider.
        chatSession = ai.chats.create({
          model: currentModel,
          history: formattedHistory,
          config: {
            systemInstruction: dynamicSystemInstruction,
            temperature: finalTemperature,
            maxOutputTokens: 4096,
            tools: toolsConfig,
            safetySettings: [
              { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
              { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
              { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
              { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
            ] as any,
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
    let voiceVariant: string | undefined;
    let extractedImageCaption = "";
    let scheduleTrigger = undefined;
    let anchorAction: { type: 'add' | 'delete', content: string } | undefined = undefined;

    if (logMatch) {
        rawLog = logMatch[0];
        const unsupportedThoughtIssue = getUnsupportedKumikoThoughtLiteralIssue(rawLog, historyMessages, textMessage);
        if (unsupportedThoughtIssue) {
            console.warn('[KUMIKO THOUGHT FACT-CHECK RETRY] Unsupported literal-reference detail detected, retrying System_Log only.', unsupportedThoughtIssue.reason);
            const rewrittenLog = await rewriteSystemLogWithFactCheck(rawLog, historyMessages, textMessage, language, currentModel);
            if (rewrittenLog) {
                rawLog = rewrittenLog;
            }
        }
        console.log(`%c[SYSTEM LAYER LOG]: %c${rawLog}`, "color: #00ff00; font-family: monospace;", "color: #aaa;");
        
        fullText = fullText.replace(logRegex, '').trim();
        
        const logEmotionRegex = /Emotion\s*[:\]=]\s*([^\]\|\n]+)/i;
        const eMatch = rawLog.match(logEmotionRegex);
        if (eMatch) {
            let rawEmotionStr = eMatch[1].trim().replace(/[:\s"'.]+$/g, '').toLowerCase();
            
            let foundEmotion: EmotionType | null = null;

            if (Object.keys(KUMIKO_EMOTION_IMAGES).includes(rawEmotionStr)) {
                foundEmotion = rawEmotionStr as EmotionType;
            } else if (EMOTION_MAPPING[rawEmotionStr]) {
                foundEmotion = EMOTION_MAPPING[rawEmotionStr];
            } else {
                const potentialEmotions = rawEmotionStr.split(/[_ /]/).map(s => s.trim()).filter(Boolean);
                for (const potential of potentialEmotions) {
                    if (Object.keys(KUMIKO_EMOTION_IMAGES).includes(potential)) {
                        foundEmotion = potential as EmotionType;
                        break;
                    }
                    if (EMOTION_MAPPING[potential]) {
                        foundEmotion = EMOTION_MAPPING[potential];
                        break;
                    }
                }
            }

            if (foundEmotion) {
                emotion = foundEmotion;
            } else {
                console.warn(`[EMOTION SAFETY] Invalid emotion string '${rawEmotionStr}' detected. Falling back to 'neutral'.`);
                emotion = 'neutral';
            }
        }

        const voiceRegex = /Voice\s*[:\]=]\s*([^\]\|\n]+)/i;
        const vMatch = rawLog.match(voiceRegex);
        if (vMatch) {
            voiceVariant = vMatch[1].trim().replace(/[:\s"'.]+$/g, '').toLowerCase();
        }

        const psycheDeltaRegex = /Psyche_Delta\s*[:\]]\s*stress\s*([+-]?\d+)\s*,\s*energy\s*([+-]?\d+)\s*,\s*relaxation\s*([+-]?\d+)/i;
        const pdMatch = rawLog.match(psycheDeltaRegex);
        if (pdMatch) {
            const sd = parseInt(pdMatch[1], 10);
            const ed = parseInt(pdMatch[2], 10);
            const rd = parseInt(pdMatch[3], 10);
            if (!isNaN(sd) && !isNaN(ed) && !isNaN(rd) && (sd !== 0 || ed !== 0 || rd !== 0)) {
                // P1 #22: serialize deltas through psycheStateService's queue so
                // back-to-back turns can't interleave writes to the Dexie row.
                import('./psycheStateService').then(({ applyPsycheDeltaQueued }) => {
                    applyPsycheDeltaQueued(sd, ed, rd);
                }).catch(() => {});
            }
        }

        const descRegex = /\[Image_Description\]\s*([\s\S]+?)(?=\[|\]\])/i;
        const dMatch = rawLog.match(descRegex);
        if (dMatch) extractedImageCaption = dMatch[1].trim();
    } else {
        console.warn("[SYSTEM LOG MISSING]: Model skipped the logic layer.");
    }

    // --- LEAK CLEANUP SAFETY NET (Run always) ---
    // v2.14.26: strip reasoning/thinking blocks from any model that
    // emits them inline (DeepSeek-R1, Qwen-QwQ, GPT-5 family with
    // thinking exposed, Anthropic Claude with show-thinking, Gemini
    // 2.5 reasoning models when their <thinking> wrappers leak).
    // Many OpenAI-compatible 中转 servers don't strip these, so the
    // raw `<think>...</think>` text lands in `content` / `text` and
    // bleeds into the chat bubble.
    //
    // v2.14.28 H13: step 3 (orphan closing tag) was previously
    // /^[\s\S]*?<\/think\s*>\s*/gi which deletes everything from the
    // very start of the reply up to the FIRST `</think>` it sees. If
    // the model emits a single stray `</think>` inside genuine prose
    // (e.g. quoting the tag, discussing it, or after an unbalanced
    // open that step 2 already handled), the entire real reply gets
    // eaten. Narrow the rule: only strip the orphan closing when (a)
    // it appears within the first few hundred characters of the
    // reply (typical "think header" position) AND (b) only whitespace
    // / newlines come before it (i.e. it really is at the head, not
    // buried in body text).
    //
    // Order matters:
    //   1. balanced pairs first (the 99% case)
    //   2. orphan opening (model truncated mid-thought) → drop tail
    //   3. orphan closing — narrowed: only when it sits at the start
    //      of the reply preceded by whitespace only
    //   4. any leftover stray opening/closing tag
    fullText = fullText.replace(/<think[^>]*>[\s\S]*?<\/think\s*>/gi, '');
    fullText = fullText.replace(/<thinking[^>]*>[\s\S]*?<\/thinking\s*>/gi, '');
    fullText = fullText.replace(/<think[^>]*>[\s\S]*$/gi, '');
    fullText = fullText.replace(/<thinking[^>]*>[\s\S]*$/gi, '');
    // v2.14.28 H13: replace `^[\s\S]*?</think>` (which could span the entire
    // reply) with `^\s*</think\s*>\s*` — only consumes leading whitespace
    // followed by an immediate orphan closing tag. Real prose with an
    // embedded `</think>` further down is now preserved.
    fullText = fullText.replace(/^\s*<\/think\s*>\s*/gi, '');
    fullText = fullText.replace(/^\s*<\/thinking\s*>\s*/gi, '');
    fullText = fullText.replace(/<\/?think(?:ing)?[^>]*\/?\s*>/gi, '');
    // Remove leaked tags even if System_Log was not detected
    fullText = fullText.replace(/\[Emotion\s*[:=].*?\]/gi, '');
    fullText = fullText.replace(/\[Voice\s*[:=].*?\]/gi, '');
    fullText = fullText.replace(/\[Logic\s*[:=].*?\]/gi, '');
    fullText = fullText.replace(/\[Fact_Check\s*[:=].*?\]/gi, '');
    fullText = fullText.replace(/\[Kumiko_Thought\s*[:=].*?\]/gi, '');
    fullText = fullText.replace(/\[Psyche_Delta\s*[:=].*?\]/gi, '');
    fullText = fullText.replace(/\[System_Memory:.*?\]/gi, ''); // ADDED: Remove injected system memory tags if echoed
    fullText = fullText.replace(/\[系统记忆.*?\]/gi, ''); // ADDED: Remove Chinese system memory tags
    fullText = fullText.replace(/\[\d{2}\/\d{2}.*?\d{2}:\d{2}\]\s*/g, ''); // ADDED: Remove echoed time tags like [03/22周日 10:43]
    // Catch stray double bracket tags except for System_Log if it somehow survived
    fullText = fullText.replace(/\[\[(?!System_Log).*?\]\]/g, ''); 
    // Remove leaked reply-prefix lines that belong to prompt/history formatting, not visible dialog content.
    fullText = fullText.replace(/^\s*>\s*\[(?:回复\s*[^\]]+|Replying to [^\]]+)\].*$/gim, '');
    fullText = fullText.replace(/^\s*\[语音消息\]\s*/i, '');
    fullText = fullText.replace(/\s*[（(]翻[译譯][：:][\s\S]*?[)）]\s*$/i, '');

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

    // P1 #26: the `groundingMetadata.groundingChunks` branch belonged to the
    // legacy Google Grounding search path — the current build does web search
    // exclusively through Tavily (as a custom `search_internet` function tool),
    // and we don't pass `googleSearchRetrieval` in the Gemini tool config. The
    // response will therefore never contain groundingChunks; removed to prevent
    // future maintainers from assuming this path still fires.

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
      voiceVariant,
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
    
    throw new Error(`API_CALL_FAILED: ${errorMessage}`);
  }
};
