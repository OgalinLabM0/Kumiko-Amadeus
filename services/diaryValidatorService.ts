import { callLLMRaw, getCurrentAIConfig } from './geminiService';
import { searchLocalRagMemory } from './localRagService';

export const verifyAgainstHistory = async (
  draftContent: string,
  chatHistoryText: string,
  pastDiarySummary: string
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
          const results = await searchLocalRagMemory(claim, config, 3, undefined, 'semantic_recall');
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

请指出草稿中存在的致命逻辑错误或严重重复。
如果上述问题统统没有，请仅仅输出 "PASS"。
如果查出问题，请分行输出具体的报错原因及修改指令（例如：“逻辑矛盾：你在聊天中提到了吃拉面，但日记写了吃外卖。请修改饮食部分。”、“吃书：你此前买的其实是大闸蟹，不是大虾。请修正剧情接续。”）`;

  const verificationResult = await callLLMRaw(
    verifyPrompt, 
    "请核对草稿是否存在矛盾与重复。", 
    config.model_summary || config.model_main
  );
  
  if (!verificationResult || verificationResult.includes('PASS') || verificationResult.length < 5) {
      return [];
  }

  return verificationResult.split('\n').filter(line => line.trim().length > 0);
};
