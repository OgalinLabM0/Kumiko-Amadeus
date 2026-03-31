const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
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
      'app:get-japan-holidays',
      'voice:save',
      'voice:load',
      'voice:delete',
      'voice:list',
      'voice:open-folder',
      'voice:get-storage-info',
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
      'rag:embed',
      'rag:save',
      'rag:search',
      'rag:expand-context',
      'rag:sync-messages',
      'rag:get-messages',
      'rag:get-all',
      'rag:restore',
      'rag:clear-all',
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
      'app:update:quit-and-install'
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
      'app:close-call-notification'
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  on: (channel, listener) => {
    const validChannels = [
      'rag:rebuild:started',
      'rag:rebuild:progress',
      'rag:rebuild:done',
      'rag:rebuild:error',
      'app:auto-zip-progress',
      'app:update-status'
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
      'app:update-status'
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.removeListener(channel, listener);
    }
  }
});
