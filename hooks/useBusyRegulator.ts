import { useEffect, useRef } from 'react';
import { useAppStore } from '../store';
import { getAmbientEnvironmentContext } from '../components/app/ambientContext';
import {
  getDetailedScheduleSlot,
  getBusyEndTimestamp,
} from '../services/kumikoStateMachine';
import {
  prepareBusyFollowUpResponse,
  displayPreparedProactiveMessage,
} from '../components/app/chatActions';

// Tuning constants. The exact numbers here satisfy the requirements from
// the plan: prepare 2 minutes before slot end, display 25-40s after
// slot end, typing animation scales with text length (handled inside
// `displayPreparedProactiveMessage`), 6 h overdue bucket for safety,
// 4 retries with exponential backoff capped at 10 minutes.
const POLL_INTERVAL_MS = 1000;
const PREPARE_LEAD_MS = 2 * 60 * 1000;
const DISPLAY_DELAY_MIN_MS = 25 * 1000;
const DISPLAY_DELAY_JITTER_MS = 15 * 1000;
const OVERDUE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_PREPARE_RETRIES = 4;
const BACKOFF_BASE_MS = 30 * 1000;
const BACKOFF_MAX_MS = 10 * 60 * 1000;

// `useBusyRegulator` runs on a 1 s polling loop and is the single owner
// of the following state transitions:
//
//   busySlotRuntime  --(slot ended)-->  busyFollowUp
//   busyFollowUp     --(prepareAt reached)--> preparedTextParts populated
//   busyFollowUp     --(displayAt reached)--> message shipped, cleared
//   busyFollowUp     --(4 consecutive API failures)--> pendingApology
//   busyFollowUp     --(6 h after displayAt, never delivered)--> pendingApology
//
// User-interrupt preemption (user starts chatting BEFORE displayAt) is
// handled in `chatActions.ts` A-3 top check, not here, because the
// detection and the conversion need to happen inside the same
// user-message pipeline turn.
export function useBusyRegulator(enabled: boolean): void {
  const busyRuntime = useAppStore(s => s.busySlotRuntime);
  const busyFollowUp = useAppStore(s => s.busyFollowUp);
  const locationConfig = useAppStore(s => s.locationConfig);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const now = Date.now();
        // Holiday / schedule detection is async, but we cache the last
        // result across ticks to avoid thrashing the ambient context
        // every second.
        const ambient = await getCachedAmbient();
        const isHoliday = ambient.includes('今日特殊历法：日本法定节假日');
        const slot = getDetailedScheduleSlot(locationConfig.modelTimezone, isHoliday);

        const storeState = useAppStore.getState();

        // ---------- 1. Slot boundary archive ----------
        const runtime = storeState.busySlotRuntime;
        if (runtime && runtime.slotKey !== slot.slotKey) {
          const hasUnread = runtime.unreadUserMessageIds.length > 0;
          const shouldArchive = hasUnread || runtime.mode === 'block';
          if (shouldArchive) {
            const endMs = runtime.endAtMs ?? now;
            const prepareAt = Math.max(endMs - PREPARE_LEAD_MS, now);
            const jitter = Math.floor(Math.random() * DISPLAY_DELAY_JITTER_MS);
            const displayAt = Math.max(endMs, now) + DISPLAY_DELAY_MIN_MS + jitter;
            await storeState.archiveBusySlotToFollowUp({ prepareAt, displayAt });
          } else {
            await storeState.clearBusySlot();
          }
        }

        // ---------- 2. Early-archive (still in slot, <2 min to end) ----------
        // This lets the prepare stage fire before the slot actually
        // ends, so that when the user's class finishes the reply is
        // ready to drop within 25-40 s.
        const runtime2 = useAppStore.getState().busySlotRuntime;
        const followUpNow = useAppStore.getState().busyFollowUp;
        if (
          runtime2 &&
          !followUpNow &&
          typeof runtime2.endAtMs === 'number' &&
          now >= runtime2.endAtMs - PREPARE_LEAD_MS &&
          now < runtime2.endAtMs
        ) {
          const hasUnread2 = runtime2.unreadUserMessageIds.length > 0;
          const shouldArchive2 = hasUnread2 || runtime2.mode === 'block';
          if (shouldArchive2) {
            const prepareAt = now;
            const jitter = Math.floor(Math.random() * DISPLAY_DELAY_JITTER_MS);
            const displayAt = runtime2.endAtMs + DISPLAY_DELAY_MIN_MS + jitter;
            await useAppStore.getState().archiveBusySlotToFollowUp({ prepareAt, displayAt });
          }
        }

        // ---------- 3. Prepare stage (silent API call) ----------
        const followUp = useAppStore.getState().busyFollowUp;
        if (
          followUp &&
          !followUp.preparedAt &&
          now >= followUp.prepareAt &&
          (!followUp.nextRetryAt || now >= followUp.nextRetryAt)
        ) {
          const result = await prepareBusyFollowUpResponse(followUp);
          if (result) {
            await useAppStore.getState().patchBusyFollowUp({
              preparedTextParts: result.textParts,
              preparedEmotion: result.emotion,
              preparedAt: Date.now(),
              failureCount: 0,
              nextRetryAt: undefined,
            });
          } else {
            const nextCount = followUp.failureCount + 1;
            if (nextCount >= MAX_PREPARE_RETRIES) {
              await useAppStore.getState().appendFollowUpToApology('api_failure');
            } else {
              const backoff = Math.min(BACKOFF_BASE_MS * Math.pow(2, nextCount - 1), BACKOFF_MAX_MS);
              await useAppStore.getState().patchBusyFollowUp({
                failureCount: nextCount,
                nextRetryAt: Date.now() + backoff,
              });
            }
          }
        }

        // ---------- 4. Display stage ----------
        const followUpForDisplay = useAppStore.getState().busyFollowUp;
        if (
          followUpForDisplay &&
          followUpForDisplay.preparedTextParts &&
          followUpForDisplay.preparedTextParts.length > 0 &&
          now >= followUpForDisplay.displayAt
        ) {
          // Guard: if another chat turn is already in flight we skip
          // this tick and retry on the next.
          const latest = useAppStore.getState();
          if (!latest.isTalking && !latest.isThinking) {
            const ok = await displayPreparedProactiveMessage(followUpForDisplay);
            if (ok) await useAppStore.getState().clearBusyFollowUp();
          }
        }

        // ---------- 5. Overdue timeout escalation ----------
        const followUpForTimeout = useAppStore.getState().busyFollowUp;
        if (followUpForTimeout && now >= followUpForTimeout.displayAt + OVERDUE_TIMEOUT_MS) {
          await useAppStore.getState().appendFollowUpToApology('timeout');
        }
      } catch (e) {
        console.warn('[BUSY-REGULATOR] tick failed', e);
      } finally {
        inFlightRef.current = false;
      }
    };

    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // `busyRuntime` / `busyFollowUp` dependency ensures the poller picks
    // up external state transitions (e.g. persisted rehydration on
    // startup) without waiting a full tick.
  }, [enabled, locationConfig.modelTimezone, busyRuntime?.slotKey, busyFollowUp?.id]);
}

// Ambient context lookup is cached across ticks to keep this hook's
// overhead minimal; the ambient string only really changes day-to-day.
let ambientCache: { text: string; at: number } | null = null;
const AMBIENT_TTL_MS = 5 * 60 * 1000;
async function getCachedAmbient(): Promise<string> {
  const now = Date.now();
  if (ambientCache && now - ambientCache.at < AMBIENT_TTL_MS) return ambientCache.text;
  try {
    const text = await getAmbientEnvironmentContext();
    ambientCache = { text, at: now };
    return text;
  } catch {
    return ambientCache?.text ?? '';
  }
}

// Helper the rest of the app can import to flush an overdue followUp
// into `pendingApology` synchronously (e.g. when user sends a new
// message before displayAt — see chatActions.ts A-3 top check).
export async function convertBusyFollowUpToApologyForPreemption(): Promise<boolean> {
  const store = useAppStore.getState();
  const followUp = store.busyFollowUp;
  if (!followUp) return false;
  const reason: 'user_interrupted' | 'user_interrupted_no_prep' =
    followUp.preparedTextParts && followUp.preparedTextParts.length > 0
      ? 'user_interrupted'
      : 'user_interrupted_no_prep';
  await store.appendFollowUpToApology(reason);
  return true;
}

// Also exposed so components that touch the busy state can remove
// stale buckets without importing the slice directly (e.g. TaskPanel
// "dismiss" button, admin clear-all, etc.). Kept out of the auto
// lifecycle so accidental clears don't silently lose unread topics.
export { getBusyEndTimestamp };
