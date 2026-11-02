import type { ChatResponse } from '../types';
import { db, type MessageEntity } from './db';
import { applyPsycheDelta } from './psycheStateService';
import { commitResponseEffect, responsePayloadSignature, type ResponseEffectGuard } from './responseEffectCommit';
import { recordStateProvenance } from './stateProvenance';

/** Commit one accepted response with its first real chat message. The marker
 * lives with the psyche row, so renderer restarts and backup restores retain
 * the same once-only decision. Dexie's overlapping rw transactions serialize
 * both simultaneous deliveries and ordinary psyche updates. */
export async function commitVisibleResponsePsyche(
  response: Pick<ChatResponse, 'responseEventId' | 'psycheDelta'>,
  message: MessageEntity,
  guard?: ResponseEffectGuard,
  messageAlreadyStored = false,
): Promise<boolean> {
  if (guard) {
    if (message.role !== 'model' || message.isHidden || !message.id || !message.text.trim()) return false;
    const signature = await responsePayloadSignature([response.psycheDelta, message.id, message.text]);
    const result = await commitResponseEffect(guard, `visible:${message.id}`, [db.psycheState], async () => {
      const previous = await db.messages.get(message.id);
      await db.messages.put({ ...message, contentRevision: previous?.contentRevision, sourceRevision: previous?.sourceRevision });
      const persisted = await db.messages.get(message.id);
      await recordStateProvenance(message.id, 'message', persisted?.contentRevision ?? String(message.timestamp),
        guard.sourceRefs, guard.consultedSources);
      return commitVisibleResponsePsyche(response, message, undefined, true);
    }, signature);
    return result.value ?? false;
  }
  const { responseEventId, psycheDelta } = response;
  if (!responseEventId || !psycheDelta || message.role !== 'model' || message.isHidden || !message.id || !message.text.trim()) return false;
  const { stress, energy, relaxation } = psycheDelta;
  if (![stress, energy, relaxation].every(Number.isFinite) || (!stress && !energy && !relaxation)) return false;

  return db.transaction('rw', db.psycheState, db.messages, async () => {
    const previous = await db.psycheState.get('current');
    if (Object.hasOwn(previous?.committedResponseEvents ?? {}, responseEventId)) return false;
    // The visible insertion occurs before this call. Persist its evidence in
    // the same transaction so a psyche event cannot outlive its chat message.
    if (!messageAlreadyStored) await db.messages.put(message);
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
