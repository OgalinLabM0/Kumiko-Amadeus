import type { StateCreator } from 'zustand';
import { db } from '../../services/db';
import type { EmotionType } from '../../types';
import type { ScheduleSlotType } from '../../services/kumikoStateMachine';

// Dexie keyval keys. Surfaced for useInitialLoadBootstrap to pre-hydrate.
export const BUSY_SLOT_RUNTIME_STORAGE_KEY = 'kumiko_busy_slot_runtime';
export const BUSY_FOLLOWUP_STORAGE_KEY = 'kumiko_busy_followup';
export const PENDING_APOLOGY_STORAGE_KEY = 'kumiko_pending_apology';

// ---------------------------------------------------------------------------
// 1. Runtime state of the *currently active* busy slot.
//
// A single busy slot (`teaching:p3`, `shr:morning`, `after_school`, ...) is
// represented by one `BusySlotRuntime` while the user is still inside it.
// The slot's dice decision (`mode = 'allow' | 'block'`) is made on the FIRST
// user message and persisted for the duration of the slot. When the slot
// boundary passes, `useBusyRegulator` archives the runtime into a
// `BusyFollowUp` (if any user messages were blocked) or simply discards it.
// ---------------------------------------------------------------------------
export interface BusySlotRuntime {
  slotKey: string;                         // e.g. "2026-04-15:teaching:p3"
  slotType: ScheduleSlotType;
  slotDescription: string;                 // Human-readable snapshot for later prompts.
  enteredAtMs: number;                     // When we first saw this slot in chatActions.
  endAtMs: number | null;                  // Absolute JST-resolved end timestamp.
  mode: 'allow' | 'block';                 // Dice outcome or round-limit upgrade.
  reason?: 'dice' | 'round_limit';
  kumikoRepliedRounds: number;             // Only meaningful for allow+teaching.
  unreadUserMessageIds: string[];          // Accumulated while mode=block.
  shortReplyIssued: boolean;               // First block reply already sent?
  shortReplyText?: string;                 // The actual short reply (for later ctx).
}

// ---------------------------------------------------------------------------
// 2. FollowUp: a "proactive message Kumiko owes the user" task.
//
// Produced at slot boundary from `BusySlotRuntime`. Lives through two phases:
//   - prepare: 2 minutes before slot end, silently generate reply text.
//   - display: 25–40 s after slot end, simulate typing & send.
// If preparation keeps failing (4 retries) or displayAt never fires within
// 6 h, the followUp is "appended" to `PendingApology` so the next user-
// initiated turn can compensate.
// ---------------------------------------------------------------------------
export interface BusyFollowUp {
  id: string;
  createdAt: number;
  slotKey: string;
  slotType: ScheduleSlotType;
  slotDescription: string;
  slotEndAtMs: number | null;
  prepareAt: number;                       // Absolute ms — when prepare should fire.
  displayAt: number;                       // Absolute ms — when UI should start typing.
  unreadUserMessageIds: string[];
  shortReplyText?: string;
  reason?: 'dice' | 'round_limit';
  preparedTextParts?: string[];            // Set after successful prepare.
  preparedEmotion?: EmotionType;
  preparedAt?: number;
  failureCount: number;                    // Prepare attempts that errored.
  nextRetryAt?: number;                    // Exponential backoff waypoint.
}

// ---------------------------------------------------------------------------
// 3. PendingApology: "unanswered-message ledger" that Kumiko will confess to
// on the next user-initiated turn.
//
// Unlike `BusyFollowUp`, a pending apology can *accumulate* multiple sources
// over time — the user's explicit requirement is that Kumiko must NOT forget
// unread messages, even if they span several busy periods. Each entry in
// `sources` represents one FollowUp that degraded (timeout / API failure /
// user interruption). When the user finally sends a new turn, chatActions
// injects a system prompt that asks Kumiko to apologize ONCE, reply to the
// new message, and pick 2–3 of the freshest/most-relevant old topics to
// bring up naturally. After that single compensation turn the entire
// PendingApology (all sources) is cleared.
// ---------------------------------------------------------------------------
export interface PendingApologySource {
  slotKey: string;
  slotType: ScheduleSlotType;
  slotDescription: string;
  unreadUserMessageIds: string[];
  shortReplyText?: string;
  // If the user pre-empted the followUp before displayAt AND prepare had
  // succeeded, we preserve the already-written draft so the compensation
  // prompt can reuse the tone Kumiko had planned.
  preparedTextParts?: string[];
  reason: 'timeout' | 'api_failure' | 'user_interrupted' | 'user_interrupted_no_prep';
  convertedAt: number;
}

export interface PendingApology {
  id: string;
  createdAt: number;                       // When the first source was appended.
  latestAppendedAt: number;                // When the most recent source was appended.
  sources: PendingApologySource[];         // Append-only until compensation fires.
}

// ---------------------------------------------------------------------------
// 4. Slice shape
// ---------------------------------------------------------------------------

/**
 * Decision returned by `ensureBusySlot` on every user message arriving during
 * a busy slot. Interpreted by chatActions.ts A-3:
 *   - 'allow'         : no interception; let the normal AI pipeline run.
 *   - 'block_first'   : send the short canned reply & mark the user message
 *                        as unread-in-slot.
 *   - 'block_silent'  : mark unread only; do not send anything.
 */
export type BusySlotDecision = 'allow' | 'block_first' | 'block_silent';

export interface BusySlotContext {
  slotKey: string;
  slotType: ScheduleSlotType;
  slotDescription: string;
  endAtMs: number | null;
}

export interface BusySlice {
  busySlotRuntime: BusySlotRuntime | null;
  busyFollowUp: BusyFollowUp | null;
  pendingApology: PendingApology | null;

  // Raw setters — primarily used by bootstrap hydration.
  setBusySlotRuntime: (v: BusySlotRuntime | null) => void;
  setBusyFollowUp: (v: BusyFollowUp | null) => void;
  setPendingApology: (v: PendingApology | null) => void;

  // Persisting setters — mirrors reminderSlice's pattern.
  persistBusySlotRuntime: (v: BusySlotRuntime | null) => Promise<void>;
  persistBusyFollowUp: (v: BusyFollowUp | null) => Promise<void>;
  persistPendingApology: (v: PendingApology | null) => Promise<void>;

  // Slot runtime lifecycle — called from chatActions A-3.
  ensureBusySlot: (ctx: BusySlotContext, baseProbability: number, now: number) => BusySlotDecision;
  incrementBusySlotRound: (slotKey: string) => Promise<void>;
  appendBusyUnread: (
    slotKey: string,
    userMsgId: string,
    opts?: { shortReplyText?: string; markShortReplyIssued?: boolean },
  ) => Promise<void>;
  clearBusySlot: () => Promise<void>;
  archiveBusySlotToFollowUp: (opts: { prepareAt: number; displayAt: number }) => Promise<void>;

  // FollowUp lifecycle — called from useBusyRegulator.
  patchBusyFollowUp: (partial: Partial<BusyFollowUp>) => Promise<void>;
  clearBusyFollowUp: () => Promise<void>;

  // Apology lifecycle. `appendFollowUpToApology` migrates the current
  // followUp into the pending-apology ledger (preserving *all* prior
  // sources), then clears the followUp. `clearPendingApology` is called
  // by chatActions after the compensation turn succeeds.
  appendFollowUpToApology: (reason: PendingApologySource['reason']) => Promise<void>;
  clearPendingApology: () => Promise<void>;
}

export const createBusySlice: StateCreator<BusySlice, [], [], BusySlice> = (set, get) => ({
  busySlotRuntime: null,
  busyFollowUp: null,
  pendingApology: null,

  setBusySlotRuntime: (v) => set({ busySlotRuntime: v }),
  setBusyFollowUp: (v) => set({ busyFollowUp: v }),
  setPendingApology: (v) => set({ pendingApology: v }),

  persistBusySlotRuntime: async (v) => {
    set({ busySlotRuntime: v });
    if (v === null) await db.keyval.delete(BUSY_SLOT_RUNTIME_STORAGE_KEY);
    else await db.setVal(BUSY_SLOT_RUNTIME_STORAGE_KEY, v);
  },

  persistBusyFollowUp: async (v) => {
    set({ busyFollowUp: v });
    if (v === null) await db.keyval.delete(BUSY_FOLLOWUP_STORAGE_KEY);
    else await db.setVal(BUSY_FOLLOWUP_STORAGE_KEY, v);
  },

  persistPendingApology: async (v) => {
    set({ pendingApology: v });
    if (v === null) await db.keyval.delete(PENDING_APOLOGY_STORAGE_KEY);
    else await db.setVal(PENDING_APOLOGY_STORAGE_KEY, v);
  },

  ensureBusySlot: (ctx, baseProbability, now) => {
    const existing = get().busySlotRuntime;

    // Same slot as the one we already rolled for → reuse prior decision.
    if (existing && existing.slotKey === ctx.slotKey) {
      if (existing.mode === 'block') {
        return existing.shortReplyIssued ? 'block_silent' : 'block_first';
      }

      // allow mode: teaching has a round-limit ceiling (2 successful replies).
      // The 3rd user message upgrades the slot to `block`.
      if (existing.slotType === 'teaching' && existing.kumikoRepliedRounds >= 2) {
        const next: BusySlotRuntime = {
          ...existing,
          mode: 'block',
          reason: 'round_limit',
          shortReplyIssued: false,
        };
        set({ busySlotRuntime: next });
        void db.setVal(BUSY_SLOT_RUNTIME_STORAGE_KEY, next);
        return 'block_first';
      }

      return 'allow';
    }

    // New slot (or very first slot). Dice-roll once and persist the outcome.
    const dice = Math.random();
    const willBlock = dice < baseProbability;
    const mode: 'allow' | 'block' = willBlock ? 'block' : 'allow';
    const runtime: BusySlotRuntime = {
      slotKey: ctx.slotKey,
      slotType: ctx.slotType,
      slotDescription: ctx.slotDescription,
      enteredAtMs: now,
      endAtMs: ctx.endAtMs,
      mode,
      reason: willBlock ? 'dice' : undefined,
      kumikoRepliedRounds: 0,
      unreadUserMessageIds: [],
      shortReplyIssued: false,
    };
    set({ busySlotRuntime: runtime });
    void db.setVal(BUSY_SLOT_RUNTIME_STORAGE_KEY, runtime);
    return mode === 'block' ? 'block_first' : 'allow';
  },

  incrementBusySlotRound: async (slotKey) => {
    const existing = get().busySlotRuntime;
    if (!existing || existing.slotKey !== slotKey) return;
    const next: BusySlotRuntime = {
      ...existing,
      kumikoRepliedRounds: existing.kumikoRepliedRounds + 1,
    };
    set({ busySlotRuntime: next });
    await db.setVal(BUSY_SLOT_RUNTIME_STORAGE_KEY, next);
  },

  appendBusyUnread: async (slotKey, userMsgId, opts) => {
    const existing = get().busySlotRuntime;
    if (!existing || existing.slotKey !== slotKey) return;
    const alreadyTracked = existing.unreadUserMessageIds.includes(userMsgId);
    const next: BusySlotRuntime = {
      ...existing,
      unreadUserMessageIds: alreadyTracked
        ? existing.unreadUserMessageIds
        : [...existing.unreadUserMessageIds, userMsgId],
      shortReplyIssued: opts?.markShortReplyIssued ? true : existing.shortReplyIssued,
      shortReplyText: opts?.shortReplyText ?? existing.shortReplyText,
    };
    set({ busySlotRuntime: next });
    await db.setVal(BUSY_SLOT_RUNTIME_STORAGE_KEY, next);
  },

  clearBusySlot: async () => {
    set({ busySlotRuntime: null });
    await db.keyval.delete(BUSY_SLOT_RUNTIME_STORAGE_KEY);
  },

  archiveBusySlotToFollowUp: async ({ prepareAt, displayAt }) => {
    const runtime = get().busySlotRuntime;
    if (!runtime) return;
    const followUp: BusyFollowUp = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      slotKey: runtime.slotKey,
      slotType: runtime.slotType,
      slotDescription: runtime.slotDescription,
      slotEndAtMs: runtime.endAtMs,
      prepareAt,
      displayAt,
      unreadUserMessageIds: runtime.unreadUserMessageIds.slice(),
      shortReplyText: runtime.shortReplyText,
      reason: runtime.reason,
      failureCount: 0,
    };
    set({ busySlotRuntime: null, busyFollowUp: followUp });
    await db.keyval.delete(BUSY_SLOT_RUNTIME_STORAGE_KEY);
    await db.setVal(BUSY_FOLLOWUP_STORAGE_KEY, followUp);
  },

  patchBusyFollowUp: async (partial) => {
    const existing = get().busyFollowUp;
    if (!existing) return;
    const next: BusyFollowUp = { ...existing, ...partial };
    set({ busyFollowUp: next });
    await db.setVal(BUSY_FOLLOWUP_STORAGE_KEY, next);
  },

  clearBusyFollowUp: async () => {
    set({ busyFollowUp: null });
    await db.keyval.delete(BUSY_FOLLOWUP_STORAGE_KEY);
  },

  appendFollowUpToApology: async (reason) => {
    const followUp = get().busyFollowUp;
    if (!followUp) return;
    const source: PendingApologySource = {
      slotKey: followUp.slotKey,
      slotType: followUp.slotType,
      slotDescription: followUp.slotDescription,
      unreadUserMessageIds: followUp.unreadUserMessageIds.slice(),
      shortReplyText: followUp.shortReplyText,
      preparedTextParts: followUp.preparedTextParts
        ? followUp.preparedTextParts.slice()
        : undefined,
      reason,
      convertedAt: Date.now(),
    };
    const existingApology = get().pendingApology;
    const now = Date.now();
    const nextApology: PendingApology = existingApology
      ? {
          ...existingApology,
          latestAppendedAt: now,
          sources: [...existingApology.sources, source],
        }
      : {
          id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
          createdAt: now,
          latestAppendedAt: now,
          sources: [source],
        };
    set({ pendingApology: nextApology, busyFollowUp: null });
    // v2.14.28 M19: combine the two keyval writes into a single rw
    // transaction so a crash / quota-exhaustion in between cannot
    // leave behind a stale BUSY_FOLLOWUP row paired with a freshly
    // promoted PENDING_APOLOGY (or vice versa). With the transaction
    // either both writes commit OR Dexie rolls both back.
    await db.transaction('rw', db.keyval, async () => {
      await db.keyval.put({ key: PENDING_APOLOGY_STORAGE_KEY, value: nextApology });
      await db.keyval.delete(BUSY_FOLLOWUP_STORAGE_KEY);
    });
  },

  clearPendingApology: async () => {
    set({ pendingApology: null });
    await db.keyval.delete(PENDING_APOLOGY_STORAGE_KEY);
  },
});
