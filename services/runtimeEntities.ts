/** Versioned runtime metadata. These records never grant a model write access. */
export interface EvidenceRef {
  kind: 'message' | 'diary' | 'fragment' | 'receipt' | 'artifact';
  id: string;
  version: string;
  relation?: 'quoted' | 'derived' | 'basis' | 'context';
}
export interface RuntimeJobEntity {
  id: string; version: number; kind: string; status: string;
  sourceId: string; sourceVersion: string; epoch: string; memoryGeneration?: string;
  attempt: number; retryAt: number; createdAt: number; updatedAt: number;
  previousAttempts?: number; owner?: string; token?: string; leaseUntil?: number;
  startedAt?: number; deadlineAt?: number; error?: string;
  payload?: any; checkpoint?: any; [field: string]: any;
}
export interface RuntimeRequestAttempt {
  id: string; rootId: string; taskId: string; role: string;
  lane: 'foreground' | 'background'; status: string; startedAt: number;
  deadlineAt: number; leaseUntil: number; owner: string;
  provider?: string; model?: string; operation?: string; connectionId?: string;
  configRevision?: number | string; finishedAt?: number; usage?: any;
  errorKind?: string; epoch?: string; memoryGeneration?: string; [field: string]: any;
}
export interface StateCommitEntity {
  id: string; signature: string; kind: string; epoch: string;
  committedAt: number; sourceRefs?: EvidenceRef[]; targetVersions?: Record<string, number>;
  result?: any; status?: string; version?: number; [field: string]: any;
}
export interface MemoryDependency {
  id: string; artifactId: string; artifactKind: string; artifactVersion: string;
  sourceId: string; sourceKind: EvidenceRef['kind']; sourceVersion: string;
  relation: NonNullable<EvidenceRef['relation']>; createdAt: number;
}
export interface MemoryCorrection {
  id: string; version: 1; status: 'prepared' | 'purging' | 'rebuilding' | 'failed' | 'completed';
  generation: string; createdAt: number; updatedAt: number;
  messageIds: string[]; artifactIds: string[]; sourceVersions: Record<string, string>;
  includeLegacyDerived: boolean; phase: string; error?: string;
  imageIds?: string[]; voiceIds?: string[]; parentIds?: string[];
  sharedVoicesRetained?: Array<{ id: string; messageIds: string[] }>;
  reminderIds?: string[]; unknownReminderSourceIds?: string[];
  retainedPrivateKeys?: string[]; affectedPrivateKeys?: string[]; unknownPrivateKeys?: string[]; protectedArtifactIds?: string[];
  redactBlockReason?: boolean;
  affectedStateCommitIds?: string[]; unknownStateCommitIds?: string[];
  anchorIds?: string[]; unknownAnchorIds?: string[];
  legacyCutoff?: number;
  managedBackups?: Array<{ path: string; size: number; digest: string }>;
  syncPath?: string;
  rebuildRequired?: boolean;
}
export interface MessageView {
  id: string; locallyDeletedAt: number; updatedAt: number;
}
