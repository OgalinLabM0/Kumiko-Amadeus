'use strict';
// Synthetic end-to-end application harness. It never loads the installed app,
// user profile, user credentials or network model providers.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', 'evaluations', 'agent-application');
const prefix = 'kumiko-agent-application-';
const flag = '--agent-fixture-profile=';
function safeProfile(dir) {
  const real = fs.realpathSync(dir);
  if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith(prefix) || fs.lstatSync(dir).isSymbolicLink()) throw Error('Unsafe fixture profile');
  return real;
}
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, flag + dir], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
  child.on('exit', code => {
    try { fs.rmSync(safeProfile(dir), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
    catch (e) { console.error('Fixture profile retained:', dir, e.message); }
    process.exitCode = code ?? 1;
  });
} else {
  const { app, BrowserWindow, ipcMain, session } = require('electron');
  const profile = safeProfile(process.argv.find(x => x.startsWith(flag)).slice(flag.length));
  app.setPath('userData', profile); app.setPath('sessionData', profile);
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('in-process-gpu');
  fs.mkdirSync(output, { recursive: true });
  const run = 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const folder = path.join(output, run); fs.mkdirSync(folder);
  const save = (name, value) => fs.writeFileSync(path.join(folder, name), JSON.stringify(value, null, 2));
  let seq = 0, stopped = false, win, server, pendingModels = 0, clockPump;
  let rawMessages = [];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const request = async payload => {
    // Fixture-only CDP clock suspension excludes the human agent's response
    // latency from application timeouts; no production timeout is changed.
    pendingModels++;
    try {
    await win.webContents.debugger.sendCommand('Emulation.setVirtualTimePolicy', { policy: 'pause' });
    const id = String(++seq).padStart(4, '0');
    const requestPath = path.join(folder, `${id}.request.json`);
    const responsePath = path.join(folder, `${id}.response.json`);
    const body = { id, createdAt: new Date().toISOString(), rendererClock: 'at most 2ms per 250ms wall time while awaiting actor', params: payload.params };
    fs.writeFileSync(requestPath + '.tmp', JSON.stringify(body, null, 2)); fs.renameSync(requestPath + '.tmp', requestPath);
    console.log('MODEL_REQUEST ' + requestPath);
    while (!stopped) {
      if (fs.existsSync(responsePath)) {
        const response = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
        if (!response || typeof response !== 'object') throw Error('Invalid actor response');
        save(`${id}.consumed.json`, { consumedAt: new Date().toISOString() });
        if (response.error) return { success: false, error: String(response.error) };
        const result = response.result || response;
        return { success: true, result };
      }
      await sleep(200);
    }
    return { success: false, error: 'Fixture stopped' };
    } finally { pendingModels--; }
  };
  const initial = { 'rag:status': { success: true, modelLoaded: false }, 'rag:get-messages': { success: true, messages: [] },
    'rag:get-all': { success: true, vectors: [] }, 'rag:search': { success: true, results: [] },
    'rag:get-by-id': { success: true, row: null }, 'rag:stats': { success: true, vectorCount: 0 },
    'app:get-auto-zip-backup': { success: true, enabled: false }, 'backup:protection-status': { success: true, enabled: false },
    'app:get-data-directory-info': { success: true }, 'app:get-japan-holidays': { success: false, error: 'offline fixture' } };
  const preload = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');
  const allowed = [...preload.matchAll(/'([\w-]+:[\w:-]+)'/g)].map(x => x[1]);
  for (const channel of new Set(allowed)) {
    if (channel === 'credentials:gemini') ipcMain.handle(channel, async (_event, payload) => {
      try { return await request(payload); } catch (error) { return { success: false, error: error.message }; }
    });
    else if (channel === 'rag:sync-messages') ipcMain.handle(channel, async (_event, payload) => {
      const messages = Array.isArray(payload?.messages) ? payload.messages : [];
      if (payload?.replaceAll) rawMessages = [];
      for (const item of messages) {
        const i = rawMessages.findIndex(existing => existing.id === item.id);
        if (i < 0) rawMessages.push(item); else rawMessages[i] = item;
      }
      return { success: true, count: messages.length };
    });
    else if (channel === 'rag:get-messages') ipcMain.handle(channel, async () => ({ success: true, messages: rawMessages }));
    else ipcMain.handle(channel, async () => initial[channel] || { success: false, error: `Isolated fixture does not implement ${channel}` });
  }
  async function snapshot(name) {
    const evidence = await win.webContents.executeJavaScript(`({ text: document.body.innerText.slice(0,30000),
      inputs: [...document.querySelectorAll('input, textarea')].map(e => ({placeholder:e.placeholder, disabled:e.disabled, value:e.value})),
      buttons: [...document.querySelectorAll('button')].map(e => ({title:e.title, aria:e.getAttribute('aria-label'), text:e.innerText, disabled:e.disabled})) })`);
    save(name + '.dom.json', evidence);
    const state = await win.webContents.executeJavaScript(`(async () => {
      const {db} = await import('/services/db.ts');
      const keys = ['kumiko_relative_reminders','kumiko_daily_reminders','kumiko_turn_epoch_v1',
        'user_known_location_v1','kumiko_reminder_occurrences_v1'];
      const keyval = {}; for (const key of keys) keyval[key] = (await db.keyval.get(key))?.value ?? null;
      return {messages: await db.messages.toArray(), keyval};
    })()`);
    save(name + '.database.json', state);
    if (pendingModels) {
      save(name + '.capture-skipped.json', { reason: 'Renderer virtual clock advances only minimally while a model request is pending.' });
      return;
    }
    fs.writeFileSync(path.join(folder, name + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  async function send(text) {
    const value = JSON.stringify(text);
    return win.webContents.executeJavaScript(`(() => {
      const input = [...document.querySelectorAll('input[type="text"],textarea')].find(e => /发送消息|send a message/i.test(e.placeholder) && !e.disabled);
      if (!input) throw Error('Chat input not found');
      const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(input, ${value});
      input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true}));
      input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
      return {placeholder:input.placeholder, sent:${value}};
    })()`);
  }
  app.whenReady().then(async () => {
    const vite = await import('vite');
    const react = (await import('@vitejs/plugin-react')).default;
    server = await vite.createServer({ root, configFile: false, envDir: profile,
      plugins: [react()], define: { __APP_VERSION__: JSON.stringify('0.0.0') },
      optimizeDeps: { entries: ['scripts/fixtures/agent-application.html'], exclude: ['hnswlib-wasm'] },
      server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: { ignored: ['**/*'] } } });
    await server.listen();
    const port = server.httpServer.address().port;
    session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
      const u = new URL(details.url);
      cb({ cancel: ['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol) && !(u.hostname === '127.0.0.1' && Number(u.port) === port) });
    });
    win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { preload: path.join(root, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
    win.webContents.debugger.attach('1.3');
    win.webContents.on('console-message', (_e, _level, message) => console.log('[renderer]', message));
    await win.loadURL(`http://127.0.0.1:${port}/scripts/fixtures/agent-application.html`);
    let ready = false;
    for (let i = 0; i < 120; i++) {
      ready = await win.webContents.executeJavaScript(`!![...document.querySelectorAll('input[type="text"],textarea')].find(e=>/发送消息|send a message/i.test(e.placeholder)&&!e.disabled)`);
      if (ready) break; await sleep(500);
    }
    await snapshot('ready');
    if (!ready) throw Error('Application chat did not become ready; inspect ready.dom.json and ready.png');
    // Fixed midday in Japan: avoid the real wall clock selecting the sleep auto-reply.
    const virtualStart = Date.UTC(2026, 10, 1, 3, 0, 0);
    await win.webContents.debugger.sendCommand('Emulation.setVirtualTimePolicy', { policy: 'pause', initialVirtualTime: virtualStart / 1000 });
    let advancing = false;
    clockPump = setInterval(async () => {
      if (advancing) return;
      advancing = true;
      try { await win.webContents.debugger.sendCommand('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: pendingModels ? 2 : 250 }); }
      catch (error) { console.error('Fixture virtual clock failed:', error); }
      finally { advancing = false; }
    }, 250);
    save('ready.json', { run, profileIsolated: true, nativeRag: 'stub', externalNetwork: 'blocked',
      virtualStart, virtualClock: 'at most 250ms every 250ms wall time; at most 2ms every 250ms while any model request is pending to permit IndexedDB callbacks',
      instructions: 'For a request write <id>.response.json with {"result":{"text":"...","candidates":[{"content":{"role":"model","parts":[{"text":"..."}]}}]}}. For a new synthetic user message write command.json as {"action":"send","text":"..."}; screenshot with {"action":"snapshot","name":"..."}; stop with {"action":"stop"}.' });
    console.log('FIXTURE_READY ' + folder);
    await send('请十分钟后提醒我喝水。');
    while (!stopped) {
      const commandFile = path.join(folder, 'command.json');
      if (fs.existsSync(commandFile)) {
        try {
          const cmd = JSON.parse(fs.readFileSync(commandFile, 'utf8')); fs.unlinkSync(commandFile);
          if (cmd.action === 'send') save('last-command.json', await send(String(cmd.text)));
          else if (cmd.action === 'snapshot' && /^[\w-]+$/.test(cmd.name)) await snapshot(cmd.name);
          else if (cmd.action === 'click' && typeof cmd.selector === 'string') {
            const clicked = await win.webContents.executeJavaScript(`(() => { const e = document.querySelector(${JSON.stringify(cmd.selector)}); if (!e) throw Error('Control not found'); e.click(); return true; })()`);
            save('last-command.json', { clicked, selector: cmd.selector });
          }
          else if (cmd.action === 'clickText' && typeof cmd.text === 'string') {
            const clicked = await win.webContents.executeJavaScript(`(() => { const e = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(cmd.text)}); if (!e) throw Error('Button not found'); e.click(); return true; })()`);
            save('last-command.json', { clicked, text: cmd.text });
          }
          else if (cmd.action === 'stop') stopped = true;
        } catch (e) { save('command-error.json', { error: String(e) }); }
      }
      await sleep(250);
    }
    while (pendingModels) await sleep(100);
    await snapshot('final'); clearInterval(clockPump); await server.close(); win.destroy(); app.exit(0);
  }).catch(async error => { clearInterval(clockPump); console.error(error.stack || error); if (server) await server.close(); app.exit(1); });
}
