'use strict';
if (!process.versions.electron) {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kumiko-clock-fixture-'));
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  const r = require('node:child_process').spawnSync(require('electron'), [__filename, '--profile=' + dir], { env, encoding: 'utf8', timeout: 20000 });
  process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
  if (path.dirname(fs.realpathSync(dir)) !== fs.realpathSync(os.tmpdir()) || !path.basename(dir).startsWith('kumiko-clock-fixture-')) throw Error('Unsafe fixture');
  fs.rmSync(dir, {recursive:true,force:true}); process.exit(r.status === 0 ? 0 : 1);
} else {
  const { app, BrowserWindow } = require('electron');
  const profile = process.argv.find(v=>v.startsWith('--profile='))?.slice(10);
  if (!profile) throw Error('Isolated profile required');
  app.setPath('userData',profile); app.setPath('sessionData',profile);
  app.whenReady().then(async () => {
    const w = new BrowserWindow({ show: false }); w.webContents.debugger.attach('1.3');
    await w.loadURL('data:text/html,<html></html>');
    await w.webContents.executeJavaScript('window.count=0; setInterval(()=>window.count++,1000)');
    await w.webContents.debugger.sendCommand('Emulation.setVirtualTimePolicy', {policy:'pause',initialVirtualTime:Date.now()/1000});
    for (let i=0;i<20;i++) { await w.webContents.debugger.sendCommand('Emulation.setVirtualTimePolicy', {policy:'advance',budget:250}); await new Promise(r=>setTimeout(r,250)); }
    const count=await w.webContents.executeJavaScript('window.count');
    console.log(JSON.stringify({count})); w.destroy(); app.exit(count>=3 && count<=7 ? 0:1);
  }).catch(e=>{ console.error(e); app.exit(1); });
}
