import { registerPlugin } from '@capacitor/core';
import { getCapacitorPlatform, isCapacitorNative, isElectron } from './environment';
import { assertDataWritesAllowed } from './dataRestoreGate';
interface NativeCredentials { store(args: any): Promise<any>; request(args: any): Promise<any>; gemini(args: any): Promise<any>; tavily(args: any): Promise<any>; clear(args: any): Promise<any>; version(args: any): Promise<any>; cancel(args: any): Promise<any>; }
const androidCredentials = registerPlugin<NativeCredentials>('KumikoCredentials');
export const hasNativeCredentials = () => isElectron() || (isCapacitorNative() && getCapacitorPlatform() === 'android');
export async function clearAndroidCredentials(): Promise<void> {
  if (!isCapacitorNative() || getCapacitorPlatform() !== 'android') return;
  const result = await androidCredentials.clear({});
  if (!result?.success) throw new Error('Unable to clear protected Android credentials.');
}
export async function invokeCredential(operation: 'store' | 'request' | 'gemini' | 'tavily', args: any, signal?: AbortSignal): Promise<any> {
  assertDataWritesAllowed();
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (isElectron()) {
    if (operation === 'store') return window.electronAPI.invoke('credentials:store', args);
    const requestId = crypto.randomUUID();
    const cancel = () => { void window.electronAPI.invoke('credentials:cancel', { requestId }).catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const pending = window.electronAPI.invoke('credentials:' + operation, { ...args, requestId });
      if (signal?.aborted) cancel();
      return await pending;
    } finally { signal?.removeEventListener('abort', cancel); }
  }
  if (isCapacitorNative() && getCapacitorPlatform() === 'android') {
    try {
      if (operation === 'store') { const version = await androidCredentials.version({}); return await androidCredentials.store({ ...args, generation: version.generation }); }
      const version = await androidCredentials.version({});
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const requestId = crypto.randomUUID();
      const cancel = () => { void androidCredentials.cancel({ requestId }).catch(() => {}); };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        const pending = androidCredentials[operation]({ ...args, requestId, generation: version.generation });
        if (signal?.aborted) cancel();
        return await pending;
      } finally { signal?.removeEventListener('abort', cancel); }
    } catch { return { success: false, error: 'Protected credential operation failed.' }; }
  }
  throw new Error('Native secure credentials are unavailable.');
}
