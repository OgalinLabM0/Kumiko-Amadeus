import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './components/App';

// PWA service worker registration.
// Kept intentionally even though desktop Electron never hits this branch
// (no `serviceWorker` in Electron's navigator on our current config) and
// Capacitor iOS uses a WebView with its own offline policy. Reserved for
// a future web-build target where offline cache and install-to-homescreen
// actually matter. Do NOT remove as "dead code" without first confirming
// the web build has been abandoned. See also vite.config.ts VitePWA block
// and the `vite-plugin-pwa` / `workbox-precaching` devDeps in package.json.
if ('serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    registerSW({ immediate: true });
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
root.render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);