import { useEffect, useState } from 'react';
import { isDesktopElectron } from '../../services/desktopBackupService';
import { db } from '../../services/db';

interface MessageLike {
  imageId?: string;
}

// Single-source-of-truth resolver for a Message's display image. Returns
// one display URL depending on the runtime:
//   - Desktop + imageId -> kumiko-image://<id> (custom protocol served by
//     main process, reads userData/images/{id}.{ext}; authoritative)
//   - Web + imageId     -> async Dexie read (via useMessageImage hook,
//     resolves to ImageEntity.base64Data)
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
    (async () => {
      try {
        const row = await db.images.get(imageId);
        if (!cancelled) setAsyncResolved(row?.base64Data || null);
      } catch (err) {
        console.warn('[useMessageImage] Failed to resolve imageId:', imageId, err);
        if (!cancelled) setAsyncResolved(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [syncResolved, imageId]);

  return syncResolved ?? asyncResolved;
};
