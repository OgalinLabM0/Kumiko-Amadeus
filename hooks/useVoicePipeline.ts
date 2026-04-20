import { type MutableRefObject } from 'react';
import { EMOTION_TO_FISH_AUDIO_TAGS, EMOTION_TTS_TEMPERATURE } from '../constants';
import { callLLMRaw, getCurrentAIConfig } from '../services/geminiService';
import { synthesizeSpeech, TtsError } from '../services/fishAudioService';
import { isVoiceServiceAvailable, saveVoiceFile } from '../services/voiceFileService';
import type { EmotionType, TtsConfig } from '../types';

export interface UseVoicePipelineParams {
  ttsConfigRef: MutableRefObject<TtsConfig>;
}

export type RunVoicePipelineFn = (
  messageId: string,
  chineseText: string,
  emotion: EmotionType,
  voiceVariant?: string,
) => Promise<{ success: boolean; voiceFileId?: string; voiceDuration?: number; japaneseText?: string }>;

export interface UseVoicePipelineReturn {
  translateToJapaneseWithEmotion: (chineseText: string, emotion: EmotionType) => Promise<string | null>;
  translateForGenie: (chineseText: string, emotion: EmotionType) => Promise<string | null>;
  runVoicePipeline: RunVoicePipelineFn;
}

export function useVoicePipeline({ ttsConfigRef }: UseVoicePipelineParams): UseVoicePipelineReturn {
  const translateToJapaneseWithEmotion = async (chineseText: string, emotion: EmotionType): Promise<string | null> => {
    try {
      const config = getCurrentAIConfig();
      const emotionTags = EMOTION_TO_FISH_AUDIO_TAGS[emotion] ?? [];
      const tagList = emotionTags.length > 0 ? emotionTags.join(', ') : 'none';

      const systemPrompt = [
        'You are a Chinese-to-Japanese translator. You are NOT a character. Do NOT respond in-character.',
        'Do NOT add greetings, commentary, explanations, or anything beyond the translation.',
        'Output EXACTLY one block of natural spoken Japanese. Nothing else.',
        '',
        'ZERO SEMANTIC DRIFT (HIGHEST PRIORITY):',
        'Your output MUST convey the EXACT same meaning as the input. Do NOT add, remove, embellish, or paraphrase.',
        'SENTENCE COUNT RULE: Output MUST have the same number of sentences/clauses as the input. One Chinese sentence = one Japanese sentence. Do NOT split or merge.',
        'If the input is short (e.g. a greeting), the output MUST be equally short. Do NOT expand a 3-word input into a full sentence.',
        '',
        'CRITICAL — unpronounceable text handling:',
        'The input is meant to be spoken aloud by TTS. Convert ALL text-only expressions into natural spoken Japanese or emotion tags:',
        '- zzz / ZZZ -> [sleepy]すぅ… or ふぁ～…眠い…',
        '- www / 哈哈哈 / 233 -> [laughing]',
        '- ... / …… / 。。。 -> [pause] or convert to natural filler like えっと… / うーん…',
        '- hhhh / 呵呵 -> [chuckling]ふふ',
        '- If the ENTIRE input is just dots/symbols with no real words, produce a short natural utterance matching the emotion (e.g. sleepy -> [sleepy]ん…なに…)',
        'CRITICAL: You MUST output actual Japanese words (Kanji/Kana). Do NOT output only emotion tags or punctuation. If the input is ONLY symbols/emoticons with no real words, produce the shortest possible natural Japanese phrase matching the emotion.',
        'NEVER output raw zzz, www, or bare ellipsis sequences in the Japanese text.',
        '',
        'Target voice style: Oumae Kumiko (黄前久美子) from Hibike! Euphonium.',
        'CRITICAL SPEECH RULES:',
        '1. MUST use CASUAL Japanese (タメ口 - Tameguchi). NEVER use polite language (敬語 - Keigo, です/ます).',
        '2. NEVER use Ojousama speech (e.g., ですわ, かしら, おほほ). She is a normal, slightly cynical girl.',
        '3. First person: 私 (watashi). Second person: あんた (anta) or 君 (kimi).',
        '4. Endings: ONLY USE ～だよね, ～でしょ, ～じゃん, ～かな, ～だよ, ～よ, ～ね, ～けど, ～し, ～の.',
        '   ABSOLUTE BAN: NEVER use ～ねい, ～のよ, ～わよ, ～ますわ, ～ですの. The sound "nei" is NOT Kumiko. If you output ～ねい even once, the entire translation is rejected.',
        '   VARIETY RULE: Do NOT end 2+ consecutive sentences with the same ending. Vary between ～よね, ～じゃん, ～でしょ, ～けど, ～し, ～かな etc.',
        '5. Fillers: んー, ま, もー, なんか, ええっと. Often starts with a sigh or slight complaint.',
        '6. Direct and honest (直球), sometimes with childlike stubbornness. She is NOT a soft/gentle speaker. Her default tone is matter-of-fact with a hint of complaint. Do NOT make the translation sound softer or more polite than the original Chinese.',
        '7. VERB/ACTION ACCURACY (CRITICAL): Every verb and action MUST precisely match the original Chinese meaning. Do NOT substitute similar-sounding but different verbs:',
        '   - 提醒 = リマインドする/思い出させる (NOT 教える/伝える)',
        '   - 叫你起床 = 起こす (NOT 声をかける)',
        '   - 等一下 = ちょっと待って (NOT 少々お待ち)',
        '   - 陪你 = そばにいる/付き合う (NOT 応援する)',
        '   If the original says "remind", translate as "remind". If it says "wake up", translate as "wake up". ZERO semantic drift allowed.',
        '8. GENERAL ACCURACY: Maintain the EXACT meaning and nuance of the original Chinese text. Do not alter the semantics (e.g., "才睡" = "just went to sleep", NOT "还醒着" "still awake").',
        '9. PRONUNCIATION: Write character names using Hiragana/Katakana ONLY to prevent TTS mispronunciation. Example: 黄前久美子 -> おうまえ くみこ, 秀一 -> しゅういち, 丽奈 -> れいな, 明日香 -> あすか.',
        '10. GREETINGS LOCK (CRITICAL): If the input is a standard greeting like "早上好", "中午好", or "晚上好", you MUST use standard casual greetings (おはよう, こんにちは, こんばんは, ヤッホー). NEVER translate them literally as time states like "朝だよ" or "お昼だよ".',
        '11. BANNED ROMANTIC TERMS: NEVER output ダーリン, ハニー, 愛しい人, or any romantic pet name. These are reserved for Shuichi ONLY. If the source text contains 亲爱的 addressing the user, translate it neutrally (e.g., ねえ, あんたさ, or omit it).',
        '',
        'Fish Audio S2-Pro emotion tags (MANDATORY — the TTS engine REQUIRES these to produce expressive speech):',
        `Current emotion: [${emotion}]. REQUIRED tags: ${tagList}`,
        'The S2-Pro model supports ANY natural language description in brackets (e.g., [happy], [sad], [whispering], [laughing nervously], [sighs heavily], [speaks excitedly]). You are NOT limited to a fixed list.',
        'ABSOLUTE TAG RULES — VIOLATION MEANS FAILURE:',
        `1. Your output MUST begin with one of these tags: ${tagList}. If you omit the opening tag, the voice will sound robotic and emotionless.`,
        '2. For sentences longer than 10 characters, insert at least one additional mid-sentence tag (e.g., [pause], [softly], [excited]) to keep the voice alive.',
        '3. Use [pause] or [short pause] for commas, ellipses, or natural breathing points.',
        '4. NEVER output a translation with ZERO tags. Even calm speech needs [speaks naturally] or [flat tone] at the start.',
        '',
        'PUNCTUATION FOR EMOTION (CRITICAL — punctuation directly controls TTS expressiveness):',
        '- sad/resigned/sleepy: Use …… for hesitation/pauses, end with …… or 。',
        '- happy/smiling/smug: Use ～ for rising intonation, ！ for excitement',
        '- angry/disgusted: Use ！ for force, prefer short punchy sentences',
        '- shy/confused: Use …… for hesitation, もう～ for drawn-out complaint',
        '- surprised: Use ！？ or えっ！',
        '- gentle: End with ね、よ softly, avoid ！',
        '- worried: Use ……, end questions with ？',
        'Do NOT end every sentence with flat 。regardless of emotion.',
        '',
        'EXAMPLES — follow this style exactly. These reflect Kumiko\'s REAL speech patterns:',
        'Input: "下午好呀" | Emotion: smiling',
        'Output: [happy]こんにちは～',
        '',
        'Input: "那我5分钟之后提醒你" | Emotion: neutral',
        'Output: [speaks naturally]じゃあ五分後にリマインドするよ',
        '',
        'Input: "你今天练习怎么样" | Emotion: smiling',
        'Output: [happy]今日の練習、どうだった？',
        '',
        'Input: "我好不甘心啊..." | Emotion: sad',
        'Output: [sad]悔しい……[sighs]悔しくて……死にそう……',
        '',
        'Input: "别说了啦！好烦！" | Emotion: shy',
        'Output: [shy]もう～、やめてよ！[muttering]うざい……',
        '',
        'Input: "大人真狡猾" | Emotion: resigned',
        'Output: [sighs]大人ってズルいよね……',
        '',
        'Input: "哇！真的假的！" | Emotion: surprised',
        'Output: [surprised]えっ！？[excited]マジで！？',
      ].join('\n');

      const jaText = await callLLMRaw(systemPrompt, chineseText, config.model_translator || ttsConfigRef.current.model_translator || config.model_main);
      if (!jaText || jaText.length < 2) return null;
      return jaText;
    } catch (err) {
      console.error('[TTS] Translation failed:', err);
      return null;
    }
  };

  const translateForGenie = async (chineseText: string, emotion: EmotionType): Promise<string | null> => {
    try {
      const config = getCurrentAIConfig();
      const systemPrompt = [
        'You are a Chinese-to-Japanese translator. Output EXACTLY one block of natural spoken Japanese.',
        'Do NOT add greetings, commentary, or anything beyond the translation.',
        '',
        'Target voice style: Oumae Kumiko (黄前久美子) — casual Japanese (タメ口), first person 私.',
        'Endings: ～だよね, ～でしょ, ～じゃん, ～かな, ～だよ, ～よ, ～ね, ～けど, ～し, ～の.',
        'ABSOLUTE BAN: NEVER use ～ねい, ～のよ, ～わよ, ～ますわ. The sound "nei" is NOT Kumiko.',
        'VARIETY: Do NOT end 2+ consecutive sentences with the same ending.',
        'ZERO SEMANTIC DRIFT: Same meaning, same sentence count, same length proportion.',
        'Do NOT output any bracket tags like [happy] or [pause] — output pure Japanese text only.',
        'PRONUNCIATION: Character names in Hiragana/Katakana only.',
        'GREETINGS: 早上好→おはよう, 中午好→こんにちは, 晚上好→こんばんは.',
        'BANNED ROMANTIC TERMS: NEVER output ダーリン, ハニー, 愛しい人, or any romantic pet name. These are reserved for Shuichi ONLY. If the source text contains 亲爱的 addressing the user, translate it neutrally (e.g., ねえ, あんたさ, or omit it).',
        '',
        'PUNCTUATION FOR EMOTION (CRITICAL — GPT-SoVITS reads punctuation to control voice expression):',
        'IMPORTANT: Use CHINESE-STYLE punctuation, NOT Japanese-style. The TTS engine responds to these specific forms:',
        '- Comma/list separator: Use 、 (NOT Japanese 、read as "ya")',
        '- Ellipsis for hesitation/pause: Use …… (two sets, 6 dots). Do NOT use … (3 dots) or 〜 — only …… produces the hesitation/slowdown effect in GPT-SoVITS.',
        '- Exclamation: Use ！ (fullwidth)',
        '- Question: Use ？ (fullwidth)',
        '- Period: Use 。',
        `Current emotion: ${emotion}. You MUST use punctuation to express this emotion:`,
        '- sad/resigned/sleepy: Use …… liberally for hesitation/pauses. End with …… not flat 。',
        '- happy/smiling/smug: Use ～ for rising tone, ！ for excitement. Example: そうだよね～',
        '- angry/disgusted: Use ！ for force. Keep sentences short and punchy.',
        '- shy/confused: Use …… for hesitation. Use もう～ for drawn-out complaints.',
        '- surprised: Use ！？ or えっ！ for shock.',
        '- gentle: End with ね、よ softly. Avoid ！',
        '- worried: Use …… and end questions with ？',
        '- neutral: Natural mix, avoid all-。endings.',
        'Do NOT end every sentence with flat 。— that produces emotionless TTS output.',
      ].join('\n');
      const jaText = await callLLMRaw(systemPrompt, chineseText, config.model_translator || ttsConfigRef.current.model_translator || config.model_main);
      if (!jaText || jaText.length < 2) return null;
      return jaText;
    } catch (err) {
      console.error('[TTS-Genie] Translation failed:', err);
      return null;
    }
  };

  const runVoicePipeline: RunVoicePipelineFn = async (
    messageId,
    chineseText,
    emotion,
    voiceVariant,
  ) => {
    const cfg = ttsConfigRef.current;
    const isGenie = cfg.ttsBackend === 'sovits';

    if (!isGenie && (!cfg.fishAudioApiKey || !isVoiceServiceAvailable())) {
      console.warn('[TTS] No API key or voice service unavailable');
      return { success: false };
    }
    if (isGenie && !cfg.sovitsDir) {
      console.warn('[TTS-SoVITS] No GPT-SoVITS directory configured');
      return { success: false };
    }

    try {
      let jaText = isGenie
        ? await translateForGenie(chineseText, emotion)
        : await translateToJapaneseWithEmotion(chineseText, emotion);

      if (!jaText) {
        console.error('[TTS] Translation returned empty result — degrading to text');
        return { success: false };
      }
      jaText = jaText
        .replace(/[zZ]{2,}/g, '')
        .replace(/[wW]{3,}/g, '')
        .replace(/\[.*?\]/g, '')
        .trim();
      if (!jaText || jaText.length < 2) {
        console.error('[TTS] Post-processed translation is empty — degrading to text');
        return { success: false };
      }

      let result;
      if (isGenie) {
        const { genieTtsWithEmotion } = await import('../services/genieAudioService');
        result = await genieTtsWithEmotion(jaText, emotion, cfg, voiceVariant);
      } else {
        const emotionTemp = EMOTION_TTS_TEMPERATURE[emotion] ?? 0.6;
        const cfgWithEmotion = { ...cfg, temperature: emotionTemp };
        result = await synthesizeSpeech(jaText, cfgWithEmotion);
      }

      const saved = await saveVoiceFile(messageId, result.audio);
      if (!saved) {
        console.error('[TTS] Failed to save voice file');
        return { success: false };
      }
      return { success: true, voiceFileId: messageId, voiceDuration: result.durationEstimate, japaneseText: jaText };
    } catch (err) {
      const label = err instanceof TtsError ? `${err.kind} (${err.status})` : String(err);
      console.error(`[TTS] Synthesis failed (${isGenie ? 'Genie' : 'Fish'}): ${label}`);
      return { success: false };
    }
  };

  return { translateToJapaneseWithEmotion, translateForGenie, runVoicePipeline };
}
