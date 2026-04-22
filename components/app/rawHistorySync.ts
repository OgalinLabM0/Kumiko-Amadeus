import type { Message } from '../../types';
import { db } from '../../services/db';
import { loadRawHistoryMessagesFromMain, syncRawHistoryMessagesToMain } from '../../services/localRagService';
import { mapEntityToMessage, mapMessageToEntity, formatJstTimeForRag } from './messageMappers';

export const loadRawHistoryMessages = async (): Promise<Message[]> => {
  const mainProcessMessages = await loadRawHistoryMessagesFromMain();
  const rawMessages = await db.messages.orderBy('timestamp').toArray();
  const mergedById = new Map<string, Message>();
  let droppedMainCount = 0;
  let droppedDexieCount = 0;

  if (Array.isArray(mainProcessMessages)) {
    mainProcessMessages.forEach(message => {
      if (!message?.id || !message.text || !Number.isFinite(message.timestamp)) {
        droppedMainCount += 1;
        return;
      }
      mergedById.set(message.id, message);
    });
  }

  if (rawMessages.length > 0) {
    rawMessages.map(mapEntityToMessage).forEach(message => {
      if (!message?.id || !message.text || !Number.isFinite(message.timestamp)) {
        droppedDexieCount += 1;
        return;
      }
      mergedById.set(message.id, message);
    });
  }

  if (droppedMainCount > 0 || droppedDexieCount > 0) {
    console.warn('[RAW HISTORY] Dropped invalid raw history messages while loading evidence.', {
      droppedMainCount,
      droppedDexieCount,
      mergedCount: mergedById.size,
    });
  }

  if (mergedById.size > 0) {
    return Array.from(mergedById.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  const legacyMessages = await db.getVal<Message[]>('kumiko_chat_history', []);
  return Array.isArray(legacyMessages) ? legacyMessages : [];
};

export const normalizeHistoryEvidenceMessages = (messages: Message[]) => {
  const mergedById = new Map<string, Message>();
  messages.forEach(message => {
    if (!message?.id || !message.text || !Number.isFinite(message.timestamp)) return;
    mergedById.set(message.id, message);
  });
  return Array.from(mergedById.values()).sort((a, b) => a.timestamp - b.timestamp);
};

export const buildHistoryEvidenceMessages = async (liveMessages: Message[]) => {
  const rawMessages = await loadRawHistoryMessages();
  // Merge persisted raw history with live state so strict recall never drops
  // recently added messages just because IndexedDB sync lagged behind by one tick.
  return normalizeHistoryEvidenceMessages([...rawMessages, ...liveMessages]);
};

export const formatTemporalEpisodeRange = (startTimestamp: number, endTimestamp: number) => {
  const start = formatJstTimeForRag(startTimestamp);
  const end = formatJstTimeForRag(endTimestamp);
  return start === end ? start : `${start} -> ${end}`;
};

// Callers that are part of an interactive / user-visible pipeline (e.g.
// `summaryActions.handleRebuildRag`) should pass `throwOnSyncError: true`
// so a failed main-process SQLite sync aborts the outer operation and
// surfaces a real error to the user. Callers on non-critical paths
// (`App.tsx` autosave, backup import) should omit the flag so a flaky
// sync degrades gracefully with only a console.warn. This exists because
// the mobile RAG rebuild was silently stalling at "1/6 Syncing raw
// messages to desktop SQLite" whenever the 60s HTTP/IPC bridge timeout
// fired — the error was swallowed here and the outer `completion`
// Promise in `summaryActions` then waited forever for a rebuild that
// had never started.
export const syncRawHistoryMessages = async (
  messages: Message[],
  options: { forceFull?: boolean; throwOnSyncError?: boolean } = {},
) => {
  const entities = messages.map(mapMessageToEntity);

  await db.setVal('kumiko_chat_history', messages);

  if (options.forceFull) {
    await db.messages.clear();
  }

  if (entities.length === 0) {
    if (!options.forceFull) {
      await db.messages.clear();
    }
    try {
      await syncRawHistoryMessagesToMain([], { replaceAll: true });
    } catch (e) {
      console.warn('[RAW HISTORY] Failed to clear main-process SQLite raw history.', e);
      if (options.throwOnSyncError) throw e;
    }
    return;
  }

  await db.messages.bulkPut(entities);

  try {
    await syncRawHistoryMessagesToMain(messages, { replaceAll: !!options.forceFull });
  } catch (e) {
    console.warn('[RAW HISTORY] Failed to sync messages to main-process SQLite.', e);
    if (options.throwOnSyncError) throw e;
  }
};
