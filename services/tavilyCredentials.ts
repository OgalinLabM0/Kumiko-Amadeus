import { hasNativeCredentials, invokeCredential } from './nativeCredentials';
import { queueLocalStoragePreferenceSync } from './preferencesSync';
import { assertDataWritesAllowed, getDataRestoreVersion } from './dataRestoreGate';
import type { TaskContext } from './taskRuntime';
import { runStandaloneTransport, runTaskTransport } from './taskGateway';

const KEY = 'tavily_api_key';
const ENDPOINT = 'https://search.omkk.org/';
const PREFIX = 'vault:';
let browserSessionKey = '';
export function clearBrowserSearchCredential(): void { browserSessionKey = ''; }
export function hasTavilyCredential(): boolean { return !!browserSessionKey || !!localStorage.getItem(KEY); }
export function removeTavilyCredential(): void {
  assertDataWritesAllowed();
  const previous = localStorage.getItem(KEY);
  if (previous && !previous.startsWith(PREFIX)) {
    const archiveKey = 'kumiko_legacy_tavily_key_' + crypto.randomUUID();
    localStorage.setItem(archiveKey, previous);
    if (localStorage.getItem(archiveKey) !== previous) throw new Error('Existing search credential could not be preserved.');
  }
  queueLocalStoragePreferenceSync(KEY, null);
  if (localStorage.getItem(KEY) !== null) throw new Error('Search credential could not be removed from configuration.');
  browserSessionKey = '';
}
export async function saveTavilyCredential(secret: string): Promise<void> {
  assertDataWritesAllowed();
  if (!secret.trim()) throw new Error('API Key is empty.');
  if (!hasNativeCredentials()) {
    const previous = localStorage.getItem(KEY);
    if (previous) {
      const archiveKey = 'kumiko_legacy_tavily_key_' + crypto.randomUUID();
      localStorage.setItem(archiveKey, previous);
      if (localStorage.getItem(archiveKey) !== previous) throw new Error('Existing search credential could not be preserved.');
      localStorage.removeItem(KEY);
      if (localStorage.getItem(KEY) !== null) throw new Error('Existing search credential could not be isolated.');
    }
    browserSessionKey = secret; return;
  }
  assertDataWritesAllowed(); const generation = getDataRestoreVersion();
  const before = localStorage.getItem(KEY);
  let value = secret;
  if (hasNativeCredentials()) {
    const result = await invokeCredential('store', { purpose: 'tavily', endpoint: ENDPOINT, secret });
    if (!result?.success || typeof result.handle !== 'string') throw new Error(result?.error || 'Secure storage failed.');
    value = PREFIX + result.handle;
  }
  assertDataWritesAllowed();
  if (generation !== getDataRestoreVersion() || localStorage.getItem(KEY) !== before) throw new Error('Search settings changed while saving.');
  queueLocalStoragePreferenceSync(KEY, value);
  if (localStorage.getItem(KEY) !== value) throw new Error('Search settings could not be verified.');
}
export async function requestTavily(operation: 'search' | 'usage', query = '', signal?: AbortSignal, taskContext?: TaskContext): Promise<any> {
  let key = (!hasNativeCredentials() ? browserSessionKey : '') || localStorage.getItem(KEY) || '';
  if (!key) throw new Error('请先在设置中填写 Tavily API Key 以启用搜索');
  if (!hasNativeCredentials() && key.startsWith(PREFIX)) throw new Error('Protected credential is unavailable on this device.');
  if (hasNativeCredentials() && !key.startsWith(PREFIX)) { await saveTavilyCredential(key); key = localStorage.getItem(KEY) || ''; }
  const captured = key;
  const assertCurrent = () => {
    const current = (!hasNativeCredentials() ? browserSessionKey : '') || localStorage.getItem(KEY) || '';
    if (current !== captured) throw new Error('Search configuration changed during task.');
  };
  const execute = async (requestSignal: AbortSignal): Promise<any> => {
  if (hasNativeCredentials()) {
    if (!key.startsWith(PREFIX)) throw new Error('Secure search credential migration failed.');
    if (requestSignal.aborted) throw new DOMException('Aborted', 'AbortError');
    const result = await invokeCredential('tavily', { handle: key.slice(PREFIX.length), operation, query }, requestSignal);
    if (requestSignal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!result?.success) throw new Error(result?.error || 'Search failed.');
    if (result.result.status < 200 || result.result.status >= 300) throw new Error(`Search server returned ${result.result.status}`);
    return JSON.parse(result.result.body);
  }
  const url = new URL(operation === 'search' ? '/api/search' : '/api/usage', ENDPOINT);
  if (operation === 'search') url.searchParams.set('q', query);
  const response = await fetch(url, { headers: { 'x-api-key': key }, signal: requestSignal, redirect: 'error' });
  if (!response.ok) throw new Error(`Search server returned ${response.status}`);
  return response.json();
  };
  const target = { provider: 'tavily', operation: 'search-' + operation, configRevision: 'captured' };
  return taskContext ? runTaskTransport({ ...taskContext, signal }, target, execute, assertCurrent)
    : runStandaloneTransport(target, execute, assertCurrent, signal);
}
