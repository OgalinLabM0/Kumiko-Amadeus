// Portable authenticated envelope shared by Electron and Web Crypto platforms.
// Each file has a fresh data key, wrapping salt and independent GCM nonces.
const MAGIC = 'KUMIKO-BACKUP-1\n';
const ITERATIONS = 600000;
const MAX_BYTES = 512 * 1024 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();
const random = n => crypto.getRandomValues(new Uint8Array(n));
const b64 = bytes => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s, max) => {
  if (typeof s !== 'string' || s.length > Math.ceil(max / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error('Invalid encrypted backup');
  const bytes = Uint8Array.from(atob(s), c => c.charCodeAt(0));
  if (bytes.length > max) throw new Error('Encrypted backup too large');
  return bytes;
};
const derive = async (password, salt, iterations) => {
  if (typeof password !== 'string' || !password || password.length > 4096) throw new Error('Backup password required');
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
};
export const isEncryptedBackup = input => typeof input === 'string' && input.startsWith(MAGIC);
export async function encryptPortableBackup(bytes, password, kind) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BYTES || !['zip', 'json'].includes(kind)) throw new Error('Invalid backup payload');
  const salt = random(16), wrapIv = random(12), dataIv = random(12), rawKey = random(32);
  const header = { version: 1, kind, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: b64(salt), wrapIv: b64(wrapIv), dataIv: b64(dataIv) };
  const aad = enc.encode(JSON.stringify(header));
  const wrapping = await derive(password, salt, ITERATIONS);
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv, additionalData: aad }, wrapping, rawKey);
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  rawKey.fill(0);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: dataIv, additionalData: aad }, key, bytes);
  return MAGIC + JSON.stringify({ ...header, wrapped: b64(new Uint8Array(wrapped)), ciphertext: b64(new Uint8Array(ciphertext)) });
}
export async function decryptPortableBackup(input, password) {
  if (!isEncryptedBackup(input) || input.length > Math.ceil(MAX_BYTES * 4 / 3) + 4096) throw new Error('Invalid encrypted backup');
  let parsed;
  try { parsed = JSON.parse(input.slice(MAGIC.length)); } catch { throw new Error('Invalid encrypted backup'); }
  const { version, kind, kdf, iterations, salt, wrapIv, dataIv, wrapped, ciphertext } = parsed || {};
  if (version !== 1 || !['zip', 'json'].includes(kind) || kdf !== 'PBKDF2-SHA256' || iterations !== ITERATIONS) throw new Error('Unsupported encrypted backup');
  const saltBytes = unb64(salt, 16), wrapBytes = unb64(wrapIv, 12), dataBytes = unb64(dataIv, 12), wrappedBytes = unb64(wrapped, 48), content = unb64(ciphertext, MAX_BYTES + 16);
  if (saltBytes.length !== 16 || wrapBytes.length !== 12 || dataBytes.length !== 12 || wrappedBytes.length !== 48 || content.length < 16) throw new Error('Invalid encrypted backup');
  const aad = enc.encode(JSON.stringify({ version, kind, kdf, iterations, salt, wrapIv, dataIv }));
  try {
    const wrapping = await derive(password, saltBytes, iterations);
    const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: wrapBytes, additionalData: aad }, wrapping, wrappedBytes));
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    raw.fill(0);
    return { kind, bytes: new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: dataBytes, additionalData: aad }, key, content)) };
  } catch { throw new Error('Wrong backup password or corrupted backup'); }
}
