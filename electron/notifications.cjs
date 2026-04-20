// OS-level notification + call banner + unread badge state machine.
// Extracted from electron-main.cjs (Plan 9 SubPhase 3.4).
//
// Owns three user-visible surfaces that have to stay in sync with
// each other:
//
//   1. Native OS `Notification` (the "你收到一条新信息" toast) —
//      driven by `app:send-notification`.
//   2. In-app "来电中…" banner — a borderless, always-on-top
//      `BrowserWindow` rendered in the bottom-right corner via
//      `app:send-call-notification` / `app:close-call-notification`.
//      Clicking or closing the banner re-focuses the main window.
//   3. Unread-message shell state (window title prefix "(N) Kumiko…",
//      window flashFrame + tray tooltip "· N 条未读来信"), applied by
//      `applyUnreadShellState()` and updated from the renderer via
//      `app:update-unread-state`.
//
// `show-window` is also housed here because it shares the same
// "focus/restore the main window" primitive used everywhere in this
// module.

const fs = require('fs');
const path = require('path');
const { BrowserWindow, Notification, screen } = require('electron');

// Injected via setNotificationWindow(mainWindow) from electron-main.cjs
// during createWindow, same setter pattern as setBackupDialogParent
// / setGenieDialogParent / setAutoZipProgressTarget.
let mainWin = null;

// Injected via setNotificationTray(tray) from electron-main.cjs at the
// tail of createTray's success branch. Separate setter because tray
// lifecycle is conditional (it can fail silently on Linux/macOS if the
// icon asset is missing, in which case we just never register the
// tooltip side of applyUnreadShellState).
let trayRef = null;

// Module-private state.
let unreadMessageCount = 0;
let callNotifWindow = null;

function setNotificationWindow(win) {
  mainWin = win || null;
}

function setNotificationTray(trayInstance) {
  trayRef = trayInstance || null;
}

function focusMainWindow() {
  if (mainWin && !mainWin.isDestroyed()) {
    if (mainWin.isMinimized()) mainWin.restore();
    if (!mainWin.isVisible()) mainWin.show();
    mainWin.focus();
  }
}

function applyUnreadShellState() {
  const baseTitle = 'Kumiko·Amadeus';
  const nextTitle = unreadMessageCount > 0 ? `(${unreadMessageCount}) ${baseTitle}` : baseTitle;

  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.setTitle(nextTitle);
    mainWin.flashFrame(unreadMessageCount > 0);
  }

  if (trayRef) {
    const tooltip = unreadMessageCount > 0
      ? `Kumiko·Amadeus 后台守护中 · ${unreadMessageCount} 条未读来信`
      : 'Kumiko·Amadeus 后台守护中...';
    trayRef.setToolTip(tooltip);
  }
}

function handleShowWindow() {
  if (mainWin) {
    if (mainWin.isMinimized()) mainWin.restore();
    if (!mainWin.isVisible()) mainWin.show();
    mainWin.focus();
    mainWin.flashFrame(false);
  }
}

function handleSendNotification(_event, payload = {}) {
  try {
    if (Notification.isSupported()) {
      const notif = new Notification({
        title: payload.title || 'Kumiko Amadeus',
        body: payload.body || '',
        icon: payload.icon || path.join(__dirname, '..', 'public', 'CCA-P2.png'),
        silent: false,
        urgency: 'critical'
      });
      notif.on('click', () => {
        if (mainWin) {
          if (mainWin.isMinimized()) mainWin.restore();
          if (!mainWin.isVisible()) mainWin.show();
          mainWin.focus();
        }
      });
      notif.show();
    }
  } catch (e) {
    console.error('[Notification] Failed to show:', e);
  }
}

function handleSendCallNotification(_event, payload = {}) {
  try {
    if (callNotifWindow && !callNotifWindow.isDestroyed()) callNotifWindow.close();
    const display = screen.getPrimaryDisplay();
    const { width: sw, height: sh } = display.workAreaSize;
    const nw = 360, nh = 120;
    callNotifWindow = new BrowserWindow({
      width: nw, height: nh,
      x: sw - nw - 16, y: sh - nh - 16,
      frame: false, transparent: true, alwaysOnTop: true,
      resizable: false, skipTaskbar: true, focusable: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    const title = (payload.title || 'Incoming Call').replace(/'/g, "\\'").replace(/\n/g, ' ');
    const body = (payload.body || '').replace(/'/g, "\\'").replace(/\n/g, ' ');
    let avatarBase64 = '';
    try { avatarBase64 = fs.readFileSync(path.join(__dirname, '..', 'public', 'CCA-P2.png')).toString('base64'); } catch(_e) {}
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{font-family:'Segoe UI',system-ui,sans-serif;background:rgba(20,20,30,0.95);color:#fff;border-radius:14px;overflow:hidden;cursor:pointer;user-select:none;border:1px solid rgba(255,255,255,0.1)}
      .c{display:flex;align-items:center;gap:14px;padding:18px 20px;height:100%}
      .avatar{width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#a855f7,#ec4899);display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;flex-shrink:0;overflow:hidden}
      .avatar img{width:100%;height:100%;object-fit:cover}
      .info{flex:1;min-width:0}
      .title{font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .body{font-size:11px;color:rgba(255,255,255,0.6);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .ring{font-size:11px;color:#a855f7;margin-top:4px;animation:blink 1.2s infinite}
      @keyframes blink{0%,100%{opacity:1}50%{opacity:0.4}}
    </style></head><body onclick="window.close()"><div class="c">
      <div class="avatar"><img src="data:image/png;base64,${avatarBase64}" onerror="this.style.display='none';this.parentElement.innerText='久'"/></div>
      <div class="info"><div class="title">${title}</div><div class="body">${body}</div><div class="ring">📞 来电中...</div></div>
    </div></body></html>`;
    callNotifWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    callNotifWindow.on('closed', () => {
      focusMainWindow();
      callNotifWindow = null;
    });
  } catch (e) {
    console.error('[CallNotification] Failed:', e);
  }
}

function handleCloseCallNotification() {
  if (callNotifWindow && !callNotifWindow.isDestroyed()) {
    callNotifWindow.close();
    callNotifWindow = null;
  }
}

function handleUpdateUnreadState(_event, payload = {}) {
  const nextCount = Number(payload.count);
  unreadMessageCount = Number.isFinite(nextCount) && nextCount > 0 ? Math.floor(nextCount) : 0;
  applyUnreadShellState();
}

module.exports = {
  setNotificationWindow,
  setNotificationTray,
  applyUnreadShellState,
  handleShowWindow,
  handleSendNotification,
  handleSendCallNotification,
  handleCloseCallNotification,
  handleUpdateUnreadState,
};
