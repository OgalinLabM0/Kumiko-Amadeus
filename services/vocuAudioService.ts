import type { EmotionType, TtsConfig } from '../types';
import { TtsError, type TtsSynthesisResult } from './fishAudioService';

// Plan C: strong-emotion set. When `vocuEmotionBoost` is enabled and the current
// emotion belongs to this set, preset is overridden to 'vivid' (only works on
// Vocu V3.0 voices). Other emotions keep the user-selected preset.
const VIVID_EMOTIONS: ReadonlySet<EmotionType> = new Set<EmotionType>([
  'happy', 'angry', 'sad', 'surprised',
]);

const VOCU_ENDPOINT = 'https://v1.vocu.ai/api/tts/simple-generate';

// Vocu returns a direct MP3 URL in data.audio; we GET it ourselves to obtain the audio bytes.
// ~128kbps MP3 → bytes / 16000 gives a rough seconds estimate.
function estimateMp3Duration(byteLength: number): number {
  return Math.max(1, Math.round(byteLength / 16_000));
}

function vocuStatusToKind(status: number): 'auth' | 'payment' | 'validation' | 'unknown' {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'payment';
  if (status === 400 || status === 422) return 'validation';
  return 'unknown';
}

export async function synthesizeWithVocu(
  text: string,
  config: TtsConfig,
  emotion: EmotionType = 'neutral',
): Promise<TtsSynthesisResult> {
  if (!config.vocuApiKey) {
    throw new TtsError('auth', 'Vocu AI API key is not configured');
  }
  if (!config.vocuVoiceId) {
    throw new TtsError('validation', 'Vocu voice ID is not configured');
  }

  // Preset decision: when emotionBoost is on and the emotion is "strong",
  // switch to 'vivid' (requires V3.0 voice). Otherwise use the user setting.
  const boostActive = Boolean(config.vocuEmotionBoost) && VIVID_EMOTIONS.has(emotion);
  const preset: 'balance' | 'vivid' = boostActive ? 'vivid' : (config.vocuPreset || 'balance');

  const clampedSpeed = Math.min(2, Math.max(0.5, config.speed ?? 1));

  const body = {
    voiceId: config.vocuVoiceId,
    text,
    promptId: config.vocuPromptId || 'default',
    preset,
    speechRate: clampedSpeed,
    flash: Boolean(config.vocuFlash),
    seed: -1,
    srt: false,
  };

  let res: Response;
  try {
    res = await fetch(VOCU_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.vocuApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    throw new TtsError('network', `Vocu network error: ${(err as Error).message}`);
  }

  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    throw new TtsError(
      vocuStatusToKind(res.status),
      `Vocu AI TTS failed (${res.status}): ${detail.slice(0, 300)}`,
      res.status,
    );
  }

  let json: any;
  try {
    json = await res.json();
  } catch (err) {
    throw new TtsError('unknown', `Vocu response is not JSON: ${(err as Error).message}`);
  }

  const audioUrl: string | undefined =
    json?.data?.audio
    || json?.data?.streamUrl
    || json?.data?.stream_url
    || json?.audio
    || json?.streamUrl;
  if (!audioUrl || typeof audioUrl !== 'string') {
    throw new TtsError('unknown', `Vocu response missing audio URL: ${JSON.stringify(json).slice(0, 300)}`);
  }

  let audioRes: Response;
  try {
    audioRes = await fetch(audioUrl, { signal: AbortSignal.timeout(90_000) });
  } catch (err) {
    throw new TtsError('network', `Vocu audio fetch network error: ${(err as Error).message}`);
  }
  if (!audioRes.ok) {
    throw new TtsError(
      vocuStatusToKind(audioRes.status),
      `Vocu audio fetch failed (${audioRes.status})`,
      audioRes.status,
    );
  }
  const audio = await audioRes.arrayBuffer();
  if (audio.byteLength < 128) {
    throw new TtsError('unknown', `Vocu returned suspiciously small audio (${audio.byteLength} bytes)`);
  }

  return {
    audio,
    durationEstimate: estimateMp3Duration(audio.byteLength),
  };
}
