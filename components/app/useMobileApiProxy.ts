// components/app/useMobileApiProxy.ts
//
// Renderer-side listener for the `mobile-api-proxy` IPC channel. Phase 1
// runs a handful of narrow handlers here and reuses existing renderer
// services. Phase 2 will plug the real chat pipeline in the same hook so
// nothing in App.tsx needs to shift.
//
// Responsibilities:
//   - subscribe to `mobile-api-proxy` on mount, unsubscribe on unmount
//   - dispatch by channel, always reply via `mobile-api-proxy-reply` with
//     either `{ requestId, result }` or `{ requestId, error }`
//
// Handler contract notes:
//   - `ping`: smoke-test; returns `{ pong, ts, platform }`.
//   - `messages:recent`: returns up to `limit` (default 50) most recent
//     MessageEntity rows, chronological order. Images stay as ids — the
//     phone fetches them via the /media/images/:id endpoint.
//   - `chat`: Phase 1 minimum path. Persists the user's message to Dexie,
//     calls `callLLMRaw` with the current AIConfig, persists the model
//     reply, and returns both rows so the phone UI can render them
//     without needing a Dexie replica. All heavier Kumiko pipelines
//     (RAG, summary cycle, voice) stay out of scope until Phase 2.

import { useEffect } from 'react';
import { db, type MessageEntity } from '../../services/db';
import { callLLMRaw, getCurrentAIConfig } from '../../services/llmCore';

interface ProxyRequest {
  requestId: string;
  channel: string;
  args?: unknown;
}

interface ProxyReplySuccess {
  requestId: string;
  result: unknown;
}

interface ProxyReplyError {
  requestId: string;
  error: string;
}

function sendReply(payload: ProxyReplySuccess | ProxyReplyError) {
  try {
    window.electronAPI?.send?.('mobile-api-proxy-reply', payload);
  } catch (e) {
    console.warn('[MOBILE-PROXY] send reply failed:', e);
  }
}

function slimMessage(row: MessageEntity) {
  return {
    id: row.id,
    role: row.role,
    text: row.text,
    timestamp: row.timestamp,
    imageId: row.imageId || null,
    imageCaption: row.imageCaption || null,
    isVoiceMessage: !!row.isVoiceMessage,
    voiceFileId: row.voiceFileId || null,
  };
}

async function handlePing(args: unknown) {
  const echo = typeof args === 'object' && args !== null
    ? (args as Record<string, unknown>).echo
    : undefined;
  return { pong: true, ts: Date.now(), echo: echo ?? null };
}

async function handleMessagesRecent(args: unknown) {
  const limit = Math.max(
    1,
    Math.min(
      200,
      typeof (args as { limit?: unknown })?.limit === 'number'
        ? ((args as { limit: number }).limit | 0)
        : 50,
    ),
  );
  const rows = await db.messages.orderBy('timestamp').reverse().limit(limit).toArray();
  rows.reverse();
  return {
    messages: rows.map(slimMessage),
    count: rows.length,
    truncated: rows.length === limit,
  };
}

async function handleChat(args: unknown) {
  const payload = (args && typeof args === 'object') ? args as Record<string, unknown> : {};
  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  if (!message) {
    return { error: 'Empty message', code: 'E_EMPTY' };
  }

  const config = getCurrentAIConfig();
  const activeKey = config.activeKey === 'backup' ? config.apiKey_backup : config.apiKey_primary;
  if (!activeKey || !activeKey.trim()) {
    return { error: 'No API key configured on desktop', code: 'E_NO_KEY' };
  }

  // 1. Persist user message.
  const nowUser = Date.now();
  const userRow: MessageEntity = {
    id: `m-${nowUser}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    text: message,
    timestamp: nowUser,
  };
  try {
    await db.messages.put(userRow);
  } catch (e) {
    return { error: `DB write failed: ${(e as Error).message}`, code: 'E_DB' };
  }

  // 2. Call the LLM. Phase 1 uses the plain `callLLMRaw` helper with a
  // minimal system prompt — deliberately skipping the full Kumiko
  // pipeline (RAG context, worldBook, anchors) until Phase 2 lets the
  // phone drive real conversation turns. The goal here is only to prove
  // the end-to-end transport works.
  let replyText = '';
  try {
    replyText = await callLLMRaw(
      'You are responding to a user from their phone, connected to the desktop Kumiko·Amadeus over a private Tailscale tunnel. Reply concisely in the language the user wrote in.',
      message,
    );
  } catch (e) {
    return { error: `LLM call failed: ${(e as Error).message}`, code: 'E_LLM' };
  }
  const trimmedReply = (replyText || '').trim() || '…';

  // 3. Persist assistant reply.
  const nowModel = Date.now();
  const modelRow: MessageEntity = {
    id: `m-${nowModel}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'model',
    text: trimmedReply,
    timestamp: nowModel,
  };
  try {
    await db.messages.put(modelRow);
  } catch (e) {
    return { error: `DB write failed: ${(e as Error).message}`, code: 'E_DB' };
  }

  return {
    userMessage: slimMessage(userRow),
    modelMessage: slimMessage(modelRow),
  };
}

async function dispatch(channel: string, args: unknown) {
  switch (channel) {
    case 'ping': return handlePing(args);
    case 'messages:recent': return handleMessagesRecent(args);
    case 'chat': return handleChat(args);
    default: {
      const err: Error & { code?: string } = new Error(`Unknown channel: ${channel}`);
      err.code = 'E_CHANNEL';
      throw err;
    }
  }
}

export function useMobileApiProxy() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const api = window.electronAPI;
    if (!api || typeof api.on !== 'function' || typeof api.send !== 'function') {
      // PWA / web-fallback context: nothing to bridge. Mobile clients
      // talk directly to the desktop's renderer-hosted handlers over
      // HTTP, so this hook is a no-op there.
      return;
    }

    const handler = (_event: unknown, req: ProxyRequest) => {
      if (!req || typeof req.requestId !== 'string' || typeof req.channel !== 'string') return;
      Promise.resolve()
        .then(() => dispatch(req.channel, req.args))
        .then((result) => {
          sendReply({ requestId: req.requestId, result });
        })
        .catch((e) => {
          const message = (e && (e as Error).message) || 'Handler failed';
          sendReply({ requestId: req.requestId, error: message });
        });
    };

    api.on('mobile-api-proxy', handler);
    return () => {
      try { api.removeListener?.('mobile-api-proxy', handler); } catch { /* ignore */ }
    };
  }, []);
}
