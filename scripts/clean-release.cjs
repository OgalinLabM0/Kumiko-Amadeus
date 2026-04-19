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
const keepPostbuild = new Set([
  'Kumiko-Amadeus-Setup-x64.exe',
  'Kumiko-Amadeus-Setup-x64.exe.blockmap',
  'Kumiko-Amadeus-Setup-arm64.exe',
  'Kumiko-Amadeus-Setup-arm64.exe.blockmap',
  'Kumiko-Amadeus-x64.AppImage',
  'Kumiko-Amadeus-arm64.AppImage',
  'latest.yml',
  'latest-arm64.yml',
  'latest-linux.yml',
  'latest-linux-arm64.yml',
  'kumiko-assets.zip',
]);

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
    if (keepPostbuild.has(entry)) {
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
