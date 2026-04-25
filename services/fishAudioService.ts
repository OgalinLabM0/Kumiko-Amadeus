import type { TtsConfig } from '../types';
import { CapacitorHttp } from '@capacitor/core';
import { isCapacitorNative } from './environment';
// F2B.3: dropped `isMobilePwa` + `httpApi` imports.
// PWA used to proxy Fish TTS through PC's Fastify (`tts:fish-synth`)
// because the PWA WebView origin can't pass Fish Audio's CORS check;
// Capacitor APK uses CapacitorHttp to bypass CORS natively. With the PWA
// bridge gone, Electron uses direct fetch + streaming and Capacitor APK
// uses CapacitorHttp.post directly (see v2.14.9 W.2.A below).

export interface TtsSynthesisResult {
    audio: ArrayBuffer;
    durationEstimate: number;
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

    const headers = {
        'Authorization': `Bearer ${config.fishAudioApiKey}`,
        'Content-Type': 'application/json',
        'model': config.fishAudioModel || 's2-pro',
    };

    // v2.14.9 W.2.A: bypass the @capacitor/core fetch shim entirely on
    // native. v2.14.8 V.1 already switched the native branch to
    // res.arrayBuffer() instead of streaming, but users still hit
    // "Failed to load because no supported source was found" — the shim
    // mangles binary POST response bodies even via arrayBuffer(). Calling
    // CapacitorHttp.post directly with responseType:'arraybuffer' goes
    // through the native OkHttp plugin's binary path (returns base64) and
    // sidesteps the shim. Electron / Web continue to use real fetch +
    // streaming so onChunk callers still work for the desktop TTS path.
    if (isCapacitorNative()) {
        const audio = await postFishNative(url, headers, body, config.format || 'mp3');
        return {
            audio,
            durationEstimate: estimateDurationFromSize(audio.byteLength, config.format || 'mp3'),
        };
    }

    const res = await fetch(url, {
        method: 'POST',
        headers,
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

// v2.14.9 W.2.A: native-only Fish TTS POST that goes through CapacitorHttp
// directly (no fetch shim). CapacitorHttp returns binary as base64 in
// res.data when responseType is 'arraybuffer' (Android plugin contract).
async function postFishNative(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    format: string,
): Promise<ArrayBuffer> {
    const res = await CapacitorHttp.post({
        url,
        headers,
        data: body,
        responseType: 'arraybuffer',
    });

    if (res.status < 200 || res.status >= 300) {
        const detail = typeof res.data === 'string' ? res.data : '';
        throw new TtsError(
            statusToErrorKind(res.status),
            `Fish Audio TTS failed (${res.status}): ${detail}`,
            res.status,
        );
    }

    let buffer: ArrayBuffer;
    if (typeof res.data === 'string') {
        const bin = atob(res.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        buffer = bytes.buffer;
    } else if (res.data instanceof ArrayBuffer) {
        buffer = res.data;
    } else {
        throw new TtsError(
            'unknown',
            `Fish Audio TTS native response was unrecognised type: ${typeof res.data}`,
        );
    }

    // v2.14.9 W.2.C: one-shot diagnostic. MP3 magic should be 49 44 33 (ID3)
    // or ff fb / ff f3 / ff f2 (frame sync). OGG/Opus should be 4f 67 67 53.
    // If we see 7b 22 ... it's JSON (an error response), and 3c ... is HTML.
    // Remove this log in v2.14.10 once Fish TTS is confirmed stable on Android.
    try {
        const head = new Uint8Array(buffer.slice(0, 4));
        const hex = Array.from(head).map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log(`[Fish-TTS native] format=${format} bytes=${buffer.byteLength} magic=${hex}`);
    } catch { /* logging is best-effort */ }

    return buffer;
}

export async function synthesizeSpeech(
    text: string,
    config: TtsConfig,
): Promise<TtsSynthesisResult> {
    // F2B.3: simplified to direct fetch only. Electron desktop hits the
    // network natively; Capacitor APK uses CapacitorHttp (configured in
    // capacitor.config.ts) to re-route through native OkHttp and bypass
    // Fish Audio's CORS preflight against capacitor://localhost.
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
