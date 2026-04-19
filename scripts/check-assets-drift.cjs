#!/usr/bin/env node
// Compare the working tree's character-asset files against the
// kumiko-assets.zip currently attached to the latest GitHub release and
// report any drift. Designed to be run as a MANDATORY pre-release check
// so that a release agent (or human) never pushes a workflow_dispatch
// while the local asset set and the latest zip are out of sync.
//
// Exit codes:
//   0 -> in sync: every file in the local tracked asset set matches the
//        zip entry byte-for-byte (same sha256, same size). Safe to release.
//   2 -> drift detected: one or more files differ. A bootstrap hint is
//        printed showing how to refresh the zip on the current latest
//        release before re-running this check.
//   1 -> transport / internal error (network down, zip corrupt, ...).
//        No judgment about drift possible; a human must confirm manually.
//
// Why this only runs locally, never in CI: the CI runner's working tree
// is populated by `npm run fetch-assets`, i.e. CI already sees whatever
// the latest release zip contains. Comparing CI's tree against the same
// zip tautologically reports "in sync" and provides zero signal.
// Asset edits land on a developer's machine where the files are
// gitignored; only the local machine holds the new truth, so the drift
// check must happen there.
//
// Usage:
//   node scripts/check-assets-drift.cjs            (quiet, only prints drift)
//   node scripts/check-assets-drift.cjs --verbose  (also prints SAME entries)
//   ASSETS_URL=https://example.com/... node scripts/check-assets-drift.cjs
//                                                  (override source zip)

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { URL } = require('url');
const JSZip = require('jszip');

const projectRoot = path.resolve(__dirname, '..');
const verbose = process.argv.slice(2).includes('--verbose');

const DEFAULT_URL =
  process.env.ASSETS_URL ||
  'https://github.com/OgalinLabM0/Kumiko-Amadeus/releases/latest/download/kumiko-assets.zip';

// Must stay in lockstep with scripts/package-assets.cjs ASSETS so that
// what gets packaged == what gets diffed. If you add a new category of
// character asset, update both files together.
const ASSET_SPEC = [
  { src: 'public/images/emotions', dir: true },
  { src: 'public/ringtones', dir: true },
  { src: 'public/sovits-ref', dir: true },
  { src: 'public/images/logo.png' },
  { src: 'public/CCA-P2.png' },
  { src: 'public/favicon-KA.ico' },
  { src: 'assets/worldbook.enc' },
  { src: 'assets/lore.enc' },
];

const MAX_REDIRECTS = 8;
const REQUEST_TIMEOUT_MS = 120_000;

function log(msg) {
  console.log(`[check-assets] ${msg}`);
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function download(urlString) {
  return new Promise((resolve, reject) => {
    const visitedUrls = [urlString];

    const attempt = (nextUrl, depth) => {
      if (depth > MAX_REDIRECTS) {
        reject(new Error(`Too many redirects (>${MAX_REDIRECTS}) starting from ${urlString}`));
        return;
      }

      let parsedUrl;
      try {
        parsedUrl = new URL(nextUrl);
      } catch (err) {
        reject(new Error(`Invalid redirect URL ${nextUrl}: ${err.message}`));
        return;
      }

      const request = https.get(
        {
          protocol: parsedUrl.protocol,
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || undefined,
          path: `${parsedUrl.pathname}${parsedUrl.search}`,
          headers: {
            'User-Agent':
              'kumiko-amadeus-check-assets/1.0 (+https://github.com/OgalinLabM0/Kumiko-Amadeus)',
            Accept: 'application/zip, application/octet-stream, */*;q=0.5',
          },
        },
        (res) => {
          const status = res.statusCode || 0;

          if (status >= 300 && status < 400 && res.headers.location) {
            const redirectTarget = new URL(res.headers.location, nextUrl).toString();
            visitedUrls.push(redirectTarget);
            res.resume();
            attempt(redirectTarget, depth + 1);
            return;
          }

          if (status !== 200) {
            res.resume();
            reject(new Error(`HTTP ${status} from ${nextUrl}`));
            return;
          }

          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('error', (err) => reject(err));
          res.on('end', () => {
            resolve({ buffer: Buffer.concat(chunks), redirectChain: visitedUrls });
          });
        }
      );

      request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        request.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms: ${nextUrl}`));
      });
      request.on('error', (err) => reject(err));
    };

    attempt(urlString, 0);
  });
}

function extractTagFromRedirectChain(chain) {
  // GitHub /releases/latest/download/<asset> typically redirects through an
  // intermediate /releases/download/<tag>/<asset> URL before ending at
  // objects.githubusercontent.com with a signed URL. Scan the chain in order
  // and return the first tag that looks like /releases/download/<tag>/.
  for (const url of chain) {
    const match = url.match(/\/releases\/download\/([^/?]+)\//);
    if (match) return match[1];
  }
  return null;
}

async function buildReleaseMap(zipBuffer) {
  const zip = await JSZip.loadAsync(zipBuffer);
  const map = new Map();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const content = await entry.async('nodebuffer');
    const normalized = name.replace(/\\/g, '/');
    map.set(normalized, { size: content.length, sha: sha256(content) });
  }
  return map;
}

function buildLocalMap() {
  const map = new Map();
  let warned = false;
  for (const entry of ASSET_SPEC) {
    const full = path.join(projectRoot, entry.src);
    if (!fs.existsSync(full)) {
      if (!warned) {
        warned = true;
        log(`note: local path missing, will appear as REMOVED if zip has it -> ${entry.src}`);
      } else {
        log(`note: local path missing -> ${entry.src}`);
      }
      continue;
    }
    if (entry.dir) {
      const files = fs
        .readdirSync(full)
        .filter((f) => !f.startsWith('.'))
        .map((f) => path.join(full, f))
        .filter((p) => fs.statSync(p).isFile());
      for (const fp of files) {
        const rel = path
          .relative(projectRoot, fp)
          .split(path.sep)
          .join('/');
        const buf = fs.readFileSync(fp);
        map.set(rel, { size: buf.length, sha: sha256(buf) });
      }
    } else {
      const buf = fs.readFileSync(full);
      const rel = entry.src.replace(/\\/g, '/');
      map.set(rel, { size: buf.length, sha: sha256(buf) });
    }
  }
  return map;
}

function diff(localMap, releaseMap) {
  const added = [];
  const removed = [];
  const modified = [];
  const same = [];

  const keys = new Set([...localMap.keys(), ...releaseMap.keys()]);
  for (const key of [...keys].sort()) {
    const local = localMap.get(key);
    const remote = releaseMap.get(key);
    if (local && !remote) {
      added.push({ path: key, size: local.size });
    } else if (!local && remote) {
      removed.push({ path: key, size: remote.size });
    } else if (local && remote) {
      if (local.sha !== remote.sha) {
        modified.push({ path: key, localSize: local.size, remoteSize: remote.size });
      } else {
        same.push({ path: key, size: local.size });
      }
    }
  }

  return { added, removed, modified, same };
}

function printReport(result, tag) {
  const { added, removed, modified, same } = result;
  const driftCount = added.length + removed.length + modified.length;

  if (verbose || same.length === 0) {
    for (const s of same) {
      log(`  [SAME]     ${s.path} (${humanSize(s.size)})`);
    }
  }
  for (const a of added) {
    log(`  [ADDED]    ${a.path}  (local only, ${humanSize(a.size)})`);
  }
  for (const r of removed) {
    log(`  [REMOVED]  ${r.path}  (release only, ${humanSize(r.size)})`);
  }
  for (const m of modified) {
    log(
      `  [MODIFIED] ${m.path}  (local ${humanSize(m.localSize)}, release ${humanSize(m.remoteSize)})`
    );
  }

  log('');
  log(`Compared ${same.length + driftCount} paths against release ${tag || '(unknown tag)'}.`);
  log(`  in sync: ${same.length}`);
  log(`  added:   ${added.length}`);
  log(`  removed: ${removed.length}`);
  log(`  modified:${modified.length}`);
}

function printBootstrapHint(tag) {
  const tagLabel = tag || '<current-latest-tag>';
  log('');
  log('DRIFT DETECTED. Local tracked assets do not match the latest release zip.');
  log('To make the release pipeline see the new content, run locally:');
  log('');
  log('  npm run release:assets');
  log(`  gh release upload ${tagLabel} release/kumiko-assets.zip --clobber`);
  log('');
  log('Then re-run `npm run check-assets` and confirm `In sync` before pushing a new release.');
}

async function main() {
  log(`Source: ${DEFAULT_URL}`);
  let downloaded;
  try {
    downloaded = await download(DEFAULT_URL);
  } catch (err) {
    console.error(`[check-assets] Download failed: ${err.message}`);
    console.error('[check-assets] Cannot verify drift. Human must confirm asset sync manually.');
    process.exit(1);
  }

  const tag = extractTagFromRedirectChain(downloaded.redirectChain);
  log(`Downloaded ${humanSize(downloaded.buffer.length)} from tag ${tag || '(unresolved)'}`);

  let releaseMap;
  try {
    releaseMap = await buildReleaseMap(downloaded.buffer);
  } catch (err) {
    console.error(`[check-assets] Failed to read zip: ${err.message}`);
    process.exit(1);
  }

  const localMap = buildLocalMap();
  const result = diff(localMap, releaseMap);
  printReport(result, tag);

  const driftCount = result.added.length + result.removed.length + result.modified.length;
  if (driftCount === 0) {
    log('');
    log(`In sync with ${tag || 'latest release'}. Safe to release.`);
    process.exit(0);
  }

  printBootstrapHint(tag);
  process.exit(2);
}

main().catch((err) => {
  console.error(`[check-assets] Unexpected error: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
