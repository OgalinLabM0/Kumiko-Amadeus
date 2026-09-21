// Dependency-free shared import contract for both the Vite renderer and the
// Electron main process. Keep this as native ESM: Vite's dev transform does
// not synthesize default exports for local CommonJS files.

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.prototype.toString.call(value) === '[object Object]';
}

function invalid(reason) {
  return { valid: false, reason };
}

function validateArrayField(payload, field) {
  if (payload[field] !== undefined && !Array.isArray(payload[field])) {
    return `${field} must be an array when present`;
  }
  return null;
}

function hasValidBackupMessage(message) {
  if (!isPlainObject(message)) return false;
  if (typeof message.id !== 'string' || !message.id.trim()) return false;
  if (message.role !== 'user' && message.role !== 'model') return false;
  if (!Number.isFinite(Number(message.timestamp))) return false;
  if (message.text !== undefined && typeof message.text !== 'string') return false;
  if (message.image !== undefined && typeof message.image !== 'string') return false;
  if (message.imageId !== undefined && typeof message.imageId !== 'string') return false;
  if (message.voiceFileId !== undefined && typeof message.voiceFileId !== 'string') return false;
  return typeof message.text === 'string'
    || typeof message.image === 'string'
    || typeof message.imageId === 'string'
    || typeof message.voiceFileId === 'string';
}

function hasValidBackupVector(vector) {
  if (!isPlainObject(vector)) return false;
  if (typeof vector.id !== 'string' || !vector.id.trim()) return false;
  if (typeof vector.text !== 'string') return false;
  if (typeof vector.timestamp !== 'number' || !Number.isFinite(vector.timestamp)) return false;
  if (!Array.isArray(vector.vector) || vector.vector.length === 0 || !vector.vector.every(Number.isFinite)) return false;
  if (vector.messageId !== undefined && vector.messageId !== null && typeof vector.messageId !== 'string') return false;
  if (vector.tier !== undefined && !['core', 'episodic', 'background'].includes(vector.tier)) return false;
  if (vector.source !== undefined && typeof vector.source !== 'string') return false;
  if (vector.score !== undefined && !Number.isFinite(vector.score)) return false;
  if (vector.canonicalKey !== undefined && typeof vector.canonicalKey !== 'string') return false;
  if (vector.role !== undefined && typeof vector.role !== 'string') return false;
  return true;
}

export function validateBackupImportPayload(candidate) {
  if (!isPlainObject(candidate)) return invalid('Backup root must be an object');
  const hasEnvelope = Object.prototype.hasOwnProperty.call(candidate, 'data');
  const payload = hasEnvelope ? candidate.data : candidate;
  if (!isPlainObject(payload)) return invalid('Backup data must be an object');
  if (!Object.prototype.hasOwnProperty.call(payload, 'messages') || !Array.isArray(payload.messages)) {
    return invalid('Backup must contain a messages array');
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'worldBook') || !Array.isArray(payload.worldBook)) {
    return invalid('Backup must contain a worldBook array');
  }
  if (!payload.messages.every(hasValidBackupMessage)) {
    return invalid('Backup messages must contain valid id, role, timestamp, and content');
  }
  if (!payload.worldBook.every(isPlainObject)) return invalid('Backup worldBook must contain objects');

  for (const field of ['anchors', 'relativeReminders', 'dailyReminders', 'kumikoDiary', 'dailyFragments', 'episodes']) {
    const valueOwner = payload[field] !== undefined ? payload : candidate;
    const error = validateArrayField(valueOwner, field);
    if (error) return invalid(error);
  }
  for (const field of ['kumikoDiary', 'dailyFragments', 'episodes']) {
    const value = payload[field] !== undefined ? payload[field] : candidate[field];
    if (Array.isArray(value) && !value.every(isPlainObject)) return invalid(`${field} must contain objects`);
  }
  for (const field of ['coreMemory', 'currentEmotion', 'language', 'kumikoNotebook']) {
    if (payload[field] !== undefined && typeof payload[field] !== 'string') return invalid(`${field} must be a string when present`);
  }
  for (const field of ['contextLimit', 'turnCount']) {
    if (payload[field] !== undefined && (typeof payload[field] !== 'number' || !Number.isFinite(payload[field]))) {
      return invalid(`${field} must be a finite number when present`);
    }
  }
  for (const field of ['summaryArchiveState', 'locationConfig', 'worldCharacterStatus', 'psycheState']) {
    const value = payload[field] !== undefined ? payload[field] : candidate[field];
    if (value !== undefined && value !== null && !isPlainObject(value)) return invalid(`${field} must be an object or null when present`);
  }
  if (candidate.vectors !== undefined) {
    if (!Array.isArray(candidate.vectors)) return invalid('vectors must be an array when present');
    const ids = new Set();
    for (const vector of candidate.vectors) {
      if (!hasValidBackupVector(vector)) return invalid('vectors must contain valid unique records');
      if (ids.has(vector.id)) return invalid('vectors must not contain duplicate ids');
      ids.add(vector.id);
    }
  }
  return { valid: true, payload, hasEnvelope };
}
