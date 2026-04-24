// scripts/build-pwa-icons.cjs
//
// F2B.4: trimmed down. Originally this generated the full PWA icon set
// (icon-192/512, maskable variants, apple-touch-icon) for the
// vite-plugin-pwa-generated webmanifest. With the PWA pipeline removed
// (manifest, service worker, web-push, ping-server all gone in F2B.4),
// the only home-screen icon still referenced from index.html is the
// iOS Safari `apple-touch-icon-180.png`. Everything else is now packaged
// natively: Capacitor uses `android/app/src/main/res/mipmap-*/`, and
// Electron uses `public/favicon-KA.ico` / `favicon-KA.png` directly.
//
// Kept the script (vs deleting it outright) because:
//   - `package.json` `prebuild` still calls it, so removing it would
//     require touching the release pipeline.
//   - It guarantees the apple-touch icon stays in lockstep with the PC
//     favicon (single source = `public/favicon-KA.png`).
//
// Idempotent + skips silently if `sharp` isn't installed.

const path = require('node:path');
const fs = require('node:fs');

const repoRoot = path.resolve(__dirname, '..');
const publicDir = path.join(repoRoot, 'public');
const sourcePng = path.join(publicDir, 'favicon-KA.png');

const anyTargets = [
  { out: 'apple-touch-icon-180.png', size: 180 },
];

async function renderAny(sharp, source, target) {
  const outPath = path.join(publicDir, target.out);
  await sharp(source)
    .resize(target.size, target.size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outPath);
  const stat = fs.statSync(outPath);
  console.log(`[pwa-icons] (any)      ${target.out} ${target.size}x${target.size} -> ${stat.size} bytes`);
}

async function main() {
  if (!fs.existsSync(sourcePng)) {
    console.error(`[pwa-icons] source missing: ${sourcePng}`);
    process.exit(1);
  }

  let sharp;
  try {
    sharp = require('sharp');
  } catch (e) {
    console.warn(
      `[pwa-icons] sharp is not available, skipping icon generation. ` +
        `Install sharp or run the build on a supported platform. (${e.message})`,
    );
    return;
  }

  for (const t of anyTargets) {
    await renderAny(sharp, sourcePng, t);
  }
}

main().catch((err) => {
  console.error('[pwa-icons] failed:', err);
  process.exit(1);
});
