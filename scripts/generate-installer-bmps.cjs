#!/usr/bin/env node
// v2.14.11 — regenerate the NSIS MUI2 installer header bitmap from the
// shared transparent K-Amadeus logo, on a flat MUI_BGCOLOR-matching
// canvas so the header strip no longer shows a jarring gold rectangle
// against the dialog body.
//
// Background (the user's complaint):
//   The pre-v2.14.11 build/installerHeader.bmp baked the K logo onto a
//   warm gold/cream rectangle. NSIS MUI's HEADERIMAGE control draws the
//   bitmap on top of a header strip that uses MUI_BGCOLOR (set to
//   #F6F7FB in build/installer.nsh), so the gold rectangle floated as
//   a visible color block on top of the lighter dialog header. From
//   the screenshot: "你不觉得 pc 安装包的顶部颜色割裂吗？".
//
// What this script does:
//   1. Loads public/favicon-KA.png (256x256 transparent gold "K AMADEUS"
//      wordmark — the same source the in-app favicon uses, so we stay
//      visually consistent across PWA / Android / Windows installer).
//   2. Composites it onto a 150x57 RGB canvas filled with the same
//      MUI_BGCOLOR the surrounding installer chrome uses. Right-aligns
//      the logo at the standard MUI_HEADERIMAGE_RIGHT position so the
//      title/subtitle on the left has room to breathe.
//   3. Writes the result as a 24-bit Windows BMP via the same hand-rolled
//      header that build/installer-skin/scripts/generate-assets.cjs
//      uses for nsNiuniuSkin assets — sharp can do the resize/composite
//      but cannot output a BMP container, so we encode it ourselves.
//
// Re-run any time the K-Amadeus logo changes. Output:
//   build/installerHeader.bmp  (150x57, 24bpp, ~25 KB)
//
// We deliberately do NOT touch build/installerSidebar.bmp here — the
// welcome / finish page sidebar uses a different art treatment that's
// fine as-is. Add a sibling helper if that ever needs the same flow.

'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const projectRoot = path.resolve(__dirname, '..');
const SOURCE_LOGO = path.join(projectRoot, 'public', 'favicon-KA.png');
const OUTPUT_BMP = path.join(projectRoot, 'build', 'installerHeader.bmp');

// Match build/installer.nsh `!define MUI_BGCOLOR "F6F7FB"` exactly so
// the BMP background blends with the dialog header strip and there is
// no visible color block.
const BG_R = 0xf6;
const BG_G = 0xf7;
const BG_B = 0xfb;

// MUI2 header bitmap canonical dimensions. Anything else gets scaled by
// MUI's GDI blit and looks blurry on high-DPI displays.
const HEADER_WIDTH = 150;
const HEADER_HEIGHT = 57;

// Target logo size + right-edge padding. 49x49 leaves 4px top/bottom
// breathing room and 8px on the right, so the logo sits squarely in the
// header strip without crowding the wizard step number on the left.
const LOGO_SIZE = 49;
const LOGO_RIGHT_PAD = 8;
const LOGO_TOP_PAD = Math.round((HEADER_HEIGHT - LOGO_SIZE) / 2);

function encodeBmp24(rgba, width, height, channels) {
  const rowBytes = width * 3;
  const rowPad = (4 - (rowBytes % 4)) % 4;
  const stride = rowBytes + rowPad;
  const pixelBytes = stride * height;
  const fileSize = 14 + 40 + pixelBytes;

  const buf = Buffer.alloc(fileSize);
  buf.write('BM', 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(0, 6);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(pixelBytes, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(0, 46);
  buf.writeUInt32LE(0, 50);

  for (let y = 0; y < height; y += 1) {
    const srcRow = (height - 1 - y) * width * channels;
    const dstRow = 54 + y * stride;
    for (let x = 0; x < width; x += 1) {
      const s = srcRow + x * channels;
      const d = dstRow + x * 3;
      buf[d] = rgba[s + 2];
      buf[d + 1] = rgba[s + 1];
      buf[d + 2] = rgba[s];
    }
    for (let p = 0; p < rowPad; p += 1) buf[dstRow + rowBytes + p] = 0;
  }

  return buf;
}

async function main() {
  if (!fs.existsSync(SOURCE_LOGO)) {
    throw new Error(`Source logo missing: ${SOURCE_LOGO}. Run npm run fetch-assets first.`);
  }

  const logoPng = await sharp(SOURCE_LOGO)
    .resize(LOGO_SIZE, LOGO_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const composed = await sharp({
    create: {
      width: HEADER_WIDTH,
      height: HEADER_HEIGHT,
      channels: 3,
      background: { r: BG_R, g: BG_G, b: BG_B },
    },
  })
    .composite([
      {
        input: logoPng,
        left: HEADER_WIDTH - LOGO_RIGHT_PAD - LOGO_SIZE,
        top: LOGO_TOP_PAD,
      },
    ])
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bmp = encodeBmp24(composed.data, composed.info.width, composed.info.height, composed.info.channels);
  fs.mkdirSync(path.dirname(OUTPUT_BMP), { recursive: true });
  fs.writeFileSync(OUTPUT_BMP, bmp);
  console.log(`[installer-bmp] wrote ${path.relative(projectRoot, OUTPUT_BMP)} (${bmp.length} bytes, ${HEADER_WIDTH}x${HEADER_HEIGHT}, 24bpp, bg #${BG_R.toString(16)}${BG_G.toString(16)}${BG_B.toString(16)})`);
}

main().catch((err) => {
  console.error(`[installer-bmp] ${err.message || err}`);
  process.exitCode = 1;
});
