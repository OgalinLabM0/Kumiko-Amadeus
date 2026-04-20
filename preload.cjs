const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Exposed so the renderer can branch UI by host OS (e.g. show the Linux-specific
  // "SoVITS Python interpreter" field only on Linux). Equivalent to process.platform
  // in the main process — stringly typed so no Node APIs leak into the renderer.
  platform: process.platform,
  invoke: (channel, data) => {
    const validChannels = [
      'quit-app',
      'app:get-data-directory-info',
      'app:set-background-throttling',
      'app:refocus-webcontents',
      'app:open-external',
      'app:pick-data-directory',
      'app:migrate-data-directory',
      'app:reset-data-directory',
      'app:get-weather',
      'app:get-historical-weather',
      'app:get-japan-holidays',
      'voice:save',
      'voice:load',
      'voice:delete',
      'voice:list',
      'voice:open-folder',
      'voice:get-storage-info',
      'images:save',
      'images:load',
      'images:delete',
      'images:list',
      'images:open-folder',
      'images:get-storage-info',
      'ringtone:save',
      'ringtone:load',
      'ringtone:delete',
      'ringtone:get-info',
      'ringtone:open-folder',
      'backup:pick-save-file',
      'backup:pick-open-file',
      'backup:write-file',
      'backup:read-file',
      'backup:get-file-info',
      'backup:parse-import-file',
      'backup:build-zip-from-payload',
      'rag:embed',
      'rag:save',
      'rag:search',
      'rag:expand-context',
      'rag:sync-messages',
      'rag:get-messages',
      'rag:get-all',
      'rag:restore',
      'rag:clear-all',
      // `rag:clear-message-vectors` has no renderer wrapper in
      // services/localRagService.ts as of Plan 4 — the main-process handler
      // and this allowlist entry are kept as a latent capability for a
      // future per-message RAG cleanup feature. Do not remove without
      // also removing the handler in electron-rag.cjs.
      'rag:clear-message-vectors',
      'rag:rebuild:start',
      'rag:rebuild:status',
      'rag:stats',
      'rag:status',
      'app:set-auto-zip-backup',
      'app:get-auto-zip-backup',
      'app:update:get-state',
      'app:update:check',
      'app:update:download',
      'app:update:quit-and-install',
      'genie:start',
      'genie:stop',
      'genie:status',
      'genie:pick-sovits-dir',
      'genie:pick-sovits-python',
      'genie:test-sovits-python',
      'mobile-access:get-state',
      'mobile-access:get-pairing-token',
      'mobile-access:enable',
      'mobile-access:disable',
      'mobile-access:rotate-token',
      'mobile-access:revoke-sessions'
      // Note: 'app:set-bg-color' intentionally omitted here — it's a fire-and-forget
      // one-way signal handled by ipcMain.on in the main process, NOT a request/response
      // handler. Calling electronAPI.invoke('app:set-bg-color', ...) used to land here but
      // would hang forever since no ipcMain.handle exists. Stay on send() only via setBgColor.
    ];
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, data);
    }
    return Promise.reject(new Error(`Unauthorized IPC invoke channel: ${channel}`));
  },
  send: (channel, data) => {
    const validChannels = [
      'show-window',
      'app:update-unread-state',
      'app:send-notification',
      'app:send-call-notification',
      'app:close-call-notification',
      'app:set-bg-color',
      // Renderer → main reply for mobile HTTP bridge. Phase 1 pair: the
      // renderer listens on 'mobile-api-proxy' (see on() below), does the
      // work locally via existing services, and sends the result back
      // through this channel. See electron/server/ipc-bridge.cjs.
      'mobile-api-proxy-reply',
      // Phase 2 fan-out: renderer emits state-change events here and the
      // main-process ws-broadcast.cjs relays them to every connected
      // phone websocket. Events are fire-and-forget; if no phone is
      // connected, the broadcaster drops them silently.
      'mobile-event-broadcast'
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  setBgColor: (color) => ipcRenderer.send('app:set-bg-color', color),
  on: (channel, listener) => {
    const validChannels = [
      'rag:rebuild:started',
      'rag:rebuild:progress',
      'rag:rebuild:done',
      'rag:rebuild:error',
      'app:auto-zip-progress',
      'app:update-status',
      'genie:status-changed',
      'mobile-api-proxy'
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, listener);
    }
  },
  removeListener: (channel, listener) => {
    const validChannels = [
      'rag:rebuild:started',
      'rag:rebuild:progress',
      'rag:rebuild:done',
      'rag:rebuild:error',
      'app:auto-zip-progress',
      'app:update-status',
      'genie:status-changed',
      'mobile-api-proxy'
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.removeListener(channel, listener);
    }
  }
});

// Separate bridge for a tiny runtime environment flag. The renderer uses
// this to decide whether to call `window.electronAPI` directly (desktop
// Electron) or fall back to HTTP via services/httpApi.ts (mobile PWA).
// Keeping it off electronAPI avoids suggesting anything else lives here.
contextBridge.exposeInMainWorld('__KUMIKO_ENV__', {
  runtime: 'electron',
  platform: process.platform,
});
