export type KumikoState = 'TEACHING' | 'CLUB_ACTIVITIES' | 'COMMUTING' | 'RELAXING_HOME' | 'SLEEPING' | 'OUTING';

export interface StateContext {
  currentState: KumikoState;
  stateDescription: string;
  canUseVoice: boolean;
  proactiveProbability: number;
}

export const getCurrentKumikoState = (timezone: string = 'Asia/Tokyo'): StateContext => {
  const nowJST = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
  const hour = nowJST.getHours();
  const day = nowJST.getDay(); // 0 = Sunday, 1-5 = Weekday, 6 = Saturday

  const isWeekend = day === 0 || day === 6;

  if (isWeekend) {
    if (hour >= 0 && hour < 8) {
      return {
        currentState: 'SLEEPING',
        stateDescription: '正在睡觉 (周末早晨)',
        canUseVoice: false,
        proactiveProbability: 0.01
      };
    } else if (hour >= 8 && hour < 18) {
      return {
        currentState: 'OUTING',
        stateDescription: '周末休息/外出中',
        canUseVoice: true,
        proactiveProbability: 0.3
      };
    } else {
      return {
        currentState: 'RELAXING_HOME',
        stateDescription: '在家休息 (周末晚上)',
        canUseVoice: true,
        proactiveProbability: 0.4
      };
    }
  }

  // Weekdays
  if (hour >= 0 && hour < 6) {
    return {
      currentState: 'SLEEPING',
      stateDescription: '正在睡觉',
      canUseVoice: false,
      proactiveProbability: 0.01
    };
  } else if (hour >= 6 && hour < 8) {
    return {
      currentState: 'COMMUTING',
      stateDescription: '早晨通勤中',
      canUseVoice: false,
      proactiveProbability: 0.1
    };
  } else if (hour >= 8 && hour < 16) {
    return {
      currentState: 'TEACHING',
      stateDescription: '在学校上课/备课',
      canUseVoice: false,
      proactiveProbability: 0.05
    };
  } else if (hour >= 16 && hour < 19) {
    return {
      currentState: 'CLUB_ACTIVITIES',
      stateDescription: '吹奏乐部指导中',
      canUseVoice: false, // Too noisy/busy for voice
      proactiveProbability: 0.15
    };
  } else if (hour >= 19 && hour < 20) {
    return {
      currentState: 'COMMUTING',
      stateDescription: '傍晚通勤回家',
      canUseVoice: false,
      proactiveProbability: 0.2
    };
  } else {
    return {
      currentState: 'RELAXING_HOME',
      stateDescription: '在家休息/批改作业',
      canUseVoice: true,
      proactiveProbability: 0.35
    };
  }
};
