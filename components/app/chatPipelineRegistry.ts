// components/app/chatPipelineRegistry.ts
//
// Phase 3 Part A — a module-level registry that lets the shared chat
// pipeline reach the App-tree refs and helper callbacks without every
// call site having to thread them through explicit parameters.
//
// Context: the desktop `executeSend` used to be the only chat entry
// point and it took an `ChatActionRefs` bundle + `ExecuteSendHelpers`
// tuple directly. Phase 1 introduced a parallel `sendUserMessageFromMobile`
// that is called from `useMobileApiProxy` over IPC — it runs inside
// the same desktop renderer, so the refs/helpers do exist at call
// time, but ipc-bridge has no natural way to hand them to the handler
// function.
//
// The registry solves this by letting App.tsx do a one-shot
// `registerChatPipeline({...refs, runVoicePipeline, deriveSummaryTopicLabel})`
// inside a `useEffect`. Both `executeSend` (desktop, still takes refs
// directly for backwards compat with handleSendAction) and
// `sendUserMessageFromMobile` (mobile) can pull the fully-wired bundle
// from here when they need it.
//
// The stored object exposes stable proxy callbacks for
// `runVoicePipeline` / `deriveSummaryTopicLabel` — these read through
// an internal `Ref` so that language-driven recreations in App.tsx
// don't require unregistering/re-registering on every render.

import type { MutableRefObject } from 'react';
import type {
  Message,
  TtsConfig,
  MemoryQuerySession,
} from '../../types';
import type { RunVoicePipelineFn } from '../../hooks/useVoicePipeline';

export type DeriveSummaryTopicLabelFn = (
  chunks: string[],
  segmentMessages: Message[],
  summaryText: string,
) => string;

export interface ChatPipelineRegistration {
  messagesRef: MutableRefObject<Message[]>;
  ttsConfigRef: MutableRefObject<TtsConfig>;
  generationIdRef: MutableRefObject<number>;
  pendingMessageIdsRef: MutableRefObject<Set<string>>;
  pendingImageMessageIdRef: MutableRefObject<string | null>;
  pendingImageRef: MutableRefObject<string | null>;
  pendingTextRef: MutableRefObject<string>;
  memoryQuerySessionRef: MutableRefObject<MemoryQuerySession | null>;
  recentRagDedupeKeysRef: MutableRefObject<string[]>;
  hasGoneToSleepRef: MutableRefObject<boolean>;
  sleepWarningTimestampRef: MutableRefObject<number | null>;
  sleepFarewellSentRef: MutableRefObject<boolean>;
  lateNightWakeRolledRef: MutableRefObject<boolean>;
  lateNightWakeResultRef: MutableRefObject<boolean>;
  lateNightWakeTimestampRef: MutableRefObject<number | null>;
  welcomeTriggeredRef: MutableRefObject<boolean>;
  summaryRunningRef: MutableRefObject<boolean>;
  summarySemanticEmbeddingCacheRef: MutableRefObject<Map<string, Float32Array>>;
  countdownIntervalRef: MutableRefObject<ReturnType<typeof setInterval> | null>;
  sendTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  preValidationActiveRef: MutableRefObject<boolean>;
  pendingSendRef: MutableRefObject<(() => void) | null>;
  inputRef: MutableRefObject<HTMLInputElement | null>;
  runVoicePipeline: RunVoicePipelineFn;
  deriveSummaryTopicLabel: DeriveSummaryTopicLabelFn;
}

let registration: ChatPipelineRegistration | null = null;

export function registerChatPipeline(r: ChatPipelineRegistration): void {
  registration = r;
}

export function unregisterChatPipeline(): void {
  registration = null;
}

export function getChatPipelineRegistration(): ChatPipelineRegistration {
  if (!registration) {
    throw new Error(
      '[CHAT-PIPELINE] Not registered. App.tsx must call registerChatPipeline() ' +
      'inside a useEffect before mobile/desktop chat can run.',
    );
  }
  return registration;
}

export function tryGetChatPipelineRegistration(): ChatPipelineRegistration | null {
  return registration;
}
