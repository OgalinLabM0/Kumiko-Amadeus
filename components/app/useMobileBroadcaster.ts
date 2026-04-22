// components/app/useMobileBroadcaster.ts
//
// Phase 2 Part C: renderer → main → phone fan-out.
//
// Desktop Kumiko is the single source of truth for chat state. Any time
// something changes (new message appended, Kumiko's status line updates,
// unread count ticks), we emit a small JSON event through the electron
// `mobile-event-broadcast` IPC channel. The main-process `ws-broadcast`
// module relays it to every connected phone, which in turn updates its
// UI without having to poll.
//
// Why do this in a hook rather than a store middleware?
//   - We want to live-subscribe to the store AND to Dexie (the store is
//     fast path, Dexie is authoritative). Keeping the subscription
//     surface in a hook gives us React lifecycle to bail out cleanly on
//     unmount (mostly relevant for tests / hot reload).
//   - We want this to be a no-op on the PWA side (window.electronAPI is
//     absent). A hook is the natural place for that guard.
//
// Contract:
//   - All emitted event shapes MUST match `ws-broadcast.cjs` docs.
//   - Event type strings are stable; breaking changes require bumping
//     a version field (not needed as of Phase 2).
//   - Emitters are best-effort: a failed send() is logged and swallowed
//     because the phone will heal on next reconnect via /api/messages.

import { useEffect, useRef } from 'react';
import { useAppStore } from '../../store';
import type { Message, VoiceCallOverlayData } from '../../types';
import type { BusyFollowUp, PendingApology } from '../../store/slices/busySlice';

// Wire-safe projection of a BusyFollowUp. We drop the full
// `preparedTextParts` payload because phones never *play back* the
// prepared draft — that only happens on the desktop where the timed
// display pipeline lives. All the phone UI needs is the metadata to
// render the TaskPanel card (slot / status / countdown / unread count).
interface SlimBusyFollowUp {
  id: string;
  slotDescription: string;
  slotType: string;
  slotEndAtMs: number | null;
  prepareAt: number;
  displayAt: number;
  unreadCount: number;
  prepared: boolean;
  failureCount: number;
}

interface SlimPendingApologySource {
  slotDescription: string;
  slotType: string;
  reason: string;
  unreadCount: number;
}

interface SlimPendingApology {
  id: string;
  createdAt: number;
  latestAppendedAt: number;
  sources: SlimPendingApologySource[];
}

function slimBusyFollowUp(f: BusyFollowUp): SlimBusyFollowUp {
  return {
    id: f.id,
    slotDescription: f.slotDescription,
    slotType: f.slotType,
    slotEndAtMs: f.slotEndAtMs,
    prepareAt: f.prepareAt,
    displayAt: f.displayAt,
    unreadCount: f.unreadUserMessageIds.length,
    prepared: !!(f.preparedAt && f.preparedTextParts && f.preparedTextParts.length > 0),
    failureCount: f.failureCount,
  };
}

function slimPendingApology(a: PendingApology): SlimPendingApology {
  return {
    id: a.id,
    createdAt: a.createdAt,
    latestAppendedAt: a.latestAppendedAt,
    sources: a.sources.map(s => ({
      slotDescription: s.slotDescription,
      slotType: s.slotType,
      reason: s.reason,
      unreadCount: s.unreadUserMessageIds.length,
    })),
  };
}

// Wire shape for the call overlay — the live Zustand entry carries
// React closures (onAccept/onReject/onClose) that can't be serialized
// to JSON. We strip them and let the phone re-synthesize its own
// HTTP-posting callbacks on the receiving side. `ringtoneFileId` is
// pulled from ttsConfig at broadcast time so the phone doesn't have
// to round-trip a separate /api/ipc call before it can start ringing.
interface SlimCallState {
  reminderEvent: string;
  reminderText: string;
  emotion: string;
  ringtoneFileId: string | null;
  isConnecting: boolean;
  isPlayingVoice: boolean;
  isEnded: boolean;
  voiceFileId: string | null;
}

type BroadcastPayload =
  | { type: 'message:added'; message: SlimMessage }
  | { type: 'message:updated'; message: SlimMessage }
  | { type: 'message:deleted'; messageId: string }
  | { type: 'status:line'; text: string }
  | { type: 'status:emotion'; emotion: string }
  | { type: 'status:unread'; count: number }
  // Phase 3 Part D: one-way event streams that originate in the main
  // process and used to be renderer-only. Phone clients now receive
  // them too so mobile UI can live-reflect RAG rebuild progress, auto-
  // zip writes, app updater state, and SoVITS genie lifecycle without
  // polling.
  | { type: 'rag:rebuild:started'; job: unknown }
  | { type: 'rag:rebuild:progress'; job: unknown }
  | { type: 'rag:rebuild:done'; job: unknown }
  | { type: 'rag:rebuild:error'; job: unknown }
  | { type: 'backup:auto-zip'; status: unknown }
  | { type: 'update:state'; state: unknown }
  | { type: 'genie:state'; state: unknown }
  // Phase 5 Part D: incoming-call overlay mirror. The phone recreates
  // the same VoiceCallOverlay UI the PC is showing, with buttons that
  // HTTP-post back to /api/call/action to invoke the PC's closures.
  | { type: 'call:state'; state: SlimCallState }
  | { type: 'call:closed' }
  // Phase 6 Part B/C: desktop-authoritative config changed — every phone
  // re-pulls its own local copy via the bootstrap channels. Payload is
  // intentionally empty: the phone simply re-hydrates from the PC so we
  // don't have to keep wire shapes for AIConfig / backup config in sync.
  // `ai-config:changed` is emitted by `useMobileApiProxy.handleAIConfigUpdate`
  // (when a phone saves a config) and by `useMobileBroadcaster` (when the
  // desktop renderer mutates kumiko_ai_config). `backup:desktop-path-changed`
  // is fired when the desktop AuthScreen/SettingsPanel connects, creates or
  // disconnects a backup file.
  | { type: 'ai-config:changed' }
  | { type: 'backup:desktop-path-changed'; filePath: string | null; fileName: string | null }
  // Busy regulator state. The phone renders the TaskPanel "pending
  // auto-reply" card from these; it never triggers the actual AI
  // prepare/display pipeline (that is desktop-only).
  | { type: 'busy:followup:set'; followUp: SlimBusyFollowUp }
  | { type: 'busy:followup:cleared' }
  | { type: 'busy:apology:set'; apology: SlimPendingApology }
  | { type: 'busy:apology:cleared' };

interface SlimMessageQuote {
  id?: string;
  text: string;
  role: 'user' | 'model';
}

interface SlimGroundingSource {
  uri: string;
  title?: string;
}

interface SlimMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: number;
  imageId: string | null;
  imageCaption: string | null;
  isVoiceMessage: boolean;
  voiceFileId: string | null;
  // Fields below were previously dropped on the way to mobile, so the
  // PWA rendered emotion-less bubbles, no pin indicator, no reply
  // context, and no grounding footer even though the desktop UI had
  // all four. They're cheap scalars / tiny arrays, so shipping them
  // alongside the rest adds negligible WS payload.
  storedEmotion: string | null;
  isPinned: boolean;
  isHidden: boolean;
  quote: SlimMessageQuote | null;
  groundingSources: SlimGroundingSource[] | null;
}

function slimMessage(m: Message): SlimMessage {
  return {
    id: m.id,
    role: m.role,
    text: m.text,
    timestamp: m.timestamp,
    imageId: m.imageId || null,
    imageCaption: m.imageCaption || null,
    isVoiceMessage: !!m.isVoiceMessage,
    voiceFileId: m.voiceFileId || null,
    storedEmotion: typeof m.storedEmotion === 'string' && m.storedEmotion.length > 0
      ? m.storedEmotion as unknown as string
      : null,
    isPinned: !!m.isPinned,
    isHidden: !!m.isHidden,
    quote: m.quote && typeof m.quote.text === 'string' && (m.quote.role === 'user' || m.quote.role === 'model')
      ? { id: m.quote.id, text: m.quote.text, role: m.quote.role }
      : null,
    groundingSources: Array.isArray(m.groundingSources) && m.groundingSources.length > 0
      ? m.groundingSources
          .filter(src => src && typeof src.uri === 'string')
          .map(src => ({ uri: src.uri, title: typeof src.title === 'string' ? src.title : undefined }))
      : null,
  };
}

function slimCallState(
  call: VoiceCallOverlayData,
  ringtoneFileId: string | undefined,
): SlimCallState {
  return {
    reminderEvent: call.reminderEvent,
    reminderText: call.reminderText,
    emotion: call.emotion as unknown as string,
    ringtoneFileId: typeof ringtoneFileId === 'string' && ringtoneFileId.length > 0 ? ringtoneFileId : null,
    isConnecting: !!call.isConnecting,
    isPlayingVoice: !!call.isPlayingVoice,
    isEnded: !!call.isEnded,
    voiceFileId: typeof call.voiceFileId === 'string' && call.voiceFileId.length > 0 ? call.voiceFileId : null,
  };
}

function emit(payload: BroadcastPayload) {
  try {
    window.electronAPI?.send?.('mobile-event-broadcast', payload);
  } catch (e) {
    console.warn('[MOBILE-BROADCAST] send failed:', e);
  }
}

// Quick equality check for the fields a phone actually renders — we
// skip broadcasting when the only change is a non-user-visible flag
// like `isRead`. This keeps the phone's UI stable during bulk mutation
// passes like "mark all as read". Must stay in lockstep with the
// SlimMessage shape above so emotion / pin / quote / grounding
// updates on desktop reach phones in real time.
function messageVisiblyChanged(a: Message, b: Message): boolean {
  if (
    a.text !== b.text
    || a.role !== b.role
    || a.timestamp !== b.timestamp
    || a.imageId !== b.imageId
    || a.imageCaption !== b.imageCaption
    || !!a.isVoiceMessage !== !!b.isVoiceMessage
    || a.voiceFileId !== b.voiceFileId
    || !!a.isPinned !== !!b.isPinned
    || !!a.isHidden !== !!b.isHidden
    || (a.storedEmotion || '') !== (b.storedEmotion || '')
  ) {
    return true;
  }

  // Quote: compare text + role + id; ignore if both sides are empty.
  const aQuoteKey = a.quote ? `${a.quote.id || ''}|${a.quote.role}|${a.quote.text}` : '';
  const bQuoteKey = b.quote ? `${b.quote.id || ''}|${b.quote.role}|${b.quote.text}` : '';
  if (aQuoteKey !== bQuoteKey) return true;

  // Grounding sources: compare URI list order as a cheap shape proxy.
  const aSources = Array.isArray(a.groundingSources) ? a.groundingSources : [];
  const bSources = Array.isArray(b.groundingSources) ? b.groundingSources : [];
  if (aSources.length !== bSources.length) return true;
  for (let i = 0; i < aSources.length; i += 1) {
    if ((aSources[i]?.uri || '') !== (bSources[i]?.uri || '')) return true;
    if ((aSources[i]?.title || '') !== (bSources[i]?.title || '')) return true;
  }

  return false;
}

// Diff two sorted-by-timestamp message lists and produce the sequence of
// events that turns `prev` into `next`. We deliberately keep this
// O(n + m) instead of inner-loop comparing so a 50-item bulk import
// doesn't choke the UI thread.
function diffMessageLists(prev: Message[], next: Message[]): BroadcastPayload[] {
  const events: BroadcastPayload[] = [];
  const prevById = new Map<string, Message>();
  for (const m of prev) prevById.set(m.id, m);
  const nextIds = new Set<string>();
  for (const m of next) {
    nextIds.add(m.id);
    const before = prevById.get(m.id);
    if (!before) {
      events.push({ type: 'message:added', message: slimMessage(m) });
    } else if (messageVisiblyChanged(before, m)) {
      events.push({ type: 'message:updated', message: slimMessage(m) });
    }
  }
  for (const [id] of prevById) {
    if (!nextIds.has(id)) {
      events.push({ type: 'message:deleted', messageId: id });
    }
  }
  return events;
}

// Generic bridge: subscribe to a renderer-delivered IPC event and
// re-emit it to every connected phone under `forwardType`. Returns a
// cleanup that removes the underlying IPC listener on unmount.
//
// preload.cjs exposes `electronAPI.on()` as a direct passthrough of
// `ipcRenderer.on(channel, listener)`. Electron calls listeners with
// `(event: IpcRendererEvent, ...args)`, so the *real* payload is the
// second positional argument, not the first. Early versions of this
// helper treated arg[0] as the payload, then fed the IpcRendererEvent
// into `shape()`. Because `IpcRendererEvent` carries a native `sender`
// reference, the resulting broadcast object failed structured-clone at
// `ipcRenderer.send` time and we saw `[WARN][MOBILE-BROADCAST] send
// failed: Error: An object could not be cloned.` on every RAG / auto-
// zip / update / genie tick — even with no phones connected. Skipping
// the IpcRendererEvent fixes that at the source.
function bridgeIpcEvent<TPayload>(
  api: NonNullable<typeof window.electronAPI>,
  ipcChannel: string,
  forwardType: BroadcastPayload['type'],
  shape: (p: TPayload) => BroadcastPayload,
): () => void {
  const handler = (_event: unknown, payload?: TPayload) => {
    try {
      const event = shape(payload as TPayload);
      // Defensive: emission shape mismatch would poison the phone's
      // MobileEvent stream. Assert the forwardType matches the helper's
      // contract before pushing.
      if (event && event.type === forwardType) emit(event);
    } catch (e) {
      console.warn(`[MOBILE-BROADCAST] Failed to bridge ${ipcChannel}:`, e);
    }
  };
  try {
    api.on?.(ipcChannel, handler);
  } catch (e) {
    console.warn(`[MOBILE-BROADCAST] Failed to subscribe to ${ipcChannel}:`, e);
    return () => {};
  }
  return () => {
    try { api.removeListener?.(ipcChannel, handler); } catch { /* ignore */ }
  };
}

export function useMobileBroadcaster() {
  // Keep the previous snapshot so we can diff against it on each
  // subscribe callback. We don't use useRef<Message[]>([]) because we
  // want to capture the initial state (at mount) without firing events
  // for every existing message as if they were brand-new.
  const lastMessagesRef = useRef<Message[] | null>(null);
  const lastStatusLineRef = useRef<string | null>(null);
  const lastEmotionRef = useRef<string | null>(null);
  const lastUnreadRef = useRef<number | null>(null);
  // Phase 5 Part D: remember the last broadcast call snapshot so we
  // can distinguish "UI re-render but call unchanged" from a real
  // transition (ringing → connecting → playing → ended → closed).
  const lastCallSigRef = useRef<string | null>(null);
  // Phase 6 Part C5: mirror the desktop's connectedFileName to all phones
  // so when the user picks / disconnects a backup file at the PC,
  // phones update their "saving to …" indicator in real time.
  const lastBackupNameRef = useRef<string | null | undefined>(undefined);
  // Busy regulator mirrors. We signature-compare the JSON shape so we
  // only push deltas — the follow-up's prepareAt / displayAt are
  // static per follow-up, so most ticks emit nothing.
  const lastBusyFollowUpSigRef = useRef<string | null>(null);
  const lastPendingApologySigRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const api = window.electronAPI;
    if (!api || typeof api.send !== 'function') {
      // PWA / web context: nothing to broadcast. The phone PWA won't
      // have another phone listening to it, and on web the main process
      // doesn't exist at all.
      return;
    }

    // Capture starting state — we don't want the first tick to flood
    // the broadcaster with `message:added` for every message already
    // in Dexie.
    const state = useAppStore.getState();
    lastMessagesRef.current = state.messages.slice();
    lastStatusLineRef.current = state.statusText;
    lastEmotionRef.current = state.currentEmotion as unknown as string;
    // unreadCount isn't a single top-level field; the app uses
    // `messageAlerts` + `isMessageCenterOpen`. We derive a simple count.
    const initialUnread = state.messageAlerts?.length ?? 0;
    lastUnreadRef.current = initialUnread;
    lastBackupNameRef.current = state.connectedFileName ?? null;

    const unsubscribe = useAppStore.subscribe((s) => {
      // Messages diff
      const prevMsgs = lastMessagesRef.current;
      if (prevMsgs && s.messages !== prevMsgs) {
        const events = diffMessageLists(prevMsgs, s.messages);
        for (const ev of events) emit(ev);
        lastMessagesRef.current = s.messages;
      }
      // Status line
      if (s.statusText !== lastStatusLineRef.current) {
        lastStatusLineRef.current = s.statusText;
        emit({ type: 'status:line', text: s.statusText });
      }
      // Emotion
      const emotion = s.currentEmotion as unknown as string;
      if (emotion !== lastEmotionRef.current) {
        lastEmotionRef.current = emotion;
        emit({ type: 'status:emotion', emotion });
      }
      // Unread count (proxied through messageAlerts length).
      const unread = s.messageAlerts?.length ?? 0;
      if (unread !== lastUnreadRef.current) {
        lastUnreadRef.current = unread;
        emit({ type: 'status:unread', count: unread });
      }

      // Phase 6 Part C5: desktop's chosen backup file name fan-out. We send
      // `filePath: null` for the PC-side wire because the desktop renderer
      // only stores the basename in `connectedFileName`; the phone's
      // useMobileMessageSync merely echoes `fileName` into its own store.
      const connected = s.connectedFileName ?? null;
      if (connected !== lastBackupNameRef.current) {
        lastBackupNameRef.current = connected;
        emit({
          type: 'backup:desktop-path-changed',
          filePath: null,
          fileName: connected,
        });
      }

      // Phase 5 Part D: voice-call overlay mirror.
      //
      // voiceCallOverlayData transitions follow a tight ringing → connecting
      // → playing → ended → (cleared) loop inside chatActions. We signature-
      // compare the JSON-serializable fields against the last broadcast so
      // we never emit "same state repeatedly" (chatActions sets the same
      // object reference after prev?.isConnecting updates, but stored values
      // are unchanged).
      const call = s.voiceCallOverlayData;
      if (!call) {
        if (lastCallSigRef.current !== null) {
          lastCallSigRef.current = null;
          emit({ type: 'call:closed' });
        }
      } else {
        const slim = slimCallState(call, s.ttsConfig?.ringtoneFileId);
        const sig = JSON.stringify(slim);
        if (sig !== lastCallSigRef.current) {
          lastCallSigRef.current = sig;
          emit({ type: 'call:state', state: slim });
        }
      }

      // Busy regulator fan-out.
      const followUp = s.busyFollowUp;
      if (!followUp) {
        if (lastBusyFollowUpSigRef.current !== null) {
          lastBusyFollowUpSigRef.current = null;
          emit({ type: 'busy:followup:cleared' });
        }
      } else {
        const slim = slimBusyFollowUp(followUp);
        const sig = JSON.stringify(slim);
        if (sig !== lastBusyFollowUpSigRef.current) {
          lastBusyFollowUpSigRef.current = sig;
          emit({ type: 'busy:followup:set', followUp: slim });
        }
      }

      const apology = s.pendingApology;
      if (!apology || apology.sources.length === 0) {
        if (lastPendingApologySigRef.current !== null) {
          lastPendingApologySigRef.current = null;
          emit({ type: 'busy:apology:cleared' });
        }
      } else {
        const slim = slimPendingApology(apology);
        const sig = JSON.stringify(slim);
        if (sig !== lastPendingApologySigRef.current) {
          lastPendingApologySigRef.current = sig;
          emit({ type: 'busy:apology:set', apology: slim });
        }
      }
    });

    // ── Phase 3 Part D: background event streams ────────────────
    //
    // These are one-way main → renderer events that the renderer has
    // always listened for. We add a thin IPC → WebSocket bridge so
    // phone clients receive the same stream without a per-event IPC
    // channel whitelist. The renderer still gets its own copy of the
    // event (ipcRenderer.on is additive), so desktop UI behavior is
    // unchanged.
    const bridgeCleanups: Array<() => void> = [];
    bridgeCleanups.push(bridgeIpcEvent<{ job?: unknown } | undefined>(
      api, 'rag:rebuild:started', 'rag:rebuild:started',
      (p) => ({ type: 'rag:rebuild:started', job: p?.job ?? p ?? null }),
    ));
    bridgeCleanups.push(bridgeIpcEvent<{ job?: unknown } | undefined>(
      api, 'rag:rebuild:progress', 'rag:rebuild:progress',
      (p) => ({ type: 'rag:rebuild:progress', job: p?.job ?? p ?? null }),
    ));
    bridgeCleanups.push(bridgeIpcEvent<{ job?: unknown } | undefined>(
      api, 'rag:rebuild:done', 'rag:rebuild:done',
      (p) => ({ type: 'rag:rebuild:done', job: p?.job ?? p ?? null }),
    ));
    bridgeCleanups.push(bridgeIpcEvent<{ job?: unknown } | undefined>(
      api, 'rag:rebuild:error', 'rag:rebuild:error',
      (p) => ({ type: 'rag:rebuild:error', job: p?.job ?? p ?? null }),
    ));
    bridgeCleanups.push(bridgeIpcEvent<unknown>(
      api, 'app:auto-zip-progress', 'backup:auto-zip',
      (p) => ({ type: 'backup:auto-zip', status: p ?? null }),
    ));
    bridgeCleanups.push(bridgeIpcEvent<unknown>(
      api, 'app:update-status', 'update:state',
      (p) => ({ type: 'update:state', state: p ?? null }),
    ));
    bridgeCleanups.push(bridgeIpcEvent<unknown>(
      api, 'genie:status-changed', 'genie:state',
      (p) => ({ type: 'genie:state', state: p ?? null }),
    ));

    return () => {
      try { unsubscribe(); } catch { /* ignore */ }
      for (const cleanup of bridgeCleanups) {
        try { cleanup(); } catch { /* ignore */ }
      }
    };
  }, []);
}
