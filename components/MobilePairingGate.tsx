// components/MobilePairingGate.tsx
//
// Phase 4 Part E: unify the mobile PWA entry with the full desktop app.
//
// Before this phase the mobile PWA rendered a parallel `MobilePhase1App`
// component with its own minimal chat list. That was scaffolding while
// Phases 1–3 wired up transport, IPC, and sync; phase 4 now makes phones
// render the exact same `App` component as desktop (settings panel,
// memory panel, diary, etc.), so "pc能用的手机完全都能用" holds by
// construction rather than by feature-chasing two parallel UIs.
//
// What this gate owns:
//   1. Probe `/api/status` and the session cookie. If the phone hasn't
//      paired yet we render the pairing screen (exactly the same UX that
//      used to live in `MobilePhase1App`).
//   2. Once paired we render `children` (the real `<App />`). `App` has
//      a sibling effect that auto-advances `flowState` from INTRO → APP
//      when `isMobilePwa()`, so the user skips the desktop onboarding
//      wizard (AUTH / CONFIG) — those flows configure the *desktop's*
//      local-file backup and API keys, which on mobile are already
//      handled by the PC backend we just paired with.
//
// Desktop Electron never instantiates this gate (index.tsx branches on
// `isMobilePwa()`), so none of this code runs there.

import React, { useCallback, useEffect, useState } from 'react';
import {
  httpCheckSession,
  httpInvoke,
  httpPair,
  httpStatus,
} from '../services/httpApi';
import { db, type DailyFragmentEntity, type KeyValEntity, type KumikoDiaryEntity, type MessageEntity, type PsycheStateEntity } from '../services/db';

type GateState =
  | { kind: 'loading' }
  | { kind: 'pairing'; hint?: string }
  | { kind: 'hydrating'; hostname: string | null; step: string }
  | { kind: 'paired'; hostname: string | null };

interface BootstrapSnapshotPayload {
  messages: MessageEntity[];
  kumikoDiary: KumikoDiaryEntity[];
  dailyFragments: DailyFragmentEntity[];
  psycheState: PsycheStateEntity[];
  keyval: KeyValEntity[];
}

interface BootstrapSnapshotResponse {
  ok: boolean;
  snapshot?: BootstrapSnapshotPayload;
  error?: string;
}

interface BootstrapAiConfigResponse {
  ok: boolean;
  config?: string | null;
  error?: string;
}

// Flag kept in sessionStorage so hydration runs exactly once per tab —
// reloading the PWA picks up the latest PC snapshot, but in-session
// re-renders of the gate (e.g. StrictMode) skip the slow replay.
const HYDRATION_FLAG_KEY = 'kumiko_mobile_hydrated';

async function hydrateFromPcSnapshot(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const aiConfigRes = await httpInvoke<BootstrapAiConfigResponse>('bootstrap:ai-config');
    if (aiConfigRes?.ok && typeof aiConfigRes.config === 'string' && aiConfigRes.config.length > 0) {
      try {
        localStorage.setItem('kumiko_ai_config', aiConfigRes.config);
      } catch {
        // Quota errors would block the whole boot; swallow and let the
        // settings UI reconfigure manually if needed.
      }
    }

    const snapRes = await httpInvoke<BootstrapSnapshotResponse>('bootstrap:snapshot');
    if (!snapRes?.ok || !snapRes.snapshot) {
      return { ok: false, error: snapRes?.error || 'Empty snapshot from PC.' };
    }
    const snap = snapRes.snapshot;

    // Bulk-replace each table so the phone's Dexie ends as an exact
    // mirror of the PC's (for the tables we care about on mobile).
    // Vectors + images tables are intentionally left empty — RAG runs
    // on PC, images stream via /media/images/:id.
    await db.transaction(
      'rw',
      [db.messages, db.kumikoDiary, db.dailyFragments, db.psycheState, db.keyval],
      async () => {
        await Promise.all([
          db.messages.clear(),
          db.kumikoDiary.clear(),
          db.dailyFragments.clear(),
          db.psycheState.clear(),
          db.keyval.clear(),
        ]);
        if (snap.messages.length > 0) await db.messages.bulkPut(snap.messages);
        if (snap.kumikoDiary.length > 0) await db.kumikoDiary.bulkPut(snap.kumikoDiary);
        if (snap.dailyFragments.length > 0) await db.dailyFragments.bulkPut(snap.dailyFragments);
        if (snap.psycheState.length > 0) await db.psycheState.bulkPut(snap.psycheState);
        if (snap.keyval.length > 0) await db.keyval.bulkPut(snap.keyval);
      },
    );

    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'Network error during hydration.' };
  }
}

function PairingView({
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
      paddingTop: 'max(40px, env(safe-area-inset-top))',
      paddingBottom: 'max(24px, env(safe-area-inset-bottom))',
    }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 6 }}>
          Kumiko·Amadeus Mobile
        </h1>
        <div style={{ fontSize: 13, color: '#94a3b8' }}>
          Pair with your desktop
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
          minHeight: 48,
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

function LoadingView() {
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

function HydratingView({ step }: { step: string }) {
  return (
    <div style={{
      minHeight: '100dvh',
      background: '#0f172a',
      color: '#e2e8f0',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 14,
      gap: 12,
    }}>
      <div style={{ fontSize: 18, fontWeight: 600 }}>Syncing with desktop</div>
      <div style={{ color: '#94a3b8', fontSize: 13 }}>{step}</div>
    </div>
  );
}

export const MobilePairingGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<GateState>({ kind: 'loading' });

  const refresh = useCallback(async () => {
    const status = await httpStatus();
    if (!status) {
      setState({
        kind: 'pairing',
        hint: 'Desktop Fastify not reachable. Verify Tailscale + desktop app are running.',
      });
      return;
    }
    const sessionOk = await httpCheckSession();
    if (!sessionOk) {
      setState({ kind: 'pairing' });
      return;
    }

    // Session is valid. Hydrate local Dexie + AI config from PC if we
    // haven't done it yet in this session. This is the single blocking
    // step between pairing and <App /> mounting so the App sees real
    // data instead of empty IndexedDB.
    const alreadyHydrated = typeof sessionStorage !== 'undefined'
      && sessionStorage.getItem(HYDRATION_FLAG_KEY) === '1';
    if (alreadyHydrated) {
      setState({ kind: 'paired', hostname: status.hostname });
      return;
    }

    setState({ kind: 'hydrating', hostname: status.hostname, step: 'Pulling history from PC…' });
    const result = await hydrateFromPcSnapshot();
    if (result.ok === false) {
      setState({
        kind: 'pairing',
        hint: `Hydration failed: ${result.error}. Try repairing with a fresh token.`,
      });
      return;
    }
    try {
      sessionStorage.setItem(HYDRATION_FLAG_KEY, '1');
    } catch {
      // session storage may be unavailable (private mode); harmless.
    }
    setState({ kind: 'paired', hostname: status.hostname });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (state.kind === 'loading') {
    return <LoadingView />;
  }
  if (state.kind === 'pairing') {
    return <PairingView onPaired={refresh} hint={state.hint} />;
  }
  if (state.kind === 'hydrating') {
    return <HydratingView step={state.step} />;
  }
  return <>{children}</>;
};

export default MobilePairingGate;
