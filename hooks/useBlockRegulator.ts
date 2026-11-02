import { useEffect, useRef } from 'react';
import { useAppStore } from '../store';
import { tryGetChatPipelineRegistration } from '../components/app/chatPipelineRegistry';

// v2.14.29 Reactive — Block runtime expiry watcher.
//
// 1Hz polling loop that mirrors `useBusyRegulator`'s shape: ticks
// every second while the tab is visible, stops while hidden, runs an
// immediate catch-up tick on visibilitychange. Single owner of the
// expiry transitions:
//
//   blockRuntime  --(activeUntilMs reached)-->  fire block_release proactive
//   blockRuntime  --(proactive succeeded)   -->  clearBlock()
//   blockRuntime  --(N proactive failures)  -->  fall back to pendingApology
//                                                (so the user still gets the
//                                                "she came back" experience
//                                                next time they message)
//
// Why we need a regulator and not just a setTimeout from chatActions:
//   - Cross-quit recovery: a block that lapsed while the app was
//     fully closed gets re-fired at boot via `useInitialLoadBootstrap`.
//   - Visibility throttling: when the user backgrounds the tab we
//     stop the JS interval so we don't spin the CPU; on return we
//     run an immediate catch-up tick. Same pattern as useBusyRegulator.
//   - Android KumikoAlarmsPlugin alarm coexistence: when the WebView
//     returns to foreground after a process kill, the blockRuntime
//     row is hydrated from keyval and this regulator picks up where
//     it left off; the native alarm wakeup is a parallel safety net.
//
// Tuning constants — picked to match useBusyRegulator's existing
// retry behaviour so the failure modes feel symmetrical to the user
// (and to operations).
const POLL_INTERVAL_MS = 1000;
const MAX_PROACTIVE_RETRIES = 4;
const BACKOFF_BASE_MS = 30 * 1000;
const BACKOFF_MAX_MS = 10 * 60 * 1000;

interface RetryState {
  failureCount: number;
  nextRetryAt?: number;
}

export function useBlockRegulator(enabled: boolean): void {
  const blockRuntime = useAppStore(s => s.blockRuntime);
  // Fail-only retry tracking — kept in a ref so we don't re-render every
  // tick, and kept module-local-per-mount so a retry in flight can't
  // leak across enabled toggles.
  const retryRef = useRef<RetryState>({ failureCount: 0 });
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const resume = () => { if (active) void import('../services/blockRuntimeService')
      .then(service => service.resumePendingBlockSchedules()).catch(error => console.warn('[BlockRuntime] pending alarm retry failed', error)); };
    resume();
    const interval = setInterval(resume, 30_000);
    return () => { active = false; clearInterval(interval); };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;

    // Reset retry counters when blockRuntime identity changes (new
    // block started, or cleared and re-armed). The dependency below
    // keys on `startedAt` so React re-runs this effect.
    retryRef.current = { failureCount: 0 };

    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const now = Date.now();
        const runtime = useAppStore.getState().blockRuntime;
        if (!runtime) {
          retryRef.current = { failureCount: 0 };
          return;
        }

        const expired = runtime.activeUntilMs <= now;
        if (!expired) return;

        // Already fired but waiting on retry backoff? Honor it.
        const retry = retryRef.current;
        if (retry.nextRetryAt && now < retry.nextRetryAt) return;

        // Defer if any chat surface is already busy. We'll catch the
        // next tick. This avoids dropping the block_release on top of
        // an in-flight reply.
        const live = useAppStore.getState();
        if (live.isThinking || live.isTalking) return;

        const registration = tryGetChatPipelineRegistration();
        if (!registration) {
          // App tree hasn't mounted yet (or was unmounted). Try again
          // next tick — the registration is set on app start.
          return;
        }

        const fakeRefs = {
          welcomeTriggeredRef: registration.welcomeTriggeredRef,
          hasGoneToSleepRef: registration.hasGoneToSleepRef,
          sleepWarningTimestampRef: registration.sleepWarningTimestampRef,
          sleepFarewellSentRef: registration.sleepFarewellSentRef,
          lateNightWakeRolledRef: registration.lateNightWakeRolledRef,
          lateNightWakeResultRef: registration.lateNightWakeResultRef,
          lateNightWakeTimestampRef: registration.lateNightWakeTimestampRef,
        };

        const { triggerNativeProactiveMessage } = await import('../components/app/chatActions');
        const ok = await triggerNativeProactiveMessage(
          fakeRefs,
          0,
          runtime.reason || (live.language === 'en' ? 'cooled down' : '冷静'),
          'block_release',
        );

        if (ok) {
          // Block lifted successfully — clear runtime + Android alarm.
          const { clearBlock } = await import('../services/blockRuntimeService');
          await clearBlock();
          retryRef.current = { failureCount: 0 };
          return;
        }

        // Failed to fire (proactive trigger blocked because
        // welcomeTriggeredRef was already true, or LLM threw). Schedule
        // retry with exponential backoff, max N attempts. After max,
        // fall back to clearing the block (so the user can chat again)
        // and stash an apology so the next user message still gets a
        // catch-up acknowledgement.
        const nextCount = retry.failureCount + 1;
        if (nextCount >= MAX_PROACTIVE_RETRIES) {
          console.warn('[BlockRegulator] Proactive trigger failed', nextCount, 'times — degrading to silent clear.');
          const { clearBlock } = await import('../services/blockRuntimeService');
          await clearBlock();
          retryRef.current = { failureCount: 0 };
          return;
        }
        const backoff = Math.min(BACKOFF_BASE_MS * Math.pow(2, nextCount - 1), BACKOFF_MAX_MS);
        retryRef.current = {
          failureCount: nextCount,
          nextRetryAt: now + backoff,
        };
      } catch (e) {
        console.warn('[BlockRegulator] tick failed', e);
      } finally {
        inFlightRef.current = false;
      }
    };

    let intervalId: number | null = null;
    const start = () => {
      if (intervalId !== null) return;
      intervalId = window.setInterval(tick, POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else {
        // immediate catch-up so a block that expired while we were
        // backgrounded is processed on the very first frame back.
        tick();
        start();
      }
    };

    tick();
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
    // Re-run when the block runtime identity changes (start/clear/replace).
    // Using `startedAt` as the cheapest stable identifier.
  }, [enabled, blockRuntime?.startedAt]);
}
