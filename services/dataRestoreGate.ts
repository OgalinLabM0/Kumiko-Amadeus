/** A durable, synchronous fence shared by renderer windows. The restore journal
 * in IndexedDB is authoritative; this latch also stops non-database side effects. */
export const DATA_RESTORE_GATE_KEY = 'kumiko_data_restore_gate_v1';
export const DATA_RESTORE_EVENT = 'kumiko:data-restore';
const VERSION_KEY = 'kumiko_data_restore_generation_v1';
export interface DataRestoreGate { id: string; startedAt: number; phase: 'preparing' | 'committed'; kind?: 'restore' | 'reset'; }
let ownedId: string | null = null;
let fallback: string | null = null;
let fallbackVersion = '';
const permittedTransactions = new WeakSet<object>();
// An already-open window must reload its in-memory store after another window
// replaces the dataset. Keep this synchronous so writes cannot race React.
let acceptedVersion = getDataRestoreVersion();

function getStoredGate(): string {
  try { return typeof localStorage === 'undefined' ? fallback || '' : localStorage.getItem(DATA_RESTORE_GATE_KEY) || ''; }
  catch { return 'unavailable'; }
}
export function requiresDataRestoreReload(): boolean {
  return !getStoredGate() && getDataRestoreVersion() !== acceptedVersion;
}
export function getDataRestoreSnapshot(): string {
  return getStoredGate() || (requiresDataRestoreReload() ? 'reload-required' : '');
}
export function isDataRestoreBlocked(): boolean { return !!getDataRestoreSnapshot(); }
export function getDataRestoreVersion(): string {
  try { return typeof localStorage === 'undefined' ? fallbackVersion : localStorage.getItem(VERSION_KEY) || ''; }
  catch { return 'unavailable'; }
}
export function assertDataWritesAllowed(): void {
  if (isDataRestoreBlocked()) throw new Error('Data restoration is in progress; changes are paused to protect your data.');
}
export function readDataRestoreGate(): DataRestoreGate | null {
  const raw = getStoredGate();
  if (!raw) return null;
  const value = JSON.parse(raw);
  if (!value || typeof value.id !== 'string' || !Number.isFinite(value.startedAt)
    || !['preparing', 'committed'].includes(value.phase)
    || (value.kind !== undefined && !['restore', 'reset'].includes(value.kind))) throw new Error('Invalid restore recovery marker.');
  return value;
}
function publish(value: DataRestoreGate | null): void {
  const serialized = value ? JSON.stringify(value) : null;
  // Storage failure must abort before changing the live dataset.
  if (typeof localStorage === 'undefined') fallback = serialized;
  else if (serialized) localStorage.setItem(DATA_RESTORE_GATE_KEY, serialized);
  else localStorage.removeItem(DATA_RESTORE_GATE_KEY);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DATA_RESTORE_EVENT));
}
export function beginDataRestore(id: string, kind?: 'restore' | 'reset'): void {
  assertDataWritesAllowed();
  if (typeof localStorage !== 'undefined') localStorage.setItem(VERSION_KEY, id);
  else fallbackVersion = id;
  acceptedVersion = id;
  publish({ id, startedAt: Date.now(), phase: 'preparing', ...(kind ? { kind } : {}) });
  ownedId = id;
}
export function ownDataRestoreRecovery(id: string): void {
  if (readDataRestoreGate()?.id !== id) throw new Error('Restore recovery identity changed.');
  acceptedVersion = getDataRestoreVersion();
  ownedId = id;
}
export function markDataRestoreCommitted(id: string): void {
  const current = readDataRestoreGate();
  if (ownedId !== id || current?.id !== id) throw new Error('Restore identity changed.');
  publish({ ...current, phase: 'committed' });
}
export function finishDataRestore(id: string, requireReload = false): void {
  if (ownedId !== id || readDataRestoreGate()?.id !== id) throw new Error('Restore identity changed.');
  // The resetting renderer still holds the pre-reset React store. Make it
  // stale before publishing the cleared gate so autosave cannot repopulate it.
  if (requireReload) acceptedVersion = '';
  publish(null);
  ownedId = null;
}
export function permitDataRestoreTransaction(transaction: { idbtrans: object }, id: string): void {
  if (ownedId !== id || readDataRestoreGate()?.id !== id) throw new Error('Restore write is not owned by this session.');
  permittedTransactions.add(transaction.idbtrans);
}
export function assertDataTransactionAllowed(transaction: object): void {
  if (isDataRestoreBlocked() && !permittedTransactions.has(transaction)) assertDataWritesAllowed();
}
export function subscribeDataRestore(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === DATA_RESTORE_GATE_KEY || event.key === VERSION_KEY || event.key === null) callback();
  };
  window.addEventListener(DATA_RESTORE_EVENT, callback);
  window.addEventListener('storage', onStorage);
  return () => { window.removeEventListener(DATA_RESTORE_EVENT, callback); window.removeEventListener('storage', onStorage); };
}
