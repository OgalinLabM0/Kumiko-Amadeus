import { useEffect, useState } from 'react';
import { isDesktopElectron } from '../../services/desktopBackupService';
import { db } from '../../services/db';

interface MessageLike {
  image?: string;
  imageId?: string;
}

// P2 #6 Phase 1: single-source-of-truth resolver for a Message's display image.
// Before this plan, every UI consumer (ChatBubble, MemoryPanel, AppMessageList,
// App.tsx resend) directly read `message.image` (the legacy inline base64 data
// URL). That blocked the migration of legacy inline images to the imageId
// + userData/images/{id}.{ext} scheme, because dropping the `image` field
// would instantly break every render site.
//
// This resolver understands both forms and returns one display URL:
//   - Desktop + imageId  -> kumiko-image://<id> (canonical, served by main
//                           process; content authoritative)
//   - Legacy inline image -> the inline data URL, returned as-is
//   - Web + imageId-only  -> async Dexie read (via useMessageImage hook)
//
// Desktop and inline cases resolve synchronously, so chat UI never flickers
// between "no image" and "image ready" on first paint.

export const resolveMessageImageSync = (
  message: MessageLike | null | undefined,
): string | null => {
  if (!message) return null;
  // Desktop: prefer imageId because kumiko-image:// loads the canonical file
  // from userData/images/ via a custom protocol; message.image is a redundant
  // data URL snapshot the renderer kept during send. On desktop both are
  // equivalent, but the protocol path is the authoritative source.
  if (message.imageId && isDesktopElectron()) {
    return `kumiko-image://${encodeURIComponent(message.imageId)}`;
  }
  // Web, or legacy-only, or imageId missing: fall back to inline data URL.
  if (message.image) return message.image;
  // Web + imageId-only (no inline): async Dexie read is required; return null
  // here and let useMessageImage hook resolve it in an effect.
  return null;
};

export const useMessageImage = (
  message: MessageLike | null | undefined,
): string | null => {
  const inlineImage = message?.image ?? null;
  const imageId = message?.imageId ?? null;
  const syncResolved = resolveMessageImageSync(message);
  const [asyncResolved, setAsyncResolved] = useState<string | null>(null);

  useEffect(() => {
    if (syncResolved !== null) {
      // Sync path already has a URL; clear any stale async state from a
      // previous message that needed Dexie resolution.
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
  }, [syncResolved, imageId, inlineImage]);

  return syncResolved ?? asyncResolved;
};
