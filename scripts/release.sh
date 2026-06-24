#!/usr/bin/env bash
# Cut a release. Bumps the version, commits, tags, and pushes — the
# GitHub Actions "Build" workflow (.github/workflows/build.yml) does the
# actual cross-platform building and publishes the GitHub Release when it
# sees the pushed `v*` tag.
#
#   npm run release            # patch bump (default)
#   npm run release -- minor   # minor bump
#   npm run release -- major   # major bump
#
# Pipeline:
#   1. Validate: clean tree, on a branch, tag doesn't already exist.
#   2. Compute the next version from the latest `v*` tag (falling back to
#      package.json when there are no tags yet).
#   3. Bump package.json + package-lock.json, commit, annotate-tag.
#   4. Push the commit and the tag. The tag push triggers CI, which
#      builds macOS/Windows/Linux and creates the GitHub Release.
#
# Signing/notarization now happens in CI from repo secrets — no local
# Apple credentials are needed here anymore.

set -euo pipefail

cd "$(dirname "$0")/.."

BUMP="${1:-patch}"
case "$BUMP" in
  patch|minor|major) ;;
  *) echo "Usage: $(basename "$0") [patch|minor|major]" >&2; exit 1 ;;
esac

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree not clean. Commit or stash before releasing." >&2
  git status --short
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
# Releases are cut from main only — a v* tag triggers a published release,
# so tagging off a feature branch would ship non-main code. Override with
# RELEASE_BRANCH=<name> only if you really mean to.
RELEASE_BRANCH="${RELEASE_BRANCH:-main}"
if [ "$BRANCH" != "$RELEASE_BRANCH" ]; then
  echo "On branch '$BRANCH', but releases are cut from '$RELEASE_BRANCH'." >&2
  echo "Check out $RELEASE_BRANCH (or set RELEASE_BRANCH=$BRANCH to override)." >&2
  exit 1
fi

# Compute the next version from the latest v* tag so the script is the
# single source of truth. With no tags yet, fall back to the version in
# package.json (e.g. first release after import).
git fetch --tags --quiet origin || true
LAST_TAG=$(git tag -l 'v*' --sort=-v:refname | head -1)
LAST_VERSION="${LAST_TAG#v}"
LAST_VERSION="${LAST_VERSION:-$(node -p "require('./package.json').version")}"

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

echo "==> Bumping ${LAST_VERSION} -> ${NEW_VERSION} (${BUMP})"
# --no-git-tag-version: bump files only; we commit + tag explicitly below.
npm version "$NEW_VERSION" --no-git-tag-version --allow-same-version >/dev/null

echo "==> Committing + tagging $VERSION"
git add package.json package-lock.json
git commit -m "chore: release ${VERSION}" >/dev/null
git tag -a "$VERSION" -m "$NAME"

echo "==> Pushing commit + tag to origin"
# --atomic: branch and tag push as one transaction, so we never land the
# release commit on main without the v* tag that triggers CI publishing
# (or vice versa). If the push fails, the local commit + tag remain — fix
# the cause and re-run the push.
git push --atomic origin "$BRANCH" "$VERSION"

echo "==> Done. CI is now building macOS/Windows/Linux for $VERSION."
echo "    Watch it: gh run watch  (or the repo's Actions tab)"
echo "    The GitHub Release will appear once all platforms finish."
