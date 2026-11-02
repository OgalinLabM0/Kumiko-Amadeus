import { assertDataWritesAllowed, getDataRestoreVersion, subscribeDataRestore } from './dataRestoreGate';
import { assertMemoryAvailable, getMemoryGeneration, subscribeMemoryMaintenance } from './memoryMaintenanceGate';
import { beginForegroundActivity, endForegroundActivity, finishTaskRequest, reserveTaskRequest, type RequestTarget, type TaskContext } from './taskRuntime';

/** The caller supplies the exact frozen target and a revision check for that
 * target. This keeps concurrent tasks independent of mutable global context. */
export async function runTaskTransport<T>(
  context: TaskContext,
  target: RequestTarget,
  work: (signal: AbortSignal) => Promise<T>,
  assertConfigurationCurrent: () => void,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (context.signal?.aborted) abort();
  context.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.max(0, context.deadlineAt - Date.now()));
  const onChange = () => {
    try { assertConfigurationCurrent(); assertMemoryAvailable(context.memoryGeneration);
      if (getDataRestoreVersion() !== context.epoch) abort();
    } catch { abort(); }
  };
  const stopMemory = subscribeMemoryMaintenance(onChange);
  const stopRestore = subscribeDataRestore(onChange);
  if (typeof window !== 'undefined') {
    window.addEventListener('kumiko:model-config-changed', onChange);
    window.addEventListener('kumiko:preferences-updated', onChange);
    window.addEventListener('storage', onChange);
  }
  const check = () => {
    if (controller.signal.aborted || Date.now() >= context.deadlineAt) throw new DOMException('Task cancelled or expired', 'AbortError');
    assertDataWritesAllowed();
    if (getDataRestoreVersion() !== context.epoch) throw new Error('Data generation changed during task.');
    assertMemoryAvailable(context.memoryGeneration);
    assertConfigurationCurrent();
  };
  let attemptId: string | undefined;
  try {
    check();
    if (['text', 'chat', 'vision'].includes(target.operation)) {
      const revisions = context.modelRevisions || (context.modelRevisions = {});
      if (revisions[context.role] && revisions[context.role] !== target.configRevision) throw new Error('Model configuration changed during task.');
      revisions[context.role] = target.configRevision;
    }
    attemptId = await reserveTaskRequest(context, target);
    check();
    const result = await work(controller.signal);
    check();
    await finishTaskRequest(attemptId, 'succeeded');
    return result;
  } catch (error) {
    if (attemptId) await finishTaskRequest(attemptId, controller.signal.aborted ? 'cancelled' : 'failed');
    throw error;
  } finally {
    clearTimeout(timer);
    stopMemory(); stopRestore();
    if (typeof window !== 'undefined') {
      window.removeEventListener('kumiko:model-config-changed', onChange);
      window.removeEventListener('kumiko:preferences-updated', onChange);
      window.removeEventListener('storage', onChange);
    }
    context.signal?.removeEventListener('abort', abort);
  }
}

/** For explicit standalone UI actions that do not belong to an existing turn. */
export async function runStandaloneTransport<T>(target: RequestTarget, work: (signal: AbortSignal) => Promise<T>,
  assertConfigurationCurrent: () => void, signal?: AbortSignal): Promise<T> {
  const id = crypto.randomUUID();
  const context: TaskContext = { taskId: id, rootId: id, role: 'standalone', lane: 'foreground', deadlineAt: Date.now() + 180_000,
    signal, epoch: getDataRestoreVersion(), memoryGeneration: getMemoryGeneration(), modelRevisions: {}, consultedSources: [] };
  await beginForegroundActivity(context);
  try { return await runTaskTransport(context, target, work, assertConfigurationCurrent); }
  finally { await endForegroundActivity(context); }
}
