#!/usr/bin/env node
// Smoke-test a Kumiko-Amadeus Linux AppImage by extracting it via
// `--appimage-extract` (which uses the AppImage's own bundled squashfs tools,
// so no FUSE / libfuse2 is needed on the runner) and verifying the directory
// layout electron-builder is supposed to produce actually contains all the
// runtime-critical pieces:
//
//   1. AppRun exists                                  (entry point)
//   2. resources/app.asar exists and is non-trivial   (app bundle)
//   3. hnswlib-node is asar-unpacked with >=1 .node   (RAG ANN index)
//   4. better-sqlite3 is asar-unpacked with >=1 .node (local DB)
//   5. onnxruntime-node is asar-unpacked with >=1 .node (BGE inference)
//   6. bge-m3 model_int8.onnx exists and is >=400 MB  (extraResources)
//
// Usage: node scripts/verify-appimage-contents.cjs <path-to-AppImage>
// Exits non-zero on any failure so the workflow step fails loudly.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MIN_BGE_SIZE = 400 * 1024 * 1024;
const MIN_ASAR_SIZE = 10 * 1024 * 1024;

function fail(msg) {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`[smoke]   OK: ${msg}`);
}

function findNodeBinaries(dir) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.node')) found.push(full);
    }
  };
  walk(dir);
  return found;
}

function main() {
  const appimage = process.argv[2];
  if (!appimage) fail('usage: verify-appimage-contents.cjs <path-to-AppImage>');
  if (!fs.existsSync(appimage)) fail(`AppImage does not exist: ${appimage}`);

  const absolutePath = path.resolve(appimage);
  const sizeMB = fs.statSync(absolutePath).size / 1024 / 1024;
  ok(`target: ${absolutePath} (${sizeMB.toFixed(1)} MB)`);

  try {
    fs.chmodSync(absolutePath, 0o755);
  } catch (err) {
    console.warn(`[smoke] chmod failed (likely fine on non-POSIX): ${err.message}`);
  }

  const workDir = path.dirname(absolutePath);
  const extractedRoot = path.join(workDir, 'squashfs-root');

  if (fs.existsSync(extractedRoot)) {
    fs.rmSync(extractedRoot, { recursive: true, force: true });
  }

  execFileSync(absolutePath, ['--appimage-extract'], {
    cwd: workDir,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (!fs.existsSync(extractedRoot)) fail('squashfs-root/ not created after --appimage-extract');
  ok(`extracted to ${extractedRoot}`);

  const appRun = path.join(extractedRoot, 'AppRun');
  if (!fs.existsSync(appRun)) fail('AppRun missing');
  ok('AppRun present');

  const appAsar = path.join(extractedRoot, 'resources', 'app.asar');
  if (!fs.existsSync(appAsar)) fail('resources/app.asar missing');
  const appAsarSize = fs.statSync(appAsar).size;
  if (appAsarSize < MIN_ASAR_SIZE) {
    fail(`resources/app.asar suspiciously small (${appAsarSize} bytes)`);
  }
  ok(`resources/app.asar present (${(appAsarSize / 1024 / 1024).toFixed(1)} MB)`);

  const unpackedNodeModules = path.join(
    extractedRoot,
    'resources',
    'app.asar.unpacked',
    'node_modules'
  );
  for (const mod of ['hnswlib-node', 'better-sqlite3', 'onnxruntime-node']) {
    const modDir = path.join(unpackedNodeModules, mod);
    if (!fs.existsSync(modDir)) fail(`asar-unpacked node_modules/${mod}/ missing`);
    const nodes = findNodeBinaries(modDir);
    if (nodes.length === 0) fail(`no .node binary under node_modules/${mod}/`);
    ok(`node_modules/${mod}/ unpacked (${nodes.length} .node)`);
  }

  const bge = path.join(extractedRoot, 'resources', 'models', 'bge-m3-onnx', 'model_int8.onnx');
  if (!fs.existsSync(bge)) fail('resources/models/bge-m3-onnx/model_int8.onnx missing');
  const bgeSize = fs.statSync(bge).size;
  if (bgeSize < MIN_BGE_SIZE) {
    fail(
      `bge-m3 model suspiciously small: ${bgeSize} bytes (< ${MIN_BGE_SIZE}); ` +
        `expected >=400 MB. extraResources probably failed to bundle the ONNX model.`
    );
  }
  ok(`bge-m3 model present (${(bgeSize / 1024 / 1024).toFixed(1)} MB)`);

  fs.rmSync(extractedRoot, { recursive: true, force: true });
  ok('cleaned up squashfs-root/');
  console.log('[smoke] All 6 checks passed.');
}

try {
  main();
} catch (err) {
  fail(`unexpected error: ${err && err.message ? err.message : err}`);
}
