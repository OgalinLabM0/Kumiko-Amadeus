import { db } from './db';
import { beginDataRestore, finishDataRestore, ownDataRestoreRecovery,
  permitDataRestoreTransaction, readDataRestoreGate, DATA_RESTORE_GATE_KEY } from './dataRestoreGate';
import { isCapacitorNative, getCapacitorPlatform } from './environment';
import { cancelAndroidAlarm, listScheduledAndroidAlarms } from './androidAlarmService';
import { withReminderNativeAlarmLock } from './reminderNativeCancellation';
import { clearSessionBackupPassword } from './backupProtection';
import { withMediaResetFence } from './mediaWriteFence';

const VERSION_KEY = 'kumiko_data_restore_generation_v1';
const MEDIA_GENERATION_KEY = 'kumiko_media_reset_generation_v1';
const desktop = () => typeof window !== 'undefined' ? window.electronAPI : undefined;
async function exclusive<T>(work: () => Promise<T>, wait: boolean): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request('kumiko-data-restore-v1',
    { mode: 'exclusive', ifAvailable: !wait }, lock => {
      if (!lock) throw new Error('Another window is changing data.');
      return work();
    });
  if (typeof window !== 'undefined') throw new Error('Safe data reset locking is unavailable.');
  return work();
}
async function invoke(channel: string, payload?: unknown): Promise<any> {
  const result = await desktop()!.invoke(channel, payload);
  if (!result?.success) throw new Error(result?.error || `${channel} failed`);
  return result;
}

async function clearDesktopMedia(): Promise<void> {
  const listed = await invoke('images:list');
  if (!Array.isArray(listed.files)) throw new Error('Could not list image files.');
  for (const file of listed.files) await invoke('images:delete', { imageId: file.id });
  const remaining = await invoke('images:list');
  if (!Array.isArray(remaining.files) || remaining.files.length) throw new Error('Some image files were not removed.');
  const voices = await invoke('voice:clear-all');
  if (voices.errors) throw new Error('Some voice files were not removed.');
  const voiceList = await invoke('voice:list');
  if (!Array.isArray(voiceList.files) || voiceList.files.length) throw new Error('Some voice files remain.');
  await invoke('ringtone:delete');
}

async function clearMobileMedia(): Promise<void> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  for (const dir of ['images', 'voices', 'ringtones']) {
    // Create the app-owned directory if absent; any other failure stops reset.
    try { await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true }); }
    catch (error) { if (!/exist|already|0010|0008/i.test(String(error))) throw error; }
    const matches = (name: string) => dir === 'images' ? /^[\w-]+\.(jpg|jpeg|png|webp|gif)$/i.test(name)
        : dir === 'voices' ? /^[\w-]+\.mp3$/i.test(name)
          : /^custom\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(name);
    const listing = await Filesystem.readdir({ path: dir, directory: Directory.Data });
    for (const file of listing.files) if (matches(file.name))
      await Filesystem.deleteFile({ path: `${dir}/${file.name}`, directory: Directory.Data });
    const remaining = await Filesystem.readdir({ path: dir, directory: Directory.Data });
    if (remaining.files.some(file => matches(file.name))) throw new Error(`Some ${dir} files remain.`);
  }
}

async function clearMobileNotifications(): Promise<void> {
  if (getCapacitorPlatform() === 'android') {
    const ids = await listScheduledAndroidAlarms();
    if (!ids) throw new Error('Could not list scheduled Android alarms.');
    for (const id of ids) if (!await cancelAndroidAlarm(id)) throw new Error('Could not cancel an Android alarm.');
    const remaining = await listScheduledAndroidAlarms();
    if (!remaining || remaining.length) throw new Error('Android alarms remain scheduled.');
  }
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  const pending = await LocalNotifications.getPending();
  if (pending.notifications.length) await LocalNotifications.cancel({ notifications: pending.notifications.map(n => ({ id: n.id })) });
  const delivered = await LocalNotifications.getDeliveredNotifications();
  if (delivered.notifications.length) await LocalNotifications.removeDeliveredNotifications({ notifications: delivered.notifications });
}

async function resume(id: string): Promise<void> {
  if (isCapacitorNative() && getCapacitorPlatform() === 'android')
    return withReminderNativeAlarmLock(() => withMediaResetFence(() => resumeLocked(id)));
  return withMediaResetFence(() => resumeLocked(id));
}
async function resumeLocked(id: string): Promise<void> {
  ownDataRestoreRecovery(id);
  if (typeof localStorage !== 'undefined') localStorage.setItem(MEDIA_GENERATION_KEY, id);
  clearSessionBackupPassword();
  const [{ clearBrowserModelCredentials }, { clearBrowserSearchCredential }] = await Promise.all([
    import('./llmCore'), import('./tavilyCredentials'),
  ]);
  clearBrowserModelCredentials(); clearBrowserSearchCredential();
  if (desktop()) {
    await invoke('rag:restore-lock', { id, action: 'begin', kind: 'reset' });
    // These operations are allowed only to the lock owner with this token.
    await invoke('rag:sync-messages', { messages: [], replaceAll: true, restoreSessionId: id });
    const memory = await invoke('rag:restore', { vectors: [], restoreSessionId: id });
    if (memory.count !== 0) throw new Error('Native memory was not emptied.');
    await clearDesktopMedia();
    await invoke('credentials:clear-user-credentials', { restoreSessionId: id });
    await invoke('backup:clear-protection', { restoreSessionId: id });
  } else if (isCapacitorNative()) {
    await clearMobileNotifications();
    await clearMobileMedia();
    if (getCapacitorPlatform() === 'android') {
      const { clearAndroidCredentials } = await import('./nativeCredentials');
      await clearAndroidCredentials();
    }
  }
  await db.transaction('rw', db.tables, async tx => {
    permitDataRestoreTransaction(tx, id);
    for (const table of db.tables) await table.clear();
    await db.keyval.put({ key: 'kumiko_turn_epoch_v1', value: id });
  });
  if (typeof caches !== 'undefined') for (const name of await caches.keys()) {
    if (!await caches.delete(name)) throw new Error('A cache could not be removed.');
  }
  if (typeof localStorage !== 'undefined') {
    for (const key of Object.keys(localStorage)) if (key !== DATA_RESTORE_GATE_KEY && key !== VERSION_KEY && key !== MEDIA_GENERATION_KEY) localStorage.removeItem(key);
  }
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
  if (desktop()) await invoke('rag:restore-lock', { id, action: 'end' });
  finishDataRestore(id, true);
}

/** A reset is irreversible after the user confirms. Its durable gate is its
 * journal, including before any external mutation. Every step is idempotent. */
export async function runDataResetSession(): Promise<void> {
  return exclusive(async () => {
    const id = crypto.randomUUID();
    await db.transaction('rw', db.tables, async tx => {
      beginDataRestore(id, 'reset');
      permitDataRestoreTransaction(tx, id);
    });
    await resume(id);
  }, false);
}
export async function recoverInterruptedDataReset(): Promise<boolean> {
  if (readDataRestoreGate()?.kind !== 'reset') return false;
  return exclusive(async () => {
    const gate = readDataRestoreGate();
    if (gate?.kind !== 'reset') return false;
    await resume(gate.id);
    return true;
  }, true);
}
