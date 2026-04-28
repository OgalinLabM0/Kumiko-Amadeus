// v2.14.28 H6.a — build-time Tailwind config.
//
// Switched from `<script src="https://cdn.tailwindcss.com">` (runtime JIT)
// to PostCSS-time scanning so the production app:
//   - never loads JS from a third-party CDN at runtime,
//   - works fully offline (Electron + Capacitor APK),
//   - lets electron-builder ship a sealed dist/ that can sit behind a
//     strict Content-Security-Policy (no `unsafe-inline` / external
//     script-src).
//
// Filename uses `.cjs` because package.json sets "type": "module".
//
// `content` enumerates every place class names live so Tailwind's purge
// step keeps the output CSS small. Match the project's actual folder
// layout: index.html plus everything in components / hooks / services /
// store / constants / electron / utils that may reference utility classes.
//
// We intentionally do not configure custom theme tokens here — every
// design decision in the codebase already uses Tailwind defaults plus
// inline arbitrary values (e.g. `text-[#c79a2f]`). Keeping config
// minimal lets utility output match what the CDN was producing
// previously, modulo the sealed-build benefit.
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './components/**/*.{ts,tsx,js,jsx}',
    './hooks/**/*.{ts,tsx,js,jsx}',
    './services/**/*.{ts,tsx,js,jsx}',
    './store/**/*.{ts,tsx,js,jsx}',
    './constants/**/*.{ts,tsx,js,jsx}',
    './electron/**/*.{js,cjs}',
    './utils/**/*.{ts,tsx,js,jsx}',
    './index.tsx',
    './App.tsx',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
