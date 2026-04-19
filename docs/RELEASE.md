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
verify draft has 9 assets                              # Step 5
gh release edit vX.Y.Z --draft=false --latest          # Step 6
```

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

## The three distribution channels

| Channel | Workflow | Runs on | Publishes |
| --- | --- | --- | --- |
| Linux AppImage | [.github/workflows/linux-appimage.yml](../.github/workflows/linux-appimage.yml) | `ubuntu-24.04` (x64) + `ubuntu-24.04-arm` (arm64) | `Kumiko-Amadeus-x86_64.AppImage`, `Kumiko-Amadeus-arm64.AppImage`, `latest-linux.yml`, `latest-linux-arm64.yml`, `kumiko-assets.zip` |
| Windows NSIS | [.github/workflows/windows-release.yml](../.github/workflows/windows-release.yml) | `windows-latest` (x64) + `windows-11-arm` (arm64) | `Kumiko-Amadeus-Setup-x64.exe`, `Kumiko-Amadeus-Setup-arm64.exe`, `latest.yml`, `latest-arm64.yml` |
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

## Release asset anatomy (9 files must be present)

```
vX.Y.Z
├── Kumiko-Amadeus-Setup-x64.exe          Windows x64 installer   ─┐
├── Kumiko-Amadeus-Setup-arm64.exe        Windows arm64 installer │  user-facing,
├── Kumiko-Amadeus-x86_64.AppImage        Linux x64 AppImage      │  user downloads
├── Kumiko-Amadeus-arm64.AppImage         Linux arm64 AppImage    ─┘  one of these
├── latest.yml                            Windows x64 updater     ─┐
├── latest-arm64.yml                      Windows arm64 updater   │  electron-updater
├── latest-linux.yml                      Linux x64 updater       │  pulls these in
├── latest-linux-arm64.yml                Linux arm64 updater     ─┘  the background
└── kumiko-assets.zip                     shared asset snapshot    — fetched by
                                                                      `fetch-assets`
                                                                      at build time
```

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

electron-builder automatically creates `vX.Y.Z` as a **draft release**
the first time either workflow uploads. Subsequent upload steps
(including the other workflow, the other matrix job, and the Linux x64
`kumiko-assets.zip` upload) all attach to the same draft.

Requirement: `GH_TOKEN` secret must be configured (Settings → Secrets →
Actions → repository secret). Falls back to the built-in `GITHUB_TOKEN`
if not set, which is fine for same-repo releases.

### Step 5 — Verify draft has 9 assets

```bash
gh release view vX.Y.Z --repo OgalinLabM0/Kumiko-Amadeus \
  --json assets --jq '.assets[].name'
```

Expected output (order varies):

```
Kumiko-Amadeus-Setup-x64.exe
Kumiko-Amadeus-Setup-arm64.exe
Kumiko-Amadeus-x86_64.AppImage
Kumiko-Amadeus-arm64.AppImage
latest.yml
latest-arm64.yml
latest-linux.yml
latest-linux-arm64.yml
kumiko-assets.zip
```

If any file is missing, re-run the failed workflow (the missing side)
before promoting. Do **not** promote a half-complete draft to latest.

Optional spot-check: download the x64 installer, install it, boot the
app, confirm emotion sprites render and RAG search returns results.

### Step 6 — Promote to GA

```bash
gh release edit vX.Y.Z --draft=false --latest
```

The release is now visible on the repository's Releases page,
electron-updater will start serving it to installed clients, and
`fetch-assets` will redirect `/releases/latest/download/...` to this
version's `kumiko-assets.zip`.

## Rollback

### If a draft is broken but not yet promoted

```bash
gh release delete vX.Y.Z --yes --cleanup-tag \
  --repo OgalinLabM0/Kumiko-Amadeus
```

This deletes the draft release **and** the `vX.Y.Z` tag. Fix the
underlying issue, then restart from Step 0.

### If a GA release must be revoked

```bash
# 1. Demote the release so it stops being "latest".
gh release edit vX.Y.Z --draft=true --repo OgalinLabM0/Kumiko-Amadeus

# 2. Or nuke it entirely:
gh release delete vX.Y.Z --yes --cleanup-tag \
  --repo OgalinLabM0/Kumiko-Amadeus
```

If the demoted/deleted version had already rolled out to users via
electron-updater, they keep the binary they installed — just don't get
prompted to update from it anymore. Push a fixed `vX.Y.(Z+1)` through
the normal cookbook to move users forward.

## Common pitfalls

- **`GH_TOKEN` unset and workflow fails with `Cannot find credentials`**
  → add the secret, then re-run the failed workflow.
- **`publish=true` but `package.json#version` already matches an
  existing GA release** → electron-builder refuses to overwrite. Bump
  to a new patch version before retrying.
- **Draft release exists with partial assets and you forget to promote**
  → users never see it. `gh release edit vX.Y.Z --draft=false --latest`
  or delete the draft.
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
