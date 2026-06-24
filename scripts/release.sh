#!/usr/bin/env bash
# Releases are now run entirely from GitHub Actions — there is no local
# release step. This stub exists only to redirect anyone who runs
# `npm run release` out of habit.
echo "Releases are run from GitHub Actions now, not locally:" >&2
echo "" >&2
echo "  GitHub → Actions → 'Release' → Run workflow →" >&2
echo "    bump:    patch | minor | major" >&2
echo "    channel: prerelease (signed test build) | release (publish as latest)" >&2
echo "" >&2
echo "See docs/RELEASING.md." >&2
exit 1
