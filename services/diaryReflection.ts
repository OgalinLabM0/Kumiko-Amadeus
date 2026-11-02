import { db, updateWorldCharacterStatus } from './db';
import { applyDiaryPsycheDelta } from './psycheStateService';

interface Source { id?: string; role: 'user' | 'model'; text: string; timestamp: number; sourceRevision?: string; contentRevision?: string }
interface Input { date: string; sourceMessages: Source[]; updatesText: string; psycheDeltaText: string; reflect: boolean }
const jsonObject = (text: string): any => {
  try { const match = text.match(/\{[\s\S]*\}/); return match ? JSON.parse(match[0]) : {}; }
  catch { return {}; }
};

/** Prepared outside IndexedDB. The returned function runs inside diary settlement. */
export async function createDiaryReflection(input: Input): Promise<() => Promise<void>> {
  const psyche = jsonObject(input.psycheDeltaText);
  const delta = ['stress', 'energy', 'relaxation'].map(k =>
    typeof psyche[k] === 'number' && Number.isFinite(psyche[k]) ? psyche[k] : 0);
  const proposed = jsonObject(input.updatesText);
  const attitudes: Record<string, { current_attitude: string }> = {};
  if (proposed && typeof proposed === 'object' && !Array.isArray(proposed)) {
    for (const [id, value] of Object.entries(proposed)) {
      if (value && typeof value === 'object' && typeof (value as any).current_attitude === 'string') {
        attitudes[id] = { current_attitude: (value as any).current_attitude.slice(0, 1000) };
      }
    }
  }
  const bytes = new TextEncoder().encode(JSON.stringify([input.date, input.sourceMessages.map(s => s.id), delta, attitudes]));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
  return async () => {
    const id = `diary-reflection:${input.date}`;
    for (const source of input.sourceMessages) {
      if (!source.id) throw new Error('Diary evidence has no message identity');
      const current = await db.messages.get(source.id);
      if (!current || current.role !== source.role || current.text !== source.text || current.timestamp !== source.timestamp || current.sourceRevision !== source.sourceRevision
        || (current.role === 'user' && current.isRead !== true)) throw new Error('Diary evidence changed or was not read');
    }
    if (!input.reflect) return;
    const prior = await db.stateCommits.get(id);
    // The first settlement wins. A rewrite or retry must never add a second reflection.
    if (prior) {
      if (prior.signature !== digest) throw new Error('Diary reflection identity reused with different payload');
      return;
    }
    if (delta.some(Boolean)) await applyDiaryPsycheDelta(delta[0], delta[1], delta[2]);
    const current = (await db.keyval.get('world_character_status'))?.value ?? {};
    const accepted: Record<string, any> = {};
    for (const [id, update] of Object.entries(attitudes)) if (current[id]) accepted[id] = update;
    if (Object.keys(accepted).length) await updateWorldCharacterStatus(accepted);
    await db.stateCommits.put({ id, signature: digest, kind: 'diary-reflection', epoch: (await db.keyval.get('kumiko_turn_epoch_v1'))?.value ?? 'initial',
      sourceRefs: input.sourceMessages.map(source => ({ kind: 'message' as const, id: source.id!, version: source.contentRevision ?? source.sourceRevision ?? 'legacy', relation: 'basis' as const })),
      committedAt: Date.now() });
  };
}
