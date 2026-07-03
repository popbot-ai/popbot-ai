#!/usr/bin/env node
// Flips just the "Show Beta on Website" flag (beta.visible) in an existing
// manifest, without rebuilding. Used by the Set-Beta-Visibility workflow.
//
// Env:
//   MANIFEST_IN    path to the current manifest.json
//   MANIFEST_OUT   path to write (default: same as MANIFEST_IN)
//   BETA_VISIBLE   "true" | "false"

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const { MANIFEST_IN, MANIFEST_OUT, BETA_VISIBLE } = process.env;

if (!MANIFEST_IN || !existsSync(MANIFEST_IN)) {
  console.error(`set-beta-visibility: manifest not found at ${MANIFEST_IN}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST_IN, 'utf8'));
if (!manifest.beta) {
  console.error('set-beta-visibility: manifest has no beta section — nothing to toggle.');
  process.exit(1);
}

const visible = String(BETA_VISIBLE) === 'true';
manifest.beta.visible = visible;

writeFileSync(MANIFEST_OUT || MANIFEST_IN, JSON.stringify(manifest, null, 2) + '\n');
console.log(`set-beta-visibility: beta v${manifest.beta.version} → visible=${visible}`);
