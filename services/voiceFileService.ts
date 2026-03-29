const getIpc = () => {
    try {
        if (typeof window === 'undefined' || !(window as any).electronAPI) return null;
        return (window as any).electronAPI;
    } catch { return null; }
};

export const isVoiceServiceAvailable = () => !!getIpc();

export interface VoiceFileInfo {
    id: string;
    size: number;
    mtime: number;
}

export interface VoiceStorageInfo {
    count: number;
    totalBytes: number;
}

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

export async function saveRingtoneFile(buffer: ArrayBuffer, ext: string): Promise<boolean> {
    const ipc = getIpc();
    if (!ipc) return false;
    const result = await ipc.invoke('ringtone:save', { buffer: new Uint8Array(buffer), ext });
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

export async function loadRingtoneFileWithName(): Promise<{ buffer: ArrayBuffer; fileName: string } | null> {
    const ipc = getIpc();
    if (!ipc) return null;
    const result = await ipc.invoke('ringtone:load');
    if (!result?.success || !result.buffer) return null;
    const buf = result.buffer;
    let ab: ArrayBuffer | null = null;
    if (buf instanceof ArrayBuffer) ab = buf;
    else if (buf?.buffer instanceof ArrayBuffer) ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    if (!ab) return null;
    return { buffer: ab, fileName: result.fileName || 'custom.mp3' };
}

export async function deleteRingtoneFile(): Promise<boolean> {
    const ipc = getIpc();
    if (!ipc) return false;
    const result = await ipc.invoke('ringtone:delete');
    return result?.success === true;
}
