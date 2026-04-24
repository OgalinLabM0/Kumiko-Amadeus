// components/MobilePairingGate.tsx
//
// Phase 4 Part E + Phase 7 Part t2_pairing_ui: unify the mobile PWA
// entry with the full desktop app, wrapped in the Kitauji brand chrome.
//
// Before Phase 4 the mobile PWA rendered a parallel `MobilePhase1App`
// component with its own minimal chat list. Phase 4 made phones render
// the exact same `<App />` as desktop (settings, memory, diary, etc.).
// Phase 6 removed the INTRO auto-skip so the mobile PWA walks the FULL
// desktop onboarding flow (INTRO → AUTH → CONFIG → APP) — see
// components/App.tsx `initialFlowFor`.
//
// What this gate owns:
//   1. Probe `/api/status` + session cookie. If the phone hasn't paired
//      yet we render the pairing screen.
//   2. Once paired, hydrate the local Dexie mirror + AI config from the
//      PC snapshot (once per tab, guarded by sessionStorage).
//   3. Hand off to `children` (the real `<App />`) which then runs the
//      same `flowState` state machine as desktop.
//
// Desktop Electron never instantiates this gate (index.tsx branches on
// `isMobilePwa()`), so none of this code runs there.
//
// Phase 7 note: All three views (Loading, Pairing, Hydrating) now share
// the `MobilePairingChrome` shell that mirrors IntroScreen's palette +
// typography, so a phone landing on the PWA never sees a "demo" dark
// screen before the app kicks in.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  httpCheckSession,
  httpInvoke,
  httpPair,
  httpStatus,
} from '../services/httpApi';
import { db, type DailyFragmentEntity, type KeyValEntity, type KumikoDiaryEntity, type MessageEntity, type PsycheStateEntity } from '../services/db';
import { applyPreferencesPatch, type PreferencesBootstrapPayload } from '../services/preferencesSync';
import {
  getCapacitorPcBaseUrl,
  isCapacitorNative,
  setCapacitorPcBaseUrl,
} from '../services/environment';
import { ensurePushSubscription } from '../services/pushSubscriptionService';
import { useViewportSync } from '../hooks/useAppViewport';
import {
  MobilePairingChrome,
  MobilePairingHydrating,
  MobilePairingLoading,
  type MobilePairingStep,
} from './mobile/MobilePairingChrome';

type GateState =
  // Capacitor native (Android APK / iOS .ipa) only: the WebView origin is
  // capacitor://localhost so we have to ask the user for PC's reachable
  // URL once. PWA path skips this state entirely (origin == PC).
  | { kind: 'configure-pc-url'; hint?: string }
  | { kind: 'loading' }
  | { kind: 'pairing'; hint?: string }
  | { kind: 'hydrating'; hostname: string | null; step: HydrationStep }
  | { kind: 'paired'; hostname: string | null };

type HydrationStep = 'probing' | 'config' | 'snapshot' | 'applying';

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

interface BootstrapPreferencesResponse {
  ok: boolean;
  payload?: PreferencesBootstrapPayload;
  error?: string;
}

const HYDRATION_FLAG_KEY = 'kumiko_mobile_hydrated';

async function hydrateFromPcSnapshot(
  onStep: (s: HydrationStep) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    onStep('config');
    const prefsRes = await httpInvoke<BootstrapPreferencesResponse>('preferences:bootstrap');
    if (!prefsRes?.ok || !prefsRes.payload) {
      return { ok: false, error: prefsRes?.error || 'Empty preferences payload from PC.' };
    }
    await applyPreferencesPatch(prefsRes.payload, {
      replaceKeyval: true,
      revision: prefsRes.payload.revision,
    });

    onStep('snapshot');
    const snapRes = await httpInvoke<BootstrapSnapshotResponse>('bootstrap:snapshot');
    if (!snapRes?.ok || !snapRes.snapshot) {
      return { ok: false, error: snapRes?.error || 'Empty snapshot from PC.' };
    }
    const snap = snapRes.snapshot;

    onStep('applying');
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

const HYDRATION_LABELS: Record<HydrationStep, { zh: string; en: string }> = {
  probing: { zh: '定位桌面服务', en: 'Reaching desktop Fastify' },
  config: { zh: '读取 AI 配置', en: 'Reading AI configuration' },
  snapshot: { zh: '从 PC 拉取历史', en: 'Pulling history from PC' },
  applying: { zh: '写入本地存储', en: 'Mirroring into local storage' },
};

function hydrationSteps(current: HydrationStep): MobilePairingStep[] {
  const order: HydrationStep[] = ['probing', 'config', 'snapshot', 'applying'];
  const idx = order.indexOf(current);
  return order.map((id, i) => ({
    id,
    label: HYDRATION_LABELS[id].zh,
    labelEn: HYDRATION_LABELS[id].en,
    state: i < idx ? 'done' : i === idx ? 'active' : 'pending',
  }));
}

function PairingView({
  onPaired,
  onEditPcUrl,
  hint,
}: {
  onPaired: () => void;
  onEditPcUrl?: () => void;
  hint?: string;
}) {
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const trimmed = token.trim();
    if (!trimmed) {
      setError('请先粘贴桌面端显示的配对口令。');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await httpPair(trimmed);
      if (!result.ok) {
        setError(result.error || '配对失败。');
        return;
      }
      // Phase 5 Part A: while we still own the user-gesture context from
      // the "Pair phone" tap, kick off Web Push registration. iOS 16.4+
      // requires Notification.requestPermission() to fire from a user
      // gesture, and this is the only hands-on moment we have in the
      // pairing flow. Best-effort — can retry from Settings later.
      void ensurePushSubscription();
      onPaired();
    } catch (e) {
      setError((e as Error).message || '网络异常，请稍后重试。');
    } finally {
      setSubmitting(false);
    }
  }, [token, onPaired]);

  return (
    <div className="flex flex-col gap-5">
      <div className="ka-pair-card px-5 py-5">
        <div className="ka-pair-micro text-[10px] font-semibold uppercase mb-1">
          第一步 · 与桌面端配对
        </div>
        <div className="ka-pair-micro text-[10px] opacity-70 mb-2">
          Step 1 · Pair with Desktop
        </div>
        <p className="ka-pair-body text-[13px] leading-relaxed">
          在桌面端打开 <strong>设置 → 手机访问</strong>，复制一次性配对口令，
          粘贴到下方，即可把这台手机接入你的 Tailnet。
        </p>
        <p className="ka-pair-micro text-[10.5px] leading-relaxed opacity-60 mt-2">
          Open <strong>Settings → Mobile Access</strong> on your desktop and
          paste the one-time token below.
        </p>
      </div>

      {hint && (
        <div
          className="ka-pair-card px-4 py-3 text-[12px] leading-relaxed"
          style={{
            background: 'rgba(197, 160, 89, 0.12)',
            borderColor: 'rgba(197, 160, 89, 0.4)',
            color: '#785A42',
          }}
        >
          {hint}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <label className="ka-pair-micro text-[10px] font-semibold uppercase px-1">
          配对口令 · Pairing token
        </label>
        <textarea
          className="ka-pair-input"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      </div>

      {error && (
        <div
          className="ka-pair-card px-4 py-3 text-[12px] leading-relaxed"
          style={{
            background: 'rgba(180, 60, 60, 0.08)',
            borderColor: 'rgba(180, 60, 60, 0.32)',
            color: '#7f2a2a',
          }}
        >
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={submitting}
        className="ka-pair-btn"
      >
        <span className="relative z-10">
          {submitting ? '配对中…' : '配对手机 · Pair phone'}
        </span>
      </button>

      <div className="ka-pair-body text-[11.5px] leading-relaxed opacity-70 px-1">
        口令仅在桌面端显示一次。一旦服务器下发会话 cookie，配对即完成，下次
        访问不需要再填。
      </div>

      {onEditPcUrl && (
        <button
          type="button"
          onClick={onEditPcUrl}
          className="ka-pair-body text-[11.5px] leading-relaxed underline opacity-70 hover:opacity-100 px-1 self-start"
          style={{ color: '#785A42', background: 'transparent', border: 'none' }}
        >
          换一个 PC 地址 · Use a different PC URL
        </button>
      )}
    </div>
  );
}

// Capacitor-only: ask the user for PC's reachable URL on first launch.
// PWA never sees this view because `getApiBaseUrl()` already resolves to
// the page origin (which is PC for the PWA case). The form validates the
// URL by hitting `${url}/api/status`; a 200 + JSON response means the PC
// process + Fastify mobile-access bridge are both live and reachable.
function PcUrlConfigureView({
  onSaved,
  initialUrl,
  hint,
}: {
  onSaved: () => void;
  initialUrl: string;
  hint?: string;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const trimmed = url.trim().replace(/\/+$/, '');
    if (!trimmed) {
      setError('请填写桌面端的 URL，例如 http://192.168.1.50:3000 或 http://100.64.x.x:3000。');
      return;
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      setError('URL 必须以 http:// 或 https:// 开头。');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // Probe the URL directly (NOT via httpStatus, which reads the same
      // localStorage key we're about to write — chicken-and-egg). 8s timeout
      // is generous enough for sleepy LAN routers / first-Tailscale-handshake
      // delays, while still bailing fast enough to keep the user from
      // staring at a frozen button.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${trimmed}/api/status`, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        setError(`PC 地址有响应但状态码异常 (${res.status})。请确认 PC 软件已开启「设置 → 手机访问」。`);
        return;
      }
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        setError('该 URL 没有返回我们认识的 PC 服务（不是 JSON）。请确认你输入的是 Kumiko·Amadeus PC 软件的地址。');
        return;
      }
      setCapacitorPcBaseUrl(trimmed);
      onSaved();
    } catch (e) {
      const msg = (e as Error).name === 'AbortError'
        ? '连接超时（8 秒）。请确认手机和 PC 在同一网段（或 Tailscale 互通），且 PC 端 IP / 端口正确。'
        : ((e as Error).message || '连接失败。');
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }, [url, onSaved]);

  return (
    <div className="flex flex-col gap-5">
      <div className="ka-pair-card px-5 py-5">
        <div className="ka-pair-micro text-[10px] font-semibold uppercase mb-1">
          第〇步 · 找到桌面端
        </div>
        <div className="ka-pair-micro text-[10px] opacity-70 mb-2">
          Step 0 · Reach your desktop
        </div>
        <p className="ka-pair-body text-[13px] leading-relaxed">
          这是 Android 原生 App，不是浏览器 PWA，所以需要先告诉它你 PC 软件的地址。
          打开桌面端 <strong>设置 → 手机访问</strong>，会显示「http://xxx.xxx.xxx.xxx:3000」一行，
          原样填到下方。
        </p>
        <p className="ka-pair-micro text-[10.5px] leading-relaxed opacity-60 mt-2">
          Native Android app: enter the LAN / Tailscale URL shown in your
          desktop client's <strong>Settings → Mobile Access</strong>.
        </p>
      </div>

      {hint && (
        <div
          className="ka-pair-card px-4 py-3 text-[12px] leading-relaxed"
          style={{
            background: 'rgba(197, 160, 89, 0.12)',
            borderColor: 'rgba(197, 160, 89, 0.4)',
            color: '#785A42',
          }}
        >
          {hint}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <label className="ka-pair-micro text-[10px] font-semibold uppercase px-1">
          桌面端 URL · Desktop URL
        </label>
        <input
          type="url"
          inputMode="url"
          className="ka-pair-input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://192.168.1.50:3000"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>

      {error && (
        <div
          className="ka-pair-card px-4 py-3 text-[12px] leading-relaxed"
          style={{
            background: 'rgba(180, 60, 60, 0.08)',
            borderColor: 'rgba(180, 60, 60, 0.32)',
            color: '#7f2a2a',
          }}
        >
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={submitting}
        className="ka-pair-btn"
      >
        <span className="relative z-10">
          {submitting ? '检查中…' : '保存并连接 · Save & Connect'}
        </span>
      </button>

      <div className="ka-pair-body text-[11.5px] leading-relaxed opacity-70 px-1">
        URL 保存在本机；之后每次启动直接连。可以在「配对页 → 换一个 PC 地址」里改回来。
      </div>
    </div>
  );
}

// Watchdog + auto-retry tuning. The 5s per-probe timeout lives in
// services/httpApi.ts (httpStatus / httpCheckSession wrap fetch with
// AbortController). Any individual refresh() therefore resolves within
// ~10s worst case (status + session back-to-back). The gate adds two
// safety nets on top:
//   WATCHDOG: if we've been stuck in loading/hydrating for this long,
//     drop the user into the pairing view with a diagnostic hint so
//     they stop staring at an opaque spinner.
//   RETRY: while the gate is showing the pairing error card (PC not
//     reachable, token rejected, etc.) we silently re-probe every 10s
//     so the phone auto-heals the moment the PC process + Fastify +
//     mobile-access tunnel come back up. No user interaction needed.
const LOADING_WATCHDOG_MS = 10_000;
const PAIRING_RETRY_INTERVAL_MS = 10_000;
const ELAPSED_TICK_MS = 500;

export const MobilePairingGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<GateState>({ kind: 'loading' });
  const [loadingElapsedMs, setLoadingElapsedMs] = useState(0);
  const loadingStartedAtRef = useRef<number>(Date.now());

  // 在配对阶段（loading / pairing / hydrating）App 还没挂载，
  // useAppViewport 不会跑 → 键盘弹起会露 iOS 灰背景。
  // 由本 gate 顶部接管同一份 viewport sync，bg 用 IntroScreen / splash
  // 同款米色 #f9f7f2，与 MobilePairingChrome 背景对齐。
  // `enabled = state.kind !== 'paired'`：配对完成后让 children → App →
  // useAppViewport 接管，避免两个 hook 同时写 :root / body / #root 互相覆盖。
  useViewportSync({ bg: '#f9f7f2', enabled: state.kind !== 'paired' });

  const refresh = useCallback(async () => {
    loadingStartedAtRef.current = Date.now();
    setLoadingElapsedMs(0);
    // Capacitor native: short-circuit straight to the PC-URL configurator
    // when no URL has been pinned yet. Without this gate, httpStatus()
    // would call `${''}/api/status` → `/api/status` → 404 against the
    // capacitor://localhost asset bundle, which the PWA codepath would
    // misread as "PC unreachable" and dump the user into an empty
    // pairing form they can't fix.
    if (isCapacitorNative() && !getCapacitorPcBaseUrl()) {
      setState({ kind: 'configure-pc-url' });
      return;
    }
    const status = await httpStatus();
    if (!status) {
      setState(isCapacitorNative()
        ? {
            kind: 'configure-pc-url',
            hint: '无法连接所配置的桌面端 URL。请确认 PC 软件已启动，「设置 → 手机访问」处于启用状态，且 IP / 端口正确。',
          }
        : {
            kind: 'pairing',
            hint: '无法连接桌面端。请确认桌面端 App 已启动，且两台设备在同一 Tailscale 账户下。',
          });
      return;
    }
    const sessionOk = await httpCheckSession();
    if (!sessionOk) {
      setState({ kind: 'pairing' });
      return;
    }

    const alreadyHydrated = typeof sessionStorage !== 'undefined'
      && sessionStorage.getItem(HYDRATION_FLAG_KEY) === '1';
    if (alreadyHydrated) {
      try {
        const prefsRes = await httpInvoke<BootstrapPreferencesResponse>('preferences:bootstrap');
        if (prefsRes?.ok && prefsRes.payload) {
          await applyPreferencesPatch(prefsRes.payload, {
            replaceKeyval: true,
            revision: prefsRes.payload.revision,
          });
        }
      } catch (e) {
        console.warn('[MobilePairingGate] lightweight preferences refresh failed (non-fatal):', e);
      }
      setState({ kind: 'paired', hostname: status.hostname });
      return;
    }

    setState({ kind: 'hydrating', hostname: status.hostname, step: 'probing' });
    const result = await hydrateFromPcSnapshot((s) => {
      setState({ kind: 'hydrating', hostname: status.hostname, step: s });
    });
    if (result.ok === false) {
      setState({
        kind: 'pairing',
        hint: `同步失败：${result.error}。请回到桌面端重新生成口令后再试一次。`,
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

  // Tick the loading/hydrating elapsed counter so MobilePairingLoading
  // can show "已等待 X 秒 · Elapsed Xs" — turns an opaque "connecting…"
  // into an obvious "still alive" signal for the user while we wait for
  // the PC handshake.
  useEffect(() => {
    if (state.kind !== 'loading' && state.kind !== 'hydrating') {
      return;
    }
    const interval = setInterval(() => {
      setLoadingElapsedMs(Date.now() - loadingStartedAtRef.current);
    }, ELAPSED_TICK_MS);
    return () => clearInterval(interval);
  }, [state.kind]);

  // Watchdog: if we've been stuck in loading/hydrating past
  // LOADING_WATCHDOG_MS, assume the PC side is non-responsive (Fastify
  // never listened / renderer dispatch hanging) and expose the pairing
  // view with a diagnostic hint so the user can at least re-paste a
  // fresh token. The auto-retry effect below then silently re-probes
  // every 10s; the user does not have to reload.
  //
  // On Capacitor we instead bounce back to the URL-config view so the
  // user can fix a wrong IP / port — re-typing a pairing token won't
  // help if the underlying URL is unreachable.
  useEffect(() => {
    if (state.kind !== 'loading' && state.kind !== 'hydrating') {
      return;
    }
    const timer = setTimeout(() => {
      setState(isCapacitorNative()
        ? {
            kind: 'configure-pc-url',
            hint: '长时间未能连接桌面端。如果换了网络（家 → 公司 / 4G / Tailscale），请在下方更新 PC 地址。',
          }
        : {
            kind: 'pairing',
            hint: '长时间未能连接桌面端。请确认 PC 端软件已打开，且"设置 → 手机访问"处于启用状态。稍后会自动重试。',
          });
    }, LOADING_WATCHDOG_MS);
    return () => clearTimeout(timer);
  }, [state.kind]);

  // Auto-retry while the gate is showing the pairing error card. When
  // the PC software re-opens / mobile access gets re-enabled / the
  // Tailscale tunnel heals, the phone picks it up within 10s and falls
  // through to the hydrating/paired branches on its own. The user's
  // token input in <PairingView /> is preserved across these ticks:
  // setState with a matching shape just re-renders the subtree, React
  // keeps PairingView's local state alive.
  useEffect(() => {
    if (state.kind !== 'pairing') {
      return;
    }
    const interval = setInterval(() => {
      void refresh();
    }, PAIRING_RETRY_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [state.kind, refresh]);

  if (state.kind === 'loading') {
    return (
      <MobilePairingChrome>
        <MobilePairingLoading
          label="正在连接桌面端"
          subLabel="Connecting with your desktop"
          elapsedMs={loadingElapsedMs}
        />
      </MobilePairingChrome>
    );
  }
  if (state.kind === 'configure-pc-url') {
    return (
      <MobilePairingChrome>
        <PcUrlConfigureView
          initialUrl={getCapacitorPcBaseUrl()}
          hint={state.hint}
          onSaved={() => {
            // After save, drop straight back into the loading branch and
            // let the existing refresh chain do its thing (probe status →
            // pairing or hydrating → paired).
            setState({ kind: 'loading' });
            void refresh();
          }}
        />
      </MobilePairingChrome>
    );
  }
  if (state.kind === 'pairing') {
    // Show the "change PC URL" link only on Capacitor — PWA's URL is the
    // page origin and can't be re-edited from inside the app.
    const onEditPcUrl = isCapacitorNative()
      ? () => setState({ kind: 'configure-pc-url' })
      : undefined;
    return (
      <MobilePairingChrome>
        <PairingView onPaired={refresh} onEditPcUrl={onEditPcUrl} hint={state.hint} />
      </MobilePairingChrome>
    );
  }
  if (state.kind === 'hydrating') {
    return (
      <MobilePairingChrome>
        <MobilePairingHydrating steps={hydrationSteps(state.step)} />
      </MobilePairingChrome>
    );
  }
  return <>{children}</>;
};

export default MobilePairingGate;
