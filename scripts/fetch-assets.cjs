#!/usr/bin/env node
// Downloads kumiko-assets.zip from the latest GitHub release and unpacks
// the character-specific asset set (emotion sprites, ringtones, favicon,
// logo, CCA-P2 splash, encrypted lore + worldbook) back into the working
// tree. These assets live outside the tracked source code, so this step
// is mandatory before any `npm run build:*` or `npx electron-builder`
// invocation when building from source.
//
// Intentional traits (mirrors scripts/fetch-bge-model.cjs style):
//   - Idempotent: if the sentinel files are already present and non-empty,
//     the script exits 0 immediately. Local developers already on disk do
//     not re-download; CI cold runs do.
//   - ASSETS_URL env override: useful for private mirrors or CI testing
//     against a draft release.
//   - Follows redirects: `/releases/latest/download/...` 302s to
//     objects.githubusercontent.com.
//   - Defends against zip-slip: refuses entries whose resolved path
//     escapes the project root.
//   - Only jszip as non-stdlib dep (already a direct dependency for
//     scripts/package-assets.cjs), so `npm ci` must have completed first.

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const JSZip = require('jszip');

const projectRoot = path.resolve(__dirname, '..');

const DEFAULT_URL =
  process.env.ASSETS_URL ||
  'https://github.com/OgalinLabM0/Kumiko-Amadeus/releases/latest/download/kumiko-assets.zip';

// If every sentinel file is present and non-empty, assume the asset set is
// already on disk. Chosen to cover each asset category (icon / sprite /
// splash / encrypted payload) so a partial extract still re-triggers.
const IDEMPOTENCY_SENTINELS = [
  'public/favicon-KA.ico',
  'public/images/emotions/Happy.png',
  'public/CCA-P2.png',
  'assets/lore.enc',
];

const MAX_REDIRECTS = 8;
const REQUEST_TIMEOUT_MS = 120_000;

function log(msg) {
  console.log(`[fetch-assets] ${msg}`);
}

function warn(msg) {
  console.warn(`[fetch-assets] ${msg}`);
}

function humanSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function alreadyPresent() {
  return IDEMPOTENCY_SENTINELS.every((rel) => {
    const full = path.join(projectRoot, rel);
    try {
      return fs.statSync(full).size > 0;
    } catch (_err) {
      return false;
    }
  });
}

function download(urlString) {
  return new Promise((resolve, reject) => {
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
              'kumiko-amadeus-ci/1.0 (+https://github.com/OgalinLabM0/Kumiko-Amadeus)',
            Accept: 'application/zip, application/octet-stream, */*;q=0.5',
          },
        },
        (res) => {
          const status = res.statusCode || 0;

          if (status >= 300 && status < 400 && res.headers.location) {
            const redirectTarget = new URL(res.headers.location, nextUrl).toString();
            res.resume();
            attempt(redirectTarget, depth + 1);
            return;
          }

          if (status === 404) {
            res.resume();
            reject(
              new Error(
                `HTTP 404 from ${nextUrl}. Most likely the latest GitHub release does not ` +
                  `yet have kumiko-assets.zip attached. First-time bootstrap from a machine ` +
                  `that still has the assets on disk:\n` +
                  `    npm run release:assets\n` +
                  `    gh release upload <tag> release/kumiko-assets.zip --clobber\n` +
                  `Or override the source: ASSETS_URL=https://example.com/kumiko-assets.zip npm run fetch-assets`
              )
            );
            return;
          }

          if (status !== 200) {
            res.resume();
            reject(new Error(`HTTP ${status} from ${nextUrl}`));
            return;
          }

          const chunks = [];
          const expectedBytes = Number(res.headers['content-length']) || null;
          let receivedBytes = 0;
          let lastLogged = 0;

          res.on('data', (chunk) => {
            chunks.push(chunk);
            receivedBytes += chunk.length;
            if (receivedBytes - lastLogged > 20 * 1024 * 1024) {
              if (expectedBytes) {
                const pct = ((receivedBytes / expectedBytes) * 100).toFixed(1);
                log(`  progress: ${humanSize(receivedBytes)} / ${humanSize(expectedBytes)} (${pct}%)`);
              } else {
                log(`  progress: ${humanSize(receivedBytes)}`);
              }
              lastLogged = receivedBytes;
            }
          });
          res.on('error', (err) => reject(err));
          res.on('end', () => {
            if (expectedBytes && receivedBytes !== expectedBytes) {
              reject(
                new Error(
                  `Size mismatch: expected ${expectedBytes} bytes, got ${receivedBytes} from ${nextUrl}`
                )
              );
              return;
            }
            resolve(Buffer.concat(chunks));
          });
        }
      );

      request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        request.destroy(
          new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms: ${nextUrl}`)
        );
      });
      request.on('error', (err) => reject(err));
    };

    attempt(urlString, 0);
  });
}

async function extractZip(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.keys(zip.files).filter((name) => !zip.files[name].dir);

  if (entries.length === 0) {
    throw new Error('kumiko-assets.zip contains no files');
  }

  const rootWithSep = projectRoot + path.sep;
  let extracted = 0;
  for (const name of entries) {
    const targetRelative = path.normalize(name);
    const targetAbs = path.join(projectRoot, targetRelative);
    if (targetAbs !== projectRoot && !targetAbs.startsWith(rootWithSep)) {
      throw new Error(`Refusing to extract unsafe path: ${name}`);
    }
    const content = await zip.files[name].async('nodebuffer');
    fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
    fs.writeFileSync(targetAbs, content);
    extracted += 1;
  }

  return extracted;
}

async function main() {
  if (alreadyPresent()) {
    const listing = IDEMPOTENCY_SENTINELS.map((s) => `    - ${s}`).join('\n');
    log('Assets already on disk (all sentinel files present). Skipping download.');
    log(`To force a refresh, delete any of:\n${listing}`);
    return;
  }

  log(`Downloading from ${DEFAULT_URL}`);
  const zipBuffer = await download(DEFAULT_URL);
  log(`Downloaded ${humanSize(zipBuffer.length)}`);

  const count = await extractZip(zipBuffer);
  log(`Extracted ${count} files into project root.`);
}

main().catch((err) => {
  console.error(`[fetch-assets] ${err.message || err}`);
  process.exitCode = 1;
});
