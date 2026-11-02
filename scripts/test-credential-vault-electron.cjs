'use strict';
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const {spawnSync} = require('node:child_process');
const prefix='kumiko-vault-electron-test-'; const arg='--vault-profile=';
function check(p) { const real=fs.realpathSync(p); if(path.dirname(real)!==fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith(prefix) || fs.lstatSync(p).isSymbolicLink()) throw Error('Unsafe profile'); return real; }
if(!process.versions.electron) {
 const p=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),prefix)); const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE;
 try {const child=spawnSync(require('electron'),[__filename,arg+p],{env,windowsHide:true,encoding:'utf8',timeout:30000});
  const receipt=path.join(check(p),'receipt.json'); const passed=child.status===0 && fs.existsSync(receipt) && JSON.parse(fs.readFileSync(receipt,'utf8')).passed===true;
  if(!passed){console.error('Electron vault receipt missing',child.status,child.stderr);process.exitCode=1;} else console.log('Electron safeStorage fixture encryption and readback passed.');
 } finally {fs.rmSync(check(p),{recursive:true,force:true,maxRetries:3,retryDelay:200});}
} else {
 const {app,safeStorage}=require('electron'); const p=check(process.argv.find(x=>x.startsWith(arg)).slice(arg.length)); app.setPath('userData',p);
 app.whenReady().then(async()=>{const vault=require('../electron/credential-vault.cjs').createCredentialVault({directory:path.join(p,'vault'),safeStorage});
 await vault.setInternalBackupKey('isolated-fixture-key'); if(await vault.getInternalBackupKey()!=='isolated-fixture-key') throw Error('Mismatch');
 if(fs.readFileSync(path.join(p,'vault','backup-key.bin')).includes(Buffer.from('isolated-fixture-key'))) throw Error('Plaintext fixture key persisted');
 fs.writeFileSync(path.join(p,'receipt.json'),JSON.stringify({passed:true})); app.exit(0);}).catch(e=>{console.error(e);app.exit(1)});
}
