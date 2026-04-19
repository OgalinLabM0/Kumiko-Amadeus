#!/usr/bin/env node
// Smoke-test a Kumiko-Amadeus Windows NSIS installer by extracting it with
// 7-Zip in two passes (the installer exe is a 7z SFX whose payload is another
// 7z archive under $PLUGINSDIR/app-*.7z) and verifying that the directory
// layout electron-builder is supposed to produce actually contains all the
// runtime-critical pieces:
//
//   1. Kumiko-Amadeus.exe exists                     (entry executable)
//   2. resources/app.asar exists and is non-trivial  (app bundle)
//   3. hnswlib-node is asar-unpacked with >=1 .node  (RAG ANN index)
//   4. better-sqlite3 is asar-unpacked with >=1 .node (local DB)
//   5. onnxruntime-node is asar-unpacked with >=1 .node (BGE inference)
//   6. bge-m3 model_int8.onnx exists and is >=400 MB (extraResources)
//
// Usage: node scripts/verify-nsis-contents.cjs <path-to-Setup.exe>
// Exits non-zero on any failure so the workflow step fails loudly.
//
// Assumes 7-Zip is on PATH or at %ProgramFiles%\7-Zip\7z.exe. Both
// windows-latest and windows-11-arm runner images ship with 7-Zip.

'use strict';

const fs = require('fs');
const os = require('os');
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

function find7z() {
  const candidates = [
    process.env.SEVEN_ZIP_PATH,
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', '7-Zip', '7z.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', '7-Zip', '7z.exe'),
    '7z.exe',
    '7z',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-h'], { stdio: 'ignore' });
      return candidate;
    } catch (_err) {
      // try next candidate
    }
  }

  fail(
    '7-Zip not found. Looked at %ProgramFiles%\\7-Zip\\7z.exe, %ProgramFiles(x86)%\\7-Zip\\7z.exe, PATH. ' +
      'Set SEVEN_ZIP_PATH env var to override.'
  );
  return null; // unreachable, fail() exits
}

function extract(sevenZip, archive, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  execFileSync(sevenZip, ['x', archive, `-o${outDir}`, '-y'], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
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

function findInnerArchive(outerDir) {
  // electron-builder NSIS packs the app tree as a single 7z archive inside
  // $PLUGINSDIR. Name depends on arch: app-64.7z (x64) or app-arm64.7z.
  const pluginsDir = path.join(outerDir, '$PLUGINSDIR');
  if (!fs.existsSync(pluginsDir)) {
    fail(`expected $PLUGINSDIR/ inside extracted installer but not found at ${pluginsDir}`);
  }
  const candidates = fs.readdirSync(pluginsDir).filter((n) => /^app-.*\.7z$/i.test(n));
  if (candidates.length === 0) {
    fail(`no app-*.7z inside $PLUGINSDIR; content: ${fs.readdirSync(pluginsDir).join(', ')}`);
  }
  if (candidates.length > 1) {
    console.warn(`[smoke] multiple app-*.7z candidates: ${candidates.join(', ')}; using ${candidates[0]}`);
  }
  return path.join(pluginsDir, candidates[0]);
}

function main() {
  const installer = process.argv[2];
  if (!installer) fail('usage: verify-nsis-contents.cjs <path-to-Setup.exe>');
  if (!fs.existsSync(installer)) fail(`installer does not exist: ${installer}`);

  const absolutePath = path.resolve(installer);
  const sizeMB = fs.statSync(absolutePath).size / 1024 / 1024;
  ok(`target: ${absolutePath} (${sizeMB.toFixed(1)} MB)`);

  const sevenZip = find7z();
  ok(`7-Zip: ${sevenZip}`);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nsis-smoke-'));
  const outerDir = path.join(tmpRoot, 'outer');
  const innerDir = path.join(tmpRoot, 'inner');

  try {
    extract(sevenZip, absolutePath, outerDir);
    ok(`outer extracted to ${outerDir}`);

    const innerArchive = findInnerArchive(outerDir);
    ok(`inner archive: ${path.basename(innerArchive)}`);

    extract(sevenZip, innerArchive, innerDir);
    ok(`inner extracted to ${innerDir}`);

    const mainExe = path.join(innerDir, 'Kumiko-Amadeus.exe');
    if (!fs.existsSync(mainExe)) fail('Kumiko-Amadeus.exe missing');
    ok('Kumiko-Amadeus.exe present');

    const appAsar = path.join(innerDir, 'resources', 'app.asar');
    if (!fs.existsSync(appAsar)) fail('resources/app.asar missing');
    const appAsarSize = fs.statSync(appAsar).size;
    if (appAsarSize < MIN_ASAR_SIZE) {
      fail(`resources/app.asar suspiciously small (${appAsarSize} bytes)`);
    }
    ok(`resources/app.asar present (${(appAsarSize / 1024 / 1024).toFixed(1)} MB)`);

    const unpackedNodeModules = path.join(
      innerDir,
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

    const bge = path.join(innerDir, 'resources', 'models', 'bge-m3-onnx', 'model_int8.onnx');
    if (!fs.existsSync(bge)) fail('resources/models/bge-m3-onnx/model_int8.onnx missing');
    const bgeSize = fs.statSync(bge).size;
    if (bgeSize < MIN_BGE_SIZE) {
      fail(
        `bge-m3 model suspiciously small: ${bgeSize} bytes (< ${MIN_BGE_SIZE}); ` +
          `expected >=400 MB. extraResources probably failed to bundle the ONNX model.`
      );
    }
    ok(`bge-m3 model present (${(bgeSize / 1024 / 1024).toFixed(1)} MB)`);

    console.log('[smoke] All 6 checks passed.');
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      ok(`cleaned up ${tmpRoot}`);
    } catch (err) {
      console.warn(`[smoke] cleanup of ${tmpRoot} failed: ${err.message}`);
    }
  }
}

try {
  main();
} catch (err) {
  fail(`unexpected error: ${err && err.stack ? err.stack : err}`);
}
