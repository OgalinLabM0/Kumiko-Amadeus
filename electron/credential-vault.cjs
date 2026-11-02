'use strict';
// Main-process only. No renderer method returns decrypted credentials.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function createCredentialVault({ directory, safeStorage, fetchImpl = globalThis.fetch }) {
  if (!path.isAbsolute(directory)) throw new Error('Credential vault requires an absolute directory.');
  let writes = Promise.resolve();
  function available() {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')) {
      throw new Error('Secure system storage is unavailable.');
    }
  }
  const filename = handle => {
    if (!/^(?:backup-key|[a-f0-9]{64})$/.test(handle)) throw new Error('Invalid credential reference.');
    return path.join(directory, `${handle}.bin`);
  };
  async function read(handle) {
    available();
    let encrypted;
    try { encrypted = await fs.readFile(filename(handle)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Unable to read secure storage.'); }
    try { return JSON.parse(safeStorage.decryptString(encrypted)); }
    catch { throw new Error('Unable to decrypt secure storage.'); }
  }
  async function write(handle, value) {
    const run = async () => {
      available();
      const plain = JSON.stringify(value);
      let encrypted;
      try {
        encrypted = safeStorage.encryptString(plain);
        if (safeStorage.decryptString(encrypted) !== plain) throw new Error();
      } catch { throw new Error('Secure storage verification failed.'); }
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const target = filename(handle);
      const temp = `${target}.${crypto.randomBytes(16).toString('hex')}.tmp`;
      try {
        await fs.writeFile(temp, encrypted, { flag: 'wx', mode: 0o600 });
        const saved = await fs.readFile(temp);
        if (!saved.equals(encrypted) || safeStorage.decryptString(saved) !== plain) throw new Error();
        await fs.rename(temp, target);
      } catch {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw new Error('Secure storage write or verification failed.');
      }
    };
    const pending = writes.then(run, run); writes = pending.catch(() => {}); return pending;
  }
  async function clear(includeBackup) {
    const run = async () => {
      let entries;
      try {
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid vault directory.');
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw new Error('Unable to inspect credential storage.');
      }
      for (const entry of entries) {
        if (/^(?:backup-key|[a-f0-9]{64})\.bin(?:\.[a-f0-9]{32}\.tmp)?$/.test(entry.name)
          && (includeBackup || !entry.name.startsWith('backup-key.'))) {
          if (!entry.isFile()) throw new Error('Invalid credential storage entry.');
          await fs.unlink(path.join(directory, entry.name));
        }
      }
    };
    const pending = writes.then(run, run); writes = pending.catch(() => {}); return pending;
  }
  function endpoint(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Invalid credential endpoint.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('Credential endpoint must be HTTPS without credentials, query or fragment.');
    return url.href;
  }
  const headers = { gemini: 'x-goog-api-key', openai: 'authorization', anthropic: 'x-api-key', embedding: 'authorization', 'embedding-gemini': 'x-goog-api-key',
    fish: 'authorization', vocu: 'authorization', tavily: 'x-api-key' };
  return {
    async setInternalBackupKey(value) {
      if (typeof value !== 'string' || !value || value.length > 4096) throw new Error('Invalid internal key.');
      await write('backup-key', { version: 1, value });
    },
    async getInternalBackupKey() {
      const item = await read('backup-key');
      if (item === null) return null;
      if (item.version !== 1 || typeof item.value !== 'string' || !item.value) throw new Error('Invalid internal key record.');
      return item.value;
    },
    // Caller must fence all other vault instances during a confirmed reset.
    // Remove only files owned by this vault, leaving unrelated files untouched.
    clearAll: () => clear(true),
    clearCredentials: () => clear(false),
    async deleteCredential(handle) {
      if (!/^[a-f0-9]{64}$/.test(handle)) throw new Error('Invalid credential reference.');
      await fs.rm(filename(handle), { force: true });
    },
    async storeCredential({ purpose, endpoint: destination, secret }) {
      if (!Object.hasOwn(headers, purpose) || typeof secret !== 'string' || !secret.trim() || secret.length > 8192 || /[\r\n]/.test(secret)) throw new Error('Invalid credential.');
      const target = endpoint(destination);
      const handle = crypto.randomBytes(32).toString('hex');
      await write(handle, { version: 1, purpose, endpoint: target, secret });
      return { handle, purpose, endpoint: target, configured: true };
    },
    async generateGemini({ handle, params, expectedEndpoint, signal }) {
      const item = await read(handle);
      if (!item || item.version !== 1 || item.purpose !== 'gemini' || typeof item.secret !== 'string') throw new Error('Credential binding does not match.');
      if (expectedEndpoint !== undefined && endpoint(expectedEndpoint) !== item.endpoint) throw new Error('Credential endpoint binding does not match.');
      const base = new URL(endpoint(item.endpoint));
      if (!params || typeof params !== 'object' || typeof params.model !== 'string' || !/^[A-Za-z0-9._:/-]{1,200}$/.test(params.model) || params.model.includes('..') || params.model.includes('//')
        || !params.contents || params.config?.httpOptions || JSON.stringify(params).length > 8 * 1024 * 1024) throw new Error('Invalid Gemini request.');
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: item.secret, httpOptions: { baseUrl: base.href, retryOptions: { attempts: 1 } } });
      // Override this SDK instance only; never change global fetch. Reject per-call
      // destination changes and redirects before a credential crosses origins.
      ai.apiClient.apiCall = async (destination, options) => {
        const url = new URL(destination);
        const prefix = base.pathname.endsWith('/') ? base.pathname : base.pathname + '/';
        if (url.origin !== base.origin || !(url.pathname === base.pathname || url.pathname.startsWith(prefix))
          || url.username || url.password || url.hash || [...url.searchParams.keys()].some(k => /key|token|secret/i.test(k))) {
          throw new Error('Gemini request destination does not match credential binding.');
        }
        try { return await fetchImpl(url.href, { ...options, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : []), ...(options.signal ? [options.signal] : [])]) }); }
        catch { throw new Error('Gemini request failed.'); }
      };
      const result = await ai.models.generateContent(params);
      const plain = JSON.stringify(result);
      if (plain.includes(item.secret)) throw new Error('Credential appeared in the API response.');
      return { ...JSON.parse(plain), text: result.text, functionCalls: result.functionCalls };
    },
    async tavily({ handle, operation, query, signal }) {
      const item = await read(handle);
      if (!item || item.purpose !== 'tavily' || endpoint(item.endpoint) !== 'https://search.omkk.org/'
        || typeof item.secret !== 'string' || !item.secret || /[\r\n]/.test(item.secret)) throw new Error('Credential binding does not match.');
      if (!['search', 'usage'].includes(operation) || (operation === 'search' && (typeof query !== 'string' || !query.trim() || query.length > 4000))) throw new Error('Invalid search request.');
      const target = new URL(operation === 'search' ? '/api/search' : '/api/usage', item.endpoint);
      if (operation === 'search') target.searchParams.set('q', query);
      let response;
      try { response = await fetchImpl(target.href, { method: 'GET', redirect: 'error', headers: { 'x-api-key': item.secret }, signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]) }); }
      catch { throw new Error('Search request failed.'); }
      const reader = response.body?.getReader(); const chunks = []; let size = 0;
      if (reader) try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length;
        if (size > 2 * 1024 * 1024) throw new Error('Search response too large.'); chunks.push(Buffer.from(part.value)); } }
      finally { await reader.cancel().catch(() => {}); }
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.includes(item.secret)) throw new Error('Invalid search response.');
      return { status: response.status, body: text };
    },
    async request({ handle, purpose, body, expectedEndpoint, model, contentType = 'application/json', signal }) {
      const item = await read(handle);
      if (!item || item.version !== 1 || item.purpose !== purpose || !Object.hasOwn(headers, purpose)) throw new Error('Credential binding does not match.');
      const bound = endpoint(item.endpoint);
      let destination = bound;
      if (purpose === 'embedding-gemini') {
        const base = 'https://generativelanguage.googleapis.com/';
        const legacy = /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/([A-Za-z0-9._-]{1,200}):embedContent$/;
        if (expectedEndpoint !== base || (bound !== base && (!legacy.test(bound) || bound.includes('..')))
          || typeof model !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(model) || model.includes('..')) throw new Error('Credential endpoint binding does not match.');
        destination = `${base}v1beta/models/${model}:embedContent`;
      } else if (expectedEndpoint !== undefined && endpoint(expectedEndpoint) !== destination) throw new Error('Credential endpoint binding does not match.');
      if (typeof item.secret !== 'string' || !item.secret || /[\r\n]/.test(item.secret)) throw new Error('Invalid stored credential.');
      if (typeof body !== 'string' || Buffer.byteLength(body) > 8 * 1024 * 1024 || !['application/json', 'text/plain'].includes(contentType)) throw new Error('Invalid request body.');
      const name = headers[purpose];
      const auth = name === 'authorization' ? `Bearer ${item.secret}` : item.secret;
      if (purpose === 'fish' && !['s1', 's2-pro'].includes(model)) throw new Error('Invalid voice model.');
      if (purpose !== 'fish' && purpose !== 'embedding-gemini' && model !== undefined) throw new Error('Invalid request model.');
      let response;
      try { response = await fetchImpl(destination, { method: 'POST', redirect: 'error', headers: { 'content-type': contentType, [name]: auth,
        ...(purpose === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}), ...(purpose === 'fish' ? { model } : {}) }, body, signal: AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])]) }); }
      catch { throw new Error('Credential request failed.'); }
      const reader = response.body?.getReader();
      const chunks = []; let size = 0;
      if (reader) try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 16 * 1024 * 1024) throw new Error('Response too large.'); chunks.push(Buffer.from(part.value)); } } finally { await reader.cancel().catch(() => {}); }
      const output = Buffer.concat(chunks);
      if (output.includes(Buffer.from(item.secret))) throw new Error('Credential appeared in the API response.');
      return { status: response.status, contentType: response.headers.get('content-type') || '', body: output.toString('base64') };
    },
  };
}
module.exports = { createCredentialVault };
