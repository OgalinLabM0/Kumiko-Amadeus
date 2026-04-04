const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const projectRoot = path.resolve(__dirname, '..');
const releaseDir = path.join(projectRoot, 'release');
const outputPath = path.join(releaseDir, 'kumiko-assets.zip');

const ASSETS = [
  { src: 'public/images/emotions', dir: true },
  { src: 'public/ringtones', dir: true },
  { src: 'public/images/logo.png' },
  { src: 'public/CCA-P2.png' },
  { src: 'public/favicon-KA.ico' },
  { src: 'assets/worldbook.enc' },
  { src: 'assets/lore.enc' },
];

async function main() {
  const zip = new JSZip();
  let fileCount = 0;

  for (const asset of ASSETS) {
    const fullPath = path.join(projectRoot, asset.src);
    if (!fs.existsSync(fullPath)) {
      console.warn(`[assets] Skipping missing: ${asset.src}`);
      continue;
    }

    if (asset.dir) {
      const entries = fs.readdirSync(fullPath).filter(f => !f.startsWith('.'));
      for (const entry of entries) {
        const filePath = path.join(fullPath, entry);
        if (fs.statSync(filePath).isFile()) {
          zip.file(path.join(asset.src, entry).replace(/\\/g, '/'), fs.readFileSync(filePath));
          fileCount++;
        }
      }
    } else {
      zip.file(asset.src.replace(/\\/g, '/'), fs.readFileSync(fullPath));
      fileCount++;
    }
  }

  if (fileCount === 0) {
    console.warn('[assets] No files found to package. Skipping kumiko-assets.zip.');
    return;
  }

  if (!fs.existsSync(releaseDir)) fs.mkdirSync(releaseDir, { recursive: true });

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  fs.writeFileSync(outputPath, buffer);
  console.log(`Generated ${outputPath} (${fileCount} files, ${(buffer.length / 1024).toFixed(1)} KB)`);
}

main().catch(e => { console.error('[assets]', e.message); process.exit(1); });
