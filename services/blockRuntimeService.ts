// services/blockRuntimeService.ts
//
// v2.14.29 Reactive — Block runtime lifecycle.
//
// Purpose: when the LLM emits a `[Block: minutes=N, reason="..."]`
// directive (and the audit service approved it), this service starts
// a runtime block for `N` minutes. While active:
//   - chatActions.executeSendCore intercepts every user message at
//     the top, calls `appendBlockUnread` and short-circuits (no LLM
//     call, bubble shows "未送达" subtitle but is marked read so the
//     timeline stays consistent);
//   - useBlockRegulator ticks 1Hz to detect expiry → fires the
//     `block_release` proactive message;
//   - On Android, KumikoAlarmsPlugin is asked to schedule an exact
//     alarm at `activeUntilMs` so the WebView can wake even after
//     process kill (mirrors useScheduledReminders).
//
// Persistence: store/slices/affectionSlice.persistBlockRuntime writes
// keyval `kumiko_block_runtime`. This file owns all runtime mutations
// so the slice setter is only used for hydration / direct UI updates.

import { useAppStore } from '../store';
import { isCapacitorNative, getCapacitorPlatform } from './environment';
import { scheduleAndroidAlarm, cancelAndroidAlarm } from './androidAlarmService';
import type { KumikoBlockRuntime } from '../types';

// Reserved alarm id for the block-expiry alarm. Distinct namespace
// from reminder ids (`reminder:<uuid>`) so a cancel can't collide.
const BLOCK_EXPIRY_ALARM_ID = 'kumiko_block_expiry';

// Hard ceiling on block duration. The audit service is supposed to
// have already capped this, but we double-clamp here so a malformed
// store row from a future build can't lock the user out.
const MIN_BLOCK_MINUTES = 1;
const MAX_BLOCK_MINUTES = 240;

export interface StartBlockInput {
  minutes: number;
  reason: string;
  triggerMessageId?: string;
}

const sanitizeMinutes = (m: number): number => {
  if (!Number.isFinite(m)) return MIN_BLOCK_MINUTES;
  return Math.max(MIN_BLOCK_MINUTES, Math.min(MAX_BLOCK_MINUTES, Math.round(m)));
};

const sanitizeReason = (r: string | undefined): string => {
  if (typeof r !== 'string') return '';
  return r.slice(0, 25);
};

const tryScheduleAndroidExpiryAlarm = async (
  runtime: KumikoBlockRuntime,
): Promise<void> => {
  if (!isCapacitorNative() || getCapacitorPlatform() !== 'android') return;
  try {
    // wantsCall=false → block expiry uses the standard messages channel
    // (LocalNotifications); the regulator will pick the JS-side alarm
    // event up in foreground, so the notification text is just a
    // failsafe for users with the app fully killed.
    await scheduleAndroidAlarm({
      reminderId: BLOCK_EXPIRY_ALARM_ID,
      at: runtime.activeUntilMs,
      event: 'block_release',
      text: 'Kumiko · 拉黑解除',
      wantsCall: false,
    });
  } catch (e) {
    console.warn('[BlockRuntime] Android expiry alarm schedule failed:', e);
  }
};

const tryCancelAndroidExpiryAlarm = async (): Promise<void> => {
  if (!isCapacitorNative() || getCapacitorPlatform() !== 'android') return;
  try {
    await cancelAndroidAlarm(BLOCK_EXPIRY_ALARM_ID);
  } catch (e) {
    console.warn('[BlockRuntime] Android expiry alarm cancel failed:', e);
  }
};

// Start a fresh block. If a block is already active, the new directive
// REPLACES the old (LLM-driven design choice — letting blocks stack
// across turns made the regulator math fragile). Reason is overwritten
// too, so the UI banner reflects the latest cause.
export const startBlock = async (
  input: StartBlockInput,
): Promise<KumikoBlockRuntime> => {
  const minutes = sanitizeMinutes(input.minutes);
  const reason = sanitizeReason(input.reason);
  const now = Date.now();
  const runtime: KumikoBlockRuntime = {
    activeUntilMs: now + minutes * 60_000,
    startedAt: now,
    reason,
    triggerMessageId: input.triggerMessageId,
    capturedUnreadIds: [],
    expiryAcked: false,
  };
  await useAppStore.getState().persistBlockRuntime(runtime);
  await tryScheduleAndroidExpiryAlarm(runtime);
  return runtime;
};

// Snapshot of the active block, or null if none / already expired.
// Note: this does NOT auto-clear an expired block — useBlockRegulator
// is responsible for the expiry path so the proactive message can
// fire from a single place. Callers that need a hard "is the user
// currently blocked" check should compare `activeUntilMs > Date.now()`.
export const getActiveBlock = (): KumikoBlockRuntime | null => {
  const runtime = useAppStore.getState().blockRuntime;
  if (!runtime) return null;
  if (runtime.activeUntilMs <= Date.now()) return null;
  return runtime;
};

// True if a block exists in store AND has not yet expired.
export const isBlockActive = (now: number = Date.now()): boolean => {
  const runtime = useAppStore.getState().blockRuntime;
  return runtime !== null && runtime.activeUntilMs > now;
};

// Append a user-message id to `capturedUnreadIds`. Idempotent — calling
// twice with the same id is a no-op so the chatActions intercept can
// re-run without doubling the queue.
export const appendBlockUnread = async (userMsgId: string): Promise<void> => {
  const runtime = useAppStore.getState().blockRuntime;
  if (!runtime) return;
  if (runtime.capturedUnreadIds.includes(userMsgId)) return;
  const next: KumikoBlockRuntime = {
    ...runtime,
    capturedUnreadIds: [...runtime.capturedUnreadIds, userMsgId],
  };
  await useAppStore.getState().persistBlockRuntime(next);
};

// Mark expiry as acked — used by chatActions when the `block_release`
// proactive message lands successfully. Distinct from `clearBlock` so
// the regulator can post-fire UI cleanup separately.
export const markBlockExpiryAcked = async (): Promise<void> => {
  const runtime = useAppStore.getState().blockRuntime;
  if (!runtime || runtime.expiryAcked) return;
  const next: KumikoBlockRuntime = { ...runtime, expiryAcked: true };
  await useAppStore.getState().persistBlockRuntime(next);
};

// Fully clear the block — wipes keyval, store and the Android alarm.
// Called after `block_release` has been delivered AND the user has seen
// it (we treat the proactive message landing as the de-facto seal).
//
// Side effect: flips every captured-during-block user message from
// "未送达" / "Not delivered" to the normal read state. By the time we
// reach here, the `block_release` proactive prompt has already been
// shown the captured lines as `blockReleaseContext`, so it's correct to
// say they were ultimately seen. Without this flip those bubbles would
// stay stuck on "未送达" forever, which contradicts the proactive line.
export const clearBlock = async (): Promise<void> => {
  const runtime = useAppStore.getState().blockRuntime;
  const capturedIds = runtime?.capturedUnreadIds ?? [];
  if (capturedIds.length > 0) {
    const idSet = new Set(capturedIds);
    useAppStore.getState().setMessages(prev => prev.map(m =>
      idSet.has(m.id)
        ? { ...m, blockedDuringSend: false, isRead: true }
        : m,
    ));
  }
  await useAppStore.getState().persistBlockRuntime(null);
  await tryCancelAndroidExpiryAlarm();
};

// Boot-time helper: returns 'fire_expiry' if the block already lapsed
// during downtime (caller should immediately fire the proactive),
// 'still_active' if it's still in the future (caller should reschedule
// a setTimeout + Android alarm), or 'none' if there's no block at all.
export type BlockBootDecision = 'fire_expiry' | 'still_active' | 'none';

export const expireBlockIfDue = (now: number = Date.now()): BlockBootDecision => {
  const runtime = useAppStore.getState().blockRuntime;
  if (!runtime) return 'none';
  if (runtime.activeUntilMs <= now) return 'fire_expiry';
  return 'still_active';
};

export { BLOCK_EXPIRY_ALARM_ID };
