// services/reminderIntentRetry.ts
//
// v2.14.17 — D-fallback: triggered second-opinion LLM pass for reminder
// intent extraction. Only runs when BOTH the main-pass LLM scheduleTrigger
// AND the local regex parsers (parseRelativeReminderRequest /
// parseDailyReminderRequest) miss, gated upstream by `hasReminderIntent`
// in chatActions.ts. So 0 LLM cost on every normal turn — only fires on
// the edge cases where the user expressed reminder intent but neither
// path could extract usable timing.
//
// Returns null in every "not actually a reminder" case so the warn block
// stays quiet and we never create a phantom reminder.
//
// Platform agnostic — uses callLLMRaw which is the same pipeline PC and
// Capacitor Android both use for utility LLM tasks (see
// diaryValidatorService.ts for the pattern this module mirrors).

import { callLLMRaw, getCurrentAIConfig } from './geminiService';
import type { Language } from '../types';

export interface ReminderIntentRetryResult {
  isReminder: boolean;
  event?: string;
  /** Seconds from now (preferred for "30秒后" / "in 5 minutes" type asks). */
  delaySeconds?: number;
  /** 0-23, only meaningful when recurrence === 'daily'. */
  hour?: number;
  /** 0-59, only meaningful when recurrence === 'daily'. */
  minute?: number;
  /** 'daily' for recurring asks, 'once' for one-off, null if unsure. */
  recurrence?: 'daily' | 'once' | null;
}

const SYSTEM_PROMPT_ZH = `你是一个意图提取器，专门判断用户消息是否表达了"创建定时提醒"的意图，并提取出时间和事件。

只输出一个 JSON 对象，不要任何其他文字（包括 markdown 代码块、解释、前后文）：

{
  "isReminder": boolean,
  "event": string | null,
  "delaySeconds": number | null,
  "hour": number | null,
  "minute": number | null,
  "recurrence": "daily" | "once" | null
}

判断规则:
- isReminder=true 当且仅当用户明确要求"在某个时间点/某段时间后提醒/叫/喊我做某事"。
- 一次性相对时间（"30秒后"/"5分钟后"/"两小时后"/"in 5 min"）→ recurrence="once" + delaySeconds (转成秒)。
- 每日重复（"每天 8 点"/"每晚 10 点半"/"daily at 7am"）→ recurrence="daily" + hour (0-23) + minute (0-59)。
- 含糊提及未来事件但没有明确时间 → isReminder=false。
- 单纯问候/闲聊/感叹 → isReminder=false。
- event 是简短动词短语（"喝水"/"开会"/"吃药"）。如果用户没说做什么，event 可以是 "提醒你"。
- 多义/不确定 → 优先 isReminder=false。`;

const SYSTEM_PROMPT_EN = `You are an intent extractor: decide whether the user's message asks to create a timed reminder, and extract the time + event.

Output only a single JSON object, no other text (no markdown fences, no explanation):

{
  "isReminder": boolean,
  "event": string | null,
  "delaySeconds": number | null,
  "hour": number | null,
  "minute": number | null,
  "recurrence": "daily" | "once" | null
}

Rules:
- isReminder=true iff the user explicitly asks to be reminded/pinged/called at a specific point in time or after a duration.
- One-off relative time ("in 30 seconds" / "after 5 min" / "30秒后") → recurrence="once" + delaySeconds (in seconds).
- Daily recurring ("every day 8am" / "daily at 22:30" / "每天早上7点") → recurrence="daily" + hour (0-23) + minute (0-59).
- Vague future mention without specific time → isReminder=false.
- Pure greetings / chitchat / exclamations → isReminder=false.
- event is a short verb phrase ("drink water" / "meeting" / "take medicine"). If unspecified, event can be "remind you".
- When ambiguous → prefer isReminder=false.`;

function tryParseJson(raw: string): ReminderIntentRetryResult | null {
  if (!raw) return null;
  let text = raw.trim();
  // The model occasionally wraps JSON in a fenced block despite instructions.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) text = fenceMatch[1].trim();
  // Or it preambles with "Here's the JSON:" — grab the first { ... } block.
  if (text[0] !== '{') {
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (!braceMatch) return null;
    text = braceMatch[0];
  }
  try {
    // v2.14.23: looser coercion. Some models stream JSON with stringified
    // primitives (`"isReminder": "true"`, `"hour": "22"`) which under the
    // strict typeof checks below would silently get rejected and the
    // whole D-fallback would return null - the user then sees their
    // "晚点提醒我" go nowhere. Accept stringified bool/int as long as the
    // semantic value is unambiguous.
    const parsed = JSON.parse(text) as Record<string, unknown>;

    const coerceBool = (v: unknown): boolean | null => {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') {
        const lo = v.trim().toLowerCase();
        if (lo === 'true' || lo === 'yes' || lo === '1') return true;
        if (lo === 'false' || lo === 'no' || lo === '0') return false;
      }
      return null;
    };
    const coerceInt = (v: unknown): number | null => {
      if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
      if (typeof v === 'string') {
        const trimmed = v.trim();
        if (!trimmed) return null;
        const n = Number(trimmed);
        if (Number.isFinite(n)) return Math.round(n);
      }
      return null;
    };
    const coerceStringTrim = (v: unknown): string | undefined => {
      if (typeof v === 'string') return v.trim() || undefined;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v).trim() || undefined;
      return undefined;
    };

    const isReminder = coerceBool(parsed.isReminder);
    if (isReminder === null) return null;
    const delayInt = coerceInt(parsed.delaySeconds);
    const hourInt = coerceInt(parsed.hour);
    const minuteInt = coerceInt(parsed.minute);
    const rec = typeof parsed.recurrence === 'string' ? parsed.recurrence.trim().toLowerCase() : null;

    return {
      isReminder,
      event: coerceStringTrim(parsed.event),
      delaySeconds: delayInt !== null && delayInt > 0 ? delayInt : undefined,
      hour: hourInt !== null && hourInt >= 0 && hourInt <= 23 ? hourInt : undefined,
      minute: minuteInt !== null && minuteInt >= 0 && minuteInt <= 59 ? minuteInt : undefined,
      recurrence: rec === 'daily' || rec === 'once' ? (rec as 'daily' | 'once') : null,
    };
  } catch {
    return null;
  }
}

/**
 * Triggered second-opinion reminder intent extractor. Returns null if the
 * model says it's not a reminder, the JSON is malformed, or the timing
 * fields are insufficient to actually create a reminder.
 *
 * Caller (chatActions.ts) is responsible for the gating: only invoke when
 * `hasReminderIntent && !createdReminderThisTurn` (i.e. local regex
 * detected user wanted a reminder but neither the main-pass LLM
 * scheduleTrigger nor the local parser produced usable timing).
 */
export const extractReminderIntentLLM = async (
  userText: string,
  language: Language,
): Promise<ReminderIntentRetryResult | null> => {
  if (!userText || !userText.trim()) return null;

  const config = getCurrentAIConfig();
  // Prefer the lighter "summary" model (same choice diaryValidatorService
  // makes for its extraction pass). Falls back to model_main when no
  // summary model is configured. Fast and cheap.
  const model = config.model_summary || config.model_main;

  const systemPrompt = language === 'en' ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_ZH;
  const userPrompt = language === 'en'
    ? `User message:\n${userText.slice(0, 800)}\n\nReturn the JSON now.`
    : `用户消息:\n${userText.slice(0, 800)}\n\n现在返回 JSON。`;

  let raw = '';
  try {
    raw = await callLLMRaw(systemPrompt, userPrompt, model);
  } catch (err) {
    console.warn('[reminderIntentRetry] callLLMRaw failed:', err);
    return null;
  }

  const parsed = tryParseJson(raw);
  if (!parsed) {
    console.warn('[reminderIntentRetry] failed to parse JSON, raw:', raw.slice(0, 200));
    return null;
  }
  if (!parsed.isReminder) return parsed;

  // Sanity gate: must have either daily timing or a positive delaySeconds.
  const hasDaily = parsed.recurrence === 'daily' && typeof parsed.hour === 'number' && typeof parsed.minute === 'number';
  const hasRelative = typeof parsed.delaySeconds === 'number' && parsed.delaySeconds > 0;
  if (!hasDaily && !hasRelative) {
    console.warn('[reminderIntentRetry] isReminder=true but timing missing:', parsed);
    return parsed;
  }

  if (!parsed.event) {
    parsed.event = language === 'en' ? 'remind you' : '提醒你';
  }

  return parsed;
};
