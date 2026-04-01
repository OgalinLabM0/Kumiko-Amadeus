export type KumikoState = 'TEACHING' | 'CLUB_ACTIVITIES' | 'COMMUTING' | 'RELAXING_HOME' | 'SLEEPING' | 'OUTING';
export type VoicePolicy = 'allow' | 'discourage' | 'forbid';

export interface StateContext {
  currentState: KumikoState;
  stateDescription: string;
  canUseVoice: boolean;
  voicePolicy: VoicePolicy;
  proactiveProbability: number;
}

// ---------------------------------------------------------------------------
// 1. School period time definitions (Todō High School / Kitauji standard)
// ---------------------------------------------------------------------------

export type ScheduleSlotType =
  | 'teaching' | 'free' | 'shr' | 'lunch'
  | 'cleaning' | 'after_school' | 'commuting' | 'home' | 'sleeping';

export interface DetailedScheduleSlot {
  slotType: ScheduleSlotType;
  classGroup?: string;
  subject?: string;
  currentUnit?: string;
  freeActivity?: string;
  periodNumber?: number;
  description: string;
  canChat: boolean;
  interceptChance: number;
}

interface PeriodTimeDef {
  id: string;
  label: string;
  startMinute: number;
  endMinute: number;
}

const PERIOD_TIMES: PeriodTimeDef[] = [
  { id: 'shr_morning',  label: 'SHR（朝会）',   startMinute: 8 * 60 + 30,  endMinute: 8 * 60 + 40 },
  { id: 'p1',           label: '第1校时',        startMinute: 8 * 60 + 45,  endMinute: 9 * 60 + 35 },
  { id: 'p2',           label: '第2校时',        startMinute: 9 * 60 + 45,  endMinute: 10 * 60 + 35 },
  { id: 'p3',           label: '第3校时',        startMinute: 10 * 60 + 45, endMinute: 11 * 60 + 35 },
  { id: 'p4',           label: '第4校时',        startMinute: 11 * 60 + 45, endMinute: 12 * 60 + 35 },
  { id: 'lunch',        label: '午休',           startMinute: 12 * 60 + 35, endMinute: 13 * 60 + 20 },
  { id: 'p5',           label: '第5校时',        startMinute: 13 * 60 + 20, endMinute: 14 * 60 + 10 },
  { id: 'p6',           label: '第6校时',        startMinute: 14 * 60 + 20, endMinute: 15 * 60 + 10 },
  { id: 'shr_evening',  label: '归宅SHR+清扫',   startMinute: 15 * 60 + 10, endMinute: 15 * 60 + 20 },
  { id: 'after_school', label: '放课后',          startMinute: 15 * 60 + 30, endMinute: 18 * 60 + 30 },
];

const PERIOD_INDEX_MAP: Record<string, number> = { p1: 1, p2: 2, p3: 3, p4: 4, p5: 5, p6: 6 };

// ---------------------------------------------------------------------------
// 2. Weekly timetable (base year 2026)
// ---------------------------------------------------------------------------

type TimetableSlotKind = 'teaching' | 'free';

interface TimetableTeachingSlot {
  kind: 'teaching';
  classGroupKey: string;
  subjectKey: string;
}
interface TimetableFreeSlot {
  kind: 'free';
  activity: string;
}
type TimetableSlot = TimetableTeachingSlot | TimetableFreeSlot;

interface DayTimetable {
  shr: boolean;
  shrNote?: string;
  slots: Record<string, TimetableSlot>; // p1..p6
  afterSchool: string;
}

const BASE_TIMETABLE: Record<number, DayTimetable> = {
  // Monday (day=1): 4 classes
  1: {
    shr: true, shrNote: '1年A組班主任朝会',
    slots: {
      p1: { kind: 'teaching', classGroupKey: '1A', subjectKey: 'kokugo_sogo' },
      p2: { kind: 'teaching', classGroupKey: '2B', subjectKey: 'gendaibun' },
      p3: { kind: 'free',     activity: '批改1年级作文' },
      p4: { kind: 'teaching', classGroupKey: '3E', subjectKey: 'gendaibun' },
      p5: { kind: 'free',     activity: '备课/打印下午讲义' },
      p6: { kind: 'teaching', classGroupKey: '2D', subjectKey: 'koten' },
    },
    afterSchool: '批改作业、学生面谈',
  },
  // Tuesday (day=2): 3 classes
  2: {
    shr: false,
    slots: {
      p1: { kind: 'teaching', classGroupKey: '2D', subjectKey: 'koten' },
      p2: { kind: 'free',     activity: '教材制作/打印プリント' },
      p3: { kind: 'teaching', classGroupKey: '1C', subjectKey: 'kokugo_sogo' },
      p4: { kind: 'free',     activity: '学生面谈（进路相谈）' },
      p5: { kind: 'teaching', classGroupKey: '3E', subjectKey: 'gendaibun' },
      p6: { kind: 'free',     activity: '学年会议' },
    },
    afterSchool: '批改/备课、会议延长',
  },
  // Wednesday (day=3): 4 classes
  3: {
    shr: false,
    slots: {
      p1: { kind: 'teaching', classGroupKey: '1A', subjectKey: 'kokugo_sogo' },
      p2: { kind: 'teaching', classGroupKey: '3E', subjectKey: 'gendaibun' },
      p3: { kind: 'free',     activity: '批改3年级小論文' },
      p4: { kind: 'teaching', classGroupKey: '1C', subjectKey: 'kokugo_sogo' },
      p5: { kind: 'teaching', classGroupKey: '2B', subjectKey: 'gendaibun' },
      p6: { kind: 'free',     activity: '校务（成绩输入/出欠确认）' },
    },
    afterSchool: '吹奏乐部副顾问事务',
  },
  // Thursday (day=4): 4 classes
  4: {
    shr: true, shrNote: '归宅SHR+清扫监督（1年A組）',
    slots: {
      p1: { kind: 'free',     activity: '备课/教研准备' },
      p2: { kind: 'teaching', classGroupKey: '1C', subjectKey: 'kokugo_sogo' },
      p3: { kind: 'teaching', classGroupKey: '2B', subjectKey: 'gendaibun' },
      p4: { kind: 'free',     activity: '教研（同僚と授業検討）' },
      p5: { kind: 'teaching', classGroupKey: '1A', subjectKey: 'kokugo_sogo' },
      p6: { kind: 'teaching', classGroupKey: '2D', subjectKey: 'koten' },
    },
    afterSchool: '批改/家长联络',
  },
  // Friday (day=5): 3 classes
  5: {
    shr: false,
    slots: {
      p1: { kind: 'teaching', classGroupKey: '3F', subjectKey: 'shoronbun' },
      p2: { kind: 'free',     activity: '批改小論文反馈' },
      p3: { kind: 'teaching', classGroupKey: '1A', subjectKey: 'kokugo_sogo' },
      p4: { kind: 'free',     activity: '3年级进路指导面谈' },
      p5: { kind: 'teaching', classGroupKey: '1C', subjectKey: 'kokugo_sogo' },
      p6: { kind: 'free',     activity: '部活准备/资料整理' },
    },
    afterSchool: '吹奏乐部指导（~18:30）',
  },
};

// ---------------------------------------------------------------------------
// 3. Yearly assignment rotation (multi-year support)
// ---------------------------------------------------------------------------

const BASE_YEAR = 2026;

interface YearlyAssignment {
  teachingYear: number;
  homeroomClass: string;
  classGroups: Record<string, { label: string; grade: number; section: string }>;
  subjectMap: Record<string, { label: string; poolKey: string }>;
  profileNote: string;
}

export const getSchoolYear = (dateStr: string): number => {
  const parts = dateStr.split('-');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  return month >= 4 ? year : year - 1;
};

const getYearlyAssignment = (schoolYear: number): YearlyAssignment => {
  const teachingYear = schoolYear - 2024;
  const yearIndex = (schoolYear - BASE_YEAR) % 3;

  if (yearIndex === 0) {
    return {
      teachingYear,
      homeroomClass: '1年A組',
      classGroups: {
        '1A': { label: '1年A組', grade: 1, section: 'A' },
        '1C': { label: '1年C組', grade: 1, section: 'C' },
        '2B': { label: '2年B組', grade: 2, section: 'B' },
        '2D': { label: '2年D組', grade: 2, section: 'D' },
        '3E': { label: '3年E組', grade: 3, section: 'E' },
        '3F': { label: '3年F組', grade: 3, section: 'F' },
      },
      subjectMap: {
        'kokugo_sogo': { label: '国語総合', poolKey: 'nen1_kokugo' },
        'gendaibun':   { label: '現代文B',  poolKey: 'nen2_gendaibun' },
        'koten':       { label: '古典B',    poolKey: 'nen2_koten' },
        'shoronbun':   { label: '小論文指導', poolKey: 'nen3_shoronbun' },
      },
      profileNote: `教龄第${teachingYear}年，还算新人。1年A組班主任，偶尔被前辈提点。`,
    };
  } else if (yearIndex === 1) {
    return {
      teachingYear,
      homeroomClass: '2年A組',
      classGroups: {
        '1A': { label: '1年B組', grade: 1, section: 'B' },
        '1C': { label: '1年D組', grade: 1, section: 'D' },
        '2B': { label: '2年A組', grade: 2, section: 'A' },
        '2D': { label: '2年C組', grade: 2, section: 'C' },
        '3E': { label: '3年B組', grade: 3, section: 'B' },
        '3F': { label: '3年D組', grade: 3, section: 'D' },
      },
      subjectMap: {
        'kokugo_sogo': { label: '国語総合', poolKey: 'nen1_kokugo' },
        'gendaibun':   { label: '現代文B',  poolKey: 'nen2_gendaibun' },
        'koten':       { label: '古典B',    poolKey: 'nen2_koten' },
        'shoronbun':   { label: '小論文指導', poolKey: 'nen3_shoronbun' },
      },
      profileNote: `教龄第${teachingYear}年，渐入佳境。2年A組班主任，开始被安排出期末考题。`,
    };
  } else {
    return {
      teachingYear,
      homeroomClass: '3年C組',
      classGroups: {
        '1A': { label: '1年A組', grade: 1, section: 'A' },
        '1C': { label: '1年E組', grade: 1, section: 'E' },
        '2B': { label: '2年D組', grade: 2, section: 'D' },
        '2D': { label: '2年B組', grade: 2, section: 'B' },
        '3E': { label: '3年C組', grade: 3, section: 'C' },
        '3F': { label: '3年A組', grade: 3, section: 'A' },
      },
      subjectMap: {
        'kokugo_sogo': { label: '国語総合', poolKey: 'nen1_kokugo' },
        'gendaibun':   { label: '現代文B',  poolKey: 'nen2_gendaibun' },
        'koten':       { label: '古典B',    poolKey: 'nen2_koten' },
        'shoronbun':   { label: '小論文指導', poolKey: 'nen3_shoronbun' },
      },
      profileNote: `教龄第${teachingYear}年，成为可靠的中坚教师。3年C組班主任，负责升学指导。`,
    };
  }
};

// ---------------------------------------------------------------------------
// 4. Curriculum pools (large enough for 2-3 years without repetition)
// ---------------------------------------------------------------------------

interface CurriculumWork {
  title: string;
  author: string;
  note?: string;
}

const CURRICULUM_POOLS: Record<string, CurriculumWork[]> = {
  nen1_kokugo: [
    { title: '羅生門',               author: '芥川龍之介' },
    { title: '竹取物語',              author: '（古典）' },
    { title: '少年の日の思い出',       author: 'ヘルマン・ヘッセ/高橋健二訳' },
    { title: '枕草子',               author: '清少納言（古典）', note: '春はあけぼの/虫は' },
    { title: '走れメロス',            author: '太宰治' },
    { title: '徒然草',               author: '兼好法師（古典）', note: 'つれづれなるままに/仁和寺にある法師' },
    { title: '山月記',               author: '中島敦' },
    { title: '平家物語',              author: '（古典）', note: '祇園精舎/木曾の最期' },
    { title: 'こころ・序章',          author: '夏目漱石' },
    { title: '伊勢物語',              author: '（古典）', note: '初冠/筒井筒' },
    { title: '故郷',                 author: '魯迅/竹内好訳' },
    { title: '万葉集',               author: '（古典）', note: '額田王・柿本人麻呂' },
    { title: '檸檬',                 author: '梶井基次郎' },
    { title: '古今和歌集',            author: '紀貫之（古典）', note: '仮名序' },
    { title: '鼻',                   author: '芥川龍之介' },
    { title: '宇治拾遺物語',          author: '（古典）', note: '児のそら寝/絵仏師良秀' },
    { title: '高瀬舟',               author: '森鷗外' },
    { title: '大和物語',              author: '（古典）', note: '姨捨' },
    { title: '蜜柑',                 author: '芥川龍之介' },
    { title: '百人一首選',            author: '（古典）', note: '在原業平・小野小町等' },
    { title: 'トロッコ',              author: '芥川龍之介' },
    { title: '土佐日記',              author: '紀貫之（古典）', note: '門出/帰京' },
    { title: '城の崎にて',            author: '志賀直哉' },
    { title: '更級日記',              author: '菅原孝標女（古典）', note: '源氏の五十余巻' },
  ],
  nen2_gendaibun: [
    { title: '舞姫',                 author: '森鷗外' },
    { title: '檸檬',                 author: '梶井基次郎' },
    { title: '評論：日本語の特質',     author: '金田一春彦' },
    { title: '城の崎にて',            author: '志賀直哉' },
    { title: 'セメント樽の中の手紙',   author: '葉山嘉樹' },
    { title: '評論：近代化と日本',     author: '丸山真男' },
    { title: 'こころ',               author: '夏目漱石' },
    { title: '評論：水の東西',        author: '山崎正和' },
    { title: '人間失格・前半',        author: '太宰治' },
    { title: '評論：ものとことば',     author: '鈴木孝夫' },
    { title: '銀河鉄道の夜',          author: '宮沢賢治' },
    { title: '風立ちぬ',              author: '堀辰雄' },
    { title: '春と修羅',              author: '宮沢賢治（詩）' },
    { title: '智恵子抄',              author: '高村光太郎（詩）' },
    { title: '恩讐の彼方に',          author: '菊池寛' },
    { title: '斜陽',                 author: '太宰治' },
    { title: '雪国・序章',            author: '川端康成' },
    { title: '伊豆の踊子',            author: '川端康成' },
    { title: '評論：言葉と世界',      author: '外山滋比古' },
    { title: '評論：科学的思考',      author: '池内了' },
  ],
  nen2_koten: [
    { title: '源氏物語・桐壺',        author: '紫式部', note: '光源氏の誕生' },
    { title: '漢文：論語',            author: '孔子', note: '学而/為政' },
    { title: '源氏物語・若紫',        author: '紫式部' },
    { title: '大鏡',                 author: '（歴史物語）', note: '花山天皇の出家' },
    { title: '伊勢物語',              author: '（歌物語）', note: '東下り/筒井筒' },
    { title: '漢文：史記',            author: '司馬遷', note: '鴻門之会' },
    { title: '土佐日記',              author: '紀貫之', note: '門出/帰京' },
    { title: '漢文：老子/荘子選',     author: '老子・荘子' },
    { title: '更級日記',              author: '菅原孝標女', note: '源氏の五十余巻' },
    { title: '蜻蛉日記',              author: '藤原道綱母', note: 'うつろひたる菊' },
    { title: '漢文：唐詩選',          author: '李白・杜甫・王維' },
    { title: '枕草子・中級篇',        author: '清少納言', note: '中納言参りたまひて' },
    { title: '方丈記',               author: '鴨長明' },
    { title: 'おくのほそ道',          author: '松尾芭蕉' },
    { title: '源氏物語・須磨',        author: '紫式部' },
    { title: '古事記',               author: '（神話）', note: '因幡の白兎/ヤマトタケル' },
    { title: '今昔物語集',            author: '（説話集）' },
    { title: '漢文：十八史略選',      author: '曾先之' },
  ],
  nen3_gendaibun: [
    { title: '人間失格',              author: '太宰治' },
    { title: '金閣寺',               author: '三島由紀夫' },
    { title: '評論：日本文化の構造',   author: '中根千枝' },
    { title: '砂の女',               author: '安部公房' },
    { title: '雪国',                 author: '川端康成' },
    { title: '評論：近代文学と自我',   author: '小林秀雄' },
    { title: '坊っちゃん',            author: '夏目漱石' },
    { title: '暗夜行路',              author: '志賀直哉' },
    { title: '評論：ポストモダンと日本', author: '柄谷行人' },
    { title: '細雪',                 author: '谷崎潤一郎' },
    { title: '蒲団',                 author: '田山花袋' },
    { title: '入試評論文演習',        author: '（大学別傾向）' },
    { title: '小論文技法',            author: '（構成・論証・表現）' },
    { title: '現代詩選',              author: '谷川俊太郎・茨木のり子' },
    { title: '戦後文学選',            author: '遠藤周作・大江健三郎' },
    { title: '卒業前総合演習',        author: '（総復習）' },
  ],
};

const ESSAY_TOPIC_POOL: string[] = [
  'AIと社会の共存', '少子高齢化と地方', 'グローバル化の功罪', 'エネルギー問題と未来',
  'SNS依存と若者', '食品ロスと消費社会', '働き方改革の現在地', 'ジェンダー平等の課題',
  '外国人労働者と多文化共生', '地方創生の可能性', '教育格差と公平性', '医療倫理と生命',
  '防災意識と社会', '方言の消亡と文化', '祭りの意義と地域', '読書離れと情報社会',
  '伝統芸能の継承', 'アニメ文化と日本', '日本語の乱れ論争', '学校制服の是非',
  'ボランティアの意義', '図書館の未来像', '自由とは何か', '幸福の定義を問う',
  '正義と法の境界', '個人と社会の関係', '死生観を考える', '科学と倫理の対話',
  '言葉の力と責任', '差別と偏見の構造', '記憶と記録の違い', '環境と経済の両立',
  '大学志望理由書', '自己PR作成演習', 'グループディスカッション対策', '面接想定問答演習',
  '課題文型小論文実践', '要約力トレーニング', 'データ読解と論証', '反論構成の技術',
  '原稿用紙作法確認', '異文化理解と寛容', '情報リテラシーと真実', 'スポーツと社会の関係',
  '食文化と国際化', '住まいと生活様式の変化', '動物愛護と人間中心主義', 'アートと社会の接点',
  '通勤と都市設計', '睡眠と現代人の健康', '子どもの権利と教育', '宇宙開発の意義',
  '水資源と国際紛争', '核と平和の問い',
];

// Teaching stages within a unit
const TEACHING_STAGES = ['導入', '精読', '討論・発表', '感想文・小テスト'] as const;
type TeachingStage = typeof TEACHING_STAGES[number];

// ---------------------------------------------------------------------------
// 5. School term helpers
// ---------------------------------------------------------------------------

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

const isSchoolInSession = (dateStr: string): boolean => {
  const ctx = getSchoolTermContext(dateStr);
  return ctx.includes('正常上课期间');
};

const getTermIndex = (dateStr: string): number => {
  const parts = dateStr.split('-');
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  const md = month * 100 + day;
  if (md >= 401 && md <= 720) return 0;
  if (md >= 901 && md <= 1224) return 1;
  if (md >= 111 && md <= 310) return 2;
  return -1;
};

const getTermStartMd = (termIndex: number): number => {
  if (termIndex === 0) return 401;
  if (termIndex === 1) return 901;
  if (termIndex === 2) return 111;
  return 401;
};

const getWeekOfTerm = (dateStr: string): number => {
  const parts = dateStr.split('-');
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  const termIndex = getTermIndex(dateStr);
  const termStartMd = getTermStartMd(termIndex);
  const termStartMonth = Math.floor(termStartMd / 100);
  const termStartDay = termStartMd % 100;

  const year = parseInt(parts[0], 10);
  const current = new Date(year, month - 1, day);
  const termStartYear = termIndex === 2 && month >= 1 && month <= 3 ? year : year;
  const termStart = new Date(termStartYear, termStartMonth - 1, termStartDay);
  const diffDays = Math.floor((current.getTime() - termStart.getTime()) / (1000 * 60 * 60 * 24));
  return Math.max(0, Math.floor(diffDays / 7));
};

// ---------------------------------------------------------------------------
// 6. Curriculum resolution
// ---------------------------------------------------------------------------

const UNITS_PER_TERM = 4;
const WEEKS_PER_UNIT = 3;

export const getCurrentCurriculum = (poolKey: string, dateStr: string): { work: CurriculumWork; stage: TeachingStage; stageLabel: string } | null => {
  const pool = CURRICULUM_POOLS[poolKey];
  if (!pool || pool.length === 0) return null;

  const termIndex = getTermIndex(dateStr);
  if (termIndex < 0) return null;

  const schoolYear = getSchoolYear(dateStr);
  const yearOffset = ((schoolYear - BASE_YEAR) * 3 * UNITS_PER_TERM) % pool.length;
  const weekOfTerm = getWeekOfTerm(dateStr);
  const unitInTerm = Math.min(Math.floor(weekOfTerm / WEEKS_PER_UNIT), UNITS_PER_TERM - 1);
  const unitIndex = (yearOffset + termIndex * UNITS_PER_TERM + unitInTerm) % pool.length;
  const work = pool[unitIndex];

  const weekInUnit = weekOfTerm % WEEKS_PER_UNIT;
  const stageIndex = Math.min(weekInUnit, TEACHING_STAGES.length - 1);
  const stage = TEACHING_STAGES[stageIndex];

  const noteStr = work.note ? `（${work.note}）` : '';
  const stageLabel = `『${work.title}』${noteStr} — ${stage}`;

  return { work, stage, stageLabel };
};

const getEssayTopic = (dateStr: string): string => {
  const schoolYear = getSchoolYear(dateStr);
  const parts = dateStr.split('-');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  const startOfYear = new Date(year, 0, 1);
  const current = new Date(year, month - 1, day);
  const weekOfYear = Math.floor((current.getTime() - startOfYear.getTime()) / (7 * 24 * 60 * 60 * 1000));
  const yearSeed = (schoolYear - BASE_YEAR) * 17;
  const index = (yearSeed + weekOfYear) % ESSAY_TOPIC_POOL.length;
  return ESSAY_TOPIC_POOL[index];
};

// ---------------------------------------------------------------------------
// 7. Core exported functions
// ---------------------------------------------------------------------------

const formatTime = (minutes: number): string => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
};

const getJSTDateStr = (timezone: string): string => {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

export const getDetailedScheduleSlot = (timezone: string = 'Asia/Tokyo', isHoliday: boolean = false): DetailedScheduleSlot => {
  const nowJST = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
  const minutesOfDay = nowJST.getHours() * 60 + nowJST.getMinutes();
  const dayOfWeek = nowJST.getDay();
  const dateStr = getJSTDateStr(timezone);

  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const inSession = isSchoolInSession(dateStr);

  if (isWeekend || isHoliday || !inSession) {
    if (minutesOfDay < 6 * 60) {
      return { slotType: 'sleeping', description: '正在睡觉', canChat: false, interceptChance: 0 };
    } else if (minutesOfDay < 8 * 60) {
      return { slotType: 'home', description: isHoliday ? '节假日早晨，在家' : !inSession ? '假期中，在家' : '周末早晨，在家', canChat: true, interceptChance: 0 };
    } else if (minutesOfDay < 18 * 60) {
      return { slotType: 'home', description: isHoliday ? '节假日休息/外出中' : !inSession ? '假期中，自由安排' : '周末休息/外出中', canChat: true, interceptChance: 0 };
    } else if (minutesOfDay < 23 * 60) {
      return { slotType: 'home', description: '在家休息', canChat: true, interceptChance: 0 };
    } else {
      return { slotType: 'sleeping', description: '准备睡觉', canChat: false, interceptChance: 0 };
    }
  }

  // Weekday during school session
  if (minutesOfDay < 6 * 60) {
    return { slotType: 'sleeping', description: '正在睡觉', canChat: false, interceptChance: 0 };
  }
  if (minutesOfDay < 7 * 60 + 50) {
    return { slotType: 'commuting', description: '早晨通勤中（7:40左右到校）', canChat: false, interceptChance: 0 };
  }
  if (minutesOfDay < 8 * 60 + 30) {
    return { slotType: 'free', freeActivity: '出勤准备（打印讲义、检查缺席联络）', description: '到校准备中', canChat: true, interceptChance: 0 };
  }

  const daySchedule = BASE_TIMETABLE[dayOfWeek];
  if (!daySchedule) {
    return { slotType: 'home', description: '周末/无课日', canChat: true, interceptChance: 0 };
  }

  const assignment = getYearlyAssignment(getSchoolYear(dateStr));

  for (const period of PERIOD_TIMES) {
    if (minutesOfDay >= period.startMinute && minutesOfDay < period.endMinute) {
      if (period.id === 'shr_morning') {
        if (daySchedule.shr) {
          return { slotType: 'shr', description: daySchedule.shrNote || 'SHR朝会', canChat: false, interceptChance: 0.20 };
        }
        return { slotType: 'free', freeActivity: '朝会时间（非班主任日，在办公室准备）', description: '办公室准备', canChat: true, interceptChance: 0 };
      }

      if (period.id === 'lunch') {
        return { slotType: 'lunch', description: '午休/午餐时间（在办公室座位上吃便当）', canChat: true, interceptChance: 0 };
      }

      if (period.id === 'shr_evening') {
        if (daySchedule.shr && daySchedule.shrNote?.includes('归宅')) {
          return { slotType: 'shr', description: '归宅SHR+清扫监督', canChat: false, interceptChance: 0.20 };
        }
        return { slotType: 'cleaning', description: '归宅时间/清扫', canChat: true, interceptChance: 0 };
      }

      if (period.id === 'after_school') {
        return { slotType: 'after_school', freeActivity: daySchedule.afterSchool, description: `放课后：${daySchedule.afterSchool}`, canChat: true, interceptChance: 0.05 };
      }

      const slotKey = period.id;
      const timetableSlot = daySchedule.slots[slotKey];
      if (!timetableSlot) {
        return { slotType: 'free', freeActivity: '办公室事务', description: '在办公室', canChat: true, interceptChance: 0 };
      }

      const periodNum = PERIOD_INDEX_MAP[slotKey] || 0;
      const timeRange = `${formatTime(period.startMinute)}-${formatTime(period.endMinute)}`;

      if (timetableSlot.kind === 'teaching') {
        const cg = assignment.classGroups[timetableSlot.classGroupKey];
        const sub = assignment.subjectMap[timetableSlot.subjectKey];
        if (!cg || !sub) {
          return { slotType: 'teaching', periodNumber: periodNum, description: `第${periodNum}校时 上课中`, canChat: false, interceptChance: 0.40 };
        }

        let unitLabel = '';
        if (timetableSlot.subjectKey === 'shoronbun') {
          unitLabel = `小論文テーマ：${getEssayTopic(dateStr)}`;
        } else {
          const poolKey = sub.poolKey;
          const currResult = getCurrentCurriculum(poolKey, dateStr);
          unitLabel = currResult ? currResult.stageLabel : '';
        }

        return {
          slotType: 'teaching',
          classGroup: cg.label,
          subject: sub.label,
          currentUnit: unitLabel,
          periodNumber: periodNum,
          description: `第${periodNum}校时（${timeRange}）${cg.label} ${sub.label}${unitLabel ? ` — ${unitLabel}` : ''}`,
          canChat: false,
          interceptChance: 0.40,
        };
      } else {
        return {
          slotType: 'free',
          freeActivity: timetableSlot.activity,
          periodNumber: periodNum,
          description: `第${periodNum}校时（${timeRange}）[空档] ${timetableSlot.activity}`,
          canChat: true,
          interceptChance: 0,
        };
      }
    }
  }

  // After school hours, before commute home
  if (minutesOfDay >= 18 * 60 + 30 && minutesOfDay < 19 * 60 + 30) {
    return { slotType: 'commuting', description: '傍晚通勤回家', canChat: false, interceptChance: 0 };
  }

  if (minutesOfDay >= 19 * 60 + 30 && minutesOfDay < 23 * 60) {
    return { slotType: 'home', description: '在家休息/备课或批改作文', canChat: true, interceptChance: 0 };
  }

  return { slotType: 'sleeping', description: '深夜，准备睡觉', canChat: false, interceptChance: 0 };
};

export const getDayScheduleSummary = (dateStr: string, timezone: string = 'Asia/Tokyo'): string => {
  const parts = dateStr.split('-');
  if (parts.length < 3) return '';

  const dayOfWeek = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])).getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const inSession = isSchoolInSession(dateStr);

  if (isWeekend || !inSession) {
    return '';
  }

  const daySchedule = BASE_TIMETABLE[dayOfWeek];
  if (!daySchedule) return '';

  const assignment = getYearlyAssignment(getSchoolYear(dateStr));
  const lines: string[] = [];

  if (daySchedule.shr) {
    lines.push(`- 8:30 朝会（${assignment.homeroomClass}班主任）`);
  }

  for (const period of PERIOD_TIMES) {
    const slotKey = period.id;
    if (!slotKey.startsWith('p')) continue;
    const periodNum = PERIOD_INDEX_MAP[slotKey];
    if (!periodNum) continue;

    const timetableSlot = daySchedule.slots[slotKey];
    if (!timetableSlot) continue;

    const timeStr = formatTime(period.startMinute);

    if (timetableSlot.kind === 'teaching') {
      const cg = assignment.classGroups[timetableSlot.classGroupKey];
      const sub = assignment.subjectMap[timetableSlot.subjectKey];
      if (cg && sub) {
        let unitStr = '';
        if (timetableSlot.subjectKey === 'shoronbun') {
          unitStr = ` — 小論文テーマ：${getEssayTopic(dateStr)}`;
        } else {
          const currResult = getCurrentCurriculum(sub.poolKey, dateStr);
          unitStr = currResult ? ` — ${currResult.stageLabel}` : '';
        }
        lines.push(`- P${periodNum} ${timeStr}: ${cg.label} ${sub.label}${unitStr}`);
      }
    } else {
      lines.push(`- P${periodNum} ${timeStr}: [空档] ${timetableSlot.activity}`);
    }
  }

  lines.push(`- 12:35 午休（办公室座位上吃便当）`);
  lines.push(`- 15:30~ 放课后：${daySchedule.afterSchool}`);

  return lines.join('\n');
};

// ---------------------------------------------------------------------------
// 8. Updated getCurrentKumikoState (uses detailed schedule)
// ---------------------------------------------------------------------------

export const getCurrentKumikoState = (timezone: string = 'Asia/Tokyo', isHoliday: boolean = false): StateContext => {
  const nowJST = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
  const minutesOfDay = nowJST.getHours() * 60 + nowJST.getMinutes();
  const day = nowJST.getDay();
  const dateStr = getJSTDateStr(timezone);

  const isWeekendOrHoliday = day === 0 || day === 6 || isHoliday;
  const inSession = isSchoolInSession(dateStr);

  if (isWeekendOrHoliday || !inSession) {
    if (minutesOfDay < 8 * 60) {
      return { currentState: 'SLEEPING', stateDescription: isHoliday ? '正在睡觉（节假日）' : !inSession ? '正在睡觉（假期中）' : '正在睡觉（周末）', canUseVoice: false, voicePolicy: 'forbid', proactiveProbability: 0.01 };
    } else if (minutesOfDay < 18 * 60) {
      return { currentState: 'OUTING', stateDescription: isHoliday ? '节假日休息/外出中' : !inSession ? '假期中，自由安排' : '周末休息/外出中', canUseVoice: true, voicePolicy: 'allow', proactiveProbability: 0.3 };
    } else {
      return { currentState: 'RELAXING_HOME', stateDescription: '在家休息', canUseVoice: true, voicePolicy: 'allow', proactiveProbability: 0.4 };
    }
  }

  const slot = getDetailedScheduleSlot(timezone, isHoliday);

  switch (slot.slotType) {
    case 'sleeping':
      return { currentState: 'SLEEPING', stateDescription: slot.description, canUseVoice: false, voicePolicy: 'forbid', proactiveProbability: 0.01 };
    case 'commuting':
      return { currentState: 'COMMUTING', stateDescription: slot.description, canUseVoice: false, voicePolicy: 'discourage', proactiveProbability: 0.1 };
    case 'teaching':
      return { currentState: 'TEACHING', stateDescription: slot.description, canUseVoice: false, voicePolicy: 'discourage', proactiveProbability: 0.03 };
    case 'shr':
      return { currentState: 'TEACHING', stateDescription: slot.description, canUseVoice: false, voicePolicy: 'discourage', proactiveProbability: 0.05 };
    case 'lunch':
      return { currentState: 'TEACHING', stateDescription: slot.description, canUseVoice: false, voicePolicy: 'discourage', proactiveProbability: 0.18 };
    case 'free':
      return { currentState: 'TEACHING', stateDescription: slot.description, canUseVoice: false, voicePolicy: 'discourage', proactiveProbability: 0.12 };
    case 'cleaning':
      return { currentState: 'TEACHING', stateDescription: slot.description, canUseVoice: false, voicePolicy: 'discourage', proactiveProbability: 0.10 };
    case 'after_school':
      return { currentState: 'CLUB_ACTIVITIES', stateDescription: slot.description, canUseVoice: false, voicePolicy: 'discourage', proactiveProbability: 0.15 };
    case 'home':
      return { currentState: 'RELAXING_HOME', stateDescription: slot.description, canUseVoice: true, voicePolicy: 'allow', proactiveProbability: 0.35 };
    default:
      return { currentState: 'RELAXING_HOME', stateDescription: '在家休息', canUseVoice: true, voicePolicy: 'allow', proactiveProbability: 0.35 };
  }
};
