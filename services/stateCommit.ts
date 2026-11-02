import { db } from './db';
import { type ResponseEffectGuard, RESPONSE_EFFECT_PREFIX } from './responseEffectCommit';
import { applyMoodDelta, getMoodState } from './moodService';
import { applyAffectionDelta, getAffectionState } from './affectionService';
import { blockOutboxKey, createBlockRuntime, resumeCommittedBlock, type StartBlockInput } from './blockRuntimeService';
import { getMemoryGeneration, assertMemoryGenerationCurrent } from './memoryMaintenanceGate';
import { recordStateProvenance } from './stateProvenance';

type Candidate = { mood?: number; affection?: number; block?: StartBlockInput | null };
export type ReactiveSnapshot = { mood: string; affection: string };

async function signature(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/** One audited reaction is one decision: no partial mood/affection/block. */
export async function commitReactiveCandidate(guard: ResponseEffectGuard, candidate: Candidate,
  auditedAgainst?: ReactiveSnapshot): Promise<void> {
  const id = `reaction:${guard.eventId}`;
  const digest = await signature(candidate);
  const result = await db.transaction('rw', [db.keyval, db.messages, db.kumikoDiary, db.dailyFragments, db.memoryDependencies, db.memoryCorrections, db.kumikoMood, db.kumikoAffection, db.stateCommits], async () => {
    await guard.check();
    const previous = await db.stateCommits.get(id);
    if (previous) {
      if (previous.signature !== digest) throw new Error('State candidate identity reused with different payload');
      return previous.result as { block?: ReturnType<typeof createBlockRuntime> } | undefined;
    }
    // A pre-migration partial decision must not be replayed as a new group.
    for (const effect of ['mood', 'affection', 'block']) {
      if (await db.keyval.get(RESPONSE_EFFECT_PREFIX + JSON.stringify([guard.eventId, effect]))) {
        throw new Error('Legacy reaction was already partially committed');
      }
    }
    const mood = await getMoodState();
    const affection = await getAffectionState();
    if (auditedAgainst && (JSON.stringify(mood) !== auditedAgainst.mood || JSON.stringify(affection) !== auditedAgainst.affection)) {
      throw new Error('Reaction state changed after audit');
    }
    if ((candidate.mood !== undefined && !Number.isFinite(candidate.mood)) ||
        (candidate.affection !== undefined && !Number.isFinite(candidate.affection))) throw new Error('Invalid reaction delta');
    const targetVersions: Record<string, number> = {};
    const targets = [candidate.mood ? 'mood' : null, candidate.affection ? 'affection' : null,
      candidate.block ? 'block' : null].filter((target): target is string => target !== null);
    for (const target of targets) {
      const key = `kumiko_state_version_v1:${target}`;
      const version = Number((await db.keyval.get(key))?.value ?? 0);
      if (!Number.isSafeInteger(version) || version < 0) throw new Error('Invalid state version');
      targetVersions[target] = version;
      await db.keyval.put({ key, value: version + 1 });
    }
    if (candidate.mood) await applyMoodDelta(candidate.mood);
    if (candidate.affection) await applyAffectionDelta(candidate.affection);
    const block = candidate.block ? createBlockRuntime(candidate.block) : undefined;
    if (block) {
      await db.keyval.put({ key: 'kumiko_block_runtime', value: block });
      await db.keyval.put({ key: blockOutboxKey(id), value: { eventId: id, startedAt: block.startedAt, status: 'pending' } });
    }
    await guard.check();
    const result = { block };
    await db.stateCommits.put({ id, signature: digest, kind: 'reaction', epoch: guard.epoch,
      sourceRefs: guard.sourceRefs ?? [], targetVersions, committedAt: Date.now(), result });
    await recordStateProvenance(id, 'stateCommit', digest, guard.sourceRefs, guard.consultedSources);
    if (!guard.isActive()) throw new Error('Reply cancelled before reaction commit');
    return result;
  });
  // Once committed, a cancelled reply does not undo the reaction. Refresh the
  // UI from durable state while respecting a concurrent memory correction.
  const generation = getMemoryGeneration();
  await assertMemoryGenerationCurrent(generation);
  const mood = await getMoodState();
  const affection = await getAffectionState();
  await assertMemoryGenerationCurrent(generation);
  const { useAppStore } = await import('../store');
  useAppStore.getState().setMood(mood);
  useAppStore.getState().setAffection(affection);
  if (result?.block) await resumeCommittedBlock(id, result.block);
}
