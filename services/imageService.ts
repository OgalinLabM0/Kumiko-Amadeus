import imageCompression from 'browser-image-compression';
import { db } from './db';
import {
  DEFAULT_IMAGE_QUALITY_PRESET,
  IMAGE_QUALITY_PRESETS,
  type ImageQualityPreset,
} from '../constants/imageQualityConfig';
import { useAppStore } from '../store';
import { isDesktopElectron } from './desktopBackupService';
// F2B.3: dropped `isMobilePwa` + `httpInvoke` + `getHttpImageUrl` +
// `isCapacitorNative` imports. Capacitor APK keeps image bytes inside
// the local Dexie (base64Data), Electron desktop writes to
// userData/images via IPC. Branching is now `isDesktopElectron()` vs
// "everything else uses Dexie".

// ──────────────────────────────────────────────────────────────────────────────
// Image storage service (P1 #36)
//
// Before this refactor:
//   - Every image was squashed to 200KB / 1024px edge, visibly mangling detail.
//   - The squashed image was stored as a base64 data URL inside a Dexie table,
//     inflating disk usage by ~33% and making every message carry KB–MB of base64.
//
// After:
//   - Compression is governed by user-selected ImageQualityPreset
//     (high / balanced / compact / original) so detail-critical images survive.
//   - On desktop (Electron) the binary goes to userData/images/{id}.{ext} via IPC;
//     the renderer keeps only the imageId + caption. Loading for display goes
//     through the custom `kumiko-image://` protocol (see electron-main.cjs).
//   - On web / PWA builds there's no filesystem, so we keep the Dexie base64
//     fallback for compatibility.
// ──────────────────────────────────────────────────────────────────────────────

function currentPresetConfig() {
  const preset: ImageQualityPreset =
    (useAppStore.getState().imageQualityPreset as ImageQualityPreset | undefined)
    || DEFAULT_IMAGE_QUALITY_PRESET;
  return IMAGE_QUALITY_PRESETS[preset];
}

function pickExtFromMime(mime: string): 'png' | 'webp' | 'gif' | 'jpg' {
  if (!mime) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'jpg';
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('FileReader read error'));
    try {
      reader.readAsDataURL(blob);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Ship an image (raw base64 + extension) to the Electron desktop for
// userData storage. F2B.3 removed the mobile-PWA `images:save` HTTP
// branch — Capacitor APK falls through to the Dexie base64 path below.
async function saveImageToBackend(
  imageId: string,
  ext: string,
  rawBase64: string,
): Promise<{ success: boolean; filePath?: string; error?: string }> {
  if (isDesktopElectron() && (window as any).electronAPI) {
    const buffer = base64ToArrayBuffer(rawBase64);
    return (window as any).electronAPI.invoke('images:save', { imageId, ext, buffer });
  }
  return { success: false, error: 'No backend available' };
}

export const compressAndSaveImage = async (file: File): Promise<string> => {
  const cfg = currentPresetConfig();
  // The 'original' preset keeps the source file untouched; every other preset
  // runs it through the compressor with the preset's bounds.
  const processed = cfg.maxSizeMB === Infinity && cfg.maxWidthOrHeight === Infinity
    ? file
    : await imageCompression(file, {
        maxSizeMB: cfg.maxSizeMB,
        maxWidthOrHeight: cfg.maxWidthOrHeight,
        initialQuality: cfg.initialQuality,
        useWebWorker: true,
      });

  const imageId = 'img_' + Date.now() + '_' + Math.random().toString(36).substring(7);
  const mimeType = processed.type || 'image/jpeg';
  const ext = pickExtFromMime(mimeType);

  // F2B.3: simplified to "Electron desktop only" for filesystem path.
  // Capacitor APK + dev-server fallback drop straight to the Dexie base64
  // path below — both store images self-contained inside IndexedDB.
  if (isDesktopElectron() && (window as any).electronAPI) {
    try {
      const dataUrl = await blobToDataUrl(processed);
      const rawBase64 = dataUrl.split(',')[1] || '';
      const result = await saveImageToBackend(imageId, ext, rawBase64);
      if (!result?.success) throw new Error(result?.error || 'images:save failed');
      // Keep a metadata-only row so things like imageService.getAllImages()
      // (and the rest of the existing Dexie-based code paths) keep working.
      await db.images.add({
        id: imageId,
        base64Data: '',
        mimeType,
        timestamp: Date.now(),
      });
      return imageId;
    } catch (err) {
      console.warn('[imageService] Filesystem save failed, falling back to Dexie:', err);
      // Fall through to the Dexie path below.
    }
  }

  // Web / Capacitor / fallback path: keep the existing base64-in-Dexie
  // behaviour. Capacitor (A4.5) hits this branch directly so images are
  // self-contained inside the APK's IndexedDB.
  const dataUrl = await blobToDataUrl(processed);
  await db.images.add({
    id: imageId,
    base64Data: dataUrl,
    mimeType,
    timestamp: Date.now(),
  });
  return imageId;
};

// Resolve a URL we can put into <img src> for a given imageId.
//   - Desktop: custom kumiko-image:// protocol so Chromium can lazy-load
//     and cache the file off-renderer.
//   - Capacitor APK + dev-server fallback: data URL from Dexie. F2B.3
//     dropped the PWA `getHttpImageUrl()` branch alongside the rest of
//     the PC bridge.
export const getImageDisplayUrl = async (imageId: string): Promise<string | null> => {
  if (!imageId) return null;
  if (isDesktopElectron()) {
    return `kumiko-image://${encodeURIComponent(imageId)}`;
  }
  const row = await db.images.get(imageId);
  return row?.base64Data || null;
};

// Legacy callers (model tool calls, RAG, etc.) still want the data URL.
// Prefer the filesystem copy on desktop; on mobile we fetch the bytes
// from the PC's /media/images/:id route and base64-encode in the phone
// renderer (the route already enforces the session cookie).
export const getImageBase64 = async (imageId: string): Promise<string | undefined> => {
  if (!imageId) return undefined;
  if (isDesktopElectron() && (window as any).electronAPI) {
    try {
      const result = await (window as any).electronAPI.invoke('images:load', { imageId });
      if (result?.success && result.buffer) {
        const b64 = arrayBufferToBase64(result.buffer);
        return `data:${result.mimeType || 'image/jpeg'};base64,${b64}`;
      }
    } catch (err) {
      console.warn('[imageService] images:load failed, falling back to Dexie:', err);
    }
  }
  // F2B.3: dropped the PWA /media/images fetch path. Capacitor APK and
  // dev-server fallback both reach here: the image bytes live in
  // db.images.base64Data because the saveImage Capacitor branch wrote
  // them there. Returns the cached data URL as-is.
  const row = await db.images.get(imageId);
  return row?.base64Data || undefined;
};

// Preserved for backwards-compatibility with callers that expected a sync-ish
// "get the image" function. The earlier code had a `getImage` alias; kept here so
// no callers break.
export const getImage = getImageBase64;

// P2 #6 Phase 1 (and fix for desktop export silently dropping images):
// On desktop, `db.images` rows are metadata-only (`base64Data: ''`) because
// `rag:save` wrote the real bytes to userData/images/{id}.{ext}. The old
// implementation below returned those rows with `data: ''`, and
// handleExportBackup's regex then silently dropped them from the zip — users
// saw "backup exported" while the zip's images/ folder was empty. Now we
// hydrate every metadata-only row from the filesystem via `images:load` IPC
// (which getImageBase64 already implements), so callers always get a real
// data URL. On web, base64Data is populated and this is a cheap pass-through.
export const getAllImages = async () => {
  const images = await db.images.toArray();
  const out: { id: string; data: string }[] = [];
  for (const img of images) {
    if (img.base64Data) {
      out.push({ id: img.id, data: img.base64Data });
      continue;
    }
    const hydrated = await getImageBase64(img.id);
    if (hydrated) {
      out.push({ id: img.id, data: hydrated });
    } else {
      console.warn('[imageService] getAllImages could not hydrate image id:', img.id);
    }
  }
  return out;
};

export const saveImageWithId = async (id: string, base64Data: string) => {
  const match = base64Data.match(/^data:(.*);base64,(.*)$/);
  const mimeType = match ? match[1] : 'image/jpeg';
  const rawBase64 = match ? match[2] : base64Data;

  // F2B.3: simplified to "Electron desktop only" for filesystem path.
  // Capacitor APK keeps the bytes in Dexie (base64Data) like dev preview.
  if (isDesktopElectron() && (window as any).electronAPI) {
    try {
      const ext = pickExtFromMime(mimeType);
      const result = await saveImageToBackend(id, ext, rawBase64);
      if (result?.success) {
        await db.images.put({
          id,
          base64Data: '',
          mimeType,
          timestamp: Date.now(),
        });
        return;
      }
      console.warn('[imageService] images:save fallback to Dexie:', result?.error);
    } catch (err) {
      console.warn('[imageService] images:save threw, falling back to Dexie:', err);
    }
  }

  await db.images.put({
    id,
    base64Data,
    mimeType,
    timestamp: Date.now(),
  });
};

// v2.14.1 E.2: bulk-clear API. On Capacitor (Android) the user has no
// way to reach the app-private IndexedDB from the OS file manager —
// scoped storage hides it behind the WebView sandbox. The Data
// Management UI now exposes a "Clear N images" button that fans out to
// this function. Returns { cleared } so the dialog can render
// "已清除 X 张图片". On Electron we additionally invoke the existing
// `images:clear-all` IPC if present, falling back to a list+delete loop
// against `images:delete` so the API is consistent across platforms.
export const clearAllImages = async (): Promise<{ success: boolean; cleared: number; error?: string }> => {
  try {
    const all = await db.images.toArray();
    const cleared = all.length;

    if (isDesktopElectron() && (window as any).electronAPI) {
      // Best-effort: try a one-shot IPC (cheaper than N IPC calls), and
      // fall through to per-id deletes if the channel doesn't exist.
      try {
        const result = await (window as any).electronAPI.invoke('images:clear-all');
        if (!result?.success) {
          for (const img of all) {
            try { await (window as any).electronAPI.invoke('images:delete', { imageId: img.id }); }
            catch { /* swallow individual failures, Dexie clear below is the source of truth */ }
          }
        }
      } catch {
        for (const img of all) {
          try { await (window as any).electronAPI.invoke('images:delete', { imageId: img.id }); }
          catch { /* swallow */ }
        }
      }
    }

    // Dexie clear is platform-agnostic and the canonical "no metadata
    // left" guarantee. Capacitor (Android) reaches here with the bytes
    // still inside base64Data and a clear() wipes them in one stroke;
    // Electron reaches here after the IPC + per-id loop above already
    // removed the on-disk PNG/JPG copies, so this just nukes the
    // remaining metadata rows.
    await db.images.clear();
    return { success: true, cleared };
  } catch (e) {
    return { success: false, cleared: 0, error: String((e as any)?.message || e) };
  }
};

export const imageService = {
  compressAndSaveImage,
  getImageBase64,
  getImage,
  getAllImages,
  saveImageWithId,
  getImageDisplayUrl,
  clearAllImages,
};
