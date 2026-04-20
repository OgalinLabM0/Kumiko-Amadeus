import { useEffect } from 'react';
import { UI_TRANSLATIONS } from '../constants';
import type { Language, LocationConfig } from '../types';

type FlowState = 'INTRO' | 'AUTH' | 'CONFIG' | 'APP';

const ACTIVITY_MAP: Record<string, [string, string]> = {
  '批改1年级作文': ['批改1年级作文', 'Grading Year 1 essays'],
  '备课/打印下午讲义': ['备课/打印讲义', 'Lesson prep / printing'],
  '教材制作/打印プリント': ['教材制作/打印', 'Making handouts'],
  '学生面谈（进路相谈）': ['学生面谈', 'Student counseling'],
  '学年会议': ['学年会议', 'Faculty meeting'],
  '批改3年级小論文': ['批改3年级小论文', 'Grading Year 3 essays'],
  '校务（成绩输入/出欠确认）': ['校务处理', 'Admin duties'],
  '备课/教研准备': ['备课/教研准备', 'Lesson prep'],
  '教研（同僚と授業検討）': ['教研讨论', 'Teaching seminar'],
  '批改小論文反馈': ['批改小论文', 'Grading essays'],
  '3年级进路指导面谈': ['进路指导面谈', 'Career counseling'],
  '部活准备/资料整理': ['部活准备/资料整理', 'Club prep / filing'],
  '批改作业、学生面谈': ['批改作业/学生面谈', 'Grading / student meetings'],
  '批改/备课、会议延长': ['批改/备课', 'Grading / prep'],
  '吹奏乐部副顾问事务': ['吹奏部副顾问事务', 'Band club duties'],
  '批改/家长联络': ['批改/家长联络', 'Grading / parent contact'],
  '吹奏乐部指导（~18:30）': ['吹奏部指导', 'Band club (~18:30)'],
  '出勤准备（打印讲义、检查缺席联络）': ['出勤准备', 'Attendance prep'],
  '朝会时间（非班主任日，在办公室准备）': ['办公室准备', 'Office prep'],
  '办公室事务': ['办公室事务', 'Office work'],
};

const SUBJECT_MAP: Record<string, [string, string]> = {
  '国語総合': ['国语综合', 'Japanese (General)'],
  '現代文B': ['现代文B', 'Modern Literature B'],
  '古典B': ['古典B', 'Classics B'],
  '小論文指導': ['小论文指导', 'Essay Writing'],
};

const CLASS_MAP: Record<string, [string, string]> = {
  '1年A組': ['1年A组', '1-A'],
  '1年B組': ['1年B组', '1-B'],
  '1年C組': ['1年C组', '1-C'],
  '2年A組': ['2年A组', '2-A'],
  '2年B組': ['2年B组', '2-B'],
  '2年D組': ['2年D组', '2-D'],
  '3年C組': ['3年C组', '3-C'],
  '3年E組': ['3年E组', '3-E'],
  '3年F組': ['3年F组', '3-F'],
};

const PREP_LABELS: Record<string, [string, string]> = {
  staff_prep: ['新学年教职员准备', 'Staff Prep'],
  shigyoushiki: ['始业式（开学典礼）', 'Opening Ceremony'],
  transition: ['学年过渡日', 'Transition Day'],
  nyuugakushiki: ['入学式', 'Entrance Ceremony'],
  class_prep: ['授业准备（座席调整）', 'Class Preparation'],
  term_ceremony: ['学期始业式', 'Term Ceremony'],
};

interface UseKumikoStatusLineParams {
  flowState: FlowState;
  locationConfig: LocationConfig;
  language: Language;
  setStatusText: (text: string) => void;
}

export const useKumikoStatusLine = ({
  flowState,
  locationConfig,
  language,
  setStatusText,
}: UseKumikoStatusLineParams): void => {
  const t = UI_TRANSLATIONS[language];

  useEffect(() => {
      const updateStatus = async () => {
          if (flowState !== 'APP') return;
          try {
              if (!locationConfig || !locationConfig.modelTimezone) {
                  throw new Error("Invalid Location Config");
              }

              const isZh = language === 'zh';
              const { getDetailedScheduleSlot: getSlotForStatus } = await import('../services/kumikoStateMachine');
              const slot = getSlotForStatus(locationConfig.modelTimezone, false);

              const prefix = isZh ? '状态：' : 'STATUS: ';
              const localizeActivity = (raw: string) => {
                const m = ACTIVITY_MAP[raw];
                return m ? (isZh ? m[0] : m[1]) : raw;
              };
              const localizeSubject = (raw: string) => {
                const m = SUBJECT_MAP[raw];
                return m ? (isZh ? m[0] : m[1]) : raw;
              };
              const localizeClass = (raw: string) => {
                const m = CLASS_MAP[raw];
                return m ? (isZh ? m[0] : m[1]) : raw;
              };
              let text = '';
              switch (slot.slotType) {
                  case 'drowsy':
                      text = prefix + (isZh ? '犯困中...' : 'DROWSY...');
                      break;
                  case 'sleeping':
                      text = prefix + (isZh ? '睡眠模式 (勿扰)' : 'SLEEP MODE (DND)');
                      break;
                  case 'commuting':
                      text = prefix + (isZh ? '通勤中' : 'COMMUTING');
                      break;
                  case 'shr':
                      text = prefix + (isZh ? 'SHR朝会' : 'SHR HOMEROOM');
                      break;
                  case 'teaching': {
                      const cls = slot.classGroup ? localizeClass(slot.classGroup) : '';
                      const sub = slot.subject ? localizeSubject(slot.subject) : '';
                      const detail = cls ? ` — ${cls} ${sub}` : '';
                      text = isZh
                          ? `${prefix}${slot.periodNumber ? `第${slot.periodNumber}校时` : '上课中'}${detail}`
                          : `${prefix}${slot.periodNumber ? `P${slot.periodNumber} IN CLASS` : 'IN CLASS'}${detail}`;
                      break;
                  }
                  case 'free': {
                      const act = slot.freeActivity ? localizeActivity(slot.freeActivity) : '';
                      text = isZh
                          ? `${prefix}空档${act ? ` — ${act}` : '（办公室）'}`
                          : `${prefix}FREE${act ? ` — ${act}` : ' (OFFICE)'}`;
                      break;
                  }
                  case 'lunch':
                      text = prefix + (isZh ? '午休中' : 'LUNCH BREAK');
                      break;
                  case 'cleaning':
                      text = prefix + (isZh ? '归宅SHR/清扫' : 'CLEANUP');
                      break;
                  case 'after_school': {
                      const aa = slot.freeActivity ? localizeActivity(slot.freeActivity) : '';
                      text = isZh
                          ? `${prefix}放课后${aa ? ` — ${aa}` : ''}`
                          : `${prefix}AFTER SCHOOL${aa ? ` — ${aa}` : ''}`;
                      break;
                  }
                  case 'school_prep': {
                      const label = PREP_LABELS[slot.prepPhaseKey || ''];
                      const desc = label ? (isZh ? label[0] : label[1]) : (isZh ? '学校准备日' : 'School Prep');
                      text = `${prefix}${desc}`;
                      break;
                  }
                  default:
                      text = prefix + (isZh ? '在线' : 'ONLINE');
              }
              setStatusText(text);
          } catch(e) {
              console.error("Status Update Failed", e);
              setStatusText(t.signalConnected);
          }
      };

      updateStatus();
      const timer = setInterval(updateStatus, 60000);
      return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- preserve original deps (setStatusText from Zustand is stable)
  }, [flowState, locationConfig, language, t.signalConnected]);
};
