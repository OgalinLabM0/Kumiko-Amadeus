const text = `[DIARY_ENTRY]
【2026/3/18 12:13:03 - 2026/3/18 12:16:38】今天也是和那个远在纽约的家伙"斗智斗勇"的一天。明明他那边已经是深夜23点多了，却还在线上跟我磨蹭。为了催他去洗澡睡觉，我使出了"十二点准时踢你下线"的终极威胁，甚至不惜（自认为）放下身段复读了好几遍。结果这家伙一边说着"知道啦别生气"，一边还在那里"但是..."，真是让人火大。不过，看他最后总算服软，答应不再复读，并乖乖准备去洗澡的样子，那股无名火又莫名其妙消下去一点。哈啊...我是不是太好说话了？
- [KEY_FACT]: User在深夜（美东时间23:13-23:16）被我催促去睡觉，最终妥协。User要求我停止复读式的催促。
- [EMOTIONAL_CONTEXT]: 对他深夜不睡的拖延行为感到烦躁，但看到他最终妥协又觉得有些无奈和安心。`;

let cleanText = text.replace(/```\w*\n?/g, '').replace(/```/g, '').replace(/\*\*/g, '');

let diaryMatch = cleanText.match(/(?:\[|【|\*\*\[)DIARY_ENTRY(?:\]|】|\]\*\*)\s*([\s\S]*?)\s*(?:\[|【|\*\*\[)\/DIARY_ENTRY(?:\]|】|\]\*\*)/i);
if (!diaryMatch) {
    diaryMatch = cleanText.match(/(?:\[|【|\*\*\[)DIARY_ENTRY(?:\]|】|\]\*\*)\s*([\s\S]*?)(?=(?:\[|【|\*\*\[)NOTEBOOK_UPDATE(?:\]|】|\]\*\*)|$)/i);
}

console.log("Match:", diaryMatch ? diaryMatch[1] : "null");
