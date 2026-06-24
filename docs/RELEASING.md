# Releasing PopBot

Releases are built by GitHub Actions across **macOS, Windows, and Linux**
and published to a GitHub Release. You never build binaries for other
platforms locally — each OS must compile the native modules
(`better-sqlite3`, `node-pty`) against Electron's ABI on its own runner.

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
first tag exists, from `package.json`).

## What gets produced

| Platform | Artifacts |
|----------|-----------|
| macOS    | `.dmg`, `.zip` |
| Windows  | NSIS installer `.exe`, `.zip` |
| Linux    | `.AppImage`, `.zip` |

Build configuration lives in [`electron-builder.yml`](../electron-builder.yml);
the workflow is [`.github/workflows/build.yml`](../.github/workflows/build.yml).

## CI triggers

- **`v*` tag push** → build all platforms + publish a GitHub Release.
- **Pull request to `main`** (non-docs changes) → validation build only;
  artifacts attach to the workflow run, nothing is published.
- **Manual** → "Run workflow" (workflow_dispatch) for an on-demand build.

## Code signing

Signing is **optional and driven by repo secrets**. With no secrets set,
CI produces unsigned builds (macOS Gatekeeper and Windows SmartScreen
warn on first launch) — fine for testing, and CI stays green.

### macOS (sign + notarize)

Add these as **Settings → Secrets and variables → Actions** secrets:

| Secret | Value |
|--------|-------|
| `MAC_CSC_LINK` | base64 of your "Developer ID Application" cert as a `.p12` (`base64 -i cert.p12 \| pbcopy`) |
| `MAC_CSC_KEY_PASSWORD` | password for that `.p12` |
| `APPLE_ID` | Apple ID email used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | your Apple Developer Team ID |

When `MAC_CSC_LINK` **and** `APPLE_ID` are present the macOS job signs and
notarizes; otherwise it builds unsigned (and skips notarization).

### Windows (optional)

| Secret | Value |
|--------|-------|
| `WIN_CSC_LINK` | base64 of your code-signing `.pfx` |
| `WIN_CSC_KEY_PASSWORD` | password for that `.pfx` |

Absent these, the Windows build is unsigned.

## Auto-update note

The in-app update check (`src/main/updates/check.ts`) polls
`popbot-ai/popbot-ai` releases. As long as releases are published to this
repo by the workflow above, clients will see them.
