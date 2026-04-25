import { useEffect, useState } from 'react';
import { isDesktopElectron } from '../../services/desktopBackupService';
import { isCapacitorNative } from '../../services/environment';
import { db } from '../../services/db';
import { capacitorImageRead } from '../../services/imageFileService';

interface MessageLike {
  imageId?: string;
}

// Single-source-of-truth resolver for a Message's display image. Returns
// one display URL depending on the runtime:
//   - Desktop + imageId -> kumiko-image://<id> (custom protocol served by
//     main process, reads userData/images/{id}.{ext}; authoritative)
//   - Capacitor + imageId (v2.14.4 F.4) -> blob: URL built from
//     capacitorImageRead(relativePath); revoked on cleanup so Chromium
//     doesn't leak ArrayBuffers per chat scroll.
//   - Web + imageId -> async Dexie read (resolves to base64Data data URL).
//
// The desktop path resolves synchronously so chat UI never flickers between
// "no image" and "image ready" on first paint.
//
// The legacy inline `message.image` (base64 data URL) path that this hook
// used to support was retired in Plan 14 Phase A (P2 #6 Phase 2). Any
// remaining legacy backup JSON that still ships inline `image` is hydrated
// to `imageId` at import time by backupActions, so runtime code only ever
// sees the imageId shape.

export const resolveMessageImageSync = (
  message: MessageLike | null | undefined,
): string | null => {
  if (!message) return null;
  if (message.imageId && isDesktopElectron()) {
    return `kumiko-image://${encodeURIComponent(message.imageId)}`;
  }
  return null;
};

function base64ToBlob(rawBase64: string, mimeType: string): Blob {
  const binary = atob(rawBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || 'image/jpeg' });
}

export const useMessageImage = (
  message: MessageLike | null | undefined,
): string | null => {
  const imageId = message?.imageId ?? null;
  const syncResolved = resolveMessageImageSync(message);
  const [asyncResolved, setAsyncResolved] = useState<string | null>(null);

  useEffect(() => {
    if (syncResolved !== null) {
      setAsyncResolved(null);
      return;
    }
    if (!imageId) {
      setAsyncResolved(null);
      return;
    }

    let cancelled = false;
    let createdObjectUrl: string | null = null;
    const isNativeCapacitor = isCapacitorNative();

    (async () => {
      try {
        const row = await db.images.get(imageId);
        if (cancelled) return;
        if (!row) {
          setAsyncResolved(null);
          return;
        }
        // v2.14.4 F.4: Capacitor branch — read the bytes off
        // Filesystem and wrap in a blob: URL. We deliberately do NOT
        // turn this into a `data:${mimeType};base64,${...}` data URL
        // because data: URLs hold their full payload in memory for the
        // entire lifetime of every <img> referencing them — a chat
        // with hundreds of historical images would balloon RAM and
        // never release. Blob URLs let Chromium GC the underlying
        // bytes once we revoke them on unmount / re-target.
        if (isNativeCapacitor && row.relativePath) {
          const rawB64 = await capacitorImageRead(row.relativePath);
          if (cancelled) return;
          if (rawB64) {
            const blob = base64ToBlob(rawB64, row.mimeType || 'image/jpeg');
            createdObjectUrl = URL.createObjectURL(blob);
            setAsyncResolved(createdObjectUrl);
            return;
          }
          // File missing — fall through to whatever's in base64Data
          // (probably empty for v2.14.4 rows; old rows could still
          // have inline bytes).
        }
        setAsyncResolved(row.base64Data || null);
      } catch (err) {
        console.warn('[useMessageImage] Failed to resolve imageId:', imageId, err);
        if (!cancelled) setAsyncResolved(null);
      }
    })();

    return () => {
      cancelled = true;
      if (createdObjectUrl) {
        URL.revokeObjectURL(createdObjectUrl);
      }
    };
  }, [syncResolved, imageId]);

  return syncResolved ?? asyncResolved;
};
