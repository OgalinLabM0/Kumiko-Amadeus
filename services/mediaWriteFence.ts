import { assertDataWritesAllowed, getDataRestoreVersion } from './dataRestoreGate';
import { assertMemoryAvailable, getMemoryGeneration } from './memoryMaintenanceGate';

export function assertMediaGeneration(version: string): void {
  assertDataWritesAllowed();
  if (getDataRestoreVersion() !== version) throw new Error('Media operation belongs to an earlier dataset.');
}

/** Held until filesystem work completes so reset can drain in-flight writes. */
export async function withMediaWriteFence<T>(version: string, work: () => Promise<T>, expectedMemoryGeneration?: string, onInvalidated?: () => Promise<void>): Promise<T> {
  const memoryGeneration = expectedMemoryGeneration ?? getMemoryGeneration();
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request('kumiko-media-write-v1', async () => {
    assertMemoryAvailable(memoryGeneration);
    assertMediaGeneration(version);
    const result = await work();
    try { assertMemoryAvailable(memoryGeneration); assertMediaGeneration(version); } catch (error) { if (onInvalidated) await onInvalidated(); throw error; }
    return result;
  });
  if (typeof window !== 'undefined') throw new Error('Safe media write locking is unavailable.');
  assertMediaGeneration(version);
  assertMemoryAvailable(memoryGeneration);
  return work();
}

export async function withMediaResetFence<T>(work: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request('kumiko-media-write-v1', work);
  if (typeof window !== 'undefined') throw new Error('Safe media reset locking is unavailable.');
  return work();
}
