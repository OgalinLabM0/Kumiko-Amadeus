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
      return (
        <div style={{
          position: 'fixed', inset: 0, background: '#111', color: '#e0e0e0',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', fontFamily: 'monospace', padding: '2rem',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠</div>
          <h1 style={{ fontSize: 20, color: '#f87171', marginBottom: 8 }}>
            Kumiko·Amadeus crashed
          </h1>
          <pre style={{
            maxWidth: '80vw', maxHeight: '40vh', overflow: 'auto',
            background: '#1e1e1e', padding: 16, borderRadius: 8,
            fontSize: 12, textAlign: 'left', whiteSpace: 'pre-wrap',
            color: '#fbbf24',
          }}>
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 24, padding: '10px 24px', background: '#7c3aed',
              color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer',
              fontSize: 14,
            }}
          >
            Reload
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
