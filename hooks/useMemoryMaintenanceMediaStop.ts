import { useEffect } from 'react';
import { assertMemoryAvailable, getMemoryGeneration, isMemoryMaintenanceBlocked, subscribeMemoryMaintenance } from '../services/memoryMaintenanceGate';

const active = new Map<HTMLMediaElement, { generation: string; onStop?: () => void }>();
export function registerMemorySensitiveMedia(media: HTMLMediaElement, generation: string, onStop?: () => void): () => void {
  assertMemoryAvailable(generation);
  active.set(media, { generation, onStop });
  const remove = () => active.delete(media);
  return remove;
}

export function useMemoryMaintenanceMediaStop(): void {
  useEffect(() => subscribeMemoryMaintenance(() => {
    const blocked = isMemoryMaintenanceBlocked();
    const generation = getMemoryGeneration();
    for (const [media, entry] of active) {
      if (!blocked && entry.generation === generation) continue;
      try { media.pause(); media.removeAttribute('src'); media.load(); } catch { /* best effort */ }
      active.delete(media);
      try { entry.onStop?.(); } catch { /* best effort */ }
    }
  }), []);
  useEffect(() => {
    let stopped = false;
    const retry = () => {
      if (!stopped && !isMemoryMaintenanceBlocked()) void import('../services/voiceWriteLedger')
        .then(service => service.reconcileVoiceLedger()).catch(error => console.warn('[TTS] Voice cleanup retry failed:', error));
    };
    retry();
    const timer = setInterval(retry, 60_000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);
}
