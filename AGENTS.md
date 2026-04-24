# AGENTS.md

Orientation file for any coding agent (or human) picking up this
repository for the first time. Read top to bottom once; you will have
enough context to make safe changes and, crucially, to ship a release
without guessing.

## Project at a glance

`Kumiko·Amadeus` is a desktop companion app built on Electron +
React + Vite. It ships as a Windows NSIS installer (x64 + arm64) and a
Linux AppImage (x64 + arm64). The core loop is long-term-memory chat
with a character backed by a local RAG pipeline (`bge-m3` ONNX
embeddings, `hnswlib-node` for ANN, `better-sqlite3` for persistence).

- Main window and desktop services: `electron-main.cjs`
- Preload bridge: `preload.cjs`
- Native RAG worker process: `electron-rag.cjs` + `rag-worker.cjs`
- React UI entry: `index.tsx` + `components/App.tsx`
- Build system: Vite (`vite.config.ts`) for web bundle, electron-builder
  (`package.json#build`) for installer.

## Repo map

```
.github/workflows/          CI: linux-appimage, windows-release, ios-cap-bootstrap
build/                      NSIS customisations (installerSidebar.bmp, installer.nsh)
components/                 React UI tree (app/, settings/, etc.)
constants/                  Compile-time configuration and feature flags
docs/                       Long-form documentation (RELEASE.md, windows-manual-install.md)
hooks/                      React hooks (useAutoSave, etc.)
models/bge-m3-onnx/         ONNX tokenizer files tracked; model_int8.onnx is fetched on demand
public/                     Frontend static assets. Includes gitignored character assets
scripts/                    Release and maintenance scripts (see "Daily commands")
services/                   Core app services: db, memory, gemini, state machine, etc.
store/                      Zustand stores
workers/                    Web workers (onnxruntime-web etc.)

electron-main.cjs           Main Electron process
electron-rag.cjs            Forked RAG process (isolates native modules)
preload.cjs                 contextBridge surface
rag-worker.cjs              Worker entry for RAG batching
index.html, index.tsx       Vite root
package.json                Dependencies + build config + scripts
tsconfig.json               TS project config
```

The **untracked but mandatory-at-runtime** locations are:

```
assets/lore.enc                 encrypted story memory
assets/worldbook.enc            encrypted world book
public/images/emotions/*.png    17 emotion sprites
public/ringtones/*.mp3          8 ringtones
public/images/logo.png          app logo
public/CCA-P2.png               call screen avatar
public/favicon-KA.ico           installer + window icon
public/sovits-ref/              optional GPT-SoVITS reference audio
models/bge-m3-onnx/model_int8.onnx   RAG embedding model (~450 MB)
```

None of these are in git. The first batch (character assets) is
distributed through `kumiko-assets.zip` on the latest release; the
model is fetched from Hugging Face. See `npm run fetch-assets` and
`npm run check-assets` below.

## Release asset anatomy

Every release ships **10 files**, grouped by who consumes them (substitute `<version>` for the actual semver, e.g. `2.14.0`):

| Group | Files | Consumer |
| --- | --- | --- |
| Installers | `Kumiko-Amadeus-Setup-x64-<version>.exe`, `Kumiko-Amadeus-Setup-arm64-<version>.exe`, `Kumiko-Amadeus-x86_64.AppImage`, `Kumiko-Amadeus-arm64.AppImage`, `Kumiko-Amadeus.apk` | End user downloads the single file matching their OS + arch. |
| Auto-update channels | `latest.yml`, `latest-arm64.yml`, `latest-linux.yml`, `latest-linux-arm64.yml` | `electron-updater` in the installed Electron app and the in-app GitHub Releases poller in the Android APK fetch these in the background. Users never touch them. |
| Shared assets | `kumiko-assets.zip` | `npm run fetch-assets` downloads this when building from source; regular end users never touch it. Installers already bundle everything inside. |

A release with all 10 is complete. See
[docs/RELEASE.md](docs/RELEASE.md) for the effect of a missing file.

## Daily commands

| Command | Purpose |
| --- | --- |
| `npm install` | Install dependencies. First-time setup. |
| `npm run fetch-assets` | Pull `kumiko-assets.zip` from latest release and unpack into `public/` + `assets/`. Idempotent: skips if sentinel files already present. If the latest release 404s on the zip (publish race), auto-falls back to the most recent prior release that still has it; set `FETCH_ASSETS_NO_FALLBACK=1` to disable the fallback. |
| `npm run check-assets` | **Pre-release mandatory check.** Diffs local asset set against the zip on the latest release. Exit 0 = in sync, exit 2 = drift (with a printed bootstrap hint), exit 1 = transport error. |
| `npm run desktop:dev` | Vite dev server + Electron main process, with hot reload. |
| `npm run build:cap` | Production Vite bundle (relative base, suitable for Electron + Capacitor). |
| `npm run desktop:build` | Full local installer build. Runs `build:cap` + electron-builder + channel yml + `release:assets` + clean. |
| `npm run release:assets` | Package `public/` + `assets/` into `release/kumiko-assets.zip`. Used for local bootstrap of a changed asset set. |
| `npm run build:lore` | Regenerate `assets/lore.enc` from `services/loreData.ts`. |

## Mandatory pre-release check

Before any release workflow is triggered — whether by you, by another
agent, or by a human — the following is non-negotiable:

```bash
npm run check-assets
```

- Must print `In sync with vX.Y.Z. Safe to release.`
- If it prints a drift list instead, follow the `gh release upload
  <tag> ... --clobber` command it shows, then re-run until in sync.
- Exit code 1 (network error) does not count as in sync. Re-try or
  verify manually.

**Why this matters.** Character assets are gitignored. If a developer
added a new sprite locally and forgot to refresh
`kumiko-assets.zip` on the latest release, CI would happily bake the
old asset set into the new installer, ship a stale release, and never
tell anyone. This check is the only safeguard against that class of
silent failure, and it runs in under 15 seconds.

**When to run this check.** Only when you are about to cut a release
or refresh the zip on the current latest tag. Not every merge to
`main` triggers a release — see
[When to cut a release](docs/RELEASE.md#when-to-cut-a-release) in the
release playbook for the current cadence policy.

## kumiko-assets.zip lifecycle

Separate "uploader" from "source of truth":

- **Source of truth**: whatever is on a developer's disk under
  `public/` + `assets/`. Git does not track these files; the latest
  release zip is their only persistent artifact.
- **Uploader during a release**: the Linux x64 matrix job in
  [.github/workflows/linux-appimage.yml](.github/workflows/linux-appimage.yml)
  is the **single owner** of the zip upload. It runs
  `npm run release:assets` then `gh release upload --clobber` to attach
  a fresh snapshot to the new release. Windows workflow and Linux
  arm64 matrix job skip this step. Sole ownership prevents four
  concurrent matrix jobs racing on `--clobber`.
- **Consumer during a build**: both the Linux and the Windows workflow
  run `npm run fetch-assets` early, pulling the zip from
  `/releases/latest/download/kumiko-assets.zip`. Whichever workflow
  runs first is irrelevant — they both read from the same latest-zip
  URL.

If assets change, the developer bootstraps by refreshing the zip on
the **current latest** release (not the upcoming release) so that
subsequent workflow runs see the new content:

```bash
npm run release:assets
gh release upload <current-latest-tag> release/kumiko-assets.zip --clobber
npm run check-assets     # confirm in sync
```

`npm run check-assets` automates detecting when this is necessary.
Details and the full rollback procedure for the "forgot to bootstrap"
pitfall are in [docs/RELEASE.md](docs/RELEASE.md#common-pitfalls).

## Distribution channels and their status

| Channel | Workflow | Status |
| --- | --- | --- |
| Linux AppImage (x64 + arm64) | [.github/workflows/linux-appimage.yml](.github/workflows/linux-appimage.yml) | Fully automated. `workflow_dispatch` with `publish` boolean. Smoke-tested via `scripts/verify-appimage-contents.cjs`. |
| Windows NSIS (x64 + arm64) | [.github/workflows/windows-release.yml](.github/workflows/windows-release.yml) | Fully automated. `workflow_dispatch` with `publish` boolean. Smoke-tested via `scripts/verify-nsis-contents.cjs`. arm64 runs on the `windows-11-arm` partner runner. |
| iOS Capacitor bootstrap | [.github/workflows/ios-cap-bootstrap.yml](.github/workflows/ios-cap-bootstrap.yml) | Generates the `ios/` Capacitor project artifact for developers with an Apple dev account. **Not a user-facing release.** |

See [docs/RELEASE.md](docs/RELEASE.md) for the step-by-step cookbook
that promotes a draft release to GA across both desktop channels.

## Known gaps

- **Windows dual-arch installer collision (FIXED in v2.14.0 / F2B.5)**:
  `package.json#build.nsis.artifactName` is
  `Kumiko-Amadeus-Setup-${arch}-${version}.exe`. Without the explicit
  `${arch}` token both legs of the matrix wrote to the same filename
  and the second upload overwrote the first as a ~1.6 GB universal
  installer. As a defence-in-depth, [windows-release.yml](.github/workflows/windows-release.yml)
  Step C.1 also deletes any `Kumiko-Amadeus-Setup-${PACKAGE_VERSION}.exe`
  GitHub release asset that lacks an `-x64-` / `-arm64-` arch suffix.
- **Windows / Linux differential update blockmaps (RE-ENABLED in v2.14.2 / K.1)**:
  `package.json#build.nsis.differentialPackage` was disabled in v2.14.0
  while we were tracking down the dual-arch bug above and never turned
  back on. With the artifactName fix in place, blockmap generation is
  safe again, so v2.14.2 sets `differentialPackage: true` and lets
  electron-builder emit the matching `.blockmap` siblings (Windows NSIS
  + Linux AppImage). The blockmap siblings are NOT the same thing as
  the universal installer — the C.1 cleanup grep is anchored on the
  exact `Kumiko-Amadeus-Setup-${PACKAGE_VERSION}.exe` literal so it
  will not delete `*.blockmap` files. The arm64 channel file may still
  need synthesis via `scripts/generate-latest-yml.cjs` if
  electron-builder skips it on the matrix arm64 leg — see release
  cookbook Step 5.
- **macOS desktop**: no channel. Not planned until someone volunteers
  a signed-notarised build pipeline on `macos-latest`.
- **iOS App Store release**: out of scope. The iOS workflow only
  bootstraps the Xcode project; archive / upload is manual on a
  developer's Mac.
- **CHANGELOG**: not maintained yet. Release notes live on GitHub
  release descriptions for now.
- **Linux package formats beyond AppImage**: no deb / rpm / flatpak /
  snap. AppImage covers most glibc distros.
- **Windows 32-bit**: explicitly not supported; modern Windows users
  have shifted to x64 or arm64.

Any of these are reasonable future scope expansions. None of them
should block a regular release.
