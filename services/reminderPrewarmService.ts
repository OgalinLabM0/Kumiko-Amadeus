// v2.14.28 H17.A — reminder prewarm service.
//
// PROBLEM
// On the desktop, scheduled reminders only start their LLM + TTS
// generation at T=0 (the trigger moment). LLM generation alone is
// 3-9 s on most providers, and full-voice TTS adds another 1-3 s on
// top. Net effect: a "9:00 AM medicine" reminder routinely fires at
// 9:00:08 with the call screen / system notification visibly late.
// Worst case (network blip + heavy provider): the user has already
// moved on by the time the bubble arrives.
//
// SOLUTION
// When the app is backgrounded / minimized / locked AND a scheduled
// reminder is due within the next 60 s, run the full pipeline (LLM +
// TTS if voice mode allows) up-front and cache the result. At T=0
// the dispatcher reads from cache and just plays / posts the
// already-prepared payload — no model round-trip, no TTS wait.
//
// SCOPE
// Desktop only for now. Android H17.A schedules a separate alarm
// at T-60s and routes through the same cache (see Patch 4.2). Web
// preview / dev mode follows the desktop path.
//
// CACHE LIFECYCLE
//   - prewarm starts → entry status = 'pending'
//   - LLM done       → entry holds response (textParts + emotion)
//   - TTS done       → entry holds voiceResult
//   - dispatcher     → reads entry, marks 'consumed', removes
//   - 60s after dueAt without consumption → expired (caller drops)
//   - cancellation (reminder removed, abort signal) → status='cancelled'
//
// All state lives in-process. A renderer reload throws the cache
// away, which is fine — at boot the polling loop resumes its 1 s
// tick and the existing T=0 just-in-time fallback handles whatever
// is in the next minute.

import type { ChatResponse } from '../types';

export type ReminderPrewarmStatus =
  | 'pending'
  | 'llm-ready'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'consumed';

export interface ReminderPrewarmVoicePayload {
  voiceFileId: string;
  voiceDuration?: number;
  japaneseText?: string;
}

export interface ReminderPrewarmEntry {
  reminderId: string;
  reminderEvent: string;
  dueAt: number;
  status: ReminderPrewarmStatus;
  response?: ChatResponse;
  voice?: ReminderPrewarmVoicePayload;
  startedAt: number;
  llmDoneAt?: number;
  ttsDoneAt?: number;
  abort: AbortController;
  /** Last error if status === 'failed'. Kept for diagnostics. */
  failureReason?: string;
}

const cache: Map<string, ReminderPrewarmEntry> = new Map();
const PREWARM_LEAD_MS = 60_000;
const PREWARM_KICK_WINDOW_MS = 10_000; // T-60s ~ T-50s detection window in poller
const PREWARM_RESULT_GRACE_MS = 90_000; // entry stays valid up to 90 s after dueAt

/** Returns true when `now` is inside the T-60s..T-50s detection window. */
export function shouldKickReminderPrewarm(dueAt: number, now: number): boolean {
  const lead = dueAt - now;
  return lead <= PREWARM_LEAD_MS && lead > PREWARM_LEAD_MS - PREWARM_KICK_WINDOW_MS;
}

/** Returns the cache entry for a reminder, if any (regardless of status). */
export function readReminderPrewarm(reminderId: string): ReminderPrewarmEntry | undefined {
  return cache.get(reminderId);
}

/** Returns a usable cache entry only if it's `'ready'` or `'llm-ready'` and not expired. */
export function consumeReminderPrewarm(reminderId: string, now = Date.now()): ReminderPrewarmEntry | null {
  const entry = cache.get(reminderId);
  if (!entry) return null;
  if (entry.status !== 'ready' && entry.status !== 'llm-ready') return null;
  if (now > entry.dueAt + PREWARM_RESULT_GRACE_MS) {
    cache.delete(reminderId);
    return null;
  }
  entry.status = 'consumed';
  cache.delete(reminderId);
  return entry;
}

/**
 * Cancels and drops a prewarm entry. Called when the user removes the
 * reminder, when the reminder fires (after consumption), or when an
 * abort signal trips the underlying TTS pipeline.
 */
export function cancelReminderPrewarm(reminderId: string, reason?: string): void {
  const entry = cache.get(reminderId);
  if (!entry) return;
  entry.status = 'cancelled';
  if (reason) entry.failureReason = reason;
  try { entry.abort.abort(reason); } catch { /* noop */ }
  cache.delete(reminderId);
}

/**
 * Registers a brand-new prewarm entry. Returns the entry so the caller
 * can write `response` / `voice` to it as the pipeline progresses. If a
 * prewarm is already in flight or finished for this reminder, returns
 * the existing entry without resetting it.
 */
export function startReminderPrewarm(
  reminderId: string,
  reminderEvent: string,
  dueAt: number,
): ReminderPrewarmEntry {
  const existing = cache.get(reminderId);
  if (existing && existing.status !== 'failed' && existing.status !== 'cancelled') {
    return existing;
  }
  const entry: ReminderPrewarmEntry = {
    reminderId,
    reminderEvent,
    dueAt,
    status: 'pending',
    startedAt: Date.now(),
    abort: new AbortController(),
  };
  cache.set(reminderId, entry);
  return entry;
}

/** Test-only / boundary helper: drop every entry. */
export function clearAllReminderPrewarm(): void {
  for (const entry of cache.values()) {
    try { entry.abort.abort('cache-cleared'); } catch { /* noop */ }
  }
  cache.clear();
}

export const __PREWARM_CONSTANTS__ = {
  PREWARM_LEAD_MS,
  PREWARM_KICK_WINDOW_MS,
  PREWARM_RESULT_GRACE_MS,
};
