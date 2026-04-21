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
            // Phase 5 Part C + Phase 7 Part t1_icons: complete PWA manifest.
            //
            // - `name` / `short_name` / `description` power the "Add to
            //   Home Screen" prompt + the installed app entry on iOS /
            //   Android launchers.
            // - `id: "/"` keeps iOS from treating the Safari tab and the
            //   installed PWA as two separate apps (Phase 7).
            // - `theme_color` matches the desktop UI's primary accent so
            //   Android's status bar blends into the chat gradient.
            // - `background_color` only shows between splash and first
            //   paint; same warm cream as IntroScreen so the hand-off is
            //   invisible.
            // - `display: 'standalone'` opts into the native-like
            //   container; iOS 16.4+ requires standalone mode for Web
            //   Push, so this is non-negotiable.
            // - `orientation: 'portrait'` keeps iPads from forcing
            //   landscape and scrambling the mobile chat layout.
            // - Icon set:
            //   * `any` purpose (icon-192 / icon-512 / apple-touch-icon-180):
            //     pure resize of public/favicon-KA.png — no padding, no
            //     background, alpha preserved. Visually identical to the
            //     PC Electron tray / installer icon.
            //   * `maskable` purpose (icon-192-maskable / icon-512-maskable):
            //     independent 20% safe-zone variants with a theme-color
            //     background, so Android adaptive icon masks (circle /
            //     rounded square / squircle) don't clip the logo edge.
            //   All files are produced by `scripts/build-pwa-icons.cjs`,
            //   wired through `package.json` prebuild so `npm run build`
            //   always refreshes them before the manifest is hashed.
            name: 'Kumiko·Amadeus',
            short_name: 'Kumiko',
            id: '/',
            description: 'Private AI companion synced with your desktop — chat, reminders, and memory, available on your phone.',
            theme_color: '#f9f7f2',
            background_color: '#f9f7f2',
            display: 'standalone',
            orientation: 'portrait',
            start_url: '/',
            scope: '/',
            lang: 'zh',
            dir: 'ltr',
            categories: ['productivity', 'utilities', 'lifestyle'],
            icons: [
              {
                src: 'icon-192.png',
                sizes: '192x192',
                type: 'image/png',
                purpose: 'any',
              },
              {
                src: 'icon-512.png',
                sizes: '512x512',
                type: 'image/png',
                purpose: 'any',
              },
              {
                src: 'icon-192-maskable.png',
                sizes: '192x192',
                type: 'image/png',
                purpose: 'maskable',
              },
              {
                src: 'icon-512-maskable.png',
                sizes: '512x512',
                type: 'image/png',
                purpose: 'maskable',
              },
              {
                src: 'apple-touch-icon-180.png',
                sizes: '180x180',
                type: 'image/png',
                purpose: 'any',
              },
            ],
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
