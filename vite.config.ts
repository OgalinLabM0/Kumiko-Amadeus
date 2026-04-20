import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      base: './',
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [
        react(),
        // VitePWA config + the `vite-plugin-pwa` / `workbox-precaching` devDeps
        // are kept intentionally for a future web-build target. Desktop Electron
        // ignores the generated service worker and manifest; Capacitor iOS uses
        // its own WebView offline policy, so neither current distribution channel
        // depends on this plugin. See also the matching comment above the
        // serviceWorker registration in index.tsx. Do NOT remove as "dead
        // dependencies" without first confirming the web build has been abandoned.
        VitePWA({
          strategies: 'injectManifest',
          srcDir: '',
          filename: 'sw.ts',
          registerType: 'autoUpdate',
          injectManifest: {
            injectionPoint: undefined
          },
          manifest: {
            name: 'Kumiko Amadeus',
            short_name: 'Kumiko',
            theme_color: '#ffffff',
            background_color: '#ffffff',
            display: 'standalone',
            icons: [
              {
                src: 'icon-192.png',
                sizes: '192x192',
                type: 'image/png'
              },
              {
                src: 'icon-512.png',
                sizes: '512x512',
                type: 'image/png'
              }
            ]
          },
          devOptions: {
            enabled: true,
            type: 'module'
          }
        })
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
