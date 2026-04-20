// electron/server/tailscale-cert.cjs
//
// Thin wrapper around the Tailscale CLI so the mobile-access Fastify server
// can acquire a Let's Encrypt certificate for its MagicDNS hostname. This
// is the only supported HTTPS path in Phase 1 because iOS Safari refuses
// self-signed certs for PWA push registration and the pairing flow.
//
// We never call Tailscale's control plane directly — the local `tailscale`
// CLI already owns all the ACME + Tailscale HTTPS plumbing. We only need
// to (a) detect the binary, (b) ask it for the node's DNSName, and (c)
// shell out `tailscale cert` to mint or renew certs under userData.
//
// Error model: every exported function returns `{ ok: true, ... }` on
// success and `{ ok: false, code, message }` on failure, where `code` is
// one of:
//   - 'E_NO_CLI'           tailscale binary not on PATH / not installed
//   - 'E_NOT_LOGGED_IN'    tailscale status indicates not connected
//   - 'E_NO_HOSTNAME'      tailscale didn't report a MagicDNS DNSName
//   - 'E_NO_HTTPS_FEATURE' tailscale account hasn't enabled HTTPS certs
//                          (specifically: "does not support getting TLS
//                          certs" from the CLI stderr)
//   - 'E_CERT_TIMEOUT'     `tailscale cert` timed out (default 90s)
//   - 'E_CERT_FAILED'      `tailscale cert` exited non-zero for any
//                          other reason (ACME rate limit, network, etc.)
//   - 'E_CERT_READ'        local cert file couldn't be parsed
// The MobileAccessSection UI branches on these so the user sees an
// actionable message rather than a stack trace. Every distinct `code`
// above also has a row in constants/mobileSetupGuideContent.ts so the
// panel's ErrorCard can deep-link into the right tutorial section.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { app } = require('electron');

const RENEWAL_THRESHOLD_DAYS = 30; // renew if cert has <= 30 days left
const RENEWAL_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // check every 6h

function getCertDir() {
  const dir = path.join(app.getPath('userData'), 'mobile-access-certs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Possible fallback locations for the tailscale CLI when it is installed
// but not on PATH (common on Windows where the installer stamps it into
// Program Files without mutating the system PATH).
function getFallbackCandidates() {
  const candidates = [];
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates.push(path.join(programFiles, 'Tailscale', 'tailscale.exe'));
    candidates.push(path.join(programFilesX86, 'Tailscale', 'tailscale.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push('/usr/local/bin/tailscale');
    candidates.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  } else {
    candidates.push('/usr/bin/tailscale');
    candidates.push('/usr/local/bin/tailscale');
  }
  return candidates;
}

let resolvedCliPath = null;

async function resolveCliPath() {
  if (resolvedCliPath) return resolvedCliPath;
  const tryRun = (binary) => new Promise((resolve) => {
    execFile(binary, ['version'], { timeout: 4000 }, (err) => {
      resolve(!err);
    });
  });
  // First try the bare name (PATH lookup).
  if (await tryRun('tailscale')) {
    resolvedCliPath = 'tailscale';
    return resolvedCliPath;
  }
  for (const candidate of getFallbackCandidates()) {
    try {
      if (fs.existsSync(candidate) && await tryRun(candidate)) {
        resolvedCliPath = candidate;
        return resolvedCliPath;
      }
    } catch { /* continue */ }
  }
  return null;
}

// Scans stderr/err for tell-tale substrings and returns a typed error
// code. Kept outside runCli so we can also use it on higher-level failures
// (e.g. the ensureCertificate wrapper) without duplicating the string
// matching rules. Defaults to 'E_CLI_FAILED' when nothing specific fits.
function classifyCliError(err, stderrText) {
  const haystack = [
    stderrText || '',
    err && err.message ? String(err.message) : '',
  ].join('\n').toLowerCase();

  // Tailscale's most common help-your-user errors, in order of specificity.
  if (haystack.includes('does not support getting tls certs')
      || haystack.includes('https is not enabled')
      || haystack.includes('enable https')) {
    return 'E_NO_HTTPS_FEATURE';
  }
  if (haystack.includes('not logged in')
      || haystack.includes('backend state')
      || haystack.includes('not connected')
      || haystack.includes('need to log in')) {
    return 'E_NOT_LOGGED_IN';
  }
  // execFile sets `err.signal === 'SIGTERM'` when the timeout fires on
  // POSIX. Windows surfaces it differently but the error message still
  // usually contains the word 'timeout'/'killed'. Treat either as timeout.
  if ((err && err.killed && (err.signal === 'SIGTERM' || err.signal === null))
      || haystack.includes('timeout')
      || haystack.includes('etimedout')) {
    return 'E_CERT_TIMEOUT';
  }
  return 'E_CLI_FAILED';
}

function runCli(args, { timeoutMs = 20000 } = {}) {
  return new Promise(async (resolve) => {
    const cli = await resolveCliPath();
    if (!cli) {
      resolve({ ok: false, code: 'E_NO_CLI', message: 'tailscale CLI not found' });
      return;
    }
    execFile(cli, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const stderrText = stderr ? stderr.toString() : '';
        const code = classifyCliError(err, stderrText);
        resolve({
          ok: false,
          code,
          message: (stderrText && stderrText.trim()) || err.message,
          stderr: stderrText,
        });
        return;
      }
      resolve({ ok: true, stdout: stdout ? stdout.toString() : '' });
    });
  });
}

// ── Public surface ───────────────────────────────────────────────

async function getStatus() {
  const cli = await resolveCliPath();
  if (!cli) {
    return { ok: false, code: 'E_NO_CLI', message: 'tailscale CLI not found' };
  }
  const result = await runCli(['status', '--json']);
  if (!result.ok) {
    // `tailscale status` failures are most often "not logged in"; stick
    // with that code when classifyCliError couldn't say anything more
    // specific, but honor the targeted code when it did.
    const outCode = result.code && result.code !== 'E_CLI_FAILED'
      ? result.code
      : 'E_NOT_LOGGED_IN';
    return { ok: false, code: outCode, message: result.message };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed.BackendState && parsed.BackendState !== 'Running') {
      return {
        ok: false,
        code: 'E_NOT_LOGGED_IN',
        message: `Tailscale backend state: ${parsed.BackendState}`,
      };
    }
    const dnsName = parsed.Self && typeof parsed.Self.DNSName === 'string'
      ? parsed.Self.DNSName.replace(/\.$/, '')
      : '';
    if (!dnsName) {
      return { ok: false, code: 'E_NO_HOSTNAME', message: 'Tailscale reported no DNSName' };
    }
    const ipv4 = Array.isArray(parsed.Self && parsed.Self.TailscaleIPs)
      ? parsed.Self.TailscaleIPs.find((ip) => typeof ip === 'string' && ip.includes('.'))
      : null;
    return {
      ok: true,
      cliPath: cli,
      hostname: dnsName,
      ipv4: ipv4 || null,
      tailnet: parsed.CurrentTailnet && parsed.CurrentTailnet.Name ? parsed.CurrentTailnet.Name : null,
    };
  } catch (e) {
    return {
      ok: false,
      code: 'E_CERT_READ',
      message: `Could not parse tailscale status output: ${e && e.message}`,
    };
  }
}

function certFilePaths(hostname) {
  const dir = getCertDir();
  // Tailscale reserves hostnames to ASCII + hyphen-dot; a stable hash avoids
  // any exotic filename collisions without ever round-tripping raw user
  // input into the filesystem.
  const slug = crypto.createHash('sha1').update(hostname).digest('hex').slice(0, 12);
  return {
    certPath: path.join(dir, `${slug}.crt`),
    keyPath: path.join(dir, `${slug}.key`),
  };
}

function parseCertExpiry(certPath) {
  try {
    const data = fs.readFileSync(certPath);
    const cert = new crypto.X509Certificate(data);
    const validTo = new Date(cert.validTo);
    if (Number.isNaN(validTo.getTime())) return null;
    return validTo;
  } catch {
    return null;
  }
}

async function ensureCertificate({ hostname, forceRenew = false } = {}) {
  if (typeof hostname !== 'string' || !hostname) {
    return { ok: false, code: 'E_NO_HOSTNAME', message: 'Missing hostname' };
  }
  const { certPath, keyPath } = certFilePaths(hostname);

  // Reuse existing cert if it still has >= RENEWAL_THRESHOLD_DAYS left.
  if (!forceRenew && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const expiresAt = parseCertExpiry(certPath);
    if (expiresAt) {
      const msLeft = expiresAt.getTime() - Date.now();
      const daysLeft = msLeft / (24 * 60 * 60 * 1000);
      if (daysLeft > RENEWAL_THRESHOLD_DAYS) {
        return { ok: true, certPath, keyPath, expiresAt, reused: true };
      }
    }
  }

  // Tailscale CLI writes cert + key atomically; tmp paths are used so a
  // half-written file can't poison the reload logic.
  const tmpCertPath = `${certPath}.tmp`;
  const tmpKeyPath = `${keyPath}.tmp`;
  const result = await runCli(
    ['cert', '--cert-file', tmpCertPath, '--key-file', tmpKeyPath, hostname],
    { timeoutMs: 90000 },
  );

  if (!result.ok) {
    try { fs.existsSync(tmpCertPath) && fs.unlinkSync(tmpCertPath); } catch { /* ignore */ }
    try { fs.existsSync(tmpKeyPath) && fs.unlinkSync(tmpKeyPath); } catch { /* ignore */ }
    // Preserve the specific code produced by classifyCliError so the UI
    // can render a targeted ErrorCard; fall back to the legacy
    // E_CERT_FAILED only when we couldn't classify anything.
    const outCode = result.code && result.code !== 'E_CLI_FAILED'
      ? result.code
      : 'E_CERT_FAILED';
    return {
      ok: false,
      code: outCode,
      message: result.message || 'tailscale cert failed',
    };
  }

  try {
    fs.renameSync(tmpCertPath, certPath);
    fs.renameSync(tmpKeyPath, keyPath);
    if (process.platform !== 'win32') {
      try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort */ }
    }
  } catch (e) {
    return { ok: false, code: 'E_CERT_FAILED', message: `Cert atomic move failed: ${e.message}` };
  }

  const expiresAt = parseCertExpiry(certPath);
  return { ok: true, certPath, keyPath, expiresAt, reused: false };
}

// Start a low-frequency timer that re-runs `ensureCertificate` periodically.
// onRenew({ certPath, keyPath, expiresAt }) fires only when a new cert was
// actually issued so the caller can hot-swap the TLS context. `dispose`
// clears the timer.
function watchCertificate({ hostname, onRenew, onError }) {
  let disposed = false;
  const timer = setInterval(async () => {
    if (disposed) return;
    const result = await ensureCertificate({ hostname });
    if (disposed) return;
    if (!result.ok) {
      if (typeof onError === 'function') onError(result);
      return;
    }
    if (!result.reused && typeof onRenew === 'function') onRenew(result);
  }, RENEWAL_CHECK_INTERVAL_MS);
  // Avoid keeping Electron alive if this is the last handle.
  if (typeof timer.unref === 'function') timer.unref();
  return () => {
    disposed = true;
    clearInterval(timer);
  };
}

module.exports = {
  getStatus,
  ensureCertificate,
  watchCertificate,
  certFilePaths,
  getCertDir,
};
