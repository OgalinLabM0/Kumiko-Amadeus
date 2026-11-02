'use strict';
if (!process.versions.electron) {
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const result=require('node:child_process').spawnSync(require('electron'),[__filename],{env,windowsHide:true,encoding:'utf8',timeout:30000});
  if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);
  process.exitCode=result.status===0?0:1;
} else {
  const {app}=require('electron'),assert=require('node:assert/strict');
  app.whenReady().then(async()=>{
    const Database=require('better-sqlite3');const db=new Database(':memory:');
    const {registerArtifactIndex,replaceArtifactProvenance,readArtifactProvenance}=require('../electron/artifact-index.cjs');
    db.exec('CREATE TABLE vectors (id TEXT PRIMARY KEY,text TEXT,canonical_key TEXT)');
    const handlers=new Map();registerArtifactIndex({handle:(name,fn)=>handlers.set(name,fn)},()=>db,()=>1,()=>true);
    const id='ka-'+'d'.repeat(64), chunk=id+':0', refs=[{kind:'message',id:'m',version:'r'}];
    const payload={id,version:'v1',token:'t',leaseUntil:Date.now()+60000,epoch:'epoch',memoryGeneration:'initial',sourceRefs:refs,chunkIds:[chunk],canonicalKeys:['ka-artifact:'+chunk],textChunks:['before']};
    assert.equal((await handlers.get('rag:artifact-stage')({},payload)).success,true);
    db.prepare('INSERT INTO vectors VALUES (?,?,?)').run(chunk,'before',payload.canonicalKeys[0]);
    assert.equal((await handlers.get('rag:artifact-commit')({},payload)).success,true);
    db.exec("CREATE TRIGGER fail_artifact_restore BEFORE INSERT ON artifact_registry BEGIN SELECT RAISE(ABORT,'injected artifact failure'); END");
    const item={id:chunk,canonicalKey:payload.canonicalKeys[0],artifactId:id,artifactVersion:'v1',sourceRefs:refs};
    assert.throws(()=>db.transaction(()=>{db.exec('DELETE FROM vectors');db.prepare('INSERT INTO vectors VALUES (?,?,?)').run(chunk,'after',payload.canonicalKeys[0]);replaceArtifactProvenance(db,[item],2);})(),/injected/);
    assert.equal(db.prepare('SELECT text FROM vectors WHERE id=?').get(chunk).text,'before');
    assert.equal(readArtifactProvenance(db).get(chunk).artifactState,'active');
    db.exec('DROP TRIGGER fail_artifact_restore');
    db.transaction(()=>{db.exec('DELETE FROM vectors');db.prepare('INSERT INTO vectors VALUES (?,?,?)').run(chunk,'after',payload.canonicalKeys[0]);replaceArtifactProvenance(db,[item],2);})();
    assert.equal(readArtifactProvenance(db).get(chunk).artifactState,'staged');
    assert.equal(readArtifactProvenance(db).get(chunk).sourceRefs[0].id,'m');db.close();
    console.log('Electron SQLite artifact restore passed: vectors and provenance roll back together.');app.exit(0);
  }).catch(error=>{console.error(error);app.exit(1);});
}
