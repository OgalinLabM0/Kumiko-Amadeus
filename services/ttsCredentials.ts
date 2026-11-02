import { hasNativeCredentials, invokeCredential } from './nativeCredentials';
import { assertDataWritesAllowed, getDataRestoreVersion } from './dataRestoreGate';
import { queueLocalStoragePreferenceSync } from './preferencesSync';
const destinations = { fish: 'https://api.fish.audio/v1/tts', vocu: 'https://v1.vocu.ai/api/tts/simple-generate' } as const;
type VoiceService = keyof typeof destinations;
export async function storeTtsCredential(purpose: VoiceService, secret: string): Promise<string> {
  if (!secret.trim()) throw new Error('API Key is empty.');
  if (!hasNativeCredentials()) return secret;
  assertDataWritesAllowed(); const version = getDataRestoreVersion();
  const result = await invokeCredential('store', { purpose, endpoint: destinations[purpose], secret });
  assertDataWritesAllowed();
  if (version !== getDataRestoreVersion() || !result?.success || typeof result.handle !== 'string') throw new Error(result?.error || 'Secure credential storage failed.');
  return 'vault:' + result.handle;
}
export async function requestTts(purpose: VoiceService, secret: string, body: string, model?: string, signal?: AbortSignal): Promise<Response> {
  if (!secret.startsWith('vault:')) {
    assertDataWritesAllowed(); const generation = getDataRestoreVersion();
    const { useAppStore } = await import('../store');
    const field = purpose === 'fish' ? 'fishAudioApiKey' : 'vocuApiKey';
    const before = useAppStore.getState().ttsConfig;
    if (before[field] !== secret) throw new Error('Save the voice credential before use.');
    const replacement = await storeTtsCredential(purpose, secret);
    assertDataWritesAllowed();
    if (generation !== getDataRestoreVersion()) throw new Error('Data changed while migrating voice credentials.');
    const current = useAppStore.getState().ttsConfig;
    if (current[field] !== secret) throw new Error('Voice settings changed while migrating credentials.');
    const next = { ...current, [field]: replacement };
    useAppStore.getState().setTtsConfig(next);
    queueLocalStoragePreferenceSync('kumiko_tts_config', JSON.stringify(next), { applyToStore: false });
    let persisted: any;
    try { persisted = JSON.parse(localStorage.getItem('kumiko_tts_config') || '{}'); } catch { /* checked below */ }
    if (persisted?.[field] !== replacement) {
      if (useAppStore.getState().ttsConfig[field] === replacement) useAppStore.getState().setTtsConfig(current);
      throw new Error('Voice credential migration could not be verified.');
    }
    secret = replacement;
  }
  const result = await invokeCredential('request', { handle: secret.slice(6), purpose, expectedEndpoint: destinations[purpose], body, model }, signal);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!result?.success) throw new Error(result?.error || 'Protected voice request failed.');
  const bytes = Uint8Array.from(atob(result.result.body), c => c.charCodeAt(0));
  return new Response(bytes, { status: result.result.status, headers: { 'content-type': result.result.contentType } });
}
