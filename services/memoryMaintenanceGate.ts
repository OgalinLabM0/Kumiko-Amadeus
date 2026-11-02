import { db } from './db';
export const MEMORY_GENERATION_KEY = 'kumiko_memory_generation_v1';
export const MEMORY_MAINTENANCE_KEY = 'kumiko_memory_maintenance_v1';
const EVENT = 'kumiko:memory-maintenance';
let fallbackGeneration = 'initial';
let fallbackGate = '';
let acceptedGeneration = 'initial';
let ownedId: string | undefined;
const permittedTransactions = new WeakSet<object>();
const read = (key: string, fallback: string): string => {
  try { return typeof localStorage === 'undefined' ? fallback : localStorage.getItem(key) || fallback; }
  catch { throw new Error('Memory protection state is unavailable.'); }
};
acceptedGeneration = getMemoryGeneration();
export function getMemoryGeneration(): string { return read(MEMORY_GENERATION_KEY, fallbackGeneration); }
export function requiresMemoryReload(): boolean { return !read(MEMORY_MAINTENANCE_KEY, fallbackGate) && getMemoryGeneration() !== acceptedGeneration; }
export function getMemoryMaintenanceSnapshot(): string { return read(MEMORY_MAINTENANCE_KEY, fallbackGate) || (requiresMemoryReload() ? 'reload-required' : ''); }
export function isMemoryMaintenanceBlocked(): boolean {
  try { return !!read(MEMORY_MAINTENANCE_KEY, fallbackGate) || getMemoryGeneration() !== acceptedGeneration; } catch { return true; }
}
export function ownMemoryMaintenance(id: string): void {
  if (read(MEMORY_MAINTENANCE_KEY, fallbackGate) !== id) throw new Error('Memory maintenance ownership changed.');
  ownedId = id;
}
export function permitMemoryMaintenanceTransaction(transaction: { idbtrans: object }, id: string): void {
  if (ownedId !== id || read(MEMORY_MAINTENANCE_KEY, fallbackGate) !== id) throw new Error('Memory maintenance write is not owned.');
  permittedTransactions.add(transaction.idbtrans);
}
export function assertMemoryTransactionAllowed(transaction: object): void {
  if (!permittedTransactions.has(transaction)) assertMemoryAvailable();
}
export function assertMemoryAvailable(expectedGeneration?: string): void {
  if (isMemoryMaintenanceBlocked()) throw new Error('Memory maintenance is in progress.');
  if (expectedGeneration !== undefined && getMemoryGeneration() !== expectedGeneration) throw new Error('Memory input was superseded.');
}
export async function assertMemoryGenerationCurrent(expected: string): Promise<void> {
  assertMemoryAvailable(expected);
  const [generation, gate] = await Promise.all([db.keyval.get(MEMORY_GENERATION_KEY), db.keyval.get(MEMORY_MAINTENANCE_KEY)]);
  if (gate?.value || (generation?.value || 'initial') !== expected) throw new Error('Memory generation changed or requires maintenance.');
}
function publish(generation: string, gate: string): void {
  if (typeof localStorage !== 'undefined') {
    // Set the latch before advancing the generation, so other windows fail closed.
    if (gate) localStorage.setItem(MEMORY_MAINTENANCE_KEY, gate);
    localStorage.setItem(MEMORY_GENERATION_KEY, generation);
    if (!gate) localStorage.removeItem(MEMORY_MAINTENANCE_KEY);
  }
  fallbackGeneration = generation; fallbackGate = gate;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT));
}
/** Call only after a durable maintenance journal was prepared. */
export function publishMemoryMaintenance(generation: string, correctionId: string): void { publish(generation, correctionId); }
/** DB is authoritative on startup, including recovery after a crashed window. */
export async function synchronizeMemoryMaintenanceGate(accept = false): Promise<void> {
  const [generation, gate] = await Promise.all([db.keyval.get(MEMORY_GENERATION_KEY), db.keyval.get(MEMORY_MAINTENANCE_KEY)]);
  if (accept) acceptedGeneration = generation?.value || 'initial';
  publish(generation?.value || 'initial', typeof gate?.value === 'string' ? gate.value : '');
}
export function subscribeMemoryMaintenance(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: StorageEvent) => {
    if (event.key === MEMORY_GENERATION_KEY || event.key === MEMORY_MAINTENANCE_KEY || event.key === null) callback();
  };
  window.addEventListener(EVENT, callback); window.addEventListener('storage', listener);
  return () => { window.removeEventListener(EVENT, callback); window.removeEventListener('storage', listener); };
}
