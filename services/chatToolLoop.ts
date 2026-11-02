import type { ChatToolOutput, ChatToolRound, ProviderResponse } from './llmProviderService';

// A response can request several tools and then ask follow-up questions. Keep
// all results paired with their calls, with a finite per-turn execution budget.
export const runChatToolLoop = async (
  initial: ProviderResponse,
  execute: (call: any, signal: AbortSignal) => Promise<ChatToolOutput>,
  followUp: (rounds: ChatToolRound[], allowTools: boolean, signal: AbortSignal) => Promise<ProviderResponse>,
  options: { maxRounds?: number; maxCalls?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ProviderResponse> => {
  if (options.signal?.aborted) throw new Error('Tool query cancelled');
  if (!initial.functionCalls?.length) return initial;
  const maxRounds = options.maxRounds ?? 4;
  const maxCalls = options.maxCalls ?? 12;
  const controller = new AbortController();
  let cancel: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => { controller.abort(); reject(new Error('Tool query cancelled')); };
    options.signal?.addEventListener('abort', cancel, { once: true });
  });
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Tool query timed out before all evidence was available'));
    }, options.timeoutMs ?? 90_000);
  });
  const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, timeout, cancelled]);
  const rounds: ChatToolRound[] = [];
  let result = initial;
  let callsUsed = 0;
  try {
    for (let roundIndex = 0; roundIndex < maxRounds; roundIndex++) {
      const outputs: ChatToolOutput[] = [];
      for (const call of result.functionCalls || []) {
        if (callsUsed >= maxCalls) {
          outputs.push({ call, result: { success: false, error: 'Tool execution budget reached; this call was not executed' } });
          continue;
        }
        callsUsed++;
        try {
          outputs.push(await bounded(execute(call, controller.signal)));
        } catch (error) {
          if (controller.signal.aborted) throw error;
          outputs.push({ call, result: { success: false, error: error instanceof Error ? error.message : String(error) } });
        }
      }
      rounds.push({ model: result, outputs });
      const allowTools = roundIndex + 1 < maxRounds && callsUsed < maxCalls;
      result = await bounded(followUp(rounds, allowTools, controller.signal));
      if (!result.functionCalls?.length) return result;
      if (!allowTools) throw new Error('Tool query did not finish within the execution budget');
    }
    throw new Error('Tool query did not finish');
  } finally {
    clearTimeout(timer!);
    options.signal?.removeEventListener('abort', cancel!);
  }
};

export const toGeminiToolParts = (outputs: ChatToolOutput[]): any[] => outputs.flatMap(output => [
  { functionResponse: { id: output.call.id, name: output.call.name, response: output.result } },
  ...(output.image ? [{ inlineData: output.image }] : []),
]);
