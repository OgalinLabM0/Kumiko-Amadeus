
import { useState, useEffect, useRef, useCallback } from 'react';
import { BackupConfig } from '../types';
import { isDesktopElectron, writeDesktopBackupFile } from '../services/desktopBackupService';
import { isCapacitorNative } from '../services/environment';
// F2B.3: dropped `isMobilePwa` + `httpInvoke` imports. The mobile-PWA
// remote-file-write branch (`backup:write-desktop-file`) is gone with
// the PC bridge; on Capacitor the LOCAL backup tab is hidden (F2A.4).

export type SyncStatus = 'IDLE' | 'DIRTY' | 'SAVING' | 'SAVED' | 'ERROR' | 'CONFLICT';

interface UseAutoSaveProps {
  data: any; // The full state object to save
  config: BackupConfig;
  fileHandle: any; // FileSystemFileHandle or desktop file path
  isBlocked: boolean; // e.g. isTalking || isThinking
  onSaveError?: (msg: string) => void;
  validate?: (data: any) => boolean; // NEW: Validation callback
}

// Note: cloud sync was removed (P0 #6). The `fetchWithTimeout` helper and its
// remote-save path were retired at the same time; only local file-handle /
// desktop IPC writes remain.

export const useAutoSave = ({ data, config, fileHandle, isBlocked, onSaveError, validate }: UseAutoSaveProps) => {
  const [status, setStatus] = useState<SyncStatus>('IDLE');
  const [lastSyncedTime, setLastSyncedTime] = useState<number>(Date.now());
  const [lastChangeTime, setLastChangeTime] = useState<number>(Date.now()); // Track when data last changed
  
  // Refs to hold latest values for async functions
  const dataRef = useRef(data);
  const configRef = useRef(config);
  const fileHandleRef = useRef(fileHandle);
  const statusRef = useRef(status);
  const isBlockedRef = useRef(isBlocked); // Ref for blocker
  const savePendingRef = useRef(false); // If true, trigger another save immediately after current one finishes
  const lastSnapshotRef = useRef(JSON.stringify(data)); // For dirty checking
  
  // Retry logic state
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // v2.14.28 M4: SAVED→IDLE revert timer kept in a ref so unmount can
  // clear it. See executeSave for the rationale.
  const idleRevertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // v2.14.28 M3: latest onSaveError ref so executeSave's stable identity
  // can dispatch the freshest callback even after the parent recreates it.
  const onSaveErrorRef = useRef(onSaveError);
  useEffect(() => { onSaveErrorRef.current = onSaveError; }, [onSaveError]);

  // Sync refs
  useEffect(() => {
    dataRef.current = data;
    configRef.current = config;
    fileHandleRef.current = fileHandle;
    statusRef.current = status;
    isBlockedRef.current = isBlocked;
  }, [data, config, fileHandle, status, isBlocked]);

  // --- CORE ACTIONS ---

  // 1. Update Baseline: Call this when we successfully LOAD/RESTORE data from external source
  const updateBaseline = useCallback((timestamp: number, overrideData?: any) => {
    console.log(`[AutoSave] Baseline updated to ${new Date(timestamp).toLocaleTimeString()}`);
    setLastSyncedTime(timestamp);
    // CRITICAL: Update snapshot immediately to prevent false DIRTY state after restore
    lastSnapshotRef.current = JSON.stringify(overrideData !== undefined ? overrideData : dataRef.current);
    setStatus('IDLE');
    savePendingRef.current = false;
    retryCountRef.current = 0;
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
  }, []);

  // 2. Perform Save Implementation
  const executeSave = useCallback(async (isRetry = false) => {
    const currentConfig = configRef.current;
    const currentHandle = fileHandleRef.current;
    const currentData = dataRef.current;

    // --- WRITE PROTECTION ---
    // If validation fails we MUST report it. Previously this silently returned which
    // left syncStatus stuck on DIRTY forever and the user had no way to know saves
    // were being skipped. Now we flip to ERROR and notify so the user can investigate
    // or trigger a manual retry after fixing the source data.
    if (validate && !validate(currentData)) {
        console.warn("[AutoSave] Data validation failed (Write Protection). Skipping save.");
        setStatus('ERROR');
        // v2.14.28 M3: read through the ref so a parent that swaps
        // onSaveError between renders never sees a stale callback fire.
        const cbValidate = onSaveErrorRef.current;
        if (cbValidate) {
            cbValidate('数据完整性校验失败，已暂停自动保存以防止覆盖。请检查记忆/世界书等是否异常后手动重试。');
        }
        return;
    }

    // Safety checks
    if (!currentConfig.localEnabled) return;
    if (statusRef.current === 'CONFLICT') return; // Never save over a conflict

    setStatus('SAVING');

    try {
      const timestamp = Date.now();
      // COMPREHENSIVE PAYLOAD: Ensure all memory systems are included
      const payload = {
        timestamp,
        version: "1.3",
        data: currentData // This contains messages, worldBook, coreMemory, anchors, notebook etc.
      };
      
      let localSuccess = false;

      // Local File System Save
      if (currentHandle) {
        const serializedPayload = JSON.stringify(payload, null, 2);

        if (isDesktopElectron() && typeof currentHandle === 'string') {
          const result = await writeDesktopBackupFile(currentHandle, serializedPayload);
          if (!result.success) {
            throw new Error(result.error || 'Failed to write desktop backup file.');
          }
        } else {
          // Browser (Chromium desktop) with FileSystemFileHandle from
          // showSaveFilePicker / showOpenFilePicker. F2B.3 removed the
          // separate isMobilePwa() string-path branch (was for
          // MobileRemoteFileBrowser).
          // @ts-ignore
          const writable = await currentHandle.createWritable();
          await writable.write(serializedPayload);
          await writable.close();
        }

        localSuccess = true;
      }

      // Success!
      console.log(`[AutoSave] Save complete. Local: ${localSuccess}`);
      setLastSyncedTime(timestamp);
      lastSnapshotRef.current = JSON.stringify(currentData);
      setStatus('SAVED');
      retryCountRef.current = 0; // Reset retries

      // Check Queue
      if (savePendingRef.current) {
          savePendingRef.current = false;
          console.log("[AutoSave] Pending save detected, triggering immediately...");
          executeSave(); // Recurse
      } else {
          // v2.14.28 M4: keep a handle to the SAVED→IDLE timer in a ref so
          // unmount can clear it. The previous fire-and-forget setTimeout
          // would call setStatus on an unmounted component during HMR or
          // when the user navigated away mid-save, producing the React
          // "update on unmounted" warning.
          if (idleRevertTimerRef.current) {
            clearTimeout(idleRevertTimerRef.current);
          }
          idleRevertTimerRef.current = setTimeout(() => {
              idleRevertTimerRef.current = null;
              if (statusRef.current === 'SAVED') setStatus('IDLE');
          }, 2000);
      }

    } catch (error: any) {
      console.error("[AutoSave] Error:", error);
      
      // RETRY LOGIC (Exponential Backoff)
      if (retryCountRef.current < 3) {
          retryCountRef.current += 1;
          const delay = [2000, 5000, 10000][retryCountRef.current - 1] || 10000;
          
          console.log(`[AutoSave] Retrying in ${delay}ms (Attempt ${retryCountRef.current}/3)...`);
          setStatus('SAVING'); // Keep spinner going
          
          retryTimerRef.current = setTimeout(() => {
              executeSave(true);
          }, delay);
      } else {
          setStatus('ERROR');
          // v2.14.28 M3: ref-read for fresh callback identity.
          const cbErr = onSaveErrorRef.current;
          if (cbErr) cbErr(error.message || "Timeout/Network Error");
      }
    }
  }, [lastSyncedTime, validate]); // Depend on lastSyncedTime and validate

  // 3. Trigger Wrapper
  const triggerSave = useCallback(() => {
      if (statusRef.current === 'SAVING') {
          savePendingRef.current = true;
          return;
      }
      if (statusRef.current === 'CONFLICT') return;
      executeSave();
  }, [executeSave]);

  // 4. Flush If Dirty (Smart Save on Close)
  const flushIfDirty = useCallback(() => {
      if (statusRef.current === 'DIRTY') {
          console.log("[AutoSave] Flush triggered (Closing with changes).");
          executeSave();
          return true;
      }
      return false;
  }, [executeSave]);

  // --- WATCHERS ---

  // Watch for Data Changes
  //
  // Note (P2 #48): we investigated adding a cheap structural "fingerprint"
  // pre-check so we could skip JSON.stringify on renders where the shape is
  // obviously unchanged. We backed it out because any fingerprint loose enough
  // to be cheap would miss in-place edits (e.g. retyping a middle message's
  // text with the same length), causing silent "DIRTY never fires" regressions.
  // The deep-stringify comparison stays as the source of truth.
  useEffect(() => {
    const currentSnapshot = JSON.stringify(data);
    if (currentSnapshot === lastSnapshotRef.current) return;

    if (status !== 'ERROR' && status !== 'CONFLICT' && status !== 'SAVING') {
        setStatus('DIRTY');
    }

    setLastChangeTime(Date.now());

    if (isBlocked) return;

    const timer = setTimeout(() => {
        triggerSave();
    }, 3000);

    return () => clearTimeout(timer);
  }, [data, isBlocked, triggerSave, status]);

  // --- WATCHDOG SYSTEM ---
  // v2.14.1 H.2: Capacitor (Android) has no fileHandle and the backup UI
  // hides the auto-save toggle entirely (F2A.4 — only manual ZIP export
  // / import is exposed). `executeSave()` ends up touching nothing
  // because `if (currentHandle)` is always false, but the watchdog used
  // to fire `triggerSave()` every 5 s anyway, polluting LogViewer with
  // "[AutoSave Watchdog] Force saving idle DIRTY state." every cycle.
  // Skip starting the interval on platforms where there's no save target,
  // so the watchdog stays inert (and silent) until/unless the user is on
  // a platform where auto-save can actually run.
  useEffect(() => {
      if (isCapacitorNative()) {
          return;
      }
      const interval = setInterval(() => {
          const now = Date.now();
          const timeSinceChange = now - lastChangeTime;

          // RULE 1: IDLE CLEANUP
          if (statusRef.current === 'DIRTY' && !isBlockedRef.current && timeSinceChange > 5000) {
              // Belt-and-suspenders: if the host process happens to have
              // dropped the file handle mid-session (e.g. user disconnected
              // the local file from Settings), skip the trigger entirely
              // instead of churning state.
              if (!fileHandleRef.current) return;
              console.log("[AutoSave Watchdog] Force saving idle DIRTY state.");
              triggerSave();
          }

          // RULE 2: STUCK 'SAVING' CLEANUP
          if (statusRef.current === 'SAVING' && timeSinceChange > 45000) {
              console.warn("[AutoSave Watchdog] Detected stuck SAVING state. Resetting to ERROR.");
              setStatus('ERROR');
              // v2.14.28 M3: ref-read for fresh callback identity.
              const cbWatchdog = onSaveErrorRef.current;
              if (cbWatchdog) cbWatchdog("Sync process hung (Watchdog reset).");
          }

      }, 5000); 

      return () => clearInterval(interval);
  // v2.14.28 M3: removed `onSaveError` from this dep list — the watchdog
  // closure now reads `onSaveErrorRef.current` so a parent re-creating the
  // callback no longer churns the interval (effectively pausing the
  // 5s watchdog every render).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastChangeTime, triggerSave]);

  // Watch for "Talking" End (Immediate Trigger - Falling Edge)
  const prevBlocked = useRef(isBlocked);
  useEffect(() => {
      if (prevBlocked.current && !isBlocked) {
          const currentSnapshot = JSON.stringify(data);
          if (currentSnapshot !== lastSnapshotRef.current || status === 'DIRTY') {
              console.log("[AutoSave] Block released (Turn End), triggering immediate save.");
              triggerSave();
          }
      }
      prevBlocked.current = isBlocked;
  }, [isBlocked, data, triggerSave, status]);

  // Manual Retry Handler
  const manualRetry = useCallback(() => {
      retryCountRef.current = 0;
      triggerSave();
  }, [triggerSave]);

  // v2.14.28 M4: clean up the SAVED→IDLE timer on unmount so React no
  // longer warns about state updates on unmounted components when HMR
  // re-renders the parent or the user navigates away mid-save.
  useEffect(() => {
    return () => {
      if (idleRevertTimerRef.current) {
        clearTimeout(idleRevertTimerRef.current);
        idleRevertTimerRef.current = null;
      }
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, []);

  // v2.14.28 M5: best-effort flush on browser/window close so the last
  // few seconds of edits still hit disk. The 3s debounce in the data
  // watcher means a quick exit after typing could leave the local
  // backup file slightly behind. `beforeunload` fires synchronously
  // on Electron close + browser tab close + Capacitor backgrounding,
  // and `flushIfDirty` is a fire-and-forget that schedules the save
  // immediately — it's allowed to lose to a hard kill, but soft exits
  // (the common case) will land on disk. The handler short-circuits
  // when we're not the desktop / browser path (mobile has no fileHandle).
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onBeforeUnload = () => {
      if (statusRef.current === 'DIRTY') {
        try { executeSave(); } catch { /* swallow — exit window is short */ }
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    // Some Electron builds dispatch a parallel custom event from
    // electron-main's `before-quit` IPC; subscribe defensively.
    window.addEventListener('app:before-quit-flush', onBeforeUnload as EventListener);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('app:before-quit-flush', onBeforeUnload as EventListener);
    };
  }, [executeSave]);

  return {
    syncStatus: status,
    triggerManualSave: triggerSave,
    flushIfDirty, 
    manualRetry,
    updateBaseline
  };
};
