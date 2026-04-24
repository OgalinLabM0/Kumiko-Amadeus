const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const releaseDir = path.join(projectRoot, 'release');
const mode = process.argv[2] || 'postbuild';

// Release artifacts to keep after electron-builder finishes. Covers dual-arch
// (x64 + arm64) NSIS output, Linux AppImage output, plus electron-updater
// channel files and the auxiliary asset bundle. See package.json build.win /
// build.linux targets and scripts/generate-latest-yml.cjs for the other ends
// of this contract.
//
// F2B.5: NSIS artifactName became `Kumiko-Amadeus-Setup-${arch}-${version}.exe`
// (e.g. `Kumiko-Amadeus-Setup-x64-2.14.0.exe`). The exact version isn't known
// here, so we keep entries via prefix/suffix patterns instead of literal sets.
//
// K.1 (v2.14.2): `differentialPackage: true` is back, so electron-builder
// emits matching `.blockmap` siblings for both the NSIS installers and the
// AppImage targets. We keep all of them so electron-updater clients can
// download incremental diffs instead of full ~750 MB installers.
const keepPostbuildLiteral = new Set([
  'latest.yml',
  'latest-arm64.yml',
  'latest-linux.yml',
  'latest-linux-arm64.yml',
  'kumiko-assets.zip',
]);

// F2B.5 + K.1: keep any per-arch versioned NSIS installer and its blockmap.
// Matches:
//   Kumiko-Amadeus-Setup-x64-2.14.2.exe
//   Kumiko-Amadeus-Setup-arm64-2.14.2.exe
//   Kumiko-Amadeus-Setup-x64-2.14.2.exe.blockmap
//   Kumiko-Amadeus-Setup-arm64-2.14.2.exe.blockmap
//   Kumiko-Amadeus-Setup-x64.exe / -arm64.exe (legacy fallback, pre-F2B.5)
const NSIS_KEEP_RE = /^Kumiko-Amadeus-Setup-(x64|arm64)(-[0-9]+\.[0-9]+\.[0-9]+(?:[A-Za-z0-9.\-+]*)?)?\.exe(?:\.blockmap)?$/i;

// K.1: AppImages and their blockmap siblings.
//   Kumiko-Amadeus-x86_64.AppImage
//   Kumiko-Amadeus-arm64.AppImage
//   Kumiko-Amadeus-x86_64.AppImage.blockmap
//   Kumiko-Amadeus-arm64.AppImage.blockmap
const APPIMAGE_KEEP_RE = /^Kumiko-Amadeus-(x86_64|arm64)\.AppImage(?:\.blockmap)?$/i;

function isKeepablePostbuildEntry(name) {
  if (keepPostbuildLiteral.has(name)) return true;
  if (NSIS_KEEP_RE.test(name)) return true;
  if (APPIMAGE_KEEP_RE.test(name)) return true;
  return false;
}

function removeEntry(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  fs.rmSync(targetPath, { recursive: true, force: true });
  console.log(`Removed ${path.relative(projectRoot, targetPath)}`);
}

function ensureReleaseDir() {
  fs.mkdirSync(releaseDir, { recursive: true });
}

function cleanPrebuild() {
  ensureReleaseDir();

  for (const entry of fs.readdirSync(releaseDir)) {
    removeEntry(path.join(releaseDir, entry));
  }
}

function prunePostbuild() {
  ensureReleaseDir();

  for (const entry of fs.readdirSync(releaseDir)) {
    if (isKeepablePostbuildEntry(entry)) {
      continue;
    }

    removeEntry(path.join(releaseDir, entry));
  }
}

if (mode === 'prebuild') {
  cleanPrebuild();
} else if (mode === 'postbuild') {
  prunePostbuild();
} else {
  throw new Error(`Unknown clean-release mode: ${mode}`);
}
