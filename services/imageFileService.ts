// v2.14.4 F.2: image binary storage on Capacitor native (Android APK).
//
// Before this file existed:
//   - Android stored every image as a base64 string inside the Dexie
//     `images` table (see services/imageService.ts F2B.3 fallback path).
//   - That blew up IndexedDB by ~33 % vs the original bytes, and put
//     long-lived large blobs into the WebView's IDB quota — same risk
//     vector as voice clips before voiceFileService.ts existed.
//   - Big image-heavy chats hit IDBFS pressure and silent eviction.
//
// After (v2.14.4 F):
//   - Capacitor branch writes the raw image bytes to
//     Directory.Data/images/<id>.<ext> via @capacitor/filesystem.
//   - Dexie keeps a metadata-only row (`base64Data: ''`, plus the new
//     `relativePath: 'images/<id>.<ext>'` field on ImageEntity F.1) so
//     getAllImages() / getImageDisplayUrl() / clearAllImages() / backup
//     export-import still work via the same imageService.ts API.
//
// Design notes:
//   - Same shape as services/voiceFileService.ts so the two are easy to
//     keep in sync (they share the OS-PLUG-FILE-0010 mkdir-spam pattern,
//     the Directory.Data location, the in-flight Promise mkdir memo,
//     etc.). Keeping them as siblings rather than collapsing into one
//     "fileService" because the wire-formats are different (mp3 binary
//     vs typed image bytes with mimeType) and the failure-mode fallbacks
//     diverge (voice -> text bubble, image -> Dexie base64 leftover).
//   - Errors (out-of-space, sandbox revoked, etc.) bubble up as `false`
//     / null from the wrappers so the caller in imageService.ts can fall
//     through to the legacy Dexie base64 path on a single image's
//     failure rather than nuking the whole save.
//   - Not branched on isCapacitorNative() inside this module: callers
//     gate the call site themselves (mirrors voiceFileService.ts).

const IMAGE_DIR = 'images';

function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

// See voiceFileService.ts ensureVoiceDir for the full backstory on why
// stat-then-mkdir-once-per-session is the only mkdir pattern that
// doesn't pollute logcat with OS-PLUG-FILE-0010 every boot. Same shape
// here, dedicated Promise so the two trees never share a memo (so a
// voice mkdir failure doesn't poison image writes and vice versa).
let imageDirEnsuredPromise: Promise<void> | null = null;
async function ensureImageDir(
    Filesystem: typeof import('@capacitor/filesystem').Filesystem,
    Directory: typeof import('@capacitor/filesystem').Directory,
): Promise<void> {
    if (imageDirEnsuredPromise) return imageDirEnsuredPromise;
    imageDirEnsuredPromise = (async () => {
        try {
            const info = await Filesystem.stat({ path: IMAGE_DIR, directory: Directory.Data });
            if ((info as { type?: string } | undefined)?.type === 'directory') return;
        } catch {
            /* stat 抛 not-exists / 其它异常都 fall through 到 mkdir */
        }
        try {
            await Filesystem.mkdir({ path: IMAGE_DIR, directory: Directory.Data, recursive: true });
        } catch (e: any) {
            const msg = String(e?.message || e || '').toLowerCase();
            if (!/exist|already|0010|0008/i.test(msg)) {
                console.warn('[imageFileService] ensureImageDir non-exist error:', e);
                imageDirEnsuredPromise = null;
            }
        }
    })();
    return imageDirEnsuredPromise;
}

export interface ImageFileInfo {
    id: string;
    ext: string;
    size: number;
    mtime: number;
    relativePath: string;
}

export interface ImageStorageInfo {
    count: number;
    totalBytes: number;
}

// Strip a stored relativePath ("images/abc.jpg") down to its `id` and
// `ext` parts. We store both because the same id could in theory be
// re-saved with a different ext (PNG -> WebP after re-compression),
// although in practice imageService.ts assigns an id-per-save so this
// is mostly defensive.
function parseImageBasename(name: string): { id: string; ext: string } | null {
    const m = name.match(/^(.+?)\.([a-z0-9]+)$/i);
    if (!m) return null;
    return { id: m[1], ext: m[2].toLowerCase() };
}

export function getImageRelativePath(id: string, ext: string): string {
    const safeExt = (ext || 'jpg').replace(/^\./, '').toLowerCase();
    return `${IMAGE_DIR}/${id}.${safeExt}`;
}

export async function capacitorImageWrite(
    id: string,
    ext: string,
    rawBase64: string,
): Promise<{ success: boolean; relativePath?: string; error?: string }> {
    try {
        const { Filesystem, Directory } = await import('@capacitor/filesystem');
        await ensureImageDir(Filesystem, Directory);
        const relativePath = getImageRelativePath(id, ext);
        await Filesystem.writeFile({
            path: relativePath,
            data: rawBase64,
            directory: Directory.Data,
        });
        return { success: true, relativePath };
    } catch (e) {
        console.warn('[imageFileService] write failed:', e);
        return { success: false, error: String((e as any)?.message || e) };
    }
}

// Returns raw base64 (no `data:` prefix) so callers can pair with the
// row's mimeType themselves (matches the existing imageService.ts
// `data:${mimeType};base64,${b64}` assembly point in getImageBase64).
export async function capacitorImageRead(relativePath: string): Promise<string | null> {
    if (!relativePath) return null;
    try {
        const { Filesystem, Directory } = await import('@capacitor/filesystem');
        const result = await Filesystem.readFile({
            path: relativePath,
            directory: Directory.Data,
        });
        const data = (result as { data?: unknown }).data;
        if (typeof data === 'string') return data;
        if (data instanceof Blob) {
            const buf = await data.arrayBuffer();
            return arrayBufferToBase64(buf);
        }
        return null;
    } catch {
        // Missing path is the normal "image not yet written / already
        // cleared" case — quiet on purpose so a stale imageId in a
        // message doesn't spam warns every render.
        return null;
    }
}

export async function capacitorImageDelete(relativePath: string): Promise<boolean> {
    if (!relativePath) return false;
    try {
        const { Filesystem, Directory } = await import('@capacitor/filesystem');
        await Filesystem.deleteFile({
            path: relativePath,
            directory: Directory.Data,
        });
        return true;
    } catch {
        return false;
    }
}

export async function capacitorImageList(): Promise<ImageFileInfo[]> {
    try {
        const { Filesystem, Directory } = await import('@capacitor/filesystem');
        await ensureImageDir(Filesystem, Directory);
        const result = await Filesystem.readdir({ path: IMAGE_DIR, directory: Directory.Data });
        const files = (result as { files?: Array<{ name: string; size?: number; mtime?: number }> }).files || [];
        const out: ImageFileInfo[] = [];
        for (const f of files) {
            const parsed = parseImageBasename(f.name);
            if (!parsed) continue;
            out.push({
                id: parsed.id,
                ext: parsed.ext,
                size: f.size || 0,
                mtime: f.mtime || 0,
                relativePath: `${IMAGE_DIR}/${f.name}`,
            });
        }
        return out;
    } catch {
        return [];
    }
}

// One-shot directory wipe for the Data Management "clear images"
// button. Returns the number of files actually deleted; the caller
// (imageService.clearAllImages) chases this with a Dexie clear() so
// metadata rows don't outlive the bytes.
export async function capacitorImageClearAll(): Promise<{ success: boolean; cleared: number; error?: string }> {
    try {
        const files = await capacitorImageList();
        let cleared = 0;
        for (const f of files) {
            if (await capacitorImageDelete(f.relativePath)) cleared += 1;
        }
        return { success: true, cleared };
    } catch (e) {
        return { success: false, cleared: 0, error: String((e as any)?.message || e) };
    }
}

export async function getImageStorageInfo(): Promise<ImageStorageInfo> {
    const files = await capacitorImageList();
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    return { count: files.length, totalBytes };
}
