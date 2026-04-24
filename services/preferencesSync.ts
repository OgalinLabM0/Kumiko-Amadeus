import { db, INITIAL_WORLD_CHARACTER_STATUS, type KeyValEntity } from './db';
import { useAppStore } from '../store';
import { isElectron, isMobilePwa } from './environment';
import { DEFAULT_LOCATION_CONFIG, LOCALIZED_WORLD_BOOK } from '../constants';
import { DEFAULT_BACKUP_CONFIG, normalizeBackupConfig } from './appConfig';
import { sanitizeTtsConfig } from './ttsConfigSanitize';
import { normalizeAIConfig } from './appConfig';
import {
  MESSAGE_ALERTS_STORAGE_KEY,
  SUMMARY_ARCHIVE_STATE_STORAGE_KEY,
} from '../components/app/appConstants';
import {
  RELATIVE_REMINDER_STORAGE_KEY,
  DAILY_REMINDER_STORAGE_KEY,
  type DailyReminder,
  type RelativeReminder,
} from '../store/slices/reminderSlice';
import {
  BUSY_FOLLOWUP_STORAGE_KEY,
  BUSY_SLOT_RUNTIME_STORAGE_KEY,
  PENDING_APOLOGY_STORAGE_KEY,
  type BusyFollowUp,
  type BusySlotRuntime,
  type PendingApology,
} from '../store/slices/busySlice';
import { RAG_HISTORY_DIRTY_STORAGE_KEY } from '../store/slices/ragSlice';
import {
  sanitizeDailyReminderRecord,
  sanitizeMessageAlertRecord,
  sanitizeRelativeReminderRecord,
  sanitizeWorldCharacterStatusRecord,
} from '../components/app/backupHelpers';
import { normalizeSummaryArchiveState } from '../components/app/summaryCycle';
import type {
  AIConfig,
  BackupConfig,
  EmotionType,
  LocationConfig,
  MissedMessageAlert,
  SummaryArchiveState,
  TtsConfig,
  WorldBookEntry,
} from '../types';

export const SYNCED_LOCAL_STORAGE_KEYS = [
  'kumiko_ai_config',
  'kumiko_tts_config',
  'tavily_api_key',
  'enable_internet_search',
  'enable_proactive_messaging',
  'kumiko_auto_diary_backfill',
  'kumiko_auth_username',
  'kumiko_auth_password',
] as const;

export type SyncedLocalStorageKey = (typeof SYNCED_LOCAL_STORAGE_KEYS)[number];

export const PREFERENCES_UPDATED_EVENT = 'kumiko:preferences-updated';
export const PREFERENCES_REVISION_STORAGE_KEY = 'kumiko_preferences_revision';
export const SYNCED_KEYVAL_KEYS = new Set<string>([
  'kumiko_language',
  'kumiko_location_config',
  'kumiko_core_memory',
  'kumiko_notebook',
  'kumiko_context_limit',
  'kumiko_diary_layer_preset',
  'kumiko_image_quality_preset',
  'kumiko_world_book',
  'kumiko_turn_count',
  SUMMARY_ARCHIVE_STATE_STORAGE_KEY,
  RELATIVE_REMINDER_STORAGE_KEY,
  DAILY_REMINDER_STORAGE_KEY,
  'kumiko_anchors',
  MESSAGE_ALERTS_STORAGE_KEY,
  'kumiko_current_emotion',
  'kumiko_backup_config',
  RAG_HISTORY_DIRTY_STORAGE_KEY,
  'world_character_status',
  BUSY_SLOT_RUNTIME_STORAGE_KEY,
  BUSY_FOLLOWUP_STORAGE_KEY,
  PENDING_APOLOGY_STORAGE_KEY,
]);

export interface PreferencesPatch {
  localStorage?: Partial<Record<SyncedLocalStorageKey, string | null>>;
  keyval?: KeyValEntity[];
  autoZipEnabled?: boolean;
}

export interface PreferencesBootstrapPayload extends PreferencesPatch {
  revision: number;
}

interface PreferencesUpdatedDetail {
  keys: string[];
  revision?: number;
}

const DESKTOP_BROADCAST_CHANNEL = 'mobile-event-broadcast';

let syncSuppressionDepth = 0;
let queuedDesktopKeys = new Set<string>();
let desktopFlushScheduled = false;
let queuedMobileLocalStorage = new Map<SyncedLocalStorageKey, string | null>();
let queuedMobileKeyval = new Map<string, unknown>();
let mobileFlushScheduled = false;

function dispatchPreferencesUpdated(detail: PreferencesUpdatedDetail): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent<PreferencesUpdatedDetail>(PREFERENCES_UPDATED_EVENT, { detail }));
  } catch {
    // ignore
  }
}

function readLocalStorageNumber(key: string): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? Number(raw) : 0;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeLocalStorageNumber(key: string, value: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, String(Math.max(0, Math.floor(value))));
  } catch {
    // ignore quota/private-mode failures
  }
}

export function readPreferencesRevision(): number {
  return readLocalStorageNumber(PREFERENCES_REVISION_STORAGE_KEY);
}

export function writePreferencesRevision(revision: number): void {
  writeLocalStorageNumber(PREFERENCES_REVISION_STORAGE_KEY, revision);
}

function bumpPreferencesRevision(): number {
  const next = readPreferencesRevision() + 1;
  writePreferencesRevision(next);
  return next;
}

export function isPreferencesSyncSuppressed(): boolean {
  return syncSuppressionDepth > 0;
}

export function shouldSyncKeyvalKey(key: string): boolean {
  return SYNCED_KEYVAL_KEYS.has(key);
}

export async function withPreferencesSyncSuppressed<T>(fn: () => Promise<T> | T): Promise<T> {
  syncSuppressionDepth += 1;
  try {
    return await fn();
  } finally {
    syncSuppressionDepth = Math.max(0, syncSuppressionDepth - 1);
  }
}

function setRawLocalStorageValue(key: SyncedLocalStorageKey, value: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // ignore
  }
}

function normaliseAiConfigRaw(raw: string | null): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeAIConfig(parsed as AIConfig);
    return JSON.stringify(normalized);
  } catch {
    return raw;
  }
}

function normaliseTtsConfigRaw(raw: string | null): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const normalized = sanitizeTtsConfig(parsed as TtsConfig);
    return JSON.stringify(normalized);
  } catch {
    return raw;
  }
}

function normaliseLocalStorageValue(key: SyncedLocalStorageKey, value: string | null): string | null {
  switch (key) {
    case 'kumiko_ai_config':
      return normaliseAiConfigRaw(value);
    case 'kumiko_tts_config':
      return normaliseTtsConfigRaw(value);
    case 'enable_internet_search':
    case 'enable_proactive_messaging':
    case 'kumiko_auto_diary_backfill':
      return value === 'true' ? 'true' : 'false';
    default:
      return value;
  }
}

function resolveDiaryLayerPreset(value: unknown): 'economy' | 'balanced' | 'rich' {
  return value === 'economy' || value === 'rich' ? value : 'balanced';
}

function resolveImageQualityPreset(value: unknown): 'original' | 'high' | 'standard' | 'compact' {
  return value === 'original' || value === 'standard' || value === 'compact' ? value : 'high';
}

function applyLocalStorageValueToRuntime(key: SyncedLocalStorageKey, value: string | null): void {
  const store = useAppStore.getState();
  if (key === 'kumiko_tts_config' && typeof value === 'string' && value.length > 0) {
    try {
      store.setTtsConfig(sanitizeTtsConfig(JSON.parse(value)));
    } catch {
      // ignore malformed payloads
    }
  }
}

function applyKeyvalToRuntime(key: string, value: unknown, turnCountHint?: number): void {
  const store = useAppStore.getState();

  switch (key) {
    case 'kumiko_language':
      store.setLanguage(value === 'en' ? 'en' : 'zh');
      return;
    case 'kumiko_location_config':
      store.setLocationConfig(
        value && typeof value === 'object'
          ? (value as LocationConfig)
          : DEFAULT_LOCATION_CONFIG,
      );
      return;
    case 'kumiko_core_memory':
      store.setCoreMemory(typeof value === 'string' ? value : '');
      return;
    case 'kumiko_notebook':
      store.setKumikoNotebook(typeof value === 'string' ? value : '');
      return;
    case 'kumiko_context_limit':
      store.setContextLimit(
        typeof value === 'number' && Number.isFinite(value) ? value : 100,
      );
      return;
    case 'kumiko_diary_layer_preset':
      store.setDiaryLayerPreset(resolveDiaryLayerPreset(value));
      return;
    case 'kumiko_image_quality_preset':
      store.setImageQualityPreset(resolveImageQualityPreset(value));
      return;
    case 'kumiko_world_book':
      store.setWorldBook(
        Array.isArray(value) ? (value as WorldBookEntry[]) : LOCALIZED_WORLD_BOOK.zh,
      );
      return;
    case 'kumiko_turn_count':
      store.setTurnCount(typeof value === 'number' && Number.isFinite(value) ? value : 0);
      return;
    case SUMMARY_ARCHIVE_STATE_STORAGE_KEY: {
      const currentTurnCount =
        typeof turnCountHint === 'number' && Number.isFinite(turnCountHint)
          ? turnCountHint
          : useAppStore.getState().turnCount;
      store.setSummaryArchiveState(
        normalizeSummaryArchiveState(value as SummaryArchiveState | null, currentTurnCount),
      );
      return;
    }
    case RELATIVE_REMINDER_STORAGE_KEY:
      store.setRelativeReminders(
        (Array.isArray(value) ? value : [])
          .map(sanitizeRelativeReminderRecord)
          .filter(Boolean) as RelativeReminder[],
      );
      return;
    case DAILY_REMINDER_STORAGE_KEY:
      store.setDailyReminders(
        (Array.isArray(value) ? value : [])
          .map(sanitizeDailyReminderRecord)
          .filter(Boolean) as DailyReminder[],
      );
      return;
    case 'kumiko_anchors':
      store.setAnchors(Array.isArray(value) ? value : []);
      return;
    case MESSAGE_ALERTS_STORAGE_KEY:
      store.setMessageAlerts(
        (Array.isArray(value) ? value : [])
          .map(sanitizeMessageAlertRecord)
          .filter(Boolean)
          .slice(0, 50) as MissedMessageAlert[],
      );
      return;
    case 'kumiko_current_emotion':
      store.setCurrentEmotion(
        typeof value === 'string' && value.length > 0 ? (value as EmotionType) : 'neutral',
      );
      return;
    case 'kumiko_backup_config':
      store.setBackupConfig(normalizeBackupConfig(value as BackupConfig));
      return;
    case RAG_HISTORY_DIRTY_STORAGE_KEY:
      store.setIsRagHistoryDirty(value === true);
      return;
    case BUSY_SLOT_RUNTIME_STORAGE_KEY:
      store.setBusySlotRuntime(
        value && typeof value === 'object' ? (value as BusySlotRuntime) : null,
      );
      return;
    case BUSY_FOLLOWUP_STORAGE_KEY:
      store.setBusyFollowUp(
        value && typeof value === 'object' ? (value as BusyFollowUp) : null,
      );
      return;
    case PENDING_APOLOGY_STORAGE_KEY:
      store.setPendingApology(
        value && typeof value === 'object' ? (value as PendingApology) : null,
      );
      return;
    case 'world_character_status':
      sanitizeWorldCharacterStatusRecord(
        value && typeof value === 'object' ? value : INITIAL_WORLD_CHARACTER_STATUS,
      );
      return;
    default:
      return;
  }
}

export async function applyPreferencesPatch(
  patch: PreferencesPatch,
  options: { replaceKeyval?: boolean; revision?: number } = {},
): Promise<void> {
  const localEntries = Object.entries(patch.localStorage || {}) as Array<[SyncedLocalStorageKey, string | null]>;
  const keyvalRows = (Array.isArray(patch.keyval) ? patch.keyval : []).filter((row) => shouldSyncKeyvalKey(row.key));
  const normalisedLocalEntries = localEntries.map(([key, value]) => [key, normaliseLocalStorageValue(key, value)] as const);
  const turnCountEntry = keyvalRows.find((row) => row.key === 'kumiko_turn_count');
  const turnCountHint =
    typeof turnCountEntry?.value === 'number' && Number.isFinite(turnCountEntry.value)
      ? turnCountEntry.value
      : undefined;

  await withPreferencesSyncSuppressed(async () => {
    for (const [key, value] of normalisedLocalEntries) {
      setRawLocalStorageValue(key, value);
    }
    if (keyvalRows.length > 0 || options.replaceKeyval) {
      await db.transaction('rw', [db.keyval], async () => {
        if (options.replaceKeyval) {
          await db.keyval.bulkDelete([...SYNCED_KEYVAL_KEYS]);
        }
        if (keyvalRows.length > 0) {
          await db.keyval.bulkPut(keyvalRows);
        }
      });
    }
  });

  for (const [key, value] of normalisedLocalEntries) {
    applyLocalStorageValueToRuntime(key, value);
  }
  for (const row of keyvalRows) {
    applyKeyvalToRuntime(row.key, row.value, turnCountHint);
  }
  if (typeof patch.autoZipEnabled === 'boolean') {
    useAppStore.getState().setAutoZipEnabled(patch.autoZipEnabled);
  }
  if (typeof options.revision === 'number' && Number.isFinite(options.revision)) {
    writePreferencesRevision(options.revision);
  }

  const changedKeys = [
    ...normalisedLocalEntries.map(([key]) => key),
    ...keyvalRows.map((row) => row.key),
    ...(typeof patch.autoZipEnabled === 'boolean' ? ['app:auto-zip-backup'] : []),
  ];
  if (changedKeys.length > 0) {
    dispatchPreferencesUpdated({ keys: changedKeys, revision: options.revision });
  }
}

export async function buildPreferencesBootstrapPayload(
  autoZipEnabled?: boolean,
): Promise<PreferencesBootstrapPayload> {
  const localStorageSnapshot = {} as Record<SyncedLocalStorageKey, string | null>;
  if (typeof window !== 'undefined') {
    for (const key of SYNCED_LOCAL_STORAGE_KEYS) {
      try {
        localStorageSnapshot[key] = normaliseLocalStorageValue(key, window.localStorage.getItem(key));
      } catch {
        localStorageSnapshot[key] = null;
      }
    }
  }
  const keyval = (await db.keyval.toArray()).filter((row) => shouldSyncKeyvalKey(row.key));
  return {
    revision: readPreferencesRevision(),
    localStorage: localStorageSnapshot,
    keyval,
    autoZipEnabled,
  };
}

function scheduleDesktopPreferencesFlush(): void {
  if (desktopFlushScheduled) return;
  desktopFlushScheduled = true;
  setTimeout(() => {
    desktopFlushScheduled = false;
    const keys = [...queuedDesktopKeys];
    queuedDesktopKeys = new Set<string>();
    if (keys.length === 0) return;
    const revision = bumpPreferencesRevision();
    try {
      window.electronAPI?.send?.(DESKTOP_BROADCAST_CHANNEL, {
        type: 'preferences:changed',
        keys,
        revision,
      });
    } catch (e) {
      console.warn('[preferencesSync] desktop preferences broadcast failed:', e);
    }
    dispatchPreferencesUpdated({ keys, revision });
  }, 0);
}

function scheduleMobilePatchFlush(): void {
  if (mobileFlushScheduled) return;
  mobileFlushScheduled = true;
  setTimeout(() => {
    mobileFlushScheduled = false;
    const localStoragePatch = queuedMobileLocalStorage.size > 0
      ? Object.fromEntries(queuedMobileLocalStorage)
      : undefined;
    const keyvalPatch = queuedMobileKeyval.size > 0
      ? [...queuedMobileKeyval.entries()].map(([key, value]) => ({ key, value }))
      : undefined;
    queuedMobileLocalStorage = new Map<SyncedLocalStorageKey, string | null>();
    queuedMobileKeyval = new Map<string, unknown>();
    if (!localStoragePatch && !keyvalPatch) return;
    void import('./httpApi')
      .then(({ httpInvoke }) => httpInvoke('preferences:set-from-mobile', {
        localStorage: localStoragePatch,
        keyval: keyvalPatch,
      }))
      .catch((e) => {
        console.warn('[preferencesSync] mobile preferences sync failed:', e);
      });
  }, 0);
}

export function queueLocalStoragePreferenceSync(
  key: SyncedLocalStorageKey,
  value: string | null,
  options: {
    /** Mobile PWA only: forward this change up to the PC. Defaults to true. */
    propagateToDesktop?: boolean;
    /**
     * Re-apply the new value to the in-process Zustand store. Defaults to
     * true. Pass `false` when the caller has already updated the store with
     * the same value to avoid a redundant `setTtsConfig` / `setLanguage` etc.
     * (the redundant write would create a fresh object reference, force an
     * extra render of every store subscriber, and—on Windows desktop—
     * compound visible jank when the caller is reacting to a click event).
     */
    applyToStore?: boolean;
    /**
     * Queue a `preferences:changed` cross-device broadcast. Defaults to true.
     * Pass `false` when the caller is sending a more specific broadcast
     * (e.g. `tts-config:changed`) so a single user action does not fan out
     * two redundant IPC events that ultimately drive the same mobile
     * rehydration.
     */
    broadcast?: boolean;
  } = {},
): void {
  const normalized = normaliseLocalStorageValue(key, value);
  setRawLocalStorageValue(key, normalized);
  if (options.applyToStore !== false) {
    applyLocalStorageValueToRuntime(key, normalized);
  }
  dispatchPreferencesUpdated({ keys: [key] });

  if (isPreferencesSyncSuppressed()) return;
  if (options.broadcast === false) return;

  if (isElectron()) {
    queuedDesktopKeys.add(key);
    scheduleDesktopPreferencesFlush();
    return;
  }

  if (isMobilePwa() && options.propagateToDesktop !== false) {
    queuedMobileLocalStorage.set(key, normalized);
    scheduleMobilePatchFlush();
  }
}

export function noteKeyvalPreferenceWrite(key: string, value: unknown): void {
  if (!shouldSyncKeyvalKey(key)) return;
  if (isPreferencesSyncSuppressed()) return;
  if (isElectron()) {
    queuedDesktopKeys.add(key);
    scheduleDesktopPreferencesFlush();
    return;
  }
  if (isMobilePwa()) {
    queuedMobileKeyval.set(key, value);
    scheduleMobilePatchFlush();
  }
}

export function emitPreferencesChanged(keys: string[]): void {
  if (!isElectron() || isPreferencesSyncSuppressed()) return;
  for (const key of keys) {
    queuedDesktopKeys.add(key);
  }
  scheduleDesktopPreferencesFlush();
}
