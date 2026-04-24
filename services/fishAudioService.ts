import type { TtsConfig } from '../types';
import { isCapacitorNative, isMobilePwa } from './environment';
import { base64ToArrayBuffer, httpInvoke } from './httpApi';

export interface TtsSynthesisResult {
    audio: ArrayBuffer;
    durationEstimate: number;
}

interface TtsProxyResult {
    ok: boolean;
    audioB64?: string;
    mime?: string;
    durationEstimate?: number;
    error?: string;
    code?: string;
}

export type TtsErrorKind = 'auth' | 'payment' | 'validation' | 'network' | 'unknown';

export class TtsError extends Error {
    kind: TtsErrorKind;
    status?: number;
    constructor(kind: TtsErrorKind, message: string, status?: number) {
        super(message);
        this.kind = kind;
        this.status = status;
    }
}

function statusToErrorKind(status: number): TtsErrorKind {
    if (status === 401) return 'auth';
    if (status === 402) return 'payment';
    if (status === 422) return 'validation';
    return 'unknown';
}

// P1 #33: `callFishAudioTts` was the original non-streaming Fish Audio TTS call;
// it has been fully superseded by `synthesizeSpeechStreaming` (below) which handles
// the same request-body + status-code concerns and additionally streams chunks to
// the caller. Note: Fish Audio is still in active use — `synthesizeSpeech` /
// `synthesizeSpeechStreaming` remain exported and drive the Fish Audio TTS backend.
// Only the dead private helper is removed here.

function estimateDurationFromSize(byteLength: number, format: string, bitrate = 128): number {
    if (format === 'opus') bitrate = 32;
    return Math.max(1, Math.round(byteLength / (bitrate * 1000 / 8)));
}

function concatUint8Arrays(chunks: Uint8Array[], totalBytes: number): Uint8Array {
    const result = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}

export async function synthesizeSpeechStreaming(
    text: string,
    config: TtsConfig,
    onChunk?: (chunk: Uint8Array) => void,
): Promise<TtsSynthesisResult> {
    const url = 'https://api.fish.audio/v1/tts';

    const body: Record<string, unknown> = {
        text,
        reference_id: config.fishAudioReferenceId || undefined,
        format: config.format || 'mp3',
        latency: config.latency || 'normal',
        normalize: true,
        temperature: config.temperature ?? 0.6,
        prosody: {
            normalize_loudness: true,
        },
    };

    if (config.speed !== undefined && config.speed !== 1.0) {
        body.prosody = { ...body.prosody as any, speed: config.speed };
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${config.fishAudioApiKey}`,
            'Content-Type': 'application/json',
            'model': config.fishAudioModel || 's2-pro',
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        let detail = '';
        try { detail = await res.text(); } catch { /* ignore */ }
        throw new TtsError(
            statusToErrorKind(res.status),
            `Fish Audio TTS failed (${res.status}): ${detail}`,
            res.status,
        );
    }

    if (res.body) {
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            totalBytes += value.byteLength;
            if (onChunk) onChunk(value);
        }

        const audio = concatUint8Arrays(chunks, totalBytes);
        return {
            audio: audio.buffer as ArrayBuffer,
            durationEstimate: estimateDurationFromSize(totalBytes, config.format || 'mp3'),
        };
    }

    const audio = await res.arrayBuffer();
    return {
        audio,
        durationEstimate: estimateDurationFromSize(audio.byteLength, config.format || 'mp3'),
    };
}

export async function synthesizeSpeech(
    text: string,
    config: TtsConfig,
): Promise<TtsSynthesisResult> {
    // Routing matrix:
    //   - Desktop Electron / Capacitor Android → fall through to direct
    //     fetch below. On Capacitor the global CapacitorHttp plugin
    //     (capacitor.config.ts) re-routes the WebView's fetch through
    //     native OkHttp, so Fish Audio's CORS preflight against
    //     capacitor://localhost is bypassed entirely. A3 cuts the PC
    //     dependency for Fish here so the APK keeps working after A7.
    //   - Mobile PWA only (NOT Capacitor) → still proxies through the
    //     PC renderer because the PWA WebView origin (PC's IP / Tailnet
    //     hostname) IS in CORS rejection territory the same way, and
    //     the PWA's whole design is "PC handles the heavy lifting".
    //     `!isCapacitorNative()` guards against the Capacitor case where
    //     isMobilePwa() returns true (Capacitor uses the HTTP bridge
    //     model when PC is configured) but we still want direct fetch.
    if (isMobilePwa() && !isCapacitorNative()) {
        const reply = await httpInvoke<TtsProxyResult>('tts:fish-synth', { text, config });
        if (!reply || reply.ok === false || !reply.audioB64) {
            throw new TtsError('unknown', reply?.error || 'Mobile Fish TTS proxy failed');
        }
        return {
            audio: base64ToArrayBuffer(reply.audioB64),
            durationEstimate: reply.durationEstimate ?? 1,
        };
    }

    const maxRetries = 1;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await synthesizeSpeechStreaming(text, config);
        } catch (err) {
            lastError = err;
            if (err instanceof TtsError && (err.kind === 'auth' || err.kind === 'payment')) {
                throw err;
            }
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }

    throw lastError;
}
