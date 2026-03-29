/**
 * Shared RAG rebuild heuristics used by both renderer and Electron main.
 */

const HEADER_PATTERNS = [
  /^【Time:.*$/u,
  /^【MEMORY CHUNK.*$/u,
];

const ROLE_PREFIX_PATTERN = /^(?:User|Kumiko):\s*/iu;

const SHORT_FILLER_PATTERNS = [
  /^(?:嗯+|恩+|哦+|噢+|喔+|啊+|呀+|欸+|诶+|哈+|哈哈+|好+|好的+|好哦+|好呀+|行+|行吧+|行呀+|知道了+|收到+|没问题+|是啊+|对啊+|对呀+|对啦+|就是这样+|就这样+|好好好+|ok+|okay+|sure+|yep+|yeah+|got it+|alright+|haha+|lol+)$/iu,
];

const FACT_PATTERNS = [
  /\d{1,2}[:：]\d{2}/u,
  /\d+\s*(?:秒|分钟?|分|小时|天|周|个月|月|年|点)/u,
  /(?:明天|后天|今晚|明早|今天|周[一二三四五六日天]|星期[一二三四五六日天]|JST|UTC)/u,
  /\b(?:tomorrow|tonight|today|friday|saturday|sunday|monday|tuesday|wednesday|thursday|jst|utc|\d+\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?))\b/i,
];

const TASK_PATTERNS = [
  /(?:提醒|记得|联系我|叫我|喊我|洗澡|睡觉|起床|待会|稍后|之后|计划|安排|约定|任务|每天|每周|每晚|别忘)/u,
  /\b(?:remind|remember|ping me|tell me|schedule|task|todo|deadline|later|after|daily|every day|every week)\b/i,
];

const RELATION_PATTERNS = [
  /(?:答应|承诺|在意|担心|想你|喜欢|不喜欢|讨厌|害怕|怕|习惯|别再|道歉|对不起|难过|开心|关系|约好了)/u,
  /\b(?:promise|promised|care about|miss you|like|dislike|hate|afraid|sorry|relationship|agreed)\b/i,
];

const STATUS_PATTERNS = [
  /(?:上班|下班|放学|到家|回家|刚到家|刚回家|在家|出门|通勤|午饭|晚饭|吃饭|甜点|洗澡|睡了|醒了)/u,
  /\b(?:off work|got home|just got home|back home|at home|commute|lunch|dinner|dessert|bath|sleep)\b/i,
];

const REASONING_PATTERNS = [
  /(?:报错|错误|修复|实现|逻辑|方案|原因|配置|接口|模型|向量|检索|记忆|RAG|SQLite|HNSW|embedding|endpoint|function|class|error|bug|stack|trace|prompt|code|api|model)/iu,
  /[`{}[\]();=<>]|::|=>/u,
];

const IMPORTANT_SHORT_PATTERNS = [
  /(?:别走|答应我|周[一二三四五六日天]|明天|后天|洗澡|睡觉|联系我|提醒我|别再|喜欢|不喜欢|怕打雷|晚安|下班|到家|回家|刚到家)/u,
  /\b(?:tomorrow|friday|saturday|sunday|remind me|remember|promise|good night|don't forget)\b/i,
];

const REBUILD_FRAGMENT_GAP_MS = 3 * 60 * 1000;
const REBUILD_FRAGMENT_WINDOW_MS = 8 * 60 * 1000;
const REBUILD_FRAGMENT_MAX_MESSAGES = 4;
const REBUILD_FRAGMENT_MAX_CHAR_LENGTH = 32;
const REBUILD_FRAGMENT_MAX_TOTAL_CHARS = 120;

const REBUILD_FRAGMENT_BLOCK_PATTERNS = [
  /(?:报错|错误|修复|实现|逻辑|方案|原因|配置|接口|模型|向量|检索|RAG|SQLite|HNSW|embedding|endpoint|function|class|error|bug|stack|trace|prompt|code|api|model)/iu,
  /[`{}[\]();=<>]|::|=>/u,
];

const JST_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const normalizeWhitespace = (text) => String(text || '').replace(/\s+/g, ' ').trim();

const getBodyLines = (text) => {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !HEADER_PATTERNS.some(pattern => pattern.test(line)));
};

const stripRolePrefix = (line) => line.replace(ROLE_PREFIX_PATTERN, '').trim();

const createCanonicalKey = (text) => {
  return normalizeWhitespace(
    String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  ).slice(0, 240);
};

export const formatJstTimeForRag = (timestamp) => {
  const parts = JST_TIME_FORMATTER.formatToParts(new Date(timestamp));
  const parsed = {};
  parts.forEach(part => {
    parsed[part.type] = part.value;
  });
  return `${parsed.year}/${parsed.month}/${parsed.day} ${parsed.hour}:${parsed.minute} (JST)`;
};

export const buildSingleRebuildEntry = (message) => {
  const prefix = message?.role === 'model' ? 'Kumiko: ' : 'User: ';
  return `【Time: ${formatJstTimeForRag(Number(message?.timestamp) || 0)}】\n${prefix}${String(message?.text || '')}`;
};

export const buildFragmentRebuildEntry = (messages) => {
  const safeMessages = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const firstMessage = safeMessages[0];
  const lastMessage = safeMessages[safeMessages.length - 1];
  const startTime = formatJstTimeForRag(Number(firstMessage?.timestamp) || 0);
  const endTime = formatJstTimeForRag(Number(lastMessage?.timestamp) || 0);
  const header = startTime === endTime
    ? `【Time: ${startTime}】`
    : `【Time: ${startTime} -> ${endTime}】`;

  const body = safeMessages.map(message => {
    const prefix = message?.role === 'model' ? 'Kumiko: ' : 'User: ';
    return `${prefix}${String(message?.text || '')}`;
  }).join('\n');

  return `${header}\n${body}`;
};

export const getMessageCharCount = (message) => Array.from(String(message?.text || '').trim()).length;

export const isRebuildFragmentFriendlyMessage = (message) => {
  const text = String(message?.text || '').trim();
  if (!text) return false;
  if (getMessageCharCount(message) > REBUILD_FRAGMENT_MAX_CHAR_LENGTH) return false;
  return !REBUILD_FRAGMENT_BLOCK_PATTERNS.some(pattern => pattern.test(text));
};

/**
 * @param {string} rawText
 * @param {'rebuild_message' | 'rebuild_fragment' | 'turn_pair' | 'memory_chunk'} source
 */
export const evaluateRagMemoryCandidate = (rawText, source) => {
  const bodyLines = getBodyLines(rawText);
  const plainLines = bodyLines.map(stripRolePrefix).filter(Boolean);
  const joinedBodyText = plainLines.join('\n');
  const normalizedBody = normalizeWhitespace(plainLines.join(' '));
  const canonicalKey = createCanonicalKey(normalizedBody);

  if (!canonicalKey) {
    return {
      shouldStore: false,
      tier: 'discard',
      score: 0,
      flags: ['empty'],
      canonicalKey: '',
      dedupeKey: null,
      reason: 'empty_after_normalization',
    };
  }

  if (source === 'memory_chunk') {
    return {
      shouldStore: true,
      tier: 'core',
      score: 999,
      flags: ['memory_chunk'],
      canonicalKey,
      dedupeKey: null,
      reason: 'structured_summary_chunk',
    };
  }

  const flags = [];
  let score = 0;
  const charCount = Array.from(normalizedBody).length;

  const hasFactSignal = FACT_PATTERNS.some(pattern => pattern.test(normalizedBody));
  const hasTaskSignal = TASK_PATTERNS.some(pattern => pattern.test(normalizedBody));
  const hasRelationshipSignal = RELATION_PATTERNS.some(pattern => pattern.test(normalizedBody));
  const hasStatusSignal = STATUS_PATTERNS.some(pattern => pattern.test(normalizedBody));
  const hasReasoningSignal = REASONING_PATTERNS.some(pattern => pattern.test(joinedBodyText));
  const hasImportantShortSignal = IMPORTANT_SHORT_PATTERNS.some(pattern => pattern.test(normalizedBody));

  if (charCount >= 10) {
    score += 1;
    flags.push('substantive_length');
  }
  if (charCount >= 28) {
    score += 1;
    flags.push('rich_length');
  }
  if (charCount >= 80) {
    score += 1;
    flags.push('dense_length');
  }
  if (plainLines.length >= 2) {
    score += 1;
    flags.push('multi_line');
  }
  if (hasFactSignal) {
    score += 2;
    flags.push('fact');
  }
  if (hasTaskSignal) {
    score += 2;
    flags.push('task');
  }
  if (hasRelationshipSignal) {
    score += 2;
    flags.push('relationship');
  }
  if (hasStatusSignal) {
    score += 1;
    flags.push('status');
  }
  if (hasReasoningSignal) {
    score += 2;
    flags.push('reasoning');
  }
  if (hasImportantShortSignal && charCount <= 24) {
    score += 2;
    flags.push('important_short');
  }

  const fillerOnly = plainLines.length > 0
    && plainLines.every(line => Array.from(line).length <= 16 && SHORT_FILLER_PATTERNS.some(pattern => pattern.test(line)))
    && !hasFactSignal
    && !hasTaskSignal
    && !hasRelationshipSignal
    && !hasStatusSignal
    && !hasReasoningSignal
    && !hasImportantShortSignal;

  if (fillerOnly) {
    return {
      shouldStore: true,
      tier: 'background',
      score: 0,
      flags: ['filler_only', 'background'],
      canonicalKey,
      dedupeKey: canonicalKey.length <= 96 ? canonicalKey : null,
      reason: 'low_value_filler_retained',
    };
  }

  const trivialPoliteOnly = plainLines.length > 0
    && plainLines.every(line => /^(?:谢谢+|谢啦+|辛苦啦+|thanks+|thank you+)$/iu.test(line))
    && !hasFactSignal
    && !hasTaskSignal
    && !hasStatusSignal
    && !hasReasoningSignal
    && !hasImportantShortSignal;

  if (trivialPoliteOnly) {
    return {
      shouldStore: true,
      tier: 'background',
      score: 0,
      flags: ['trivial_polite', 'background'],
      canonicalKey,
      dedupeKey: canonicalKey.length <= 96 ? canonicalKey : null,
      reason: 'trivial_polite_retained',
    };
  }

  const isCoreMemory = hasTaskSignal
    || hasImportantShortSignal
    || score >= 5
    || ((hasRelationshipSignal || hasReasoningSignal) && score >= 4);
  const tier = isCoreMemory ? 'core' : score >= 1 ? 'episodic' : 'background';
  const isRebuildSource = source === 'rebuild_message' || source === 'rebuild_fragment';
  const shouldStore = isRebuildSource
    ? true
    : score >= 2 || hasTaskSignal || hasRelationshipSignal || hasStatusSignal || hasReasoningSignal || hasImportantShortSignal;

  if (!shouldStore) {
    return {
      shouldStore: true,
      tier: 'background',
      score,
      flags: [...flags, 'background'],
      canonicalKey,
      dedupeKey: canonicalKey.length <= 96 ? canonicalKey : null,
      reason: 'score_below_threshold_retained',
    };
  }

  return {
    shouldStore: true,
    tier,
    score,
    flags,
    canonicalKey,
    dedupeKey: canonicalKey.length <= 96 ? canonicalKey : null,
    reason: 'high_value_memory',
  };
};

export const hasRecentRagDuplicate = (dedupeKey, existingKeys) => {
  if (!dedupeKey) return false;
  for (const key of existingKeys) {
    if (key === dedupeKey) {
      return true;
    }
  }
  return false;
};

const buildRebuildCandidate = (validMessages, startIndex) => {
  const firstMessage = validMessages[startIndex];
  const singleEntry = buildSingleRebuildEntry(firstMessage);
  const singleDecision = evaluateRagMemoryCandidate(singleEntry, 'rebuild_message');

  if (!isRebuildFragmentFriendlyMessage(firstMessage)) {
    return {
      ragEntry: singleEntry,
      memoryDecision: singleDecision,
      messageId: firstMessage.id,
      timestamp: firstMessage.timestamp,
      consumedUntil: startIndex,
      grouped: false,
      role: firstMessage.role === 'model' ? 'model' : 'user',
    };
  }

  const fragmentMessages = [firstMessage];
  let runningChars = getMessageCharCount(firstMessage);
  let lastTimestamp = firstMessage.timestamp;

  for (let cursor = startIndex + 1; cursor < validMessages.length; cursor += 1) {
    if (fragmentMessages.length >= REBUILD_FRAGMENT_MAX_MESSAGES) break;
    const nextMessage = validMessages[cursor];
    if (!isRebuildFragmentFriendlyMessage(nextMessage)) break;

    const gapMs = nextMessage.timestamp - lastTimestamp;
    const windowMs = nextMessage.timestamp - firstMessage.timestamp;
    if (gapMs < 0 || gapMs > REBUILD_FRAGMENT_GAP_MS || windowMs > REBUILD_FRAGMENT_WINDOW_MS) break;

    const nextChars = getMessageCharCount(nextMessage);
    if ((runningChars + nextChars) > REBUILD_FRAGMENT_MAX_TOTAL_CHARS) break;

    fragmentMessages.push(nextMessage);
    runningChars += nextChars;
    lastTimestamp = nextMessage.timestamp;
  }

  if (fragmentMessages.length < 2) {
    return {
      ragEntry: singleEntry,
      memoryDecision: singleDecision,
      messageId: firstMessage.id,
      timestamp: firstMessage.timestamp,
      consumedUntil: startIndex,
      grouped: false,
      role: firstMessage.role === 'model' ? 'model' : 'user',
    };
  }

  const fragmentEntry = buildFragmentRebuildEntry(fragmentMessages);
  const fragmentDecision = evaluateRagMemoryCandidate(fragmentEntry, 'rebuild_message');
  const preferFragment = fragmentDecision.shouldStore && (
    !singleDecision.shouldStore
    || fragmentDecision.score > singleDecision.score
    || fragmentDecision.flags.includes('status')
    || fragmentDecision.flags.includes('task')
    || fragmentDecision.flags.includes('fact')
    || fragmentDecision.flags.includes('important_short')
    || fragmentMessages.length >= 3
  );

  if (!preferFragment) {
    return {
      ragEntry: singleEntry,
      memoryDecision: singleDecision,
      messageId: firstMessage.id,
      timestamp: firstMessage.timestamp,
      consumedUntil: startIndex,
      grouped: false,
      role: firstMessage.role === 'model' ? 'model' : 'user',
    };
  }

  const anchorMessage = fragmentMessages[Math.floor(fragmentMessages.length / 2)] || firstMessage;
  const distinctRoles = new Set(fragmentMessages.map(message => message.role));
  const fragmentRole = distinctRoles.size > 1 ? 'mixed' : (anchorMessage.role === 'model' ? 'model' : 'user');
  return {
    ragEntry: fragmentEntry,
    memoryDecision: fragmentDecision,
    messageId: anchorMessage.id,
    timestamp: anchorMessage.timestamp,
    consumedUntil: startIndex + fragmentMessages.length - 1,
    grouped: true,
    role: fragmentRole,
  };
};

/**
 * @param {Array<{id?: string, role?: string, text?: string, timestamp?: number}>} messages
 * @param {{ onProgress?: (progress: { processed: number, total: number, accepted: number, filtered: number, deduped: number }) => void, progressInterval?: number }} [options]
 */
export const buildRebuildCandidates = (messages, options = {}) => {
  const validMessages = Array.isArray(messages)
    ? [...messages]
      .filter(message => {
        const text = String(message?.text || '').trim();
        return !!text && Number.isFinite(message?.timestamp);
      })
      .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
      .map(message => ({
        ...message,
        role: message?.role === 'model' ? 'model' : 'user',
        text: String(message?.text || ''),
        timestamp: Number(message?.timestamp) || 0,
      }))
    : [];

  const seenRebuildDedupeKeys = new Set();
  const rebuildCandidates = [];
  let filteredCount = 0;
  let duplicateCount = 0;
  let groupedCount = 0;

  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const progressInterval = Number.isFinite(options.progressInterval) && options.progressInterval > 0
    ? Math.max(1, Math.floor(options.progressInterval))
    : 20;

  const emitProgress = (processed, force = false) => {
    if (!onProgress) return;
    if (!force && processed < validMessages.length && (processed % progressInterval) !== 0) return;
    onProgress({
      processed,
      total: validMessages.length,
      accepted: rebuildCandidates.length,
      filtered: filteredCount,
      deduped: duplicateCount,
    });
  };

  for (let index = 0; index < validMessages.length; index += 1) {
    const candidate = buildRebuildCandidate(validMessages, index);
    const { ragEntry, memoryDecision, messageId, timestamp, consumedUntil, grouped, role } = candidate;

    if (!memoryDecision.shouldStore) {
      filteredCount += 1;
      emitProgress(index + 1, index === validMessages.length - 1);
      continue;
    }

    if (hasRecentRagDuplicate(memoryDecision.dedupeKey, seenRebuildDedupeKeys)) {
      duplicateCount += 1;
      index = consumedUntil;
      emitProgress(index + 1, index >= validMessages.length - 1);
      continue;
    }

    if (memoryDecision.dedupeKey) {
      seenRebuildDedupeKeys.add(memoryDecision.dedupeKey);
    }

    rebuildCandidates.push({
      ragEntry,
      memoryDecision,
      messageId,
      timestamp,
      grouped,
      role: role === 'mixed' ? 'mixed' : role === 'model' ? 'model' : 'user',
    });
    if (grouped) {
      groupedCount += 1;
    }

    index = consumedUntil;
    emitProgress(index + 1, index >= validMessages.length - 1);
  }

  emitProgress(validMessages.length, true);

  return {
    validMessageCount: validMessages.length,
    candidates: rebuildCandidates,
    filteredCount,
    duplicateCount,
    groupedCount,
  };
};
