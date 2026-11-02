import { db } from './db';
import { createTurnCoordinator, readTurnSources } from './turnCoordinator';
import type { TurnSource } from './turnUnderstanding';
import type { Language } from '../types';
import type { ReminderSlice } from '../store/slices/reminderSlice';

export const RECEIVED_TURN_PREFIX = 'kumiko_received_turn_v1:';
export interface ReceivedTurn {
  id: string;
  sourceIds: string[];
  sources?: TurnSource[];
  receivedAt: number;
  order: number;
  restored?: boolean;
  context?: string;
  status: 'received' | 'completed';
}

/** Withdraw only before a coordinator has claimed the source for reading. */
export async function withdrawUnprocessedSource(source: { id: string; text: string; timestamp: number }): Promise<boolean> {
  return db.transaction('rw', [db.keyval, db.messages], async () => {
    if (await db.keyval.get('kumiko_turn_source_v1:' + source.id)) return false;
    const receipts = await db.keyval.filter(row => row.key.startsWith(RECEIVED_TURN_PREFIX)
      && Array.isArray(row.value?.sourceIds) && row.value.sourceIds.includes(source.id)).toArray();
    if (receipts.some(row => row.value.status !== 'received')) return false;
    const saved = await db.messages.get(source.id);
    if (saved && (saved.role !== 'user' || saved.text !== source.text || saved.timestamp !== source.timestamp || saved.isRead === true)) return false;
    for (const receipt of receipts) {
      const value = receipt.value as ReceivedTurn;
      const sourceIds = value.sourceIds.filter(id => id !== source.id);
      if (!sourceIds.length) await db.keyval.delete(receipt.key);
      else await db.keyval.put({ key: receipt.key, value: { ...value, sourceIds,
        sources: value.sources?.filter(item => item.id !== source.id) } });
    }
    if (saved) await db.messages.delete(source.id);
    return true;
  });
}

/** Record receipt only: no understanding or fact changes happen here. */
export async function receiveUnreadTurn(sources: TurnSource[]): Promise<void> {
  if (!sources.length) throw new Error('Missing unread sources');
  const id = sources[0].id;
  await db.transaction('rw', [db.keyval, db.messages], async () => {
    for (const source of sources) {
      const saved = await db.messages.get(source.id);
      if (!saved || saved.role !== 'user' || saved.text !== source.text || saved.timestamp !== source.timestamp) {
        throw new Error('Unread source was not saved');
      }
    }
    const key = RECEIVED_TURN_PREFIX + id;
    const old = (await db.keyval.get(key))?.value as ReceivedTurn | undefined;
    const ids = sources.map(source => source.id);
    if (old && JSON.stringify(old.sourceIds) !== JSON.stringify(ids)) throw new Error('Unread turn identity changed');
    if (!old) {
      const existing = await db.keyval.filter(row => row.key.startsWith(RECEIVED_TURN_PREFIX)).toArray();
      const order = existing.reduce((max, row) => Math.max(max, Number(row.value?.order) || 0), 0) + 1;
      await db.keyval.put({ key, value: { id, sourceIds: ids, sources: sources.map(({ id, role, text, timestamp }) => ({ id, role, text, timestamp })), receivedAt: sources[0].timestamp, order, status: 'received' } });
    }
  });
}

/** Migrate older busy/block ledgers without splitting an already claimed turn. */
export async function seedReceivedTurns(ids: string[]): Promise<void> {
  const seen = new Set<string>();
  const existing = await db.keyval.filter(row => row.key.startsWith(RECEIVED_TURN_PREFIX)).toArray();
  const recorded = new Set(existing.flatMap(row => (row.value as ReceivedTurn).sourceIds || []));
  for (const id of ids) {
    if (id.startsWith('synthetic-') || recorded.has(id)) continue;
    const original = await readTurnSources(id);
    const key = original.turnId || original.sources[0].id;
    if (seen.has(key)) continue;
    seen.add(key);
    await receiveUnreadTurn(original.sources);
    for (const source of original.sources) recorded.add(source.id);
  }
}

export async function hasUnreadReceivedTurns(): Promise<boolean> {
  const rows = await db.keyval.filter(row => row.key.startsWith(RECEIVED_TURN_PREFIX) && row.value?.status === 'received').toArray();
  return rows.length > 0;
}

type Input = { language: Language; privateTimeZone: string;
  reminders: Pick<ReminderSlice, 'getRelativeReminders' | 'getDailyReminders' | 'saveRelativeReminder' | 'saveDailyReminder' | 'applyReminderMutation'>;
  isCancelled: () => boolean; onRead?: (ids: string[]) => void; relevantIds?: string[] };

/** Process every received original turn before any later input may be understood. */
export async function readReceivedTurns(input: Input): Promise<string[]> {
  const all = await db.keyval.filter(row => row.key.startsWith(RECEIVED_TURN_PREFIX)).toArray();
  all.sort((a, b) => a.value.receivedAt - b.value.receivedAt || (a.value.order || 0) - (b.value.order || 0) || a.key.localeCompare(b.key));
  const entries = all.filter(row => row.value?.status === 'received');
  const relevant = new Set(input.relevantIds || []);
  const contexts: string[] = all.filter(row => row.value?.status === 'completed' && typeof row.value.context === 'string'
    && row.value.sourceIds.some((id: string) => relevant.has(id))).map(row => row.value.context);
  for (const entry of entries) {
    if (input.isCancelled()) throw new Error('Reading cancelled');
    const item = entry.value as ReceivedTurn;
    const sources: TurnSource[] = [];
    for (const id of item.sourceIds) {
      const msg = await db.messages.get(id);
      if (!msg || msg.role !== 'user') throw new Error('Unread source missing');
      const source: TurnSource = { id: msg.id, role: 'user', text: msg.text, timestamp: msg.timestamp };
      const frozen = item.sources?.find(saved => saved.id === id);
      if (item.sources && (!frozen || frozen.text !== source.text || frozen.timestamp !== source.timestamp || frozen.role !== source.role)) throw new Error('Unread source changed');
      sources.push(source);
    }
    const recentMessages = (await db.messages.where('timestamp').below(item.receivedAt).reverse().limit(6).toArray())
      .reverse().map(({ id, role, text, timestamp }) => ({ id, role, text, timestamp }));
    const turn = await createTurnCoordinator({ ...input, sources, recentMessages, ...(item.restored ? { factsOnly: true } : {}) });
    try {
      if (item.restored) await turn.prepareFactsOnly();
      else await turn.prepare(true);
      const result = turn.catchUpResult();
      if (!result.complete) throw new Error('Unread facts could not be committed');
      const context = result.context;
      await db.transaction('rw', [db.keyval, db.messages], async () => {
        const current = (await db.keyval.get(entry.key))?.value as ReceivedTurn | undefined;
        if (!current || JSON.stringify(current.sourceIds) !== JSON.stringify(item.sourceIds)) throw new Error('Unread receipt changed');
        if (input.isCancelled()) throw new Error('Reading cancelled');
        for (const id of current.sourceIds) await db.messages.update(id, { isRead: true });
        await db.keyval.put({ key: entry.key, value: { ...current, status: 'completed', context } });
      });
      input.onRead?.(item.sourceIds);
      contexts.push(context);
    } finally { await turn.dispose(); }
  }
  return contexts;
}
