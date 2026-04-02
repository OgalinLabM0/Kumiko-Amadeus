import type { TtsConfig, EmotionType } from '../types';
import type { TtsSynthesisResult } from './fishAudioService';
import { EMOTION_TO_SOVITS_REF } from '../constants';

let lastRefEmotion: string | null = null;

export async function checkGenieHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/tts`, { method: 'GET', signal: AbortSignal.timeout(3000) });
    return res.status === 422 || res.status === 200 || res.status === 405;
  } catch {
    return false;
  }
}

export async function setGptWeights(baseUrl: string, weightsPath: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/set_gpt_weights?weights_path=${encodeURIComponent(weightsPath)}`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function setSovitsWeights(baseUrl: string, weightsPath: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/set_sovits_weights?weights_path=${encodeURIComponent(weightsPath)}`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function loadGenieCharacter(_baseUrl: string, _config: {
  characterName: string; modelDir: string; language: string;
}): Promise<{ success: boolean; error?: string }> {
  return { success: true };
}

export async function synthesizeWithSovits(
  text: string,
  baseUrl: string,
  refAudioPath: string,
  promptText: string,
  options: {
    speed?: number;
    topK?: number;
    topP?: number;
    temperature?: number;
    textSplitMethod?: string;
    fragmentInterval?: number;
  } = {},
): Promise<TtsSynthesisResult> {
  const body: Record<string, unknown> = {
    text,
    text_lang: 'ja',
    ref_audio_path: refAudioPath,
    prompt_text: promptText,
    prompt_lang: 'ja',
    speed_factor: options.speed ?? 1.0,
    top_k: options.topK ?? 15,
    top_p: options.topP ?? 1,
    temperature: options.temperature ?? 1,
    text_split_method: options.textSplitMethod ?? 'cut0',
    fragment_interval: options.fragmentInterval ?? 0.3,
    media_type: 'wav',
    streaming_mode: false,
    batch_size: 1,
    parallel_infer: true,
    repetition_penalty: 1.35,
  };

  const res = await fetch(`${baseUrl}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`GPT-SoVITS TTS failed: HTTP ${res.status} ${errText}`);
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
  const baseUrl = `http://127.0.0.1:${ttsConfig.sovitsPort || 9880}`;
  const refDir = ttsConfig.sovitsRefAudioDir || '';
  const refKey = EMOTION_TO_SOVITS_REF[emotion] || 'neutral';

  const separator = refDir.includes('/') ? '/' : '\\';
  const refAudioPath = refDir ? `${refDir}${separator}${refKey}.wav` : '';
  const promptText = text.slice(0, 30);

  return synthesizeWithSovits(text, baseUrl, refAudioPath, promptText, {
    speed: ttsConfig.speed,
    topK: ttsConfig.sovitsTopK,
    topP: ttsConfig.sovitsTopP,
    temperature: ttsConfig.sovitsTemperature,
    textSplitMethod: ttsConfig.sovitsTextSplitMethod,
    fragmentInterval: ttsConfig.sovitsFragmentInterval,
  });
}
