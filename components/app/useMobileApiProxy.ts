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
import { getCurrentAIConfig } from '../../services/llmCore';
import { sendUserMessageFromMobile } from './chatActions';
import { useAppStore } from '../../store';
import {
  validateAIConnection,
  validateModels,
  validateSearchCapability,
} from '../../services/aiValidation';
import type { AIConfig } from '../../types';

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

// Phase 2 Part D: handoff to the real pipeline. sendUserMessageFromMobile
// persists the user row, runs the full sendMessageToGemini (worldBook /
// coreMemory / RAG / anchors / kumikoNotebook), persists every part the
// model returned, and mutates the zustand store — which the Part C
// WebSocket broadcaster then fans out to the phone for live updates.
//
// The HTTP reply retains the Phase 1 shape ({userMessage, modelMessage})
// for backwards compatibility with the current PWA UI. When the model
// returns multiple textParts we concatenate them into a single reply
// row echoed back synchronously, but each part is persisted as its
// own message — the broadcaster and the next `messages:recent` call
// will see all of them individually.
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

  const imageId = typeof payload.imageId === 'string' ? payload.imageId : undefined;
  const voiceFileId = typeof payload.voiceFileId === 'string' ? payload.voiceFileId : undefined;

  const result = await sendUserMessageFromMobile(message, { imageId, voiceFileId });
  if (result.error) {
    return { error: result.error, code: result.code ?? 'E_CHAT' };
  }

  // Re-read the freshly written rows so the HTTP reply carries exactly
  // the same shape as Phase 1 (and exactly the same slim projection as
  // every other messages:* handler). We could synthesize the reply from
  // the result IDs alone, but round-tripping through Dexie means any
  // downstream hydration (e.g. emotion / grounding) shows up in the
  // phone's first render without waiting on the WS broadcast.
  const userRow = await db.messages.get(result.userMessageId);
  const modelRows: MessageEntity[] = [];
  for (const id of result.modelMessageIds) {
    const row = await db.messages.get(id);
    if (row) modelRows.push(row);
  }

  if (!userRow || modelRows.length === 0) {
    // Shouldn't happen unless Dexie was cleared mid-turn; fall back to
    // an explicit error so the phone can surface something meaningful.
    return { error: 'Chat completed but messages missing from DB', code: 'E_CHAT_STATE' };
  }

  return {
    userMessage: slimMessage(userRow),
    // Keep legacy single-message shape for older PWA builds. When the
    // model sent multiple parts we expose the first (the rest arrive
    // via the WS broadcaster), and also ship the full list for new
    // clients that know how to consume it.
    modelMessage: slimMessage(modelRows[0]),
    modelMessages: modelRows.map(slimMessage),
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

async function handleRingtoneSave(args: unknown) {
  const payload = argsAsObject(args);
  const ext = typeof payload.ext === 'string' ? payload.ext : '';
  const bufferB64 = typeof payload.bufferB64 === 'string' ? payload.bufferB64 : '';
  const originalName = typeof payload.originalName === 'string' ? payload.originalName : '';
  if (!ext || !bufferB64) {
    return { success: false, error: 'Missing ext/bufferB64' };
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(bufferB64);
  } catch (e) {
    return { success: false, error: `Invalid base64: ${(e as Error).message}` };
  }
  return invokeElectron('ringtone:save', {
    buffer: bytes,
    ext,
    originalName: originalName || undefined,
  });
}

// ── Phase 4 Part E hydration handlers ─────────────────────────────
//
// The phone renders the full <App /> now, which reads its initial state
// from local Dexie + localStorage. Both of those are per-origin, so the
// phone starts empty. These two handlers let the phone pull the PC's
// state in one round-trip on boot:
//
//   bootstrap:ai-config → PC's `kumiko_ai_config` localStorage payload,
//     so the phone's `getCurrentAIConfig()` matches the PC's model +
//     provider + API key choices. The key is synced intentionally so
//     that any UI that inspects the config (e.g. SettingsPanel) renders
//     the same rows on both sides; actual LLM calls still run on PC
//     because sendUserMessageFromMobile routes chat through the PC.
//
//   bootstrap:snapshot → the minimum Dexie slice useInitialLoadBootstrap
//     needs: all `messages` rows, the kumikoDiary / dailyFragments /
//     psycheState tables, and every `keyval` row the boot path reads
//     (language, location, core memory, reminders, etc.). Vectors and
//     images tables are explicitly excluded — they're enormous and the
//     phone doesn't need them locally: RAG runs on PC and images stream
//     via /media/images/:id.
async function handleBootstrapAiConfig() {
  try {
    const raw = localStorage.getItem('kumiko_ai_config');
    return { ok: true, config: raw };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function handleBootstrapSnapshot() {
  try {
    const [messages, kumikoDiary, dailyFragments, psycheStateRows, keyvalRows] = await Promise.all([
      db.messages.orderBy('timestamp').toArray(),
      db.kumikoDiary.orderBy('date').toArray(),
      db.dailyFragments.orderBy('timestamp').toArray(),
      db.psycheState.toArray(),
      db.keyval.toArray(),
    ]);
    return {
      ok: true,
      snapshot: {
        messages,
        kumikoDiary,
        dailyFragments,
        psycheState: psycheStateRows,
        keyval: keyvalRows,
      },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── Passthrough to existing Electron IPC ─────────────────────────

// Channels that accept args as-is and whose return shape is already
// phone-friendly JSON. Adding one here requires the matching entry in
// electron/server/ipc-bridge.cjs's ALLOWED_CHANNELS and also that the
// preload already whitelists the channel in its `invoke` array.
//
// Kept in sync with ipc-bridge.cjs's ALLOWED_CHANNELS. Binary-write
// channels (images:save, voice:save, ringtone:save) are handled in
// dedicated helpers above so they can decode base64 before forwarding.
const PASSTHROUGH_CHANNELS = new Set<string>([
  // Weather + holiday lookups
  'app:get-weather',
  'app:get-historical-weather',
  'app:get-japan-holidays',
  // App-wide status / config
  'app:get-data-directory-info',
  'app:get-auto-zip-backup',
  'app:set-auto-zip-backup',
  // Mobile session introspection (phone reads its own state)
  'mobile-access:get-state',
  // Image management
  'images:list',
  'images:delete',
  'images:get-storage-info',
  // Voice file management
  'voice:list',
  'voice:delete',
  'voice:get-storage-info',
  // Ringtone management (save routed through handleRingtoneSave)
  'ringtone:delete',
  'ringtone:get-info',
  // Backup passthroughs (dialog-free variants only)
  'backup:parse-import-file',
  'backup:build-zip-from-payload',
  // GPT-SoVITS (genie) lifecycle. Phone passes manual paths to
  // genie:test-sovits-python; native dialog pickers are intentionally
  // PC-only and excluded from the whitelist above.
  'genie:status',
  'genie:start',
  'genie:stop',
  'genie:test-sovits-python',
  // RAG maintenance + inspection
  'rag:search',
  'rag:get-messages',
  'rag:get-all',
  'rag:sync-messages',
  'rag:stats',
  'rag:status',
  'rag:rebuild:start',
  'rag:rebuild:status',
  'rag:embed',
  'rag:expand-context',
  'rag:save',
  'rag:restore',
  'rag:clear-all',
  'rag:clear-message-vectors',
  // Phase 6 Part C: mobile remote file browser + desktop backup I/O.
  // Every handler lives in main (electron-main.cjs); the renderer here
  // is just a forwarder. Root mutation channels are deliberately out of
  // the phone's HTTP allowlist — they exist on PASSTHROUGH only so the
  // desktop's SettingsPanel > MobileBrowseRootSection can hit them
  // directly via electronAPI.invoke.
  'fs:get-mobile-browse-root',
  'fs:list-directory',
  'fs:get-shortcuts',
  'fs:check-path-exists',
  'backup:read-desktop-file',
  'backup:write-desktop-file',
  'backup:set-desktop-backup-path',
  'backup:disconnect-desktop-file',
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

// Phase 6 Part B: AIConfigScreen on mobile proxies validate + save
// through these. The phone's localStorage is ultimately re-synced from
// bootstrap:ai-config (fired by the ai-config:changed broadcast below),
// so the desktop remains the sole authority for API keys + provider
// choices. Validation runs on PC so the Gemini / OpenAI / etc. network
// call leaves only the desktop's IP, not the phone's.
async function handleAIConfigValidate(args: unknown): Promise<boolean> {
  if (!args || typeof args !== 'object') return false;
  return validateAIConnection(args as AIConfig);
}

async function handleAIConfigValidateModels(args: unknown) {
  if (!args || typeof args !== 'object') {
    return { main: false, summary: false, vision: false };
  }
  return validateModels(args as AIConfig);
}

async function handleAIConfigValidateSearch(args: unknown) {
  if (!args || typeof args !== 'object') {
    return { success: false, message: 'invalid_config' };
  }
  return validateSearchCapability(args as AIConfig);
}

async function handleAIConfigUpdate(args: unknown): Promise<{ ok: boolean; error?: string }> {
  if (!args || typeof args !== 'object') {
    return { ok: false, error: 'invalid_config' };
  }
  try {
    localStorage.setItem('kumiko_ai_config', JSON.stringify(args));
    // Fan-out to every connected phone so they re-hydrate their
    // localStorage from bootstrap:ai-config. useMobileMessageSync listens
    // for the resulting `ai-config:changed` WS event.
    try {
      window.electronAPI?.send?.('mobile-event-broadcast', { type: 'ai-config:changed' });
    } catch (e) {
      console.warn('[MOBILE-PROXY] ai-config:changed broadcast failed:', e);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// Phase 5 Part D: invoke the currently-active VoiceCallOverlay's
// closure from the mobile side. The phone sees the same ringing
// overlay via the call:state WS broadcast (useMobileBroadcaster) and
// POSTs {action} back through /api/ipc/call:action when the user taps
// accept/reject/close. We resolve against the live Zustand state so
// stale payloads for a call that already closed become no-ops
// instead of resurrecting a dead promise.
function handleCallAction(args: unknown): { ok: boolean; reason?: string } {
  const raw = (args as { action?: unknown })?.action;
  const action = typeof raw === 'string' ? raw : '';
  if (action !== 'accept' && action !== 'reject' && action !== 'close') {
    return { ok: false, reason: 'invalid_action' };
  }
  const call = useAppStore.getState().voiceCallOverlayData;
  if (!call) {
    return { ok: false, reason: 'no_active_call' };
  }
  try {
    if (action === 'accept') call.onAccept();
    else if (action === 'reject') call.onReject();
    else if (action === 'close') (call.onClose || (() => useAppStore.getState().setVoiceCallOverlayData(null)))();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message || 'callback_threw' };
  }
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
    case 'ringtone:save': return handleRingtoneSave(args);
    case 'bootstrap:ai-config': return handleBootstrapAiConfig();
    case 'bootstrap:snapshot': return handleBootstrapSnapshot();
    case 'call:action': return handleCallAction(args);
    case 'ai-config:validate-from-mobile': return handleAIConfigValidate(args);
    case 'ai-config:validate-models-from-mobile': return handleAIConfigValidateModels(args);
    case 'ai-config:validate-search-from-mobile': return handleAIConfigValidateSearch(args);
    case 'ai-config:update-from-mobile': return handleAIConfigUpdate(args);
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
