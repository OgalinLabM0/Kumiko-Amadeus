import type { ChatResponse } from '../types';
import { db, type MessageEntity } from './db';
import { applyPsycheDelta } from './psycheStateService';

/** Commit one accepted response with its first real chat message. The marker
 * lives with the psyche row, so renderer restarts and backup restores retain
 * the same once-only decision. Dexie's overlapping rw transactions serialize
 * both simultaneous deliveries and ordinary psyche updates. */
export async function commitVisibleResponsePsyche(
  response: Pick<ChatResponse, 'responseEventId' | 'psycheDelta'>,
  message: MessageEntity,
): Promise<boolean> {
  const { responseEventId, psycheDelta } = response;
  if (!responseEventId || !psycheDelta || message.role !== 'model' || message.isHidden || !message.id || !message.text.trim()) return false;
  const { stress, energy, relaxation } = psycheDelta;
  if (![stress, energy, relaxation].every(Number.isFinite) || (!stress && !energy && !relaxation)) return false;

  return db.transaction('rw', db.psycheState, db.messages, async () => {
    const previous = await db.psycheState.get('current');
    if (Object.hasOwn(previous?.committedResponseEvents ?? {}, responseEventId)) return false;
    // The visible insertion occurs before this call. Persist its evidence in
    // the same transaction so a psyche event cannot outlive its chat message.
    await db.messages.put(message);
    const state = await applyPsycheDelta(stress, energy, relaxation);
    await db.psycheState.put({
      ...state,
      committedResponseEvents: {
        ...state.committedResponseEvents,
        [responseEventId]: { messageId: message.id, committedAt: Date.now() },
      },
    });
    return true;
  });
}
