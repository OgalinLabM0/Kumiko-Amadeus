import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Phone, PhoneOff, Loader2, X } from 'lucide-react';
import { loadVoiceFile, resolveRingtoneAudioSource } from '../services/voiceFileService';
import { isCapacitorNative, isMobileLikeRuntime } from '../services/environment';
import { getHttpVoiceUrl } from '../services/httpApi';
import {
  getSharedUnlockedAudio,
  primeSharedAudioForGesture,
} from '../utils/audioUnlock';
import type { Language } from '../types';
import { UI_TRANSLATIONS } from '../constants';

interface VoiceCallOverlayProps {
  reminderEvent: string;
  reminderText?: string;
  ringtoneFileId?: string;
  isDarkMode: boolean;
  language: Language;
  onAccept: () => void;
  onReject: () => void;
  onClose?: () => void;
  isConnecting?: boolean;
  isPlayingVoice?: boolean;
  isEnded?: boolean;
  // Phase 5 Part D: populated by the PC once the voice pipeline
  // resolves. On mobile we open an <audio> against /media/voices/:id
  // so the phone hears Kumiko's clip in parallel with the PC's local
  // Blob playback. Desktop ignores this — chatActions already owns an
  // ArrayBuffer-backed <audio> and doesn't need to re-fetch.
  voiceFileId?: string;
}

export const VoiceCallOverlay: React.FC<VoiceCallOverlayProps> = ({
  reminderEvent,
  reminderText,
  ringtoneFileId,
  isDarkMode,
  language,
  onAccept,
  onReject,
  onClose,
  isConnecting,
  isPlayingVoice,
  isEnded,
  voiceFileId,
}) => {
  const t = UI_TRANSLATIONS[language];
  const ringtoneRef = useRef<HTMLAudioElement | null>(null);
  const ringtoneCleanupRef = useRef<(() => void) | null>(null);
  const acceptedRef = useRef(false);
  const callStartRef = useRef<number>(0);
  // Phase 5 Part D: track the mobile-only voice element separately so
  // it can be torn down independently of the ringtone. On desktop this
  // ref stays null and chatActions owns the playback path instead.
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);
  const [phase, setPhase] = useState<'ringing' | 'connecting' | 'active' | 'ended'>('ringing');
  const [callDuration, setCallDuration] = useState(0);

  useEffect(() => {
    if (isEnded) setPhase('ended');
    else if (isConnecting) setPhase('connecting');
    else if (isPlayingVoice) {
      setPhase('active');
      if (!callStartRef.current) callStartRef.current = Date.now();
    } else setPhase('ringing');
  }, [isConnecting, isPlayingVoice, isEnded]);

  useEffect(() => {
    if (phase === 'ended') {
      if (callStartRef.current) {
        setCallDuration(Math.round((Date.now() - callStartRef.current) / 1000));
      }
      const timer = setTimeout(() => { onClose?.(); }, 3000);
      return () => clearTimeout(timer);
    }
  }, [phase, onClose]);

  useEffect(() => {
    if (phase !== 'ringing') return;
    let cancelled = false;

    (async () => {
      try {
        const source = await resolveRingtoneAudioSource(ringtoneFileId);
        if (cancelled) return;
        if (source) {
          ringtoneCleanupRef.current = source.cleanup || null;
          // A.3: shared unlocked Audio is needed on ANY mobile-like
          // runtime (PWA + Capacitor) to bypass the iOS Safari /
          // Capacitor WebView autoplay policy. Desktop / Electron
          // (`isMobileLikeRuntime() === false`) creates a fresh element
          // because autoplay is unrestricted there.
          const audio = isMobileLikeRuntime() ? getSharedUnlockedAudio() : new Audio(source.src);
          try {
            audio.pause();
            audio.currentTime = 0;
          } catch {
            // ignore stale state from a previous playback session
          }
          audio.src = source.src;
          audio.loop = true;
          audio.volume = 0.6;
          ringtoneRef.current = audio;
          await audio.play().catch((e) => {
            console.warn('[CALL-OVERLAY] ringtone playback failed:', e);
          });
        }
      } catch { /* no custom ringtone */ }
    })();

    return () => {
      cancelled = true;
      if (ringtoneRef.current) {
        ringtoneRef.current.pause();
        ringtoneRef.current.src = '';
        ringtoneRef.current = null;
      }
      if (ringtoneCleanupRef.current) {
        ringtoneCleanupRef.current();
        ringtoneCleanupRef.current = null;
      }
    };
  }, [phase, ringtoneFileId]);

  // Phase 5 Part D + A.3: mobile-side voice playback. When the call
  // transitions to `isPlayingVoice=true` and we know the voiceFileId,
  // resolve a playable URL:
  //   - Mobile PWA: GET /media/voices/:id from PC's Fastify
  //   - Capacitor (paired or standalone): loadVoiceFile() reads the
  //     local Filesystem copy saved by services/voiceFileService.ts'
  //     Capacitor branch and creates a blob: URL
  //   - Desktop / Electron: never enters here — chatActions owns the
  //     local ArrayBuffer playback there.
  useEffect(() => {
    if (!isMobileLikeRuntime()) return;
    if (phase !== 'active' || !voiceFileId) return;
    let cancelled = false;
    let blobUrl: string | null = null;
    const audio = getSharedUnlockedAudio();
    try {
      audio.pause();
      audio.currentTime = 0;
    } catch {
      // ignore stale state from the ringing phase
    }

    const setupAndPlay = async () => {
      let src: string;
      if (isCapacitorNative()) {
        // Standalone or paired Capacitor: voice clip lives in
        // Directory.Data/voices/{id}.mp3 (see voiceFileService A.3 branch).
        const buf = await loadVoiceFile(voiceFileId);
        if (!buf || cancelled) return;
        const blob = new Blob([buf], { type: 'audio/mpeg' });
        blobUrl = URL.createObjectURL(blob);
        src = blobUrl;
      } else {
        // PWA: stream from PC HTTP. Same behaviour as before A.3.
        src = getHttpVoiceUrl(voiceFileId);
      }
      if (cancelled) {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        return;
      }
      audio.src = src;
      audio.preload = 'auto';
      audio.volume = 1.0;
      voiceAudioRef.current = audio;
      audio.addEventListener('ended', () => {
        if (!cancelled) {
          // Parent controls the ended flag via PC-side state on PWA;
          // standalone Capacitor relies on the same external state
          // shape for symmetry. Either way we don't mutate it here.
          try { audio.src = ''; } catch { /* ignore */ }
        }
      });
      try {
        await audio.play();
      } catch (e) {
        console.warn('[CALL-OVERLAY] mobile voice playback failed:', e);
      }
    };
    void setupAndPlay();

    return () => {
      cancelled = true;
      try {
        audio.pause();
        audio.src = '';
      } catch { /* ignore */ }
      if (blobUrl) {
        try { URL.revokeObjectURL(blobUrl); } catch { /* ignore */ }
      }
      voiceAudioRef.current = null;
    };
  }, [phase, voiceFileId]);

  const handleAccept = useCallback(() => {
    if (acceptedRef.current) return;
    acceptedRef.current = true;
    if (ringtoneRef.current) { ringtoneRef.current.pause(); }
    if (isMobileLikeRuntime()) {
      void primeSharedAudioForGesture().catch(() => {
        // ignore: the accept gesture still improves later autoplay odds
      });
    }
    onAccept();
  }, [onAccept]);

  const handleReject = useCallback(() => {
    if (ringtoneRef.current) { ringtoneRef.current.pause(); }
    onReject();
  }, [onReject]);

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    // Phase 7 Part t10_chat_voice: on 5.5" phones in the ringing
    // phase (avatar + name + reminder + accept/reject row) the stack
    // overflowed 667px vertical. We add `overflow-y-auto` + safe-area
    // padding so the Accept button isn't clipped under the iOS home
    // indicator and all content remains scrollable. Desktop still has
    // plenty of vertical room.
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center overflow-y-auto"
      style={{
        background: 'radial-gradient(ellipse at center, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.95) 100%)',
        paddingTop: 'max(1rem, var(--sat))',
        paddingBottom: 'max(1rem, var(--sab))',
        paddingLeft: 'var(--sal)',
        paddingRight: 'var(--sar)',
      }}
    >
      <div className="flex flex-col items-center gap-6 sm:gap-8 text-white animate-[breathe_0.3s_ease-out] my-auto">
        <div className="relative">
          <div className={`w-28 h-28 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-4xl font-bold shadow-2xl overflow-hidden ${phase === 'ringing' ? 'animate-pulse' : ''}`}>
            <img src="./CCA-P2.png" alt="Kumiko" className="w-full h-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.parentElement!.innerText = '久'; }} />
          </div>
          {phase === 'ringing' && (
            <>
              <div className="absolute inset-0 rounded-full border-2 border-purple-400/40 animate-ping" />
              <div className="absolute inset-[-8px] rounded-full border border-purple-400/20 animate-ping" style={{ animationDelay: '0.5s' }} />
            </>
          )}
        </div>

        <div className="text-center">
          <div className="text-xl font-semibold tracking-wide">黄前久美子</div>
          <div className="text-sm text-gray-400 mt-1">
            {phase === 'ringing' && t.voiceCallIncoming}
            {phase === 'connecting' && t.voiceCallConnecting}
            {phase === 'active' && '🔊'}
            {phase === 'ended' && (language === 'zh' ? `通话结束  ${formatDuration(callDuration)}` : `Call ended  ${formatDuration(callDuration)}`)}
          </div>
        </div>

        <div className={`rounded-xl px-5 py-3 text-center max-w-[280px] ${isDarkMode ? 'bg-white/10' : 'bg-white/10'}`}>
          <div className="text-[11px] text-gray-400 uppercase tracking-wider mb-1">{t.voiceCallReminder}</div>
          <div className="text-sm">{reminderText || reminderEvent}</div>
        </div>

        {(phase === 'active' || phase === 'ended') && reminderText && (
          <div className="rounded-xl px-5 py-3 text-center max-w-[300px] bg-purple-500/15 border border-purple-400/20">
            <div className="text-[11px] text-purple-300 mb-1">{language === 'zh' ? '久美子说' : 'Kumiko says'}</div>
            <div className="text-sm text-white/90 leading-relaxed">{reminderText}</div>
          </div>
        )}

        {phase === 'ringing' ? (
          // Phase 7 Part t10_chat_voice: drop gap to 12 on phones so
          // the Accept+Reject pair still centres on 320px screens, and
          // add `active:scale-95` for a tactile press. Desktop `sm:`
          // rehydrates the original `gap-16`.
          <div className="flex items-center gap-12 sm:gap-16 mt-4">
            <button onClick={handleReject}
              className="w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 active:scale-95 flex items-center justify-center transition-all shadow-lg shadow-red-500/30">
              <PhoneOff size={24} />
            </button>
            <button onClick={handleAccept} disabled={acceptedRef.current}
              className={`w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg shadow-green-500/30 active:scale-95 ${acceptedRef.current ? 'bg-green-800 opacity-50 cursor-not-allowed' : 'bg-green-500 hover:bg-green-600 animate-bounce'}`}>
              <Phone size={24} />
            </button>
          </div>
        ) : phase === 'connecting' ? (
          <div className="flex flex-col items-center gap-3 mt-4">
            <Loader2 size={32} className="animate-spin text-purple-400" />
          </div>
        ) : phase === 'active' ? (
          <div className="flex flex-col items-center gap-3 mt-4">
            <div className="flex items-center gap-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="w-1 bg-purple-400 rounded-full animate-pulse"
                  style={{ height: `${12 + Math.random() * 20}px`, animationDelay: `${i * 0.1}s` }} />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 mt-4 opacity-60">
            <PhoneOff size={20} />
          </div>
        )}
      </div>
    </div>
  );
};
