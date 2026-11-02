const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app } = require('electron');
const { assertBackupPathAllowed } = require('./backup-files.cjs');
const rag = require('../electron-rag.cjs');
const media = require('./media-files.cjs');
const { writeConfigValue } = require('./user-config.cjs');
async function fingerprint(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Backup is not a regular file.');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return { path: filePath, size: stat.size, digest: hash.digest('hex') };
}
function assertOwnedPath(filePath, syncPath) {
  const resolved = path.resolve(filePath);
  const root = fs.realpathSync(app.getPath('userData'));
  const parent = fs.realpathSync(path.dirname(resolved));
  if (parent === root && /^kumiko_backup_[\w.-]+\.(?:json|zip|kab)$/.test(path.basename(resolved))) return resolved;
  if (syncPath) {
    const sync = path.resolve(syncPath); assertBackupPathAllowed(sync);
    const syncParent = fs.realpathSync(path.dirname(sync));
    if (parent === syncParent && (resolved === sync || /^kumiko_backup_auto\.(?:zip|kab)$/.test(path.basename(resolved)))) return resolved;
  }
  throw new Error('Backup is outside the approved managed scope.');
}
async function inventory(syncPath) {
  const files = new Set();
  for (const name of fs.readdirSync(app.getPath('userData'))) {
    if (/^kumiko_backup_[\w.-]+\.(?:json|zip|kab)$/.test(name)) files.add(path.join(app.getPath('userData'), name));
  }
  if (syncPath) {
    assertBackupPathAllowed(path.resolve(syncPath));
    files.add(path.resolve(syncPath));
    for (const name of ['kumiko_backup_auto.zip','kumiko_backup_auto.kab']) files.add(path.join(path.dirname(path.resolve(syncPath)), name));
  }
  const result = [];
  for (const file of files) if (fs.existsSync(file)) result.push(await fingerprint(assertOwnedPath(file, syncPath)));
  return result;
}
// Only inventory names that the managed media handlers themselves understand.
// Never follow links, including a replaced images/voice directory.
function inventoryMedia() {
  const root = fs.realpathSync(app.getPath('userData'));
  const read = (folder, pattern) => {
    const dir = path.join(root, folder);
    if (!fs.existsSync(dir)) return [];
    const dirStat = fs.lstatSync(dir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || fs.realpathSync(dir) !== dir) throw new Error('Managed media directory is not a real directory.');
    const ids = new Set();
    for (const name of fs.readdirSync(dir)) {
      const match = pattern.exec(name); if (!match) continue;
      const stat = fs.lstatSync(path.join(dir, name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Managed media entry is not a regular file.');
      ids.add(match[1]);
    }
    return [...ids].sort();
  };
  return { imageIds: read('images', /^([a-zA-Z0-9_-]{1,80})\.(?:jpg|jpeg|png|webp|gif)$/i), voiceIds: read('voice', /^([a-zA-Z0-9_-]{1,80})\.mp3$/) };
}
function register(ipcMain) {
  ipcMain.handle('memory:managed-backups', async (_event, payload) => {
    try { return { success: true, files: await inventory(payload?.syncPath), ...inventoryMedia() }; }
    catch (error) { return { success: false, error: error.message }; }
  });
  ipcMain.handle('memory:purge-files', async (event, payload) => {
    try {
      if (!rag.isMemoryMaintenanceOwner(event, payload?.id)) throw new Error('Memory maintenance ownership is required.');
      if (!Array.isArray(payload.backups) || !Array.isArray(payload.imageIds) || !Array.isArray(payload.voiceIds)) throw new Error('Invalid purge manifest.');
      // After a correction auto-ZIP must wait for a newly saved clean payload,
      // never rediscover an older independent export by filename/date.
      writeConfigValue('MemoryMaintenanceGeneration', payload.id);
      // All paths and identities are checked before any destructive write.
      const verified = [];
      for (const item of payload.backups) {
        const target = assertOwnedPath(item.path, payload.syncPath);
        verified.push({ ...item, path: target });
        if (!fs.existsSync(target)) continue;
        const current = await fingerprint(target);
        if (current.digest !== item.digest || current.size !== item.size) throw new Error('A backup changed since the preview.');
      }
      for (const id of [...payload.imageIds, ...payload.voiceIds]) if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid media identity.');
      inventoryMedia(); // Refuse a replaced directory or symlink before any deletion.
      for (const item of verified) {
        if (!fs.existsSync(item.path)) continue;
        // A different backup could have replaced an earlier manifest entry
        // while later large files were being hashed. Recheck immediately
        // before unlinking; never delete that replacement on an old preview.
        const current = await fingerprint(item.path);
        if (current.digest !== item.digest || current.size !== item.size) throw new Error('A backup changed since the preview.');
        fs.unlinkSync(item.path);
      }
      for (const imageId of payload.imageIds) { const r = await media.handleImagesDelete(event, { imageId }); if (!r.success) throw new Error('Image removal failed.'); }
      for (const messageId of payload.voiceIds) { const r = await media.handleVoiceDelete(event, { messageId }); if (!r.success) throw new Error('Voice removal failed.'); }
      const images = await media.handleImagesList(); const voices = await media.handleVoiceList();
      if (!images.success || !voices.success || images.files.some(x => payload.imageIds.includes(x.id)) || voices.files.some(x => payload.voiceIds.includes(x.id))) throw new Error('Media removal verification failed.');
      if (payload.backups.some(x => fs.existsSync(x.path))) throw new Error('Backup removal verification failed.');
      return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
  });
}
module.exports = { register, inventory, inventoryMedia, fingerprint, assertOwnedPath };
