import imageCompression from 'browser-image-compression';
import { db } from './db';
import {
  DEFAULT_IMAGE_QUALITY_PRESET,
  IMAGE_QUALITY_PRESETS,
  type ImageQualityPreset,
} from '../constants/imageQualityConfig';
import { useAppStore } from '../store';
import { isDesktopElectron } from './desktopBackupService';
import { isMobilePwa } from './environment';
import { httpInvoke, getHttpImageUrl } from './httpApi';

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

// Ship an image (raw base64 + extension) to the desktop for userData
// storage. On desktop this goes directly through electronAPI.invoke; on
// mobile PWA it goes over POST /api/ipc/images:save which is handled on
// the PC renderer side (useMobileApiProxy.handleImagesSave decodes the
// base64 and forwards to the real IPC handler). Returns the IPC result
// shape `{ success, filePath?, error? }`. This lets both mobile image
// uploads and mobile backup-import image restoration land on the PC's
// filesystem instead of leaking into a phone-local Dexie shell that
// will never be read.
async function saveImageToBackend(
  imageId: string,
  ext: string,
  rawBase64: string,
): Promise<{ success: boolean; filePath?: string; error?: string }> {
  if (isDesktopElectron() && (window as any).electronAPI) {
    const buffer = base64ToArrayBuffer(rawBase64);
    return (window as any).electronAPI.invoke('images:save', { imageId, ext, buffer });
  }
  if (isMobilePwa()) {
    return httpInvoke('images:save', { imageId, ext, bufferB64: rawBase64 });
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

  // Desktop + Mobile PWA both land the image on the PC's filesystem via
  // the `images:save` IPC/HTTP bridge. Desktop uses the direct Electron
  // IPC; mobile goes through /api/ipc/images:save which proxies the
  // base64 through the PC renderer into userData/images/{id}.{ext}.
  if ((isDesktopElectron() && (window as any).electronAPI) || isMobilePwa()) {
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

  // Web / fallback path: keep the existing base64-in-Dexie behaviour.
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
//   - Mobile PWA: GET /media/images/:id, same userData/images source
//     of truth as desktop. The cookie-gated route handles auth.
//   - Web fallback (dev preview): data URL from Dexie, same as before.
export const getImageDisplayUrl = async (imageId: string): Promise<string | null> => {
  if (!imageId) return null;
  if (isDesktopElectron()) {
    // Cache-bust with the image id itself — file contents don't mutate in place.
    return `kumiko-image://${encodeURIComponent(imageId)}`;
  }
  if (isMobilePwa()) {
    return getHttpImageUrl(imageId);
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
  if (isMobilePwa()) {
    try {
      const response = await fetch(getHttpImageUrl(imageId), { credentials: 'include' });
      if (response.ok) {
        const arr = await response.arrayBuffer();
        const mime = response.headers.get('Content-Type') || 'image/jpeg';
        return `data:${mime};base64,${arrayBufferToBase64(arr)}`;
      }
    } catch (err) {
      console.warn('[imageService] /media/images fetch failed, falling back to Dexie:', err);
    }
  }
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

  // Both desktop Electron and mobile PWA persist through the PC's
  // userData/images/ filesystem — see saveImageToBackend. Mobile can't
  // keep images in its local Dexie because the PC serves /media/images
  // from disk, not from Dexie. Falling back to Dexie on failure keeps
  // dev-preview builds (no PC backend at all) alive.
  if ((isDesktopElectron() && (window as any).electronAPI) || isMobilePwa()) {
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

export const imageService = {
  compressAndSaveImage,
  getImageBase64,
  getImage,
  getAllImages,
  saveImageWithId,
  getImageDisplayUrl,
};
