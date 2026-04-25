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
//
// Publish-race fallback (Plan 6):
//   When Windows x64 hits `releases/latest/download/kumiko-assets.zip`
//   during a publish=true workflow, electron-builder has already created
//   the new GA tag but Linux x64 may not have uploaded the zip yet, so
//   the request 404s mid-build. Rather than failing the whole workflow,
//   we list the repo's recent releases via the GitHub REST API and pick
//   the most recent prior release that still has the zip attached. zip
//   contents are almost always identical across patch bumps (user
//   character assets rarely change), so this is semantically safe.
//
//   Opt-outs:
//     - FETCH_ASSETS_NO_FALLBACK=1 : skip the fallback entirely, raise
//       the original 404. Use this for strict validation.
//     - ASSETS_URL pointing at a non-GitHub mirror: the URL parser
//       refuses to synthesize a fallback for non-github.com hosts, so
//       private-mirror 404s propagate as-is.

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

// Transient 5xx + network-error retry (v2.14.10 hotfix).
// v2.14.9 Linux arm64 build died because GitHub releases CDN returned a
// single 502 from /releases/download/v2.14.8/kumiko-assets.zip and the
// script previously bubbled that straight up as a fatal exit. The retry
// budget here is intentionally small (4 tries, ~1s/2s/4s back-off,
// capped at ~10s total) so a genuinely broken release still fails fast,
// but a one-off CDN hiccup no longer wastes a whole CI minute.
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 1_000;

const USER_AGENT =
  'kumiko-amadeus-ci/1.0 (+https://github.com/OgalinLabM0/Kumiko-Amadeus)';

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
            'User-Agent': USER_AGENT,
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
            const err = new Error(
              `HTTP 404 from ${nextUrl}. Most likely the latest GitHub release does not ` +
                `yet have kumiko-assets.zip attached. First-time bootstrap from a machine ` +
                `that still has the assets on disk:\n` +
                `    npm run release:assets\n` +
                `    gh release upload <tag> release/kumiko-assets.zip --clobber\n` +
                `Or override the source: ASSETS_URL=https://example.com/kumiko-assets.zip npm run fetch-assets`
            );
            err.status = 404;
            reject(err);
            return;
          }

          if (status !== 200) {
            res.resume();
            const err = new Error(`HTTP ${status} from ${nextUrl}`);
            err.status = status;
            reject(err);
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

// Lightweight JSON fetcher used only for the GitHub REST releases listing
// in the fallback path. Kept separate from `download()` so the main asset
// path stays a pure streamed binary fetch.
function fetchJson(urlString, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > MAX_REDIRECTS) {
      reject(new Error(`Too many redirects (>${MAX_REDIRECTS}) starting from ${urlString}`));
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(urlString);
    } catch (err) {
      reject(new Error(`Invalid URL ${urlString}: ${err.message}`));
      return;
    }

    const request = https.get(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || undefined,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/vnd.github+json',
        },
      },
      (res) => {
        const status = res.statusCode || 0;

        if (status >= 300 && status < 400 && res.headers.location) {
          const redirectTarget = new URL(res.headers.location, urlString).toString();
          res.resume();
          fetchJson(redirectTarget, depth + 1).then(resolve, reject);
          return;
        }

        if (status !== 200) {
          res.resume();
          const err = new Error(`HTTP ${status} from ${urlString}`);
          err.status = status;
          reject(err);
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', (err) => reject(err));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (err) {
            reject(new Error(`Invalid JSON from ${urlString}: ${err.message}`));
          }
        });
      }
    );

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms: ${urlString}`));
    });
    request.on('error', (err) => reject(err));
  });
}

// Parses a github.com release asset URL into owner / repo / tag / filename.
// Supported shapes:
//   https://github.com/<owner>/<repo>/releases/latest/download/<file>
//   https://github.com/<owner>/<repo>/releases/download/<tag>/<file>
// Returns null for anything else (private mirrors, raw.githubusercontent,
// custom CDNs), which short-circuits the fallback path.
function parseGitHubReleaseUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch (_err) {
    return null;
  }
  if (parsed.hostname !== 'github.com') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 6 || parts[2] !== 'releases') return null;
  const owner = parts[0];
  const repo = parts[1];
  const filename = parts[parts.length - 1];
  let currentTag = null;
  if (parts[3] === 'latest' && parts[4] === 'download') {
    currentTag = null; // /latest/ form: GitHub will resolve tag; we'll skip index 0 in the releases list instead.
  } else if (parts[3] === 'download' && parts[4]) {
    currentTag = parts[4];
  } else {
    return null;
  }
  return { owner, repo, filename, currentTag };
}

async function findPreviousReleaseZipUrl(originalUrl) {
  const info = parseGitHubReleaseUrl(originalUrl);
  if (!info) return null;
  const { owner, repo, filename, currentTag } = info;

  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=20`;
  let releases;
  try {
    releases = await fetchJson(apiUrl);
  } catch (err) {
    warn(`fallback: could not list releases (${err.message || err})`);
    return null;
  }
  if (!Array.isArray(releases) || releases.length === 0) return null;

  for (let i = 0; i < releases.length; i += 1) {
    const r = releases[i];
    // Skip rule: /latest/ URLs skip index 0 (GitHub returns newest-first).
    // Explicit-tag URLs skip that specific tag regardless of index (in case
    // the tag is mid-list, e.g. a non-draft test release).
    if (currentTag === null && i === 0) continue;
    if (currentTag && r && r.tag_name === currentTag) continue;
    const asset = r && Array.isArray(r.assets)
      ? r.assets.find((a) => a && a.name === filename)
      : null;
    if (asset && asset.browser_download_url) {
      return { url: asset.browser_download_url, tag: r.tag_name || '<unknown>' };
    }
  }
  return null;
}

function isTransientError(err) {
  if (!err) return false;
  // 502/503/504 are GitHub CDN/origin transient blips. 408 and 429 are
  // timeouts/rate-limits worth retrying. 5xx in general is server-side
  // and almost never permanent for an existing release asset URL.
  if (err.status === 408 || err.status === 429) return true;
  if (typeof err.status === 'number' && err.status >= 500 && err.status < 600) return true;
  // Network-layer errors that surface as Node `Error` without a status.
  // Code list mirrors what `https.get` raises when the socket dies mid-stream.
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'EAI_AGAIN' ||
      err.code === 'ECONNREFUSED' || err.code === 'ENETUNREACH' || err.code === 'EPIPE') {
    return true;
  }
  // Our own timeout from `request.setTimeout` surfaces as a generic Error.
  if (typeof err.message === 'string' && err.message.includes('Request timed out')) return true;
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadWithRetry(urlString) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      return await download(urlString);
    } catch (err) {
      lastErr = err;
      // 404 must be passed through immediately so the caller's
      // 404-fallback path (look at previous releases) still triggers
      // without burning the retry budget on a permanent miss.
      if (err && err.status === 404) throw err;
      if (!isTransientError(err)) throw err;
      if (attempt === MAX_RETRIES - 1) break;
      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      const reason = err && err.status ? `HTTP ${err.status}` : (err && err.code) || (err && err.message) || 'unknown';
      warn(`transient error from ${urlString} (${reason}); retry ${attempt + 1}/${MAX_RETRIES - 1} in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function downloadWith404Fallback(primaryUrl) {
  try {
    return await downloadWithRetry(primaryUrl);
  } catch (err) {
    if (err && err.status === 404) {
      if (process.env.FETCH_ASSETS_NO_FALLBACK === '1') {
        warn('FETCH_ASSETS_NO_FALLBACK=1 set; not attempting fallback.');
        throw err;
      }
      if (!parseGitHubReleaseUrl(primaryUrl)) {
        warn('URL is not a github.com release asset; no fallback path applies.');
        throw err;
      }
      warn(`primary 404 (${err.message.split('\n')[0]})`);
      warn('checking whether a previous release still carries a valid zip...');
      const fallback = await findPreviousReleaseZipUrl(primaryUrl);
      if (!fallback) {
        warn('no previous release with this asset found; bubbling up original 404.');
        throw err;
      }
      warn(`FALLBACK: using ${fallback.tag} (likely mid-publish race or recently-deleted asset).`);
      warn('Contents of kumiko-assets.zip rarely change across patch releases, so this is usually safe.');
      warn('If the current release intentionally ships NEW asset contents, rerun fetch-assets once Linux x64 has finished uploading the zip.');
      log(`Downloading fallback from ${fallback.url}`);
      return await downloadWithRetry(fallback.url);
    }
    throw err;
  }
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
  const zipBuffer = await downloadWith404Fallback(DEFAULT_URL);
  log(`Downloaded ${humanSize(zipBuffer.length)}`);

  const count = await extractZip(zipBuffer);
  log(`Extracted ${count} files into project root.`);
}

main().catch((err) => {
  console.error(`[fetch-assets] ${err.message || err}`);
  process.exitCode = 1;
});
