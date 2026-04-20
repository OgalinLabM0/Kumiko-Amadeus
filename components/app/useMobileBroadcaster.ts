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
import type { Message } from '../../types';

type BroadcastPayload =
  | { type: 'message:added'; message: SlimMessage }
  | { type: 'message:updated'; message: SlimMessage }
  | { type: 'message:deleted'; messageId: string }
  | { type: 'status:line'; text: string }
  | { type: 'status:emotion'; emotion: string }
  | { type: 'status:unread'; count: number };

interface SlimMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: number;
  imageId: string | null;
  imageCaption: string | null;
  isVoiceMessage: boolean;
  voiceFileId: string | null;
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
// passes like "mark all as read".
function messageVisiblyChanged(a: Message, b: Message): boolean {
  return (
    a.text !== b.text
    || a.role !== b.role
    || a.timestamp !== b.timestamp
    || a.imageId !== b.imageId
    || a.imageCaption !== b.imageCaption
    || !!a.isVoiceMessage !== !!b.isVoiceMessage
    || a.voiceFileId !== b.voiceFileId
  );
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

export function useMobileBroadcaster() {
  // Keep the previous snapshot so we can diff against it on each
  // subscribe callback. We don't use useRef<Message[]>([]) because we
  // want to capture the initial state (at mount) without firing events
  // for every existing message as if they were brand-new.
  const lastMessagesRef = useRef<Message[] | null>(null);
  const lastStatusLineRef = useRef<string | null>(null);
  const lastEmotionRef = useRef<string | null>(null);
  const lastUnreadRef = useRef<number | null>(null);

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
    });

    return () => {
      try { unsubscribe(); } catch { /* ignore */ }
    };
  }, []);
}
