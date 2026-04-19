import type { Message, EmotionType } from '../../types';
import type { MessageEntity } from '../../services/db';

export const formatJstTimeForRag = (timestamp: number) => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(timestamp));
  const parsed: Record<string, string> = {};
  parts.forEach(part => {
    parsed[part.type] = part.value;
  });
  return `${parsed.year}/${parsed.month}/${parsed.day} ${parsed.hour}:${parsed.minute} (JST)`;
};

export const mapMessageToEntity = (message: Message): MessageEntity => ({
  id: message.id,
  role: message.role,
  text: message.text,
  timestamp: message.timestamp,
  imageId: message.imageId,
  imageCaption: message.imageCaption,
  isHidden: message.isHidden,
  isPinned: message.isPinned,
  isRead: message.isRead,
  quote: message.quote ? {
    id: message.quote.id,
    text: message.quote.text,
    role: message.quote.role,
  } : undefined,
  emotion: message.storedEmotion,
  image: message.image,
  groundingSources: message.groundingSources,
  isVoiceMessage: message.isVoiceMessage,
  voiceFileId: message.voiceFileId,
  voiceDuration: message.voiceDuration,
  japaneseText: message.japaneseText,
  sendStatus: message.sendStatus,
  failReason: message.failReason,
});

export const mapEntityToMessage = (entity: MessageEntity): Message => ({
  id: entity.id,
  role: entity.role,
  text: entity.text,
  timestamp: entity.timestamp,
  image: entity.image,
  imageId: entity.imageId,
  imageCaption: entity.imageCaption,
  groundingSources: entity.groundingSources,
  isRead: entity.isRead,
  isHidden: entity.isHidden,
  isPinned: entity.isPinned,
  quote: entity.quote,
  storedEmotion: entity.emotion as EmotionType | undefined,
  isVoiceMessage: entity.isVoiceMessage,
  voiceFileId: entity.voiceFileId,
  voiceDuration: entity.voiceDuration,
  japaneseText: entity.japaneseText,
  sendStatus: entity.sendStatus === 'sending' ? 'failed' : entity.sendStatus,
  failReason: entity.sendStatus === 'sending' ? 'App closed during send' : entity.failReason,
});

export type BackupMessageNormalizationStats = {
  inputCount: number;
  keptCount: number;
  droppedCount: number;
  droppedInvalidIdCount: number;
  droppedInvalidRoleCount: number;
  droppedInvalidTimestampCount: number;
  coercedTimestampCount: number;
};

export const normalizeImportedBackupMessages = (
  messages: any[]
): { messages: Message[]; stats: BackupMessageNormalizationStats } => {
  const stats: BackupMessageNormalizationStats = {
    inputCount: Array.isArray(messages) ? messages.length : 0,
    keptCount: 0,
    droppedCount: 0,
    droppedInvalidIdCount: 0,
    droppedInvalidRoleCount: 0,
    droppedInvalidTimestampCount: 0,
    coercedTimestampCount: 0,
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], stats };
  }

  const normalizedMessages: Message[] = [];
  messages.forEach((candidate) => {
    const id = typeof candidate?.id === 'string' ? candidate.id.trim() : '';
    if (!id) {
      stats.droppedInvalidIdCount += 1;
      stats.droppedCount += 1;
      return;
    }

    const role = candidate?.role === 'user'
      ? 'user'
      : candidate?.role === 'model'
        ? 'model'
        : null;
    if (!role) {
      stats.droppedInvalidRoleCount += 1;
      stats.droppedCount += 1;
      return;
    }

    const normalizedTimestamp = Number(candidate?.timestamp);
    if (!Number.isFinite(normalizedTimestamp)) {
      stats.droppedInvalidTimestampCount += 1;
      stats.droppedCount += 1;
      return;
    }
    if (typeof candidate?.timestamp !== 'number') {
      stats.coercedTimestampCount += 1;
    }

    const quote = candidate?.quote && typeof candidate.quote === 'object'
      ? candidate.quote
      : null;
    const quoteRole = quote?.role === 'user' || quote?.role === 'model'
      ? quote.role
      : undefined;

    normalizedMessages.push({
      id,
      role,
      text: typeof candidate?.text === 'string' ? candidate.text : '',
      timestamp: normalizedTimestamp,
      image: typeof candidate?.image === 'string' ? candidate.image : undefined,
      imageId: typeof candidate?.imageId === 'string' ? candidate.imageId : undefined,
      imageCaption: typeof candidate?.imageCaption === 'string' ? candidate.imageCaption : undefined,
      groundingSources: Array.isArray(candidate?.groundingSources)
        ? candidate.groundingSources
        : undefined,
      isRead: typeof candidate?.isRead === 'boolean' ? candidate.isRead : undefined,
      isHidden: typeof candidate?.isHidden === 'boolean' ? candidate.isHidden : undefined,
      isPinned: typeof candidate?.isPinned === 'boolean' ? candidate.isPinned : undefined,
      quote: quote && typeof quote?.text === 'string' && quoteRole
        ? {
            id: typeof quote?.id === 'string' ? quote.id : undefined,
            text: quote.text,
            role: quoteRole,
          }
        : undefined,
      storedEmotion: typeof candidate?.storedEmotion === 'string'
        ? candidate.storedEmotion as EmotionType
        : undefined,
      isVoiceMessage: typeof candidate?.isVoiceMessage === 'boolean' ? candidate.isVoiceMessage : undefined,
      voiceFileId: typeof candidate?.voiceFileId === 'string' ? candidate.voiceFileId : undefined,
      voiceDuration: typeof candidate?.voiceDuration === 'number' ? candidate.voiceDuration : undefined,
      japaneseText: typeof candidate?.japaneseText === 'string' ? candidate.japaneseText : undefined,
    });
    stats.keptCount += 1;
  });

  return {
    messages: normalizedMessages,
    stats,
  };
};

export const getJstDateParts = (timestamp: number) => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(timestamp));
  const parsed: Record<string, string> = {};
  parts.forEach(part => {
    parsed[part.type] = part.value;
  });
  return {
    year: Number(parsed.year),
    month: Number(parsed.month),
    day: Number(parsed.day),
    hour: Number(parsed.hour),
    minute: Number(parsed.minute),
    second: Number(parsed.second),
  };
};
