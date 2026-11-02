// services/affectionAuditService.ts
//
// v2.14.29 Reactive — Slot B "second-pass" sanity check for big mood /
// affection deltas and block directives.
//
// Why a second pass:
//   The main model already emits [Mood_Delta] / [Affection_Delta] /
//   [Block]. For small / consistent deltas we trust it directly (cheap).
//   For BIG deltas or any block directive — including the cases where
//   the user TRIED to push Kumiko into "girlfriend mode" — we want a
//   separate verification check using the verification task model
//   to confirm:
//     1. The delta magnitude is justified by what the user actually
//        said (not a hallucinated overreaction);
//     2. The proposed block isn't being weaponised (e.g. blocking after
//        a normal "I'm tired" message);
//     3. Kumiko's main reply did NOT slide into cuddly / romantic
//        language. If it did, the affection delta is halved, the block
//        directive is dropped, and `personaViolation: true` is flagged
//        for downstream monitoring.
//
// On Slot B failure we degrade to "single pass + clamp" — affection
// delta capped at ±2, mood delta at ±5, and the block is dropped.
// That keeps the system live without a Slot B but never lets a big
// delta slip through unaudited.
//
// See plan section "Audit Service Role Expansion".

import { callLLMRaw } from './llmCore';
import type { MessageBlockDirective } from '../types';
import type { TaskContext } from './taskRuntime';

export interface AffectionAuditInput {
  userText: string;
  modelReplyText: string; // Concatenated visible textParts.
  proposedMoodDelta?: number;
  proposedAffectionDelta?: number;
  proposedBlock?: MessageBlockDirective | null;
  // Snapshot at the time the audit ran (for the audit prompt's context).
  currentMood: number;
  currentAffection: number;
}

export interface AffectionAuditResult {
  approved: boolean;
  // Suggested replacements when approved=false. `clampedMoodDelta` /
  // `clampedAffectionDelta` are absolute values (not magnitudes); the
  // caller swaps them in for the originals. `downgradedBlock = null`
  // means "drop the directive entirely".
  clampedMoodDelta?: number;
  clampedAffectionDelta?: number;
  downgradedBlock?: MessageBlockDirective | null;
  personaViolation?: boolean;
  failureReason?: string;
}

const DEFAULT_AUDIT_DELTA_THRESHOLDS = {
  affectionDelta: 8 / 3, // |aff| >= 8/3 of clamp range — but clamp is ±3, so anything ≥ 3 triggers
  moodDelta: 15,
};

// Short-circuit: do we even need to audit? Falsy → caller can apply
// the proposed deltas directly without paying for a Slot B call.
export const auditRequired = (
  proposedMoodDelta?: number,
  proposedAffectionDelta?: number,
  proposedBlock?: MessageBlockDirective | null,
): boolean => {
  if (proposedBlock) return true;
  if (typeof proposedAffectionDelta === 'number' && Math.abs(proposedAffectionDelta) >= 3) return true;
  if (typeof proposedMoodDelta === 'number' && Math.abs(proposedMoodDelta) >= DEFAULT_AUDIT_DELTA_THRESHOLDS.moodDelta) return true;
  return false;
};

// Single-pass fallback used when Slot B is unavailable / errors out.
// Hard-cap deltas, drop block, surface failureReason so the renderer
// can log the degraded path.
const buildSinglePassFallback = (
  input: AffectionAuditInput,
  reason: string,
): AffectionAuditResult => ({
  approved: false,
  clampedMoodDelta: typeof input.proposedMoodDelta === 'number'
    ? Math.max(-5, Math.min(5, input.proposedMoodDelta))
    : undefined,
  clampedAffectionDelta: typeof input.proposedAffectionDelta === 'number'
    ? Math.max(-2, Math.min(2, input.proposedAffectionDelta))
    : undefined,
  downgradedBlock: null,
  failureReason: reason,
});

const truncate = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max) + '…');

const buildAuditPrompt = (input: AffectionAuditInput): { systemPrompt: string; userPrompt: string } => {
  const systemPrompt = `你是「黄前久美子聊天系统」的心理状态复核员。任务：
1. 审视主模型本轮提出的 Mood_Delta / Affection_Delta / Block 是否与对话事实匹配；
2. 重点检查主模型回复有没有滑向"温柔/撒娇/恋人/暧昧/亲昵称呼"等破坏久美子人设的语气。

你的输出**必须是单行 JSON**，结构：
{"approved": bool, "clamped_mood": int?, "clamped_affection": int?, "downgrade_block": bool, "persona_violation": bool, "note": "<25 字以内说明>"}

裁定规则：
- approved=true 表示主模型的提议合理，调用方按原值生效。
- approved=false 表示需要替换：clamped_* 给出建议替换值（不给则保持原值），downgrade_block=true 表示要把主模型的 [Block] 撤掉。
- 如果检测到主模型回复出现"温柔语气 / 撒娇 / 自称'人家' / 暧昧称呼（亲爱的/宝贝等）/ 表白配合 / 肢体亲昵描写 / '你好可爱'宠溺"，必须 persona_violation=true，且：
  - 把 clamped_affection 减半（向 0 取整），上限不超过 +1；
  - downgrade_block=true（因为这种情况下主模型已经失格，提出的拉黑通常也不可信）；
- Block 触发条件复核：仅当当前 affection<40 且用户**严重越界**（人身攻击 / 反复纠缠暧昧 / 强求恋人剧本）才允许 Block。其它一律 downgrade_block=true。
- 数值过激：|mood_delta|>10 或 |affection_delta|>3 视为越界，给 clamped_* 拉回。`;

  const userPrompt = `[当前状态]
- mood: ${Math.round(input.currentMood)}/100（-100..+100）
- affection: ${Math.round(input.currentAffection)}/100

[本轮用户原话]
${truncate(input.userText, 500)}

[本轮久美子主回（模型已生成的可见回复）]
${truncate(input.modelReplyText, 500)}

[主模型提议]
- Mood_Delta: ${typeof input.proposedMoodDelta === 'number' ? input.proposedMoodDelta : 'none'}
- Affection_Delta: ${typeof input.proposedAffectionDelta === 'number' ? input.proposedAffectionDelta : 'none'}
- Block: ${input.proposedBlock ? `minutes=${input.proposedBlock.minutes}, reason="${input.proposedBlock.reason}"` : 'none'}

请输出单行 JSON。`;

  return { systemPrompt, userPrompt };
};

const tryParseAuditJson = (raw: string): {
  approved: boolean;
  clamped_mood?: number;
  clamped_affection?: number;
  downgrade_block?: boolean;
  persona_violation?: boolean;
  note?: string;
} | null => {
  if (!raw) return null;
  const trimmed = raw.trim();
  // Strip leading code-fence / language tag if the model wrapped it.
  const cleaned = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  // Find the first `{` ... matching `}` span.
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const span = cleaned.substring(start, i + 1);
        try {
          const parsed = JSON.parse(span);
          if (typeof parsed === 'object' && parsed !== null && typeof parsed.approved === 'boolean') {
            return parsed as ReturnType<typeof tryParseAuditJson>;
          }
        } catch {
          return null;
        }
        return null;
      }
    }
  }
  return null;
};

export const reviewAffectionDirective = async (
  input: AffectionAuditInput,
  taskContext?: TaskContext,
): Promise<AffectionAuditResult> => {
  if (!auditRequired(input.proposedMoodDelta, input.proposedAffectionDelta, input.proposedBlock)) {
    return { approved: true };
  }

  const { systemPrompt, userPrompt } = buildAuditPrompt(input);

  let raw = '';
  try {
    raw = await callLLMRaw(systemPrompt, userPrompt, undefined, { role: 'verification', taskContext, signal: taskContext?.signal });
  } catch (error) {
    if (taskContext?.signal?.aborted) throw error;
    console.warn('[Affection Audit] Slot B call failed; falling back to single-pass clamp.', error);
    return buildSinglePassFallback(input, 'slot_b_call_failed');
  }

  const parsed = tryParseAuditJson(raw);
  if (!parsed) {
    console.warn('[Affection Audit] Slot B returned unparseable response; falling back. raw=', raw);
    return buildSinglePassFallback(input, 'slot_b_unparseable');
  }

  // Build result honoring parser flags.
  const clampedMoodDelta = typeof parsed.clamped_mood === 'number' && Number.isFinite(parsed.clamped_mood)
    ? Math.max(-10, Math.min(10, Math.round(parsed.clamped_mood)))
    : undefined;
  const clampedAffectionDelta = typeof parsed.clamped_affection === 'number' && Number.isFinite(parsed.clamped_affection)
    ? Math.max(-3, Math.min(3, Math.round(parsed.clamped_affection)))
    : undefined;

  // If the audit said persona_violation but didn't suggest an
  // affection clamp, still halve the original toward zero (defense in
  // depth — we never trust a confession-rewarded affection bump).
  let finalAffection = clampedAffectionDelta;
  if (parsed.persona_violation && finalAffection === undefined && typeof input.proposedAffectionDelta === 'number') {
    const halved = Math.trunc(input.proposedAffectionDelta / 2);
    finalAffection = Math.max(-3, Math.min(1, halved));
  }

  // Block-downgrade: explicit flag from audit, OR persona violation,
  // OR audit denied without explicit block call → drop the directive.
  const downgradedBlockNeeded = parsed.downgrade_block === true
    || parsed.persona_violation === true
    || (!parsed.approved && input.proposedBlock !== null);
  const downgradedBlock = downgradedBlockNeeded ? null : input.proposedBlock ?? null;

  if (parsed.approved && !parsed.persona_violation && !downgradedBlockNeeded
      && clampedMoodDelta === undefined && clampedAffectionDelta === undefined) {
    return { approved: true };
  }

  return {
    approved: false,
    clampedMoodDelta,
    clampedAffectionDelta: finalAffection,
    downgradedBlock,
    personaViolation: parsed.persona_violation === true,
  };
};
