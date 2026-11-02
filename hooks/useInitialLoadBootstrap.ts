import { useEffect, type MutableRefObject } from 'react';
import { loadRawHistoryMessages } from '../components/app/rawHistorySync';
import { recalculateTurnCountFromMessages, sanitizeRelativeReminderRecord, sanitizeDailyReminderRecord, sanitizeMessageAlertRecord, sanitizeMissedReminderRecord, sanitizeWorldCharacterStatusRecord, sanitizeKumikoDiaryRecord, sanitizeDailyFragmentRecord, sanitizePsycheStateRecord, sanitizeKumikoMoodRecord, sanitizeKumikoAffectionRecord, sanitizeKumikoBlockRuntime } from '../components/app/backupHelpers';
import { isDataRestoreBlocked } from '../services/dataRestoreGate';
import { recoverInterruptedBackupRestore } from '../services/backupRestoreSession';
import { recoverInterruptedDataReset } from '../services/dataResetSession';
import { recoverMemoryMaintenance } from '../services/memoryMaintenance';
import { normalizeSummaryArchiveState, resolveCoreMemoryFromSummaryArchive } from '../components/app/summaryCycle';
import { normalizeMemoryQuerySession } from '../components/app/ragRecallHelpers';
import {
  SUMMARY_ARCHIVE_STATE_STORAGE_KEY,
  MEMORY_QUERY_SESSION_STORAGE_KEY,
  MESSAGE_ALERTS_STORAGE_KEY,
} from '../components/app/appConstants';
import {
  db,
  INITIAL_WORLD_CHARACTER_STATUS,
  type DailyFragmentEntity,
  type KumikoDiaryEntity,
  type KumikoAffectionEntity,
  type KumikoMoodEntity,
  type PsycheStateEntity,
  type WorldCharacterStatusMap,
} from '../services/db';
import { DEFAULT_BACKUP_CONFIG, normalizeBackupConfig } from '../services/appConfig';
import { DEFAULT_LOCATION_CONFIG, LOCALIZED_WORLD_BOOK } from '../constants';
import { RELATIVE_REMINDER_STORAGE_KEY, DAILY_REMINDER_STORAGE_KEY, KUMIKO_MISSED_REMINDERS_STORAGE_KEY, type RelativeReminder, type DailyReminder, type MissedReminderRecord } from '../store/slices/reminderSlice';
import { RAG_HISTORY_DIRTY_STORAGE_KEY } from '../store/slices/ragSlice';
import {
  BUSY_SLOT_RUNTIME_STORAGE_KEY,
  BUSY_FOLLOWUP_STORAGE_KEY,
  PENDING_APOLOGY_STORAGE_KEY,
  type BusySlotRuntime,
  type BusyFollowUp,
  type PendingApology,
} from '../store/slices/busySlice';
import { KUMIKO_BLOCK_RUNTIME_STORAGE_KEY } from '../store/slices/affectionSlice';
import type {
  Message,
  Language,
  LocationConfig,
  EmotionType,
  WorldBookEntry,
  AnchorEntry,
  BackupConfig,
  SummaryArchiveState,
  MemoryQuerySession,
  MissedMessageAlert,
  KumikoBlockRuntime,
} from '../types';

// v2.14.29 H10 rework helpers ------------------------------------------------
// These build the inbox alert + persistent context record for one-shot
// reminders that boot scan classifies as "Branch 2: > 3 days late, do
// not chat". Keeping them at module scope (vs. inside the hook closure)
// because they're pure and easy to unit-test in DevTools by re-importing
// without spinning up React. Both return null if the input record is
// malformed past the point where building a useful surface text is
// possible — caller filters those out.

const formatMissedSinceLabel = (lateBy: number, language: Language): string => {
  const days = Math.floor(lateBy / 86_400_000);
  if (language === 'en') {
    if (days <= 1) return 'about a day ago';
    if (days < 7) return `${days} days ago`;
    if (days < 14) return 'about a week ago';
    return `${Math.floor(days / 7)} weeks ago`;
  }
  if (days <= 1) return '大约一天前';
  if (days < 7) return `${days} 天前`;
  if (days < 14) return '差不多一周前';
  return `${Math.floor(days / 7)} 周前`;
};

const buildMissedReminderAlert = (
  raw: any,
  language: Language,
  bootNow: number,
): MissedMessageAlert | null => {
  if (!raw || typeof raw.event !== 'string' || typeof raw.dueAt !== 'number' || !Number.isFinite(raw.dueAt)) {
    return null;
  }
  const lateLabel = formatMissedSinceLabel(bootNow - raw.dueAt, language);
  const eventTrimmed = raw.event.trim();
  const preview = language === 'en'
    ? `Missed reminder · should have happened ${lateLabel}: ${eventTrimmed}`
    : `错过的提醒 · 本应在${lateLabel}发生：${eventTrimmed}`;
  // Synthetic message id — no real chat message exists for this case.
  // IMPORTANT: must be deterministic per raw reminder, NOT salted with
  // bootNow. Otherwise we'd append a brand-new alert on every cold boot
  // for the same overdue reminder (until cleanup drops the source row),
  // pushing the inbox toward its 50-cap with duplicates.
  const messageId = `missed-reminder-${raw.id ?? raw.dueAt}`;
  return {
    id: messageId,
    messageId,
    preview,
    timestamp: bootNow,
    kind: 'reminder',
    isRead: false,
  };
};

const buildMissedReminderRecord = (
  raw: any,
  bootNow: number,
): MissedReminderRecord | null => {
  if (!raw || typeof raw.event !== 'string' || typeof raw.dueAt !== 'number' || !Number.isFinite(raw.dueAt)) {
    return null;
  }
  return sanitizeMissedReminderRecord({
    id: typeof raw.id === 'string' ? `missed-${raw.id}` : `missed-${raw.dueAt}-${Math.random().toString(36).slice(2, 8)}`,
    event: raw.event,
    sourceText: typeof raw.sourceText === 'string' ? raw.sourceText : undefined,
    originalDueAt: raw.dueAt,
    recordedAt: bootNow,
  });
};

// Drop entries with the same `event + originalDueAt` pair, keeping the
// oldest `recordedAt` (so we don't spam the LLM if the user reopens the
// app multiple times before dismissing).
const dedupeMissedReminderRecords = (records: MissedReminderRecord[]): MissedReminderRecord[] => {
  const seen = new Map<string, MissedReminderRecord>();
  for (const r of records) {
    const key = `${r.event}::${r.originalDueAt}`;
    const prev = seen.get(key);
    if (!prev || r.recordedAt < prev.recordedAt) {
      seen.set(key, r);
    }
  }
  return Array.from(seen.values()).sort((a, b) => b.originalDueAt - a.originalDueAt);
};
// ----------------------------------------------------------------------------

export interface UseInitialLoadBootstrapParams {
  // Refs that survive across renders, written during load.
  rawHistorySyncedIdsRef: MutableRefObject<Set<string>>;
  forceRawHistoryResyncRef: MutableRefObject<boolean>;
  ragBufferRef: MutableRefObject<string[]>;

  // Memory-query session is always written via updateMemoryQuerySession
  // (ref + IndexedDB mirror); deps must match the original effect 1:1.
  updateMemoryQuerySession: (next: MemoryQuerySession | null) => void;

  // Setters (store actions; stable Zustand refs)
  setMessages: (v: Message[]) => void;
  setIsDisconnected: (v: boolean) => void;
  setLanguage: (v: Language) => void;
  setLocationConfig: (v: LocationConfig) => void;
  setCoreMemory: (v: string) => void;
  setKumikoNotebook: (v: string) => void;
  setContextLimit: (v: number) => void;
  setDiaryLayerPreset: (v: 'economy' | 'balanced' | 'rich') => void;
  setImageQualityPreset: (v: 'original' | 'high' | 'standard' | 'compact') => void;
  setWorldBook: (v: WorldBookEntry[]) => void;
  setTurnCount: (v: number) => void;
  setSummaryArchiveState: (v: SummaryArchiveState | ((prev: SummaryArchiveState) => SummaryArchiveState)) => void;
  setAnchors: (v: AnchorEntry[]) => void;
  setCurrentEmotion: (v: EmotionType) => void;
  setRelativeReminders: (v: RelativeReminder[]) => void;
  setDailyReminders: (v: DailyReminder[]) => void;
  setMissedReminders: (v: MissedReminderRecord[] | ((prev: MissedReminderRecord[]) => MissedReminderRecord[])) => void;
  setMessageAlerts: (v: MissedMessageAlert[] | ((prev: MissedMessageAlert[]) => MissedMessageAlert[])) => void;
  setWorldCharacterStatus: (v: WorldCharacterStatusMap) => void;
  setAutoSavedKumikoDiary: (v: KumikoDiaryEntity[]) => void;
  setAutoSavedDailyFragments: (v: DailyFragmentEntity[]) => void;
  setAutoSavedPsycheState: (v: PsycheStateEntity | null) => void;
  setBackupConfig: (v: BackupConfig) => void;
  setIsRagHistoryDirty: (v: boolean) => void;
  setIsDataLoaded: (v: boolean) => void;
  setDataLoadError: (v: string | null) => void;
  setSystemNotice: (v: string | null) => void;
  setBusySlotRuntime: (v: BusySlotRuntime | null) => void;
  setBusyFollowUp: (v: BusyFollowUp | null) => void;
  setPendingApology: (v: PendingApology | null) => void;
  // v2.14.29 Reactive: hydration setters for the mood / affection /
  // block-runtime slice. mood + affection have full Dexie tables (single
  // 'current' row); blockRuntime lives in keyval at
  // KUMIKO_BLOCK_RUNTIME_STORAGE_KEY. The boot rescue path also needs
  // persistBlockRuntime so we can clear an expired runtime row before
  // firing the proactive (otherwise the regulator would re-enter a tick
  // mid-fire and double-trigger).
  setMood: (v: KumikoMoodEntity | null) => void;
  setAffection: (v: KumikoAffectionEntity | null) => void;
  setBlockRuntime: (v: KumikoBlockRuntime | null) => void;
}

/**
 * Runs the one-shot data hydration that used to live inline at App.tsx L688.
 *
 * Flow:
 *   1. Loads messages via raw history sync; derives turn count + summary
 *      archive state + core memory; hydrates memory-query session.
 *   2. Pulls ~20 keys out of Dexie into the store, with defensive
 *      normalisation for rows that may legacy-corrupt.
 *   3. On failure, records `dataLoadError` so `useAutoSave` can block writes
 *      and surfaces a bilingual notice before still flipping `isDataLoaded`
 *      so the UI can render the error screen.
 *
 * Dep list is intentionally `[updateMemoryQuerySession]` only, matching the
 * pre-extraction effect exactly. Every other dependency is either a stable
 * setter (Zustand) or a mutable ref.
 */
export const useInitialLoadBootstrap = (params: UseInitialLoadBootstrapParams): void => {
  const {
    rawHistorySyncedIdsRef,
    forceRawHistoryResyncRef,
    ragBufferRef,
    updateMemoryQuerySession,
    setMessages,
    setIsDisconnected,
    setLanguage,
    setLocationConfig,
    setCoreMemory,
    setKumikoNotebook,
    setContextLimit,
    setDiaryLayerPreset,
    setImageQualityPreset,
    setWorldBook,
    setTurnCount,
    setSummaryArchiveState,
    setAnchors,
    setCurrentEmotion,
    setRelativeReminders,
    setDailyReminders,
    setMissedReminders,
    setMessageAlerts,
    setWorldCharacterStatus,
    setAutoSavedKumikoDiary,
    setAutoSavedDailyFragments,
    setAutoSavedPsycheState,
    setBackupConfig,
    setIsRagHistoryDirty,
    setIsDataLoaded,
    setDataLoadError,
    setSystemNotice,
    setBusySlotRuntime,
    setBusyFollowUp,
    setPendingApology,
    setMood,
    setAffection,
    setBlockRuntime,
  } = params;

  useEffect(() => {
    const loadData = async () => {
      try {
        await recoverInterruptedDataReset();
        await recoverInterruptedBackupRestore();
        await recoverMemoryMaintenance();
        const loadedMessages = await loadRawHistoryMessages();
        const loadedTurnCount = recalculateTurnCountFromMessages(loadedMessages);
        const loadedSummaryArchiveState = normalizeSummaryArchiveState(
          await db.getVal(SUMMARY_ARCHIVE_STATE_STORAGE_KEY, null),
          loadedTurnCount
        );
        const loadedCoreMemory = resolveCoreMemoryFromSummaryArchive(
          loadedSummaryArchiveState,
          await db.getVal('kumiko_core_memory', '')
        );
        const loadedMemoryQuerySession = normalizeMemoryQuerySession(
          await db.getVal(MEMORY_QUERY_SESSION_STORAGE_KEY, null)
        );

        setMessages(loadedMessages);
        if (loadedMessages.some(m => m.sendStatus === 'failed')) {
          setIsDisconnected(true);
        }
        rawHistorySyncedIdsRef.current = new Set(loadedMessages.map(message => message.id));
        forceRawHistoryResyncRef.current = false;
        updateMemoryQuerySession(loadedMemoryQuerySession);
        setLanguage(await db.getVal('kumiko_language', 'zh'));
        const loadedLocationConfig: LocationConfig = await db.getVal('kumiko_location_config', DEFAULT_LOCATION_CONFIG);
        setLocationConfig(loadedLocationConfig);
        setCoreMemory(loadedCoreMemory);
        setKumikoNotebook(await db.getVal('kumiko_notebook', ''));
        setContextLimit(await db.getVal('kumiko_context_limit', 100));
        {
          const storedPreset = await db.getVal('kumiko_diary_layer_preset', 'balanced');
          // Defensive: legacy installs / corrupted rows may hold an unknown string.
          // Fall back to the default rather than letting it poison the store.
          const resolvedPreset: 'economy' | 'balanced' | 'rich' =
            storedPreset === 'economy' || storedPreset === 'rich' ? storedPreset : 'balanced';
          setDiaryLayerPreset(resolvedPreset);
        }
        {
          const storedImageQuality = await db.getVal('kumiko_image_quality_preset', 'high');
          const resolvedImagePreset: 'original' | 'high' | 'standard' | 'compact' =
            storedImageQuality === 'original' || storedImageQuality === 'standard' || storedImageQuality === 'compact'
              ? storedImageQuality
              : 'high';
          setImageQualityPreset(resolvedImagePreset);
        }

        const savedWorldBook = await db.getVal('kumiko_world_book', null);
        if (savedWorldBook) {
            setWorldBook(savedWorldBook);
        } else {
            setWorldBook(LOCALIZED_WORLD_BOOK['zh']);
        }

        setTurnCount(loadedTurnCount);
        setSummaryArchiveState(loadedSummaryArchiveState);
        setAnchors(await db.getVal('kumiko_anchors', []));

        // v2.14.29 sleep-window FSM reconstruction at cold boot.
        //
        // The status line ("睡眠模式 (勿扰)") is computed every second from
        // the JST schedule slot, so it is always accurate. But the avatar
        // emotion / 情感参数 reads `kumiko_current_emotion` from disk, and the
        // only writers that flip it to 'sleepy' are runtime FSM transitions
        // (Phase 3 farewell + 5s, 30-min idle auto-sleep, chatActions
        // post-reply sleep activation). On a cold boot during the sleep
        // window — especially for fresh users who have never chatted —
        // none of those writers have ever fired, so the avatar stays at the
        // default 'neutral' even though the schedule says she should be
        // asleep.
        //
        // Heuristic: if JST is inside the sleeping slot AND the user is not
        // recentlyActive (no message in the last 15 min, OR no message
        // ever), then the FSM would have placed her at 'sleepy' by now.
        // Match the heartbeat's own thresholds (useProactiveLifeCycle.ts
        // line ~178/240). Don't override when she's mid-conversation —
        // her last reply emotion stays. Don't override outside the sleeping
        // slot. The mount-time effect in useProactiveLifeCycle then sets
        // hasGoneToSleepRef.current so the user's first message correctly
        // routes through the late-night wake dice in chatActions:2839.
        let bootEmotion: EmotionType = await db.getVal<EmotionType>('kumiko_current_emotion', 'neutral');
        try {
          const { getDetailedScheduleSlot } = await import('../services/kumikoStateMachine');
          const slot = getDetailedScheduleSlot(loadedLocationConfig?.modelTimezone, false);
          const lastMsgTime = loadedMessages.length > 0
            ? loadedMessages[loadedMessages.length - 1].timestamp
            : 0;
          const recentlyActive = lastMsgTime > 0 && Date.now() - lastMsgTime < 15 * 60_000;
          if (slot?.slotType === 'sleeping' && !recentlyActive && bootEmotion !== 'sleepy') {
            bootEmotion = 'sleepy';
            await db.setVal('kumiko_current_emotion', 'sleepy');
            console.log('[BOOT-SLEEP-SYNC] reconstructed FSM: she is asleep right now (slot=sleeping, !recentlyActive)');
          } else if (
            bootEmotion === 'sleepy'
            && slot?.slotType !== 'sleeping'
            && slot?.slotType !== 'drowsy'
          ) {
            // Stale 'sleepy' from a previous night. The existing 6:00 reset
            // branch (useProactiveLifeCycle.ts:181 / chatActions.ts:2818) is
            // gated by `hasGoneToSleepRef.current` which is false on every
            // cold boot, so a user who closed the app at 03:00 (with 'sleepy'
            // persisted by the heartbeat / by the boot sync above) and
            // reopens at 06:30+ would otherwise see the avatar stuck on
            // sleepy all morning. Treat any non-sleeping / non-drowsy slot
            // as "she has woken up" and rebaseline to neutral. Drowsy
            // (00:00-00:29) is preserved because that window legitimately
            // overlaps with "still tired, just laid down".
            bootEmotion = 'neutral';
            await db.setVal('kumiko_current_emotion', 'neutral');
            console.log('[BOOT-SLEEP-SYNC] cleared stale sleepy: slot=', slot?.slotType, '→ neutral');
          }
        } catch (e) {
          console.warn('[BOOT-SLEEP-SYNC] reconstruct failed; keeping rehydrated emotion', e);
        }
        setCurrentEmotion(bootEmotion);
        // v2.14.29 H10 rework: dual-branch boot scan for missed one-shot reminders.
        //
        // Background: the v2.14.28 first cut blanket re-armed any expired
        // one-shot reminder to `dueAt = now + 1ms`, which made the scheduler
        // fire the original on-time prompt ("现在已经到点了，快去吃药！")
        // even when the original time was hours or days ago. That nag-on-boot
        // behavior is what the user pushed back on: "都过期了，立刻提醒又是
        // 什么意义". The new design splits by lateness:
        //
        //   ≤ 3 days late: still re-arm, but stamp `originalDueAt` so the
        //     trigger path (chatActions.buildTimedReminderSystemPrompt) picks
        //     the "late acknowledgement" prompt instead of pretending it's
        //     on-time. Kumiko admits she missed it and asks if the user
        //     already handled it.
        //
        //   > 3 days late: don't fire any chat. Push a MissedMessageAlert to
        //     the inbox so the user can see it was logged, and push a
        //     MissedReminderRecord into kumiko_missed_reminders so the
        //     system prompt surfaces it deterministically — Kumiko brings
        //     it up only when (a) the user mentions a related topic or
        //     (b) she's initiating a chat after gapHours >= 3. See
        //     services/geminiService.ts missedReminderRecallBlock.
        //
        // The MissedReminderRecord array also gets a 7-day TTL sweep here so
        // entries don't accumulate indefinitely; the inbox itself caps at 50.
        if (isDataRestoreBlocked()) throw new Error('Data restore is in progress');
        const RESCUE_LATE_CHAT_GRACE_MS = 0; // Expired records are handled by the shared dispatcher.
        const MISSED_REMINDER_CONTEXT_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7d  → drop from prompt context

        const loadedLanguage = (await db.getVal('kumiko_language', 'zh')) as Language;
        const rawRelativeReminders = (await db.getVal(RELATIVE_REMINDER_STORAGE_KEY, [])) as any[];
        const bootNow = Date.now();
        const liveAndRescuedRelative: RelativeReminder[] = [];
        const pendingMissedAlerts: MissedMessageAlert[] = [];
        const pendingMissedRecords: MissedReminderRecord[] = [];

        for (const raw of rawRelativeReminders) {
            const live = sanitizeRelativeReminderRecord(raw);
            if (live) {
                liveAndRescuedRelative.push(live);
                continue;
            }
            // Possibly expired — split by lateness.
            if (raw && typeof raw.event === 'string' && typeof raw.dueAt === 'number'
                && typeof raw.createdAt === 'number' && Number.isFinite(raw.dueAt)
                && raw.dueAt <= bootNow) {
                const lateBy = bootNow - raw.dueAt;
                if (lateBy <= RESCUE_LATE_CHAT_GRACE_MS) {
                    // Branch 1: late chat, prompt template will acknowledge the lag.
                    const rescued = sanitizeRelativeReminderRecord({
                        ...raw,
                        dueAt: bootNow + 1,
                        originalDueAt: raw.dueAt,
                    });
                    if (rescued) {
                        console.info(`[BOOT H10] Late-chat rescue: ${rescued.event} (was due ${new Date(raw.dueAt).toISOString()}, ${Math.round(lateBy / 60000)}min late)`);
                        liveAndRescuedRelative.push(rescued);
                    }
                } else {
                    // Branch 2: passive — inbox alert + missed-reminder context, no chat.
                    const alert = buildMissedReminderAlert(raw, loadedLanguage, bootNow);
                    const record = buildMissedReminderRecord(raw, bootNow);
                    if (alert) pendingMissedAlerts.push(alert);
                    if (record) pendingMissedRecords.push(record);
                    console.info(`[BOOT H10] Passive missed reminder: ${raw.event} (was due ${new Date(raw.dueAt).toISOString()}, ${Math.round(lateBy / 86400000)}d late)`);
                }
            }
        }

        // Apply TTL sweep on existing missedReminders + merge in any new ones from this boot.
        const existingMissedRaw = (await db.getVal(KUMIKO_MISSED_REMINDERS_STORAGE_KEY, [])) as any[];
        const existingMissed = (existingMissedRaw.map(sanitizeMissedReminderRecord).filter(Boolean) as MissedReminderRecord[])
            .filter(r => (r.count ?? 0) > 0 || bootNow - r.recordedAt < MISSED_REMINDER_CONTEXT_TTL_MS);
        const mergedMissed = dedupeMissedReminderRecords([...pendingMissedRecords, ...existingMissed]);
        setMissedReminders(mergedMissed);
        // Persist back so the TTL drop and de-dup survive across restarts
        // even if the user never opens MessageCenterPanel to dismiss.
        await db.setVal(KUMIKO_MISSED_REMINDERS_STORAGE_KEY, mergedMissed);

        setRelativeReminders(liveAndRescuedRelative);
        // v2.14.29 H10: persist the rescued/cleaned list so the raw store
        // no longer carries the > 3-day-late entries we just demoted to
        // missed-reminder context. Without this, every cold boot would
        // re-scan the same expired rows, regenerate the same context
        // record, and push another inbox alert (the messageId is stable
        // so dedup catches it, but it still wastes a write each boot).
        await db.setVal(RELATIVE_REMINDER_STORAGE_KEY, liveAndRescuedRelative);
        setDailyReminders((await db.getVal(DAILY_REMINDER_STORAGE_KEY, [])).map(sanitizeDailyReminderRecord).filter(Boolean) as DailyReminder[]);

        // v2.14.29 H10: prepend pendingMissedAlerts so the user sees the
        // freshly-discovered missed reminders at the top of the inbox; cap
        // at 50 to match MESSAGE_ALERTS_STORAGE_KEY's policy elsewhere.
        const existingAlerts = ((await db.getVal(MESSAGE_ALERTS_STORAGE_KEY, [])) as any[])
            .map(sanitizeMessageAlertRecord)
            .filter(Boolean) as MissedMessageAlert[];
        const mergedAlerts = [...pendingMissedAlerts, ...existingAlerts.filter(a => !pendingMissedAlerts.some(p => p.id === a.id))]
            .slice(0, 50);
        setMessageAlerts(mergedAlerts);
        setWorldCharacterStatus(sanitizeWorldCharacterStatusRecord(await db.getVal('world_character_status', INITIAL_WORLD_CHARACTER_STATUS)));
        setAutoSavedKumikoDiary((await db.kumikoDiary.orderBy('date').toArray()).map(sanitizeKumikoDiaryRecord).filter(Boolean) as KumikoDiaryEntity[]);
        setAutoSavedDailyFragments((await db.dailyFragments.orderBy('timestamp').toArray()).map(sanitizeDailyFragmentRecord).filter(Boolean) as DailyFragmentEntity[]);
        setAutoSavedPsycheState(sanitizePsycheStateRecord(await db.psycheState.get('current')));

        const backupCfg = normalizeBackupConfig(await db.getVal('kumiko_backup_config', DEFAULT_BACKUP_CONFIG));
        setBackupConfig(backupCfg);
        setIsRagHistoryDirty(await db.getVal(RAG_HISTORY_DIRTY_STORAGE_KEY, false));

        // --- Busy state hydration ---
        // Load persisted `busySlotRuntime`, `busyFollowUp`, and
        // `pendingApology` from `keyval`. Defensive: even if the saved
        // shape is malformed, we coerce to null rather than throw —
        // the regulator hook will simply re-fill these on first tick.
        try {
          const savedRuntime = await db.getVal(BUSY_SLOT_RUNTIME_STORAGE_KEY, null) as BusySlotRuntime | null;
          if (savedRuntime && typeof savedRuntime.slotKey === 'string') {
            setBusySlotRuntime(savedRuntime);
          } else {
            setBusySlotRuntime(null);
          }
        } catch {
          setBusySlotRuntime(null);
        }
        try {
          const savedFollowUp = await db.getVal(BUSY_FOLLOWUP_STORAGE_KEY, null) as BusyFollowUp | null;
          if (savedFollowUp && typeof savedFollowUp.id === 'string') {
            setBusyFollowUp(savedFollowUp);
          } else {
            setBusyFollowUp(null);
          }
        } catch {
          setBusyFollowUp(null);
        }
        try {
          const savedApology = await db.getVal(PENDING_APOLOGY_STORAGE_KEY, null) as PendingApology | null;
          if (savedApology && Array.isArray(savedApology.sources)) {
            setPendingApology(savedApology);
          } else {
            setPendingApology(null);
          }
        } catch {
          setPendingApology(null);
        }

        // v2.14.29 Reactive: hydrate mood / affection / blockRuntime.
        //
        //   - mood + affection live in dedicated Dexie tables with a
        //     single 'current' row each. They can never be "expired";
        //     we just defensively sanitize the loaded shape and feed
        //     it into the store. The store mirror is what every UI
        //     panel reads at render time; the Dexie row stays the
        //     source of truth for persistence.
        //
        //   - blockRuntime is keyval-backed (mirror of busy state).
        //     Three boot decisions:
        //       (a) no row              → setBlockRuntime(null)
        //       (b) row, not yet expired → setBlockRuntime(row), the
        //           regulator will pick it up on the first tick and
        //           native AlarmManager (Android) is rescheduled now;
        //       (c) row, already expired → setBlockRuntime(row) so the
        //           regulator's next tick fires `block_release`
        //           immediately (mirrors H10 ≤3-day rescue path).
        try {
          const savedMood = await db.kumikoMood.get('current');
          setMood(sanitizeKumikoMoodRecord(savedMood));
        } catch {
          setMood(null);
        }
        try {
          const savedAffection = await db.kumikoAffection.get('current');
          setAffection(sanitizeKumikoAffectionRecord(savedAffection));
        } catch {
          setAffection(null);
        }
        try {
          const savedBlock = await db.getVal(KUMIKO_BLOCK_RUNTIME_STORAGE_KEY, null);
          const block = sanitizeKumikoBlockRuntime(savedBlock);
          if (block) {
            setBlockRuntime(block);
            // Reschedule the Android expiry alarm if the WebView was
            // killed: blockRuntimeService.startBlock registered one when
            // the block began, but Android may have dropped the
            // AlarmManager state on a hard-stop / device reboot. We
            // re-register here so the OS still has a chance to wake the
            // WebView when the block lapses, even if the JS regulator
            // never gets to tick because the user backgrounded again.
            if (block.activeUntilMs > bootNow) {
              try {
                const { isCapacitorNative, getCapacitorPlatform } = await import('../services/environment');
                if (isCapacitorNative() && getCapacitorPlatform() === 'android') {
                  const { scheduleAndroidAlarm } = await import('../services/androidAlarmService');
                  await scheduleAndroidAlarm({
                    reminderId: 'kumiko_block_expiry',
                    at: block.activeUntilMs,
                    event: 'block_release',
                    text: 'Kumiko · 拉黑解除',
                    wantsCall: false,
                  });
                }
              } catch (e) {
                console.warn('[BOOT] Block-expiry alarm rescheduling failed (non-fatal):', e);
              }
            }
            // If already expired, the JS-side useBlockRegulator will
            // notice `activeUntilMs <= now` on its first tick and fire
            // the block_release proactive. We intentionally do NOT
            // clear the row here — leaving it intact is what lets the
            // regulator detect the "expired during downtime" state.
          } else {
            setBlockRuntime(null);
          }
        } catch (e) {
          console.warn('[BOOT] Block-runtime hydration failed (non-fatal):', e);
          setBlockRuntime(null);
        }

        ragBufferRef.current = await db.getVal('kumiko_rag_buffer', []);

        setIsDataLoaded(true);
      } catch (e) {
        console.error("Failed to load data from IndexedDB", e);
        // CRITICAL: record the error so useAutoSave can block writes and UI can warn.
        // Previously we unconditionally flipped isDataLoaded to true, which let the empty
        // default state be auto-saved back over the user's real backup in 3s — destroying data.
        const message = e instanceof Error ? e.message : String(e);
        setDataLoadError(message);
        // Surface a warning. We cannot rely on `language` being loaded here (it's part of
        // the failing load). Default to zh (app primary language); only use en if browser
        // explicitly reports English.
        const isEn = typeof navigator !== 'undefined' && /^en/i.test(navigator.language || '');
        setSystemNotice(isEn
          ? 'Data load failed; auto-save has been paused to protect your backup. Please restart the app or restore from a backup.'
          : '数据加载失败，已暂停自动保存以保护您的备份。请重启应用或从备份恢复。');
        setIsDataLoaded(true);
      }
    };
    loadData();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- preserve original deps (all setters/refs are stable; only updateMemoryQuerySession triggers re-run)
  }, [updateMemoryQuerySession]);
};
