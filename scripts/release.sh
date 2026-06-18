#!/usr/bin/env bash
# Build + publish a GitHub Release. Auto-bumps from the latest v* tag.
#
#   npm run release            # patch bump (default)
#   npm run release -- minor   # minor bump
#   npm run release -- major   # major bump
#
# Pipeline:
#   1. Find the latest `v*` tag and compute the next version.
#   2. Validate: clean tree, gh CLI authed, tag/release don't already exist.
#   3. Bump package.json + package-lock.json (uncommitted).
#   4. Build .dmg + .zip via `npm run package`.
#   5. On success only: commit, tag, push, create GH release.
#
# On failure (any step after bump): the package.json change is stashed
# (recoverable via `git stash list` / `git stash pop`) — never deleted.

set -euo pipefail

cd "$(dirname "$0")/.."

# Auto-load notarization credentials from a known location outside
# the repo so the user doesn't have to re-export env vars per shell.
# Treats the file's first non-blank line as the app-specific password.
# Skipped if the file is missing — release will then run unsigned/
# unnotarized (electron-builder will surface a clear error).
NOTARIZE_PASSWORD_FILE="${NOTARIZE_PASSWORD_FILE:-$HOME/Documents/popbot-notarize.txt}"
if [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -f "$NOTARIZE_PASSWORD_FILE" ]; then
  APPLE_APP_SPECIFIC_PASSWORD="$(grep -v '^[[:space:]]*$' "$NOTARIZE_PASSWORD_FILE" | head -1 | tr -d '[:space:]')"
  export APPLE_APP_SPECIFIC_PASSWORD
fi
# Apple notarization identity. Set these in your environment (or a local
# untracked wrapper script) to release a signed + notarized build under
# your own Apple Developer account. Left unset, notarization fails and
# electron-builder surfaces a clear error.
export APPLE_ID="${APPLE_ID:-}"
export APPLE_TEAM_ID="${APPLE_TEAM_ID:-}"

if [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
  echo "warning: APPLE_APP_SPECIFIC_PASSWORD not set and $NOTARIZE_PASSWORD_FILE missing." >&2
  echo "         notarization will fail. Generate one at appleid.apple.com." >&2
fi

BUMP="${1:-patch}"
case "$BUMP" in
  patch|minor|major) ;;
  *) echo "Usage: $(basename "$0") [patch|minor|major]" >&2; exit 1 ;;
esac

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found. Install: brew install gh" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree not clean. Commit or stash before releasing." >&2
  git status --short
  exit 1
fi

# Compute the next version from the latest v* tag (not package.json) so
# the script is the single source of truth even if package.json drifts.
git fetch --tags --quiet origin || true
LAST_TAG=$(git tag -l 'v*' --sort=-v:refname | head -1)
LAST_VERSION="${LAST_TAG#v}"
LAST_VERSION="${LAST_VERSION:-0.0.0}"

IFS='.' read -r MAJOR MINOR PATCH <<< "$LAST_VERSION"
case "$BUMP" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
esac
NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
VERSION="v${NEW_VERSION}"
NAME="PopBot $VERSION"

if git rev-parse "$VERSION" >/dev/null 2>&1; then
  echo "Tag $VERSION already exists. Did the last release succeed?" >&2
  exit 1
fi

if gh release view "$VERSION" >/dev/null 2>&1; then
  echo "GitHub Release $VERSION already exists." >&2
  exit 1
fi

# Stash the in-flight bump on failure so the tree comes back clean
# without losing the change. User can `git stash pop` to recover.
stash_bump_on_exit() {
  local code=$?
  if [ $code -ne 0 ] && [ -n "$(git status --porcelain package.json package-lock.json 2>/dev/null)" ]; then
    echo "Stashing in-flight version bump (recover with: git stash pop)" >&2
    git stash push --include-untracked --message "popbot release rollback ${VERSION}" \
      -- package.json package-lock.json >/dev/null 2>&1 || true
  fi
}
trap stash_bump_on_exit EXIT

echo "==> Bumping ${LAST_VERSION} -> ${NEW_VERSION} (${BUMP})"
# --no-git-tag-version: bump files only, no commit, no tag. We commit
# + tag manually below once the build succeeds.
npm version "$NEW_VERSION" --no-git-tag-version --allow-same-version >/dev/null

echo "==> Building binaries for $VERSION"
npm run package

# Match the just-built version explicitly — globbing on `PopBot-*.dmg`
# would pick up a stale older build sitting next to the new one.
DMG=$(ls release/PopBot-${NEW_VERSION}-*.dmg 2>/dev/null | head -1)
ZIP=$(ls release/PopBot-${NEW_VERSION}-*-mac.zip 2>/dev/null | head -1)
if [ -z "$DMG" ] || [ -z "$ZIP" ]; then
  echo "Expected artifacts not found in release/" >&2
  ls release/ || true
  exit 1
fi

echo "==> Committing + tagging $VERSION"
git add package.json package-lock.json
git commit -m "chore: release ${VERSION}" >/dev/null
git tag -a "$VERSION" -m "$NAME"

# Bump succeeded and is committed — disarm the stash trap.
trap - EXIT

echo "==> Pushing commit + tag to origin"
git push origin HEAD
git push origin "$VERSION"

echo "==> Creating GitHub Release $VERSION"
gh release create "$VERSION" \
  "$DMG" "$ZIP" \
  --title "$NAME" \
  --generate-notes

echo "==> Done."
gh release view "$VERSION" --web >/dev/null 2>&1 || true
