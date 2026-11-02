'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'kumiko-memory-files-'));
const repo = path.resolve(__dirname, '..');
const handlers = new Map(), config = new Map();
const profile = path.join(dir, 'profile'), sync = path.join(dir, 'sync'), unrelated = path.join(dir, 'outside');
for (const folder of [profile, sync, unrelated, path.join(profile,'images'), path.join(profile,'voice')]) fs.mkdirSync(folder, { recursive: true });
const syncFile = path.join(sync, 'selected.json');
let owner = true;
let replaceAfterFirstCheck=null, checkReads=0, simulateLinkedDirectory=false;
const fsFixture=Object.assign({},fs,{createReadStream(file,...args){
  if(replaceAfterFirstCheck && ++checkReads===2){fs.writeFileSync(replaceAfterFirstCheck,'replacement after earlier hash');replaceAfterFirstCheck=null;}
  return fs.createReadStream(file,...args);
},lstatSync(file,...args){const stat=fs.lstatSync(file,...args);if(simulateLinkedDirectory&&file===path.join(profile,'images')) return {isDirectory:()=>true,isSymbolicLink:()=>true};return stat;}});
const moduleBox = { exports: {} };
const media = {
  handleImagesDelete: (_e, {imageId}) => { const f = path.join(profile,'images',imageId+'.png'); if(fs.existsSync(f))fs.unlinkSync(f); return {success:true}; },
  handleVoiceDelete: (_e, {messageId}) => { const f = path.join(profile,'voice',messageId+'.mp3'); if(fs.existsSync(f))fs.unlinkSync(f); return {success:true}; },
  handleImagesList: () => ({success:true,files:fs.readdirSync(path.join(profile,'images')).map(f=>({id:f.slice(0,-4)}))}),
  handleVoiceList: () => ({success:true,files:fs.readdirSync(path.join(profile,'voice')).map(f=>({id:f.slice(0,-4)}))}),
};
const imports = {
  'node:fs': fsFixture,
  electron: { app: { getPath: () => profile } },
  './backup-files.cjs': { assertBackupPathAllowed(p) { if(p!==syncFile)throw Error('Not authorized'); } },
  '../electron-rag.cjs': { isMemoryMaintenanceOwner: (_e,id) => owner&&id==='correction' },
  './media-files.cjs': media, './user-config.cjs': {writeConfigValue:(k,v)=>config.set(k,v)},
};
vm.runInNewContext(fs.readFileSync(path.join(repo,'electron/memory-maintenance.cjs'),'utf8'), {module:moduleBox,exports:moduleBox.exports,require:id=>imports[id]||require(id),console});
(async()=>{
  for(const f of [syncFile,path.join(sync,'kumiko_backup_auto.zip'),path.join(profile,'kumiko_backup_old.json'),path.join(unrelated,'export.json')])fs.writeFileSync(f,'fixture private content');
  for(const f of ['shared','target'])fs.writeFileSync(path.join(profile,'images',f+'.png'),'fixture image');
  fs.writeFileSync(path.join(profile,'voice','target.mp3'),'fixture voice');
  const api=moduleBox.exports;api.register({handle:(name,fn)=>handlers.set(name,fn)});
  const inventory=await api.inventory(syncFile);assert.equal(inventory.length,3);
  fs.writeFileSync(path.join(profile,'images','orphan.webp'),'orphan');
  fs.writeFileSync(path.join(profile,'voice','orphan.mp3'),'orphan');
  fs.writeFileSync(path.join(profile,'images','unknown.txt'),'untouched');
  const listed=await handlers.get('memory:managed-backups')({}, {syncPath:syncFile});
  assert.equal(listed.success,true);assert.deepEqual([...listed.imageIds],['orphan','shared','target']);assert.deepEqual([...listed.voiceIds],['orphan','target']);
  simulateLinkedDirectory=true;
  assert.equal((await handlers.get('memory:managed-backups')({}, {syncPath:syncFile})).success,false,'linked media directory must be rejected');
  simulateLinkedDirectory=false;
  assert.ok(!inventory.some(item=>item.path.startsWith(unrelated)));
  const purge=handlers.get('memory:purge-files');
  const payload={id:'correction',syncPath:syncFile,backups:inventory,imageIds:['target'],voiceIds:['target']};
  owner=false;assert.equal((await purge({},payload)).success,false);owner=true;
  fs.writeFileSync(syncFile,'changed after preview');assert.equal((await purge({},payload)).success,false);
  assert.ok(fs.existsSync(path.join(profile,'images','target.png')),'no deletion before all fingerprints pass');
  payload.backups=await api.inventory(syncFile);
  assert.equal((await purge({}, {...payload,backups:[{path:path.join(unrelated,'export.json'),size:23,digest:'bad'}]})).success,false);
  replaceAfterFirstCheck=payload.backups[0].path;checkReads=0;
  assert.equal((await purge({},payload)).success,false,'replacement after an earlier hash must not be deleted');
  assert.ok(fs.existsSync(payload.backups[0].path));
  payload.backups=await api.inventory(syncFile);
  assert.equal((await purge({},payload)).success,true);
  assert.ok(fs.existsSync(path.join(profile,'images','shared.png')));
  assert.ok(fs.existsSync(path.join(profile,'images','orphan.webp')));
  assert.ok(fs.existsSync(path.join(profile,'images','unknown.txt')));
  assert.ok(fs.existsSync(path.join(profile,'voice','orphan.mp3')));
  assert.ok(fs.existsSync(path.join(unrelated,'export.json')));
  assert.equal(fs.existsSync(syncFile),false);assert.equal(config.get('MemoryMaintenanceGeneration'),'correction');
  assert.equal((await purge({},payload)).success,true,'interrupted deletion is idempotent');
  console.log('Memory file maintenance: real isolated files, exact inventory, changed backup rejection, shared media and resumable purge passed.');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{
  const resolved=fs.realpathSync(dir);
  if(path.dirname(resolved)!==fs.realpathSync(os.tmpdir())||!path.basename(resolved).startsWith('kumiko-memory-files-')||fs.lstatSync(dir).isSymbolicLink())throw Error('Unsafe fixture cleanup');
  fs.rmSync(resolved,{recursive:true,force:true});
});
