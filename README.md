# Kumiko AI

Kumiko AI is an Electron desktop companion app built with React + Vite.
The current app includes local chat state, image handling, configurable AI providers, and a desktop-side local RAG memory stack backed by SQLite.

## Development

Prerequisites:

- Node.js
- npm

Install dependencies:

```bash
npm install
```

Run the desktop app in development mode:

```bash
npm run desktop:dev
```

This starts the Vite dev server on `http://localhost:3000` and then launches Electron against that server.

## Build

Create production desktop artifacts:

```bash
npm run desktop:build
```

Build outputs are written to `release/`.

## Notes

- API keys can be configured inside the app UI.
- The local desktop RAG database is stored in Electron's user data directory.
- Cloud-related flows are currently not part of the active development scope.
- Browser-side Web Push testing now reads the VAPID public key from a root `.env.local` file instead of a hardcoded value.
- If you use the local relay under `ping-server/`, see `ping-server/README.md` and keep the VAPID private key only in local, ignored files.
