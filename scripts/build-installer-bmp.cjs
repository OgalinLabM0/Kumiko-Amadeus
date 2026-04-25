/**
 * scripts/build-installer-bmp.cjs
 *
 * v2.14.5 E.1/E.2 + v2.14.6 B: prepare the two BMP assets that NSIS MUI2
 * needs for the Windows installer Welcome page.
 *
 *   build/installerSidebar.bmp   164 x 314, 24-bit BMP  (MUI WelcomePage sidebar)
 *   build/installerHeader.bmp    150 x  57, 24-bit BMP  (MUI HEADERIMAGE strip)
 *
 * Sidebar source artwork (commissioned, NOT AI-generated) lives one folder up
 * so it stays out of git:
 *
 *   ..\TT2.png            – portrait Kumiko illustration (sidebar source)
 *
 * Header source (v2.14.6 B): the in-repo app favicon. The user complained that
 * the v2.14.5 cropped-from-I02.png header was too generic / hard to identify
 * as KA at small size. The favicon is the single visual asset every Kumiko
 * surface (taskbar, title bar, About, store) already shares, so reusing it on
 * the installer header keeps the brand instantly recognisable. The favicon is
 * scaled DOWN to a small 40px sprite and centred on a 150x57 white canvas (so
 * the icon doesn't fill edge-to-edge — see the v2.14.6 plan note "smaller").
 *
 *   public/favicon-KA.png – square app icon (header source)
 *
 * Pipeline per output:
 *   - 'cover' mode (sidebar): cover-crop & resize, alpha-flatten on cream,
 *     hand-encode 24-bit BMP.
 *   - 'iconCenter' mode (header): resize favicon DOWN to icon size, composite
 *     centred on a white canvas of the target size, hand-encode 24-bit BMP.
 *
 * Why hand-encode the BMP: `sharp` doesn't expose a BMP writer, and NSIS only
 * accepts 24-bit (or 8-bit palette) BMP for installer bitmaps. Writing the
 * 54-byte header ourselves keeps the dependency footprint zero.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const repoRoot = path.resolve(__dirname, '..');
// Sidebar artwork lives OUTSIDE the repo (in the parent C-KA brand-asset
// folder) so we never accidentally commit copyrighted source illustrations
// into git history.
const brandAssetsRoot = path.resolve(repoRoot, '..');

const TARGETS = [
  {
    name: 'sidebar',
    mode: 'cover',
    source: path.join(brandAssetsRoot, 'TT2.png'),
    out: path.join(repoRoot, 'build', 'installerSidebar.bmp'),
    width: 164,
    height: 314,
    // top-anchored cover: keep KA monogram + Kumiko's head visible, crop feet
    // if necessary. North gravity = anchor to top edge.
    gravity: 'north',
  },
  {
    name: 'header',
    mode: 'iconCenter',
    // v2.14.6 B: in-repo favicon (square, transparent). NSIS header BMP must
    // be 24-bit so we composite the favicon onto a white canvas before encode.
    source: path.join(repoRoot, 'public', 'favicon-KA.png'),
    out: path.join(repoRoot, 'build', 'installerHeader.bmp'),
    width: 150,
    height: 57,
    // Favicon rendered SMALL inside the strip so it reads as a chip / accent
    // rather than filling the whole header. 40x40 leaves ~8px vertical
    // breathing room above and below in a 57px-tall strip.
    iconSize: 40,
    // Solid background colour the icon sits on. Pure white matches NSIS MUI2
    // default header band (#FFFFFF) so there's no visible seam.
    canvasBackground: { r: 255, g: 255, b: 255 },
  },
];

// 24-bit BMP encoder. RGB byte order in BMP file is BGR per pixel, rows are
// stored bottom-up, every row padded to a 4-byte boundary.
function encodeBmp24(rgbBuf, width, height) {
  const rowSize = Math.floor((24 * width + 31) / 32) * 4; // 4-byte aligned
  const pixelArraySize = rowSize * height;
  const fileSize = 54 + pixelArraySize;

  const header = Buffer.alloc(54);
  // BITMAPFILEHEADER (14 bytes)
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(fileSize, 2);
  header.writeUInt32LE(0, 6); // reserved
  header.writeUInt32LE(54, 10); // pixel data offset
  // BITMAPINFOHEADER (40 bytes)
  header.writeUInt32LE(40, 14); // header size
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22); // positive = bottom-up
  header.writeUInt16LE(1, 26); // planes
  header.writeUInt16LE(24, 28); // bpp
  header.writeUInt32LE(0, 30); // BI_RGB (no compression)
  header.writeUInt32LE(pixelArraySize, 34);
  header.writeInt32LE(2835, 38); // 72 DPI horizontal in pixels/meter
  header.writeInt32LE(2835, 42); // 72 DPI vertical
  header.writeUInt32LE(0, 46); // colors used
  header.writeUInt32LE(0, 50); // important colors

  const pixels = Buffer.alloc(pixelArraySize);
  // sharp gives us RGB top-down; BMP wants BGR bottom-up.
  for (let y = 0; y < height; y++) {
    const srcRow = y * width * 3;
    const dstRow = (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const srcOff = srcRow + x * 3;
      const dstOff = dstRow + x * 3;
      pixels[dstOff + 0] = rgbBuf[srcOff + 2]; // B
      pixels[dstOff + 1] = rgbBuf[srcOff + 1]; // G
      pixels[dstOff + 2] = rgbBuf[srcOff + 0]; // R
    }
    // remaining bytes in the row stay zero (padding)
  }

  return Buffer.concat([header, pixels]);
}

async function buildOne(target) {
  if (!fs.existsSync(target.source)) {
    console.error(`[installer-bmp] source not found: ${target.source}`);
    process.exit(1);
  }

  let pipeline;
  if (target.mode === 'iconCenter') {
    // Render the favicon DOWN to iconSize, then composite centred onto a
    // canvasBackground-coloured rectangle of the full target size. This keeps
    // the icon small (per v2.14.6 B "smaller") and surrounded by white.
    const iconBuf = await sharp(target.source)
      .resize(target.iconSize, target.iconSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    pipeline = sharp({
      create: {
        width: target.width,
        height: target.height,
        channels: 4,
        background: { ...target.canvasBackground, alpha: 1 },
      },
    })
      .composite([{ input: iconBuf, gravity: 'centre' }])
      .flatten({ background: target.canvasBackground })
      .removeAlpha()
      .raw();
  } else {
    pipeline = sharp(target.source);
    if (target.extract) {
      pipeline = pipeline.extract(target.extract);
    }
    pipeline = pipeline
      .resize(target.width, target.height, {
        fit: 'cover',
        position: target.gravity,
      })
      // flatten any alpha onto brand cream so the BMP is fully opaque
      .flatten({ background: { r: 249, g: 247, b: 242 } })
      .removeAlpha()
      .raw();
  }

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  if (info.width !== target.width || info.height !== target.height) {
    console.error(
      `[installer-bmp] sharp produced ${info.width}x${info.height}, expected ${target.width}x${target.height}`,
    );
    process.exit(1);
  }
  if (info.channels !== 3) {
    console.error(`[installer-bmp] expected 3 channels, got ${info.channels}`);
    process.exit(1);
  }

  const bmp = encodeBmp24(data, target.width, target.height);
  fs.mkdirSync(path.dirname(target.out), { recursive: true });
  fs.writeFileSync(target.out, bmp);
  console.log(
    `[installer-bmp] ${target.name}: ${target.width}x${target.height} 24-bit -> ${target.out} (${bmp.length} bytes)`,
  );
}

async function main() {
  for (const t of TARGETS) {
    await buildOne(t);
  }
}

main().catch((e) => {
  console.error('[installer-bmp] failed:', e);
  process.exit(1);
});
