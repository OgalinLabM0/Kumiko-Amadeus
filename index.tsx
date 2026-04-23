import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './components/App';
import { MobilePairingGate } from './components/MobilePairingGate';
import { isElectron, isMobilePwa, waitForRuntimeDetection } from './services/environment';

// PWA service worker registration. Kept intentionally even though desktop
// Electron never hits this branch. Phase 7 Part t4_sw_and_notes: enabled
// immediate takeover + a 60s update pull so users stranded on the
// Phase 6-era auto-skip build pick up the new INTRO/AUTH/CONFIG flow
// without having to manually clear Safari storage.
if ('serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        // Auto-apply the waiting worker: our own `sw.ts` calls
        // skipWaiting+clients.claim, so the page refreshes into the new
        // bundle without a prompt. Phase 6 left some phones stranded on
        // the pre-Phase-6 JS (which still had the INTRO auto-skip), and
        // a manual update prompt was easy to miss — hence forced.
        void updateSW(true);
      },
      onRegistered(reg) {
        if (reg) {
          setInterval(() => { void reg.update(); }, 60_000);
        }
      },
    });
  }).catch(() => {});
}

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[FATAL] React render crash:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      // Brand-styled fallback (Phase 7 post-update): instead of the old
      // opaque black/monospace crash card, we show the AMADEUS shell in
      // Kitauji beige + brown with bilingual copy. This way a runtime
      // exception in <App /> looks visually distinct from the pre-React
      // inline splash (same beige but "Booting Ns" counter) — so the
      // user can tell us whether React never ran, ran and crashed, or
      // ran and silently hung. The raw error message / stack stays in a
      // scrollable panel for bug reports.
      const KITAUJI_BROWN = '#785A42';
      const BG_COLOR = '#f9f7f2';
      return (
        <div style={{
          position: 'fixed', inset: 0, background: BG_COLOR, color: KITAUJI_BROWN,
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', padding: '2rem',
          fontFamily: "'Noto Sans SC', 'PingFang SC', 'Plus Jakarta Sans', sans-serif",
          textAlign: 'center',
        }}>
          <img
            src="/favicon-KA.png"
            alt="Kumiko·Amadeus"
            width={72}
            height={72}
            style={{ width: 72, height: 72, objectFit: 'contain', marginBottom: 14 }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ display: 'inline-block', width: '2.5rem', height: 1, background: KITAUJI_BROWN, opacity: 0.4 }} />
            <span style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 10, fontWeight: 600,
              color: 'rgba(120, 90, 66, 0.55)',
              letterSpacing: '0.14em', textTransform: 'uppercase',
            }}>
              AMADEUS · Runtime Error
            </span>
            <span style={{ display: 'inline-block', width: '2.5rem', height: 1, background: KITAUJI_BROWN, opacity: 0.4 }} />
          </div>
          <h1 style={{
            fontFamily: "'Cormorant Garamond', Georgia, serif",
            fontSize: 26, letterSpacing: '0.08em', fontWeight: 700,
            margin: 0, color: KITAUJI_BROWN,
          }}>
            软件启动时发生异常
          </h1>
          <p style={{
            fontSize: 13, letterSpacing: '0.04em', opacity: 0.8,
            marginTop: 6, marginBottom: 18, fontWeight: 300,
          }}>
            Crashed during boot
          </p>
          <pre style={{
            maxWidth: 'min(640px, 86vw)', maxHeight: '40vh', overflow: 'auto',
            background: 'rgba(255, 255, 255, 0.78)',
            border: '1px solid rgba(120, 90, 66, 0.22)',
            padding: 14, borderRadius: 4,
            fontSize: 12, textAlign: 'left', whiteSpace: 'pre-wrap',
            color: '#5b3f2a', fontFamily: "'IBM Plex Mono', monospace",
            width: '100%', boxSizing: 'border-box',
          }}>
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 22, padding: '12px 28px', background: KITAUJI_BROWN,
              color: BG_COLOR, border: 'none', borderRadius: 4, cursor: 'pointer',
              fontFamily: "'Cormorant Garamond', Georgia, serif",
              fontWeight: 600, fontSize: 14, letterSpacing: '0.12em',
              boxShadow: '0 4px 15px rgba(96, 65, 43, 0.22)',
            }}
          >
            重新加载 · Reload
          </button>
        </div>
      );
    }
    return (this as any).props.children;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);

function renderShell() {
  // Phase 4 Part E + Phase 7 unified entry. Desktop Electron renders
  // <App /> directly; mobile PWA wraps App in `MobilePairingGate`, which
  // blocks until the phone has a valid session cookie and then hands
  // off to <App />. The App component walks the full desktop onboarding
  // flow (INTRO → AUTH → CONFIG → APP) on mobile as well — Phase 6
  // removed the previous auto-skip so `pc能用的手机完全都能用` holds
  // by construction. See docs/mobile-parity.md §9 and §10.
  const RenderedShell = isMobilePwa()
    ? <MobilePairingGate><App /></MobilePairingGate>
    : <App />;

  root.render(
    <React.StrictMode>
      <AppErrorBoundary>{RenderedShell}</AppErrorBoundary>
    </React.StrictMode>
  );
}

// Phase 7 Part t3_api_probe: wait for the runtime probe to settle before
// the first render. Desktop Electron resolves synchronously via
// `isElectron()` so there's no extra latency. Mobile PWA in HTTP LAN
// mode (where the sync HTTPS heuristic says "web fallback") still picks
// the right branch on first paint instead of re-rendering after the
// probe dispatches `kumiko:runtime-changed`.
const bootstrap = isElectron()
  ? Promise.resolve()
  : waitForRuntimeDetection().catch(() => undefined);

bootstrap.finally(() => {
  renderShell();
  // Guard against the probe result differing from the sync fallback AFTER
  // first paint (e.g. offline → online transitions). A forced reload is
  // the only way to cleanly re-mount the gate/App tree in the new runtime.
  if (typeof window !== 'undefined' && !isElectron()) {
    window.addEventListener('kumiko:runtime-changed', () => {
      window.location.reload();
    }, { once: true });
  }
});
