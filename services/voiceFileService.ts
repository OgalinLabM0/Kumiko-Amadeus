import { isCapacitorNative } from './environment';
// F2B.3: dropped `isMobilePwa` + `httpInvoke` + `getHttpVoiceUrl` +
// `getHttpCustomRingtoneUrl`. PWA voice/ringtone paths went through PC's
// Fastify; with the bridge gone, only Electron (electronAPI IPC) and
// Capacitor (Capacitor Filesystem + Dexie keyval) remain.
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

// F2B.3: simplified to Electron (electronAPI) OR Capacitor native. The
// PWA HTTP-bridge backend is gone with the rest of services/httpApi.ts.
// On Capacitor we use @capacitor/filesystem under
// Directory.Data/voices/{id}.mp3, sandboxed to the app and persistent
// across launches.
const hasBackend = (): boolean => !!getIpc() || isCapacitorNative();

// A.3: voice file storage on Capacitor native (Android APK / iOS .ipa).
// Uses Capacitor Filesystem (NOT Dexie) because voice clips can total
// 100s of MB after a year of conversation; Dexie's 5-50 MB IndexedDB
// quota would evict them silently. Directory.Data is the right pick:
//   - Sandboxed to the app (`/data/data/com.kumiko.amadeus.app/files/...`)
//   - Persistent across launches (unlike Cache)
//   - Not visible to other apps via SAF (we're not handing out shares)
//   - Backup-safe: included in Android Auto Backup unless we mark
//     android:allowBackup="false" (we don't, so cloud restore retains
//     voice history alongside Dexie)
//
// Failures (out-of-space, sandbox revoked, etc.) bubble up as `false`
// from the wrappers so the caller's existing
// `if (!success) addMessageToStore(text)` text-only fallback fires.
const VOICE_DIR = 'voices';

async function capacitorVoiceWrite(messageId: string, buffer: ArrayBuffer): Promise<boolean> {
    try {
        const { Filesystem, Directory } = await import('@capacitor/filesystem');
        await Filesystem.writeFile({
            path: `${VOICE_DIR}/${messageId}.mp3`,
            data: arrayBufferToBase64(buffer),
            directory: Directory.Data,
            recursive: true,
        });
        return true;
    } catch (e) {
        console.warn('[voiceFileService] Capacitor voice write failed:', e);
        return false;
    }
}

async function capacitorVoiceRead(messageId: string): Promise<ArrayBuffer | null> {
    try {
        const { Filesystem, Directory } = await import('@capacitor/filesystem');
        const result = await Filesystem.readFile({
            path: `${VOICE_DIR}/${messageId}.mp3`,
            directory: Directory.Data,
        });
        const data = (result as { data?: unknown }).data;
        if (typeof data === 'string') {
            const binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
            return bytes.buffer;
        }
        // Web Filesystem returns Blob; coerce to ArrayBuffer.
        if (data instanceof Blob) return await data.arrayBuffer();
        return null;
    } catch {
        // Filesystem.readFile throws on missing path — voice file simply
        // hasn't been generated yet (or was deleted), no warn needed.
        return null;
    }
}

async function capacitorVoiceDelete(messageId: string): Promise<boolean> {
    try {
        const { Filesystem, Directory } = await import('@capacitor/filesystem');
        await Filesystem.deleteFile({
            path: `${VOICE_DIR}/${messageId}.mp3`,
            directory: Directory.Data,
        });
        return true;
    } catch {
        return false;
    }
}

async function capacitorVoiceList(): Promise<VoiceFileInfo[]> {
    try {
        const { Filesystem, Directory } = await import('@capacitor/filesystem');
        // F2A.1: New install / never-recorded users hit Filesystem.readdir
        // before the directory exists, which throws OS-PLUG-FILE-0008 and
        // gets logged as native [ERROR] in logcat / our LogViewer even
        // though the JS try/catch swallows it. mkdir({ recursive: true })
        // is idempotent (swallow "exists" error) and prevents the spam.
        try {
            await Filesystem.mkdir({ path: VOICE_DIR, directory: Directory.Data, recursive: true });
        } catch (e: any) {
            if (e?.message && !/exist/i.test(String(e.message))) throw e;
        }
        const result = await Filesystem.readdir({ path: VOICE_DIR, directory: Directory.Data });
        const files = (result as { files?: Array<{ name: string; size?: number; mtime?: number }> }).files || [];
        return files
            .filter((f) => /\.mp3$/i.test(f.name))
            .map((f) => ({
                id: f.name.replace(/\.mp3$/i, ''),
                size: f.size || 0,
                mtime: f.mtime || 0,
            }));
    } catch {
        return [];
    }
}

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
    // F2B.3: Capacitor is now the only non-Electron writer (PWA branch removed).
    if (isCapacitorNative()) {
        return capacitorVoiceWrite(messageId, buffer);
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
    if (isCapacitorNative()) {
        return capacitorVoiceRead(messageId);
    }
    return null;
}

export async function deleteVoiceFile(messageId: string): Promise<boolean> {
    const ipc = getIpc();
    if (ipc) {
        const result = await ipc.invoke('voice:delete', { messageId });
        return result?.success === true;
    }
    if (isCapacitorNative()) {
        return capacitorVoiceDelete(messageId);
    }
    return false;
}

export async function listVoiceFiles(): Promise<VoiceFileInfo[]> {
    const ipc = getIpc();
    if (ipc) {
        const result = await ipc.invoke('voice:list');
        return result?.files ?? [];
    }
    if (isCapacitorNative()) {
        return capacitorVoiceList();
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
    if (isCapacitorNative()) {
        const files = await capacitorVoiceList();
        const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
        return { count: files.length, totalBytes };
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
        // F2B.3: dropped the PWA `getHttpCustomRingtoneUrl()` branch
        // (was streamed from desktop's /media/ringtone route). Both
        // remaining backends — Electron desktop and Capacitor native —
        // load the bytes locally via loadRingtoneFileWithName() and wrap
        // in a blob: URL.
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
