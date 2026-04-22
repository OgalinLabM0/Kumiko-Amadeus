import type { TtsConfig, EmotionType } from '../types';
import type { TtsSynthesisResult } from './fishAudioService';
import { EMOTION_TO_SOVITS_REF } from '../constants';
import type { SovitsRefVariant } from '../constants';

let lastRefFile: string | null = null;

export async function checkGenieHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/tts`, { method: 'GET', signal: AbortSignal.timeout(3000) });
    // P1 #18: previously we returned `!!res.status`, which was *always* truthy for any
    // HTTP response (including 404 / 500), so "healthy" showed even when the server
    // was up but the TTS route was unreachable. `GET /tts` without args returns 405
    // Method Not Allowed on a live GPT-SoVITS server, which is also an acceptable
    // signal of liveness — accept 2xx or 405, treat anything else as down.
    return res.ok || res.status === 405;
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
    signal: AbortSignal.timeout(90000),
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

/**
 * Detect whether the user is currently running a GPT-SoVITS v3 or v4
 * checkpoint. Official upstream (`TTS_infer_pack/TTS.py` → `v3v4set`)
 * forbids `no_prompt_text` mode on v3/v4 weights — calling ref-free would
 * throw `NO_PROMPT_ERROR`. When this returns true the UI should lock
 * `sovitsUseRefText` to ON and the inference layer forces prompt_text
 * regardless of the persisted toggle.
 *
 * Matches the same `v2ProPlus`-safe substring heuristic used in the
 * settings UI, so the two layers stay consistent.
 */
export function isSovitsV3V4Model(
  ttsConfig: Pick<TtsConfig, 'sovitsGptWeights' | 'sovitsVitsWeights'>,
): boolean {
  const gpt = ttsConfig.sovitsGptWeights || '';
  const vits = ttsConfig.sovitsVitsWeights || '';
  return /v[34]/i.test(gpt) || /v[34]/i.test(vits);
}

export async function genieTtsWithEmotion(
  text: string, emotion: EmotionType, ttsConfig: TtsConfig,
  voiceVariant?: string,
): Promise<TtsSynthesisResult> {
  const baseUrl = `http://127.0.0.1:${ttsConfig.sovitsPort || 9880}`;
  const refDir = ttsConfig.sovitsRefAudioDir || '';

  const variants: SovitsRefVariant[] = EMOTION_TO_SOVITS_REF[emotion] || EMOTION_TO_SOVITS_REF['neutral'];

  let pick: SovitsRefVariant;
  if (voiceVariant) {
    const allVariants = Object.values(EMOTION_TO_SOVITS_REF).flat();
    const specified = allVariants.find(v => v.file === voiceVariant);
    pick = specified || variants[Math.floor(Math.random() * variants.length)];
  } else {
    pick = variants[Math.floor(Math.random() * variants.length)];
    if (variants.length > 1 && lastRefFile === pick.file) {
      pick = variants[(variants.indexOf(pick) + 1) % variants.length];
    }
  }
  lastRefFile = pick.file;

  const separator = refDir.includes('/') ? '/' : '\\';
  const refAudioPath = refDir ? `${refDir}${separator}${pick.file}.wav` : '';

  // Resolve prompt_text:
  // - v3/v4 weights: upstream forbids no_prompt_text mode → force prompt.
  // - Otherwise honour persisted toggle: OFF → "" (ref-free), ON → custom
  //   override if non-empty, else the built-in default.
  const v3v4 = isSovitsV3V4Model(ttsConfig);
  const useRefText = v3v4 || (ttsConfig.sovitsUseRefText ?? false);
  const customPrompt = ttsConfig.sovitsCustomPrompts?.[pick.file];
  const promptText = useRefText
    ? (customPrompt && customPrompt.trim().length > 0 ? customPrompt : pick.promptText)
    : '';

  return synthesizeWithSovits(text, baseUrl, refAudioPath, promptText, {
    speed: ttsConfig.speed,
    topK: ttsConfig.sovitsTopK,
    topP: ttsConfig.sovitsTopP,
    temperature: ttsConfig.sovitsTemperature,
    textSplitMethod: ttsConfig.sovitsTextSplitMethod,
    fragmentInterval: ttsConfig.sovitsFragmentInterval,
  });
}
