// scripts/build-android-icons.cjs
//
// A1.3: Generate the Android launcher icons referenced by AndroidManifest.xml
// (ic_launcher.png, ic_launcher_round.png, ic_launcher_foreground.png at five
// density buckets, plus the cream-tinted ic_launcher_background.xml drawable)
// from the same source brand asset that drives PWA icons / Windows tray /
// Linux AppImage: `public/favicon-KA.png`.
//
// Three output families
// ---------------------
// 1. Legacy launcher (`ic_launcher.png`):
//    Pre-Android-8 launcher icon. 48dp visible, full-bleed (no padding,
//    transparent background). Sized at 48/72/96/144/192 px for the five
//    density buckets (mdpi/hdpi/xhdpi/xxhdpi/xxxhdpi).
//
// 2. Legacy round launcher (`ic_launcher_round.png`):
//    Pre-adaptive-icon round-launcher fallback (Pixel launcher on
//    Android 7.x). Same content as ic_launcher.png; modern launchers
//    that clip to a circle ignore this and use the adaptive icon. We
//    generate it identical so older launchers don't fall back to the
//    bundled Capacitor bird.
//
// 3. Adaptive icon foreground (`ic_launcher_foreground.png`):
//    Android 8+ adaptive-icon spec: 108dp canvas with the visible glyph
//    confined to the inner 60dp circle (24dp safe zone all around) so
//    the system mask (circle / squircle / teardrop) doesn't clip the
//    icon. Sized at 108/162/216/324/432 px.
//
// Plus a static drawable XML (`drawable/ic_launcher_background.xml`)
// that fills the background layer with the brand cream `#f9f7f2`,
// matching the splash / pairing-page background and PWA maskable
// background.
//
// Wiring: invoked from `scripts/build-cap.cjs` (and eventually the
// Android workflow in `.github/workflows/android-apk-release.yml`)
// before `npx cap sync android` so the regenerated icons get copied
// into the APK assets.
//
// Idempotent: byte-identical output for the same source.
//
// Failure modes:
// - `public/favicon-KA.png` missing → log + exit 0 (PWA icon script
//   does the same; lets fresh clones without `npm run fetch-assets`
//   still succeed at `cap add android`).
// - `sharp` missing → log + exit 0 (matches build-pwa-icons.cjs).

const path = require('node:path');
const fs = require('node:fs');

const repoRoot = path.resolve(__dirname, '..');
const publicDir = path.join(repoRoot, 'public');
const sourcePng = path.join(publicDir, 'favicon-KA.png');
const androidResDir = path.join(repoRoot, 'android', 'app', 'src', 'main', 'res');

const THEME_BG_HEX = '#f9f7f2';
const THEME_BG_RGBA = { r: 0xf9, g: 0xf7, b: 0xf2, alpha: 1 };

// 48dp at each density bucket. Same scale Android uses for legacy launcher
// and round-launcher icons (Android <8 + Pixel 7.x round fallback).
const LEGACY_DENSITIES = [
  { dir: 'mipmap-mdpi', size: 48 },
  { dir: 'mipmap-hdpi', size: 72 },
  { dir: 'mipmap-xhdpi', size: 96 },
  { dir: 'mipmap-xxhdpi', size: 144 },
  { dir: 'mipmap-xxxhdpi', size: 192 },
];

// 108dp at each density bucket (adaptive icon canvas). The visible glyph
// must fit inside the inner 66dp (≈ 60dp safe zone + 6dp tolerance);
// Android's various launcher masks (circle / squircle / squareRound /
// teardrop) clip everything outside that inner region.
const ADAPTIVE_DENSITIES = [
  { dir: 'mipmap-mdpi', size: 108 },
  { dir: 'mipmap-hdpi', size: 162 },
  { dir: 'mipmap-xhdpi', size: 216 },
  { dir: 'mipmap-xxhdpi', size: 324 },
  { dir: 'mipmap-xxxhdpi', size: 432 },
];

// Visible glyph occupies the inner 66dp (out of 108dp canvas) — 21dp of
// safe zone all around, comfortably inside the 18dp Android-spec minimum
// while still showing a punchy logo at typical launcher sizes.
const ADAPTIVE_INNER_RATIO = 66 / 108;

async function renderLegacyLauncher(sharp, outName) {
  for (const target of LEGACY_DENSITIES) {
    const outDir = path.join(androidResDir, target.dir);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, outName);
    await sharp(sourcePng)
      .resize(target.size, target.size, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toFile(outPath);
    const stat = fs.statSync(outPath);
    console.log(
      `[android-icons] legacy   ${target.dir}/${outName} ${target.size}x${target.size} -> ${stat.size} bytes`,
    );
  }
}

async function renderAdaptiveForeground(sharp) {
  for (const target of ADAPTIVE_DENSITIES) {
    const outDir = path.join(androidResDir, target.dir);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'ic_launcher_foreground.png');

    const innerSize = Math.round(target.size * ADAPTIVE_INNER_RATIO);
    const padPx = Math.round((target.size - innerSize) / 2);

    const inner = await sharp(sourcePng)
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
        // Foreground layer is composited on top of the background drawable;
        // it must itself be transparent so the cream layer shows through.
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: inner, top: padPx, left: padPx }])
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toFile(outPath);

    const stat = fs.statSync(outPath);
    console.log(
      `[android-icons] adaptive ${target.dir}/ic_launcher_foreground.png ${target.size}x${target.size} (inner ${innerSize}) -> ${stat.size} bytes`,
    );
  }
}

function writeBackgroundDrawable() {
  const drawableDir = path.join(androidResDir, 'drawable');
  fs.mkdirSync(drawableDir, { recursive: true });
  const out = path.join(drawableDir, 'ic_launcher_background.xml');
  // Solid color at the brand cream so the adaptive icon background layer
  // matches the splash / pairing-page background. The Capacitor default
  // ships a vector with a Capacitor-blue gradient, which clashes with the
  // KA brand glyph.
  const xml = `<?xml version="1.0" encoding="utf-8"?>\n<shape xmlns:android="http://schemas.android.com/apk/res/android"\n    android:shape="rectangle">\n    <solid android:color="${THEME_BG_HEX}" />\n</shape>\n`;
  fs.writeFileSync(out, xml, 'utf8');
  console.log(`[android-icons] drawable ic_launcher_background.xml -> ${THEME_BG_HEX}`);
}

async function main() {
  if (!fs.existsSync(sourcePng)) {
    console.warn(
      `[android-icons] source missing: ${sourcePng}\n` +
        `  Run \`npm run fetch-assets\` first (or wait for the workflow to do it on CI).`,
    );
    return;
  }
  if (!fs.existsSync(androidResDir)) {
    console.warn(
      `[android-icons] android/ not generated yet: ${androidResDir}\n` +
        `  Run \`npx cap add android\` first.`,
    );
    return;
  }

  let sharp;
  try {
    sharp = require('sharp');
  } catch (e) {
    console.warn(
      `[android-icons] sharp is not available, skipping icon generation. (${e.message})`,
    );
    return;
  }

  await renderLegacyLauncher(sharp, 'ic_launcher.png');
  await renderLegacyLauncher(sharp, 'ic_launcher_round.png');
  await renderAdaptiveForeground(sharp);
  writeBackgroundDrawable();

  // Older Capacitor templates also ship an `ic_launcher_background.xml`
  // inside `res/values/` that defines a `<color>` resource referenced
  // from the v26 mipmap XMLs. If present, normalise it to the brand
  // cream too. Best-effort — leave alone if file shape is unexpected.
  const valuesBgXml = path.join(androidResDir, 'values', 'ic_launcher_background.xml');
  if (fs.existsSync(valuesBgXml)) {
    const next = `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${THEME_BG_HEX}</color>\n</resources>\n`;
    fs.writeFileSync(valuesBgXml, next, 'utf8');
    console.log(`[android-icons] values/ic_launcher_background.xml -> ${THEME_BG_HEX}`);
  }
}

main().catch((err) => {
  console.error('[android-icons] failed:', err);
  process.exit(1);
});
