import { db, DailyFragmentEntity, KumikoDiaryEntity, getWorldCharacterStatus, updateWorldCharacterStatus, WorldCharacterStatusMap } from './db';
import { callLLMRaw, getCurrentAIConfig } from './geminiService';
import { verifyAgainstHistory } from './diaryValidatorService';
import { getCurrentKumikoState, getSchoolTermContext } from './kumikoStateMachine';
import { updatePsycheState } from './psycheStateService';

type DiaryChatMessage = {
  role: 'user' | 'model';
  text: string;
  timestamp: number;
};

type DiaryWeekdayFocusId = 'classroom' | 'office' | 'grading' | 'campus' | 'commute';

type DiarySpecificSceneSnippet = {
  date: string;
  sentence: string;
  markers: string[];
};

type DiaryContinuityContext = {
  previousDiary: KumikoDiaryEntity | null;
  recentDiaries: KumikoDiaryEntity[];
  carryoverFacts: string[];
  recentMotifs: string[];
  recentDiaryEvidence: string[];
  recentTitles: string[];
  recentFocuses: DiaryWeekdayFocusId[];
  recentSentences: Array<{ date: string; sentence: string }>;
  allowedSpecificTitles: string[];
  allowedSpecificLogistics: string[];
  recentForbiddenSpecifics: string[];
  specificityEvidenceLines: string[];
  specificityEvidenceTexts: string[];
  recentSpecificScenes: DiarySpecificSceneSnippet[];
};



const JST_TIMEZONE = 'Asia/Tokyo';
const DIARY_WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];
const CHAT_ANCHOR_GAP_MS = 30 * 60 * 1000;
const DIARY_RECENT_LOOKBACK_DAYS = 7;
const DIARY_EVIDENCE_LOOKBACK_DAYS = 3;
const DIARY_MAX_CARRYOVER_FACTS = 6;
const DIARY_MAX_RECENT_MOTIFS = 8;
const DIARY_MAX_RECENT_EVIDENCE = 3;
const DIARY_MAX_SPECIFICITY_EVIDENCE = 8;
const DIARY_MAX_FORBIDDEN_SPECIFICS = 8;
const DIARY_MAX_SPECIFIC_SCENES = 8;
const DIARY_MAX_SPECIFIC_SCENES_PER_DAY = 3;
const DIARY_MAX_SENTENCES_PER_DAY = 4;
const DIARY_REPETITION_MIN_LENGTH = 14;
const DIARY_SPECIFICITY_SUPPORT_MIN_OVERLAP = 0.22;
const DIARY_SPECIFIC_SCENE_REPETITION_MIN_OVERLAP = 0.42;
const CHAT_TOPIC_HINTS = ['面试', '工作', '学校', '国语课', '作文', '副顾问', '上低音号', '秀一', '丽奈', '晚饭', '回家', '电车', '天气', '周末', '睡觉'];
const CHAT_ACTIVITY_HINTS = [
  { pattern: /(开会|会议中|在会场)/u, label: '你提到自己当时在开会或参加会议' },
  { pattern: /(在学校|上课|授课|备课|改作业|批改|作文|国语课|国文课)/u, label: '你提到自己当时在学校处理国语课、备课或批改作业' },
  { pattern: /(部活|吹奏乐部|副顾问)/u, label: '你提到自己当时在处理吹奏部副顾问相关事务，不代表你在主导全团排练' },
  { pattern: /(上低音号|悠风号|低音部)/u, label: '你提到自己当时在看上低音号或低音部相关的事' },
  { pattern: /(在电车上|通勤|刚下车|路上)/u, label: '你提到自己当时在通勤路上' },
  { pattern: /(刚到家|已经到家|在家里|回家了)/u, label: '你提到自己当时已经在家' },
  { pattern: /(吃饭|做饭|晚饭|点外卖)/u, label: '你提到自己当时正在吃饭或准备晚饭' },
];
const DIARY_CARRYOVER_PATTERNS = [
  /昨晚/u,
  /昨天/u,
  /剩下/u,
  /没吃完/u,
  /吃不完/u,
  /留到/u,
  /明天/u,
  /改天/u,
  /下次/u,
  /约好/u,
  /说好/u,
  /打算/u,
  /准备/u,
];
const DIARY_MOTIF_SENTENCE_PATTERNS = [
  /《[^》]{1,24}》/u,
  /(国语课|课堂|学生|作文|作业|批改|备课|办公室|教研|会议|打印|资料|值班|副顾问|吹奏部|上低音号|低音部|电车|通勤|面包|咖啡|便利店|味噌汤|沙拉|炸鸡块|定食屋|外卖|秀一|丽奈)/u,
];
const DIARY_KEYWORD_HINTS = [
  '面包',
  '咖啡',
  '便利店',
  '味噌汤',
  '沙拉',
  '炸鸡块',
  '定食屋',
  '外卖',
  '早餐',
  '晚饭',
  '作文',
  '作业',
  '国语课',
  '办公室',
  '教研',
  '会议',
  '副顾问',
  '吹奏部',
  '上低音号',
  '低音部',
  '电车',
  '通勤',
  '秀一',
  '丽奈',
];
const DIARY_CLASSROOM_CONTEXT_PATTERN = /(国语课|课堂|上课|学生|发言|讨论|作文|作业|批改|备课)/u;
const DIARY_CLASSROOM_SPECIFICITY_PATTERN = /(《[^》]+》|[「『“][^」』”]{2,28}[」』”]|名句|原文|作者|开头|结尾|那句|这一句|那段|这一段|意象|修辞|主题|课文|教材)/u;
const DIARY_SPECIFIC_LOGISTICS_RULES = [
  { pattern: /音乐准备室/u, label: '音乐准备室' },
  { pattern: /准备室/u, label: '准备室' },
  { pattern: /低音部安排表/u, label: '低音部安排表' },
  { pattern: /安排表/u, label: '安排表' },
  { pattern: /谱架/u, label: '谱架' },
  { pattern: /卷边(?:的)?乐谱/u, label: '卷边乐谱' },
  { pattern: /乐谱/u, label: '乐谱' },
  { pattern: /器材柜/u, label: '器材柜' },
  { pattern: /剩下的面包|剩面包|面包还剩/u, label: '剩面包' },
  { pattern: /昨晚剩下的饭|剩饭|剩菜/u, label: '剩饭' },
] as const;
const DIARY_WEEKDAY_FOCUS_ROTATION: Array<{
  id: DiaryWeekdayFocusId;
  label: string;
  schoolLine: string;
  detailHint: string;
}> = [
  {
    id: 'classroom',
    label: '课堂互动',
    schoolLine: '- 上午～下午：在学校（以上课和课堂互动为主，也会处理教师工作）',
    detailHint: '如果写课堂，不要重复最近几天已经出现过的课文、讨论句子或学生反应。',
  },
  {
    id: 'office',
    label: '办公室与教研',
    schoolLine: '- 上午～下午：在学校（备课、教研、打印材料、办公室事务为主，也会上课）',
    detailHint: '今天更适合写办公室、同事、打印材料、临时通知或会议前后的细节。',
  },
  {
    id: 'grading',
    label: '批改与反馈',
    schoolLine: '- 上午～下午：在学校（批改作文、阅读作业、登记反馈，也会完成授课）',
    detailHint: '如果写作文或阅读反馈，不要重复最近几天相同的比喻、课文或评语桥段。',
  },
  {
    id: 'campus',
    label: '校内杂务',
    schoolLine: '- 上午～下午：在学校（上课之外，也可能忙于值班、会议、跑办公室、校内杂务）',
    detailHint: '今天可以把重心放在校内琐事或副顾问事务，不必硬写成一堂文学课。',
  },
  {
    id: 'commute',
    label: '通勤与天气',
    schoolLine: '- 上午～下午：在学校（上课和备课照常进行，但更适合把镜头放在通勤、天气和校内移动）',
    detailHint: '今天可更多写通勤路上、天气体感、校园节奏变化，不必把重点放在课堂内容。',
  },
];

const uniqueStrings = (items: string[]): string[] => Array.from(new Set(items.map(item => item.trim()).filter(Boolean)));

const stripDiaryHeaderLine = (content: string): string => (
  content.replace(/^\d{4}年\d+月\d+日[^\n]*\n*/u, '').trim()
);

const splitDiarySentences = (text: string): string[] => (
  text
    .replace(/\r/gu, '')
    .split(/(?<=[。！？!?])|\n+/u)
    .map(sentence => sentence.trim())
    .filter(Boolean)
);

const truncateForPrompt = (text: string, maxLength: number): string => (
  text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`
);

const normalizeDiaryTextForCompare = (text: string): string => (
  text
    .toLowerCase()
    .replace(/\s+/gu, '')
    .replace(/[，。！？、“”"'‘’：；（）()《》【】\[\],.!?;:…\-]/gu, '')
);

const extractDiaryTitles = (text: string): string[] => {
  const matches = text.match(/《[^》]{1,24}》/gu) || [];
  return uniqueStrings(matches);
};

const extractDiaryKeywords = (text: string): string[] => {
  const keywords = new Set<string>(extractDiaryTitles(text));
  for (const hint of DIARY_KEYWORD_HINTS) {
    if (text.includes(hint)) {
      keywords.add(hint);
    }
  }
  return Array.from(keywords);
};

const extractSpecificLogistics = (text: string): string[] => {
  const labels = DIARY_SPECIFIC_LOGISTICS_RULES
    .filter(rule => rule.pattern.test(text))
    .map(rule => rule.label);
  const uniqueLabels = uniqueStrings(labels);
  return uniqueLabels.filter(label => {
    if (label === '准备室' && uniqueLabels.includes('音乐准备室')) return false;
    if (label === '安排表' && uniqueLabels.includes('低音部安排表')) return false;
    if (label === '乐谱' && uniqueLabels.includes('卷边乐谱')) return false;
    return true;
  });
};

const extractClassroomQuotes = (text: string): string[] => {
  if (!DIARY_CLASSROOM_CONTEXT_PATTERN.test(text)) return [];
  const matches = Array.from(text.matchAll(/[「『“]([^」』”]{2,28})[」』”]/gu));
  return uniqueStrings(matches.map(match => match[1]?.trim() || ''));
};

const extractSpecificSceneMarkers = (text: string): string[] => uniqueStrings([
  ...extractDiaryTitles(text),
  ...extractSpecificLogistics(text),
  ...extractClassroomQuotes(text).map(quote => `引句:${quote}`),
]);

const countMarkerOverlap = (left: string[], right: string[]): number => {
  const rightSet = new Set(right);
  return uniqueStrings(left).filter(marker => rightSet.has(marker)).length;
};

const isSpecificClassroomSentence = (sentence: string): boolean => (
  DIARY_CLASSROOM_CONTEXT_PATTERN.test(sentence) && DIARY_CLASSROOM_SPECIFICITY_PATTERN.test(sentence)
);

const hasSpecificitySignal = (text: string): boolean => (
  extractDiaryTitles(text).length > 0
  || extractSpecificLogistics(text).length > 0
  || isSpecificClassroomSentence(text)
);

const getCharacterBigrams = (text: string): Set<string> => {
  const normalized = normalizeDiaryTextForCompare(text);
  if (normalized.length <= 1) return new Set(normalized ? [normalized] : []);
  const bigrams = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    bigrams.add(normalized.slice(index, index + 2));
  }
  return bigrams;
};

const computeDiaryTextOverlapScore = (left: string, right: string): number => {
  const leftBigrams = getCharacterBigrams(left);
  const rightBigrams = getCharacterBigrams(right);
  if (leftBigrams.size === 0 || rightBigrams.size === 0) return 0;

  let intersection = 0;
  leftBigrams.forEach(token => {
    if (rightBigrams.has(token)) {
      intersection += 1;
    }
  });

  const union = new Set([...leftBigrams, ...rightBigrams]).size;
  return union === 0 ? 0 : intersection / union;
};

const classifyDiaryFocusFromContent = (content: string): DiaryWeekdayFocusId => {
  const body = stripDiaryHeaderLine(content);
  if (/(《[^》]+》|课堂|学生|发言|国语课)/u.test(body)) return 'classroom';
  if (/(批改|作文|作业|评语|阅读反馈)/u.test(body)) return 'grading';
  if (/(办公室|教研|会议|打印|资料|同事)/u.test(body)) return 'office';
  if (/(值班|副顾问|吹奏部|校内杂务|器材|走廊)/u.test(body)) return 'campus';
  return 'commute';
};

const extractCarryoverFactsFromContent = (content: string): string[] => {
  const sentences = splitDiarySentences(stripDiaryHeaderLine(content));
  return uniqueStrings(
    sentences
      .filter(sentence => DIARY_CARRYOVER_PATTERNS.some(pattern => pattern.test(sentence)))
      .slice(0, DIARY_MAX_CARRYOVER_FACTS)
      .map(sentence => truncateForPrompt(sentence, 90))
  );
};

const extractMotifLinesFromDiary = (diary: KumikoDiaryEntity): string[] => {
  const body = stripDiaryHeaderLine(diary.content);
  const sentences = splitDiarySentences(body);
  const titleLines = extractDiaryTitles(body).map(title => `${diary.date}：课文/作品 ${title}`);
  const sceneLines = sentences
    .filter(sentence => DIARY_MOTIF_SENTENCE_PATTERNS.some(pattern => pattern.test(sentence)))
    .slice(0, 2)
    .map(sentence => `${diary.date}：${truncateForPrompt(sentence, 48)}`);

  return uniqueStrings([...titleLines, ...sceneLines]);
};

const extractDiaryEvidenceSnippet = (diary: KumikoDiaryEntity): string => {
  const body = stripDiaryHeaderLine(diary.content);
  const sentences = splitDiarySentences(body);
  const prioritized = uniqueStrings([
    ...sentences.filter(sentence => DIARY_CARRYOVER_PATTERNS.some(pattern => pattern.test(sentence))).slice(0, 1),
    ...sentences.filter(sentence => DIARY_MOTIF_SENTENCE_PATTERNS.some(pattern => pattern.test(sentence))).slice(0, 1),
    ...sentences.slice(-2),
  ]).slice(0, 2);

  const snippet = prioritized.length > 0
    ? prioritized.map(sentence => truncateForPrompt(sentence, 88)).join(' / ')
    : truncateForPrompt(body, 88);

  return `[${diary.date}] ${snippet}`;
};

const collectRecentDiarySentences = (recentDiaries: KumikoDiaryEntity[]): Array<{ date: string; sentence: string }> => (
  recentDiaries.flatMap(diary => {
    const sentences = splitDiarySentences(stripDiaryHeaderLine(diary.content))
      .filter(sentence => sentence.length >= DIARY_REPETITION_MIN_LENGTH)
      .slice(0, DIARY_MAX_SENTENCES_PER_DAY);
    return sentences.map(sentence => ({ date: diary.date, sentence }));
  })
);

const buildSpecificityEvidenceBundle = (
  chatMessages: DiaryChatMessage[],
  fragments: DailyFragmentEntity[],
  carryoverFacts: string[]
): {
  lines: string[];
  texts: string[];
  allowedSpecificTitles: string[];
  allowedSpecificLogistics: string[];
} => {
  const rawEntries = [
    ...chatMessages.map(message => ({
      label: `聊天 ${formatJSTTime(message.timestamp)}`,
      text: message.text,
    })),
    ...fragments.map(fragment => ({
      label: `切片 ${formatJSTTime(fragment.timestamp)}`,
      text: fragment.content,
    })),
    ...carryoverFacts.map(fact => ({
      label: '承接',
      text: fact,
    })),
  ];

  const evidenceEntries = rawEntries
    .filter(entry => hasSpecificitySignal(entry.text))
    .slice(0, DIARY_MAX_SPECIFICITY_EVIDENCE);

  return {
    lines: evidenceEntries.map(entry => `[${entry.label}] ${truncateForPrompt(entry.text, 84)}`),
    texts: uniqueStrings(evidenceEntries.map(entry => entry.text)),
    allowedSpecificTitles: uniqueStrings(evidenceEntries.flatMap(entry => extractDiaryTitles(entry.text))),
    allowedSpecificLogistics: uniqueStrings(evidenceEntries.flatMap(entry => extractSpecificLogistics(entry.text))),
  };
};

const extractSpecificSceneSnippetsFromDiary = (diary: KumikoDiaryEntity): DiarySpecificSceneSnippet[] => {
  const body = stripDiaryHeaderLine(diary.content);
  const sentences = splitDiarySentences(body);
  return sentences
    .filter(sentence => hasSpecificitySignal(sentence))
    .slice(0, DIARY_MAX_SPECIFIC_SCENES_PER_DAY)
    .map(sentence => ({
      date: diary.date,
      sentence,
      markers: extractSpecificSceneMarkers(sentence),
    }));
};

const extractForbiddenSpecificsFromDiary = (diary: KumikoDiaryEntity): string[] => uniqueStrings(
  extractSpecificSceneSnippetsFromDiary(diary).map(scene => `${scene.date}：${truncateForPrompt(scene.sentence, 58)}`)
);

const buildDiaryContinuityContext = async (
  dateStr: string,
  chatMessages: DiaryChatMessage[] = [],
  fragments: DailyFragmentEntity[] = []
): Promise<DiaryContinuityContext> => {
  const recentDiaries = await getRecentDiaries(DIARY_RECENT_LOOKBACK_DAYS, dateStr);
  const previousDiary = recentDiaries.length > 0 ? recentDiaries[recentDiaries.length - 1] : null;
  const carryoverFacts = previousDiary ? extractCarryoverFactsFromContent(previousDiary.content) : [];
  const specificityEvidence = buildSpecificityEvidenceBundle(chatMessages, fragments, carryoverFacts);
  const recentMotifs = uniqueStrings(recentDiaries.flatMap(extractMotifLinesFromDiary)).slice(0, DIARY_MAX_RECENT_MOTIFS);
  const recentDiaryEvidence = recentDiaries
    .slice(-DIARY_EVIDENCE_LOOKBACK_DAYS)
    .map(extractDiaryEvidenceSnippet)
    .slice(0, DIARY_MAX_RECENT_EVIDENCE);
  const recentTitles = uniqueStrings(recentDiaries.flatMap(diary => extractDiaryTitles(stripDiaryHeaderLine(diary.content))));
  const recentFocuses = recentDiaries.slice(-4).map(diary => classifyDiaryFocusFromContent(diary.content));
  const recentSentences = collectRecentDiarySentences(recentDiaries);
  const recentForbiddenSpecifics = uniqueStrings(
    [...recentDiaries].reverse().flatMap(extractForbiddenSpecificsFromDiary)
  ).slice(0, DIARY_MAX_FORBIDDEN_SPECIFICS);
  const recentSpecificScenes = [...recentDiaries]
    .reverse()
    .flatMap(extractSpecificSceneSnippetsFromDiary)
    .slice(0, DIARY_MAX_SPECIFIC_SCENES);

  return {
    previousDiary,
    recentDiaries,
    carryoverFacts,
    recentMotifs,
    recentDiaryEvidence,
    recentTitles,
    recentFocuses,
    recentSentences,
    allowedSpecificTitles: specificityEvidence.allowedSpecificTitles,
    allowedSpecificLogistics: specificityEvidence.allowedSpecificLogistics,
    recentForbiddenSpecifics,
    specificityEvidenceLines: specificityEvidence.lines,
    specificityEvidenceTexts: specificityEvidence.texts,
    recentSpecificScenes,
  };
};

const pickWeekdayFocus = (
  dateStr: string,
  recentFocuses: DiaryWeekdayFocusId[] = []
): (typeof DIARY_WEEKDAY_FOCUS_ROTATION)[number] => {
  const dateSeed = dateStr.split('-').reduce((sum, part) => sum + Number(part), 0);
  const recentFocusBlocklist = new Set(recentFocuses.slice(-2));
  const baseIndex = dateSeed % DIARY_WEEKDAY_FOCUS_ROTATION.length;

  for (let offset = 0; offset < DIARY_WEEKDAY_FOCUS_ROTATION.length; offset += 1) {
    const candidate = DIARY_WEEKDAY_FOCUS_ROTATION[(baseIndex + offset) % DIARY_WEEKDAY_FOCUS_ROTATION.length];
    if (!recentFocusBlocklist.has(candidate.id)) {
      return candidate;
    }
  }

  return DIARY_WEEKDAY_FOCUS_ROTATION[baseIndex];
};

const buildContinuityPromptBlock = (continuityContext: DiaryContinuityContext): string => {
  const carryoverText = continuityContext.carryoverFacts.length > 0
    ? continuityContext.carryoverFacts.map(fact => `- ${fact}`).join('\n')
    : '无。';
  const specificityEvidenceText = continuityContext.specificityEvidenceLines.length > 0
    ? continuityContext.specificityEvidenceLines.map(line => `- ${line}`).join('\n')
    : '无。';
  const recentForbiddenSpecificsText = continuityContext.recentForbiddenSpecifics.length > 0
    ? continuityContext.recentForbiddenSpecifics.map(item => `- ${item}`).join('\n')
    : '暂无。';
  const recentMotifText = continuityContext.recentMotifs.length > 0
    ? continuityContext.recentMotifs.map(motif => `- ${motif}`).join('\n')
    : '暂无。';
  const recentEvidenceText = continuityContext.recentDiaryEvidence.length > 0
    ? continuityContext.recentDiaryEvidence.map(snippet => `- ${snippet}`).join('\n')
    : '无';

  return `【近期参考记忆圈（此处仅做防呆参考，你今天仍需自行想象丰满的新剧情细节）】
由于过去的记忆片段不完整，你不需要强行全部提及，但如果有延续，必须与之兼容：
${carryoverText}
${specificityEvidenceText}

【特别提醒：这些是最近几天已经详细写过的桥段内容，今天请**刻意避免重复**】
${recentForbiddenSpecificsText}
${recentMotifText}

最近几天的真实记忆锚点（用于校准连续性，**请注意：如果前几天的锚点写了“明天要干什么”，你今天的日记必须把时间推进至“今天干完了”，严禁在这个状态上停滞复读！**）：
${recentEvidenceText}`;
};


const parseDiaryModelResponse = (
  response: string,
  diaryDateHeader: string
): { content: string; summary: string; updatesText: string } => {
  const cleanResponse = response.replace(/^```[a-z]*\s*/im, '').replace(/```$/im, '').trim();

  const contentMatch = cleanResponse.match(/<diary_content>([\s\S]*?)<\/diary_content>/i);
  const summaryMatch = cleanResponse.match(/<diary_summary>([\s\S]*?)<\/diary_summary>/i);
  const updatesMatch = cleanResponse.match(/<character_status_updates>([\s\S]*?)<\/character_status_updates>/i);

  let rawContent = cleanResponse;
  if (contentMatch) {
    rawContent = contentMatch[1].trim();
  } else {
    // LLM forgot <diary_content> tags, manually strip the other two elements to salvage text
    rawContent = rawContent.replace(/<diary_summary>[\s\S]*?<\/diary_summary>/gi, '')
                           .replace(/<character_status_updates>[\s\S]*?<\/character_status_updates>/gi, '')
                           .replace(/<diary_content>/gi, '')
                           .replace(/<\/diary_content>/gi, '')
                           .trim();
  }

  // If the extracted content contains the header again near the start, strip the secondary one to prevent double headers
  let content = rawContent;
  
  // Clean potential residual headers or markdown formatting from LLM
  content = content.replace(/^#+.*?\n/g, '').trim(); 
  const potentialHeaderMatch = content.match(/^(20\d{2}年\d+月\d+日.+?)\n/);
  if (potentialHeaderMatch && potentialHeaderMatch[1].includes(diaryDateHeader.split(' ')[0])) {
      // The LLM included its own header that looks like a date, strip it
      content = content.substring(potentialHeaderMatch[1].length).trim();
  }

  if (!content.startsWith(diaryDateHeader)) {
    content = `${diaryDateHeader}\n\n${content.replace(/^\s+/u, '')}`;
  }

  const contentForSummary = content.startsWith(diaryDateHeader)
    ? content.slice(diaryDateHeader.length).trim()
    : content;

  return {
    content,
    summary: summaryMatch ? summaryMatch[1].trim() : `${contentForSummary.replace(/\s+/gu, ' ').slice(0, 50)}...`,
    updatesText: updatesMatch ? updatesMatch[1].trim() : '',
  };
};



const getJSTDateString = (timestamp: number): string => {
  const date = new Date(timestamp);
  const jstDate = new Date(date.toLocaleString("en-US", { timeZone: JST_TIMEZONE }));
  const year = jstDate.getFullYear();
  const month = String(jstDate.getMonth() + 1).padStart(2, '0');
  const day = String(jstDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getJSTWeekdayIndex = (dateStr: string): number => new Date(`${dateStr}T12:00:00+09:00`).getUTCDay();

const formatJSTTime = (timestamp: number): string => new Date(timestamp).toLocaleTimeString('ja-JP', {
  timeZone: JST_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const getWeatherContextText = (weatherStr?: string): string => {
  const raw = (weatherStr || '').trim();
  if (!raw) return '天气不详';

  const ujiWeatherMatch = raw.match(/久美子所在地.*?当前天气:\s*([^\n]+)/u);
  if (ujiWeatherMatch?.[1]) {
    return ujiWeatherMatch[1].trim();
  }

  return raw;
};

const getWeatherSummary = (weatherStr?: string): string => {
  const normalized = getWeatherContextText(weatherStr);
  if (!normalized || normalized === '天气不详') return '一般';
  if (/雷/u.test(normalized)) return '雷';
  if (/雪/u.test(normalized)) return '雪';
  if (/(暴雨|大雨|阵雨|雨)/u.test(normalized)) return '雨';
  if (/晴/u.test(normalized)) return '晴';
  if (/(多云|云)/u.test(normalized)) return '多云';
  if (/阴/u.test(normalized)) return '阴';
  if (/(温度|风速|°C|km\/h)/iu.test(normalized)) return '一般';
  return normalized.split(/[，。,、\s/]/u)[0]?.slice(0, 6) || '一般';
};

const buildDiaryDateHeader = (dateStr: string, weatherStr?: string): string => {
  const [year, month, day] = dateStr.split('-').map(Number);
  const weekday = DIARY_WEEKDAY_LABELS[getJSTWeekdayIndex(dateStr)] || '日';
  return `${year}年${month}月${day}日 ${weekday}曜日 ${getWeatherSummary(weatherStr)}`;
};

const buildChatHistoryText = (chatMessages: DiaryChatMessage[]): string => {
  const sorted = [...chatMessages].sort((a, b) => a.timestamp - b.timestamp);
  return sorted
    .map(message => `[${formatJSTTime(message.timestamp)}] ${message.role === 'user' ? 'User' : 'Kumiko'}: ${message.text}`)
    .join('\n');
};

const summarizeChatTopic = (messages: DiaryChatMessage[]): string => {
  const joinedText = messages.map(message => message.text).join(' ');
  const matchedHints = CHAT_TOPIC_HINTS.filter(hint => joinedText.includes(hint)).slice(0, 2);
  if (matchedHints.length > 0) {
    return `你和朋友在聊${matchedHints.join('、')}`;
  }
  return '你和朋友在线上聊天';
};

const buildChatAnchorBlock = (chatMessages: DiaryChatMessage[]): string => {
  const sorted = [...chatMessages].sort((a, b) => a.timestamp - b.timestamp);
  if (sorted.length === 0) {
    return '【聊天时间锚点】\n今天没有和朋友聊天，不需要预留线上聊天时段。';
  }

  const groups: DiaryChatMessage[][] = [];
  for (const message of sorted) {
    const currentGroup = groups[groups.length - 1];
    if (!currentGroup || message.timestamp - currentGroup[currentGroup.length - 1].timestamp > CHAT_ANCHOR_GAP_MS) {
      groups.push([message]);
      continue;
    }
    currentGroup.push(message);
  }

  const anchorLines = groups.map(group => {
    const startTime = formatJSTTime(group[0].timestamp);
    const endTime = formatJSTTime(group[group.length - 1].timestamp);
    const timeRange = startTime === endTime ? `约 ${startTime}` : `约 ${startTime}-${endTime}`;
    return `- ${timeRange}（JST）：${summarizeChatTopic(group)}`;
  });

  const hardConstraintSet = new Set<string>();
  for (const message of sorted) {
    if (message.role !== 'model') continue;
    for (const hint of CHAT_ACTIVITY_HINTS) {
      if (hint.pattern.test(message.text)) {
        hardConstraintSet.add(`- ${hint.label}（约 ${formatJSTTime(message.timestamp)} JST）`);
      }
    }
  }

  const hardConstraints = Array.from(hardConstraintSet).slice(0, 4);

  return [
    '【重要：以下时间段你在和朋友线上聊天，日记中这些时段的安排不能与聊天矛盾】',
    ...anchorLines,
    hardConstraints.length > 0
      ? '如果你在聊天里明确说过自己当时在做什么，以下约束必须保持一致：'
      : '',
    ...hardConstraints,
  ].filter(Boolean).join('\n');
};

export const buildDailyContext = (
  dateStr: string,
  weatherStr?: string,
  isHoliday?: boolean,
  chatMessages: DiaryChatMessage[] = [],
  continuityContext?: DiaryContinuityContext
): string => {
  const weekdayIndex = getJSTWeekdayIndex(dateStr);
  const weekday = DIARY_WEEKDAY_LABELS[weekdayIndex] || '日';
  const isWeekend = weekdayIndex === 0 || weekdayIndex === 6;
  const isRestDay = Boolean(isHoliday) || isWeekend;
  const dayTypeText = isHoliday ? '日本法定节假日' : isWeekend ? '周末' : '普通工作日';
  const weekdayFocus = pickWeekdayFocus(dateStr, continuityContext?.recentFocuses || []);
  const scheduleLines = isRestDay
    ? [
        '- 早上：起床较晚，在家慢慢开始一天',
        '- 白天：自由安排，可以外出、休息、处理杂事，也可能和秀一见面或顺路约会',
        '- 傍晚：从外面回来，或者准备晚上在家待着',
        '- 晚上：在家收尾；有时和秀一一起简单吃点，有时会出门找地方吃饭',
      ]
    : [
        '- 早上：起床、洗漱、吃点东西，然后通勤去学校',
        weekdayFocus.schoolLine,
        '- 放学后：通常留校处理杂务、会议或副顾问事务，不是每天都会深入吹奏部',
        '- 晚上：回家休息；经常会和秀一一起吃饭，可能在家随便吃，也可能顺路出门',
      ];

  return [
    '【今天的身份与大致框架】',
    `日期：${dateStr}（${weekday}曜日）`,
    `今天是${dayTypeText}。`,
    '你的本职是北宇治高中的国语老师，吹奏乐部副顾问只是附加身份，不代表你每天都在带整个社团。',
    ...scheduleLines,
    !isRestDay ? `- 今日镜头重点：${weekdayFocus.label}` : '',
    `天气：${getWeatherContextText(weatherStr)}`,
    '',
    '具体几点起床、早餐吃什么、路上的见闻、课堂、办公室、批改作文、回家之后的小事，都由你根据天气、心情和生活切片自由发挥，但不能违背上述客观框架。只有当天确实合理时，才少量提到吹奏部，而且更适合写成副顾问事务或和上低音号相关的小片段。',
    !isRestDay ? weekdayFocus.detailHint : '',
    '',
    buildChatAnchorBlock(chatMessages),
  ].join('\n');
};

export const getDailyFragments = async (dateStr: string): Promise<DailyFragmentEntity[]> => {
  return await db.dailyFragments.where('date').equals(dateStr).sortBy('timestamp');
};

export const getRecentDiaries = async (limit: number = 3, beforeDateStr?: string): Promise<KumikoDiaryEntity[]> => {
  if (beforeDateStr) {
    const diaries = await db.kumikoDiary.where('date').below(beforeDateStr).reverse().limit(limit).toArray();
    return diaries.reverse();
  }

  return await db.kumikoDiary.orderBy('date').reverse().limit(limit).toArray();
};

export const generateLifeFragment = async (
  dateStr: string,
  weatherStr: string,
  isHoliday: boolean,
  timezone: string,
  hoursPassed: number
): Promise<DailyFragmentEntity | null> => {
  try {
    const config = getCurrentAIConfig();
    const stateCtx = getCurrentKumikoState(timezone, isHoliday);
    const continuityContext = await buildDiaryContinuityContext(dateStr);
    
    // Update psyche state based on time passed
    const psycheState = await updatePsycheState(hoursPassed * 60 * 60 * 1000, timezone, isHoliday, weatherStr);
    
    // Get recent diaries for context
    const recentDiaries = continuityContext.recentDiaries.slice(-2);
    const diaryContext = recentDiaries.map(d => `[${d.date} 日记]: ${d.summary}`).join('\n');

    // Get today's existing fragments
    const existingFragments = await getDailyFragments(dateStr);
    const fragmentContext = existingFragments.map(f => `[${new Date(f.timestamp).toLocaleTimeString('en-US', {timeZone: 'Asia/Tokyo'})} 切片]: ${f.content}`).join('\n');
    const schoolTermContext = getSchoolTermContext(dateStr);

    const systemPrompt = `你是一个后台推演引擎。你需要根据客观环境数据，为角色“黄前久美子”推演出一段她刚刚经历的【生活切片】。
这段切片代表了她在离线期间（没有和用户聊天时）的生活轨迹和内心状态。

【客观变量】
- 离线时间：约 ${Math.round(hoursPassed)} 小时
- 当前状态：${stateCtx.stateDescription}
- 天气/节假日：${weatherStr}
- 学校阶段：${schoolTermContext}
- 当前心理状态：压力 ${Math.round(psycheState.stress)}/100, 精力 ${Math.round(psycheState.energy)}/100, 松弛度 ${Math.round(psycheState.relaxation)}/100

【历史上下文】
前几日日记摘要：
${diaryContext || '无'}

今日已有切片（必须承接这些事件，不能产生矛盾）：
${fragmentContext || '无'}

【最近几天已写过，生活切片尽量不要重复这些镜头】
${continuityContext.recentMotifs.length > 0
  ? continuityContext.recentMotifs.map(motif => `- ${motif}`).join('\n')
  : '无'}

【推演要求 —— 极其重要】
1. 结合天气、节假日、当前作息状态，合理想象她刚才正处于什么场景，正在经历什么。
2. 必须符合她作为北宇治高中国语老师、暂代吹奏乐部副顾问的身份（今年24岁，切勿回到高中生视角）。
3. 展现出真实人类的情绪（烦躁、疲惫、走神、开心等），符合当前的心理状态数值。
4. 绝对不要包含任何和用户聊天的内容，这纯粹是她自己的真实生活。
5. **严禁捏造新配角名字，严禁脑补宏大剧情**：所有相关路人只能用代词（如“前排短发女生”、“对面桌的老师”），不可凭空捏造具名NPC。如果你回想起高中（六年前），不可脑补违反原著设定的剧情。
6. 1-3句话即可。如果近期出现过类似场景，请换新切入点。
7. **防止时间停滞（Temporal Inertia）**：如果你看到了昨天关于“明天准备做某事”的回忆，你**必须将时间推进为过去时**（例如：“今天终于做完了某事”），绝对不允许像复读机一样在今天再次感叹“明天要去做某事”！
8. 不要输出任何多余的解释，直接输出文本。`;

    const content = await callLLMRaw(systemPrompt, "请推演当前的生活切片。", config.model_summary || config.model_main);
    
    if (!content) return null;

    const fragment: DailyFragmentEntity = {
      id: crypto.randomUUID(),
      date: dateStr,
      timestamp: Date.now(),
      content: content.trim(),
      triggerReason: 'intra_day_gap'
    };

    await db.dailyFragments.put(fragment);
    return fragment;
  } catch (e) {
    console.error('[LifeStream] Failed to generate life fragment:', e);
    return null;
  }
};

const rewriteDiaryModelResponse = async (params: {
  diaryDateHeader: string;
  dateStr: string;
  weekday: string;
  weatherContextText: string;
  holidayText: string;
  dailyContext: string;
  fragmentContext: string;
  diaryContext: string;
  afterContextBlock: string;
  chatHistoryText: string;
  charStatusContext: string;
  continuityPromptBlock: string;
  originalContent: string;
  originalSummary: string;
  issues: string[];
  freezeStatusEvolution: boolean;
}): Promise<string | null> => {
  const config = getCurrentAIConfig();
  const {
    diaryDateHeader,
    dateStr,
    weekday,
    weatherContextText,
    holidayText,
    dailyContext,
    fragmentContext,
    diaryContext,
    afterContextBlock,
    chatHistoryText,
    charStatusContext,
    continuityPromptBlock,
    originalContent,
    originalSummary,
    issues,
    freezeStatusEvolution,
  } = params;

  const rewritePrompt = `你现在是黄前久美子日记的极其严格的【纠错定向修订器】。
下面这篇日记初稿在情节上存在致命的客观错误（吃书、与聊天矛盾、或复读机）。

【严重错误报告（你必须彻底修复以下问题）】
${issues.map((iss, i) => `${i + 1}. ${iss}`).join('\n')}

【原稿及客观设定库】
- 日期：${dateStr}（${weekday}曜日） 天气：${weatherContextText} 节假日：${holidayText}
【作息锚点】
${dailyContext}
【生活切片（必须保留）】
${fragmentContext || '无'}
【过往日记参考】
${diaryContext || '无'}
${afterContextBlock}
【聊天记录事实大盘】
${chatHistoryText || '无'}

【被核查的原初稿（包含需要替换的错误情节）】
<diary_content>
${originalContent}
</diary_content>
<diary_summary>
${originalSummary}
</diary_summary>

【重写要求 —— 不许降级，必须创新，且严守世界观边界】
1. 针对错误报告里的批评，找到原稿对应的段落，**不仅要删掉错误内容，还必须发明出全新的生动细节来填补空白**。
2. **严禁凭空捏造新人物**：不许给同事、学生编造名字（如佐藤、田中），只能用“前排女生”、“隔壁老师”等代词；绝不要创造脱离日常的原创长线抓马剧情。
3. **时间线铁律**：你已经24岁了，高中时期的吹奏部生活是六年前的事，绝不是“去年”或“最近”。严禁瞎编违背原著《吹响吧！上低音号》的剧情（例如你自己去定竞赛选曲）。
4. 绝不允许用类似“今天照常过了”、“处理了些杂事”这种敷衍空话。
5. 第一行必须且只能是「${diaryDateHeader}」。
6. ${freezeStatusEvolution ? '<character_status_updates> 必须留空。' : '只要修复完逻辑问题，仍旧可以正常输出人物情绪状态波动。'}

请重新输出修订后的日记：
<diary_content>
（在此输出全新的正文）
</diary_content>
<diary_summary>
（一句新的摘要）
</diary_summary>
<character_status_updates>
${freezeStatusEvolution ? '留空。' : '如无必要请留空。'}
</character_status_updates>`;

  return callLLMRaw(
    rewritePrompt,
    '初稿发生客观逻辑穿帮，请你根据报错信息，以相同丰满的颗粒度定点重写矛盾段落，绝不许泛化退缩。',
    config.model_summary || config.model_main
  );
};

export const generateDailyDiary = async (
  dateStr: string,
  chatMessages: DiaryChatMessage[],
  afterContext?: string,
  weatherStr?: string,
  isHoliday?: boolean,
  freezeStatusEvolution: boolean = false,
  existingDiary?: KumikoDiaryEntity | null
): Promise<KumikoDiaryEntity | null> => {
  try {
    const config = getCurrentAIConfig();
    const normalizedChatMessages = Array.isArray(chatMessages)
      ? [...chatMessages].sort((a, b) => a.timestamp - b.timestamp)
      : [];
    const fragments = await getDailyFragments(dateStr);
    const continuityContext = await buildDiaryContinuityContext(dateStr, normalizedChatMessages, fragments);
    const chatHistoryText = buildChatHistoryText(normalizedChatMessages);
    const dailyContext = buildDailyContext(dateStr, weatherStr, isHoliday, normalizedChatMessages, continuityContext);
    const diaryDateHeader = buildDiaryDateHeader(dateStr, weatherStr);
    const weatherContextText = getWeatherContextText(weatherStr);
    const weekday = DIARY_WEEKDAY_LABELS[getJSTWeekdayIndex(dateStr)] || '日';
    const holidayText = isHoliday === undefined ? '未知' : (isHoliday ? '是' : '否');
    const continuityPromptBlock = buildContinuityPromptBlock(continuityContext);
    
    // Get today's fragments
    const fragmentContext = fragments.map(f => `[时间 ${formatJSTTime(f.timestamp)}]: ${f.content}`).join('\n');

    // Get recent diaries for causal continuity
    const recentDiaries = continuityContext.recentDiaries.slice(-3);
    const diaryContext = recentDiaries
      .filter(d => d.date !== dateStr)
      .map(d => `[${d.date}]: ${d.summary}`)
      .join('\n');

    const afterContextBlock = afterContext
      ? `\n【未来锚点（你未来几天的日记中已经确定的事实，今天的日记必须与之逻辑兼容，不能矛盾）】\n${afterContext}\n注意：这些是你"之后"写的日记里提到的事。今天的日记需要为这些事件做合理的铺垫或前因，但不要直接复述未来的内容。\n`
      : '';

    // Get current character status for dynamic evolution
    const charStatus = await getWorldCharacterStatus();
    const charStatusContext = Object.entries(charStatus).map(([key, data]) => {
      return `- ${data.aliases[0]} (${key}): [客观状态] ${data.current_status} | [主观情绪] ${data.current_attitude} | [近期事件] ${data.last_major_event}`;
    }).join('\n');
    const schoolTermContext = getSchoolTermContext(dateStr);

    const systemPrompt = `你现在是黄前久美子。现在是深夜23点，你正在写今天的私人日记。

【今天的客观信息】
- 日期：${dateStr}（${weekday}曜日）
- 天气：${weatherContextText}
- 是否节假日：${holidayText}
- 学校阶段：${schoolTermContext}
- 你的本职：北宇治高中国语老师（兼吹奏乐部副顾问）。你是教国语的，不是音乐老师！
- 乐器相关设定：你学生时代使用的上低音号是学校财产，毕业时已归还，你现在**没有**自己的私人上低音号。绝对不要在日记里写“在家里吹上低音号”或“擦拭自己的乐器”。作为副顾问，你主要负责社团杂务和学生心理辅导，绝对不要把自己写成指导学生吹奏的音乐老师。

【你今天的作息时间线】
${dailyContext}

【今天记录到的生活切片（离线推演的真实经历，必须纳入日记）】
${fragmentContext || '今天没有额外的生活切片记录。'}

【前几日日记摘要（必须承接因果）】
${diaryContext || '没有前几日的日记记录。'}
${afterContextBlock}
${continuityPromptBlock}

【今天和朋友的线上聊天记录（仅供参考，不能喧宾夺主）】
${chatHistoryText || '今天没有和朋友聊天。'}

【当前核心人物关系档案】
${charStatusContext || '暂无核心人物关系档案。'}

【日记写作要求 —— 极其重要，逐条遵守】
3. 想象力边界：大胆写出眼前的微观感觉。但【绝对禁止凭空捏造带名字的新配角】，【绝对禁止展开长线原创剧情（如某人跟你大吵一架）】，不要让日记变成配角纷乱的网络连载小说！
4. 职业边界与时间线铁律：你是北宇治国语老师。【你今年24岁】，高中生活是六年前的事，不是“去年”！回忆过去时，【绝不可违背原著剧情】。
5. 聊天降权：今天和朋友聊过天的话，可以自然带过一两句，但绝不能把聊天内容写成主角。
6. 生活切片优先：所有记录到的生活切片都必须被自然整合进日记。如果今天切片少，你就脑补合理的微观事件填充。
7. 【秀一的人设铁律】：秀一是男朋友，他是一名**最普通的本地上班族（公司职员）**。绝对禁止给他安插“研究室”、“研究生”、“医院”、“设计师”等脱离原著的复杂职场设定！不要过度描写他的工作细节。
8. 规避重复与【严防时间停滞】：参考前几天的日记，**今天刻意换一个全新的焦点**。严禁描写前几天注视过的同一物件。此外，如果昨天日记预告了“明天做某事”，今天必须推进为“今天做了某事”，绝不可在今天再次预告“明天要做某事”！
9. 允许承接与翻篇：过去的记忆只供参考，你可以选择自然地给昨天的事一点后续，也可以毫无包袱地自然翻篇，自由度由你掌握。
10. 口吻：真实、随意、略带吐槽，意识流，像是在自言自语，不要写得像在汇报工作。
11. 叙事连贯与排版：正文 400-600 字（不含首行），段间空行。可以集中笔墨写几件具体小事，但**【绝对禁止空间与时间线崩塌】**：例如绝对不能出现第一段写“晚上在家”，中间写“在办公室办公”，结尾又写“晚上回家”这种时空错乱的逻辑错误！各个段落之间的时间推移与身处场所必须保持严密的自然单向流动。
12. 灵活更新心理状态及关系：
- 允许你的日常遭遇（即使是你在日记里自己想象出的遭遇）微调你的主观压力（Stress）和精力（Energy）。
- 如果今天你遇到了让你烦躁或开心的事，或者是两人相处间的微小波澜，可以在 \`<character_status_updates>\` 里更新情绪。
- \${freezeStatusEvolution ? '当前是历史补齐模式，请勿推动人物状态演进，<character_status_updates> 必须留空。' : '当天若有明确的心理波动或关系演化，请务必输出合法的更新字段。'}

请严格按照以下格式输出：
<diary_content>
第一行必须是：${diaryDateHeader}

（这里写完整的日记正文）
</diary_content>
<diary_summary>
（这里写一句 20-40 字的简短摘要，用于后续上下文注入）
</diary_summary>
<character_status_updates>
${freezeStatusEvolution ? '留空。' : '如果今天确实发生了明确的关系事件，请输出一个合法 JSON 对象，仅包含需要更新的人物和字段；如果没有，请留空。'}
</character_status_updates>`;

    const response = await callLLMRaw(
      systemPrompt,
      freezeStatusEvolution
        ? '请写下今天的日记。注意这是历史补齐模式，不要更新人物状态。'
        : '请写下今天的日记，并仅在确有必要时更新人物状态档案。',
      config.model_summary || config.model_main
    );
    
    if (!response) return null;

    let parsedDiary = parseDiaryModelResponse(response, diaryDateHeader);

    // Run the global semantic and consistency check
    const issues = await verifyAgainstHistory(parsedDiary.content, chatHistoryText, diaryContext);
    
    if (issues.length > 0) {
      console.warn('[LifeStream] Diary Validator flagged factual errors/hallucinations, triggering rewrite:', issues);
      const rewrittenResponse = await rewriteDiaryModelResponse({
        diaryDateHeader,
        dateStr,
        weekday,
        weatherContextText,
        holidayText,
        dailyContext,
        fragmentContext,
        diaryContext,
        afterContextBlock,
        chatHistoryText,
        charStatusContext,
        continuityPromptBlock,
        originalContent: parsedDiary.content,
        originalSummary: parsedDiary.summary,
        issues,
        freezeStatusEvolution,
      });

      if (rewrittenResponse) {
        parsedDiary = parseDiaryModelResponse(rewrittenResponse, diaryDateHeader);
        console.log('[LifeStream] Diary successfully rewritten resolving hallucinations.');
      }
    }

    const { content, summary, updatesText } = parsedDiary;
    
    // Process character status updates
    if (!freezeStatusEvolution && updatesText && updatesText !== '无' && updatesText !== '{}' && updatesText !== '留空。') {
      try {
        // Simple JSON extraction in case there's markdown formatting
        const jsonMatch = updatesText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsedUpdates = JSON.parse(jsonMatch[0]) as Partial<WorldCharacterStatusMap>;
          if (Object.keys(parsedUpdates).length > 0) {
            console.log('[LifeStream] Evolving character status:', parsedUpdates);
            await updateWorldCharacterStatus(parsedUpdates);
          }
        }
      } catch (e) {
        console.warn('[LifeStream] Failed to parse character_status_updates JSON:', e);
      }
    }

    const diary: KumikoDiaryEntity = {
      id: existingDiary?.id || crypto.randomUUID(),
      date: dateStr,
      timestamp: existingDiary?.timestamp ?? Date.now(),
      content,
      summary,
      weather: weatherStr?.trim() || existingDiary?.weather || undefined,
      holiday: isHoliday === undefined ? existingDiary?.holiday : (isHoliday ? 'holiday' : undefined),
    };

    await db.kumikoDiary.put(diary);
    return diary;
  } catch (e) {
    console.error('[LifeStream] Failed to generate diary:', e);
    return null;
  }
};

export const embedDiaryToRAG = async (diary: KumikoDiaryEntity): Promise<void> => {
  try {
    if (!window.electronAPI) return;
    const textToEmbed = `[久美子的日记 - ${diary.date}]\n${diary.content}`;
    const result = await window.electronAPI.invoke('rag:save', {
      id: `diary-${diary.id}`,
      text: textToEmbed,
      timestamp: diary.timestamp,
      tier: 'core',
      source: 'diary',
      canonicalKey: `diary:${diary.date}`,
      role: 'system',
    });
    if (!result?.success) {
      throw new Error(result?.error || 'Failed to save diary into local RAG');
    }
    console.log(`[LifeStream] Embedded diary ${diary.date} into RAG`);
  } catch (e) {
    console.error('[LifeStream] Failed to embed diary to RAG:', e);
  }
};

const getJSTMidnightUTC = (dateStr: string): number => {
  return new Date(dateStr + 'T00:00:00+09:00').getTime();
};

const getDatesBetween = (startDateStr: string, endDateStr: string): string[] => {
  const dates: string[] = [];
  const current = new Date(startDateStr + 'T00:00:00+09:00');
  const end = new Date(endDateStr + 'T00:00:00+09:00');
  current.setDate(current.getDate() + 1);
  while (current < end) {
    const y = current.getUTCFullYear();
    const m = String(current.getUTCMonth() + 1).padStart(2, '0');
    const d = String(current.getUTCDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    current.setDate(current.getDate() + 1);
  }
  return dates;
};

const getChatMessagesForDate = async (dateStr: string): Promise<DiaryChatMessage[]> => {
  const dayStartUTC = getJSTMidnightUTC(dateStr);
  const dayEndUTC = dayStartUTC + 24 * 60 * 60 * 1000;
  const messages = await db.messages.where('timestamp').between(dayStartUTC, dayEndUTC, true, false).toArray();
  return messages
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(message => ({
      role: message.role,
      text: message.text,
      timestamp: message.timestamp,
    }));
};

const getNextDiaryAfterContext = async (dateStr: string): Promise<string | undefined> => {
  const nextDiary = await db.kumikoDiary.where('date').above(dateStr).first();
  return nextDiary ? `[${nextDiary.date}]: ${nextDiary.summary}` : undefined;
};

export const getEarliestMessageDate = async (): Promise<string | null> => {
  const earliest = await db.messages.orderBy('timestamp').first();
  if (!earliest) return null;
  return getJSTDateString(earliest.timestamp);
};

export interface DiaryGapInfo {
  missingDates: string[];
  gapType: 'all_missing' | 'tail_missing' | 'mid_gap' | 'none';
  totalMissing: number;
  contextBefore?: string;
  contextAfter?: string;
}

const getAllDateRange = (startStr: string, endStr: string): string[] => {
  const dates: string[] = [];
  const current = new Date(startStr + 'T00:00:00+09:00');
  const end = new Date(endStr + 'T00:00:00+09:00');
  while (current <= end) {
    const y = current.getUTCFullYear();
    const m = String(current.getUTCMonth() + 1).padStart(2, '0');
    const d = String(current.getUTCDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    current.setDate(current.getDate() + 1);
  }
  return dates;
};

export const detectDiaryGaps = async (): Promise<DiaryGapInfo> => {
  const earliestMsgDate = await getEarliestMessageDate();
  if (!earliestMsgDate) return { missingDates: [], gapType: 'none', totalMissing: 0 };

  const nowDateStr = getJSTDateString(Date.now());
  const fullRange = getAllDateRange(earliestMsgDate, nowDateStr);

  const allDiaries = await db.kumikoDiary.orderBy('date').toArray();
  const diaryDateSet = new Set(allDiaries.map(d => d.date));

  const today = nowDateStr;
  const missingDates = fullRange.filter(d => !diaryDateSet.has(d) && d !== today);

  if (missingDates.length === 0) return { missingDates: [], gapType: 'none', totalMissing: 0 };

  if (allDiaries.length === 0) {
    return { missingDates, gapType: 'all_missing', totalMissing: missingDates.length };
  }

  const sortedDiaryDates = allDiaries.map(d => d.date).sort();
  const lastDiaryDate = sortedDiaryDates[sortedDiaryDates.length - 1];
  const firstDiaryDate = sortedDiaryDates[0];

  const hasMissingBefore = missingDates.some(d => d < firstDiaryDate);
  const hasMissingAfter = missingDates.some(d => d > lastDiaryDate);
  const hasMissingMiddle = missingDates.some(d => d > firstDiaryDate && d < lastDiaryDate);

  if (hasMissingMiddle) {
    const midGapDates = missingDates.filter(d => d > firstDiaryDate && d < lastDiaryDate);
    const gapStart = midGapDates[0];
    const gapEnd = midGapDates[midGapDates.length - 1];

    const beforeDiary = allDiaries.filter(d => d.date < gapStart).sort((a, b) => b.date.localeCompare(a.date))[0];
    const afterDiary = allDiaries.filter(d => d.date > gapEnd).sort((a, b) => a.date.localeCompare(b.date))[0];

    return {
      missingDates,
      gapType: 'mid_gap',
      totalMissing: missingDates.length,
      contextBefore: beforeDiary?.summary,
      contextAfter: afterDiary ? `[${afterDiary.date}]: ${afterDiary.summary}` : undefined,
    };
  }

  if (hasMissingAfter) {
    const beforeDiary = allDiaries[allDiaries.length - 1];
    return {
      missingDates,
      gapType: 'tail_missing',
      totalMissing: missingDates.length,
      contextBefore: beforeDiary?.summary,
    };
  }

  return { missingDates, gapType: 'all_missing', totalMissing: missingDates.length };
};

export const batchGenerateDiaries = async (
  datesToFill: string[],
  onProgress: (current: number, total: number, dateStr: string) => void,
  afterContext?: string
): Promise<number> => {
  let generated = 0;
  const sorted = [...datesToFill].sort();

  for (let i = 0; i < sorted.length; i++) {
    const dateStr = sorted[i];
    onProgress(i + 1, sorted.length, dateStr);

    const existing = await db.kumikoDiary.where('date').equals(dateStr).first();
    if (existing) {
      console.log(`[LifeStream] Diary for ${dateStr} already exists, skipping`);
      continue;
    }

    console.log(`[LifeStream] Batch generating diary for ${dateStr}`);
    const chatMessages = await getChatMessagesForDate(dateStr);
    const diary = await generateDailyDiary(dateStr, chatMessages, afterContext, undefined, undefined, true);
    if (diary) {
      await embedDiaryToRAG(diary);
      await db.dailyFragments.where('date').equals(dateStr).delete();
      generated++;
    }
  }

  return generated;
};

export const rewriteDiaryEntry = async (dateStr: string): Promise<KumikoDiaryEntity | null> => {
  const existingDiary = await db.kumikoDiary.where('date').equals(dateStr).first();
  if (!existingDiary) return null;

  const chatMessages = await getChatMessagesForDate(dateStr);
  const afterContext = await getNextDiaryAfterContext(dateStr);
  const rewrittenDiary = await generateDailyDiary(
    dateStr,
    chatMessages,
    afterContext,
    existingDiary.weather,
    existingDiary.holiday === 'holiday',
    true,
    existingDiary
  );

  if (rewrittenDiary) {
    await embedDiaryToRAG(rewrittenDiary);
  }

  return rewrittenDiary;
};

export const handleRetroactiveGeneration = async (
  lastMessageTimestamp: number,
  weatherStr: string,
  isHoliday: boolean,
  timezone: string
): Promise<void> => {
  const now = Date.now();
  const gapHours = (now - lastMessageTimestamp) / (1000 * 60 * 60);

  if (gapHours < 3) return;

  const nowDateStr = getJSTDateString(now);
  console.log(`[LifeStream] Retroactive: generating today's fragment for ${nowDateStr} (gap: ${gapHours.toFixed(1)}h)`);
  await generateLifeFragment(nowDateStr, weatherStr, isHoliday, timezone, gapHours);
};
