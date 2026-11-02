/** Content-free metadata shared by live writes and portable backups. */
export const VOICE_WRITE_PREFIX = 'kumiko_voice_write_v1:';
export interface VoiceWriteRecord {
  version: 1;
  id: string;
  sourceIds: string[];
  memoryGeneration: string;
  taskId?: string;
  status: 'reserved' | 'pending' | 'referenced';
  createdAt: number;
  updatedAt: number;
  attempt: number;
  retryAt: number;
}
export const validVoiceId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
export const validVoiceSource = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 1000;
export function isVoiceWriteRecord(entryKey: string, value: unknown): value is VoiceWriteRecord {
  const row = value as Partial<VoiceWriteRecord> | null;
  return !!row && row.version === 1 && validVoiceId(row.id) && entryKey === VOICE_WRITE_PREFIX + row.id
    && Array.isArray(row.sourceIds) && row.sourceIds.length <= 10000 && row.sourceIds.every(validVoiceSource)
    && validVoiceSource(row.memoryGeneration) && (row.taskId === undefined || validVoiceSource(row.taskId))
    && ['reserved', 'pending', 'referenced'].includes(row.status as string)
    && Number.isFinite(row.createdAt) && Number(row.createdAt) >= 0
    && Number.isFinite(row.updatedAt) && Number(row.updatedAt) >= 0
    && Number.isFinite(row.retryAt) && Number(row.retryAt) >= 0
    && Number.isSafeInteger(row.attempt) && Number(row.attempt) >= 0;
}
