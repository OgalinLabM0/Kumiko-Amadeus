import type { StateCreator } from 'zustand';
import { db, type KumikoAffectionEntity, type KumikoMoodEntity } from '../../services/db';
import type { KumikoBlockRuntime } from '../../types';

// v2.14.29 Reactive — Mood / Affection / Block runtime store slice.
//
// Why three pieces in one slice:
//   - `mood` and `affection` are the public-facing state that the
//     UI (ProfilePanel, BlockBanner debug copy) reads at 1Hz / on
//     panel open. Keeping them on the same slice mirrors how busy +
//     followUp + apology share `busySlice`.
//   - `blockRuntime` is the only piece that lives in keyval (not in
//     its own Dexie table) because it's a single object whose only
//     persistence is "is there an active block, and how long".
//
// Persistence path:
//   - mood / affection: services/db.ts singleton tables → mutated by
//     services/moodService.ts + affectionService.ts directly. The
//     slice setters here are the renderer mirror only; the source of
//     truth is the Dexie row.
//   - blockRuntime: keyval `kumiko_block_runtime` so it survives
//     PC quit / Android process kill (mirror of busySlotRuntime).

export const KUMIKO_BLOCK_RUNTIME_STORAGE_KEY = 'kumiko_block_runtime';

export interface AffectionSlice {
  mood: KumikoMoodEntity | null;
  affection: KumikoAffectionEntity | null;
  blockRuntime: KumikoBlockRuntime | null;

  setMood: (v: KumikoMoodEntity | null) => void;
  setAffection: (v: KumikoAffectionEntity | null) => void;
  setBlockRuntime: (v: KumikoBlockRuntime | null) => void;

  // Persisting setter for blockRuntime — the only keyval-backed entry
  // in this slice. Mood / affection use their dedicated Dexie table
  // through moodService / affectionService.
  persistBlockRuntime: (v: KumikoBlockRuntime | null) => Promise<void>;
}

export const createAffectionSlice: StateCreator<AffectionSlice, [], [], AffectionSlice> = (set) => ({
  mood: null,
  affection: null,
  blockRuntime: null,

  setMood: (v) => set({ mood: v }),
  setAffection: (v) => set({ affection: v }),
  setBlockRuntime: (v) => set({ blockRuntime: v }),

  persistBlockRuntime: async (v) => {
    set({ blockRuntime: v });
    if (v === null) await db.keyval.delete(KUMIKO_BLOCK_RUNTIME_STORAGE_KEY);
    else await db.setVal(KUMIKO_BLOCK_RUNTIME_STORAGE_KEY, v);
  },
});
