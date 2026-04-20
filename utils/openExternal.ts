// utils/openExternal.ts
//
// Single helper for opening URLs in the user's system browser from either
// the Electron renderer or the mobile PWA build.
//
// Electron: bare `<a target="_blank">` navigates inside the BrowserWindow
// by default, which is almost never what we want for admin consoles or
// third-party docs. We route through the `app:open-external` IPC channel
// which calls `shell.openExternal` in the main process, so links open in
// the user's real browser (Chrome / Safari / etc.).
//
// PWA: no Electron bridge available, so we fall back to window.open with
// `_blank` + `noopener,noreferrer`. On iOS PWAs (launched from home
// screen) this defers to Safari — exactly what we want.
//
// History: both InternetSearchSection and TtsConfigSection had their own
// inline copies of this logic. Any new section that needs it should
// import from here instead.

export async function openExternalUrl(url: string): Promise<void> {
  if (typeof url !== 'string' || !url) return;

  if (typeof window !== 'undefined') {
    const ipc = (window as unknown as { electronAPI?: { invoke?: (c: string, d: unknown) => Promise<unknown> } })
      .electronAPI;
    if (ipc?.invoke) {
      try {
        await ipc.invoke('app:open-external', { url });
        return;
      } catch {
        // Fall through to window.open so the user isn't stranded if the
        // IPC handler rejected for some transient reason.
      }
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
