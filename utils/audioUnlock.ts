// utils/audioUnlock.ts
//
// iOS Safari (and Capacitor / Tailscale-served PWAs running in Mobile
// Safari) enforce an autoplay policy that's stricter than the spec:
// `HTMLAudioElement.play()` is only allowed when the call frame can be
// traced back to a still-active user gesture. The moment we `await`
// inside a click handler — for a TTS HTTP round-trip, a Dexie blob load,
// anything — that linkage is severed, and the next `audio.play()` throws
//
//   NotAllowedError: The request is not allowed by the user agent or the
//   platform in the current context, possibly because the user denied
//   permission.
//
// Workaround: synchronously inside the user-gesture handler, point an
// HTMLAudioElement at a tiny silent WAV and call `play()`. Once that
// element has been "primed" by a user gesture, every subsequent
// `audio.src = …; audio.play()` on the SAME element is allowed even
// after arbitrary `await`s. The async work then runs as usual, and at
// the end we swap in the real audio source.
//
// Usage pattern inside a click/touch handler:
//
//   const handleClick = async () => {
//     // 1. Prime synchronously (creates or reuses an Audio element) ──┐
//     const audio = audioRef.current ?? new Audio();                   │ user
//     audioRef.current = audio;                                        │ gesture
//     primeAudioForUserGesture(audio);                                 │ frame
//     // 2. Now safe to await; the element is unlocked. ───────────────┘
//     const result = await fetchAudioBytes();
//     audio.src = URL.createObjectURL(result.blob);
//     await audio.play();
//   };
//
// The helper is a no-op on Electron desktop (autoplay is unrestricted in
// the BrowserWindow), but is also harmless there — calling it on every
// platform keeps the same code path live everywhere.

// 44-byte PCM WAV header with 0 sample bytes. iOS Safari accepts this
// minimal silent stream as a valid playback target and flips the
// element into the gesture-permitted state.
const SILENT_WAV_BYTES: Uint8Array = (() => {
  const buf = new ArrayBuffer(44);
  const view = new DataView(buf);
  view.setUint8(0, 0x52); view.setUint8(1, 0x49); view.setUint8(2, 0x46); view.setUint8(3, 0x46); // "RIFF"
  view.setUint32(4, 36, true);                                                                     // ChunkSize = 36 + 0
  view.setUint8(8, 0x57); view.setUint8(9, 0x41); view.setUint8(10, 0x56); view.setUint8(11, 0x45); // "WAVE"
  view.setUint8(12, 0x66); view.setUint8(13, 0x6D); view.setUint8(14, 0x74); view.setUint8(15, 0x20); // "fmt "
  view.setUint32(16, 16, true);                                                                     // Subchunk1Size = 16 (PCM)
  view.setUint16(20, 1, true);                                                                      // AudioFormat = 1 (PCM)
  view.setUint16(22, 1, true);                                                                      // NumChannels = 1
  view.setUint32(24, 8000, true);                                                                   // SampleRate
  view.setUint32(28, 8000, true);                                                                   // ByteRate
  view.setUint16(32, 1, true);                                                                      // BlockAlign
  view.setUint16(34, 8, true);                                                                      // BitsPerSample
  view.setUint8(36, 0x64); view.setUint8(37, 0x61); view.setUint8(38, 0x74); view.setUint8(39, 0x61); // "data"
  view.setUint32(40, 0, true);                                                                      // Subchunk2Size = 0
  return new Uint8Array(buf);
})();

let cachedSilentUrl: string | null = null;
let sharedUnlockedAudio: HTMLAudioElement | null = null;
let sharedAudioPrimed = false;

function getSilentWavUrl(): string {
  if (cachedSilentUrl) return cachedSilentUrl;
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof Blob !== 'undefined') {
    const blob = new Blob([SILENT_WAV_BYTES], { type: 'audio/wav' });
    cachedSilentUrl = URL.createObjectURL(blob);
    return cachedSilentUrl;
  }
  let bin = '';
  for (let i = 0; i < SILENT_WAV_BYTES.length; i += 1) bin += String.fromCharCode(SILENT_WAV_BYTES[i]);
  cachedSilentUrl = 'data:audio/wav;base64,' + btoa(bin);
  return cachedSilentUrl;
}

/**
 * Synchronously prime an `HTMLAudioElement` inside a user-gesture handler so
 * subsequent `audio.src = … ; audio.play()` is allowed by iOS Safari /
 * Mobile Safari PWA after any `await` in between.
 *
 * MUST be called BEFORE any `await` — the gesture-permission handshake is
 * tied to the synchronous call frame the user's tap initiated.
 *
 * The returned promise resolves when the silent priming playback either
 * completes or is rejected (some browsers reject the very first `play()`
 * before any user has ever interacted, but the priming attempt still
 * unlocks the element). Callers can await it (to make sure the silent
 * playback has finished before swapping `src`) or fire-and-forget.
 *
 * No-op on environments without `Audio` (SSR), so it's safe to import
 * from any code path.
 */
export function primeAudioForUserGesture(audio: HTMLAudioElement): Promise<void> {
  if (!audio || typeof audio.play !== 'function') return Promise.resolve();
  try {
    audio.src = getSilentWavUrl();
    const p = audio.play();
    if (p && typeof (p as Promise<void>).then === 'function') {
      return (p as Promise<void>).catch(() => { /* swallow NotAllowedError */ });
    }
  } catch {
    // Some very old browsers throw synchronously from `play()` instead of
    // returning a rejected promise. We don't care — the element is now
    // associated with this gesture frame either way.
  }
  return Promise.resolve();
}

function getSharedAudio(): HTMLAudioElement {
  if (sharedUnlockedAudio) return sharedUnlockedAudio;
  sharedUnlockedAudio = new Audio();
  sharedUnlockedAudio.preload = 'auto';
  return sharedUnlockedAudio;
}

export function getSharedUnlockedAudio(): HTMLAudioElement {
  return getSharedAudio();
}

export function isSharedAudioPrimed(): boolean {
  return sharedAudioPrimed;
}

export async function primeSharedAudioForGesture(): Promise<HTMLAudioElement> {
  const audio = getSharedAudio();
  await primeAudioForUserGesture(audio);
  try {
    audio.pause();
    audio.currentTime = 0;
  } catch {
    // ignore
  }
  sharedAudioPrimed = true;
  return audio;
}

export function installGlobalAudioUnlock(): () => void {
  if (typeof window === 'undefined') return () => {};

  const eventTypes: Array<keyof WindowEventMap> = ['pointerdown', 'touchstart', 'click', 'keydown'];
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const type of eventTypes) {
      try {
        window.removeEventListener(type, handleFirstGesture as EventListener, true);
      } catch {
        // ignore
      }
    }
  };

  const handleFirstGesture = () => {
    void primeSharedAudioForGesture().finally(cleanup);
  };

  for (const type of eventTypes) {
    try {
      window.addEventListener(type, handleFirstGesture as EventListener, { capture: true, passive: true, once: false });
    } catch {
      window.addEventListener(type, handleFirstGesture as EventListener, true);
    }
  }

  return cleanup;
}
