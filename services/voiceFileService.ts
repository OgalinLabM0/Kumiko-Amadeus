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

// v2.14.1 B.1: Capacitor Filesystem.mkdir on an already-existing directory
// throws on the JS side AND logs a native [ERROR] OS-PLUG-FILE-0010 to
// logcat (which our LogViewer captures), even though the JS try/catch
// swallows the throw. Calling mkdir on every single readdir / write
// produced 100+ entries of log spam per session. Memoize the first
// successful (or already-exists) attempt module-wide so the spam stops
// after a single boot-time call.
// v2.14.3 N.6: switched from a boolean flag to an in-flight Promise so
// concurrent callers (capacitorVoiceWrite + capacitorVoiceList +
// clearAllVoices firing on settings open) all share the same mkdir
// attempt instead of racing into separate Filesystem.mkdir calls. Each
// race produced one OS-PLUG-FILE-0010 "Directory already exists" warn
// log per concurrent caller — visible as a wall of yellow lines on app
// startup, even though the outcome was always benign. With a Promise
// memo, the first caller does the mkdir, every subsequent caller within
// the same boot awaits the same Promise (or short-circuits if it
// already settled).
let voiceDirEnsuredPromise: Promise<void> | null = null;
async function ensureVoiceDir(
    Filesystem: typeof import('@capacitor/filesystem').Filesystem,
    Directory: typeof import('@capacitor/filesystem').Directory,
): Promise<void> {
    if (voiceDirEnsuredPromise) return voiceDirEnsuredPromise;
    voiceDirEnsuredPromise = (async () => {
        try {
            await Filesystem.mkdir({ path: VOICE_DIR, directory: Directory.Data, recursive: true });
        } catch (e: any) {
            // OS-PLUG-FILE-0010 ("Directory already exists"), localized variants
            // ("Directory exists", "已存在", "存在しています"), and OS-PLUG-FILE
            // numeric tail are all benign — the directory is there, we proceed.
            // Anything else (sandbox revoked, OOM) we still swallow because
            // the subsequent readdir / writeFile will surface the real error.
            const msg = String(e?.message || e || '').toLowerCase();
            if (!/exist|already|0010|0008/i.test(msg)) {
                console.warn('[voiceFileService] ensureVoiceDir non-exist error:', e);
                // Reset the memo so the next *new* call retries — only on a
                // genuine, unexpected failure. We deliberately don't reset on
                // the benign "already exists" path; that would defeat the
                // whole purpose of the Promise memo.
                voiceDirEnsuredPromise = null;
            }
        }
    })();
    return voiceDirEnsuredPromise;
}

async function capacitorVoiceWrite(messageId: string, buffer: ArrayBuffer): Promise<boolean> {
    try {
        const { Filesystem, Directory } = await import('@capacitor/filesystem');
        await ensureVoiceDir(Filesystem, Directory);
        await Filesystem.writeFile({
            path: `${VOICE_DIR}/${messageId}.mp3`,
            data: arrayBufferToBase64(buffer),
            directory: Directory.Data,
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
        // v2.14.1 B.1: replaced inline try/catch mkdir with module-level
        // memoized ensureVoiceDir (above). Same idempotent-mkdir intent
        // but we only spam logcat once per session at most.
        await ensureVoiceDir(Filesystem, Directory);
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

// v2.14.1 E.1: bulk-clear API. On Capacitor we replaced the dead "open
// folder" button with a "Clear N MB" button (Android scoped storage
// makes a file-manager hop a non-starter without a SAF picker UX
// detour). PC still uses openVoiceFolder so this branch isn't exposed
// in DataManagementSection on Electron, but we keep the IPC try/catch
// so a future PC clear-all UI can simply call this same function.
export async function clearAllVoices(): Promise<{ success: boolean; cleared: number; error?: string }> {
    const ipc = getIpc();
    if (ipc) {
        try {
            const result = await ipc.invoke('voice:clear-all');
            if (result?.success) return { success: true, cleared: result.cleared ?? 0 };
            // Older builds (pre-E.1) don't ship the IPC; fall through to
            // the list-and-delete loop so the call still succeeds.
            if (result?.error && !/no handler/i.test(result.error)) {
                return { success: false, cleared: 0, error: result.error };
            }
        } catch (e) {
            const msg = String((e as any)?.message || e);
            if (!/no handler/i.test(msg)) {
                return { success: false, cleared: 0, error: msg };
            }
        }
        // Fallback: read the file list and delete each entry. Slower
        // (one IPC roundtrip per file) but bounded by the `voice:list`
        // count and runs entirely off the main thread on the renderer.
        try {
            const list = await ipc.invoke('voice:list');
            const files: VoiceFileInfo[] = list?.files ?? [];
            let cleared = 0;
            for (const f of files) {
                const r = await ipc.invoke('voice:delete', { messageId: f.id });
                if (r?.success) cleared += 1;
            }
            return { success: true, cleared };
        } catch (e) {
            return { success: false, cleared: 0, error: String((e as any)?.message || e) };
        }
    }

    if (isCapacitorNative()) {
        try {
            const { Filesystem, Directory } = await import('@capacitor/filesystem');
            await ensureVoiceDir(Filesystem, Directory);
            const result = await Filesystem.readdir({ path: VOICE_DIR, directory: Directory.Data });
            const files = (result as { files?: Array<{ name: string }> }).files || [];
            let cleared = 0;
            for (const f of files) {
                if (!/\.mp3$/i.test(f.name)) continue;
                try {
                    await Filesystem.deleteFile({
                        path: `${VOICE_DIR}/${f.name}`,
                        directory: Directory.Data,
                    });
                    cleared += 1;
                } catch (e) {
                    // Skip files we can't delete (e.g. another process
                    // is writing one) but keep going so the user gets
                    // most of the space back.
                    console.warn('[voiceFileService] clearAllVoices: failed to delete', f.name, e);
                }
            }
            return { success: true, cleared };
        } catch (e) {
            return { success: false, cleared: 0, error: String((e as any)?.message || e) };
        }
    }

    return { success: false, cleared: 0, error: 'unsupported-platform' };
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

// v2.14.1 E.3: high-level "clear custom ringtone" wrapper used by the
// Data Management UI. The underlying delete is the same as
// `deleteRingtoneFile()` but we additionally report a `hadRingtone`
// flag so the dialog can render different copy ("没有自定义铃声可清理"
// vs "已清理自定义铃声"). On Capacitor we also wipe both keyval keys
// the rest of the codebase has historically used for the "uploaded
// ringtone" so future migrations don't leak orphans.
export async function clearRingtone(): Promise<{ success: boolean; hadRingtone: boolean; error?: string }> {
    try {
        // First check if there is a custom ringtone at all so the UI
        // can give a polite "nothing to clear" message instead of
        // pretending the click did something.
        const had = await loadRingtoneFile().then((b) => !!b).catch(() => false);
        const ipc = getIpc();
        if (ipc) {
            const result = await ipc.invoke('ringtone:delete');
            return { success: result?.success !== false, hadRingtone: had };
        }
        if (isCapacitorNative()) {
            try {
                await db.keyval.delete(CAPACITOR_RINGTONE_KEY);
            } catch (e) {
                return { success: false, hadRingtone: had, error: String((e as any)?.message || e) };
            }
            return { success: true, hadRingtone: had };
        }
        return { success: false, hadRingtone: had, error: 'unsupported-platform' };
    } catch (e) {
        return { success: false, hadRingtone: false, error: String((e as any)?.message || e) };
    }
}
