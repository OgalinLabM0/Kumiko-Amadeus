import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
// F2B.4: removed `vite-plugin-pwa` import. PWA bridge has been deleted —
// the only distribution targets are Electron (which loads from disk) and
// Capacitor (which packages dist/ directly into the APK and uses its own
// WebView offline policy). Service worker / web manifest are no longer
// generated, and the matching dependency entries are dropped from
// package.json.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('./package.json');
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      base: './',
      // A8: bake the package.json version into the bundle so the in-app
      // updater (services/androidUpdaterService.ts on Android,
      // electron/app-updater.cjs on PC) can compare locally without
      // bundling a fetch-package-json round-trip. Stringified so Vite's
      // define replaces every `__APP_VERSION__` literal at build time
      // with the JSON-encoded string `"2.12.0"`.
      define: {
        __APP_VERSION__: JSON.stringify(pkg.version || '0.0.0'),
      },
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [
        react(),
        // F2B.4: VitePWA plugin removed. Capacitor packages dist/ directly
        // into the APK and Electron loads it from disk — neither needs a
        // service worker or a web app manifest. Icons under public/ are
        // still produced by `scripts/build-pwa-icons.cjs` because Capacitor
        // copies them as raw assets via capacitor-assets.
      ],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      },
      build: {
        rollupOptions: {
          output: {
            manualChunks(id) {
              const n = id.split(path.sep).join('/');

              if (n.includes('/services/geminiService.ts') ||
                  n.includes('/services/localRagService.ts') ||
                  n.includes('/services/ragMemoryFilter.ts') ||
                  n.includes('/services/temporalEpisodeService.ts') ||
                  n.includes('/services/desktopBackupService.ts')) {
                return 'memory-engine';
              }

              if (n.includes('/components/SettingsPanel.tsx') ||
                  n.includes('/components/settings/')) {
                return 'settings-panel';
              }

              if (!n.includes('node_modules')) return;

              if (n.includes('/react-dom/') || n.includes('/react/') || n.includes('/scheduler/')) {
                return 'react-vendor';
              }

              if (n.includes('lucide-react')) {
                return 'ui-icons';
              }

              if (n.includes('framer-motion')) {
                return 'motion-vendor';
              }

              if (n.includes('@google/genai')) {
                return 'llm-vendor';
              }

              if (n.includes('@xenova/transformers') || n.includes('onnxruntime-web')) {
                return 'rag-vendor';
              }

              if (n.includes('jszip') || n.includes('file-saver') || n.includes('browser-image-compression')) {
                return 'media-vendor';
              }

              return 'vendor';
            }
          }
        }
      }
    };
});
