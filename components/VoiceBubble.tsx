import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Pause, AlertTriangle, RefreshCw } from 'lucide-react';
import { loadVoiceFile } from '../services/voiceFileService';
import { isCapacitorNative, isMobilePwa } from '../services/environment';
import { getHttpVoiceUrl } from '../services/httpApi';
import type { Language } from '../types';
import { UI_TRANSLATIONS } from '../constants';

interface VoiceBubbleProps {
  messageId: string;
  text: string;
  voiceFileId?: string;
  voiceDuration?: number;
  isDarkMode: boolean;
  language: Language;
  onRegenerate?: () => void;
  isRegenerating?: boolean;
}

const completedAnimations = new Set<string>();
const playedMessages = new Set<string>();

const WaveformBars: React.FC<{ isPlaying: boolean; progress: number; isDarkMode: boolean }> = ({ isPlaying, progress, isDarkMode }) => {
  const barCount = 24;
  const heights = useRef<number[]>(Array.from({ length: barCount }, () => 0.2 + Math.random() * 0.8));

  return (
    <div className="flex items-center gap-[2px] h-6 flex-1 mx-2">
      {heights.current.map((h, i) => {
        const barProgress = i / barCount;
        const isPast = barProgress < progress;
        const activeColor = isDarkMode ? 'bg-yellow-400' : 'bg-yellow-600';
        const inactiveColor = isDarkMode ? 'bg-gray-600' : 'bg-gray-300';
        return (
          <div
            key={i}
            className={`w-[3px] rounded-full transition-all duration-150 ${isPast ? activeColor : inactiveColor}`}
            style={{
              height: `${h * 100}%`,
              animationDuration: isPlaying ? `${0.3 + Math.random() * 0.4}s` : undefined,
            }}
          />
        );
      })}
    </div>
  );
};

export const VoiceBubble: React.FC<VoiceBubbleProps> = ({
  messageId,
  text,
  voiceFileId,
  voiceDuration,
  isDarkMode,
  language,
  onRegenerate,
  isRegenerating
}) => {
  const t = UI_TRANSLATIONS[language];
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [audioError, setAudioError] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const animFrameRef = useRef<number>(0);

  const alreadyPlayed = playedMessages.has(messageId);
  const alreadyRevealed = completedAnimations.has(messageId);
  const [hasPlayed, setHasPlayed] = useState(alreadyPlayed);
  const [revealedChars, setRevealedChars] = useState(alreadyRevealed ? text.length : 0);

  useEffect(() => {
    if (!hasPlayed || revealedChars >= text.length) return;
    const interval = setInterval(() => {
      setRevealedChars(prev => Math.min(prev + 1, text.length));
    }, 55);
    return () => clearInterval(interval);
  }, [text.length, revealedChars, hasPlayed]);

  useEffect(() => {
    if (hasPlayed && revealedChars >= text.length) {
      completedAnimations.add(messageId);
    }
  }, [revealedChars, text.length, messageId, hasPlayed]);

  const cleanup = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const togglePlay = useCallback(async () => {
    if (isPlaying && audioRef.current) {
      audioRef.current.pause();
      setIsPlaying(false);
      return;
    }

    if (!voiceFileId) return;

    try {
      if (!audioRef.current) {
        let audio: HTMLAudioElement;
        if (isMobilePwa() && !isCapacitorNative()) {
          // PWA only (NOT Capacitor): stream directly from the desktop
          // HTTP server; the browser handles progressive download +
          // playback without loading the entire buffer into memory.
          // Same-origin cookie auth, no crossOrigin opt-in.
          // A.3: Capacitor — paired or standalone — falls through to
          // loadVoiceFile because saveVoiceFile's Capacitor branch
          // writes to Directory.Data/voices/{id}.mp3 locally; PC
          // /media/voices/{id} wouldn't have the file (TTS was generated
          // direct on phone in A3).
          const streamUrl = getHttpVoiceUrl(voiceFileId);
          audio = new Audio(streamUrl);
        } else {
          const buf = await loadVoiceFile(voiceFileId);
          if (!buf) { setAudioError(true); return; }
          const blob = new Blob([buf], { type: 'audio/mpeg' });
          const url = URL.createObjectURL(blob);
          objectUrlRef.current = url;
          audio = new Audio(url);
        }
        audioRef.current = audio;

        audio.onended = () => {
          setIsPlaying(false);
          setProgress(1);
        };
        audio.onerror = () => {
          setAudioError(true);
          setIsPlaying(false);
        };
      }

      await audioRef.current.play();
      setIsPlaying(true);
      if (!hasPlayed) {
        setHasPlayed(true);
        playedMessages.add(messageId);
      }

      const tick = () => {
        if (audioRef.current && !audioRef.current.paused) {
          const dur = audioRef.current.duration || 1;
          setProgress(audioRef.current.currentTime / dur);
          animFrameRef.current = requestAnimationFrame(tick);
        }
      };
      animFrameRef.current = requestAnimationFrame(tick);
    } catch {
      setAudioError(true);
    }
  }, [isPlaying, voiceFileId, hasPlayed, messageId]);

  const formatDuration = (sec?: number) => {
    if (!sec || sec <= 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const bubbleBg = isDarkMode
    ? 'bg-gray-800/60 md:bg-gray-800/40 md:backdrop-blur-[1px] border-gray-600/50'
    : 'bg-white/70 md:bg-white/50 md:backdrop-blur-[1px] border-gray-200/50 shadow-sm';

  const playBtnClass = isDarkMode
    ? 'bg-yellow-600 hover:bg-yellow-700'
    : 'bg-[#b8860b] hover:bg-[#9a7400]';

  const textBorderColor = isDarkMode ? 'border-yellow-600/50' : 'border-yellow-400/50';
  const textBg = isDarkMode ? 'bg-white/5' : 'bg-black/5';

  return (
    <div className="flex flex-col items-start max-w-[85%]">
      <div className={`rounded-lg rounded-tl-none border px-4 py-3 flex items-center gap-2 min-w-[200px] ${bubbleBg} transition-all duration-500`}>
        {audioError ? (
          <div className="flex items-center justify-between w-full gap-2">
            <div className="flex items-center gap-2">
              <AlertTriangle size={14} className="text-red-500" />
              <span className={`text-[12px] ${isDarkMode ? 'text-red-400' : 'text-red-500'}`}>{t.voiceDeleted}</span>
            </div>
            {onRegenerate && (
              <button
                onClick={onRegenerate}
                disabled={isRegenerating}
                className={`p-1.5 rounded-full transition-colors flex items-center justify-center ${
                  isDarkMode 
                    ? 'hover:bg-gray-700 text-gray-400 hover:text-white disabled:opacity-50' 
                    : 'hover:bg-gray-200 text-gray-500 hover:text-gray-800 disabled:opacity-50'
                }`}
                title={language === 'zh' ? '重新生成语音' : 'Regenerate Voice'}
              >
                <RefreshCw size={14} className={isRegenerating ? "animate-spin" : ""} />
              </button>
            )}
          </div>
        ) : (
          <>
            <button
              onClick={togglePlay}
              className={`w-8 h-8 rounded-full ${playBtnClass} flex items-center justify-center transition-colors flex-shrink-0`}
            >
              {isPlaying
                ? <Pause size={14} className="text-white" />
                : <Play size={14} className="text-white ml-0.5" />
              }
            </button>
            <WaveformBars isPlaying={isPlaying} progress={progress} isDarkMode={isDarkMode} />
            <span className={`text-[11px] font-mono flex-shrink-0 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              {formatDuration(voiceDuration)}
            </span>
            {!hasPlayed && (
              <div className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
            )}
          </>
        )}
      </div>

      {hasPlayed && text && (
        <div className={`ml-3 mt-1 pl-3 border-l-2 ${textBorderColor}`}>
          <div className={`rounded-lg px-3 py-2 text-[13px] leading-relaxed ${textBg} ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>
            {text.slice(0, revealedChars)}
            {revealedChars < text.length && <span className="animate-pulse">|</span>}
          </div>
        </div>
      )}
    </div>
  );
};
