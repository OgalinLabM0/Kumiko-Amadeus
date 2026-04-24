# Release Playbook

This document is the single source of truth for cutting a new release of
`Kumiko·Amadeus`. Any agent or human driving a release must follow it
from Step 0 through Step 6 in order. The short version:

```
npm run check-assets                                   # Step 0 (non-skippable)
bump package.json version + commit + push              # Step 1
gh workflow run linux-appimage.yml  -f publish=false   # Step 2
gh workflow run windows-release.yml -f publish=false   # Step 3
gh workflow run linux-appimage.yml  -f publish=true    # Step 4a
gh workflow run windows-release.yml -f publish=true    # Step 4b
verify 9 assets present + clean stray combined exe     # Step 5
(optional) gh release edit vX.Y.Z --latest             # Step 6
```

`package.json#build.publish.releaseType` is set to `release`, so
electron-builder uploads directly to a non-draft release and GitHub
auto-marks the highest semver tag as `latest`. Step 6 is only needed
if you want to force-pin `latest` to an older tag (rare).

## Versioning

- SemVer: `MAJOR.MINOR.PATCH`.
- **PATCH** (`2.9.2` -> `2.9.3`) — bug fixes, small tweaks, asset-only
  refreshes. 99% of releases are patch bumps.
- **MINOR** (`2.9.2` -> `2.10.0`) — new user-visible feature,
  backward-compatible schema changes.
- **MAJOR** (`2.9.2` -> `3.0.0`) — breaking changes to user data
  location, settings format, or RAG DB schema that forces a migration.
- The GitHub release tag is always `vX.Y.Z`, matching
  `package.json#version` verbatim. Do not tag manually; electron-builder
  creates the draft release tag during `publish=true`.

### Historical version drift

GitHub releases jumped from `v2.3.4` (2026-03-29) straight to `v2.9.2`
(this release). The intermediate 2.3.5–2.9.1 bumps happened in local
development without cutting releases. This is documented here so that
neither humans nor future release agents mistake it for a lost history.
Going forward every bump of `package.json#version` must correspond to a
release cut through this playbook.

## When to cut a release

Not every merge to `main` becomes a release. A full cookbook run costs
~45 minutes of CI time plus a short Step 5 sanity check (asset count +
spot-check the channel files). Since v2.14.2 the previously manual
fixups — stray combined installer + matching universal blockmap, and
the per-arch Windows channel file regeneration — both run inside
`windows-release.yml` itself. Policy, in effect since v2.9.5, is:

- **Code changes without a new installer** (refactors, doc fixes,
  follow-ups that do not need to ship to end users immediately) →
  land on `main` and stop. Skip Step 0 through Step 5. The next time
  a release is cut for any other reason, these commits ship with it.
- **Asset-only update** (emotion sprite, ringtone, lore / worldbook,
  favicon, splash) → refresh the zip on the current latest release
  without cutting a new version:
  ```bash
  npm run release:assets
  gh release upload <current-latest-tag> release/kumiko-assets.zip --clobber
  npm run check-assets      # must report "In sync"
  ```
  No `package.json#version` bump, no new workflow run. Running
  builds and already-installed apps auto-pick the new assets the next
  time they `fetch-assets`.
- **User-visible feature, bug fix that must reach auto-update, or you
  want to manually install and smoke the installer** → run the full
  Step 0 through Step 5 cookbook below. This is the only path that
  actually cuts a new `vX.Y.Z`.

Prior to v2.9.5 every patch bump shipped on its own. That policy was
dropped when the release flow's wall-clock cost outgrew the value of
shipping every chore. If in doubt, prefer not to cut a release — the
backlog queued on `main` is free, the 45-minute release run is not.

## The three distribution channels

| Channel | Workflow | Runs on | Publishes |
| --- | --- | --- | --- |
| Linux AppImage | [.github/workflows/linux-appimage.yml](../.github/workflows/linux-appimage.yml) | `ubuntu-24.04` (x64) + `ubuntu-24.04-arm` (arm64) | `Kumiko-Amadeus-x86_64.AppImage`, `Kumiko-Amadeus-arm64.AppImage`, `latest-linux.yml`, `latest-linux-arm64.yml`, `kumiko-assets.zip` |
| Windows NSIS | [.github/workflows/windows-release.yml](../.github/workflows/windows-release.yml) | `windows-latest` (x64) + `windows-11-arm` (arm64) | `Kumiko-Amadeus-Setup-x64-<version>.exe`, `Kumiko-Amadeus-Setup-arm64-<version>.exe`, `latest.yml`, `latest-arm64.yml` |
| iOS Capacitor bootstrap | [.github/workflows/ios-cap-bootstrap.yml](../.github/workflows/ios-cap-bootstrap.yml) | `macos-latest` | `ios/` project folder as artifact only; **not a user-facing release** |

The Linux x64 matrix job is the **single owner** of `kumiko-assets.zip`
on the release. Windows workflow does not upload it. This avoids four
concurrent matrix jobs (Linux x64, Linux arm64, Windows x64, Windows
arm64) racing to `gh release upload --clobber` the same asset.

## `kumiko-assets.zip` lifecycle

Understanding this is mandatory before touching a release. The zip is
not tracked in git (the files inside it are gitignored), so the
"source of truth" and the "uploader" are two different concerns.

```
                          source of truth
                               │
                               ▼
                ┌──────────────────────────────┐
      edit ───▶ │ local: public/ + assets/     │
                └──────────────┬───────────────┘
                               │ if changed, run:
                               │   npm run release:assets
                               │   gh release upload <current-latest-tag> \
                               │       release/kumiko-assets.zip --clobber
                               ▼
                ┌──────────────────────────────┐
                │ latest release zip on GitHub │◀─── fetched by CI (both
                └──────────────┬───────────────┘      Linux and Windows
                               │                      workflows) via
                               │ CI: npm run fetch-assets
                               ▼                      `fetch-assets`
                ┌──────────────────────────────┐
                │ runner's public/ + assets/   │
                └──────────────┬───────────────┘
                               │
                               │ baked into installer/AppImage
                               │ by electron-builder
                               ▼
                ┌──────────────────────────────┐
                │ Setup-*.exe / *.AppImage     │
                │ (self-contained, ships to    │
                │  every user)                 │
                └──────────────┬───────────────┘
                               │
                               │ Linux x64 matrix job additionally runs:
                               │   npm run release:assets
                               │   gh release upload <new-tag> ... --clobber
                               ▼
                ┌──────────────────────────────┐
                │ new release zip snapshot     │
                │ (for future fetch-assets)    │
                └──────────────────────────────┘
```

### When does a release actually need a new zip content?

Only when a character asset changes on disk:

- Added / removed / replaced emotion sprite under `public/images/emotions/`
- Added / removed / replaced ringtone under `public/ringtones/`
- Updated SoVITS reference audio under `public/sovits-ref/`
- Re-encoded logo / favicon / CCA-P2 splash
- Regenerated `assets/lore.enc` or `assets/worldbook.enc` via
  `npm run build:lore`

`npm run check-assets` (Step 0) detects exactly this. If it says
`In sync`, the CI pipeline can take it from here without any local zip
work. If it says drift, bootstrap the latest release's zip first:

```bash
npm run release:assets
gh release upload <current-latest-tag> release/kumiko-assets.zip --clobber
npm run check-assets     # must print "In sync" before proceeding
```

## Release asset anatomy (10 files must be present)

```
vX.Y.Z
├── Kumiko-Amadeus-Setup-x64-X.Y.Z.exe    Windows x64 installer   ─┐
├── Kumiko-Amadeus-Setup-arm64-X.Y.Z.exe  Windows arm64 installer │  user-facing,
├── Kumiko-Amadeus-x86_64.AppImage        Linux x64 AppImage      │  user downloads
├── Kumiko-Amadeus-arm64.AppImage         Linux arm64 AppImage    │  one of these
├── Kumiko-Amadeus.apk                    Android universal APK   ─┘
├── latest.yml                            Windows x64 updater     ─┐
├── latest-arm64.yml                      Windows arm64 updater   │  electron-updater
├── latest-linux.yml                      Linux x64 updater       │  / Android updater
├── latest-linux-arm64.yml                Linux arm64 updater     ─┘  pull these
└── kumiko-assets.zip                     shared asset snapshot    — fetched by
                                                                      `fetch-assets`
                                                                      at build time
```

F2B.5 (v2.14.0): NSIS `artifactName` embeds `${arch}-${version}` so each
per-arch installer is fully self-contained and never produces a third
"merged" `Kumiko-Amadeus-Setup.exe` that contains both architectures.
The user picks one based on `PROCESSOR_ARCHITECTURE`.

K.1 (v2.14.2): `differentialPackage: true` is back, so each per-arch
installer also ships a sibling `*.blockmap` (Windows NSIS + Linux
AppImage). `electron-updater` uses these to download a partial diff
between two adjacent versions instead of re-downloading the full
~750 MB installer on every patch update. `windows-release.yml` Step
C.1 cleanup is anchored on the exact `Kumiko-Amadeus-Setup-${PACKAGE_VERSION}.exe`
literal, so it scrubs the universal installer collision but leaves the
arch-suffixed `*.blockmap` files alone.

| Missing asset | Blast radius |
| --- | --- |
| Any `Setup-*.exe` / `*.AppImage` | Users on that OS+arch cannot install this version. |
| Any `latest*.yml` | Users on that OS+arch stop receiving auto-update prompts until they manually visit the release page. |
| `kumiko-assets.zip` | Anyone building from source next will hit HTTP 404 in `fetch-assets`. |

All 9 must be present before Step 6 (promote draft to GA).

## The cookbook

### Step 0 — Mandatory pre-release check

```bash
npm run check-assets
```

- Exit 0 (`In sync with vX.Y.Z. Safe to release.`) → continue to Step 1.
- Exit 2 (drift report) → run the `gh release upload --clobber` command
  the script prints, then re-run `npm run check-assets`. Loop until
  `In sync`.
- Exit 1 (transport error) → not a judgment. Try once more; if still
  broken, verify asset sync manually before continuing. Never skip.

### Step 1 — Bump version and push

```bash
# edit package.json: "version": "2.9.2" -> "2.9.3"
git add package.json
git commit -m "chore(release): bump to 2.9.3"
git push origin main
```

Confirm `package.json#version` and `package-lock.json#version` both
land on the same value. electron-builder uses `package.json#version`
verbatim as the release tag during publish.

### Step 2 — Linux dry-run

```bash
gh workflow run linux-appimage.yml -f publish=false
gh run watch                                 # optional, follow logs
```

Expect ~15–25 minutes. Both matrix jobs must go green. The smoke test
step (`verify-appimage-contents.cjs`) validates `AppRun`,
`resources/app.asar`, three native modules, and the bge-m3 ONNX model
are all inside the AppImage before the artifact uploads.

### Step 3 — Windows dry-run

```bash
gh workflow run windows-release.yml -f publish=false
gh run watch
```

Expect ~15–30 minutes (arm64 is slower due to node-gyp on
`windows-11-arm`). The NSIS smoke test (`verify-nsis-contents.cjs`)
unpacks the Setup exe through two 7-Zip passes and re-validates the
same 6 checks against `Kumiko-Amadeus.exe`, `resources/app.asar`, the
three native modules, and the bge-m3 model.

### Step 4 — Publish to release

Once **both** dry-runs are green, trigger both workflows with
publish=true. Order does not matter; they can run in parallel.

```bash
gh workflow run linux-appimage.yml  -f publish=true
gh workflow run windows-release.yml -f publish=true
```

electron-builder creates `vX.Y.Z` **directly as a non-draft release**
(`publish.releaseType: release` in package.json) the first time either
workflow uploads. Subsequent upload steps from the other workflow, the
other matrix job, and the Linux x64 `kumiko-assets.zip` upload all
attach to the same release. GitHub automatically marks the newest
semver tag as `latest`, so the release is user-visible the moment the
first job finishes uploading. Unlike a draft-first flow, this means a
partial release is already public while later jobs are still running;
treat Step 5 as a gate before announcing or pushing `2.10.0`, not as a
gate before user visibility.

Requirement: `GH_TOKEN` secret must be configured (Settings → Secrets →
Actions → repository secret). Falls back to the built-in `GITHUB_TOKEN`
if not set, which is fine for same-repo releases.

### Step 5 — Verify 9 assets present + clean stray combined installer

```bash
gh release view vX.Y.Z --repo OgalinLabM0/Kumiko-Amadeus \
  --json assets --jq '.assets[].name'
```

Expected minimum (10 required files + 2-4 blockmap siblings since v2.14.2; order varies; substitute the actual version for `X.Y.Z`):

```
Kumiko-Amadeus-Setup-x64-X.Y.Z.exe
Kumiko-Amadeus-Setup-x64-X.Y.Z.exe.blockmap            (v2.14.2+; differential update)
Kumiko-Amadeus-Setup-arm64-X.Y.Z.exe
Kumiko-Amadeus-Setup-arm64-X.Y.Z.exe.blockmap          (v2.14.2+; differential update)
Kumiko-Amadeus-x86_64.AppImage
Kumiko-Amadeus-x86_64.AppImage.blockmap                (v2.14.2+; emitted when electron-builder picks it up)
Kumiko-Amadeus-arm64.AppImage
Kumiko-Amadeus-arm64.AppImage.blockmap                 (v2.14.2+; emitted when electron-builder picks it up)
Kumiko-Amadeus.apk
latest.yml
latest-arm64.yml
latest-linux.yml
latest-linux-arm64.yml
kumiko-assets.zip
```

F2B.5: `Kumiko-Amadeus-Setup.exe` (the legacy ~1.6 GB merged installer
that historically appeared alongside the per-arch ones) is **no longer
produced**. `package.json#build.nsis.artifactName` hard-codes
`${arch}-${version}`, so electron-builder cannot fall back to an
unsuffixed combined output, and `windows-release.yml` Step C.1 also
deletes any unsuffixed `Setup-${PACKAGE_VERSION}.exe` asset as a
defence-in-depth. If a future build still emits the universal version,
treat it as a configuration regression and revert before publishing.

K.1 (v2.14.2): `differentialPackage: true` is back. The matching
`*.blockmap` files are SUPPOSED to be present and are not the same
thing as the universal installer — do NOT scrub them with the C.1
cleanup. Old electron-updater clients ignore blockmaps they don't know
about, so they're forwards-compatible.

K.3 (v2.14.2): the C.1 cleanup step in `windows-release.yml` was
extended to also delete the universal `Setup-<version>.exe.blockmap`
sibling that electron-builder emits for the now-deleted universal
installer. Without it the release page shows a dangling blockmap with
no exe to diff against. Same `gh release delete-asset … || true` race
semantics as the universal exe deletion: idempotent, safe to retry,
green even on dry runs that never produced the asset.

#### Patch: `latest-arm64.yml` missing after Windows publish

> Since v2.14.2 (K.3) `windows-release.yml` always re-generates
> `latest.yml` (x64 matrix) and `latest-arm64.yml` (arm64 matrix) from
> each runner's local `release/` contents and uploads with `--clobber`
> after the electron-builder publish step. The fallback below remains
> documented for legacy releases (≤ v2.14.1) and as a recovery path if
> a future runner regression resurfaces the bug.

electron-builder in this dual-arch configuration historically emitted
only one Windows channel file (`latest.yml`) and skipped
`latest-arm64.yml` (or wrote a multi-arch latest.yml referencing the
universal exe). If Step 5 shows the arm64 yml missing on a v2.14.1-era
release, patch it by hand without re-running the 15-minute arm64 build:

```bash
mkdir -p release
gh release download vX.Y.Z --repo OgalinLabM0/Kumiko-Amadeus \
  --pattern "Kumiko-Amadeus-Setup-arm64-*.exe" --dir release
node scripts/generate-latest-yml.cjs        # emits release/latest-arm64.yml
gh release upload vX.Y.Z release/latest-arm64.yml \
  --repo OgalinLabM0/Kumiko-Amadeus --clobber
```

`generate-latest-yml.cjs` only processes the installer files that
happen to exist in `release/`, so it safely produces just the one yml
you need. Delete the downloaded exe afterwards (~775 MB).

Optional spot-check: download the x64 installer, install it, boot the
app, confirm emotion sprites render and RAG search returns results.

### Step 6 — (Optional) pin latest

`publish.releaseType: release` + GitHub's "highest semver = latest"
default mean the new release is already the latest by the time the
first job finishes uploading. Run the command below only if you need
to force-pin `latest` to this specific tag (e.g. to override a GitHub
classification glitch or temporarily roll back to an older tag):

```bash
gh release edit vX.Y.Z --latest --repo OgalinLabM0/Kumiko-Amadeus
```

Skip this step in the normal case; the release is already published,
electron-updater is already serving it, and
`fetch-assets` already redirects `/releases/latest/download/...` to
this version's `kumiko-assets.zip`.

## Rollback

Because `publish.releaseType: release`, the release is public the
moment the first job finishes uploading. There is no draft middle
state to tear down gently; any rollback revokes a public release.

### Revoke a broken release entirely

```bash
gh release delete vX.Y.Z --yes --cleanup-tag \
  --repo OgalinLabM0/Kumiko-Amadeus
```

Deletes the release **and** the `vX.Y.Z` tag. Fix the underlying issue,
bump to `vX.Y.(Z+1)`, and restart from Step 0.

### Demote a release (keep as history but stop serving)

```bash
# Demote: mark as draft so it disappears from /releases/latest
gh release edit vX.Y.Z --draft=true --repo OgalinLabM0/Kumiko-Amadeus

# Or mark an older tag as latest instead:
gh release edit vX.Y.(Z-1) --latest --repo OgalinLabM0/Kumiko-Amadeus
```

If the revoked version had already rolled out to users via
electron-updater, they keep the binary they installed — just don't get
prompted to update from it anymore. Push a fixed `vX.Y.(Z+1)` through
the normal cookbook to move users forward.

## Common pitfalls

- **`GH_TOKEN` unset and workflow fails with `Cannot find credentials`**
  → add the secret, then re-run the failed workflow.
- **`publish=true` but `package.json#version` already matches an
  existing GA release** → electron-builder refuses to overwrite. Bump
  to a new patch version before retrying.
- **Windows arm64 job fails with HTTP 502 mid-upload** → GitHub's
  asset API is intermittently flaky; `gh run rerun <run-id> --failed`
  usually succeeds on the second attempt. If two reruns fail the same
  way, check <https://www.githubstatus.com/>.
- **Windows x64 `Fetch shared assets` step fails with HTTP 404 during
  publish=true** → race window: electron-builder creates the `vX.Y.Z`
  release and marks it `latest` the moment the Linux x64 AppImage
  upload begins, but the Linux x64 `Upload kumiko-assets.zip` step is
  a later step in the same job. Windows x64, running in parallel,
  tries to fetch `releases/latest/download/kumiko-assets.zip` and hits
  the empty window. `scripts/fetch-assets.cjs` auto-falls back to the
  previous release's zip (whose contents are usually identical across
  patch bumps, since character assets change rarely), so the workflow
  self-heals and no action is needed. If the fallback also 404s — for
  example every prior release has been deleted, or the fallback's zip
  is stale and the current release ships intentionally new assets —
  either set `FETCH_ASSETS_NO_FALLBACK=1` temporarily and wait for the
  Linux x64 upload to finish, or `gh run rerun <windows-run-id>
  --failed` once you confirm `gh release view vX.Y.Z --json assets`
  shows `kumiko-assets.zip`.
- **After Windows publish: `latest-arm64.yml` missing** → fixed by
  v2.14.2 K.3: `windows-release.yml` now regenerates both Windows
  channel files locally per matrix arch and uploads with `--clobber`,
  so the arm64 channel file is always present. If it ever resurfaces
  (runner image regression, electron-builder upgrade), follow the
  "Patch: `latest-arm64.yml` missing" sub-step in Step 5 to synthesise
  it locally from the released `Setup-arm64-<version>.exe`.
- **After Windows publish: stray `Setup-<version>.exe.blockmap`
  (universal blockmap) appears** → fixed by v2.14.2 K.3 cleanup step
  (`Delete universal NSIS installer + blockmap from release`). For
  legacy v2.14.0 / v2.14.1-style releases that already shipped, run
  `gh release delete-asset vX.Y.Z Kumiko-Amadeus-Setup-X.Y.Z.exe.blockmap --yes`
  by hand.
- **Combined `Kumiko-Amadeus-Setup.exe` (~1.6 GB) appears on a release**
  → should not happen since F2B.5 (`artifactName` =
  `Setup-${arch}-${version}.exe`). `windows-release.yml` Step C.1
  cleanup is also belt-and-braces: it deletes any unsuffixed
  `Setup-${PACKAGE_VERSION}.exe` asset before promoting the draft. If
  one slips through, treat it as a configuration regression: revert
  any recent change to `package.json#build.nsis.artifactName` and
  re-run the windows workflow before publishing. Note: this is
  unrelated to `differentialPackage` — that is back to `true` since
  v2.14.2 (K.1) so blockmap siblings are intentional and must be
  preserved.
- **Concurrent `publish=true` on both workflows racing over zip**
  → cannot happen by design: only Linux x64 matrix job uploads the zip.
  Windows and Linux arm64 skip that step entirely.
- **Assets changed locally but bootstrap-upload and workflow trigger
  were done in the wrong order** → both workflows fetch the old zip,
  bake old assets into installer and AppImage, draft ships stale
  content. Rollback:
  1. `gh run cancel <run-id>` for any still-running workflow.
  2. `gh release delete vX.Y.Z --yes --cleanup-tag`.
  3. `npm run release:assets` locally, then
     `gh release upload <previous-latest-tag> release/kumiko-assets.zip --clobber`.
  4. `npm run check-assets` until `In sync`.
  5. Push again and re-enter Step 2 (or Step 4 if smoke already passed).
  **The preventive measure is Step 0. Always run it. No exceptions.**
- **Mixing up `--win --x64 --arm64` in a single runner** → don't. The
  Windows workflow splits arch across two runners because
  `hnswlib-node@3` has no prebuilt for `win32-arm64` and the x64 runner
  cannot cross-compile native modules to arm64.
