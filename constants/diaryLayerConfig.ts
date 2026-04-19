// Diary layer preset — controls how much of the user/Kumiko diary history is
// pushed into the LLM context on every turn vs. left for RAG to recall on demand.
//
// Why this exists (see audit P0 #12): before this refactor, geminiService
// unconditionally fetched every diary between the earliest chat message and now
// and interleaved the FULL `d.content` (400–1000+ chars each) into chat history.
// For a user with a year of data that approaches ~120K tokens of diary alone,
// enough to blow the 128K window of DeepSeek/GLM/Kimi/GPT-4o and cost hundreds
// of dollars/year even on models that can fit it. A `summary` field already
// exists on every diary entity; it just wasn't being used.
//
// Strategy:
//   L1 (always sent) recent full diaries — bounded by `fullDays` AND `fullBudgetChars`
//   L2 (only on time-related prompts) mid-term summaries — bounded by `summaryDays`
//       AND `summaryBudgetChars`, only when user mentions "last week", "recently", etc.
//   L3 (on demand) older diaries are left to the existing RAG pipeline; when the
//       user asks about something specific, RAG surfaces the relevant diary chunks.

export type DiaryLayerPreset = 'economy' | 'balanced' | 'rich';

export interface DiaryLayerConfig {
  /** L1 age cutoff: diaries newer than this get `d.content` injected as-is. */
  fullDays: number;
  /** L1 character budget: stop adding full diaries once we've used this many chars. */
  fullBudgetChars: number;
  /** L2 age cutoff: on time-intent turns, diaries within this window fall back to `d.summary`. */
  summaryDays: number;
  /** L2 character budget for summary tier. */
  summaryBudgetChars: number;
}

export const DIARY_LAYER_PRESETS: Record<DiaryLayerPreset, DiaryLayerConfig> = {
  // Aggressive token saving. Suited for expensive models (Claude/GPT-4o) or
  // users who chat heavily; still keeps 3 days of crisp recent memory.
  economy: {
    fullDays: 3,
    fullBudgetChars: 5_000,
    summaryDays: 14,
    summaryBudgetChars: 2_000,
  },
  // Default — tuned for "Kumiko vividly remembers the past week and has
  // rough recall of the past month", within ~1.8K tokens of context per turn.
  balanced: {
    fullDays: 7,
    fullBudgetChars: 12_000,
    summaryDays: 30,
    summaryBudgetChars: 3_000,
  },
  // For users on cheap models (DeepSeek/GLM) who want higher fidelity. Roughly
  // 8K tokens of diary per turn.
  rich: {
    fullDays: 14,
    fullBudgetChars: 25_000,
    summaryDays: 60,
    summaryBudgetChars: 5_000,
  },
};

export const DEFAULT_DIARY_LAYER_PRESET: DiaryLayerPreset = 'balanced';

// Detects user utterances that indicate a question about the recent past, where
// loading mid-term summaries is useful. Chinese & English heuristics — kept
// intentionally loose; false positives just cost a small number of extra tokens.
const MIDTERM_INTENT_RE = /上周|上个月|这个月|前.{0,2}天|那天|最近.{0,2}[月周天]|last\s+(?:week|month)|recent(?:ly)?|the other day|a while (?:ago|back)/i;

export const needsMidTermDiarySummaries = (userText: string): boolean => {
  if (!userText) return false;
  return MIDTERM_INTENT_RE.test(userText);
};
