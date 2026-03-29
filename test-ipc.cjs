const { app, BrowserWindow, ipcMain } = require('electron');
app.whenReady().then(() => {
  ipcMain.handle('test', () => Buffer.from('hello'));
  const win = new BrowserWindow({ webPreferences: { nodeIntegration: true, contextIsolation: false } });
  win.loadURL('data:text/html,<script>const {ipcRenderer} = require("electron"); ipcRenderer.invoke("test").then(res => { ipcRenderer.send("done", res instanceof Uint8Array, res.buffer instanceof ArrayBuffer, Object.prototype.toString.call(res)); })</script>');
  ipcMain.on('done', (e, a, b, c) => {
    console.log("RESULT:", a, b, c);
    app.quit();
  });
});