
import { useState, useEffect, useRef, useCallback } from 'react';
import { BackupConfig } from '../types';
import { isDesktopElectron, writeDesktopBackupFile } from '../services/desktopBackupService';

export type SyncStatus = 'IDLE' | 'DIRTY' | 'SAVING' | 'SAVED' | 'ERROR' | 'CONFLICT';

interface UseAutoSaveProps {
  data: any; // The full state object to save
  config: BackupConfig;
  fileHandle: any; // FileSystemFileHandle or desktop file path
  isBlocked: boolean; // e.g. isTalking || isThinking
  onSaveError?: (msg: string) => void;
  validate?: (data: any) => boolean; // NEW: Validation callback
}

// Helper: Fetch with Timeout
const fetchWithTimeout = async (url: string, options: RequestInit = {}, timeout = 15000) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
};

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

    // --- NEW: WRITE PROTECTION ---
    // If validation fails, abort save silently (or with warning) to prevent corruption
    if (validate && !validate(currentData)) {
        console.warn("[AutoSave] Data validation failed (Write Protection). Skipping save.");
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
          // Revert to IDLE after a moment for visual feedback
          setTimeout(() => {
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
          if(onSaveError) onSaveError(error.message || "Timeout/Network Error");
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
  useEffect(() => {
    // 1. Deep compare to avoid unnecessary triggers
    const currentSnapshot = JSON.stringify(data);
    if (currentSnapshot === lastSnapshotRef.current) return;

    // 2. Data changed! Mark dirty.
    if (status !== 'ERROR' && status !== 'CONFLICT' && status !== 'SAVING') {
        setStatus('DIRTY');
    }
    
    setLastChangeTime(Date.now());

    // 3. Blocker Check
    if (isBlocked) return; 

    // 4. Debounce Timer (Standard Path: 3 seconds)
    const timer = setTimeout(() => {
        triggerSave();
    }, 3000);

    return () => clearTimeout(timer);
  }, [data, isBlocked, triggerSave, status]);

  // --- WATCHDOG SYSTEM ---
  useEffect(() => {
      const interval = setInterval(() => {
          const now = Date.now();
          const timeSinceChange = now - lastChangeTime;

          // RULE 1: IDLE CLEANUP
          if (statusRef.current === 'DIRTY' && !isBlockedRef.current && timeSinceChange > 5000) {
              console.log("[AutoSave Watchdog] Force saving idle DIRTY state.");
              triggerSave();
          }

          // RULE 2: STUCK 'SAVING' CLEANUP
          if (statusRef.current === 'SAVING' && timeSinceChange > 45000) {
              console.warn("[AutoSave Watchdog] Detected stuck SAVING state. Resetting to ERROR.");
              setStatus('ERROR');
              if(onSaveError) onSaveError("Sync process hung (Watchdog reset).");
          }

      }, 5000); 

      return () => clearInterval(interval);
  }, [lastChangeTime, triggerSave, onSaveError]);

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

  return {
    syncStatus: status,
    triggerManualSave: triggerSave,
    flushIfDirty, 
    manualRetry,
    updateBaseline
  };
};
