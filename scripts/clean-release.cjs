const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const releaseDir = path.join(projectRoot, 'release');
const mode = process.argv[2] || 'postbuild';

// Release artifacts to keep after electron-builder finishes. Covers dual-arch
// (x64 + arm64) NSIS output, Linux AppImage output, plus electron-updater
// channel files and the auxiliary asset bundle. See package.json build.win /
// build.linux targets and scripts/generate-latest-yml.cjs for the other ends
// of this contract. Linux builds produce AppImage files but no blockmaps.
//
// F2B.5: NSIS artifactName became `Kumiko-Amadeus-Setup-${arch}-${version}.exe`
// (e.g. `Kumiko-Amadeus-Setup-x64-2.14.0.exe`). The exact version isn't known
// here, so we keep entries via prefix/suffix patterns instead of literal sets.
// `differentialPackage: false` removes the `.blockmap` siblings, but if any
// older builds left them around we keep them too so a re-run is idempotent.
const keepPostbuildLiteral = new Set([
  'Kumiko-Amadeus-x86_64.AppImage',
  'Kumiko-Amadeus-arm64.AppImage',
  'latest.yml',
  'latest-arm64.yml',
  'latest-linux.yml',
  'latest-linux-arm64.yml',
  'kumiko-assets.zip',
]);

// F2B.5: keep any per-arch versioned NSIS installer + its (legacy) blockmap.
// Matches:
//   Kumiko-Amadeus-Setup-x64-2.14.0.exe          ← new
//   Kumiko-Amadeus-Setup-arm64-2.14.0.exe        ← new
//   Kumiko-Amadeus-Setup-x64.exe                 ← legacy fallback (pre-F2B.5)
//   Kumiko-Amadeus-Setup-arm64.exe               ← legacy fallback (pre-F2B.5)
// Plus their `.exe.blockmap` siblings (only if differentialPackage somehow
// re-enables itself).
function isKeepablePostbuildEntry(name) {
  if (keepPostbuildLiteral.has(name)) return true;
  return /^Kumiko-Amadeus-Setup-(x64|arm64)(-[0-9]+\.[0-9]+\.[0-9]+(?:[A-Za-z0-9.\-+]*)?)?\.exe(?:\.blockmap)?$/i.test(name);
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
