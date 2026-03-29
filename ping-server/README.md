# Ping Server

This folder contains a tiny local Web Push relay for browser-side wake-up testing.

The repository no longer ships any VAPID keys. You must provide your own local keys before starting the server.

## Setup

1. Copy `ping-server/.env.example` to `ping-server/.env.local`.
2. Fill in:
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `VAPID_SUBJECT`
3. In the project root, copy `.env.example` to `.env.local`.
4. Put the same public key into `VITE_VAPID_PUBLIC_KEY`.

## Run

Install dependencies in this folder and start the relay:

```bash
npm install
npm start
```

The default port is `8080`.

## Important

- The browser client only needs the public key.
- The private key must stay local and must never be committed.
- If you rotate the VAPID key pair, all existing browser push subscriptions become invalid and must be subscribed again.
