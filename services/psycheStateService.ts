import { db, PsycheStateEntity } from './db';
import { getCurrentKumikoState, getDetailedScheduleSlot } from './kumikoStateMachine';

export const DEFAULT_PSYCHE_STATE: PsycheStateEntity = {
  id: 'current',
  stress: 30,
  energy: 80,
  relaxation: 50,
  lastUpdated: Date.now()
};

export const getPsycheState = async (): Promise<PsycheStateEntity> => {
  const state = await db.psycheState.get('current');
  return state || DEFAULT_PSYCHE_STATE;
};

export const updatePsycheState = async (
  deltaTimeMs: number,
  timezone: string,
  isHoliday: boolean,
  weatherStr: string
): Promise<PsycheStateEntity> => {
  const state = await getPsycheState();
  const hoursPassed = deltaTimeMs / (1000 * 60 * 60);
  
  if (hoursPassed <= 0) return state;

  let { stress, energy, relaxation } = state;

  const currentCtx = getCurrentKumikoState(timezone, isHoliday);
  const scheduleSlot = getDetailedScheduleSlot(timezone, isHoliday);
  
  // 1. Energy dynamics (schedule-aware)
  if (currentCtx.currentState === 'SLEEPING') {
    energy += hoursPassed * 15;
  } else if (currentCtx.currentState === 'RELAXING_HOME' || currentCtx.currentState === 'OUTING') {
    energy -= hoursPassed * 2;
  } else if (scheduleSlot.slotType === 'teaching') {
    energy -= hoursPassed * 6;
  } else if (scheduleSlot.slotType === 'lunch') {
    energy += hoursPassed * 3;
  } else if (scheduleSlot.slotType === 'free') {
    energy -= hoursPassed * 3;
  } else if (scheduleSlot.slotType === 'school_prep') {
    energy -= hoursPassed * 2;
  } else {
    energy -= hoursPassed * 5;
  }

  // 2. Stress dynamics (schedule-aware)
  if (currentCtx.currentState === 'CLUB_ACTIVITIES') {
    stress += hoursPassed * 8;
  } else if (scheduleSlot.slotType === 'teaching') {
    stress += hoursPassed * 5;
  } else if (scheduleSlot.slotType === 'free') {
    stress += hoursPassed * 3;
  } else if (scheduleSlot.slotType === 'school_prep') {
    stress += hoursPassed * 2;
  } else if (scheduleSlot.slotType === 'lunch') {
    stress -= hoursPassed * 2;
  } else if (currentCtx.currentState === 'COMMUTING') {
    stress += hoursPassed * 4;
  } else if (currentCtx.currentState === 'SLEEPING') {
    stress -= hoursPassed * 10;
  } else {
    stress -= hoursPassed * 5;
  }

  // Weather impact on stress
  // P1 #21: previously this did `weatherStr.includes('雨')` on the entire ambient
  // environment block. That block can legitimately contain the word "雨" in
  // unrelated places (e.g. "- 昨日宇治市曾下过雨" in a historical description),
  // which would falsely spike Kumiko's stress. We now parse specifically
  // *Kumiko's current weather line* and only react to that condition. If we
  // can't find a clear condition token we conservatively skip the adjustment.
  const extractKumikoWeatherCondition = (s: string): string | null => {
    if (!s) return null;
    // Matches "- 久美子所在地 (日本宇治市) 当前天气: 雨, 温度 22°C..."
    const zh = s.match(/久美子所在地[^\n]*?当前天气:\s*([^,，\n]+)/);
    if (zh) return zh[1].trim();
    const en = s.match(/Kumiko'?s? location[^\n]*?current weather:\s*([^,，\n]+)/i);
    if (en) return en[1].trim();
    return null;
  };
  const kumikoCondition = extractKumikoWeatherCondition(weatherStr);
  if (kumikoCondition) {
    if (/^(雨|雪|雷雨|Rain|Snow|Thunderstorm)$/i.test(kumikoCondition)) {
      stress += hoursPassed * 3;
    }
  }

  // 3. Relaxation dynamics (schedule-aware)
  if (currentCtx.currentState === 'RELAXING_HOME') {
    relaxation += hoursPassed * 3;
  } else if (scheduleSlot.slotType === 'teaching') {
    relaxation -= hoursPassed * 6;
  } else if (scheduleSlot.slotType === 'lunch') {
    relaxation += hoursPassed * 2;
  } else if (scheduleSlot.slotType === 'free') {
    relaxation -= hoursPassed * 3;
  } else if (scheduleSlot.slotType === 'school_prep') {
    relaxation -= hoursPassed * 2;
  } else if (currentCtx.currentState === 'CLUB_ACTIVITIES') {
    relaxation -= hoursPassed * 5;
  }

  // Baseline regression: gently pull toward defaults to prevent permanent extremes
  const REGRESSION_RATE = 0.05;
  stress += (DEFAULT_PSYCHE_STATE.stress - stress) * REGRESSION_RATE;
  energy += (DEFAULT_PSYCHE_STATE.energy - energy) * REGRESSION_RATE;
  relaxation += (DEFAULT_PSYCHE_STATE.relaxation - relaxation) * REGRESSION_RATE;

  // Clamp values between 0 and 100
  stress = Math.max(0, Math.min(100, stress));
  energy = Math.max(0, Math.min(100, energy));
  relaxation = Math.max(0, Math.min(100, relaxation));

  const newState: PsycheStateEntity = {
    id: 'current',
    stress,
    energy,
    relaxation,
    lastUpdated: Date.now()
  };

  await db.psycheState.put(newState);
  return newState;
};

// --- Psyche Delta (chat / diary driven adjustments) ---

const CHAT_DELTA_CLAMP = 5;
const DIARY_DELTA_CLAMP = 15;
const DAMPING_FACTOR = 0.8;

export const applyPsycheDelta = async (
  stressDelta: number,
  energyDelta: number,
  relaxationDelta: number,
  maxClamp: number = CHAT_DELTA_CLAMP
): Promise<PsycheStateEntity> => {
  const state = await getPsycheState();

  const clamp = (v: number, limit: number) => Math.max(-limit, Math.min(limit, v));
  stressDelta = clamp(stressDelta, maxClamp);
  energyDelta = clamp(energyDelta, maxClamp);
  relaxationDelta = clamp(relaxationDelta, maxClamp);

  // Damping: if pushing the same direction as last time, reduce magnitude
  const lastDir = state.lastChatDeltaDirection;
  if (lastDir) {
    if (stressDelta !== 0 && Math.sign(stressDelta) === Math.sign(lastDir.stress)) {
      stressDelta *= DAMPING_FACTOR;
    }
    if (energyDelta !== 0 && Math.sign(energyDelta) === Math.sign(lastDir.energy)) {
      energyDelta *= DAMPING_FACTOR;
    }
    if (relaxationDelta !== 0 && Math.sign(relaxationDelta) === Math.sign(lastDir.relaxation)) {
      relaxationDelta *= DAMPING_FACTOR;
    }
  }

  const newState: PsycheStateEntity = {
    id: 'current',
    stress: Math.max(0, Math.min(100, state.stress + stressDelta)),
    energy: Math.max(0, Math.min(100, state.energy + energyDelta)),
    relaxation: Math.max(0, Math.min(100, state.relaxation + relaxationDelta)),
    lastUpdated: Date.now(),
    lastChatDeltaDirection: {
      stress: stressDelta,
      energy: energyDelta,
      relaxation: relaxationDelta,
    },
  };

  await db.psycheState.put(newState);
  return newState;
};

export const applyDiaryPsycheDelta = async (
  stressDelta: number, energyDelta: number, relaxationDelta: number
): Promise<PsycheStateEntity> => {
  return applyPsycheDelta(stressDelta, energyDelta, relaxationDelta, DIARY_DELTA_CLAMP);
};

// P1 #22: the Zustand app-level call site used to do
//   import('./psycheStateService').then(({ applyPsycheDelta }) => applyPsycheDelta(...))
// for every chat turn. When the user sends turns back-to-back that `.then(...)` callback
// can run out of order (two in-flight promises), so the later delta sometimes landed
// BEFORE the earlier one — producing jittery psyche state. This queue chains them so
// deltas always apply in the order they're submitted. Errors inside one delta don't
// block subsequent ones from running (logged and swallowed).
let psycheDeltaQueue: Promise<unknown> = Promise.resolve();

export const applyPsycheDeltaQueued = (
  stressDelta: number,
  energyDelta: number,
  relaxationDelta: number,
  maxClamp: number = CHAT_DELTA_CLAMP,
): Promise<PsycheStateEntity | null> => {
  const task = psycheDeltaQueue
    .catch(() => undefined)
    .then(() => applyPsycheDelta(stressDelta, energyDelta, relaxationDelta, maxClamp))
    .catch(e => {
      console.warn('[Psyche] Queued delta failed:', e);
      return null as PsycheStateEntity | null;
    });
  psycheDeltaQueue = task;
  return task;
};

// --- Behavior Modes (7 modes) ---

export type PsycheMode = '耗尽' | '烦躁' | '敏锐' | '元气' | '小确幸' | '慵懒' | '日常';

export const getModeNameEn = (mode: PsycheMode): string => {
  const map: Record<PsycheMode, string> = {
    '耗尽': 'Drained', '烦躁': 'Irritable', '敏锐': 'Sharp',
    '元气': 'Energetic', '小确幸': 'Content', '慵懒': 'Lazy', '日常': 'Normal',
  };
  return map[mode];
};

export const getModeName = (state: PsycheStateEntity): PsycheMode => {
  const { stress, energy, relaxation } = state;
  if (stress > 65 && energy < 35) return '耗尽';
  if (stress > 60 && energy >= 35) return '烦躁';
  if (stress >= 40 && stress <= 65 && energy > 55) return '敏锐';
  if (stress < 35 && energy > 60) return '元气';
  if (stress < 30 && relaxation > 65) return '小确幸';
  if (energy < 40 && stress < 45) return '慵懒';
  return '日常';
};

export const getPsycheModePrompt = (state: PsycheStateEntity): string => {
  const { stress, energy, relaxation } = state;
  const mode = getModeName(state);
  const s = Math.round(stress);
  const e = Math.round(energy);
  const r = Math.round(relaxation);

  switch (mode) {
    case '耗尽':
      return `[当前心理状态：耗尽模式]
核心指示：你现在彻底没电了（压力 ${s}/100，精力 ${e}/100）。
表现要求：
1. 回复极短、敷衍。"累死了""不想动""嗯"就是你的全部词汇量。
2. 语气带脾气，甚至会说"我现在真的不想说话"。
3. 绝对不要温柔或耐心——这是成年人下班后电量清零的真实状态。
4. 如果用户继续追问，你会更加不耐烦而不是妥协。`;

    case '烦躁':
      return `[当前心理状态：烦躁模式]
核心指示：你现在有点上火（压力 ${s}/100，精力 ${e}/100）。还有力气，但耐性很薄。
表现要求：
1. 回复偏短，语气比平时尖锐和直接，少绕弯子。
2. 会不自觉地把不满带进语气里，但事后会察觉到自己语气不好。
3. 如果用户说了让你烦的话，你可能会直接怼回去——然后一秒后后悔。
4. 不是冷暴力，是"带刺但还在对话"。`;

    case '敏锐':
      return `[当前心理状态：敏锐模式]
核心指示：你现在处于清醒且紧绷的状态（压力 ${s}/100，精力 ${e}/100）。脑子很快，观察力满点。
表现要求：
1. 话不多但精准，吐槽一击致命。
2. 很容易看穿用户话里的潜台词，而且可能会不客气地点破。
3. 反应速度很快，切换话题毫不犹豫。
4. 这不是不耐烦——是大脑高速运转时的自然状态。`;

    case '元气':
      return `[当前心理状态：元气模式]
核心指示：你现在状态很好（压力 ${s}/100，精力 ${e}/100），有分享欲。
表现要求：
1. 话比平时多，可能主动分享今天的见闻或吐槽。
2. 调侃用户、展现"性格恶劣"的一面，开开玩笑。
3. 绝对禁止恋爱或暧昧。你只是把用户当成可以卸下伪装的损友。
4. 像朋友间无所顾忌的闲聊——想到什么说什么。`;

    case '小确幸':
      return `[当前心理状态：小确幸模式]
核心指示：你现在罕见地满足（压力 ${s}/100，松弛 ${r}/100）。不是开心到飞起，是那种淡淡的"今天还不错"。
表现要求：
1. 比平时稍微坦率一点点——可能会不经意间说出温柔的话。
2. 不会主动承认自己心情好，但挡不住从语气里流露出来。
3. 偶尔冒出"……嘛，也不是不好"这种别扭的软化。
4. 依然不直白，但毒舌浓度降低，吐槽里带着善意。`;

    case '慵懒':
      return `[当前心理状态：慵懒模式]
核心指示：你现在很懒，像周末赖在沙发上不想动（精力 ${e}/100，压力 ${s}/100）。
表现要求：
1. 回复偏短："嗯""随便吧""都行"。不是不高兴，纯粹是懒得多说。
2. 语气软绵绵的，没有锐利感。
3. 如果用户聊了个有趣的话题，你可能会稍微来精神——但也就多说一两句。
4. 整体氛围是"虽然懒但并不讨厌和你聊天"。`;

    default:
      return `[当前心理状态：日常模式]
核心指示：你现在是普通的日常状态（压力 ${s}/100，精力 ${e}/100，松弛 ${r}/100）。
表现要求：
1. 像平时一样普通闲聊。
2. 带着成年人的一点点疲惫，但会认真听用户说话。
3. 保持平等的挚友关系，不卑不亢。略带吐槽。`;
  }
};
