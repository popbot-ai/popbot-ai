#!/usr/bin/env node
// Builds the site's build manifest (download.popbot.app/manifest.json).
//
// The manifest is the single source of truth the marketing site reads to
// decide what to advertise: the current stable version and, if one exists,
// the current beta — including the "new features" bullets shown in the beta
// band. It carries BOTH channels so the site can compare them and hide the
// beta once a stable release supersedes it.
//
// This script updates only the channel being released and MERGES into any
// existing manifest, so releasing a beta never disturbs the stable section
// and vice-versa. The Release workflow downloads the live manifest first,
// runs this, then re-uploads.
//
// Env:
//   DIR             stable | beta            (which channel this release lands in)
//   VERSION         e.g. 1.2.0 or 1.2.0-rc.7 (the released version)
//   UPDATED         ISO timestamp for `updated` (workflow passes `date -u`)
//   MANIFEST_IN     path to the existing manifest to merge (optional)
//   MANIFEST_OUT    path to write the new manifest (default: ./manifest.json)
//   HIGHLIGHTS      path to beta-highlights.json (default: ./beta-highlights.json)
//   STABLE_VERSION  seed the stable section if none exists yet (optional)
//
// Installer filenames mirror electron-builder.yml `artifactName`.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const {
  DIR,
  VERSION,
  UPDATED,
  MANIFEST_IN,
  MANIFEST_OUT = 'manifest.json',
  HIGHLIGHTS = 'beta-highlights.json',
  STABLE_VERSION,
} = process.env;

if (!DIR || !VERSION) {
  console.error('gen-manifest: DIR and VERSION are required');
  process.exit(1);
}
if (DIR !== 'stable' && DIR !== 'beta') {
  console.error(`gen-manifest: DIR must be "stable" or "beta" (got "${DIR}")`);
  process.exit(1);
}

// Installer filenames per platform for a given version — must match
// electron-builder.yml artifactName exactly.
const filesFor = (v) => ({
  mac: `PopBot-${v}-mac-arm64.dmg`,
  win: `PopBot-${v}-win-x64.exe`,
  linux: `PopBot-${v}-linux-amd64.deb`,
});

const readJson = (p) => {
  try {
    return p && existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch (e) {
    console.error(`gen-manifest: could not read ${p}: ${e.message}`);
    return null;
  }
};

const manifest = readJson(MANIFEST_IN) ?? {};
const date = (UPDATED || '').slice(0, 10); // YYYY-MM-DD for display

// Keep a stable section populated even when we're releasing a beta, so the
// site can compare the two and the first-ever beta manifest still knows the
// live stable version.
if (!manifest.stable && STABLE_VERSION) {
  manifest.stable = { version: STABLE_VERSION, files: filesFor(STABLE_VERSION) };
}

if (DIR === 'stable') {
  manifest.stable = { version: VERSION, date, files: filesFor(VERSION) };
} else {
  const notes = readJson(HIGHLIGHTS) ?? {};
  const beta = {
    version: VERSION,
    date,
    headline: notes.headline || 'New features in beta',
    highlights: Array.isArray(notes.highlights) ? notes.highlights : [],
    files: filesFor(VERSION),
  };
  // Per-locale headline + highlight title/body, so the site's beta band
  // localizes with the rest of the page. Icons stay shared from `highlights`.
  if (notes.i18n && typeof notes.i18n === 'object') beta.i18n = notes.i18n;
  manifest.beta = beta;
}

manifest.updated = UPDATED || manifest.updated || '';

writeFileSync(MANIFEST_OUT, JSON.stringify(manifest, null, 2) + '\n');
console.log(`gen-manifest: wrote ${MANIFEST_OUT} (${DIR} → v${VERSION})`);
