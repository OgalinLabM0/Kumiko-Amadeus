// components/MobilePhase1App.tsx
//
// Minimal phone-PWA UI shipped for Mobile Access Phase 1. Deliberately a
// parallel React entry rather than a branch inside App.tsx — the full
// desktop UI has ~2000 lines of state wiring that assumes local Dexie +
// local filesystem; re-homing all of it into "HTTP + shared cookie"
// lands in Phase 2-5. Phase 1 only needs to prove the transport works.
//
// Lifecycle:
//   1. Fetch /api/status — if the session cookie is still valid we skip
//      straight to the chat view; otherwise render the pairing screen.
//   2. Pairing screen: the user pastes the token shown on their
//      desktop's Settings / Mobile Access panel. On success the server
//      sets an HttpOnly Secure cookie scoped to the Tailscale hostname
//      and we reload the chat view.
//   3. Chat view: pulls the last 50 messages (GET proxied as
//      `messages:recent`), shows them in a thin bubble list, and
//      exposes a send box that POSTs `chat` and appends both the user's
//      new message and the assistant reply returned from the desktop
//      renderer.
//
// Every network call goes through services/httpApi.ts so the contract
// matches what the Fastify server expects. This file does NOT touch
// Dexie or `window.electronAPI` — in PWA context neither is available.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  HttpApiError,
  type MobileEvent,
  getHttpImageUrl,
  httpCheckSession,
  httpInvoke,
  httpLogout,
  httpPair,
  httpStatus,
  subscribeEvents,
} from '../services/httpApi';

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

interface MessagesRecentResponse {
  messages: SlimMessage[];
  count: number;
  truncated: boolean;
}

interface ChatResponse {
  userMessage?: SlimMessage;
  modelMessage?: SlimMessage;
  modelMessages?: SlimMessage[];
  error?: string;
  code?: string;
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'pairing'; hint?: string }
  | { kind: 'chat'; hostname: string | null };

function formatTimestamp(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

const MessageBubble: React.FC<{ message: SlimMessage }> = ({ message }) => {
  const isUser = message.role === 'user';
  return (
    <div style={{
      display: 'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
      marginBottom: 10,
    }}>
      <div style={{
        maxWidth: '78%',
        background: isUser ? '#2563eb' : '#1f2937',
        color: '#f9fafb',
        padding: '10px 14px',
        borderRadius: 14,
        fontSize: 15,
        lineHeight: 1.4,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {message.imageId ? (
          <div style={{ marginBottom: message.text ? 8 : 0 }}>
            <img
              src={getHttpImageUrl(message.imageId)}
              alt={message.imageCaption || 'image'}
              style={{ maxWidth: '100%', borderRadius: 8, display: 'block' }}
            />
            {message.imageCaption && (
              <div style={{ fontSize: 12, color: '#cbd5f5', marginTop: 4 }}>
                {message.imageCaption}
              </div>
            )}
          </div>
        ) : null}
        {message.text && <div>{message.text}</div>}
        {message.isVoiceMessage && (
          <div style={{ fontSize: 12, color: '#cbd5f5', marginTop: 4 }}>
            (voice message — Phase 2 adds playback)
          </div>
        )}
        <div style={{
          fontSize: 11,
          color: isUser ? 'rgba(255,255,255,0.6)' : '#94a3b8',
          marginTop: 4,
          textAlign: isUser ? 'right' : 'left',
        }}>
          {formatTimestamp(message.timestamp)}
        </div>
      </div>
    </div>
  );
};

function PairingScreen({
  onPaired,
  hint,
}: {
  onPaired: () => void;
  hint?: string;
}) {
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const trimmed = token.trim();
    if (!trimmed) {
      setError('Paste the pairing token shown in your desktop app.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await httpPair(trimmed);
      if (!result.ok) {
        setError(result.error || 'Pairing failed.');
        return;
      }
      onPaired();
    } catch (e) {
      setError((e as Error).message || 'Network error.');
    } finally {
      setSubmitting(false);
    }
  }, [token, onPaired]);

  return (
    <div style={{
      minHeight: '100dvh',
      background: '#0f172a',
      color: '#e2e8f0',
      display: 'flex',
      flexDirection: 'column',
      padding: 24,
      boxSizing: 'border-box',
    }}>
      <div style={{ marginTop: 40 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 6 }}>
          Kumiko·Amadeus Mobile
        </h1>
        <div style={{ fontSize: 13, color: '#94a3b8' }}>
          Phase 1 · Pair with your desktop
        </div>
      </div>

      <p style={{ fontSize: 14, color: '#cbd5f5', marginTop: 24, lineHeight: 1.6 }}>
        Open Settings → Mobile Access on your desktop and copy the pairing
        token. Paste it below to link this phone to your Tailnet.
      </p>

      {hint && (
        <div style={{
          marginTop: 12,
          background: '#1f2937',
          padding: 10,
          borderRadius: 8,
          fontSize: 13,
          color: '#fbbf24',
        }}>
          {hint}
        </div>
      )}

      <label style={{ marginTop: 24, fontSize: 13, color: '#94a3b8' }}>
        Pairing token
      </label>
      <textarea
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="Paste token here"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        style={{
          marginTop: 6,
          background: '#1e293b',
          color: '#f8fafc',
          border: '1px solid #334155',
          borderRadius: 10,
          padding: 12,
          fontSize: 15,
          minHeight: 96,
          resize: 'vertical',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
      />

      {error && (
        <div style={{
          marginTop: 12,
          color: '#f87171',
          fontSize: 13,
          background: 'rgba(248,113,113,0.08)',
          padding: 10,
          borderRadius: 8,
        }}>
          {error}
        </div>
      )}

      <button
        onClick={submit}
        disabled={submitting}
        style={{
          marginTop: 20,
          padding: '14px 16px',
          background: submitting ? '#334155' : '#2563eb',
          color: '#fff',
          border: 'none',
          borderRadius: 10,
          fontSize: 16,
          fontWeight: 600,
          cursor: submitting ? 'wait' : 'pointer',
        }}
      >
        {submitting ? 'Pairing…' : 'Pair phone'}
      </button>

      <div style={{ marginTop: 24, fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>
        Token is one-time reveal on the desktop. Pair succeeds when the
        server sets a secure cookie; subsequent visits skip this step.
      </div>
    </div>
  );
}

function ChatScreen({ hostname }: { hostname: string | null }) {
  const [messages, setMessages] = useState<SlimMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Live WS connection status. We surface "offline" to the user rather
  // than pretending the chat is real-time; otherwise silent drops look
  // like the desktop is ignoring them.
  const [liveStatus, setLiveStatus] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [statusLine, setStatusLine] = useState<string>('');
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const body = await httpInvoke<MessagesRecentResponse>('messages:recent', { limit: 50 });
      setMessages(Array.isArray(body.messages) ? body.messages : []);
    } catch (e) {
      setLoadError((e as Error).message || 'Failed to load history.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Phase 2 Part C: live updates. Subscribe to the desktop broadcaster
  // so we see new messages without polling. Dedupe by id since a message
  // can arrive via both the WS push (fast) and a chat HTTP response
  // (deterministic); whoever lands first wins, the second is a no-op.
  useEffect(() => {
    const onEvent = (event: MobileEvent) => {
      if (event.type === 'message:added') {
        const m = (event as { message?: SlimMessage }).message;
        if (!m || !m.id) return;
        setMessages((prev) => (prev.some((p) => p.id === m.id) ? prev : [...prev, m]));
      } else if (event.type === 'message:updated') {
        const m = (event as { message?: SlimMessage }).message;
        if (!m || !m.id) return;
        setMessages((prev) => prev.map((p) => (p.id === m.id ? m : p)));
      } else if (event.type === 'message:deleted') {
        const id = (event as { messageId?: string }).messageId;
        if (typeof id !== 'string') return;
        setMessages((prev) => prev.filter((p) => p.id !== id));
      } else if (event.type === 'status:line') {
        const text = (event as { text?: unknown }).text;
        setStatusLine(typeof text === 'string' ? text : '');
      }
      // status:emotion / status:unread are intentionally ignored in the
      // Phase 1 minimal UI — Phase 5 will surface them.
    };
    const unsubscribe = subscribeEvents(onEvent, {
      onOpen: () => setLiveStatus('online'),
      onClose: () => setLiveStatus('offline'),
      onError: () => setLiveStatus('offline'),
    });
    return unsubscribe;
  }, []);

  const handleSend = useCallback(async () => {
    const message = draft.trim();
    if (!message || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const result = await httpInvoke<ChatResponse>('chat', { message });
      if (result.error || !result.userMessage || !result.modelMessage) {
        setSendError(result.error || 'Chat call returned no reply.');
      } else {
        // Part D server now returns modelMessages[] when the model
        // produced multiple reply parts. Fall back to the legacy single
        // modelMessage field so the UI stays compatible if the desktop
        // ever emits an older-shape response.
        //
        // The WS broadcaster also fires message:added for each of these
        // rows. We rely on the dedupe-by-id fold in the effect above to
        // drop duplicates, so paining them here optimistically gives
        // the sender instant feedback without double-rendering.
        const replyRows = result.modelMessages && result.modelMessages.length > 0
          ? result.modelMessages
          : [result.modelMessage!];
        setMessages((prev) => {
          const byId = new Map<string, SlimMessage>();
          for (const row of prev) byId.set(row.id, row);
          // Merge in any rows the broadcaster hasn't shipped yet; keeps
          // the "send → see it immediately" guarantee without doubling
          // up if the WS beat us to it.
          byId.set(result.userMessage!.id, result.userMessage!);
          for (const row of replyRows) byId.set(row.id, row);
          return Array.from(byId.values()).sort((a, b) => a.timestamp - b.timestamp);
        });
        setDraft('');
      }
    } catch (e) {
      const err = e as HttpApiError;
      setSendError(err.message || 'Network error.');
      if (err instanceof HttpApiError && err.status === 401) {
        window.location.reload();
      }
    } finally {
      setSending(false);
    }
  }, [draft, sending]);

  return (
    <div style={{
      minHeight: '100dvh',
      background: '#0f172a',
      color: '#e2e8f0',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <header style={{
        padding: '12px 16px',
        borderBottom: '1px solid #1e293b',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            Kumiko·Amadeus
            <span
              aria-label={liveStatus}
              title={`Live stream: ${liveStatus}`}
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background:
                  liveStatus === 'online' ? '#22c55e'
                    : liveStatus === 'connecting' ? '#facc15'
                      : '#ef4444',
                display: 'inline-block',
              }}
            />
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>
            {statusLine || (hostname ? `Connected · ${hostname}` : 'Connected')}
          </div>
        </div>
        <button
          onClick={async () => {
            await httpLogout();
            window.location.reload();
          }}
          style={{
            background: 'transparent',
            color: '#94a3b8',
            border: '1px solid #334155',
            borderRadius: 8,
            padding: '6px 10px',
            fontSize: 12,
          }}
        >
          Unpair
        </button>
      </header>

      <main style={{
        flex: 1,
        overflowY: 'auto',
        padding: '12px 12px 16px 12px',
      }}>
        {loading && messages.length === 0 && (
          <div style={{ color: '#64748b', fontSize: 13, textAlign: 'center', marginTop: 32 }}>
            Loading history…
          </div>
        )}
        {loadError && (
          <div style={{
            background: 'rgba(248,113,113,0.08)',
            color: '#f87171',
            padding: 12,
            borderRadius: 10,
            fontSize: 13,
            marginBottom: 12,
          }}>
            {loadError}{' '}
            <button
              onClick={refresh}
              style={{
                background: 'transparent',
                color: '#f87171',
                border: '1px solid #f87171',
                borderRadius: 6,
                padding: '2px 8px',
                fontSize: 12,
                marginLeft: 8,
              }}
            >
              Retry
            </button>
          </div>
        )}
        {messages.map((m) => <MessageBubble key={m.id} message={m} />)}
        <div ref={bottomRef} />
      </main>

      {sendError && (
        <div style={{
          background: 'rgba(248,113,113,0.08)',
          color: '#f87171',
          padding: 10,
          fontSize: 13,
          textAlign: 'center',
        }}>
          {sendError}
        </div>
      )}

      <footer style={{
        padding: 10,
        borderTop: '1px solid #1e293b',
        background: '#0b1220',
        display: 'flex',
        gap: 8,
      }}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Type a message…"
          disabled={sending}
          style={{
            flex: 1,
            background: '#1e293b',
            color: '#f8fafc',
            border: '1px solid #334155',
            borderRadius: 10,
            padding: '10px 12px',
            fontSize: 15,
          }}
        />
        <button
          onClick={handleSend}
          disabled={sending || !draft.trim()}
          style={{
            padding: '0 16px',
            background: sending || !draft.trim() ? '#334155' : '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 10,
            fontWeight: 600,
            fontSize: 14,
            cursor: sending || !draft.trim() ? 'not-allowed' : 'pointer',
          }}
        >
          {sending ? '…' : 'Send'}
        </button>
      </footer>
    </div>
  );
}

export function MobilePhase1App() {
  const [view, setView] = useState<ViewState>({ kind: 'loading' });

  const refreshStatus = useCallback(async () => {
    // Start by probing the server so we can surface a useful hint
    // ("desktop not reachable") if the phone is off the Tailnet.
    const status = await httpStatus();
    if (!status) {
      setView({ kind: 'pairing', hint: 'Desktop Fastify not reachable. Verify Tailscale + desktop app are running.' });
      return;
    }
    // Separately probe whether THIS browser's cookie is valid. /api/status
    // only reports that *some* device has paired — which is not the same
    // as "this phone is already authenticated".
    const sessionOk = await httpCheckSession();
    if (sessionOk) {
      setView({ kind: 'chat', hostname: status.hostname });
    } else {
      setView({ kind: 'pairing' });
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  if (view.kind === 'loading') {
    return (
      <div style={{
        minHeight: '100dvh',
        background: '#0f172a',
        color: '#94a3b8',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 14,
      }}>
        Connecting…
      </div>
    );
  }
  if (view.kind === 'pairing') {
    return <PairingScreen onPaired={refreshStatus} hint={view.hint} />;
  }
  return <ChatScreen hostname={view.hostname} />;
}

export default MobilePhase1App;
