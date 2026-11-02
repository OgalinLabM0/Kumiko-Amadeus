import { db } from './db';
import { mapMessageToEntity } from '../components/app/messageMappers';
import type { Message } from '../types';

/** Persist an unguarded reminder's voice reference before its lease is released. */
export async function commitStandaloneReminderVoice(message: Message, assertCurrent: () => Promise<void>): Promise<void> {
  await db.transaction('rw', [db.messages, db.keyval, db.memoryCorrections, db.kumikoDiary, db.dailyFragments], async () => {
    await assertCurrent();
    await db.messages.add(mapMessageToEntity(message));
    await assertCurrent();
  });
}
