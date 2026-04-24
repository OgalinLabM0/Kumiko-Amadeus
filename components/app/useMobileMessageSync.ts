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
import {
  applyPreferencesPatch,
  readPreferencesRevision,
  type PreferencesBootstrapPayload,
} from '../../services/preferencesSync';
import type { Message, EmotionType } from '../../types';

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
  // Kept in lockstep with the producer side (useMobileBroadcaster.ts).
  // These are optional on the wire: undefined means "payload predates
  // the extension" (PC still running old code during upgrade) and we
  // fall back to the existing local value.
  storedEmotion?: string | null;
  isPinned?: boolean;
  isHidden?: boolean;
  quote?: SlimMessageQuote | null;
  groundingSources?: SlimGroundingSource[] | null;
}

// Convert the wire-format slim payload into a full Message. The WS
// broadcaster includes the visually-relevant metadata (emotion, pin,
// quote, grounding) so mobile UI can render emotion bubbles / pin
// indicators / reply context the same way PC does. Other fields
// (sendStatus, failReason, voiceDuration, japaneseText) are phone-
// local and get merged in from an existing copy when present.
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
  if (slim.storedEmotion !== undefined) {
    base.storedEmotion = slim.storedEmotion === null
      ? undefined
      : (slim.storedEmotion as Message['storedEmotion']);
  }
  if (slim.isPinned !== undefined) base.isPinned = !!slim.isPinned;
  if (slim.isHidden !== undefined) base.isHidden = !!slim.isHidden;
  if (slim.quote !== undefined) {
    base.quote = slim.quote === null
      ? undefined
      : { id: slim.quote.id, text: slim.quote.text, role: slim.quote.role };
  }
  if (slim.groundingSources !== undefined) {
    base.groundingSources = slim.groundingSources === null
      ? undefined
      : slim.groundingSources.map(src => ({ uri: src.uri, title: src.title }));
  }
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
  // Last-resort ringtone reconciliation. The primary sync path is now
  // `tts-config:changed` (see the WS handler in useMobileMessageSync) +
  // `bootstrap:tts-config` on pairing — those keep the phone's full
  // TtsConfig in step with PC at all times. We still patch ringtoneFileId
  // here so a call that arrives BEFORE the bootstrap round-trip settles
  // (very early-boot races, or a phone that just (re)connected over a
  // flaky link and hasn't replayed bootstrap yet) still rings with the
  // right tone instead of falling back to the bundled default.
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

async function refreshPreferencesFromPc(hintedRevision?: number): Promise<void> {
  const localRevision = readPreferencesRevision();
  if (
    typeof hintedRevision === 'number'
    && hintedRevision > 0
    && localRevision > 0
    && hintedRevision <= localRevision
  ) {
    return;
  }
  try {
    const res = await httpInvoke<{ ok?: boolean; payload?: PreferencesBootstrapPayload; error?: string }>('preferences:bootstrap');
    if (!res?.ok || !res.payload) return;
    const remoteRevision =
      typeof res.payload.revision === 'number' && Number.isFinite(res.payload.revision)
        ? res.payload.revision
        : 0;
    if (remoteRevision > 0 && localRevision > 0 && remoteRevision <= localRevision) {
      return;
    }
    await applyPreferencesPatch(res.payload, {
      replaceKeyval: true,
      revision: remoteRevision,
    });
  } catch (err) {
    console.warn('[MOBILE-SYNC] preferences bootstrap refresh failed:', err);
  }
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
        // Phase 6 Part B: PC pushed a kumiko_ai_config change. Re-pull
        // via bootstrap:ai-config so every phone (including the one that
        // triggered the update) re-hydrates its local mirror. Deliberately
        // fire-and-forget — if the bootstrap fetch fails the phone still
        // runs on its previous local copy, and the next restart / manual
        // reconnect will reconcile.
        if (event.type === 'ai-config:changed') {
          void refreshPreferencesFromPc();
          return;
        }
        // PC-authoritative ttsConfig changed (Fish/Vocu key, ringtone,
        // SoVITS variant, speed/latency, …). Re-pull the full blob from
        // PC, persist to phone localStorage, and push the parsed value
        // into zustand so every TTS-aware component (ringtone preview,
        // voice messages, call overlay) re-renders on the new selection.
        //
        // We sanitise via the shared helper before setTtsConfig so a
        // garbled localStorage on PC (legacy ringtone id, missing Vocu
        // fields) doesn't blow up the phone's UI — same code path the
        // store hydration normally uses, just on a fresh blob.
        if (event.type === 'tts-config:changed') {
          void refreshPreferencesFromPc();
          return;
        }
        if (event.type === 'preferences:changed') {
          const revision = (event as unknown as { revision?: unknown }).revision;
          void refreshPreferencesFromPc(
            typeof revision === 'number' && Number.isFinite(revision) ? revision : undefined,
          );
          return;
        }
        // Phase 6 Part C: PC connected / created / disconnected a local
        // backup file. Mirror the resulting fileName into the phone's
        // `connectedFileName` slice so the AuthScreen / BackupSection UI
        // shows the current PC-side path. The full filePath is stored
        // into window-level state only (see useLocalFileBackup) because
        // the desktop's absolute path isn't useful to re-display beyond
        // the basename in the existing UI.
        if (event.type === 'backup:desktop-path-changed') {
          const payload = event as unknown as { filePath?: string | null; fileName?: string | null };
          const fileName = typeof payload.fileName === 'string' ? payload.fileName : null;
          useAppStore.getState().setConnectedFileName(fileName);
          return;
        }
        // Busy regulator mirrors. The phone only renders UI from
        // these events; it never runs the prepare/display AI
        // pipeline (desktop is authoritative). We reconstruct
        // minimum-viable BusyFollowUp / PendingApology shapes so
        // TaskPanel's existing component code Just Works on mobile.
        if (event.type === 'busy:followup:set') {
          const payload = event as unknown as { followUp?: {
            id: string;
            slotDescription: string;
            slotType: string;
            slotEndAtMs: number | null;
            prepareAt: number;
            displayAt: number;
            unreadCount: number;
            prepared: boolean;
            failureCount: number;
          } };
          const f = payload.followUp;
          if (f && typeof f.id === 'string') {
            useAppStore.getState().setBusyFollowUp({
              id: f.id,
              createdAt: f.prepareAt - 2 * 60 * 1000,
              slotKey: f.id,
              slotType: f.slotType as never,
              slotDescription: f.slotDescription,
              slotEndAtMs: f.slotEndAtMs,
              prepareAt: f.prepareAt,
              displayAt: f.displayAt,
              unreadUserMessageIds: new Array(f.unreadCount).fill('').map((_, i) => `phone-${f.id}-${i}`),
              preparedTextParts: f.prepared ? ['__desktop_prepared__'] : undefined,
              preparedAt: f.prepared ? Date.now() : undefined,
              failureCount: f.failureCount,
            });
          }
          return;
        }
        if (event.type === 'busy:followup:cleared') {
          useAppStore.getState().setBusyFollowUp(null);
          return;
        }
        if (event.type === 'busy:apology:set') {
          const payload = event as unknown as { apology?: {
            id: string;
            createdAt: number;
            latestAppendedAt: number;
            sources: Array<{ slotDescription: string; slotType: string; reason: string; unreadCount: number }>;
          } };
          const a = payload.apology;
          if (a && Array.isArray(a.sources)) {
            useAppStore.getState().setPendingApology({
              id: a.id,
              createdAt: a.createdAt,
              latestAppendedAt: a.latestAppendedAt,
              sources: a.sources.map((s, i) => ({
                slotKey: `phone-${a.id}-${i}`,
                slotType: s.slotType as never,
                slotDescription: s.slotDescription,
                unreadUserMessageIds: new Array(s.unreadCount).fill('').map((_, j) => `phone-${a.id}-${i}-${j}`),
                reason: s.reason as never,
                convertedAt: a.latestAppendedAt,
              })),
            });
          }
          return;
        }
        if (event.type === 'busy:apology:cleared') {
          useAppStore.getState().setPendingApology(null);
          return;
        }
        // status:unread intentionally unhandled — see header comment.
      } catch (e) {
        console.warn('[MOBILE-SYNC] Failed to apply event:', event.type, e);
      }
    };

    const unsubscribe = subscribeEvents(handle, {
      onOpen: () => {
        void refreshPreferencesFromPc();
      },
    });
    return () => {
      try { unsubscribe(); } catch { /* ignore */ }
    };
  }, []);
}
