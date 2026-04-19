#!/usr/bin/env node
// Downloads models/bge-m3-onnx/model_int8.onnx from HuggingFace (or the
// hugging-face.cn mirror) for use during CI builds. The model is gitignored
// because of its size, so CI needs to fetch it before electron-builder bundles
// it via extraResources.
//
// Intentional traits:
//   - Zero dependencies: uses only Node standard library so it can run before
//     `npm ci` if needed.
//   - Idempotent: if a sufficiently large file already exists at the target
//     path, the script exits 0 immediately. Local developers who already have
//     the model on disk will not re-download it.
//   - Mirror fallback: huggingface.co -> hugging-face.cn, matching the URLs
//     documented in README.md.
//   - Strict size floor: HuggingFace serves HTML error pages with 200 status
//     during rate-limit; we sanity-check the downloaded size and retry/fail if
//     the file is obviously wrong.

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const projectRoot = path.resolve(__dirname, '..');
const targetDir = path.join(projectRoot, 'models', 'bge-m3-onnx');
const targetFile = path.join(targetDir, 'model_int8.onnx');

// Keep in sync with README.md's "ONNX 模型说明" section. The mirror is the
// canonical China-friendly URL the project already documents.
const SOURCES = [
  'https://huggingface.co/Xenova/bge-m3/resolve/main/onnx/model_int8.onnx?download=true',
  'https://hugging-face.cn/Xenova/bge-m3/resolve/main/onnx/model_int8.onnx?download=true',
];

// bge-m3 int8 ONNX is ~540MB. Anything under 400MB is almost certainly an
// error page, a truncated download, or a wrong endpoint.
const MIN_VALID_SIZE = 400 * 1024 * 1024;
const MAX_REDIRECTS = 8;
const REQUEST_TIMEOUT_MS = 120_000;

function log(msg) {
  console.log(`[fetch-bge] ${msg}`);
}

function warn(msg) {
  console.warn(`[fetch-bge] ${msg}`);
}

function humanSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function removeIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      warn(`Failed to remove ${filePath}: ${err.message}`);
    }
  }
}

function download(urlString, destPath) {
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
            // HuggingFace blocks default node User-Agent on some endpoints.
            'User-Agent': 'kumiko-amadeus-ci/1.0 (+https://github.com/OgalinLabM0/Kumiko-Amadeus)',
            Accept: 'application/octet-stream, */*;q=0.5',
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

          if (status !== 200) {
            res.resume();
            reject(new Error(`HTTP ${status} from ${nextUrl}`));
            return;
          }

          const expectedBytes = Number(res.headers['content-length']) || null;
          let receivedBytes = 0;
          let lastLogged = 0;

          const fileStream = fs.createWriteStream(destPath);
          res.on('data', (chunk) => {
            receivedBytes += chunk.length;
            if (receivedBytes - lastLogged > 50 * 1024 * 1024) {
              if (expectedBytes) {
                const pct = ((receivedBytes / expectedBytes) * 100).toFixed(1);
                log(`  progress: ${humanSize(receivedBytes)} / ${humanSize(expectedBytes)} (${pct}%)`);
              } else {
                log(`  progress: ${humanSize(receivedBytes)}`);
              }
              lastLogged = receivedBytes;
            }
          });
          res.pipe(fileStream);

          fileStream.on('error', (err) => {
            fileStream.destroy();
            reject(err);
          });
          fileStream.on('finish', () => {
            fileStream.close(() => {
              if (expectedBytes && receivedBytes !== expectedBytes) {
                reject(
                  new Error(
                    `Size mismatch: expected ${expectedBytes} bytes, got ${receivedBytes} from ${nextUrl}`
                  )
                );
                return;
              }
              resolve({ bytes: receivedBytes, source: nextUrl });
            });
          });
        }
      );

      request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        request.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms: ${nextUrl}`));
      });
      request.on('error', (err) => {
        reject(err);
      });
    };

    attempt(urlString, 0);
  });
}

async function main() {
  if (fs.existsSync(targetFile)) {
    const existingSize = fs.statSync(targetFile).size;
    if (existingSize >= MIN_VALID_SIZE) {
      log(
        `Model already present at ${path.relative(projectRoot, targetFile)} (${humanSize(existingSize)}). Skipping download.`
      );
      return;
    }
    warn(
      `Existing file is too small (${humanSize(existingSize)}, expected >= ${humanSize(MIN_VALID_SIZE)}). Will re-download.`
    );
    removeIfExists(targetFile);
  }

  fs.mkdirSync(targetDir, { recursive: true });

  const failures = [];
  for (const source of SOURCES) {
    log(`Attempting ${source}`);
    try {
      const { bytes } = await download(source, targetFile);
      if (bytes < MIN_VALID_SIZE) {
        warn(
          `Download from ${source} returned ${humanSize(bytes)} (< ${humanSize(MIN_VALID_SIZE)}); treating as failure.`
        );
        removeIfExists(targetFile);
        failures.push(`${source}: file too small (${humanSize(bytes)})`);
        continue;
      }
      log(`Downloaded ${humanSize(bytes)} from ${source}`);
      return;
    } catch (err) {
      warn(`Failed from ${source}: ${err.message}`);
      removeIfExists(targetFile);
      failures.push(`${source}: ${err.message}`);
    }
  }

  const summary = failures.map((line) => `  - ${line}`).join('\n');
  throw new Error(`All mirrors failed to serve bge-m3 model:\n${summary}`);
}

main().catch((err) => {
  console.error(`[fetch-bge] ${err.message || err}`);
  process.exitCode = 1;
});
