'use strict';
// Isolated production renderer smoke test; never starts electron-main.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'artifacts', 'verification', 'final-20261101');
const receiptPath = path.join(out, 'production-boot-receipt.json');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const tmpRoot = fs.realpathSync(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tmpRoot, 'kumiko-production-boot-'));
  const nonce = crypto.randomUUID();
  let code = 1;
  try {
    const env = { ...process.env, KUMIKO_BOOT_PROFILE: profile, KUMIKO_BOOT_NONCE: nonce };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true, timeout: 60000 });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(`Electron test exited with status ${child.status}`);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (receipt.nonce !== nonce || receipt.passed !== true) throw new Error('Current test did not produce a matching passing receipt.');
    code = 0;
  } catch (error) {
    console.error('Production boot test failed:', error.message);
  } finally {
    // Only remove the exact directory created above, after resolving both it
    // and its parent. Refuse reparse points or any changed destination.
    const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    try {
      const stat = fs.lstatSync(profile);
      const resolved = fs.realpathSync(profile);
      if (!path.isAbsolute(profile) || !stat.isDirectory() || stat.isSymbolicLink()
        || !same(resolved, profile) || !same(path.dirname(resolved), tmpRoot)
        || !path.basename(resolved).startsWith('kumiko-production-boot-')) throw new Error('Temporary profile identity changed; cleanup refused.');
      fs.rmSync(profile, { recursive: true });
    } catch (error) {
      console.error('Temporary profile cleanup failed:', error.message);
      code = 1;
    }
  }
  process.exitCode = code;
} else {
const { app, BrowserWindow, ipcMain, session } = require('electron');
const profile = process.env.KUMIKO_BOOT_PROFILE;
const nonce = process.env.KUMIKO_BOOT_NONCE;
if (!profile || !path.isAbsolute(profile) || !nonce) throw new Error('Run this test through its Node entry point.');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const errors = [], blocked = [], calls = [];
let win;
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const preload = path.join(root, 'preload.cjs');
  const source = fs.readFileSync(preload, 'utf8');
  const channels = [...source.matchAll(/'([a-z]+:[a-z0-9:-]+)'/g)].map(x => x[1]);
  for (const channel of new Set(channels)) ipcMain.handle(channel, () => { calls.push(channel); return { success: false, error: 'Isolated test substitute' }; });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const deny = !['file:', 'data:', 'blob:', 'devtools:'].includes(url.protocol);
    if (deny) blocked.push(details.url);
    callback({ cancel: deny });
  });
  win = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) errors.push(message); });
  win.webContents.on('render-process-gone', (_event, details) => errors.push('renderer gone: ' + JSON.stringify(details)));
  win.webContents.on('did-fail-load', (_event, code, description, url, mainFrame) => { if (mainFrame) errors.push(`load ${code}: ${description} ${url}`); });
  await win.loadFile(path.join(root, 'dist', 'index.html'));
  await new Promise(resolve => setTimeout(resolve, 4000));
  const before = await win.webContents.executeJavaScript(`({text: document.body.innerText, buttons: [...document.querySelectorAll('button')].map(x => x.innerText.trim()), root: document.querySelector('#root')?.innerHTML || '', preload: !!window.electronAPI})`);
  await fs.promises.writeFile(path.join(out, 'production-boot-initial.html'), await win.webContents.executeJavaScript('document.documentElement.outerHTML'));
  await fs.promises.writeFile(path.join(out, 'production-boot-initial.png'), (await win.webContents.capturePage()).toPNG());
  const clicked = await win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('button')].find(x => /连接|connect/i.test(x.innerText)); if (!b) return false; b.click(); return true; })()`);
  await new Promise(resolve => setTimeout(resolve, 2200));
  const after = await win.webContents.executeJavaScript(`({text: document.body.innerText, buttons: [...document.querySelectorAll('button')].map(x => x.innerText.trim()), inputs: [...document.querySelectorAll('input')].map(x => ({type:x.type, placeholder:x.placeholder})), root: document.querySelector('#root')?.innerHTML || '', preload: !!window.electronAPI})`);
  await fs.promises.writeFile(path.join(out, 'production-boot-identity.html'), await win.webContents.executeJavaScript('document.documentElement.outerHTML'));
  await fs.promises.writeFile(path.join(out, 'production-boot-identity.png'), (await win.webContents.capturePage()).toPNG());
  const version = require(path.join(root, 'package.json')).version;
  const versionVisible = before.text.includes(`AMADEUS SYSTEM [Ver ${version}]`);
  const passed = before.preload && versionVisible && clicked && after.inputs.some(i => i.type === 'password') && !errors.some(x => /Uncaught|ReferenceError|TypeError|SyntaxError/i.test(x));
  const receipt = { nonce, passed, version, versionVisible, profile: 'fresh temporary profile', externalRequestsBlocked: blocked, ipcSubstitutesCalled: calls, clickedConnect: clicked, initialText: before.text, initialButtons: before.buttons, identityText: after.text, identityInputs: after.inputs, errors };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
  app.exit(passed ? 0 : 1);
}
app.whenReady().then(main).catch(error => { console.error(error); fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(receiptPath, JSON.stringify({ nonce, passed: false, fatal: String(error), errors, blocked }, null, 2)); app.exit(1); });
}
