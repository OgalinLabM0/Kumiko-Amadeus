import { db } from './db';
import type { EvidenceRef } from './runtimeEntities';

/** Called only inside the owning artifact transaction. */
export async function recordStateProvenance(artifactId: string, artifactKind: string, artifactVersion: string,
  basis: EvidenceRef[] = [], context: EvidenceRef[] = []): Promise<void> {
  const refs = [...basis.map(ref => ({ ...ref, relation: 'basis' as const })),
    ...context.map(ref => ({ ...ref, relation: 'context' as const }))];
  for (const ref of refs) {
    const id = JSON.stringify([artifactKind, artifactId, artifactVersion, ref.kind, ref.id, ref.version, ref.relation]);
    await db.memoryDependencies.put({ id, artifactId, artifactKind, artifactVersion,
      sourceId: ref.id, sourceKind: ref.kind, sourceVersion: ref.version, relation: ref.relation, createdAt: Date.now() });
  }
}
