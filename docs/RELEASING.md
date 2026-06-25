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

The next version is computed from the latest `v*` tag, bumped per the
argument above. Before any tag exists, it falls back to the version in
`package.json` (so the first release is the next bump above that). The
script refuses to run from any branch other than `main` (override with
`RELEASE_BRANCH=<name>`).

## What gets produced

| Platform | Artifacts |
|----------|-----------|
| macOS    | `.dmg`, `.zip`, `latest-mac.yml`, `.blockmap` |
| Windows  | NSIS installer `.exe`, `.zip`, `latest.yml`, `.blockmap` |
| Linux    | `.deb` (no auto-update — see Linux note below) |

The `latest*.yml` + `.blockmap` files are electron-updater metadata
([`electron-builder.yml`](../electron-builder.yml) `publish: github`
generates them). The in-app auto-updater consumes them to detect, download,
and stage updates — see the Auto-update section below.

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

A tag build signs + notarizes only when the **full set** is present —
`MAC_CSC_LINK`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, **and**
`APPLE_TEAM_ID` (plus `MAC_CSC_KEY_PASSWORD` for the cert). If any is
missing it builds unsigned rather than failing notarization late, so a
half-configured secret set won't break CI.

### Windows (optional)

| Secret | Value |
|--------|-------|
| `WIN_CSC_LINK` | base64 of your code-signing `.pfx` |
| `WIN_CSC_KEY_PASSWORD` | password for that `.pfx` |

A tag build signs when `WIN_CSC_LINK` is present; otherwise unsigned.

## Auto-update

In-app auto-update is wired with **electron-updater**
([`src/main/updates/autoUpdate.ts`](../src/main/updates/autoUpdate.ts)).
In packaged builds it polls this repo's releases, **silently downloads** a
newer version in the background, and shows a **"Restart to install"** toast
when it's staged — clicking quits and relaunches into the new version. It
reads the `latest*.yml` + `.blockmap` metadata the release workflow
attaches; the `publish: github` config in `electron-builder.yml` embeds the
`app-update.yml` the client needs.

**Signing is required for the install step.** macOS rejects unsigned
updates, so in-app install only works once releases are signed + notarized
(the tag-build path with the Apple secrets set). Until then — and whenever
the updater hits an error (no metadata, network failure) — it **falls back**
to a manual "Download" toast that opens the release page, driven by the
lightweight GitHub check in
[`src/main/updates/check.ts`](../src/main/updates/check.ts). That same
lightweight check also backs the About dialog's on-demand "Check for
updates" and works everywhere, including dev and unsigned builds.

For any of this to surface a release, the workflow must publish
**non-draft, non-prerelease** Releases with the platform installers
attached — which it does. Auto-update is disabled in dev.

### Verifying auto-update (first end-to-end test)

The auto-update path can only be verified against **two real signed
releases** — not in dev (it's disabled) and not against a single release
(there's nothing newer to pull). Do this once, after signing is set up:

1. **Confirm signing is on.** Add the macOS (and optionally Windows)
   secrets from the table above. The first signed release must succeed —
   on macOS, unsigned/un-notarized builds can download but **fail to
   install**, so this whole test is meaningless unsigned.
2. **Cut release N**, e.g. `npm run release` → `v0.0.18`. Wait for the
   workflow to publish the Release with assets + `latest*.yml`.
3. **Install N from the published Release** on each OS you support
   (macOS `.dmg`, Windows `.exe`, Linux `.deb`). Launch it — verify
   Help ▸ About shows the right version.
4. **Cut release N+1**, e.g. `npm run release` → `v0.0.19`.
5. **Leave the N install running.** Within ~30s of launch (and then every
   6h) it checks; on a signed build it downloads N+1 silently, then shows
   the **"Restart to install"** toast. Click it.
6. **Confirm it relaunched into N+1** — Help ▸ About now shows the new
   version. That proves download → stage → quitAndInstall → relaunch works
   on that OS.

Per-platform notes:
- **macOS:** Squirrel.Mac applies the update from the `.zip` asset (not the
  `.dmg`); both must be in the Release. Gatekeeper rejects an unsigned/
  un-notarized update — if "Restart to install" does nothing, re-check
  notarization on the build.
- **Linux:** the `.deb` does **not** self-update — electron-updater only
  auto-updates AppImage on Linux. Update by installing the new `.deb`
  (`sudo dpkg -i …` / `sudo apt install ./…`). So skip the auto-update
  steps (4–6) for Linux; just install N+1 over N and confirm About. To
  restore in-app Linux auto-update, re-add `AppImage` to the `linux.target`
  in `electron-builder.yml`.
- **Windows:** the NSIS install updates in place; SmartScreen may warn
  until the build is signed with `WIN_CSC_LINK`.

If step 5 instead shows a **"Download"** toast (opening the release page),
the in-app updater hit an error and fell back — check the diagnostic log
(`update.error` / `update.check.failed` entries) for why, most often an
unsigned macOS build.
