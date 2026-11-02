import { db } from './db';
import { assertMemoryAvailable } from './memoryMaintenanceGate';
/** Local visibility is independent of the recipient's received evidence. */
export async function hideMessagesLocally(ids: string[]): Promise<void> {
  assertMemoryAvailable();
  const unique = [...new Set(ids)].filter(id => typeof id === 'string' && id.length > 0);
  if (!unique.length) return;
  await db.transaction('rw', db.messages, db.messageViews, async () => {
    const now = Date.now();
    for (const id of unique) if (await db.messages.get(id)) await db.messageViews.put({ id, locallyDeletedAt: now, updatedAt: now });
    assertMemoryAvailable();
  });
}
export async function restoreLocalMessageView(id: string): Promise<void> { assertMemoryAvailable(); await db.messageViews.delete(id); }
