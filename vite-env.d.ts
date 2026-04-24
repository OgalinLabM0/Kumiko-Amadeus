/// <reference types="vite/client" />

// F2B.4: dropped VITE_VAPID_PUBLIC_KEY — Web Push pipeline removed.

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Document {
  startViewTransition?: (callback: () => void) => {
    ready: Promise<void>;
    finished: Promise<void>;
    updateCallbackDone: Promise<void>;
  };
}

// A8: vite `define` injects this constant from package.json at build
// time. Read by services/androidUpdaterService.ts to compare against
// the latest GitHub Release tag without an extra runtime fetch.
declare const __APP_VERSION__: string;
