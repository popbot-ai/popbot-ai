# Releasing PopBot

Releases are built by GitHub Actions across **macOS, Windows, and Linux**
and published to a GitHub Release on this repo. Each platform builds on its
own runner — the native modules (`better-sqlite3`, `node-pty`) must compile
against Electron's ABI per-OS, so cross-compiling isn't an option.

## Cutting a release

From a clean working tree on `main`:

```bash
npm run release            # patch bump (default)
npm run release -- minor   # minor bump
npm run release -- major   # major bump
```

`scripts/release.sh` bumps the version, commits, creates an annotated
`vX.Y.Z` tag, and pushes both. The pushed tag triggers the **Build**
workflow, which builds all three platforms and publishes the GitHub
Release with the artifacts attached. Watch it with `gh run watch` or the
Actions tab.

The next version is computed from the latest `v*` tag (or, before the
first tag exists, from `package.json` — so the first release is `v0.0.18`).

## What gets produced

| Platform | Artifacts |
|----------|-----------|
| macOS    | `.dmg`, `.zip`, `latest-mac.yml`, `.blockmap` |
| Windows  | NSIS installer `.exe`, `.zip`, `latest.yml`, `.blockmap` |
| Linux    | `.AppImage`, `.zip`, `latest-linux.yml` |

The `latest*.yml` + `.blockmap` files are electron-updater metadata
([`electron-builder.yml`](../electron-builder.yml) `publish: github`
generates them). The current update check doesn't consume them yet (see
below), but shipping them now means flipping on true auto-update later is
a client-only change.

Workflow: [`.github/workflows/build.yml`](../.github/workflows/build.yml).

## CI triggers

- **`v*` tag push** → build all platforms (signed if secrets are set) +
  publish a GitHub Release.
- **Pull request to `main`** (non-docs) → validation build only, **always
  unsigned**; artifacts attach to the run, nothing published, no secrets used.
- **Manual** → "Run workflow" (workflow_dispatch), unsigned.

Signing only ever runs on a `v*` tag push, which only the repo owner can
do. GitHub never exposes secrets to fork-triggered PR runs, so contributor
PRs can't reach the signing certs.

## Code signing

Signing is driven by **GitHub Actions secrets** (Settings → Secrets and
variables → Actions). They're encrypted, never in the git tree, and masked
in logs. With none set, tag builds produce unsigned binaries (macOS
Gatekeeper / Windows SmartScreen warn on first launch) and CI still passes.

### macOS (sign + notarize)

| Secret | Value |
|--------|-------|
| `MAC_CSC_LINK` | base64 of your "Developer ID Application" `.p12` (`base64 -i cert.p12 \| pbcopy`) |
| `MAC_CSC_KEY_PASSWORD` | password for that `.p12` |
| `APPLE_ID` | Apple ID email used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

A tag build signs + notarizes when `MAC_CSC_LINK` **and** `APPLE_ID` are present.

### Windows (optional)

| Secret | Value |
|--------|-------|
| `WIN_CSC_LINK` | base64 of your code-signing `.pfx` |
| `WIN_CSC_KEY_PASSWORD` | password for that `.pfx` |

A tag build signs when `WIN_CSC_LINK` is present; otherwise unsigned.

## Auto-update

**Today it's a notifier, not an auto-installer.**
[`src/main/updates/check.ts`](../src/main/updates/check.ts) polls this
repo's `releases/latest` on startup and every 10 minutes; when a newer
`v*` tag exists, it shows a toast with a **Download** link to the release
page. The user downloads and installs the new build manually.

For that to work, the release process must publish **non-draft,
non-prerelease** GitHub Releases (the default for `softprops/action-gh-release`)
with the platform installers attached — which the workflow does. No extra
wiring needed; cutting a release is sufficient for the notifier to surface it.

**Upgrading to true in-app auto-update** (download + install without a
trip to the browser) is a future, client-side change once signed releases
are confirmed working:

1. `npm i electron-updater`.
2. In the main process, replace the `check.ts` notifier with `autoUpdater`
   (`electron-updater`), pointed at the GitHub provider.
3. The release assets already carry the required `latest*.yml` + `.blockmap`
   metadata, so no release-process changes are needed.

macOS in-app auto-update **requires** the build to be signed + notarized
(unsigned updates are rejected), which is why this waits on signing.
