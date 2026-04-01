export type KumikoState = 'TEACHING' | 'CLUB_ACTIVITIES' | 'COMMUTING' | 'RELAXING_HOME' | 'SLEEPING' | 'OUTING';
export type VoicePolicy = 'allow' | 'discourage' | 'forbid';

export interface StateContext {
  currentState: KumikoState;
  stateDescription: string;
  canUseVoice: boolean;
  voicePolicy: VoicePolicy;
  proactiveProbability: number;
}

export const getSchoolTermContext = (dateStr: string): string => {
  const parts = dateStr.split('-');
  if (parts.length < 3) return '';
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  
  const md = month * 100 + day;
  
  if (md >= 401 && md <= 720) {
    return "第一学期（正常上课期间，4月初有开学典礼/入学典礼）";
  } else if (md >= 721 && md <= 831) {
    return "暑假期间（无需日常上课，但可能因社团指导或值班偶尔去学校）";
  } else if (md >= 901 && md <= 1224) {
    return "第二学期（正常上课期间，秋季可能有体育大会/学园祭）";
  } else if (md >= 1225 || md <= 110) {
    return "寒假期间（无需日常上课。12月25日是圣诞节，1月1日是日本新年，学校基本放假）";
  } else if (md >= 111 && md <= 310) {
    return "第三学期（正常上课期间，学期较短，3月初有期末考试和结业典礼）";
  } else if (md >= 311 && md <= 331) {
    return "春假期间（无需日常上课，学年交替期）";
  }
  return "";
};

export const getCurrentKumikoState = (timezone: string = 'Asia/Tokyo', isHoliday: boolean = false): StateContext => {
  const nowJST = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
  const hour = nowJST.getHours();
  const minute = nowJST.getMinutes();
  const minutesOfDay = hour * 60 + minute;
  const day = nowJST.getDay(); // 0 = Sunday, 1-5 = Weekday, 6 = Saturday

  const isWeekendOrHoliday = day === 0 || day === 6 || isHoliday;

  if (isWeekendOrHoliday) {
    if (minutesOfDay >= 0 && minutesOfDay < 8 * 60) {
      return {
        currentState: 'SLEEPING',
        stateDescription: isHoliday ? '正在睡觉 (节假日早晨)' : '正在睡觉 (周末早晨)',
        canUseVoice: false,
        voicePolicy: 'forbid',
        proactiveProbability: 0.01
      };
    } else if (minutesOfDay >= 8 * 60 && minutesOfDay < 18 * 60) {
      return {
        currentState: 'OUTING',
        stateDescription: isHoliday ? '节假日休息/外出中' : '周末休息/外出中',
        canUseVoice: true,
        voicePolicy: 'allow',
        proactiveProbability: 0.3
      };
    } else {
      return {
        currentState: 'RELAXING_HOME',
        stateDescription: isHoliday ? '在家休息 (节假日晚上)' : '在家休息 (周末晚上)',
        canUseVoice: true,
        voicePolicy: 'allow',
        proactiveProbability: 0.4
      };
    }
  }

  // Weekdays
  if (minutesOfDay >= 0 && minutesOfDay < 6 * 60) {
    return {
      currentState: 'SLEEPING',
      stateDescription: '正在睡觉',
      canUseVoice: false,
      voicePolicy: 'forbid',
      proactiveProbability: 0.01
    };
  } else if (minutesOfDay >= 6 * 60 && minutesOfDay < 8 * 60) {
    return {
      currentState: 'COMMUTING',
      stateDescription: '早晨通勤中',
      canUseVoice: false,
      voicePolicy: 'discourage',
      proactiveProbability: 0.1
    };
  } else if (minutesOfDay >= 8 * 60 && minutesOfDay < 12 * 60 + 10) {
    return {
      currentState: 'TEACHING',
      stateDescription: '在学校上国语课/备课',
      canUseVoice: false,
      voicePolicy: 'discourage',
      proactiveProbability: 0.05
    };
  } else if (minutesOfDay >= 12 * 60 + 10 && minutesOfDay < 13 * 60) {
    return {
      currentState: 'TEACHING',
      stateDescription: '午休/午餐时间（在学校）',
      canUseVoice: false,
      voicePolicy: 'discourage',
      proactiveProbability: 0.18
    };
  } else if (minutesOfDay >= 13 * 60 && minutesOfDay < 16 * 60) {
    return {
      currentState: 'TEACHING',
      stateDescription: '下午上课/备课中',
      canUseVoice: false,
      voicePolicy: 'discourage',
      proactiveProbability: 0.05
    };
  } else if (minutesOfDay >= 16 * 60 && minutesOfDay < 19 * 60) {
    return {
      currentState: 'CLUB_ACTIVITIES',
      stateDescription: '放学后留校处理副顾问事务/校务',
      canUseVoice: false, // Too noisy/busy for voice
      voicePolicy: 'discourage',
      proactiveProbability: 0.15
    };
  } else if (minutesOfDay >= 19 * 60 && minutesOfDay < 20 * 60) {
    return {
      currentState: 'COMMUTING',
      stateDescription: '傍晚通勤回家',
      canUseVoice: false,
      voicePolicy: 'discourage',
      proactiveProbability: 0.2
    };
  } else {
    return {
      currentState: 'RELAXING_HOME',
      stateDescription: '在家休息/备课或批改作文',
      canUseVoice: true,
      voicePolicy: 'allow',
      proactiveProbability: 0.35
    };
  }
};
