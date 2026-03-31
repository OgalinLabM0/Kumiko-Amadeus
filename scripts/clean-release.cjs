const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const releaseDir = path.join(projectRoot, 'release');
const mode = process.argv[2] || 'postbuild';

const keepPostbuild = new Set([
  'Kumiko-Amadeus-Setup.exe',
  'Kumiko-Amadeus-Setup.exe.blockmap',
  'latest.yml',
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
