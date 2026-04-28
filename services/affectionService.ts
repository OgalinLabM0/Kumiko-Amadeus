// services/affectionService.ts
//
// v2.14.29 Reactive — Long-term "好感度" / affection score, 0..100.
// Default 55 = "we already chat, but we're not best friends yet".
//
// IMPORTANT: the 81–100 band ("unguarded") = relaxed friend-level
// (similar to her canon dynamic with Reina / Manami) — explicitly
// NOT romantic / cuddly / "girlfriend mode". The persona invariant
// block forbids that vocabulary at the prompt level; this file's
// band labels and prompt strings stay friend-coded as a defense in
// depth.
//
// Pattern mirrors services/psycheStateService.ts (Dexie singleton,
// damping, queued delta, drift).

import { db, KumikoAffectionEntity } from './db';
import type { AffectionBand } from '../types';

const DEFAULT_AFFECTION_STATE: KumikoAffectionEntity = {
  id: 'current',
  score: 55,
  weeklyHigh: 55,
  weeklyLow: 55,
  lastUpdated: Date.now(),
};

// LLM may emit -3..+3 per turn. Even with damping this caps "one
// excellent turn" at +3, so noticeable affection movement is a multi-
// turn investment instead of a single-prompt cliff. Mirror the
// asymmetry from the spec (positive harder than negative — clamp is
// the same but the prompt template is stricter on +).
const DELTA_CLAMP = 3;
const DAMPING_FACTOR = 0.7;
// Slow regression toward 50 (~ "default acquaintance"): 0.5 score-
// points per day, applied during decay ticks. Keeps the score from
// freezing at extremes when the user goes quiet for weeks.
const DRIFT_PER_DAY = 0.5;

export const getAffectionState = async (): Promise<KumikoAffectionEntity> => {
  const state = await db.kumikoAffection.get('current');
  return state || DEFAULT_AFFECTION_STATE;
};

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export const applyAffectionDelta = async (
  delta: number,
): Promise<KumikoAffectionEntity> => {
  const state = await getAffectionState();
  let d = clamp(delta, -DELTA_CLAMP, DELTA_CLAMP);
  if (state.lastDelta && Math.sign(d) !== 0 && Math.sign(d) === Math.sign(state.lastDelta)) {
    d *= DAMPING_FACTOR;
  }
  const nextScore = clamp(state.score + d, 0, 100);
  const next: KumikoAffectionEntity = {
    id: 'current',
    score: nextScore,
    weeklyHigh: Math.max(state.weeklyHigh, nextScore),
    weeklyLow: Math.min(state.weeklyLow, nextScore),
    lastUpdated: Date.now(),
    lastDelta: d,
  };
  await db.kumikoAffection.put(next);
  return next;
};

let affectionDeltaQueue: Promise<unknown> = Promise.resolve();
export const applyAffectionDeltaQueued = (delta: number): Promise<KumikoAffectionEntity | null> => {
  const task = affectionDeltaQueue
    .catch(() => undefined)
    .then(() => applyAffectionDelta(delta))
    .catch(e => {
      console.warn('[Affection] Queued delta failed:', e);
      return null as KumikoAffectionEntity | null;
    });
  affectionDeltaQueue = task;
  return task;
};

export const tickAffectionDrift = async (
  now: number = Date.now(),
): Promise<KumikoAffectionEntity> => {
  const state = await getAffectionState();
  const daysElapsed = Math.max(0, (now - state.lastUpdated) / 86_400_000);
  if (daysElapsed < 1) return state;
  const target = 50;
  const distance = target - state.score;
  const step = Math.min(Math.abs(distance), DRIFT_PER_DAY * daysElapsed) * Math.sign(distance);
  if (Math.abs(step) < 0.1) return state;
  const next: KumikoAffectionEntity = {
    ...state,
    score: clamp(state.score + step, 0, 100),
    lastUpdated: now,
  };
  await db.kumikoAffection.put(next);
  return next;
};

export const getAffectionBand = (score: number): AffectionBand => {
  if (score <= 25) return 'distrusting';
  if (score <= 45) return 'cool';
  if (score <= 60) return 'default';
  if (score <= 80) return 'fond';
  return 'unguarded';
};

export const getAffectionBandLabelLocalized = (band: AffectionBand, lang: 'zh' | 'en'): string => {
  if (lang === 'en') {
    switch (band) {
      case 'distrusting': return 'distrusting';
      case 'cool': return 'cool';
      case 'default': return 'default';
      case 'fond': return 'fond';
      case 'unguarded': return 'unguarded';
    }
  }
  switch (band) {
    case 'distrusting': return '不信任';
    case 'cool': return '偏冷淡';
    case 'default': return '默认距离';
    case 'fond': return '熟人放松';
    case 'unguarded': return '老友级别';
  }
};

// Prompt-builder used by services/geminiService.ts affectionToneBlock.
// At the high end (unguarded, 81–100) the language is intentionally
// "old friend" not "lover" — "doesn't measure her words, jokes, casual
// roasts", but explicitly forbids cuddly tone.
export const getAffectionBlock = (score: number): string => {
  const band = getAffectionBand(score);
  const s = Math.round(score);
  switch (band) {
    case 'distrusting':
      return `[对用户的好感度：不信任 / distrusting，affection=${s}/100]
- 想和这个人保持距离。可以明显冷处理，回复短，避免分享私事。
- 不主动找话题，不接调情，不接撒娇。
- 即使对方道歉，也不能立刻拉到熟人级别。`;
    case 'cool':
      return `[对用户的好感度：偏冷淡 / cool，affection=${s}/100]
- 懒得多说，回复偏短，话题表层化即可。
- 不会主动关心，但被问到时会答。`;
    case 'default':
      return `[对用户的好感度：默认距离 / default，affection=${s}/100]
- 久美子和"已经在聊但不算很熟"的人之间的标准距离感。
- 该吐槽吐槽，该客套客套。`;
    case 'fond':
      return `[对用户的好感度：熟人放松 / fond，affection=${s}/100]
- 像和已经混熟的朋友聊天，话题可以再放松一点，会主动接小吐槽。
- 不需要每句都用敬语 / 措辞 / 字斟句酌。`;
    case 'unguarded':
      return `[对用户的好感度：老友级别 / unguarded，affection=${s}/100]
- ≈ 她对真奈美 / 丽奈那种放下防备的相处。"对你说话不再特别注意分寸"。
- 可以更直接地吐槽、起话题、自嘲，**笑点会变低**。
- **绝对禁止**：温柔语气 / 撒娇 / 暧昧自称 / 称呼变化（亲爱的 / 宝贝 / 老公 / 人家）/ 表白配合 / 肢体亲昵描写 / "你好可爱"宠溺。
- 高分只代表"防备小了"，不代表"和你恋爱了"。哪怕用户在表白 / 调情 / 越界，也以本人风格冷处理或敷衍。`;
  }
};
