'use strict';

function ensureArtifactSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS artifact_registry (
    id TEXT PRIMARY KEY, version TEXT NOT NULL, token TEXT NOT NULL, lease_until INTEGER NOT NULL,
    generation INTEGER NOT NULL, state TEXT NOT NULL, sources TEXT NOT NULL, chunks TEXT NOT NULL,
    source_epoch TEXT NOT NULL DEFAULT '', memory_generation TEXT NOT NULL DEFAULT ''
  )`);
  const columns=db.prepare('PRAGMA table_info(artifact_registry)').all().map(row=>row.name);
  if (!columns.includes('source_epoch')) db.exec("ALTER TABLE artifact_registry ADD COLUMN source_epoch TEXT NOT NULL DEFAULT ''");
  if (!columns.includes('memory_generation')) db.exec("ALTER TABLE artifact_registry ADD COLUMN memory_generation TEXT NOT NULL DEFAULT ''");
}

// Native metadata is deliberately separate from renderer source validation.
// A staged vector must never be exposed without a matching active registry.
function registerArtifactIndex(ipcMain, getDb, getGeneration, isSearchReady = () => false) {
  function table() {
    const db = getDb();
    if (!db) throw new Error('Memory database is unavailable.');
    ensureArtifactSchema(db);
    return db;
  }
  const valid = p => p && typeof p.id === 'string' && /^ka-[a-f0-9]{64}$/.test(p.id)
    && typeof p.version === 'string' && p.version.length <= 200
    && typeof p.token === 'string' && p.token.length > 0 && p.token.length <= 100
    && typeof p.epoch === 'string' && p.epoch.length <= 256
    && typeof p.memoryGeneration === 'string' && p.memoryGeneration.length > 0 && p.memoryGeneration.length <= 256
    && Number.isFinite(p.leaseUntil) && Array.isArray(p.sourceRefs) && p.sourceRefs.length > 0 && p.sourceRefs.length <= 10000
    && p.sourceRefs.every(ref => ref && ['message','diary','fragment'].includes(ref.kind)
      && typeof ref.id === 'string' && ref.id.length > 0 && ref.id.length <= 1000
      && typeof ref.version === 'string' && ref.version.length > 0 && ref.version.length <= 1000)
    && Array.isArray(p.chunkIds) && p.chunkIds.length > 0 && p.chunkIds.length <= 100
    && Array.isArray(p.canonicalKeys) && Array.isArray(p.textChunks) && p.canonicalKeys.length === p.chunkIds.length && p.textChunks.length === p.chunkIds.length
    && p.chunkIds.every((id,i) => id === `${p.id}:${i}` && p.canonicalKeys[i] === `ka-artifact:${id}`
      && typeof p.textChunks[i] === 'string' && p.textChunks[i].length > 0 && p.textChunks[i].length <= 1_000_000);
  ipcMain.handle('rag:artifact-stage', async (_event, p) => {
    if (!valid(p) || p.leaseUntil <= Date.now() || p.leaseUntil > Date.now() + 125000) return { success:false, error:'Invalid artifact lease.' };
    const db=table(), current=db.prepare('SELECT * FROM artifact_registry WHERE id=?').get(p.id);
    if (p.renew && (!current || current.token !== p.token || current.generation !== getGeneration()
      || current.lease_until <= Date.now() || p.leaseUntil <= current.lease_until))
      return {success:false,error:'Artifact lease cannot be renewed.'};
    if (current && current.lease_until > Date.now() && current.token !== p.token && current.generation === getGeneration())
      return { success:false, error:'Artifact is owned by another task.' };
    db.prepare('INSERT OR REPLACE INTO artifact_registry (id,version,token,lease_until,generation,state,sources,chunks,source_epoch,memory_generation) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(p.id,p.version,p.token,p.leaseUntil,getGeneration(),'staged',JSON.stringify(p.sourceRefs),JSON.stringify(p.chunkIds),p.epoch || '',p.memoryGeneration || '');
    return { success:true };
  });
  ipcMain.handle('rag:artifact-commit', async (_event, p) => {
    if (!valid(p)) return { success:false,error:'Invalid artifact commit.' };
    const db=table(), row=db.prepare('SELECT * FROM artifact_registry WHERE id=?').get(p.id);
    if (!row || row.token!==p.token || row.version!==p.version || row.generation!==getGeneration()
      || row.lease_until<=Date.now() || row.state!=='staged' || row.sources!==JSON.stringify(p.sourceRefs)
      || row.chunks!==JSON.stringify(p.chunkIds)) return {success:false,error:'Artifact lease expired or changed.'};
    const get=db.prepare('SELECT id,text,canonical_key FROM vectors WHERE id=?');
    const chunks=p.chunkIds.map(id=>get.get(id));
    if (chunks.some((chunk,i)=>!chunk || chunk.canonical_key!==p.canonicalKeys[i] || chunk.text!==p.textChunks[i] || !isSearchReady(chunk.id)))
      return {success:false,error:'Artifact index readback did not match.'};
    db.prepare("UPDATE artifact_registry SET state='active' WHERE id=? AND token=?").run(p.id,p.token);
    return {success:true,count:chunks.length};
  });
  ipcMain.handle('rag:artifact-get', async (_event, p) => {
    if (!p || typeof p.id !== 'string' || !/^ka-[a-f0-9]{64}:\d+$/.test(p.id)) return {success:false,error:'Invalid artifact chunk.'};
    const row=table().prepare('SELECT id,text,canonical_key FROM vectors WHERE id=?').get(p.id);
    return {success:true,row:row ? {id:row.id,text:row.text,canonicalKey:row.canonical_key,searchReady:isSearchReady(row.id)} : null};
  });
  ipcMain.handle('rag:artifact-list', async () => {
    const db=table(), provenance=readArtifactProvenance(db);
    const rows=db.prepare("SELECT id,text,canonical_key FROM vectors WHERE canonical_key LIKE 'ka-artifact:%'").all();
    return {success:true,vectors:rows.map(row=>({id:row.id,text:row.text,canonicalKey:row.canonical_key,...(provenance.get(row.id)||{})}))};
  });
}
function readArtifactProvenance(db) {
  const byChunk = new Map();
  let rows;
  try {
    const columns=db.prepare('PRAGMA table_info(artifact_registry)').all().map(row=>row.name);
    if (!columns.length) return byChunk;
    const epoch=columns.includes('source_epoch') ? 'source_epoch' : "'' AS source_epoch";
    const memory=columns.includes('memory_generation') ? 'memory_generation' : "'' AS memory_generation";
    rows=db.prepare(`SELECT id,version,state,sources,chunks,${epoch},${memory} FROM artifact_registry`).all();
  }
  catch (error) { if (String(error?.message || error).includes('no such table')) return byChunk; throw error; }
  for (const row of rows) {
    try {
      const refs=JSON.parse(row.sources), chunks=JSON.parse(row.chunks);
      if (!Array.isArray(refs) || !Array.isArray(chunks)) continue;
      for (const id of chunks) if (typeof id === 'string') byChunk.set(id,
        {artifactId:row.id,artifactVersion:row.version,artifactState:row.state,artifactChunkCount:chunks.length,
          artifactEpoch:row.source_epoch,artifactMemoryGeneration:row.memory_generation,sourceRefs:refs});
    } catch { /* Malformed provenance is never treated as verified. */ }
  }
  return byChunk;
}
/** Caller owns the same SQLite transaction that replaces vectors. */
function replaceArtifactProvenance(db, vectors, generation) {
  const groups = new Map();
  for (const item of vectors) {
    if (item.artifactId === undefined && item.sourceRefs === undefined) continue;
    if (typeof item.artifactId !== 'string' || !/^ka-[a-f0-9]{64}$/.test(item.artifactId)
      || typeof item.artifactVersion !== 'string' || !item.artifactVersion || item.artifactVersion.length > 200
      || !Array.isArray(item.sourceRefs) || !item.sourceRefs.length || item.sourceRefs.length > 10000
      || item.sourceRefs.some(ref => !ref || !['message','diary','fragment'].includes(ref.kind)
        || typeof ref.id !== 'string' || !ref.id || ref.id.length > 1000
        || typeof ref.version !== 'string' || !ref.version || ref.version.length > 1000)
      || item.id !== `${item.artifactId}:${String(item.id).split(':').at(-1)}`
      || !/^\d+$/.test(String(item.id).split(':').at(-1)) || item.canonicalKey !== `ka-artifact:${item.id}`)
      throw new Error('Invalid artifact provenance in vector restore.');
    const refs = JSON.stringify(item.sourceRefs), existing = groups.get(item.artifactId);
    if (existing && (existing.version !== item.artifactVersion || existing.sources !== refs
      || existing.epoch !== (item.artifactEpoch || '') || existing.memoryGeneration !== (item.artifactMemoryGeneration || ''))) throw new Error('Conflicting artifact provenance in vector restore.');
    const group = existing || { version:item.artifactVersion, sources:refs, chunks:[], epoch:item.artifactEpoch || '', memoryGeneration:item.artifactMemoryGeneration || '' };
    group.chunks.push(item.id); groups.set(item.artifactId,group);
  }
  ensureArtifactSchema(db);
  db.exec('DELETE FROM artifact_registry');
  const insert=db.prepare('INSERT OR REPLACE INTO artifact_registry (id,version,token,lease_until,generation,state,sources,chunks,source_epoch,memory_generation) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (const [id, group] of groups) insert.run(id,group.version,'restore',0,generation,'staged',group.sources,JSON.stringify(group.chunks),group.epoch,group.memoryGeneration);
}
module.exports={registerArtifactIndex,readArtifactProvenance,replaceArtifactProvenance};
