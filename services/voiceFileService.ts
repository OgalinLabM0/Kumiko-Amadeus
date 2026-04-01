const getIpc = () => {
    try {
        if (typeof window === 'undefined' || !(window as any).electronAPI) return null;
        return (window as any).electronAPI;
    } catch { return null; }
};

export const isVoiceServiceAvailable = () => !!getIpc();
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
    if (!ipc) return false;
    const result = await ipc.invoke('voice:save', { messageId, buffer: new Uint8Array(buffer) });
    return result?.success === true;
}

export async function loadVoiceFile(messageId: string): Promise<ArrayBuffer | null> {
    const ipc = getIpc();
    if (!ipc) return null;
    const result = await ipc.invoke('voice:load', { messageId });
    if (!result?.success || !result.buffer) return null;
    const buf = result.buffer;
    if (buf instanceof ArrayBuffer) return buf;
    if (buf?.buffer instanceof ArrayBuffer) return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return null;
}

export async function deleteVoiceFile(messageId: string): Promise<boolean> {
    const ipc = getIpc();
    if (!ipc) return false;
    const result = await ipc.invoke('voice:delete', { messageId });
    return result?.success === true;
}

export async function listVoiceFiles(): Promise<VoiceFileInfo[]> {
    const ipc = getIpc();
    if (!ipc) return [];
    const result = await ipc.invoke('voice:list');
    return result?.files ?? [];
}

export async function openVoiceFolder(): Promise<void> {
    const ipc = getIpc();
    if (!ipc) return;
    await ipc.invoke('voice:open-folder');
}

export async function getVoiceStorageInfo(): Promise<VoiceStorageInfo> {
    const ipc = getIpc();
    if (!ipc) return { count: 0, totalBytes: 0 };
    const result = await ipc.invoke('voice:get-storage-info');
    return { count: result?.count ?? 0, totalBytes: result?.totalBytes ?? 0 };
}

export async function saveRingtoneFile(buffer: ArrayBuffer, ext: string, originalName?: string): Promise<boolean> {
    const ipc = getIpc();
    if (!ipc) return false;
    const result = await ipc.invoke('ringtone:save', {
        buffer: new Uint8Array(buffer),
        ext,
        originalName,
    });
    return result?.success === true;
}

export async function loadRingtoneFile(): Promise<ArrayBuffer | null> {
    const ipc = getIpc();
    if (!ipc) return null;
    const result = await ipc.invoke('ringtone:load');
    if (!result?.success || !result.buffer) return null;
    const buf = result.buffer;
    if (buf instanceof ArrayBuffer) return buf;
    if (buf?.buffer instanceof ArrayBuffer) return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return null;
}

export async function loadRingtoneFileWithName(): Promise<{ buffer: ArrayBuffer; fileName: string; displayName: string } | null> {
    const ipc = getIpc();
    if (!ipc) return null;
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

export async function resolveRingtoneAudioSource(ringtoneFileId?: string | null): Promise<RingtoneAudioSource | null> {
    if (isBuiltInRingtoneId(ringtoneFileId)) {
        const src = getBuiltInRingtoneUrl(ringtoneFileId);
        if (!src) return null;
        return {
            kind: 'built-in',
            src,
            fileName: ringtoneFileId,
        };
    }

    if (isCustomRingtoneId(ringtoneFileId)) {
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
    if (!ipc) return false;
    const result = await ipc.invoke('ringtone:delete');
    return result?.success === true;
}
