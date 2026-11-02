const ENTRY_LIMIT = 256 * 1024 * 1024;
const ARCHIVE_LIMIT = 512 * 1024 * 1024;

// Reject unsafe metadata first. Actual decompressed bytes are checked below;
// a ZIP's declared size is not a trustworthy allocation bound.
export function validateBackupArchive(zip) {
  const entries = Object.values(zip.files);
  if (entries.length > 50000) throw new Error('Backup has too many entries');
  let total = 0;
  for (const entry of entries) {
    const name = entry.unsafeOriginalName ?? entry.name;
    if (typeof name !== 'string' || name.length > 1024 || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some(part => part === '..' || part === '.')) throw new Error('Unsafe backup path');
    if (entry.dir) continue;
    const size = entry._data?.uncompressedSize;
    if (!Number.isSafeInteger(size) || size < 0 || size > ENTRY_LIMIT) throw new Error('Invalid backup entry size');
    total += size;
    if (total > ARCHIVE_LIMIT) throw new Error('Backup is too large');
  }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function lowerLimit(value, maximum) {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error('Invalid backup read limit');
  return value;
}

export function createBackupArchiveReader(zip, options = {}) {
  validateBackupArchive(zip);
  const entryLimit = lowerLimit(options.entryLimit, ENTRY_LIMIT);
  const totalLimit = lowerLimit(options.totalLimit, ARCHIVE_LIMIT);
  const entries = new Set(Object.values(zip.files));
  let total = 0;
  let failed;
  let queue = Promise.resolve();

  function readEntry(entry, type) {
    if (failed) throw failed;
    if (!entries.has(entry) || entry.dir) throw new Error('Unknown backup entry');
    if (type !== 'string' && type !== 'base64') throw new Error('Unsupported backup output type');
    return new Promise((resolve, reject) => {
      const stream = entry.internalStream('uint8array');
      let chunks = [];
      let size = 0;
      let crc = 0xffffffff;
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        failed = error;
        stream.pause();
        chunks = [];
        reject(error);
      };
      stream.on('data', chunk => {
        if (settled) return;
        if (size + chunk.length > entryLimit || total + chunk.length > totalLimit) {
          fail(new Error('Backup decompressed data exceeds the read limit'));
          return;
        }
        size += chunk.length;
        total += chunk.length;
        for (let i = 0; i < chunk.length; i++) crc = crcTable[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
        chunks.push(chunk);
      }).on('error', fail).on('end', () => {
        if (settled) return;
        try {
          if (size !== entry._data.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== (entry._data.crc32 >>> 0)) {
            throw new Error('Backup entry integrity check failed');
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          chunks = [];
          let result;
          if (type === 'string') result = new TextDecoder().decode(bytes);
          else {
            const encoded = [];
            // Chunk length is divisible by three so concatenated base64 has
            // padding only at the very end, and no large argument spread.
            for (let i = 0; i < bytes.length; i += 24576) encoded.push(btoa(String.fromCharCode(...bytes.subarray(i, i + 24576))));
            result = encoded.join('');
          }
          settled = true;
          resolve(result);
        } catch (error) { fail(error); }
      }).resume();
    });
  }

  return {
    read(entry, type = 'string') {
      // A single cumulative budget also applies if a caller starts reads in
      // parallel; any damaged/overlarge entry makes the whole import fail.
      const result = queue.then(() => readEntry(entry, type));
      queue = result.catch(() => {});
      return result;
    },
  };
}
