import { db, type EpisodeEntity } from './db';
import type { Message } from '../types';

const LONG_GAP_MINUTES = 90;
const MAX_EPISODE_MESSAGES = 18;
const MAX_EPISODE_DURATION_MINUTES = 45;
const PREVIEW_LINE_LIMIT = 4;

const TOPIC_SHIFT_PATTERNS = [
  /^(?:对了|另外|顺便|说起来|再问个|换个话题|还有个事|对啦)/u,
  /^(?:by the way|anyway|on another note|one more thing|speaking of which|also)\b/i,
];

const WRAP_UP_PATTERNS = [
  /(?:先这样|先到这|今天先这样|回头再说|晚点聊|下次再聊|先不说了|先去忙|我先撤|先撤啦|拜拜|晚安|睡了|我要睡了)/u,
  /\b(?:talk later|later then|good night|goodnight|gotta sleep|going to sleep|catch you later|let's stop here)\b/i,
];

const matchesAnyPattern = (text: string, patterns: RegExp[]) => patterns.some(pattern => pattern.test(text));

const normalizeText = (text: string) => String(text || '').replace(/\s+/g, ' ').trim();

const getJstDayKey = (timestamp: number) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date(timestamp));
};

const inferRoleScope = (messages: Message[]): EpisodeEntity['roleScope'] => {
  const distinctRoles = new Set(messages.map(message => message.role));
  if (distinctRoles.size === 1) {
    return distinctRoles.has('user') ? 'user' : 'model';
  }
  return 'mixed';
};

const buildEpisodeText = (messages: Message[]) => messages.map(message => {
  const prefix = message.role === 'user' ? 'User: ' : 'Kumiko: ';
  return `${prefix}${normalizeText(message.text)}`;
}).join('\n');

const buildEpisodePreview = (messages: Message[]) => messages
  .slice(0, PREVIEW_LINE_LIMIT)
  .map(message => {
    const prefix = message.role === 'user' ? 'User: ' : 'Kumiko: ';
    return `${prefix}${normalizeText(message.text)}`;
  })
  .join('\n');

const buildEpisodeTopicHint = (messages: Message[]) => {
  const preferredMessage =
    messages.find(message => message.role === 'user' && normalizeText(message.text).length >= 4)
    || messages.find(message => normalizeText(message.text).length >= 4)
    || messages[0];

  const normalized = normalizeText(preferredMessage?.text || '');
  if (!normalized) return undefined;
  return normalized.length > 36 ? `${normalized.slice(0, 36)}...` : normalized;
};

const buildEpisodeId = (startMessageId: string, endMessageId: string) => `episode:${startMessageId}:${endMessageId}`;

const toEpisodeEntity = (
  messages: Message[],
  boundaryReason: EpisodeEntity['boundaryReason']
): EpisodeEntity => {
  const startMessage = messages[0];
  const endMessage = messages[messages.length - 1];
  return {
    id: buildEpisodeId(startMessage.id, endMessage.id),
    startMessageId: startMessage.id,
    endMessageId: endMessage.id,
    messageIds: messages.map(message => message.id),
    startTimestamp: startMessage.timestamp,
    endTimestamp: endMessage.timestamp,
    messageCount: messages.length,
    userMessageCount: messages.filter(message => message.role === 'user').length,
    modelMessageCount: messages.filter(message => message.role === 'model').length,
    roleScope: inferRoleScope(messages),
    topicHint: buildEpisodeTopicHint(messages),
    preview: buildEpisodePreview(messages),
    text: buildEpisodeText(messages),
    boundaryReason,
  };
};

export const buildTemporalEpisodes = (messages: Message[]): EpisodeEntity[] => {
  const sourceMessages = messages
    .filter(message => !!normalizeText(message.text) && Number.isFinite(message.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);

  if (sourceMessages.length === 0) return [];

  const episodes: EpisodeEntity[] = [];
  let currentEpisode: Message[] = [];
  let pendingBoundaryReason: EpisodeEntity['boundaryReason'] = 'manual';

  const flushEpisode = (boundaryReason: EpisodeEntity['boundaryReason']) => {
    if (currentEpisode.length === 0) return;
    episodes.push(toEpisodeEntity(currentEpisode, boundaryReason));
    currentEpisode = [];
  };

  for (const message of sourceMessages) {
    const normalizedText = normalizeText(message.text);

    if (currentEpisode.length > 0) {
      const previousMessage = currentEpisode[currentEpisode.length - 1];
      const gapMinutes = (message.timestamp - previousMessage.timestamp) / 60000;
      const dayChanged = getJstDayKey(message.timestamp) !== getJstDayKey(previousMessage.timestamp);
      const durationMinutes = (previousMessage.timestamp - currentEpisode[0].timestamp) / 60000;
      const shouldTopicSplit = message.role === 'user' && matchesAnyPattern(normalizedText, TOPIC_SHIFT_PATTERNS) && currentEpisode.length >= 3;

      if (gapMinutes >= LONG_GAP_MINUTES) {
        flushEpisode('long_gap');
      } else if (dayChanged) {
        flushEpisode('day_split');
      } else if (shouldTopicSplit) {
        flushEpisode('topic_shift');
      } else if (currentEpisode.length >= MAX_EPISODE_MESSAGES || durationMinutes >= MAX_EPISODE_DURATION_MINUTES) {
        flushEpisode('window_cap');
      }
    }

    currentEpisode.push(message);

    if (message.role === 'user' && matchesAnyPattern(normalizedText, WRAP_UP_PATTERNS)) {
      flushEpisode('wrap_up');
    }
  }

  flushEpisode(pendingBoundaryReason);
  return episodes;
};

export const syncTemporalEpisodes = async (messages: Message[]) => {
  const episodes = buildTemporalEpisodes(messages);
  await db.episodes.clear();
  if (episodes.length > 0) {
    await db.episodes.bulkPut(episodes);
  }
  return episodes.length;
};

const calculateEpisodeOverlapMs = (
  episode: EpisodeEntity,
  startTimestamp?: number | null,
  endTimestamp?: number | null
) => {
  if (typeof startTimestamp !== 'number' || typeof endTimestamp !== 'number') {
    return 0;
  }
  const overlapStart = Math.max(episode.startTimestamp, startTimestamp);
  const overlapEnd = Math.min(episode.endTimestamp, endTimestamp);
  return Math.max(0, overlapEnd - overlapStart);
};

export const loadTemporalEpisodesForRange = async (
  startTimestamp?: number | null,
  endTimestamp?: number | null,
  options: { limit?: number } = {}
) => {
  const allEpisodes = await db.episodes.orderBy('startTimestamp').toArray();
  const matchedEpisodes = allEpisodes.filter(episode => {
    if (typeof startTimestamp === 'number' && episode.endTimestamp < startTimestamp) return false;
    if (typeof endTimestamp === 'number' && episode.startTimestamp > endTimestamp) return false;
    return true;
  });

  const rankedEpisodes = matchedEpisodes.sort((a, b) => {
    const overlapDelta = calculateEpisodeOverlapMs(b, startTimestamp, endTimestamp)
      - calculateEpisodeOverlapMs(a, startTimestamp, endTimestamp);
    if (overlapDelta !== 0) return overlapDelta;
    return a.startTimestamp - b.startTimestamp;
  });

  const limitedEpisodes = typeof options.limit === 'number' && options.limit > 0
    ? rankedEpisodes.slice(0, options.limit)
    : rankedEpisodes;

  return limitedEpisodes.sort((a, b) => a.startTimestamp - b.startTimestamp);
};
