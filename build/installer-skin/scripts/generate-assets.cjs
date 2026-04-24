/* eslint-disable no-console */
/**
 * Kumiko·Amadeus installer skin — programmatic asset generator.
 *
 * Reads I01-I04 from the user-supplied art root, crops to even-sized PNGs that
 * nsNiuniuSkin accepts, and emits the full 1x / 1.5x / 2x DPI ladder along with
 * all buttons, progress bars and the title-bar icon.  Re-run any time after
 * tweaking the palette or layout constants below.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// ── Paths ────────────────────────────────────────────────────────────
const artRoot = path.resolve(__dirname, '../../../../'); // C-KA/
const skinDir = path.resolve(__dirname, '../skin');
const imagesDir = path.join(skinDir, 'images');
fs.mkdirSync(imagesDir, { recursive: true });

// ── Brand palette (sampled from I01/I04) ─────────────────────────────
const COLOR = {
  bgCream: '#FBF4E6',
  textDark: '#3D2D1A',
  textMuted: '#8A6A43',
  goldPrimary: '#B08940',
  goldHover: '#C49A5E',
  goldPressed: '#8D6B30',
  petal: '#EDB5BA',
  trackBg: '#EADFC6',
  whitish: '#FFFEF9',
  lineSoft: '#D4B988',
};

// ── Helpers ──────────────────────────────────────────────────────────
async function svgToPng(svg, outPath) {
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(outPath);
  console.log(`  [ok] ${path.relative(path.resolve(__dirname, '../../..'), outPath)}`);
}

/**
 * Encode a raw RGB(A) buffer as a 24-bit Windows BMP.  sharp can produce
 * RGB pixel data but cannot write the BMP container, so we hand-roll the
 * 14+40 byte header.  BMP rows are bottom-up and padded to 4-byte stride.
 */
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

  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width * channels;
    const dstRow = 54 + y * stride;
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * channels;
      const d = dstRow + x * 3;
      buf[d] = rgba[s + 2];
      buf[d + 1] = rgba[s + 1];
      buf[d + 2] = rgba[s];
    }
    for (let p = 0; p < rowPad; p++) buf[dstRow + rowBytes + p] = 0;
  }
  return buf;
}

async function writeBmp(srcPipeline, outPath) {
  const { data, info } = await srcPipeline.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const bmp = encodeBmp24(data, info.width, info.height, info.channels);
  fs.writeFileSync(outPath, bmp);
  console.log(`  [ok] ${path.basename(outPath)} (${info.width}×${info.height}, ${(bmp.length / 1024).toFixed(0)}KB)`);
}

/**
 * Build a 3-state button PNG by vertically stacking normal/hover/pressed.
 * nsNiuniuSkin XML references these with source="0,0,W,H" etc.
 */
function buttonSvg({ w, h, states, radius = 4 }) {
  const totalH = h * states.length;
  const cells = states
    .map((s, i) => {
      const y = i * h;
      const gradient = s.gradient
        ? `<defs><linearGradient id="g${i}" x1="0" y1="0" x2="0" y2="1">
             <stop offset="0" stop-color="${s.gradient[0]}"/>
             <stop offset="1" stop-color="${s.gradient[1]}"/>
           </linearGradient></defs>`
        : '';
      const fill = s.gradient ? `url(#g${i})` : s.fill;
      const stroke = s.stroke
        ? `<rect x="0.5" y="${y + 0.5}" width="${w - 1}" height="${h - 1}"
                rx="${radius}" ry="${radius}"
                fill="none" stroke="${s.stroke}" stroke-width="1"/>`
        : '';
      const text = s.text
        ? `<text x="${w / 2}" y="${y + h / 2 + s.fontSize / 3}"
                text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif"
                font-size="${s.fontSize}" font-weight="${s.fontWeight || 500}"
                fill="${s.textFill}">${s.text}</text>`
        : '';
      const icon = s.icon
        ? `<g transform="translate(${w / 2}, ${y + h / 2})">${s.icon}</g>`
        : '';
      return `
        ${gradient}
        <rect x="0" y="${y}" width="${w}" height="${h}"
              rx="${radius}" ry="${radius}" fill="${fill}"/>
        ${stroke}${text}${icon}`;
    })
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${totalH}" viewBox="0 0 ${w} ${totalH}">${cells}</svg>`;
}

// Scale a resource to the three DPI buckets.  sharp rasterises the SVG first
// at the base size, then resizes for higher buckets.  For crispness at 2x we
// actually re-render the SVG at the bigger size instead of upscaling bitmap.
async function renderThreeDpi(baseName, svgBuilder, baseSize) {
  const densities = [
    { suffix: '', scale: 1 },
    { suffix: '@1.5x', scale: 1.5 },
    { suffix: '@2x', scale: 2 },
  ];
  for (const { suffix, scale } of densities) {
    const w = Math.round(baseSize.w * scale);
    const h = Math.round(baseSize.h * scale);
    const svg = svgBuilder(w, h);
    const out = path.join(imagesDir, `${baseName}${suffix}.png`);
    await svgToPng(svg, out);
  }
}

// ── Backgrounds (I01-I04) ────────────────────────────────────────────
// I01/I03/I04 are 1499×1049 → crop to 1498×1048 (1.4289 ratio) → fit to 600×420
//   which is 1.4286, almost identical — pixel-perfect letterboxing not needed
// I02 is 1374×1145 → crop to 1374×1144 (1.201 ratio) → fit to 600×500
//   which is 1.2 — also near-perfect
async function processBackgrounds() {
  console.log('[bg] processing I01-I04 from art root...');
  const bgTasks = [
    { src: 'I01.png', base: 'bg_main', target: { w: 600, h: 420 } },
    { src: 'I02.png', base: 'bg_config_expanded', target: { w: 600, h: 500 } },
    { src: 'I02.png', base: 'bg_installing', target: { w: 600, h: 420 } },
    { src: 'I03.png', base: 'bg_uninstall', target: { w: 600, h: 420 } },
    { src: 'I04.png', base: 'bg_finish', target: { w: 600, h: 420 } },
  ];

  for (const task of bgTasks) {
    const srcPath = path.join(artRoot, task.src);
    if (!fs.existsSync(srcPath)) {
      console.warn(`  [skip] ${task.src} not found at ${srcPath}`);
      continue;
    }
    for (const { suffix, scale } of [
      { suffix: '', scale: 1 },
      { suffix: '@1.5x', scale: 1.5 },
      { suffix: '@2x', scale: 2 },
    ]) {
      const w = Math.round(task.target.w * scale);
      const h = Math.round(task.target.h * scale);
      const out = path.join(imagesDir, `${task.base}${suffix}.png`);
      await sharp(srcPath)
        .resize(w, h, { fit: 'cover', position: 'center' })
        .png({ compressionLevel: 9 })
        .toFile(out);
      console.log(`  [ok] ${path.basename(out)} (${w}×${h})`);
    }
  }
}

// ── NSIS-friendly BMP copies ─────────────────────────────────────────
// nsDialogs::CreateBitmap and the MUI welcome/header slots only accept BMP.
// 24-bit BMP keeps file size sane (≈3MB for 600×420) and matches what
// existing electron-builder NSIS expects.  The MUI sidebar slot is a
// non-negotiable 164×314 portrait crop, header is 150×57 landscape strip.
async function processNsisBmps() {
  console.log('[bmp] producing NSIS-friendly BMP outputs...');
  const bmpDir = path.join(skinDir, 'bmp');
  fs.mkdirSync(bmpDir, { recursive: true });

  // Full-bleed BMPs (kept for fallback; v1 of the skin used these and the
  // preview HTML still references them).  v2 of the installer skin uses
  // hero_*.bmp instead so the bottom 38% of the page is left clean for
  // native-rendered controls (no z-order conflict with SS_BITMAP).
  const fullPageBmpTasks = [
    { src: 'I01.png', base: 'bg_main', target: { w: 600, h: 420 } },
    { src: 'I04.png', base: 'bg_finish', target: { w: 600, h: 420 } },
    { src: 'I03.png', base: 'bg_uninstall', target: { w: 600, h: 420 } },
  ];
  for (const task of fullPageBmpTasks) {
    const src = path.join(artRoot, task.src);
    if (!fs.existsSync(src)) {
      console.warn(`  [skip] ${task.src} missing`);
      continue;
    }
    const out = path.join(bmpDir, `${task.base}.bmp`);
    await writeBmp(
      sharp(src).resize(task.target.w, task.target.h, { fit: 'cover', position: 'center' }),
      out
    );
  }

  // v2 hero BMPs: landscape 600×260 (≈ 2.31:1), used by the new
  // Hero+CTA layout.  position: 'attention' lets sharp's smart crop
  // keep the salient subject (KA logo + lead instrument) framed.
  const heroBmpTasks = [
    { src: 'I01.png', base: 'hero_main', target: { w: 600, h: 260 } },
    { src: 'I04.png', base: 'hero_finish', target: { w: 600, h: 260 } },
    { src: 'I03.png', base: 'hero_uninstall', target: { w: 600, h: 260 } },
  ];
  for (const task of heroBmpTasks) {
    const src = path.join(artRoot, task.src);
    if (!fs.existsSync(src)) {
      console.warn(`  [skip] ${task.src} missing`);
      continue;
    }
    const out = path.join(bmpDir, `${task.base}.bmp`);
    await writeBmp(
      sharp(src).resize(task.target.w, task.target.h, { fit: 'cover', position: 'attention' }),
      out
    );
  }

  await writeBmp(
    sharp(path.join(artRoot, 'I02.png')).resize(164, 314, { fit: 'cover', position: 'right' }),
    path.join(bmpDir, 'mui_sidebar.bmp')
  );

  await writeBmp(
    sharp(path.join(artRoot, 'I04.png')).resize(150, 57, { fit: 'cover', position: 'top' }),
    path.join(bmpDir, 'mui_header.bmp')
  );

  // Action button BMPs — 3-state vertical strip, same dimensions as the
  // PNG variants but rendered onto the cream background so transparent
  // edges don't show as black artifacts in nsDialogs.
  const buttonBmpSpecs = [
    {
      base: 'btn_install',
      w: 120,
      h: 36,
      labels: ['立即安装', '立即安装', '立即安装'],
      colors: [
        { fg: '#FFFFFF', bg: COLOR.goldPrimary },
        { fg: '#FFFFFF', bg: COLOR.goldHover },
        { fg: '#FFFFFF', bg: COLOR.goldPressed },
      ],
      radius: 6,
      fontSize: 16,
      fontWeight: 600,
    },
    {
      base: 'btn_custom',
      w: 100,
      h: 28,
      labels: ['自定义安装 ›', '自定义安装 ›', '自定义安装 ›'],
      colors: [
        { fg: COLOR.textMuted, bg: COLOR.bgCream },
        { fg: COLOR.goldPrimary, bg: '#F5E9CF' },
        { fg: COLOR.goldPressed, bg: '#EBDDB8' },
      ],
      radius: 4,
      fontSize: 12,
      fontWeight: 500,
    },
    {
      base: 'btn_uninstall',
      w: 120,
      h: 36,
      labels: ['卸载', '卸载', '卸载'],
      colors: [
        { fg: '#FFFFFF', bg: '#B05050' },
        { fg: '#FFFFFF', bg: '#C46060' },
        { fg: '#FFFFFF', bg: '#8D3030' },
      ],
      radius: 6,
      fontSize: 16,
      fontWeight: 600,
    },
  ];

  for (const spec of buttonBmpSpecs) {
    const totalH = spec.h * 3;
    const cells = spec.colors
      .map((c, i) => {
        const y = i * spec.h;
        return `
          <rect x="0" y="${y}" width="${spec.w}" height="${spec.h}"
                rx="${spec.radius}" ry="${spec.radius}" fill="${c.bg}"/>
          <text x="${spec.w / 2}" y="${y + spec.h / 2 + spec.fontSize / 3}"
                text-anchor="middle"
                font-family="Microsoft YaHei, Segoe UI, sans-serif"
                font-size="${spec.fontSize}" font-weight="${spec.fontWeight}"
                fill="${c.fg}">${spec.labels[i]}</text>`;
      })
      .join('\n');

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${spec.w}" height="${totalH}" viewBox="0 0 ${spec.w} ${totalH}"><rect width="${spec.w}" height="${totalH}" fill="${COLOR.bgCream}"/>${cells}</svg>`;
    const out = path.join(bmpDir, `${spec.base}.bmp`);
    await writeBmp(sharp(Buffer.from(svg)), out);
  }
}

// ── Buttons ──────────────────────────────────────────────────────────
// Each button is rendered as an SVG with normal/hover/pressed stacked vertically.
// nsNiuniuSkin reads these via source="x,y,w,h" in the XML; normal is 0..h,
// hover is h..2h, pressed is 2h..3h.
async function generateButtons() {
  console.log('[btn] rendering gold buttons...');

  // Large CTA: "立即安装" / "Install Now"
  await renderThreeDpi(
    'btn_install',
    (w, h) => {
      const single = h / 3;
      return buttonSvg({
        w,
        h: single,
        radius: 6,
        states: [
          {
            gradient: [COLOR.goldHover, COLOR.goldPrimary],
            text: '立即安装',
            textFill: '#FFFFFF',
            fontSize: Math.round(16 * (w / 120)),
            fontWeight: 600,
          },
          {
            gradient: ['#D0AE72', COLOR.goldHover],
            text: '立即安装',
            textFill: '#FFFFFF',
            fontSize: Math.round(16 * (w / 120)),
            fontWeight: 600,
          },
          {
            fill: COLOR.goldPressed,
            text: '立即安装',
            textFill: '#FFFFFF',
            fontSize: Math.round(16 * (w / 120)),
            fontWeight: 600,
          },
        ],
      });
    },
    { w: 120, h: 108 }
  );

  // Small link-style: "自定义安装 >"
  await renderThreeDpi(
    'btn_custom',
    (w, h) => {
      const single = h / 3;
      return buttonSvg({
        w,
        h: single,
        radius: 2,
        states: [
          {
            fill: 'rgba(0,0,0,0)',
            text: '自定义安装 ›',
            textFill: COLOR.textMuted,
            fontSize: Math.round(12 * (w / 80)),
          },
          {
            fill: 'rgba(176,137,64,0.08)',
            text: '自定义安装 ›',
            textFill: COLOR.goldPrimary,
            fontSize: Math.round(12 * (w / 80)),
          },
          {
            fill: 'rgba(176,137,64,0.16)',
            text: '自定义安装 ›',
            textFill: COLOR.goldPressed,
            fontSize: Math.round(12 * (w / 80)),
          },
        ],
      });
    },
    { w: 80, h: 72 }
  );

  // Browse button: "浏览..."
  await renderThreeDpi(
    'btn_browse',
    (w, h) => {
      const single = h / 3;
      return buttonSvg({
        w,
        h: single,
        radius: 4,
        states: [
          {
            fill: COLOR.whitish,
            stroke: COLOR.lineSoft,
            text: '浏览',
            textFill: COLOR.textDark,
            fontSize: Math.round(12 * (w / 64)),
          },
          {
            fill: '#FBF2E0',
            stroke: COLOR.goldPrimary,
            text: '浏览',
            textFill: COLOR.goldPressed,
            fontSize: Math.round(12 * (w / 64)),
          },
          {
            fill: '#F0E2C0',
            stroke: COLOR.goldPressed,
            text: '浏览',
            textFill: COLOR.goldPressed,
            fontSize: Math.round(12 * (w / 64)),
          },
        ],
      });
    },
    { w: 64, h: 84 }
  );

  // OK / Cancel (secondary actions on dialogs)
  const okStates = [
    {
      fill: COLOR.goldPrimary,
      text: '确定',
      textFill: '#FFFFFF',
      fontSize: 14,
    },
    {
      fill: COLOR.goldHover,
      text: '确定',
      textFill: '#FFFFFF',
      fontSize: 14,
    },
    {
      fill: COLOR.goldPressed,
      text: '确定',
      textFill: '#FFFFFF',
      fontSize: 14,
    },
  ];
  const cancelStates = [
    {
      fill: COLOR.whitish,
      stroke: COLOR.lineSoft,
      text: '取消',
      textFill: COLOR.textDark,
      fontSize: 14,
    },
    {
      fill: '#FBF2E0',
      stroke: COLOR.goldPrimary,
      text: '取消',
      textFill: COLOR.goldPressed,
      fontSize: 14,
    },
    {
      fill: '#F0E2C0',
      stroke: COLOR.goldPressed,
      text: '取消',
      textFill: COLOR.goldPressed,
      fontSize: 14,
    },
  ];
  await renderThreeDpi(
    'btn_ok',
    (w, h) => {
      const single = h / 3;
      const scaled = okStates.map((s) => ({
        ...s,
        fontSize: Math.round(s.fontSize * (w / 80)),
      }));
      return buttonSvg({ w, h: single, radius: 4, states: scaled });
    },
    { w: 80, h: 84 }
  );
  await renderThreeDpi(
    'btn_cancel',
    (w, h) => {
      const single = h / 3;
      const scaled = cancelStates.map((s) => ({
        ...s,
        fontSize: Math.round(s.fontSize * (w / 80)),
      }));
      return buttonSvg({ w, h: single, radius: 4, states: scaled });
    },
    { w: 80, h: 84 }
  );

  // Titlebar: close / minimize.  Icon-only, semi-transparent hover.
  const closeIcon = (size) => {
    const half = size * 0.25;
    return `<line x1="${-half}" y1="${-half}" x2="${half}" y2="${half}"
            stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <line x1="${-half}" y1="${half}" x2="${half}" y2="${-half}"
            stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`;
  };
  const minIcon = (size) => {
    const half = size * 0.3;
    return `<line x1="${-half}" y1="0" x2="${half}" y2="0"
            stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`;
  };

  const titlebarStates = (iconFn, size, hoverBg, pressBg) => [
    {
      fill: 'rgba(0,0,0,0)',
      icon: `<g color="${COLOR.textMuted}">${iconFn(size)}</g>`,
    },
    {
      fill: hoverBg,
      icon: `<g color="${COLOR.textDark}">${iconFn(size)}</g>`,
    },
    {
      fill: pressBg,
      icon: `<g color="${COLOR.textDark}">${iconFn(size)}</g>`,
    },
  ];

  await renderThreeDpi(
    'btn_close',
    (w, h) => {
      const single = h / 3;
      return buttonSvg({
        w,
        h: single,
        radius: 0,
        states: titlebarStates(closeIcon, single, 'rgba(232,85,85,0.9)', 'rgba(200,60,60,0.95)'),
      });
    },
    { w: 32, h: 96 }
  );

  await renderThreeDpi(
    'btn_min',
    (w, h) => {
      const single = h / 3;
      return buttonSvg({
        w,
        h: single,
        radius: 0,
        states: titlebarStates(minIcon, single, 'rgba(176,137,64,0.18)', 'rgba(176,137,64,0.32)'),
      });
    },
    { w: 32, h: 96 }
  );
}

// ── Progress bar ─────────────────────────────────────────────────────
async function generateProgress() {
  console.log('[progress] rendering track/fill/ring...');

  await renderThreeDpi(
    'progress_bg',
    (w, h) => {
      const radius = h / 2;
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
        <rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="${COLOR.trackBg}"/>
        <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="${radius}" ry="${radius}"
              fill="none" stroke="${COLOR.lineSoft}" stroke-width="0.5" opacity="0.5"/>
      </svg>`;
    },
    { w: 400, h: 8 }
  );

  await renderThreeDpi(
    'progress_fg',
    (w, h) => {
      const radius = h / 2;
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
        <defs><linearGradient id="pg" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="${COLOR.goldPrimary}"/>
          <stop offset="0.6" stop-color="${COLOR.goldHover}"/>
          <stop offset="1" stop-color="${COLOR.goldPrimary}"/>
        </linearGradient></defs>
        <rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="url(#pg)"/>
      </svg>`;
    },
    { w: 400, h: 8 }
  );

  // Decorative ring that sits on the leading edge of the fill.
  await renderThreeDpi(
    'progress_ring',
    (w, h) => {
      const cx = w / 2;
      const cy = h / 2;
      const r = Math.min(w, h) / 2 - 1;
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="${COLOR.whitish}"
                stroke="${COLOR.goldPrimary}" stroke-width="${1.5 * (w / 16)}"/>
        <circle cx="${cx}" cy="${cy}" r="${r * 0.45}" fill="${COLOR.goldPrimary}"/>
      </svg>`;
    },
    { w: 16, h: 16 }
  );
}

// ── Icons ────────────────────────────────────────────────────────────
async function generateIcon() {
  console.log('[icon] extracting titlebar icon from favicon...');
  const favSvgCandidates = [
    path.resolve(__dirname, '../../../public/favicon-KA.png'),
    path.resolve(__dirname, '../../../public/favicon-KA.svg'),
    path.resolve(__dirname, '../../../public/favicon-KA.ico'),
  ];
  const src = favSvgCandidates.find((p) => fs.existsSync(p));
  if (!src) {
    console.warn('  [warn] no favicon source found, drawing fallback "KA" monogram');
    for (const { suffix, scale } of [
      { suffix: '', scale: 1 },
      { suffix: '@1.5x', scale: 1.5 },
      { suffix: '@2x', scale: 2 },
    ]) {
      const s = Math.round(32 * scale);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
        <rect x="0" y="0" width="${s}" height="${s}" rx="${s * 0.18}" fill="${COLOR.goldPrimary}"/>
        <text x="${s / 2}" y="${s * 0.68}" text-anchor="middle"
              font-family="Georgia, serif" font-size="${s * 0.6}" font-weight="700"
              fill="#FFFFFF">KA</text>
      </svg>`;
      await svgToPng(svg, path.join(imagesDir, `icon_app${suffix}.png`));
    }
    return;
  }
  for (const { suffix, scale } of [
    { suffix: '', scale: 1 },
    { suffix: '@1.5x', scale: 1.5 },
    { suffix: '@2x', scale: 2 },
  ]) {
    const s = Math.round(32 * scale);
    const out = path.join(imagesDir, `icon_app${suffix}.png`);
    try {
      await sharp(src).resize(s, s, { fit: 'contain' }).png().toFile(out);
      console.log(`  [ok] ${path.basename(out)} from ${path.basename(src)}`);
    } catch (e) {
      console.warn(`  [warn] sharp couldn't read ${src}, using fallback for ${suffix}`);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
        <rect x="0" y="0" width="${s}" height="${s}" rx="${s * 0.18}" fill="${COLOR.goldPrimary}"/>
        <text x="${s / 2}" y="${s * 0.68}" text-anchor="middle"
              font-family="Georgia, serif" font-size="${s * 0.6}" font-weight="700"
              fill="#FFFFFF">KA</text>
      </svg>`;
      await svgToPng(svg, out);
    }
  }
}

// ── Entrypoint ───────────────────────────────────────────────────────
(async () => {
  try {
    await processBackgrounds();
    await generateButtons();
    await generateProgress();
    await generateIcon();
    await processNsisBmps();
    console.log('\nAll installer skin assets generated:');
    console.log('  PNG (preview/HTML)   → build/installer-skin/skin/images/');
    console.log('  BMP (NSIS runtime)   → build/installer-skin/bmp/');
  } catch (e) {
    console.error('FAILED:', e);
    process.exit(1);
  }
})();
