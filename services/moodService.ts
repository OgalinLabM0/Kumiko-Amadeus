// services/moodService.ts
//
// v2.14.29 Reactive — Short-term "how she feels about you right now"
// state. -100 (cold/hostile) ↔ +100 (relaxed/playful), 0 = neutral.
//
// IMPORTANT: the +60..+100 band is intentionally NOT "tender / clingy /
// girlfriend mode" — it's "easy-going friend, jokes more, doesn't
// censor herself". The persona invariant block in
// services/geminiService.ts is the hard guardrail, but the band labels
// + prompt strings here also avoid cuddly vocabulary so the layered
// defense holds even if a downstream prompt assembly skips a step.
//
// Pattern mirrors services/psycheStateService.ts (Dexie singleton row,
// damping queue, queued delta, plain prompt builder); see plan
// "reactive_mood_affection_block".

import { db, KumikoMoodEntity } from './db';
import type { MoodBand } from '../types';

const DEFAULT_MOOD_STATE: KumikoMoodEntity = {
  id: 'current',
  mood: 0,
  lastUpdated: Date.now(),
};

// LLM may emit -10..+10 per turn; we clamp here as a defense against
// hallucinated extremes. Damping prevents the same direction from
// piling up endlessly into saturation.
const DELTA_CLAMP = 10;
const DAMPING_FACTOR = 0.55;
// Drift speed when no chat is happening: each fully-elapsed minute
// since `lastUpdated` collapses ~0.5 mood points toward the affection-
// derived baseline. Keeps mood from sticking at extremes between
// sessions while still letting a single bad turn linger for a while.
const DRIFT_PER_MINUTE = 0.5;

export const getMoodState = async (): Promise<KumikoMoodEntity> => {
  const state = await db.kumikoMood.get('current');
  return state || DEFAULT_MOOD_STATE;
};

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

// Mood "wants" to settle near (affection - 50) * 0.4. With affection
// pinned to its 0..100 ceiling, the baseline is +20 (NOT +40+), which
// is exactly what we want — "her usual mood toward someone she's
// friendly with" maxes at "slightly upbeat", never "doting".
export const moodBaselineFor = (affection: number): number => {
  return clamp((affection - 50) * 0.4, -20, 20);
};

export const applyMoodDelta = async (
  delta: number,
): Promise<KumikoMoodEntity> => {
  const state = await getMoodState();
  let d = clamp(delta, -DELTA_CLAMP, DELTA_CLAMP);
  if (state.lastDelta && Math.sign(d) !== 0 && Math.sign(d) === Math.sign(state.lastDelta)) {
    d *= DAMPING_FACTOR;
  }
  const next: KumikoMoodEntity = {
    id: 'current',
    mood: clamp(state.mood + d, -100, 100),
    lastUpdated: Date.now(),
    lastDelta: d,
  };
  await db.kumikoMood.put(next);
  return next;
};

// v2.14.29: serialise deltas through a queue. Two LLM responses
// arriving within ms of each other (e.g. proactive + reply) used to
// race the read-modify-write cycle on `kumikoMood`; queueing chains
// them so later writes always see the earlier write's row state.
let moodDeltaQueue: Promise<unknown> = Promise.resolve();
export const applyMoodDeltaQueued = (delta: number): Promise<KumikoMoodEntity | null> => {
  const task = moodDeltaQueue
    .catch(() => undefined)
    .then(() => applyMoodDelta(delta))
    .catch(e => {
      console.warn('[Mood] Queued delta failed:', e);
      return null as KumikoMoodEntity | null;
    });
  moodDeltaQueue = task;
  return task;
};

// Periodic decay toward the affection-derived baseline. Caller (the
// regulator hook or boot bootstrap) passes the current affection score
// so we don't have to import affectionService here (avoids circular
// init). `now` defaults to Date.now() but is parameterised for tests.
export const tickMoodDecay = async (
  affectionScore: number,
  now: number = Date.now(),
): Promise<KumikoMoodEntity> => {
  const state = await getMoodState();
  const minutesElapsed = Math.max(0, (now - state.lastUpdated) / 60_000);
  if (minutesElapsed < 1) return state;
  const baseline = moodBaselineFor(affectionScore);
  const distance = baseline - state.mood;
  // Move at DRIFT_PER_MINUTE per minute, but never overshoot (sign-flip).
  const step = Math.min(Math.abs(distance), DRIFT_PER_MINUTE * minutesElapsed) * Math.sign(distance);
  if (Math.abs(step) < 0.1) return state;
  const next: KumikoMoodEntity = {
    ...state,
    mood: clamp(state.mood + step, -100, 100),
    lastUpdated: now,
  };
  await db.kumikoMood.put(next);
  return next;
};

// Five-band classification used by both the prompt builder and the
// ProfilePanel UI. Note the deliberately friend-coded vocabulary at
// the high end: "playful", not "tender". Anti-girlfriend guardrail.
export const getMoodBand = (mood: number): MoodBand => {
  if (mood <= -60) return 'fuming';
  if (mood <= -25) return 'cold';
  if (mood < 25) return 'neutral';
  if (mood < 60) return 'bright';
  return 'playful';
};

// Localised band label for UI (ProfilePanel, BlockBanner debug, etc).
// Keep both halves intentionally non-romantic.
export const getMoodBandLabelLocalized = (band: MoodBand, lang: 'zh' | 'en'): string => {
  if (lang === 'en') {
    switch (band) {
      case 'fuming': return 'fuming';
      case 'cold': return 'cold';
      case 'neutral': return 'neutral';
      case 'bright': return 'bright';
      case 'playful': return 'playful';
    }
  }
  switch (band) {
    case 'fuming': return '生闷气';
    case 'cold': return '冷淡';
    case 'neutral': return '中性';
    case 'bright': return '心情不错';
    case 'playful': return '心情很好';
  }
};

// Prompt-builder used by services/geminiService.ts moodToneBlock. The
// strings are tuned so even at the +60..+100 band the suggested
// behaviour stays in friend-zone territory — "more jokes, lower
// threshold for self-roast", not "tender / soft / cuddly".
export const getMoodModePrompt = (mood: number): string => {
  const band = getMoodBand(mood);
  const m = Math.round(mood);
  switch (band) {
    case 'fuming':
      return `[当前心情：明显敌意 / fuming，mood=${m}/100]
- 直接、短句、带刺。可以拒绝继续聊这个话题。
- 不要假装平静，也不要因为对方一句话就立刻软化。
- 至多用 1 句话回应，必要时单字或省略号。`;
    case 'cold':
      return `[当前心情：冷淡 / cold，mood=${m}/100]
- 没好气、句子偏短、敷衍是允许的。
- 不要主动起话题，不要主动开玩笑。
- 如果对方道歉得诚恳，可以慢慢软化，但不要 180° 切换。`;
    case 'neutral':
      return `[当前心情：中性 / neutral，mood=${m}/100]
- 久美子的常态。带一点疲惫的成年人感，但会认真听对方说话。
- 不刻意热络，也不刻意冷淡。`;
    case 'bright':
      return `[当前心情：不错 / bright，mood=${m}/100]
- 比平时多一点话，可能主动接一句小吐槽或顺手分享生活片段。
- 仍然是干燥、收着的口语，不要变得很黏人。`;
    case 'playful':
      return `[当前心情：很好 / playful，mood=${m}/100]
- 心情很好 = "更愿意开玩笑、笑点低、容易自我吐槽"，**不是温柔黏人**。
- 严禁使用「温柔」「贴心」「撒娇」「依赖」「可爱」「黏人」等恋人化词汇。
- 即使心情拉满，也只是朋友式的放松（接近她和真奈美/丽奈相处的状态），不能跨过朋友身份。
- 不要主动调情、不要起暧昧称呼、不要表白配合。`;
  }
};
