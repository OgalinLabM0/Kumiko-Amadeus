// components/app/useMobileMessageSync.ts
//
// Phase 4 Part E: the mobile-side counterpart to useMobileBroadcaster.
//
// The PC renderer publishes a fan-out of `message:*` / `status:*` events
// through the Fastify WebSocket bridge any time its Zustand store or
// Dexie mutates (see useMobileBroadcaster for the producer side). This
// hook is the consumer: on mobile PWA boot it opens the WS stream, then
// translates each incoming event into a mutation of the phone's own
// Zustand store + local Dexie so <App /> renders the PC's live state.
//
// What this hook owns:
//   - message:added / message:updated / message:deleted → `messages`
//     slice + `db.messages`. We keep local Dexie in sync so a cold
//     reload (without a fresh bootstrap:snapshot round-trip) still has
//     the latest messages until the phone's sessionStorage hydration
//     flag expires.
//   - status:line → `statusText` slice (the "Kumiko is typing…" line
//     shown under the avatar).
//   - status:emotion → `currentEmotion` slice (drives avatar mood).
//   - status:unread → reserved; we consume and discard here because
//     the phone derives unread from its own selection state and we
//     don't want PC-side mark-as-read to pre-dismiss alerts the phone
//     user hasn't seen yet.
//
// Not owned by this hook (handled elsewhere):
//   - rag:rebuild:* / update:state / genie:state / backup:auto-zip —
//     each is subscribed by its own feature hook (localRagService,
//     useAppUpdater, TtsConfigSection, useAutoZipProgress).
//
// Phase 5 Part D additions:
//   - call:state / call:closed → reconstructs VoiceCallOverlayData on
//     the phone with callbacks that HTTP-post to /api/ipc/call:action.
//     The PC's renderer holds the real onAccept/onReject closures; we
//     just relay the user's tap over HTTP so the PC's promise resolves
//     correctly (otherwise the reminder-handling chat pipeline hangs).
//
// Desktop Electron short-circuits: isMobilePwa() is false there, so
// this hook is a no-op and the renderer's local Zustand mutations are
// already authoritative. We do NOT want to double-apply events on the
// PC (it would echo every message back to itself).

import { useEffect } from 'react';
import { useAppStore } from '../../store';
import { subscribeEvents, httpInvoke, type MobileEvent } from '../../services/httpApi';
import { isMobilePwa } from '../../services/environment';
import { db } from '../../services/db';
import type { Message, EmotionType } from '../../types';

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

// Convert the wire-format slim payload into a full Message. The WS
// broadcaster deliberately slims to the fields a phone renders; extra
// per-message fields (isPinned, sendStatus, failReason, groundingSources,
// storedEmotion, japaneseText, voiceDuration, quote) either default to
// undefined on mobile or are merged in from an existing local copy when
// we apply an update.
function materialize(slim: SlimMessage, existing?: Message): Message {
  const base: Message = {
    id: slim.id,
    role: slim.role,
    text: slim.text,
    timestamp: slim.timestamp,
    imageId: slim.imageId ?? undefined,
    imageCaption: slim.imageCaption ?? undefined,
    isVoiceMessage: slim.isVoiceMessage || undefined,
    voiceFileId: slim.voiceFileId ?? undefined,
  };
  if (!existing) return base;
  // Preserve fields the PC didn't send but the phone might have learned
  // locally (e.g. sendStatus set when the phone optimistically rendered
  // a message before the PC broadcast confirmed it).
  return {
    ...existing,
    ...base,
  };
}

function applyAdd(slim: SlimMessage) {
  const state = useAppStore.getState();
  const existing = state.messages.find((m) => m.id === slim.id);
  const msg = materialize(slim, existing);
  state.setMessages((prev) => {
    const idx = prev.findIndex((p) => p.id === msg.id);
    if (idx >= 0) {
      const next = prev.slice();
      next[idx] = msg;
      return next;
    }
    return [...prev, msg].sort((a, b) => a.timestamp - b.timestamp);
  });
  // Mirror to phone's local Dexie so a reload without fresh bootstrap
  // doesn't drop this message. The `image` transient field is stripped
  // because MessageEntity doesn't carry it. MessageEntity.quote.id is
  // required whereas Message.quote.id is optional (legacy), so we only
  // carry the quote through if it has a real id.
  const quoteForDexie =
    msg.quote && typeof msg.quote.id === 'string' && msg.quote.id.length > 0
      ? { id: msg.quote.id, text: msg.quote.text, role: msg.quote.role }
      : undefined;
  void db.messages.put({
    id: msg.id,
    role: msg.role,
    text: msg.text,
    timestamp: msg.timestamp,
    imageId: msg.imageId,
    imageCaption: msg.imageCaption,
    isVoiceMessage: msg.isVoiceMessage,
    voiceFileId: msg.voiceFileId,
    isPinned: msg.isPinned,
    isHidden: msg.isHidden,
    isRead: msg.isRead,
    quote: quoteForDexie,
    emotion: msg.storedEmotion,
    voiceDuration: msg.voiceDuration,
    japaneseText: msg.japaneseText,
    sendStatus: msg.sendStatus,
    failReason: msg.failReason,
  }).catch((e) => {
    console.warn('[MOBILE-SYNC] Failed to persist added message:', e);
  });
}

function applyUpdate(slim: SlimMessage) {
  // Same logic as add — setMessages branches on id match. Kept as its
  // own function for readability / future divergence (e.g. if we want
  // a no-op when the local fields haven't changed).
  applyAdd(slim);
}

function applyDelete(id: string) {
  const state = useAppStore.getState();
  state.setMessages((prev) => prev.filter((p) => p.id !== id));
  void db.messages.delete(id).catch((e) => {
    console.warn('[MOBILE-SYNC] Failed to delete message from local Dexie:', e);
  });
}

// Phase 5 Part D: wire-shape for the call overlay snapshot emitted by
// useMobileBroadcaster. The PC's real VoiceCallOverlayData carries React
// closures which can't cross the WS boundary; we reconstruct phone-side
// closures that HTTP-post back to /api/ipc/call:action so taps on the
// phone invoke the same onAccept/onReject promises the PC is waiting on.
interface WireCallState {
  reminderEvent: string;
  reminderText: string;
  emotion: string;
  ringtoneFileId: string | null;
  isConnecting: boolean;
  isPlayingVoice: boolean;
  isEnded: boolean;
  voiceFileId: string | null;
}

// Best-effort fire-and-forget. We log to console on failure rather than
// surfacing to the user because the WS will quickly replay the PC's
// next state transition (e.g. call:closed) if the action actually
// succeeded but the HTTP hop failed mid-response.
function postCallAction(action: 'accept' | 'reject' | 'close') {
  void httpInvoke('call:action', { action }).catch((e) => {
    console.warn('[MOBILE-SYNC] call:action failed:', action, e);
  });
}

function applyCallState(wire: WireCallState) {
  const store = useAppStore.getState();
  // Merge ringtoneFileId back into ttsConfig on mobile so the overlay
  // can resolve the correct ringtone. The phone's ttsConfig is already
  // hydrated by bootstrap:ai-config, but the PC might have changed
  // ringtone in between and we want the overlay to match.
  if (wire.ringtoneFileId && store.ttsConfig && store.ttsConfig.ringtoneFileId !== wire.ringtoneFileId) {
    store.setTtsConfig((prev) => ({ ...prev, ringtoneFileId: wire.ringtoneFileId as string }));
  }
  store.setVoiceCallOverlayData({
    reminderEvent: wire.reminderEvent,
    reminderText: wire.reminderText,
    emotion: wire.emotion as EmotionType,
    isConnecting: wire.isConnecting,
    isPlayingVoice: wire.isPlayingVoice,
    isEnded: wire.isEnded,
    voiceFileId: wire.voiceFileId ?? undefined,
    onAccept: () => postCallAction('accept'),
    onReject: () => postCallAction('reject'),
    onClose: () => postCallAction('close'),
  });
}

export function useMobileMessageSync() {
  useEffect(() => {
    if (!isMobilePwa()) return;

    const handle = (event: MobileEvent) => {
      try {
        if (event.type === 'message:added') {
          const slim = (event as unknown as { message?: SlimMessage }).message;
          if (slim && slim.id) applyAdd(slim);
          return;
        }
        if (event.type === 'message:updated') {
          const slim = (event as unknown as { message?: SlimMessage }).message;
          if (slim && slim.id) applyUpdate(slim);
          return;
        }
        if (event.type === 'message:deleted') {
          const id = (event as unknown as { messageId?: string }).messageId;
          if (typeof id === 'string' && id.length > 0) applyDelete(id);
          return;
        }
        if (event.type === 'status:line') {
          const text = (event as unknown as { text?: unknown }).text;
          if (typeof text === 'string') {
            useAppStore.getState().setStatusText(text);
          }
          return;
        }
        if (event.type === 'status:emotion') {
          const emotion = (event as unknown as { emotion?: unknown }).emotion;
          if (typeof emotion === 'string' && emotion.length > 0) {
            useAppStore.getState().setCurrentEmotion(emotion as EmotionType);
          }
          return;
        }
        // Phase 5 Part D: mirror PC's voice-call overlay.
        if (event.type === 'call:state') {
          const wire = (event as unknown as { state?: WireCallState }).state;
          if (wire && typeof wire === 'object' && typeof wire.reminderEvent === 'string') {
            applyCallState(wire);
          }
          return;
        }
        if (event.type === 'call:closed') {
          useAppStore.getState().setVoiceCallOverlayData(null);
          return;
        }
        // status:unread intentionally unhandled — see header comment.
      } catch (e) {
        console.warn('[MOBILE-SYNC] Failed to apply event:', event.type, e);
      }
    };

    const unsubscribe = subscribeEvents(handle);
    return () => {
      try { unsubscribe(); } catch { /* ignore */ }
    };
  }, []);
}
