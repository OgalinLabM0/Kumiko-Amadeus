import {
  evaluateRagMemoryCandidate as evaluateRagMemoryCandidateShared,
  hasRecentRagDuplicate as hasRecentRagDuplicateShared,
} from './ragRebuildCore.js';

export type RagMemorySource = 'rebuild_message' | 'rebuild_fragment' | 'turn_pair' | 'memory_chunk';

export interface RagMemoryDecision {
  shouldStore: boolean;
  tier: 'core' | 'episodic' | 'background' | 'discard';
  score: number;
  flags: string[];
  canonicalKey: string;
  dedupeKey: string | null;
  reason: string;
}

export const evaluateRagMemoryCandidate = (
  rawText: string,
  source: RagMemorySource
): RagMemoryDecision => {
  return evaluateRagMemoryCandidateShared(rawText, source) as RagMemoryDecision;
};

export const hasRecentRagDuplicate = (dedupeKey: string | null, existingKeys: Iterable<string>) => {
  return hasRecentRagDuplicateShared(dedupeKey, existingKeys);
};
