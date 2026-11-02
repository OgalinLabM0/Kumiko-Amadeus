'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');
const { createCredentialVault } = require('./credential-vault.cjs');
const directory = () => path.join(app.getPath('userData'), 'credential-vault');
const marker = () => path.join(directory(), 'backup-enabled');
const vault = () => createCredentialVault({ directory: directory(), safeStorage });
let pending = Promise.resolve();
function serialize(work) {
  const next = pending.then(work, work);
  pending = next.catch(() => {});
  return next;
}
function enabled() { return fs.existsSync(marker()); }
async function key() {
  if (!enabled()) return null;
  const value = await vault().getInternalBackupKey();
  if (!value) throw new Error('Backup protection key is unavailable.');
  return value;
}
function enable(password, canCommit = () => true) { return serialize(async () => {
  if (typeof password !== 'string' || password.length < 12 || password.length > 4096) throw new Error('Backup password must contain at least 12 characters.');
  // Never rotate an existing password silently: existing automatic files need
  // the old key until the user explicitly migrates them.
  if (enabled()) throw new Error('Backup protection is already enabled.');
  await vault().setInternalBackupKey(password);
  if (!canCommit()) throw new Error('Data reset or restore is in progress.');
  fs.writeFileSync(marker(), '1', { flag: 'wx', mode: 0o600 });
}); }
function clear() { return serialize(async () => {
  // Keep the marker until key removal succeeds so an interrupted clear cannot
  // silently fall back to writing plaintext on the next startup.
  await fs.promises.rm(path.join(directory(), 'backup-key.bin'), { force: true });
  await fs.promises.rm(marker(), { force: true });
}); }
module.exports = { enabled, key, enable, clear };
