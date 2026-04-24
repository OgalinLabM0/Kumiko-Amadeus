import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './components/App';
// F2B.3: dropped `isElectron`/`waitForRuntimeDetection` — the runtime probe
// existed to detect the legacy PWA-served-by-PC mode. Electron and
// Capacitor each set their own globals synchronously, so we mount React
// directly with no async gate.

// F2B.4: PWA service worker registration removed alongside the
// MobilePairingGate / mobile-PC bridge cleanup (vite-plugin-pwa is also
// being uninstalled). Electron + Capacitor both load assets straight
// from the bundled WebView; neither needs a SW. The historic browser
// PWA install path is no longer supported — we ship Android as a
// proper APK now (in-app updater handles upgrades).

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

// F2B.1/3: dropped the `isMobilePwa() ? <MobilePairingGate><App /> :` fork
// AND the async runtime probe. Both Electron desktop and Capacitor Android
// mount <App /> directly and walk the same onboarding flow
// (IntroScreen → AuthScreen → AIConfigScreen → main app); the Capacitor APK
// runs standalone without a PC pairing step.
root.render(
  <React.StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </React.StrictMode>
);
