// services/ttsConfigSanitize.ts
//
// Single source of truth for "merge an unknown blob onto DEFAULT_TTS_CONFIG
// + clamp ringtone id + ensure ttsBackend / Vocu fields are well-typed".
// Called from:
//
//   - useAppPreferencesSync.handleTtsConfigChange (desktop-initiated save)
//   - any future call site that round-trips TtsConfig through localStorage
//     or IPC
//
// Keeping this pure (no React deps) lets it run in non-component contexts
// without dragging the full hook tree along.
//
// v2.14.1 H.5: previous comment header still referenced
// useMobileMessageSync + the `tts-config:changed` WebSocket frame, both
// of which were deleted in F2B alongside the rest of the PC↔mobile
// pairing infrastructure. Capacitor (Android) now sanitises locally and
// goes straight to Fish Audio (the SoVITS branch below already
// down-converts because there's no PC-loopback reachable from the
// WebView).

import { DEFAULT_TTS_CONFIG } from '../constants';
import type { TtsConfig } from '../types';
import { isCapacitorNative } from './environment';
import { isBuiltInRingtoneId, isCustomRingtoneId } from './voiceFileService';

export function sanitizeTtsConfig(value: unknown): TtsConfig {
  const merged = {
    ...DEFAULT_TTS_CONFIG,
    ...(value && typeof value === 'object' ? (value as Partial<TtsConfig>) : {}),
  } as TtsConfig & Record<string, unknown>;

  if (!isBuiltInRingtoneId(merged.ringtoneFileId) && !isCustomRingtoneId(merged.ringtoneFileId)) {
    merged.ringtoneFileId = DEFAULT_TTS_CONFIG.ringtoneFileId;
  }

  // ttsBackend must be one of the three supported backends; anything else
  // (legacy values, garbled localStorage, future renames) falls back to
  // the default so the UI never renders an empty-state radio group.
  if (merged.ttsBackend !== 'fish' && merged.ttsBackend !== 'sovits' && merged.ttsBackend !== 'vocu') {
    merged.ttsBackend = DEFAULT_TTS_CONFIG.ttsBackend;
  }

  // A3 / v2.14.1 H.5: GPT-SoVITS is PC-only by physical constraint (PyTorch
  // + CUDA + Python runtime, ~5 GB models, runs an HTTP server on PC
  // localhost). On Android Capacitor the backend is unreachable from the
  // WebView and there's no longer a PC bridge to proxy through (F2B
  // dropped the PWA loopback path), so we silently fall back to Fish
  // Audio if a phone is migrated from a desktop setup with sovits
  // selected. Electron passes through unchanged.
  if (isCapacitorNative() && merged.ttsBackend === 'sovits') {
    merged.ttsBackend = 'fish';
  }

  // Vocu field clamping: enforce types so UI inputs / API calls never see
  // undefined or malformed shapes after round-tripping through localStorage
  // / WebSocket frames.
  merged.vocuApiKey = typeof merged.vocuApiKey === 'string' ? merged.vocuApiKey : '';
  merged.vocuVoiceId = typeof merged.vocuVoiceId === 'string' ? merged.vocuVoiceId : '';
  merged.vocuPromptId = typeof merged.vocuPromptId === 'string' && merged.vocuPromptId.trim().length > 0
    ? merged.vocuPromptId
    : (DEFAULT_TTS_CONFIG.vocuPromptId || 'default');
  merged.vocuPreset = merged.vocuPreset === 'vivid' ? 'vivid' : 'balance';
  merged.vocuFlash = Boolean(merged.vocuFlash);
  merged.vocuEmotionBoost = Boolean(merged.vocuEmotionBoost);

  return merged as TtsConfig;
}
