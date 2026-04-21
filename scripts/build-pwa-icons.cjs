// scripts/build-pwa-icons.cjs
//
// Phase 7 Part t1_icons + brand-fix: generate the PWA icons referenced by
// index.html and vite.config.ts (icon-192.png, icon-512.png,
// apple-touch-icon-180.png, icon-192-maskable.png, icon-512-maskable.png)
// from the source brand asset `public/favicon-KA.png`.
//
// Two image families
// ------------------
// 1. `any` purpose (icon-192 / icon-512 / apple-touch-icon-180):
//    pure resize of the PC favicon — no padding, no background fill,
//    alpha transparency preserved. This makes the phone home-screen
//    icon visually identical to the Windows tray / Linux AppImage icon
//    that electron-builder ships (same PNG source, only downscaled).
//
// 2. `maskable` purpose (icon-192-maskable / icon-512-maskable):
//    Android's adaptive-icon spec requires ~20 % padding around the
//    visible logo so the system mask (circle / rounded square / squircle)
//    doesn't clip the glyph. These two variants add that safe zone plus a
//    solid background matching `theme_color` (#f9f7f2), so the launcher
//    renders them cleanly. The `any` files above stay tight to the edge
//    and are used everywhere that doesn't apply a mask.
//
// Why this split exists
// ---------------------
// The earlier build produced only one family with 8 % padding + a warm
// cream background that made the home-screen icon look like a different
// asset than the desktop tray. Separating `any` (PC-identical) from
// `maskable` (Android-safe) lets both launchers get a pleasant result
// without compromising the "looks like the PC icon" promise.
//
// Desktop Electron builders are unaffected: package.json `build.win.icon`
// and `build.linux.icon` still point at `public/favicon-KA.ico` /
// `public/favicon-KA.png`, which this script never touches — it only
// *adds* new files alongside them.
//
// Idempotent: running multiple times produces byte-identical output for
// the same source. Wired into `prebuild` so `npm run build` always
// refreshes icons before vite-plugin-pwa hashes them into the manifest.

const path = require('node:path');
const fs = require('node:fs');

const repoRoot = path.resolve(__dirname, '..');
const publicDir = path.join(repoRoot, 'public');
const sourcePng = path.join(publicDir, 'favicon-KA.png');

const THEME_BG = { r: 249, g: 247, b: 242, alpha: 1 };

const anyTargets = [
  { out: 'icon-192.png', size: 192 },
  { out: 'icon-512.png', size: 512 },
  { out: 'apple-touch-icon-180.png', size: 180 },
];

const maskableTargets = [
  { out: 'icon-192-maskable.png', size: 192, padding: 0.2 },
  { out: 'icon-512-maskable.png', size: 512, padding: 0.2 },
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

async function renderMaskable(sharp, source, target) {
  const outPath = path.join(publicDir, target.out);
  const padPx = Math.round(target.size * target.padding);
  const innerSize = target.size - padPx * 2;

  const inner = await sharp(source)
    .resize(innerSize, innerSize, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toBuffer();

  await sharp({
    create: {
      width: target.size,
      height: target.size,
      channels: 4,
      background: THEME_BG,
    },
  })
    .composite([{ input: inner, top: padPx, left: padPx }])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outPath);

  const stat = fs.statSync(outPath);
  console.log(`[pwa-icons] (maskable) ${target.out} ${target.size}x${target.size} -> ${stat.size} bytes`);
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
  for (const t of maskableTargets) {
    await renderMaskable(sharp, sourcePng, t);
  }
}

main().catch((err) => {
  console.error('[pwa-icons] failed:', err);
  process.exit(1);
});
