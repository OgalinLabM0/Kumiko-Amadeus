import { discardVoiceSafely } from './voiceWriteLedger';

/** Voice IDs are unique per generation. Never remove a committed/shared file. */
export async function discardUnreferencedVoice(id?: string): Promise<void> {
  if (!id) return;
  await discardVoiceSafely(id);
}
