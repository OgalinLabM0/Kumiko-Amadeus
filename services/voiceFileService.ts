import { isCapacitorNative, isMobilePwa } from './environment';
import { httpInvoke, getHttpVoiceUrl, getHttpCustomRingtoneUrl } from './httpApi';
import { db } from './db';

// A4.4: Capacitor native ringtone storage. Single user-uploaded ringtone
// fits comfortably in a Dexie keyval row (typical mp3 < 1 MB), so we
// avoid the @capacitor/filesystem complexity of remembering an absolute
// file path across app reinstalls. This row is also picked up by
// preferencesSync so a re-paired phone re-hydrates from the desktop's
// userData ringtone if the user later switches back to PWA.
const CAPACITOR_RINGTONE_KEY = 'kumiko_capacitor_custom_ringtone';

interface CapacitorRingtoneEntry {
  base64: string;
  ext: string;
  originalName?: string;
  savedAtMs: number;
}

function base64ToArrayBufferLocal(base64: string): ArrayBuffer {
  // Local copy to avoid the dynamic import dance — voiceFileService runs
  // very early on splash screen ringtone preview.
  const binary = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

const getIpc = () => {
    try {
        if (typeof window === 'undefined' || !(window as any).electronAPI) return null;
        return (window as any).electronAPI;
    } catch { return null; }
};

// On mobile PWA we don't have `window.electronAPI` but we do have the
// desktop's HTTP IPC bridge. The voice / ringtone channels are already
// whitelisted in Phase 3 Part B (images:save, voice:save, ringtone:save
// decode base64 in useMobileApiProxy and forward to the real handlers),
// so the mobile path is functionally identical to desktop.
const hasBackend = (): boolean => !!getIpc() || isMobilePwa();

export const isVoiceServiceAvailable = () => hasBackend();

function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}
export const BUILT_IN_RINGTONE_FILE_RE = /^(0[1-8])\.mp3$/i;
export const CUSTOM_RINGTONE_FILE_RE = /^custom\.(mp3|wav|ogg|m4a|aac|flac)$/i;

export interface VoiceFileInfo {
    id: string;
    size: number;
    mtime: number;
}

export interface VoiceStorageInfo {
    count: number;
    totalBytes: number;
}

export interface RingtoneAudioSource {
    kind: 'built-in' | 'custom';
    src: string;
    fileName: string;
    displayName?: string;
    cleanup?: () => void;
}

export const getAudioMimeTypeForFileName = (fileName: string) => {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.wav')) return 'audio/wav';
    if (lower.endsWith('.ogg')) return 'audio/ogg';
    if (lower.endsWith('.m4a')) return 'audio/mp4';
    if (lower.endsWith('.aac')) return 'audio/aac';
    if (lower.endsWith('.flac')) return 'audio/flac';
    return 'audio/mpeg';
};

export const isBuiltInRingtoneId = (value?: string | null): value is string => (
    typeof value === 'string' && BUILT_IN_RINGTONE_FILE_RE.test(value)
);

export const isCustomRingtoneId = (value?: string | null): value is string => (
    typeof value === 'string' && CUSTOM_RINGTONE_FILE_RE.test(value)
);

export const getBuiltInRingtoneUrl = (ringtoneFileId: string): string | null => {
    if (!isBuiltInRingtoneId(ringtoneFileId) || typeof window === 'undefined') return null;
    return new URL(`ringtones/${ringtoneFileId}`, window.location.href).toString();
};

export async function saveVoiceFile(messageId: string, buffer: ArrayBuffer): Promise<boolean> {
    const ipc = getIpc();
    if (ipc) {
        const result = await ipc.invoke('voice:save', { messageId, buffer: new Uint8Array(buffer) });
        return result?.success === true;
    }
    if (isMobilePwa()) {
        const result = await httpInvoke<{ success?: boolean }>('voice:save', {
            messageId,
            bufferB64: arrayBufferToBase64(buffer),
        });
        return result?.success === true;
    }
    return false;
}

export async function loadVoiceFile(messageId: string): Promise<ArrayBuffer | null> {
    const ipc = getIpc();
    if (ipc) {
        const result = await ipc.invoke('voice:load', { messageId });
        if (!result?.success || !result.buffer) return null;
        const buf = result.buffer;
        if (buf instanceof ArrayBuffer) return buf;
        if (buf?.buffer instanceof ArrayBuffer) return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        return null;
    }
    if (isMobilePwa()) {
        try {
            const response = await fetch(getHttpVoiceUrl(messageId), { credentials: 'include' });
            if (!response.ok) return null;
            return await response.arrayBuffer();
        } catch { return null; }
    }
    return null;
}

export async function deleteVoiceFile(messageId: string): Promise<boolean> {
    const ipc = getIpc();
    if (ipc) {
        const result = await ipc.invoke('voice:delete', { messageId });
        return result?.success === true;
    }
    if (isMobilePwa()) {
        const result = await httpInvoke<{ success?: boolean }>('voice:delete', { messageId });
        return result?.success === true;
    }
    return false;
}

export async function listVoiceFiles(): Promise<VoiceFileInfo[]> {
    const ipc = getIpc();
    if (ipc) {
        const result = await ipc.invoke('voice:list');
        return result?.files ?? [];
    }
    if (isMobilePwa()) {
        const result = await httpInvoke<{ files?: VoiceFileInfo[] }>('voice:list', {});
        return result?.files ?? [];
    }
    return [];
}

export async function openVoiceFolder(): Promise<void> {
    const ipc = getIpc();
    if (!ipc) return; // Intentionally PC-only — a file-explorer open is meaningless on mobile.
    await ipc.invoke('voice:open-folder');
}

export async function getVoiceStorageInfo(): Promise<VoiceStorageInfo> {
    const ipc = getIpc();
    if (ipc) {
        const result = await ipc.invoke('voice:get-storage-info');
        return { count: result?.count ?? 0, totalBytes: result?.totalBytes ?? 0 };
    }
    if (isMobilePwa()) {
        const result = await httpInvoke<VoiceStorageInfo>('voice:get-storage-info', {});
        return { count: result?.count ?? 0, totalBytes: result?.totalBytes ?? 0 };
    }
    return { count: 0, totalBytes: 0 };
}

export async function saveRingtoneFile(buffer: ArrayBuffer, ext: string, originalName?: string): Promise<boolean> {
    const ipc = getIpc();
    if (ipc) {
        const result = await ipc.invoke('ringtone:save', {
            buffer: new Uint8Array(buffer),
            ext,
            originalName,
        });
        return result?.success === true;
    }
    // Capacitor native (A4.4): persist to Dexie keyval. The TtsConfigSection
    // ringtone preview / VoiceCallOverlay both go through resolveRingtoneAudioSource
    // which produces a blob: URL on the Capacitor branch, so we never need
    // to know the absolute filesystem path.
    if (isCapacitorNative()) {
        try {
            const entry: CapacitorRingtoneEntry = {
                base64: arrayBufferToBase64(buffer),
                ext: ext.replace(/^\./, '').toLowerCase() || 'mp3',
                originalName,
                savedAtMs: Date.now(),
            };
            await db.setVal(CAPACITOR_RINGTONE_KEY, entry);
            return true;
        } catch (e) {
            console.error('[voiceFileService] Capacitor ringtone save failed:', e);
            return false;
        }
    }
    if (isMobilePwa()) {
        const result = await httpInvoke<{ success?: boolean }>('ringtone:save', {
            bufferB64: arrayBufferToBase64(buffer),
            ext,
            originalName,
        });
        return result?.success === true;
    }
    return false;
}

export async function loadRingtoneFile(): Promise<ArrayBuffer | null> {
    const ipc = getIpc();
    if (ipc) {
        const result = await ipc.invoke('ringtone:load');
        if (!result?.success || !result.buffer) return null;
        const buf = result.buffer;
        if (buf instanceof ArrayBuffer) return buf;
        if (buf?.buffer instanceof ArrayBuffer) return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        return null;
    }
    if (isCapacitorNative()) {
        try {
            const entry = await db.getVal<CapacitorRingtoneEntry | null>(CAPACITOR_RINGTONE_KEY, null);
            if (!entry || typeof entry.base64 !== 'string') return null;
            return base64ToArrayBufferLocal(entry.base64);
        } catch (e) {
            console.warn('[voiceFileService] Capacitor ringtone load failed:', e);
            return null;
        }
    }
    // Mobile PWA ringtone streaming is delivered via the /media/ringtone
    // route in Phase 5 Part D. Until then a phone that needs the raw
    // buffer (e.g., to re-save during export) can simply rely on the
    // server's userData copy via the backup HTTP routes.
    return null;
}

export async function loadRingtoneFileWithName(): Promise<{ buffer: ArrayBuffer; fileName: string; displayName: string } | null> {
    const ipc = getIpc();
    if (ipc) {
        const result = await ipc.invoke('ringtone:load');
        if (!result?.success || !result.buffer) return null;
        const buf = result.buffer;
        let ab: ArrayBuffer | null = null;
        if (buf instanceof ArrayBuffer) ab = buf;
        else if (buf?.buffer instanceof ArrayBuffer) ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        if (!ab) return null;
        const fileName = result.fileName || 'custom.mp3';
        return {
            buffer: ab,
            fileName,
            displayName: result.displayName || fileName,
        };
    }
    if (isCapacitorNative()) {
        try {
            const entry = await db.getVal<CapacitorRingtoneEntry | null>(CAPACITOR_RINGTONE_KEY, null);
            if (!entry || typeof entry.base64 !== 'string') return null;
            const ab = base64ToArrayBufferLocal(entry.base64);
            const fileName = `custom.${entry.ext || 'mp3'}`;
            return {
                buffer: ab,
                fileName,
                displayName: entry.originalName || fileName,
            };
        } catch (e) {
            console.warn('[voiceFileService] Capacitor ringtone load-with-name failed:', e);
            return null;
        }
    }
    return null;
}

export async function resolveRingtoneAudioSource(ringtoneFileId?: string | null): Promise<RingtoneAudioSource | null> {
    if (isBuiltInRingtoneId(ringtoneFileId)) {
        // Built-in ringtones ship inside dist/ringtones/ so both
        // Electron's file:// loader and Fastify's @fastify/static mount
        // serve them without any special handling. getBuiltInRingtoneUrl
        // resolves against window.location.href which correctly becomes
        // https://<tailscale>:<port>/ringtones/0X.mp3 on mobile.
        const src = getBuiltInRingtoneUrl(ringtoneFileId);
        if (!src) return null;
        return {
            kind: 'built-in',
            src,
            fileName: ringtoneFileId,
        };
    }

    if (isCustomRingtoneId(ringtoneFileId)) {
        // Phase 5 Part D: on mobile PWA, stream the custom ringtone
        // directly from the desktop's /media/ringtone route instead of
        // shuttling its bytes through a JSON IPC bridge. This matches
        // the voice-clip and image paths (fetch the blob via HTTP,
        // let the browser cache and range-request it).
        // Capacitor branch checked separately so it falls through to the
        // Dexie blob path below — A4.4 stores the ringtone bytes in
        // db.keyval, no PC dependency.
        if (isMobilePwa() && !isCapacitorNative()) {
            const fileName = ringtoneFileId;
            const src = getHttpCustomRingtoneUrl();
            return {
                kind: 'custom',
                src,
                fileName,
                displayName: fileName,
            };
        }
        // Electron desktop AND Capacitor native both reach this branch:
        // loadRingtoneFileWithName() returns the bytes from electronAPI
        // (desktop) or db.keyval (Capacitor). Either way we wrap in a
        // blob: URL the <audio> element can stream.
        const loaded = await loadRingtoneFileWithName();
        if (!loaded) return null;
        const blob = new Blob([loaded.buffer], { type: getAudioMimeTypeForFileName(loaded.fileName) });
        const src = URL.createObjectURL(blob);
        return {
            kind: 'custom',
            src,
            fileName: loaded.fileName,
            displayName: loaded.displayName,
            cleanup: () => URL.revokeObjectURL(src),
        };
    }

    return null;
}

export async function deleteRingtoneFile(): Promise<boolean> {
    const ipc = getIpc();
    if (ipc) {
        const result = await ipc.invoke('ringtone:delete');
        return result?.success === true;
    }
    if (isCapacitorNative()) {
        try {
            await db.keyval.delete(CAPACITOR_RINGTONE_KEY);
            return true;
        } catch (e) {
            console.warn('[voiceFileService] Capacitor ringtone delete failed:', e);
            return false;
        }
    }
    return false;
}
