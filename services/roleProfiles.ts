import type { AIProvider } from '../types';
import { getDefaultEndpoint, resolveTransportProvider } from './appConfig';
import { hasNativeCredentials, invokeCredential } from './nativeCredentials';
import { assertDataWritesAllowed, getDataRestoreVersion } from './dataRestoreGate';

type Purpose = 'gemini' | 'openai' | 'anthropic';
const session = new Map<string, { purpose: Purpose; endpoint: string; secret: string }>();

export function modelConnectionDestination(provider: AIProvider, baseUrl?: string): { purpose: Purpose; endpoint: string } {
  const transport = resolveTransportProvider(provider, baseUrl);
  const purpose: Purpose = transport === 'gemini' ? 'gemini' : transport === 'anthropic' ? 'anthropic' : 'openai';
  let endpoint = baseUrl?.trim() || (purpose === 'gemini' ? 'https://generativelanguage.googleapis.com/' : getDefaultEndpoint(provider));
  if (purpose === 'gemini') endpoint = endpoint.replace(/\/v1beta\/?$/, '').replace(/\/v1alpha\/?$/, '').replace(/\/v1\/?$/, '').replace(/\/$/, '') + '/';
  else endpoint = endpoint.replace(/\/$/, '');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
    Array.from(url.searchParams.keys()).some(key => /key|token|secret|authorization/i.test(key))) throw new Error('Invalid credential endpoint.');
  return { purpose, endpoint: url.href };
}

export async function storeModelConnectionCredential(provider: AIProvider, baseUrl: string | undefined, secret: string): Promise<string> {
  if (!secret.trim()) throw new Error('Enter an API key.');
  assertDataWritesAllowed();
  const generation = getDataRestoreVersion();
  const destination = modelConnectionDestination(provider, baseUrl);
  if (hasNativeCredentials()) {
    const result = await invokeCredential('store', { ...destination, secret });
    assertDataWritesAllowed();
    if (getDataRestoreVersion() !== generation) throw new Error('Data changed while saving credentials.');
    if (!result?.success || typeof result.handle !== 'string') throw new Error(result?.error || 'Unable to protect credential.');
    return 'vault:' + result.handle;
  }
  const id = crypto.randomUUID();
  session.set(id, { ...destination, secret });
  return 'session:' + id;
}

export function resolveModelSessionCredential(reference: string, provider: AIProvider, baseUrl?: string): string {
  if (!reference.startsWith('session:')) return reference;
  const entry = session.get(reference.slice(8));
  const destination = modelConnectionDestination(provider, baseUrl);
  if (!entry || entry.endpoint !== destination.endpoint || entry.purpose !== destination.purpose) throw new Error('Session credential unavailable or bound to another endpoint.');
  return entry.secret;
}
export function clearModelSessionCredentials(): void { session.clear(); }
