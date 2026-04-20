import { callLLMRaw, getCurrentAIConfig } from './geminiService';
import { searchLocalRagMemory } from './localRagService';

export interface DiaryDateMetadata {
  dateStr: string;
  weekday: string;
  tomorrowWeekday: string;
  isTomorrowRestDay: boolean;
}

export const verifyAgainstHistory = async (
  draftContent: string,
  chatHistoryText: string,
  pastDiarySummary: string,
  dateMetadata?: DiaryDateMetadata
): Promise<string[]> => {
  const config = getCurrentAIConfig();
  
  // 1. Extract Claims
  const extractionPrompt = `你是一个智能信息抽取器。请从下面的日记草稿中提取出“主张(Claims)”。
主张分为三类：
1. 【过去断言】：日记中提到过去发生的事（例如：“昨天买的大虾还没吃完”、“上次教的《源氏物语》”、“前天那场暴雨”）。只要初稿提到了对过去事情的接续，就必须提取。
2. 【今日新设】：初稿中编造出的**高特异性事件**（例如：“今天上课讲了《枕草子》”、“中午吃了特别的限量版炒面面包”、“有新生来交入部表”）。常规的吃饭通勤不用提取。
3. 【客观状态】：初稿中描绘的今日核心行程点（例如：“今天休假去了京都”、“今晚吃拉面”）。
4. 【微小物与视线焦点】：初稿中着重描写的某个微小的周遭物件或小动作（例如：“看了一眼伞架里的透明伞”、“盯着天花板看”、“闻到了杯子里的糖味”）。必须提取，这是为了防止连续几天都在注视同一个物件！

【日记初稿】：
${draftContent}

请将提取出的主张逐行输出，每行以 "- " 开头。如果没有找到任何值得提取的主张，输出"无"即可。不要输出多余的解释。`;

  const extractionResult = await callLLMRaw(
    extractionPrompt, 
    "请提取日记草稿中的核心主张与前置断言。", 
    config.model_summary || config.model_main
  );
  
  if (!extractionResult || extractionResult.trim() === '无' || extractionResult.trim() === '') {
    return [];
  }

  const claims = extractionResult.split('\n').map(line => line.replace(/^- /, '').trim()).filter(Boolean);
  
  // 2. Batch semantic check via RAG 
  let ragContext = "";
  for (const claim of claims) {
      if (claim.length > 3) {
          const results = await searchLocalRagMemory(claim, 3, undefined, 'semantic_recall');
          if (results && results.length > 0) {
              ragContext += `【关于 "${claim}" 的历史记忆片段】:\n${results.join('\n')}\n\n`;
          }
      }
  }

  // 3. Verification Prompt
  const verifyPrompt = `你是一个世界上最严格的逻辑与查重审查官。
请检查日记草稿是否存在【吃书连击（Continuity Hallucination）】、【与今天聊天矛盾（Chat Contradiction）】或【严重套路重复（Global Repetition）】。

【今天的真实聊天记录（绝对事实，日记不可违背）】
${chatHistoryText || '今天无聊天记录。'}

【最近几日的日记记录（参考过去事实）】
${pastDiarySummary || '无。'}

【从深层记忆库中打捞出的参考历史记录片段（用于查重或核对过去断言）】
${ragContext || '未检索到相关的历史记录。'}

【当前被审查的日记初稿】
<draft>
${draftContent}
</draft>

【审查要求】
1. 吃书判定：如果初稿中写了“之前买了A还没吃完”，但在历史记录中其实买的是“B”，或者过去根本没买过A，这叫吃书幻觉。必须报错。
2. 重复判定：如果初稿中写了“今天讲了《源氏物语》”，而检索发现一周前甚至更久之前已经讲过《源氏物语》或处理过惊人相似的事件了，要求这篇日记更换一个新的切入点或新事件。必须报错。
3. 聊天矛盾：如果聊天中约定了吃拉面，日记里写了做饭便当，这绝对不被允许。必须报错。
4. 微小物复读（极其容易出现！）：如果初稿中特写的某个“视线焦点”或“微小环境物件”（如出门看透明伞、盯着某个台灯），在参考历史记录中已经出现过，这表明日记在套用重复模版。必须严厉报错，要求将该事件更换为另一种全新的动作！
5. 人物设定矛盾（极其重要！）：审查日记中对核心人物的描写是否违反已知设定。关键铁律：丽奈已是海外职业小号演奏者，不是学生，绝不能写她有"学期""开学""考试""大学"等学生行为；小奏（久石奏）只比久美子小一届，已26岁，早已大学毕业进入社会，绝不能写她还在上大学、赶论文、去大学图书馆；叶月已是保育士，绿辉已在服装设计行业，都不是学生；秀一是普通上班族，周一到周五上班，如果日记日期是周日，写他说"明天可以休息"就是逻辑错误（明天周一要上班）。所有人物的行为必须符合当天星期几的逻辑。如发现上述矛盾，必须严厉报错。
5b. "明天"星期逻辑（极其重要！）：${dateMetadata ? `当前日期：${dateMetadata.dateStr}（${dateMetadata.weekday}曜日），明天是${dateMetadata.tomorrowWeekday}曜日（${dateMetadata.isTomorrowRestDay ? '休息日' : '工作日'}）。` : ''}久美子是老师，周一到周五上课。审查日记中所有"明天"相关的描述：如果明天是休息日，写"明天要上课/明天要讲XX/明天要备课"就是逻辑错误（应写"周一要讲的"或"下周要讲的"）。同理，秀一周末不上班，不能在周五写"明天要上班"。
6. 时间指代混乱：检查日记中是否用"手机震动了一下""手机响了"等实时接收动作来引入一条实际上早已收到的旧消息（例如"手机震动了一下。是秀一昨晚九点发来的消息"）。这种写法会让读者分不清事件发生在什么时间。如发现，必须报错。

请指出草稿中存在的致命逻辑错误或严重重复。
如果上述问题统统没有，请仅仅输出 "PASS"。
如果查出问题，请分行输出具体的报错原因及修改指令（例如：“逻辑矛盾：你在聊天中提到了吃拉面，但日记写了吃外卖。请修改饮食部分。”、“吃书：你此前买的其实是大闸蟹，不是大虾。请修正剧情接续。”）`;

  const verificationResult = await callLLMRaw(
    verifyPrompt, 
    "请核对草稿是否存在矛盾与重复。", 
    config.model_summary || config.model_main
  );
  
  // Strict PASS detection: avoid substring traps like "NOT PASS" / "CANNOT PASS" / "未 PASS".
  // Only treat as passed when the response (or its first meaningful line) is exactly "PASS"
  // (case-insensitive, optional surrounding punctuation). Anything else is treated as a failure
  // list and the lines are returned as issues for rewrite.
  const trimmed = (verificationResult || '').trim();
  if (!trimmed || trimmed.length < 5) {
    return [];
  }
  if (/^\s*PASS[\s.!。！]*$/im.test(trimmed)) {
    return [];
  }
  const firstLine = trimmed.split('\n')[0].trim().toUpperCase();
  if (firstLine === 'PASS' || firstLine.startsWith('PASS:') || firstLine.startsWith('PASS ')) {
    return [];
  }

  return trimmed.split('\n').filter(line => line.trim().length > 0);
};
