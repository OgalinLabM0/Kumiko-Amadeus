import type { StateCreator } from 'zustand';
import type { EmotionType, TtsConfig, VoiceCallOverlayData } from '../../types';
import { DEFAULT_TTS_CONFIG } from '../../constants';
import { isBuiltInRingtoneId, isCustomRingtoneId } from '../../services/voiceFileService';

const initTtsConfig = (): TtsConfig => {
  try {
    const raw = localStorage.getItem('kumiko_tts_config');
    if (raw) {
      const merged: Record<string, unknown> = {
        ...DEFAULT_TTS_CONFIG,
        ...(JSON.parse(raw) as Partial<TtsConfig>),
      };
      if (
        !isBuiltInRingtoneId(merged.ringtoneFileId as string | undefined) &&
        !isCustomRingtoneId(merged.ringtoneFileId as string | undefined)
      ) {
        merged.ringtoneFileId = DEFAULT_TTS_CONFIG.ringtoneFileId;
      }
      return merged as unknown as TtsConfig;
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_TTS_CONFIG };
};

/**
 * v2.14.24: action variants the heads-up CallStyle notification can
 * write into native SharedPreferences when the user taps a button or
 * the body of the notification. The Android drainer hook translates
 * the native action string into one of these values when it parks a
 * pending call action for the JS reminder pipeline to consume.
 *
 *  - `open`    — body tapped (or pre-v2.14.24 Accept fallback). Show the
 *                React VoiceCallOverlay's ringing UI; the user still gets
 *                to tap accept / decline inside the app.
 *  - `accept`  — Accept circle tapped. Skip the ringing UI and auto-fire
 *                the overlay's onAccept closure as soon as it mounts so
 *                the playback starts immediately.
 *  - `decline` — Decline circle tapped. Don't show the overlay at all;
 *                the drainer already logged a missed-call alert and a
 *                system notice, so the chat pipeline can no-op.
 */
export type PendingCallActionKind = 'open' | 'accept' | 'decline';

export interface PendingCallAction {
  event: string;
  action: PendingCallActionKind;
  /** Epoch ms of the heads-up tap, mostly used by tests / debug surface. */
  at?: number;
}

export interface VoiceSlice {
  isTalking: boolean;
  isThinking: boolean;
  isListening: boolean;
  timeLeft: number;
  currentEmotion: EmotionType;
  ttsConfig: TtsConfig;
  voiceCallOverlayData: VoiceCallOverlayData | null;
  regeneratingVoiceIds: Set<string>;
  /**
   * v2.14.24: when the user taps a heads-up CallStyle notification button
   * (Accept / Decline) or the notification body itself, the Android
   * pending-actions drainer parks the matching {@link PendingCallAction}
   * here keyed by reminder event. `triggerTimedReminderMessage` consumes
   * it before mounting the in-app `VoiceCallOverlay` and branches:
   *   - `accept`  → auto-fires the overlay's onAccept closure so the user
   *                 doesn't have to tap accept twice.
   *   - `open`    → renders the ringing UI; user still resolves the call
   *                 inside the app.
   *   - `decline` → skips the overlay entirely; the drainer already wrote
   *                 a missed-call alert + system notice.
   *
   * Replaces the v2.14.23 `pendingAutoAcceptReminderEvent` field which
   * only encoded the accept case.
   */
  pendingCallAction: PendingCallAction | null;

  setIsTalking: (v: boolean) => void;
  setIsThinking: (v: boolean) => void;
  setIsListening: (v: boolean) => void;
  setTimeLeft: (v: number | ((prev: number) => number)) => void;
  setCurrentEmotion: (v: EmotionType) => void;
  setTtsConfig: (v: TtsConfig | ((prev: TtsConfig) => TtsConfig)) => void;
  setVoiceCallOverlayData: (v: (VoiceCallOverlayData | null) | ((prev: VoiceCallOverlayData | null) => VoiceCallOverlayData | null)) => void;
  setRegeneratingVoiceIds: (v: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  setPendingCallAction: (v: PendingCallAction | null) => void;
  /** Consume the parked action iff `event` matches the parked event under
   *  loose normalisation (whitespace + casing). Returns the consumed action
   *  kind, or null when there was no match. */
  consumePendingCallAction: (event: string) => PendingCallActionKind | null;
}

export const createVoiceSlice: StateCreator<VoiceSlice, [], [], VoiceSlice> = (set, get) => ({
  isTalking: false,
  isThinking: false,
  isListening: false,
  timeLeft: 0,
  currentEmotion: 'neutral',
  ttsConfig: initTtsConfig(),
  voiceCallOverlayData: null,
  regeneratingVoiceIds: new Set(),
  pendingCallAction: null,

  setIsTalking: (v) => set({ isTalking: v }),
  setIsThinking: (v) => set({ isThinking: v }),
  setIsListening: (v) => set({ isListening: v }),
  setTimeLeft: (v) => set((s) => ({ timeLeft: typeof v === 'function' ? v(s.timeLeft) : v })),
  setCurrentEmotion: (v) => set({ currentEmotion: v }),
  setTtsConfig: (v) => set((s) => ({ ttsConfig: typeof v === 'function' ? v(s.ttsConfig) : v })),
  setVoiceCallOverlayData: (v) => set((s) => ({ voiceCallOverlayData: typeof v === 'function' ? v(s.voiceCallOverlayData) : v })),
  setRegeneratingVoiceIds: (v) => set((s) => ({ regeneratingVoiceIds: typeof v === 'function' ? v(s.regeneratingVoiceIds) : v })),
  setPendingCallAction: (v) => set({ pendingCallAction: v }),
  consumePendingCallAction: (event) => {
    const current = get().pendingCallAction;
    if (!current) return null;
    const normalise = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
    const matches = normalise(current.event) === normalise(event);
    if (!matches) return null;
    set({ pendingCallAction: null });
    return current.action;
  },
});
