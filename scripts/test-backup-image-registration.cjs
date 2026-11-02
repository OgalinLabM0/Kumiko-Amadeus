'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync('services/imageService.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
async function exercise(mode, fail) {
  const rows = new Map(), events = [];
  const db = {images:{add:async row=>{assert.ok(!rows.has(row.id)); rows.set(row.id,structuredClone(row));events.push('register');},put:async row=>{rows.set(row.id,structuredClone(row));events.push('put');}}};
  const write = async () => {assert.deepEqual(rows.get('new').sourceIds,['message']);events.push('write');if(fail)throw Error('injected write failure');return {success:true,relativePath:'images/new.png'};};
  const deps = {'./db':{db},'browser-image-compression':{},'../constants/imageQualityConfig':{},'../store':{},'./desktopBackupService':{isDesktopElectron:()=>mode==='desktop'},'./environment':{isCapacitorNative:()=>mode==='android'},'./dataRestoreGate':{},'./mediaWriteFence':{withMediaWriteFence:async (_v,fn)=>{events.push('fence');return fn();}},'./imageFileService':{capacitorImageWrite:write}};
  const box={exports:{}};vm.runInNewContext(code,{module:box,exports:box.exports,require:name=>{if(!(name in deps))throw Error(name);return deps[name];},window:{electronAPI:{invoke:write}},atob,btoa,Uint8Array,ArrayBuffer,console});
  const run=()=>box.exports.saveImageWithId('new','data:image/png;base64,YQ==',true,'version',['message']);
  if(fail) await assert.rejects(run,/injected/); else await run();
  assert.equal(events[0],'fence');assert.equal(events[1],'register');
  if(mode!=='web') assert.equal(events[2],'write');
  assert.deepEqual(rows.get('new').sourceIds,['message']);
  if(fail) assert.equal(rows.get('new').base64Data,'');
}
(async()=>{for(const mode of ['desktop','android','web'])await exercise(mode,false);for(const mode of ['desktop','android'])await exercise(mode,true);console.log('Backup image registration passed: write-ahead provenance, native failures, and web storage.');})().catch(e=>{console.error(e);process.exitCode=1;});
