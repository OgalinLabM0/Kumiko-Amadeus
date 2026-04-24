// services/androidUpdaterService.ts
//
// A8: Android in-app updater. Replaces electron-updater (which can't run
// inside the WebView) with a periodic GitHub Releases API check. When a
// newer tag is published we show a one-time prompt that opens the release
// page in the system browser; the user downloads + sideloads the APK
// themselves (Android requires an explicit user gesture before installing
// from "Unknown sources").
//
// Why not auto-install via Intent.ACTION_VIEW with the APK content://?
//   - Possible, but requires REQUEST_INSTALL_PACKAGES permission and a
//     Files / DownloadManager round-trip that adds friction without much
//     benefit. Browser tap → download → tap-to-install is one extra tap
//     for the user but ZERO new permissions for us.
//   - Future iteration: download to Filesystem.Cache + open with
//     ACTION_INSTALL_PACKAGE. Out of scope for this commit.
//
// Why not Google Play in-app updates API?
//   - We're not on Play Store. Direct APK distribution via GitHub
//     Releases is the user's preferred channel.
//
// PWA / Electron desktop never call into this module — they have their
// own auto-updater bridges (sw.ts re-registration / electron-updater).

import { isCapacitorNative } from './environment';

const GITHUB_OWNER = 'OgalinLabM0';
const GITHUB_REPO = 'Kumiko-Amadeus';
const RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const LAST_PROMPTED_KEY = 'kumiko_android_updater_last_prompted';
const LAST_CHECKED_KEY = 'kumiko_android_updater_last_checked';

// Don't re-prompt for the same version more than once every 24h, even if
// the user dismisses the dialog without acting on it. Avoids the "stop
// nagging me" complaint that brought down a few electron-updater UX
// patterns historically.
const PROMPT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// Background poll interval. Capped at once a week — Android users typically
// don't need a tighter cadence and this keeps us well under GitHub's
// 60 unauth req/h ratelimit even with thousands of installs.
const CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

interface GithubReleaseAsset {
  name?: string;
  browser_download_url?: string;
  size?: number;
}

interface GithubReleaseResponse {
  tag_name?: string;
  name?: string;
  html_url?: string;
  body?: string;
  prerelease?: boolean;
  draft?: boolean;
  assets?: GithubReleaseAsset[];
}

export interface AndroidUpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  releaseNotes?: string;
  apkAsset?: { name: string; url: string; size: number };
}

function getCurrentVersion(): string {
  // __APP_VERSION__ is injected by vite.config.ts `define` from package.json.
  // Defensive fallback prevents accidental update prompts if a future
  // refactor breaks the inject.
  try {
    return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Strict-ish semver compare. Returns >0 if a is newer than b, <0 if older,
 * 0 if equal. We only need the first three numeric segments — pre-release
 * suffixes (e.g. v2.12.0-pc-anchor) are stripped because we want pre-release
 * tags to compare equal to their base version (no in-app prompt for the
 * "PC anchor" tag we shipped during the Android track).
 */
function compareVersions(a: string, b: string): number {
  const stripPrerelease = (v: string) => v.replace(/^v/, '').split('-')[0];
  const ap = stripPrerelease(a).split('.').map((n) => parseInt(n, 10) || 0);
  const bp = stripPrerelease(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(ap.length, bp.length); i += 1) {
    const av = ap[i] || 0;
    const bv = bp[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function pickApkAsset(release: GithubReleaseResponse): GithubReleaseAsset | undefined {
  if (!Array.isArray(release.assets)) return undefined;
  // Match the `Kumiko-Amadeus-{version}-universal-debug.apk` filename our
  // android-apk-release.yml workflow produces. We accept any APK as a
  // fallback so future signed releases (`-release.apk`) work without a
  // service-side change.
  return (
    release.assets.find((a) => /universal/i.test(a.name || '') && /\.apk$/i.test(a.name || ''))
    || release.assets.find((a) => /\.apk$/i.test(a.name || ''))
  );
}

async function fetchLatestRelease(): Promise<GithubReleaseResponse | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(RELEASE_API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[androidUpdater] GitHub API returned HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as GithubReleaseResponse;
  } catch (e) {
    console.warn('[androidUpdater] release fetch failed:', e);
    return null;
  }
}

export async function checkForAndroidUpdate(force = false): Promise<AndroidUpdateInfo | null> {
  if (!isCapacitorNative()) return null;

  const currentVersion = getCurrentVersion();

  // Cooldown check — skip if we polled recently AND the caller didn't force.
  if (!force) {
    try {
      const lastChecked = Number(window.localStorage.getItem(LAST_CHECKED_KEY) || '0');
      if (lastChecked && Date.now() - lastChecked < CHECK_INTERVAL_MS) {
        return { hasUpdate: false, currentVersion };
      }
    } catch {
      /* ignore localStorage errors */
    }
  }

  const release = await fetchLatestRelease();
  try {
    window.localStorage.setItem(LAST_CHECKED_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
  if (!release || release.draft || release.prerelease) {
    return { hasUpdate: false, currentVersion };
  }

  const latestTag = release.tag_name || release.name || '';
  if (!latestTag) return { hasUpdate: false, currentVersion };

  const newer = compareVersions(latestTag, currentVersion) > 0;
  if (!newer) {
    return { hasUpdate: false, currentVersion, latestVersion: latestTag };
  }

  const asset = pickApkAsset(release);
  return {
    hasUpdate: true,
    currentVersion,
    latestVersion: latestTag,
    releaseUrl: release.html_url || `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${latestTag}`,
    releaseNotes: release.body || undefined,
    apkAsset: asset && asset.browser_download_url
      ? { name: asset.name || 'Kumiko-Amadeus.apk', url: asset.browser_download_url, size: asset.size || 0 }
      : undefined,
  };
}

/**
 * Open the release page (or APK direct download URL if asset is found)
 * in the system browser. Capacitor's Android WebView routes
 * `window.open(url, '_blank')` through the OS URL handler so a Chrome
 * tab takes over instead of navigating the WebView itself away. PWA
 * does the same; Electron is never reached here (PC has its own
 * electron-updater).
 *
 * If we ever want true in-app SafariViewController / Custom Tabs UX,
 * install @capacitor/browser and add a Browser.open() branch ahead of
 * the window.open fallback. Out of scope for A8.1.
 */
export async function openAndroidUpdateUrl(url: string): Promise<void> {
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch (e) {
    console.warn('[androidUpdater] openUrl failed:', e);
  }
}

/**
 * Mark the user as having dismissed the prompt for this version, so we
 * don't re-prompt within PROMPT_COOLDOWN_MS for the same tag. Called
 * from whichever UI surfaces the "update available" dialog.
 */
export function markUpdatePrompted(latestVersion: string): void {
  try {
    window.localStorage.setItem(LAST_PROMPTED_KEY, JSON.stringify({
      version: latestVersion,
      promptedAtMs: Date.now(),
    }));
  } catch {
    /* ignore */
  }
}

export function shouldShowUpdatePrompt(latestVersion: string): boolean {
  try {
    const raw = window.localStorage.getItem(LAST_PROMPTED_KEY);
    if (!raw) return true;
    const parsed = JSON.parse(raw) as { version?: string; promptedAtMs?: number };
    if (parsed.version !== latestVersion) return true;
    if (typeof parsed.promptedAtMs !== 'number') return true;
    return Date.now() - parsed.promptedAtMs >= PROMPT_COOLDOWN_MS;
  } catch {
    return true;
  }
}
