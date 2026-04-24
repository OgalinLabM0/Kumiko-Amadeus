// scripts/strip-android-only-assets.cjs
//
// Run after `vite build --base ./` and before `npx cap copy android` to
// drop PC-only assets out of `dist/` so they don't get bundled into the
// Android APK's `assets/public/` payload. Mirrors the
// electron-builder `files: ["!dist/sovits-ref/**"]` exclusion that the
// PC NSIS build already does (see package.json `build.files`), just
// applied at the dist tree level because Capacitor's `cap copy` has no
// equivalent exclusion API.
//
// Why this matters
// ----------------
// `dist/sovits-ref/` ships 25 reference audio clips (.wav) used by PC's
// GPT-SoVITS Python service. On Android we hide GPT-SoVITS entirely
// (A3, see TtsConfigSection.tsx) so these files are dead weight — they
// inflated the v2.12.0 APK to 146 MB. Stripping brings it to ~91 MB
// (the remaining bulk is dist/ringtones at 66 MB which IS used).
//
// Execution
// ---------
// Wired into `npm run verify:android` and `npm run cap:sync:android`
// so any developer cap-syncing for Android automatically gets the
// slim payload. Idempotent — re-running on an already-stripped dist
// is a no-op. Other commands (`npm run build:cap`, `npm run desktop:build`)
// do NOT run this script, so PC builds keep `dist/sovits-ref/` intact
// and electron-builder's own exclusion still controls the final NSIS
// installer payload.
//
// Future: if we add more PC-only assets, append to STRIP_PATHS. Each
// entry is treated as relative to repo root.

'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

// Paths (relative to repo root) to remove from dist before cap copy.
// Keep this list in sync with the `!dist/...` entries in package.json
// `build.files` so PC and Android exclude the same set, just through
// different mechanisms.
const STRIP_PATHS = [
  'dist/sovits-ref',
];

function stripDirIfPresent(rel) {
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs)) {
    return { stripped: false, bytes: 0 };
  }
  let bytes = 0;
  let count = 0;
  for (const entry of walk(abs)) {
    try {
      const stat = fs.statSync(entry);
      if (stat.isFile()) {
        bytes += stat.size;
        count += 1;
      }
    } catch {
      // entry vanished mid-walk; ignore
    }
  }
  fs.rmSync(abs, { recursive: true, force: true });
  return { stripped: true, bytes, count };
}

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

function formatMb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function main() {
  let totalBytes = 0;
  let totalCount = 0;
  let stripped = 0;
  for (const rel of STRIP_PATHS) {
    const result = stripDirIfPresent(rel);
    if (result.stripped) {
      stripped += 1;
      totalBytes += result.bytes;
      totalCount += result.count;
      console.log(
        `[strip-android] ${rel} -> removed ${result.count} files, ${formatMb(result.bytes)} MB`,
      );
    } else {
      console.log(`[strip-android] ${rel} -> already absent (no-op)`);
    }
  }
  if (stripped > 0) {
    console.log(
      `[strip-android] freed ${totalCount} files / ${formatMb(totalBytes)} MB total`,
    );
  }
}

main();
