// electron/media-files.cjs
//
// User-media file IO for three categories of renderer-owned bytes that live
// as real files under userData/ (not in Dexie/IndexedDB):
//   - images/{id}.{ext}: chat-bubble attachments (Plan 5, P1 #36)
//   - voice/{messageId}.mp3: SoVITS-generated voice clips
//   - ringtone/custom.{ext}: single user-supplied custom ringtone
//
// Every handler here is registered by electron-main.cjs via ipcMain.handle
// against a stable channel name. Handlers are exported by name so the main
// file only carries thin `ipcMain.handle(channel, handlerXxx)` delegates
// that keep the IPC surface legible in one place without dragging the
// implementation bodies along.
//
// All file access is path-traversal-hardened: SAFE_*_ID regexes reject
// separators and walk the final resolved path back against the intended
// dir root before writing/reading. IMAGE_EXT_WHITELIST and
// RINGTONE_AUDIO_EXTENSIONS pin which extensions are acceptable so a
// compromised renderer can't plant arbitrary binaries under userData/.

'use strict';

const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');

// Accepted ringtone audio extensions. The auto-backup path in
// electron-main.cjs's before-quit handler hard-codes its own list
// (['.mp3', '.wav', '.ogg', '.m4a', '.flac']) because it runs with this
// module possibly not yet required; keep the two lists in sync when
// extending formats.
const RINGTONE_AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);

// Safe ID pattern for voice/ringtone message IDs — prevents path traversal
// via payloads like "../../../../Windows/System32/evil". All voice: handlers
// must run the caller-supplied messageId through this.
const SAFE_VOICE_ID = /^[a-zA-Z0-9_-]{1,80}$/;

// Same constraints for image IDs — the kumiko-image:// protocol in
// electron-main.cjs enforces the identical regex on URL-derived IDs, so
// round-tripping UI → IPC → protocol stays consistent.
const SAFE_IMAGE_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const IMAGE_EXT_WHITELIST = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);

// ── Voice helpers ─────────────────────────────────────────────────

function getVoiceDir() {
  const dir = path.join(app.getPath('userData'), 'voice');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Resolve a voice file path and guarantee it still lives inside the voice dir
// after normalization. Throws on any unsafe input.
function resolveVoicePath(messageId) {
  if (typeof messageId !== 'string' || !SAFE_VOICE_ID.test(messageId)) {
    throw new Error('Invalid voice messageId');
  }
  const voiceDir = path.resolve(getVoiceDir());
  const full = path.resolve(path.join(voiceDir, `${messageId}.mp3`));
  if (full !== path.join(voiceDir, `${messageId}.mp3`) || !full.startsWith(voiceDir + path.sep)) {
    throw new Error('Voice path escaped voice directory');
  }
  return full;
}

// ── Ringtone helpers ──────────────────────────────────────────────

function getRingtoneDir() {
  const dir = path.join(app.getPath('userData'), 'ringtone');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getRingtoneMetadataPath(dir) {
  return path.join(dir, 'custom.meta.json');
}

function clearRingtoneMetadata(dir) {
  const metadataPath = getRingtoneMetadataPath(dir);
  if (fs.existsSync(metadataPath)) {
    fs.unlinkSync(metadataPath);
  }
}

function readRingtoneMetadata(dir) {
  try {
    const metadataPath = getRingtoneMetadataPath(dir);
    if (!fs.existsSync(metadataPath)) return null;
    const raw = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const originalName = typeof raw.originalName === 'string' ? raw.originalName.trim() : '';
    return originalName ? { originalName } : null;
  } catch {
    return null;
  }
}

function writeRingtoneMetadata(dir, originalName) {
  const normalizedName = typeof originalName === 'string' ? path.basename(originalName.trim()) : '';
  if (!normalizedName) {
    clearRingtoneMetadata(dir);
    return;
  }

  fs.writeFileSync(
    getRingtoneMetadataPath(dir),
    JSON.stringify({ originalName: normalizedName }, null, 2),
    'utf8',
  );
}

function listCustomRingtoneFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((fileName) => {
    if (!fileName.startsWith('custom.')) return false;
    const hasValidAudioExtension = RINGTONE_AUDIO_EXTENSIONS.has(path.extname(fileName).toLowerCase());
    if (!hasValidAudioExtension) {
      try {
        fs.unlinkSync(path.join(dir, fileName));
      } catch {
        // Ignore stale invalid ringtone files that cannot be removed right now.
      }
    }
    return hasValidAudioExtension;
  });
}

// ── Image helpers (P1 #36) ────────────────────────────────────────
// Images live as real files under userData/images/{id}.{ext} instead of
// being stored as base64 strings inside Dexie. Renderer side still holds
// only the ID + caption; bytes are loaded on demand by the UI (<img> via
// the kumiko-image:// protocol registered in electron-main.cjs) or by the
// model (view_historical_image tool, which calls images:load).

function getImagesDir() {
  const dir = path.join(app.getPath('userData'), 'images');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveImagePath(imageId, ext) {
  if (typeof imageId !== 'string' || !SAFE_IMAGE_ID.test(imageId)) {
    throw new Error('Invalid image id');
  }
  const safeExt = typeof ext === 'string' && IMAGE_EXT_WHITELIST.has(ext.toLowerCase())
    ? ext.toLowerCase()
    : 'jpg';
  const dir = path.resolve(getImagesDir());
  const full = path.resolve(path.join(dir, `${imageId}.${safeExt}`));
  if (full !== path.join(dir, `${imageId}.${safeExt}`) || !full.startsWith(dir + path.sep)) {
    throw new Error('Image path escaped images directory');
  }
  return full;
}

function findImageFile(imageId) {
  if (typeof imageId !== 'string' || !SAFE_IMAGE_ID.test(imageId)) return null;
  const dir = getImagesDir();
  for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'gif']) {
    const candidate = path.join(dir, `${imageId}.${ext}`);
    if (fs.existsSync(candidate)) {
      const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      return { path: candidate, ext, mimeType };
    }
  }
  return null;
}

// Voice counterpart of findImageFile. Used by the mobile media route so
// the phone can stream voice clips over HTTP instead of shipping them as
// base64 through the IPC JSON bridge. Voice files are always .mp3
// (handleVoiceSave enforces this), so we don't bother probing extensions.
function findVoiceFile(messageId) {
  if (typeof messageId !== 'string' || !SAFE_VOICE_ID.test(messageId)) return null;
  try {
    const candidate = resolveVoicePath(messageId);
    if (!fs.existsSync(candidate)) return null;
    return { path: candidate, ext: 'mp3', mimeType: 'audio/mpeg' };
  } catch {
    return null;
  }
}

// Phase 5 Part D: ringtone streaming counterpart of findImageFile /
// findVoiceFile. The user only ever has ONE custom ringtone stored
// under userData/ringtone/custom.{ext}, so this helper doesn't take an
// id — it just finds whichever extension the user uploaded. Returns
// null when no custom ringtone has been saved.
//
// Built-in ringtones (01.mp3 .. 08.mp3) are NOT handled here — they
// ship in the dist/ringtones/ bundle and are served by the generic
// @fastify/static root handler, so the phone can load them the same
// way the desktop renderer does.
function findRingtoneFile() {
  try {
    const dir = getRingtoneDir();
    const entries = listCustomRingtoneFiles(dir);
    if (entries.length === 0) return null;
    const fileName = entries[0];
    const filePath = path.join(dir, fileName);
    const ext = path.extname(fileName).toLowerCase().replace(/^\./, '');
    const mimeType = ext === 'wav' ? 'audio/wav'
      : ext === 'ogg' ? 'audio/ogg'
      : ext === 'm4a' ? 'audio/mp4'
      : ext === 'aac' ? 'audio/aac'
      : ext === 'flac' ? 'audio/flac'
      : 'audio/mpeg';
    return { path: filePath, ext, mimeType, fileName };
  } catch {
    return null;
  }
}

// ── Image IPC handlers ────────────────────────────────────────────

function handleImagesSave(_event, payload = {}) {
  try {
    const { imageId, ext, buffer } = payload;
    if (!imageId || !buffer) return { success: false, error: 'Missing params' };
    const filePath = resolveImagePath(imageId, ext);
    fs.writeFileSync(filePath, Buffer.from(buffer));
    return { success: true, filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function handleImagesLoad(_event, payload = {}) {
  try {
    const found = findImageFile(payload.imageId);
    if (!found) return { success: false, error: 'Not found' };
    const buffer = fs.readFileSync(found.path);
    return { success: true, buffer, mimeType: found.mimeType, ext: found.ext };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function handleImagesDelete(_event, payload = {}) {
  try {
    const found = findImageFile(payload.imageId);
    if (found) { try { fs.unlinkSync(found.path); } catch { /* ignore missing file */ } }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function handleImagesList() {
  try {
    const dir = getImagesDir();
    const entries = fs.readdirSync(dir).filter(f => /^[\w-]+\.(jpg|jpeg|png|webp|gif)$/i.test(f));
    const files = entries.map(f => {
      const stat = fs.statSync(path.join(dir, f));
      const id = f.replace(/\.(jpg|jpeg|png|webp|gif)$/i, '');
      return { id, size: stat.size, mtime: stat.mtimeMs };
    });
    return { success: true, files };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Mirror voice:open-folder. `getImagesDir()` will lazily mkdir-p on first
// call, so this IPC is still safe to invoke before the user has ever sent
// an image.
function handleImagesOpenFolder() {
  try {
    shell.openPath(getImagesDir());
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Aggregate the userData/images/ footprint for display (count + total bytes).
// Same contract as voice:get-storage-info.
function handleImagesGetStorageInfo() {
  try {
    const dir = getImagesDir();
    const entries = fs.readdirSync(dir).filter(f => /^[\w-]+\.(jpg|jpeg|png|webp|gif)$/i.test(f));
    let totalBytes = 0;
    for (const f of entries) {
      try { totalBytes += fs.statSync(path.join(dir, f)).size; } catch { /* ignore stat races */ }
    }
    return { success: true, count: entries.length, totalBytes };
  } catch {
    return { success: true, count: 0, totalBytes: 0 };
  }
}

// ── Voice IPC handlers ────────────────────────────────────────────

function handleVoiceSave(_event, payload = {}) {
  try {
    const { messageId, buffer } = payload;
    if (!messageId || !buffer) return { success: false, error: 'Missing params' };
    const filePath = resolveVoicePath(messageId);
    fs.writeFileSync(filePath, Buffer.from(buffer));
    return { success: true, filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function handleVoiceLoad(_event, payload = {}) {
  try {
    const filePath = resolveVoicePath(payload.messageId);
    if (!fs.existsSync(filePath)) return { success: false, error: 'Not found' };
    const buffer = fs.readFileSync(filePath);
    return { success: true, buffer };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function handleVoiceDelete(_event, payload = {}) {
  try {
    const filePath = resolveVoicePath(payload.messageId);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function handleVoiceList() {
  try {
    const dir = getVoiceDir();
    const entries = fs.readdirSync(dir);
    const files = entries
      .filter(f => f.endsWith('.mp3'))
      .map(f => {
        const stat = fs.statSync(path.join(dir, f));
        return { id: f.replace(/\.mp3$/, ''), size: stat.size, mtime: stat.mtimeMs };
      });
    return { success: true, files };
  } catch {
    return { success: true, files: [] };
  }
}

function handleVoiceOpenFolder() {
  try {
    shell.openPath(getVoiceDir());
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function handleVoiceGetStorageInfo() {
  try {
    const dir = getVoiceDir();
    const entries = fs.readdirSync(dir).filter(f => f.endsWith('.mp3'));
    let totalBytes = 0;
    for (const f of entries) {
      totalBytes += fs.statSync(path.join(dir, f)).size;
    }
    return { success: true, count: entries.length, totalBytes };
  } catch {
    return { success: true, count: 0, totalBytes: 0 };
  }
}

// v2.14.28 M9: bulk-delete every cached voice .mp3. Mirrors the
// per-file unlink loop in voiceFileService.clearAllVoices but does it
// in a single IPC round-trip so the renderer doesn't pay 1 round-trip
// per file (a settings-level "Clear voice cache" with 500 cached
// clips used to take 30s+ on slow disks). Field name `cleared` matches
// the renderer-side type already in use.
function handleVoiceClearAll() {
  try {
    const dir = getVoiceDir();
    let cleared = 0;
    let errors = 0;
    let entries = [];
    try {
      entries = fs.readdirSync(dir).filter(f => f.endsWith('.mp3'));
    } catch {
      return { success: true, cleared: 0, errors: 0 };
    }
    for (const f of entries) {
      try {
        fs.unlinkSync(path.join(dir, f));
        cleared += 1;
      } catch {
        errors += 1;
      }
    }
    return { success: true, cleared, errors };
  } catch (e) {
    return { success: false, error: e.message, cleared: 0, errors: 0 };
  }
}

// ── Ringtone IPC handlers ─────────────────────────────────────────

function handleRingtoneSave(_event, payload = {}) {
  try {
    const { buffer, ext, originalName } = payload;
    if (!buffer || !ext) return { success: false, error: 'Missing params' };
    const normalizedExt = `.${String(ext).replace(/^\./, '').toLowerCase()}`;
    if (!RINGTONE_AUDIO_EXTENSIONS.has(normalizedExt)) {
      return { success: false, error: 'Unsupported ringtone format' };
    }
    const dir = getRingtoneDir();
    const existing = listCustomRingtoneFiles(dir);
    for (const f of existing) fs.unlinkSync(path.join(dir, f));
    clearRingtoneMetadata(dir);
    const filePath = path.join(dir, `custom${normalizedExt}`);
    fs.writeFileSync(filePath, Buffer.from(buffer));
    writeRingtoneMetadata(dir, originalName);
    return { success: true, filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function handleRingtoneLoad() {
  try {
    const dir = getRingtoneDir();
    const entries = listCustomRingtoneFiles(dir);
    if (entries.length === 0) return { success: false };
    const filePath = path.join(dir, entries[0]);
    const buffer = fs.readFileSync(filePath);
    const metadata = readRingtoneMetadata(dir);
    return {
      success: true,
      buffer,
      fileName: entries[0],
      displayName: metadata?.originalName || entries[0],
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function handleRingtoneDelete() {
  try {
    const dir = getRingtoneDir();
    const entries = listCustomRingtoneFiles(dir);
    for (const f of entries) fs.unlinkSync(path.join(dir, f));
    clearRingtoneMetadata(dir);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function handleRingtoneGetInfo() {
  try {
    const dir = getRingtoneDir();
    if (!fs.existsSync(dir)) return { exists: false, fileName: null, size: 0 };
    const entries = listCustomRingtoneFiles(dir);
    if (entries.length === 0) return { exists: false, fileName: null, size: 0 };
    const file = entries[0];
    const size = fs.statSync(path.join(dir, file)).size;
    const metadata = readRingtoneMetadata(dir);
    return {
      exists: true,
      fileName: file,
      displayName: metadata?.originalName || file,
      size,
    };
  } catch {
    return { exists: false, fileName: null, size: 0 };
  }
}

function handleRingtoneOpenFolder() {
  try {
    const dir = getRingtoneDir();
    listCustomRingtoneFiles(dir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = {
  SAFE_IMAGE_ID,
  SAFE_VOICE_ID,
  IMAGE_EXT_WHITELIST,
  RINGTONE_AUDIO_EXTENSIONS,
  findImageFile,
  findVoiceFile,
  findRingtoneFile,
  handleImagesSave,
  handleImagesLoad,
  handleImagesDelete,
  handleImagesList,
  handleImagesOpenFolder,
  handleImagesGetStorageInfo,
  handleVoiceSave,
  handleVoiceLoad,
  handleVoiceDelete,
  handleVoiceList,
  handleVoiceOpenFolder,
  handleVoiceGetStorageInfo,
  handleVoiceClearAll,
  handleRingtoneSave,
  handleRingtoneLoad,
  handleRingtoneDelete,
  handleRingtoneGetInfo,
  handleRingtoneOpenFolder,
};
