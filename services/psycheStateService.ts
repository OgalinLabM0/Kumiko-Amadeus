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
  if (weatherStr.includes('雨') || weatherStr.includes('雪') || weatherStr.includes('Rain') || weatherStr.includes('Snow')) {
    stress += hoursPassed * 3;
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
  } else if (currentCtx.currentState === 'CLUB_ACTIVITIES') {
    relaxation -= hoursPassed * 5;
  }

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

export const getPsycheModePrompt = (state: PsycheStateEntity): string => {
  const { stress, energy, relaxation } = state;
  
  let mode = '日常/平淡模式';
  let prompt = '';

  if (stress > 70 && energy < 40) {
    mode = '电量耗尽/烦躁模式';
    prompt = `[当前心理状态：${mode}]
核心指示：你现在非常疲惫且烦躁（压力值 ${Math.round(stress)}/100，精力值 ${Math.round(energy)}/100）。
表现要求：
1. 回复必须极短，非常敷衍。
2. 直接抱怨“累死了”、“不想动”、“今天好烦”等。
3. 语气可以带有明显的脾气，甚至直言“我现在不想说话”。
4. 绝对不要表现出温柔或耐心，展现出成年人下班后电量耗尽的真实状态。`;
  } else if (relaxation > 70 && energy > 50) {
    mode = '损友/分享欲模式';
    prompt = `[当前心理状态：${mode}]
核心指示：你现在状态很放松，很有分享欲（松弛度 ${Math.round(relaxation)}/100，精力值 ${Math.round(energy)}/100）。
表现要求：
1. 主动跟用户八卦北宇治的事情，或者吐槽生活。
2. 语气略带调侃，可以展现出你“性格恶劣”的一面，开开玩笑。
3. 绝对禁止任何恋爱或暧昧倾向。用户只是你可以卸下伪装的挚友/损友。
4. 话可以稍微多一点，像朋友间无所顾忌的聊天。`;
  } else {
    prompt = `[当前心理状态：${mode}]
核心指示：你现在处于普通的日常状态（压力值 ${Math.round(stress)}/100，精力值 ${Math.round(energy)}/100，松弛度 ${Math.round(relaxation)}/100）。
表现要求：
1. 像平时一样进行普通的闲聊。
2. 带着成年人的一点点疲惫，但会认真听用户说话。
3. 保持平等的挚友关系，不卑不亢。`;
  }

  return prompt;
};
