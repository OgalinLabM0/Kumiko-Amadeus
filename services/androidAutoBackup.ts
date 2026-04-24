// services/androidAutoBackup.ts
//
// B.5 + A4.3: Android auto-backup. Replaces PC's electron-builder
// before-quit auto-zip (which doesn't apply because Android apps
// don't have a "before-quit" event in the same sense — the OS just
// kills them). Strategy:
//
//   - 4h interval timer (driven by setInterval inside the FG service-
//     hosted WebView, which keeps running because B.1 keeps the process
//     alive)
//   - Trigger on App.appStateChange → background (catch the user
//     backgrounding the app right after a long session)
//   - Rolling retention: keep the 7 most recent zips, delete older
//   - Zips written to Filesystem.Directory.Data/auto-backup/{ts}.zip
//     (private app dir, sandboxed, persists across launches, NOT in
//     Documents because we don't want them showing up in Files app)
//
// Uses the existing buildWebBackupZipBlob helper from
// components/app/backupActions.ts so the zip content is bit-identical
// to the user's manual export — same images / voice / ringtone /
// Dexie data.
//
// PWA / Electron never call into here. PC continues to use its own
// electron/auto-zip-backup.cjs before-quit handler.

import { isCapacitorNative } from './environment';

const AUTO_BACKUP_DIR = 'auto-backup';
const ROLLING_KEEP = 7;
const INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const LAST_RUN_KEY = 'kumiko_android_auto_backup_last_run';
const MIN_GAP_MS = 30 * 60 * 1000; // 30 min gap so backgrounding doesn't spam

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let appStateListenerRemove: (() => void) | null = null;
let appStateListenerAttached = false;
let runInFlight = false;

function getLastRunMs(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.localStorage.getItem(LAST_RUN_KEY);
    return raw ? Number(raw) || 0 : 0;
  } catch {
    return 0;
  }
}

function setLastRunMs(ms: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_RUN_KEY, String(ms));
  } catch {
    /* ignore */
  }
}

async function readBackupBlob(): Promise<Blob | null> {
  // Lazy-import the user's manual-backup builder so we don't pull in
  // the entire backup actions tree at module load.
  try {
    const mod = await import('../components/app/backupActions');
    // buildAndroidAutoBackupBlob is a thin re-export wrapper we add at
    // the same time as this file (see commit). Falls back to manual
    // build path if the helper isn't available.
    const builder = (mod as { buildAndroidAutoBackupBlob?: () => Promise<Blob | null> }).buildAndroidAutoBackupBlob;
    if (typeof builder === 'function') {
      return await builder();
    }
  } catch (e) {
    console.warn('[androidAutoBackup] failed to import backup builder:', e);
  }
  return null;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    bin += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(bin);
}

async function pruneOldBackups(): Promise<void> {
  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    let entries: Array<{ name: string; mtime?: number }>;
    try {
      const res = await Filesystem.readdir({ path: AUTO_BACKUP_DIR, directory: Directory.Data });
      entries = (res as { files?: Array<{ name: string; mtime?: number }> }).files || [];
    } catch {
      // Dir doesn't exist yet — no prune.
      return;
    }
    const zipFiles = entries
      .filter((f) => /\.zip$/i.test(f.name))
      .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    const toDelete = zipFiles.slice(ROLLING_KEEP);
    for (const f of toDelete) {
      try {
        await Filesystem.deleteFile({
          path: `${AUTO_BACKUP_DIR}/${f.name}`,
          directory: Directory.Data,
        });
      } catch (e) {
        console.warn('[androidAutoBackup] prune delete failed:', f.name, e);
      }
    }
    if (toDelete.length > 0) {
      console.log(`[androidAutoBackup] pruned ${toDelete.length} old backups, kept ${ROLLING_KEEP}`);
    }
  } catch (e) {
    console.warn('[androidAutoBackup] prune failed:', e);
  }
}

export async function runAndroidAutoBackup(reason: 'interval' | 'background' | 'manual'): Promise<{ ok: boolean; path?: string; error?: string; skipped?: boolean }> {
  if (!isCapacitorNative()) return { ok: false, error: 'not_capacitor', skipped: true };
  if (runInFlight) return { ok: false, error: 'already_running', skipped: true };

  // Cooldown to avoid background-event spamming.
  const now = Date.now();
  const last = getLastRunMs();
  if (reason !== 'manual' && last > 0 && now - last < MIN_GAP_MS) {
    return { ok: true, skipped: true };
  }

  runInFlight = true;
  try {
    const blob = await readBackupBlob();
    if (!blob) {
      return { ok: false, error: 'builder_unavailable' };
    }
    const ts = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19); // YYYY-MM-DDTHH-MM-SS
    const fileName = `kumiko_auto_${ts}.zip`;
    const data = await blobToBase64(blob);

    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const writeRes = await Filesystem.writeFile({
      path: `${AUTO_BACKUP_DIR}/${fileName}`,
      data,
      directory: Directory.Data,
      recursive: true,
    });

    setLastRunMs(now);
    void pruneOldBackups();

    console.log(`[androidAutoBackup] ${reason} backup saved: ${fileName} (${(blob.size / 1024).toFixed(1)} KB)`);
    return { ok: true, path: writeRes.uri };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    console.warn('[androidAutoBackup] run failed:', e);
    return { ok: false, error: msg };
  } finally {
    runInFlight = false;
  }
}

/**
 * Start the auto-backup loop. Idempotent — safe to call from any
 * lifecycle point (e.g., the App.tsx mount effect).
 */
export async function startAndroidAutoBackup(): Promise<void> {
  if (!isCapacitorNative()) return;
  if (intervalHandle !== null) return;

  // Run once on startup if it's been more than 4h since last (catches
  // the case where the user opened the app after a long absence).
  const last = getLastRunMs();
  if (Date.now() - last > INTERVAL_MS) {
    void runAndroidAutoBackup('interval');
  }

  intervalHandle = setInterval(() => {
    void runAndroidAutoBackup('interval');
  }, INTERVAL_MS);

  if (!appStateListenerAttached) {
    try {
      const { App } = await import('@capacitor/app');
      const sub = await App.addListener('appStateChange', (state) => {
        if (!state.isActive) {
          // App going to background — fire a backup unless we've run
          // in the last MIN_GAP_MS (prevents spamming on rapid
          // foreground/background flicks while the user is
          // multitasking).
          void runAndroidAutoBackup('background');
        }
      });
      appStateListenerRemove = () => sub.remove();
      appStateListenerAttached = true;
    } catch (e) {
      console.warn('[androidAutoBackup] failed to attach appState listener:', e);
    }
  }
}

export function stopAndroidAutoBackup(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (appStateListenerRemove) {
    try { appStateListenerRemove(); } catch { /* ignore */ }
    appStateListenerRemove = null;
    appStateListenerAttached = false;
  }
}
