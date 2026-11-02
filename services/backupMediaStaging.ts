import Dexie from 'dexie';
import { db } from './db';
import { isCapacitorNative } from './environment';
import { getDataRestoreVersion, permitDataRestoreTransaction } from './dataRestoreGate';
import { getMemoryGeneration } from './memoryMaintenanceGate';
import { withMediaWriteFence } from './mediaWriteFence';
import { beginVoiceWrite, finishVoiceWrite } from './voiceWriteLedger';
import { VOICE_WRITE_PREFIX, isVoiceWriteRecord, type VoiceWriteRecord } from './voiceWriteRecord';
import { executionStateEntries, getBackupExecutionState, packExecutionState } from './turnStateBackup';
import { remapExecutionVoiceEntries } from './backupVoiceRemap';
import { imageService } from './imageService';
import { isVoiceServiceAvailable, saveVoiceFile, loadVoiceFile, loadRingtoneFileWithName, saveRingtoneFile, deleteRingtoneFile, restoreNativeRingtoneCopy } from './voiceFileService';

export interface BackupMedia {
  voices?: Array<{ id: string; base64: string }>;
  ringtone?: { base64: string; ext: string; originalName?: string };
}

function decode(base64: string): ArrayBuffer {
  if (!base64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error('Invalid backup media');
  const raw = atob(base64);
  return Uint8Array.from(raw, c => c.charCodeAt(0)).buffer;
}
function equal(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const x = new Uint8Array(a), y = new Uint8Array(b);
  return x.length === y.length && x.every((value, i) => value === y[i]);
}
function encode(buffer: ArrayBuffer): string {
  return btoa(Array.from(new Uint8Array(buffer), b => String.fromCharCode(b)).join(''));
}
export type MediaRecoverySnapshot = { present: false } | { present: true; base64: string; ext: string; originalName?: string };
export interface PreparedBackupMediaHooks { snapshot: () => Promise<MediaRecoverySnapshot>; commit: (id: string) => Promise<void>; }
async function snapshotRingtone(): Promise<MediaRecoverySnapshot> {
  const ipc = typeof window !== 'undefined' ? (window as any).electronAPI : null;
  if (ipc) {
    const result = await ipc.invoke('ringtone:load');
    if (!result?.success) {
      if (result?.error) throw new Error(`Ringtone snapshot failed: ${result.error}`);
      return { present: false };
    }
    const bytes = result.buffer instanceof ArrayBuffer ? result.buffer : result.buffer.buffer.slice(result.buffer.byteOffset, result.buffer.byteOffset + result.buffer.byteLength);
    return { present: true, base64: encode(bytes), ext: (result.fileName || 'custom.mp3').split('.').pop(), originalName: result.displayName };
  }
  if (isCapacitorNative()) {
    const entry = await db.getVal<any>('kumiko_capacitor_custom_ringtone', null);
    if (!entry) return { present: false };
    decode(entry.base64);
    return { present: true, base64: entry.base64, ext: entry.ext, originalName: entry.originalName };
  }
  throw new Error('Ringtone storage unavailable');
}
async function writeRingtone(snapshot: MediaRecoverySnapshot, id: string): Promise<void> {
  if (isCapacitorNative()) {
    await db.transaction('rw', db.keyval, async () => {
      permitDataRestoreTransaction(Dexie.currentTransaction!, id);
      if (snapshot.present) await db.keyval.put({ key: 'kumiko_capacitor_custom_ringtone', value: { base64: snapshot.base64, ext: snapshot.ext, originalName: snapshot.originalName, savedAtMs: Date.now() } });
      else await db.keyval.delete('kumiko_capacitor_custom_ringtone');
    });
    await restoreNativeRingtoneCopy(snapshot.present ? { ext: snapshot.ext, buffer: decode(snapshot.base64) } : null);
  } else {
    const ok = snapshot.present ? await saveRingtoneFile(decode(snapshot.base64), snapshot.ext, snapshot.originalName) : await deleteRingtoneFile();
    if (!ok) throw new Error('Ringtone write failed');
  }
}
export async function rollbackPreparedBackupMedia(snapshot: MediaRecoverySnapshot, id: string): Promise<void> {
  await writeRingtone(snapshot, id);
  const restored = await snapshotRingtone();
  if (restored.present !== snapshot.present || (restored.present && snapshot.present && (!equal(decode(restored.base64), decode(snapshot.base64)) || restored.ext !== snapshot.ext))) throw new Error('Ringtone rollback verification failed');
}
function uniqueId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

// New IDs prevent imported media from replacing files still referenced by the old database.
export async function prepareBackupMedia(source: any, images: Array<{id: string; dataUrl: string}>, media: BackupMedia = {}) {
  const version = getDataRestoreVersion();
  const memoryGeneration = getMemoryGeneration();
  const json = structuredClone(source);
  const messages = (json.data ?? json).messages;
  const imageIds = new Map<string, string>(), voiceIds = new Map<string, string>();
  const missingImages = new Map<string, string>(), missingVoices = new Map<string, string>();
  const stagedVoiceIds: string[] = [];
  const stagedVoiceRecords = new Map<string, VoiceWriteRecord>();
  let released = false;
  const releaseVoiceLeases = async () => {
    if (released) return;
    released = true;
    await Promise.all(stagedVoiceIds.map(id => finishVoiceWrite(id).catch(() => false)));
  };
  try {
  const entries = executionStateEntries(getBackupExecutionState(json));
  const sourceIdsByVoice = new Map<string, Set<string>>();
  const sourceIdsByImage = new Map<string, Set<string>>();
  const addSource = (voiceId: string, sourceId: unknown) => {
    if (typeof sourceId !== 'string' || !sourceId || sourceId.length > 1000) return;
    let sources = sourceIdsByVoice.get(voiceId);
    if (!sources) { sources = new Set(); sourceIdsByVoice.set(voiceId, sources); }
    sources.add(sourceId);
  };
  for (const entry of entries) if (entry.key.startsWith(VOICE_WRITE_PREFIX)) {
    if (!isVoiceWriteRecord(entry.key, entry.value)) throw new Error('Invalid backup voice ledger.');
    const row = entry.value as VoiceWriteRecord;
    for (const sourceId of row.sourceIds) addSource(row.id, sourceId);
  }
  if (Array.isArray(messages)) for (const message of messages) if (typeof message?.voiceFileId === 'string') addSource(message.voiceFileId, message.id);
  if (Array.isArray(messages)) for (const message of messages) {
    if (typeof message?.imageId !== 'string' || typeof message?.id !== 'string' || !message.id) continue;
    const sources = sourceIdsByImage.get(message.imageId) || new Set<string>();
    sources.add(message.id); sourceIdsByImage.set(message.imageId, sources);
  }
  for (const voice of media.voices || []) {
    if (!voice.id || voiceIds.has(voice.id)) throw new Error('Duplicate backup voice ID');
    decode(voice.base64);
    voiceIds.set(voice.id, uniqueId('voice_restore'));
  }
  const remapVoice = (oldId: string): string => {
    const existing = voiceIds.get(oldId) || missingVoices.get(oldId);
    if (existing) return existing;
    const id = uniqueId('voice_missing'); missingVoices.set(oldId, id); return id;
  };
  const remappedEntries = remapExecutionVoiceEntries(entries, remapVoice);
  for (const image of images) {
    if (!image.id || imageIds.has(image.id)) throw new Error('Duplicate backup image ID');
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(image.dataUrl);
    if (!match) throw new Error('Invalid backup image');
    decode(match[2]);
    const id = uniqueId('img_restore');
    await imageService.saveImageWithId(id, image.dataUrl, true, version, [...(sourceIdsByImage.get(image.id) || [])]);
    const saved = await imageService.getImageBase64(id);
    if (!saved || !equal(decode(saved.split(',')[1]), decode(match[2]))) throw new Error('Backup image verification failed');
    imageIds.set(image.id, id);
  }
  for (const voice of media.voices || []) {
    if (!isVoiceServiceAvailable()) throw new Error('Voice storage unavailable');
    const bytes = decode(voice.base64), id = voiceIds.get(voice.id)!;
    await withMediaWriteFence(version, async () => {
      await beginVoiceWrite({ id, sourceIds: [...(sourceIdsByVoice.get(voice.id) || [])], memoryGeneration });
      stagedVoiceIds.push(id);
      const row = (await db.keyval.get(VOICE_WRITE_PREFIX + id))?.value as VoiceWriteRecord | undefined;
      if (!row) throw new Error('Backup voice registration failed.');
      stagedVoiceRecords.set(id, row);
      if (!await saveVoiceFile(id, bytes)) throw new Error('Backup voice write failed');
      const saved = await loadVoiceFile(id);
      if (!saved || !equal(bytes, saved)) throw new Error('Backup voice verification failed');
    }, memoryGeneration);
  }
  if (Array.isArray(messages)) for (const message of messages) {
    if (message.imageId) {
      const oldId = message.imageId;
      if (!imageIds.has(oldId) && !missingImages.has(oldId)) missingImages.set(oldId, uniqueId('img_missing'));
      message.imageId = imageIds.get(oldId) || missingImages.get(oldId);
    }
    if (message.voiceFileId) {
      const oldId = message.voiceFileId;
      message.voiceFileId = remapVoice(oldId);
    }
    if (message.image && !message.imageId) {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(message.image);
      if (!match) throw new Error('Invalid legacy inline image');
      const bytes = decode(match[2]), id = uniqueId('img_restore');
      await imageService.saveImageWithId(id, message.image, true, version, typeof message.id === 'string' && message.id ? [message.id] : []);
      const saved = await imageService.getImageBase64(id);
      if (!saved || !equal(bytes, decode(saved.split(',')[1]))) throw new Error('Legacy image verification failed');
      message.imageId = id;
      delete message.image;
    }
  }
  let hooks: PreparedBackupMediaHooks | undefined;
  if (media.ringtone) {
    if (!isVoiceServiceAvailable()) throw new Error('Ringtone storage unavailable');
    const ringtone = media.ringtone;
    if (!/^(mp3|wav|ogg|m4a|aac|flac)$/i.test(ringtone.ext)) throw new Error('Invalid ringtone format');
    const bytes = decode(ringtone.base64);
    hooks = {
      snapshot: snapshotRingtone,
      commit: async id => {
        await writeRingtone({ present: true, base64: ringtone.base64, ext: ringtone.ext, originalName: ringtone.originalName }, id);
        const saved = await loadRingtoneFileWithName();
        if (!saved || !equal(bytes, saved.buffer)) throw new Error('Ringtone verification failed');
      },
    };
  }
  const entryMap = new Map(remappedEntries.map(entry => [entry.key, entry]));
  for (const [id, row] of stagedVoiceRecords) {
    const entryKey = VOICE_WRITE_PREFIX + id;
    const imported = entryMap.get(entryKey)?.value;
    const prior = isVoiceWriteRecord(entryKey, imported) ? imported : undefined;
    entryMap.set(entryKey, { key: entryKey, value: { ...row,
      ...(prior?.taskId ? { taskId: prior.taskId } : {}), ...(prior ? { attempt: prior.attempt } : {}) } });
  }
  const packed = await packExecutionState([...entryMap.values()]);
  if (json.data) json.data.executionState = packed;
  json.executionState = packed;
  return { json, hooks, missingMediaCount: missingImages.size + missingVoices.size, releaseVoiceLeases };
  } catch (error) {
    await releaseVoiceLeases();
    throw error;
  }
}
