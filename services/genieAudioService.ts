import type { TtsConfig, EmotionType } from '../types';
import type { TtsSynthesisResult } from './fishAudioService';
import { EMOTION_TO_GENIE_REF } from '../constants';

let lastRefEmotion: string | null = null;

export async function checkGenieHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/docs`, { signal: AbortSignal.timeout(3000) });
    return res.ok || res.status === 200;
  } catch {
    return false;
  }
}

export async function loadGenieCharacter(baseUrl: string, config: {
  characterName: string; modelDir: string; language: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`${baseUrl}/load_character`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        character_name: config.characterName,
        onnx_model_dir: config.modelDir,
        language: config.language,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `HTTP ${res.status}: ${text}` };
    }
    const data = await res.json();
    return { success: true, error: data.message };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

export async function setGenieRefAudio(baseUrl: string, config: {
  characterName: string; audioPath: string; audioText: string; language: string;
}): Promise<void> {
  const res = await fetch(`${baseUrl}/set_reference_audio`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      character_name: config.characterName,
      audio_path: config.audioPath,
      audio_text: config.audioText,
      language: config.language,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`set_reference_audio failed: HTTP ${res.status} ${text}`);
  }
}

export async function synthesizeWithGenie(
  text: string, baseUrl: string, characterName: string, speed?: number,
): Promise<TtsSynthesisResult> {
  const body: Record<string, unknown> = {
    character_name: characterName,
    text,
    split_sentence: true,
  };
  if (speed !== undefined && speed !== 1.0) {
    body.speed_factor = speed;
  }
  const res = await fetch(`${baseUrl}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Genie TTS failed: HTTP ${res.status} ${errText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const sampleRate = 32000;
  const bytesPerSample = 2;
  const durationEstimate = arrayBuffer.byteLength / (sampleRate * bytesPerSample);
  return { audio: arrayBuffer, durationEstimate };
}

export async function genieTtsWithEmotion(
  text: string, emotion: EmotionType, ttsConfig: TtsConfig,
): Promise<TtsSynthesisResult> {
  const baseUrl = `http://127.0.0.1:${ttsConfig.genieServerPort || 8000}`;
  const characterName = ttsConfig.genieCharacterName || 'kumiko';
  const refDir = ttsConfig.genieRefAudioDir || '';
  const language = ttsConfig.genieLanguage || 'jp';

  const refKey = EMOTION_TO_GENIE_REF[emotion] || 'neutral';

  if (refDir && refKey !== lastRefEmotion) {
    const separator = refDir.includes('/') ? '/' : '\\';
    const audioPath = `${refDir}${separator}${refKey}.wav`;

    await setGenieRefAudio(baseUrl, {
      characterName,
      audioPath,
      audioText: text.slice(0, 30),
      language,
    });
    lastRefEmotion = refKey;
  }

  return synthesizeWithGenie(text, baseUrl, characterName, ttsConfig.speed);
}
