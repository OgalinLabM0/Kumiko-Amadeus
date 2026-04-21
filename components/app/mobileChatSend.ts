// components/app/mobileChatSend.ts
//
// Phase 4 Part E: routes a phone-originated chat send through the PC.
//
// When App.tsx is rendered inside the mobile PWA, `handleSendAction`
// would otherwise run the full desktop chat pipeline *on the phone*.
// That fails for two reasons:
//   1. LLM calls would go out from the phone using whatever API config
//      the phone has. We intentionally keep API keys only on the PC
//      (the PWA mirrors the config read-only via bootstrap:ai-config).
//   2. The desktop pipeline writes to `messagesRef`, triggers lifestream
//      regeneration, reminder parsing, summary ticks, etc., all of which
//      must happen exactly once per turn and must run next to the Dexie
//      that the broadcaster reads from. Running them on the phone as
//      well would produce a second independent chat stream.
//
// Instead, the phone POSTs to /api/ipc/chat. The server dispatches that
// to `useMobileApiProxy.handleChat` (running on the PC renderer), which
// calls `sendUserMessageFromMobile` — the same one MobilePhase1App used
// in Phase 2. The PC runs the full pipeline, writes messages to Dexie
// + Zustand, and the broadcaster shoves `message:added` events out over
// WebSocket. The phone's `useMobileMessageSync` hook applies them to
// the phone's Zustand store so the chat feed updates in place.
//
// This file deliberately stays small and side-effect-free beyond the
// HTTP call — all UI state mutations (input clearing, listening flag)
// are done by the caller in App.tsx so they match the desktop flow's
// visual cadence.

import { httpInvoke, HttpApiError } from '../../services/httpApi';

export interface MobileChatSendPayload {
  text: string;
  imageId?: string;
  voiceFileId?: string;
}

interface SlimMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: number;
  imageId: string | null;
  imageCaption: string | null;
  isVoiceMessage?: boolean;
  voiceFileId?: string | null;
}

export interface MobileChatSendResult {
  ok: boolean;
  userMessage?: SlimMessage;
  modelMessage?: SlimMessage;
  modelMessages?: SlimMessage[];
  error?: string;
  code?: string;
  // Set when the HTTP session cookie expired and the caller should
  // redirect back to the pairing gate.
  unauthenticated?: boolean;
}

export async function sendChatFromMobile(
  payload: MobileChatSendPayload,
): Promise<MobileChatSendResult> {
  const text = payload.text.trim();
  if (!text && !payload.imageId && !payload.voiceFileId) {
    return { ok: false, error: 'empty_message' };
  }
  try {
    // The server-side handleChat accepts `message` as the primary field
    // and `imageId` / `voiceFileId` as optional attachments. Voice
    // payloads have already been uploaded via /api/ipc/voice:save (see
    // services/voiceFileService.ts mobile branch) and only the id rides
    // this call.
    const result = await httpInvoke<{
      userMessage?: SlimMessage;
      modelMessage?: SlimMessage;
      modelMessages?: SlimMessage[];
      error?: string;
      code?: string;
    }>('chat', {
      message: text,
      imageId: payload.imageId,
      voiceFileId: payload.voiceFileId,
    });
    if (result.error) {
      return { ok: false, error: result.error, code: result.code };
    }
    return {
      ok: true,
      userMessage: result.userMessage,
      modelMessage: result.modelMessage,
      modelMessages: result.modelMessages,
    };
  } catch (e) {
    if (e instanceof HttpApiError && e.status === 401) {
      return { ok: false, error: 'session_expired', unauthenticated: true };
    }
    return { ok: false, error: (e as Error).message || 'network_error' };
  }
}
