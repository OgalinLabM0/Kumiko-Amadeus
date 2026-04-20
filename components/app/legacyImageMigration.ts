import { db } from '../../services/db';
import { imageService } from '../../services/imageService';
import { yieldToMainThread } from './appUtils';

// P2 #6 Phase 1: one-shot migration of legacy MessageEntity.image (inline
// base64 data URL) to the imageId + userData/images/{id}.{ext} scheme.
//
// This runs in App.tsx:loadData BEFORE setIsDataLoaded(true), so the UI only
// ever sees messages after migration has had a chance to complete. Running it
// inside a Dexie `.upgrade()` was ruled out: saveImageWithId needs IPC to the
// main process (for images:save), and calling that from inside a Dexie
// upgrade transaction risks deadlocks / long-held schema locks.
//
// Idempotent by design: the pending filter is `image && !imageId`, and a
// successful row gets `imageId` set + `image` cleared. The next boot naturally
// skips already-migrated rows. Partial progress (app killed mid-migration)
// continues on next boot.

export interface LegacyImageMigrationResult {
  pending: number;
  migrated: number;
  skipped: number;
}

/**
 * Optional progress callback. Called on start (migrated=0), periodically
 * during the loop, and on completion. Only invoked when there was at least
 * one pending row, so quiet installs stay quiet.
 */
export type LegacyImageMigrationProgress = (info: {
  migrated: number;
  pending: number;
}) => void;

const YIELD_EVERY = 10;

export async function migrateLegacyMessageImages(
  onProgress?: LegacyImageMigrationProgress,
): Promise<LegacyImageMigrationResult> {
  const pendingMessages = await db.messages
    .filter(m => !!m.image && !m.imageId)
    .toArray();

  const pending = pendingMessages.length;
  if (pending === 0) {
    return { pending: 0, migrated: 0, skipped: 0 };
  }

  console.log(`[LegacyImageMigration] Starting migration of ${pending} legacy inline images.`);
  onProgress?.({ migrated: 0, pending });

  let migrated = 0;
  let skipped = 0;
  let idx = 0;

  for (const msg of pendingMessages) {
    try {
      // Stable id so reruns hit the same target file (idempotent).
      const newId = `img_legacy_${msg.id}`;
      await imageService.saveImageWithId(newId, msg.image!);
      await db.messages.update(msg.id, {
        imageId: newId,
        image: undefined,
      });
      migrated += 1;
    } catch (err) {
      console.warn('[LegacyImageMigration] Skipped message', msg.id, err);
      skipped += 1;
    }

    idx += 1;
    if (idx % YIELD_EVERY === 0) {
      await yieldToMainThread(1);
      onProgress?.({ migrated, pending });
    }
  }

  onProgress?.({ migrated, pending });
  console.log(
    `[LegacyImageMigration] Done. migrated=${migrated}, skipped=${skipped}, pending=${pending}.`,
  );
  return { pending, migrated, skipped };
}
