#!/usr/bin/env node
/**
 * Standalone CLI to exercise the p4 slot watcher's behavior — the
 * @parcel/watcher swap, native ignore-pruning of build/output dirs, and the
 * common-subpath spam auto-detect/mute. Mirrors the logic in
 * src/main/p4/watcher.ts so you can watch it work live, on any folder.
 *
 * Run via the wrapper (uses Electron's Node so the native @parcel/watcher ABI
 * matches the rebuilt module):
 *     bash scripts/watch-test.sh <dir>
 *
 * Then, in another terminal under <dir>:
 *   - edit/create/delete a file      → printed as update/create/delete
 *   - create a file in Saved/ etc.   → NOT seen (pruned in the core)
 *   - dump a burst into a folder      → "SPAM detected" + the common subpath, muted
 *     e.g.  mkdir -p Content/Gen/Cache && for i in $(seq 1 6000); do : > Content/Gen/Cache/f$i; done
 * Ctrl+C to quit.
 */
import { subscribe } from '@parcel/watcher';
import { existsSync } from 'node:fs';
import { relative, sep } from 'node:path';

const dir = process.argv[2];
if (!dir || !existsSync(dir)) {
  console.error('usage: watch-test <existing-dir>');
  process.exit(1);
}

// --- mirror of src/main/p4/watcher.ts ---
const PRUNE_DIR_NAMES = [
  '.git', '.vs', '.shado', 'node_modules',
  'Intermediate', 'Saved', 'DerivedDataCache', 'Library', 'Binaries', 'Build', 'Logs',
  'intermediate', 'saved', 'deriveddatacache', 'library', 'binaries', 'build', 'logs',
];
const ignore = PRUNE_DIR_NAMES.flatMap((d) => [`**/${d}`, `**/${d}/**`]);
const CHURN_CAP = 4000; // events past this → spam
const HOT_DIR_MIN = 25; // a dir must itself emit this many to define the spam root

function commonPathPrefix(dirs) {
  if (!dirs.length) return '';
  let segs = dirs[0].split('/');
  for (let i = 1; i < dirs.length && segs.length; i++) {
    const o = dirs[i].split('/');
    let k = 0;
    while (k < segs.length && k < o.length && segs[k] === o[k]) k++;
    segs = segs.slice(0, k);
  }
  return segs.join('/');
}

const changes = new Map(); // rel -> 'add' | 'modify' | 'delete'
const churnByDir = new Map();
let churnTotal = 0;
let totalEvents = 0;
const mutedPrefixes = [];

const isMuted = (rel) => mutedPrefixes.some((p) => rel === p || rel.startsWith(p + '/'));

function record(rel, type) {
  if (isMuted(rel)) return;
  const ls = rel.lastIndexOf('/');
  const d = ls === -1 ? '' : rel.slice(0, ls);
  churnByDir.set(d, (churnByDir.get(d) ?? 0) + 1);
  if (++churnTotal > CHURN_CAP) {
    const hot = [...churnByDir.entries()].filter(([, c]) => c >= HOT_DIR_MIN).map(([k]) => k);
    const root = commonPathPrefix(hot.length ? hot : [...churnByDir.keys()]);
    mutedPrefixes.push(root);
    const pre = root ? root + '/' : '';
    let dropped = 0;
    for (const k of [...changes.keys()]) if (k === root || (pre && k.startsWith(pre))) { changes.delete(k); dropped++; }
    console.log(`\n🚨 SPAM detected — common subpath: "${root || '(slot root)'}"  → auto-muted (dropped ${dropped} pending changes)\n`);
    churnByDir.clear();
    churnTotal = 0;
    return;
  }
  const prev = changes.get(rel);
  if (type === 'delete') { if (prev === 'add') changes.delete(rel); else changes.set(rel, 'delete'); }
  else if (type === 'create') changes.set(rel, prev === 'delete' ? 'modify' : 'add');
  else if (prev !== 'add') changes.set(rel, 'modify');
}

console.log(`\nWatching: ${dir}`);
console.log(`Pruned in the core (never watched): Saved/ Intermediate/ DerivedDataCache/ Binaries/ Build/ Logs/ .git/ node_modules/ …`);
console.log(`Spam auto-detect: > ${CHURN_CAP} events → mute the common subpath of the hot dirs.\n`);

const t0 = Date.now();
const sub = await subscribe(
  dir,
  (err, events) => {
    if (err) { console.error('watch error:', err); return; }
    const big = events.length > 20;
    for (const ev of events) {
      const rel = relative(dir, ev.path).split(sep).join('/');
      if (!rel) continue;
      totalEvents++;
      record(rel, ev.type);
      if (!big && !isMuted(rel)) console.log(`  ${ev.type.padEnd(6)} ${rel}`);
    }
    if (big) console.log(`  …batch of ${events.length} events`);
  },
  { ignore },
);
console.log(`subscribe ready in ${Date.now() - t0}ms  (native off-thread scan — no event-loop freeze even on a huge tree)\n`);

setInterval(() => {
  console.log(`— tracked: ${changes.size} change(s) | ${totalEvents} total event(s) | muted: [${mutedPrefixes.map((p) => p || '(root)').join(', ') || '—'}]`);
}, 3000);

process.on('SIGINT', async () => {
  console.log('\nstopping…');
  await sub.unsubscribe().catch(() => {});
  process.exit(0);
});
