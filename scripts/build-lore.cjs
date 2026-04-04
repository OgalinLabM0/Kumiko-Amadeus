const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENCRYPTION_KEY = 'kumiko-amadeus-lore-2026-hibike';
const IV_LENGTH = 16;

function encrypt(text) {
  const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function main() {
  const loreDataPath = path.join(__dirname, '..', 'services', 'loreData.ts');
  const outputDir = path.join(__dirname, '..', 'assets');
  const outputPath = path.join(outputDir, 'lore.enc');

  if (!fs.existsSync(loreDataPath)) {
    console.error('loreData.ts not found. Skipping lore encryption.');
    process.exit(0);
  }

  const source = fs.readFileSync(loreDataPath, 'utf8');

  // Strip TypeScript: remove export, interface, and type annotations to get plain JS
  let jsSource = source
    .replace(/export\s+interface\s+LoreChunk\s*\{[^}]*\}/s, '')
    .replace(/export\s+const/, 'const')
    .replace(/:\s*LoreChunk\[\]/, '');

  let chunks;
  try {
    const fn = new Function(`${jsSource}; return LORE_CHUNKS;`);
    chunks = fn();
  } catch (e) {
    console.error('Failed to parse LORE_CHUNKS:', e.message);
    process.exit(1);
  }

  if (!Array.isArray(chunks) || chunks.length === 0) {
    console.error('LORE_CHUNKS is empty or invalid');
    process.exit(1);
  }

  const json = JSON.stringify(chunks);
  const encrypted = encrypt(json);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, encrypted, 'utf8');
  console.log(`Encrypted ${chunks.length} lore chunks to ${outputPath} (${(encrypted.length / 1024).toFixed(1)} KB)`);
}

main();
