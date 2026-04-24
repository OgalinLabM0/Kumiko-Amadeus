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
      'app:update:cancel-download',
      'app:update:quit-and-install',
      // v2.10.1 download-cache inspection + manual cleanup. Desktop only.
      'app:update:get-cache-info',
      'app:update:open-cache-folder',
      'app:update:clear-cache',
      'genie:start',
      'genie:stop',
      'genie:status',
      'genie:pick-sovits-dir',
      'genie:pick-sovits-python',
      'genie:test-sovits-python',
      // F2B.4: dropped mobile-access:* + fs:*-mobile-browse-root +
      // backup:*-desktop-file channels — the Fastify mobile-bridge,
      // Tailscale cert helper, and remote-file sandbox have all been
      // deleted along with the rest of the PWA pairing path.
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
      // F2B.4: dropped 'mobile-api-proxy-reply' + 'mobile-event-broadcast'
      // — Fastify mobile bridge gone.
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
      // F2B.4: dropped 'mobile-api-proxy' — Fastify mobile bridge gone.
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
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.removeListener(channel, listener);
    }
  }
});

// Tiny runtime environment flag. The renderer uses this to detect
// Electron (vs Capacitor / web preview). Capacitor sets `window.Capacitor`
// itself; web preview leaves both undefined.
contextBridge.exposeInMainWorld('__KUMIKO_ENV__', {
  runtime: 'electron',
  platform: process.platform,
});
