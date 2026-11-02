import { VOICE_WRITE_PREFIX, isVoiceWriteRecord, type VoiceWriteRecord } from './voiceWriteRecord';

type Entry = { key: string; value: unknown };

/** Remap only explicit voiceFileId properties and ledger identities; message,
 * source and event IDs are evidence and must never be rewritten here. */
export function remapExecutionVoiceEntries(entries: Entry[], remap: (oldId: string) => string): Entry[] {
  const visit = (value: any, depth: number): any => {
    if (depth > 64) throw new Error('Backup execution data is nested too deeply.');
    if (Array.isArray(value)) return value.map(item => visit(item, depth + 1));
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = key === 'voiceFileId' && typeof item === 'string' && item
      ? remap(item) : visit(item, depth + 1);
    return result;
  };
  return entries.map(entry => {
    if (entry.key.startsWith(VOICE_WRITE_PREFIX)) {
      if (!isVoiceWriteRecord(entry.key, entry.value)) throw new Error('Invalid backup voice ledger.');
      const row = entry.value as VoiceWriteRecord, id = remap(row.id);
      return { key: VOICE_WRITE_PREFIX + id, value: { ...row, id } };
    }
    return { key: entry.key, value: visit(entry.value, 0) };
  });
}
