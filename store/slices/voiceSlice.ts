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
   * v2.14.23: when the native IncomingCallActivity dispatches ACCEPT
   * (user tapped Accept on the lock-screen FSI / CallStyle UI), the
   * Android pending-actions drainer parks the matching reminder event
   * here. The next time `triggerTimedReminderMessage` is about to show
   * the in-app VoiceCallOverlay's ringing UI, it consumes this hint
   * and short-circuits straight into the connecting + playback phase
   * — the user already accepted natively, so they shouldn't have to
   * tap Accept a second time.
   *
   * Stored as the reminder.event string (the most stable ID we have
   * across the JS / native boundary, since native scheduleExact only
   * propagates event + text and not the JS-side reminder UUID).
   * Cleared as soon as a reminder consumes it.
   */
  pendingAutoAcceptReminderEvent: string | null;

  setIsTalking: (v: boolean) => void;
  setIsThinking: (v: boolean) => void;
  setIsListening: (v: boolean) => void;
  setTimeLeft: (v: number | ((prev: number) => number)) => void;
  setCurrentEmotion: (v: EmotionType) => void;
  setTtsConfig: (v: TtsConfig | ((prev: TtsConfig) => TtsConfig)) => void;
  setVoiceCallOverlayData: (v: (VoiceCallOverlayData | null) | ((prev: VoiceCallOverlayData | null) => VoiceCallOverlayData | null)) => void;
  setRegeneratingVoiceIds: (v: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  setPendingAutoAcceptReminderEvent: (v: string | null) => void;
  consumePendingAutoAcceptReminderEvent: (event: string) => boolean;
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
  pendingAutoAcceptReminderEvent: null,

  setIsTalking: (v) => set({ isTalking: v }),
  setIsThinking: (v) => set({ isThinking: v }),
  setIsListening: (v) => set({ isListening: v }),
  setTimeLeft: (v) => set((s) => ({ timeLeft: typeof v === 'function' ? v(s.timeLeft) : v })),
  setCurrentEmotion: (v) => set({ currentEmotion: v }),
  setTtsConfig: (v) => set((s) => ({ ttsConfig: typeof v === 'function' ? v(s.ttsConfig) : v })),
  setVoiceCallOverlayData: (v) => set((s) => ({ voiceCallOverlayData: typeof v === 'function' ? v(s.voiceCallOverlayData) : v })),
  setRegeneratingVoiceIds: (v) => set((s) => ({ regeneratingVoiceIds: typeof v === 'function' ? v(s.regeneratingVoiceIds) : v })),
  setPendingAutoAcceptReminderEvent: (v) => set({ pendingAutoAcceptReminderEvent: v }),
  consumePendingAutoAcceptReminderEvent: (event) => {
    const current = get().pendingAutoAcceptReminderEvent;
    if (!current) return false;
    // Permissive match: trim/normalise to absorb minor punctuation differences
    // between the JS-side reminder.event and what native marshalled.
    const normalise = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
    const matches = normalise(current) === normalise(event);
    if (matches) set({ pendingAutoAcceptReminderEvent: null });
    return matches;
  },
});
