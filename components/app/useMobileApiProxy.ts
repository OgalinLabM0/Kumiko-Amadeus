// components/app/useMobileApiProxy.ts
//
// Renderer-side listener for the `mobile-api-proxy` IPC channel. Phase 1
// ran three narrow handlers; Phase 2 broadens to ~20 channels covering
// every phone-safe capability currently wired through `preload.cjs`.
//
// Handler dispatch falls in three buckets:
//
//   1. Dexie-backed synthetic ('ping', 'chat', 'messages:*'):
//      fully implemented in this file against services/db. These don't
//      correspond to any preload invoke channel; Phase 1 introduced
//      them specifically for the mobile bridge.
//
//   2. Binary-write passthrough ('images:save', 'voice:save'):
//      accept base64 from the phone, decode to Uint8Array, then forward
//      to the existing `window.electronAPI.invoke(channel, ...)` which
//      expects a byte buffer. Without the decode step, JSON-embedded
//      number arrays would work too but balloon payload size ~4x.
//
//   3. Pure passthrough (everything else — weather, listing, RAG):
//      forward args unchanged to `window.electronAPI.invoke(channel, ...)`.
//      These don't touch Dexie directly so we keep them dumb.
//
// All handlers must reply exactly once. Silent handlers trip the 60s
// ipc-bridge timeout and surface as HTTP 504 on the phone, which is
// intentional — it keeps the bridge self-diagnosing.

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

// Decode a base64 string to a Uint8Array inside the renderer. We prefer
// the built-in `atob` over importing a heavier library so the bundle
// size stays unchanged. URL-safe base64 is handled by normalising to
// standard alphabet + padding before decoding.
function base64ToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const binary = atob(normalized + padding);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function argsAsObject(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
}

// ── Synthetic Dexie handlers ──────────────────────────────────────

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

// Load messages strictly older than `beforeTimestamp`, up to `limit`
// rows. Used by the phone UI's "pull to load older" affordance.
async function handleMessagesLoadOlder(args: unknown) {
  const payload = argsAsObject(args);
  const beforeTs = typeof payload.beforeTimestamp === 'number'
    ? (payload.beforeTimestamp as number)
    : Number.POSITIVE_INFINITY;
  const limit = Math.max(
    1,
    Math.min(200, typeof payload.limit === 'number' ? (payload.limit as number) | 0 : 50),
  );
  const rows = await db.messages
    .where('timestamp')
    .below(beforeTs)
    .reverse()
    .limit(limit)
    .toArray();
  rows.reverse();
  return {
    messages: rows.map(slimMessage),
    count: rows.length,
    hasMore: rows.length === limit,
  };
}

// Full-text scan. `text` column isn't indexed in Dexie so this is a
// filter pass; fine for phone-scale latency tolerance since typical
// users have <50k rows. If that ever stops being true we'd add a
// search index column.
async function handleMessagesSearch(args: unknown) {
  const payload = argsAsObject(args);
  const raw = typeof payload.query === 'string' ? payload.query.trim() : '';
  if (!raw) return { messages: [], count: 0, query: '' };
  const needle = raw.toLowerCase();
  const limit = Math.max(
    1,
    Math.min(200, typeof payload.limit === 'number' ? (payload.limit as number) | 0 : 50),
  );
  // Walk newest-first so the phone sees the freshest matches first and
  // can early-terminate if it only cares about the top N.
  const matched: MessageEntity[] = [];
  await db.messages
    .orderBy('timestamp')
    .reverse()
    .until(() => matched.length >= limit)
    .each((row) => {
      if (row && typeof row.text === 'string' && row.text.toLowerCase().includes(needle)) {
        matched.push(row);
      }
    });
  return {
    messages: matched.map(slimMessage),
    count: matched.length,
    query: raw,
    truncated: matched.length === limit,
  };
}

async function handleChat(args: unknown) {
  const payload = argsAsObject(args);
  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  if (!message) {
    return { error: 'Empty message', code: 'E_EMPTY' };
  }

  const config = getCurrentAIConfig();
  const activeKey = config.activeKey === 'backup' ? config.apiKey_backup : config.apiKey_primary;
  if (!activeKey || !activeKey.trim()) {
    return { error: 'No API key configured on desktop', code: 'E_NO_KEY' };
  }

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

  // Phase 1 fallback: plain `callLLMRaw` with a minimal system prompt.
  // Phase D (still TODO as of this writing) will swap this for the real
  // sendMessageToGemini pipeline so RAG / worldBook / anchors apply.
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

// ── Binary-write handlers ─────────────────────────────────────────

async function handleImagesSave(args: unknown) {
  const payload = argsAsObject(args);
  const imageId = typeof payload.imageId === 'string' ? payload.imageId : '';
  const ext = typeof payload.ext === 'string' ? payload.ext : '';
  const bufferB64 = typeof payload.bufferB64 === 'string' ? payload.bufferB64 : '';
  if (!imageId || !ext || !bufferB64) {
    return { success: false, error: 'Missing imageId/ext/bufferB64' };
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(bufferB64);
  } catch (e) {
    return { success: false, error: `Invalid base64: ${(e as Error).message}` };
  }
  return invokeElectron('images:save', { imageId, ext, buffer: bytes });
}

async function handleVoiceSave(args: unknown) {
  const payload = argsAsObject(args);
  const messageId = typeof payload.messageId === 'string' ? payload.messageId : '';
  const bufferB64 = typeof payload.bufferB64 === 'string' ? payload.bufferB64 : '';
  if (!messageId || !bufferB64) {
    return { success: false, error: 'Missing messageId/bufferB64' };
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(bufferB64);
  } catch (e) {
    return { success: false, error: `Invalid base64: ${(e as Error).message}` };
  }
  return invokeElectron('voice:save', { messageId, buffer: bytes });
}

// ── Passthrough to existing Electron IPC ─────────────────────────

// Channels that accept args as-is and whose return shape is already
// phone-friendly JSON. Adding one here requires the matching entry in
// electron/server/ipc-bridge.cjs's ALLOWED_CHANNELS and also that the
// preload already whitelists the channel in its `invoke` array.
const PASSTHROUGH_CHANNELS = new Set<string>([
  'app:get-weather',
  'app:get-historical-weather',
  'app:get-japan-holidays',
  'images:list',
  'images:delete',
  'voice:list',
  'voice:delete',
  'rag:search',
  'rag:get-messages',
  'rag:sync-messages',
  'rag:stats',
  'rag:status',
  'rag:rebuild:status',
]);

async function invokeElectron(channel: string, args: unknown): Promise<unknown> {
  const api = window.electronAPI;
  if (!api || typeof api.invoke !== 'function') {
    const err: Error & { code?: string } = new Error('electronAPI.invoke not available');
    err.code = 'E_NO_ELECTRON';
    throw err;
  }
  return api.invoke(channel, args);
}

async function dispatch(channel: string, args: unknown) {
  switch (channel) {
    case 'ping': return handlePing(args);
    case 'messages:recent': return handleMessagesRecent(args);
    case 'messages:load-older': return handleMessagesLoadOlder(args);
    case 'messages:search': return handleMessagesSearch(args);
    case 'chat': return handleChat(args);
    case 'images:save': return handleImagesSave(args);
    case 'voice:save': return handleVoiceSave(args);
    default: {
      if (PASSTHROUGH_CHANNELS.has(channel)) {
        return invokeElectron(channel, args);
      }
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
