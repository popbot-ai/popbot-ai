/**
 * Functional tests for the per-slot filesystem watcher, exercised against the
 * REAL @parcel/watcher native backend (FSEvents on macOS, inotify on Linux,
 * ReadDirectoryChangesW on Windows). These verify that:
 *   - real create/modify/delete events reach getSlotChanges()
 *   - ignored subtrees never record
 *   - an unpredicted exploder trips spam detection (auto-mute + suggestion)
 *
 * The watch is async and event delivery is coalesced by the OS, so assertions
 * poll with generous timeouts rather than fixed sleeps.
 */
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, unlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startSlotWatch,
  stopSlotWatch,
  getSlotChanges,
  getSpamSuggestion,
  type SlotChange,
} from './watcher';

const watched: string[] = [];

afterEach(() => {
  for (const w of watched.splice(0)) {
    stopSlotWatch(w);
    try {
      rmSync(w, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function makeSlot(): string {
  // realpathSync resolves macOS's /var -> /private/var (and /tmp -> /private/tmp)
  // symlinks so the watched root matches the paths FSEvents reports; otherwise
  // relative() would yield "../../.."-prefixed keys. Production slot mounts live
  // under a real (non-symlinked) path, so this only matters for the temp dir.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'shado-watch-')));
  watched.push(dir);
  return dir;
}

/** Poll `fn` until it returns truthy or the deadline passes. */
async function waitFor<T>(fn: () => T, timeoutMs = 5000, stepMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function change(changes: SlotChange[], path: string): SlotChange | undefined {
  return changes.find((c) => c.path === path);
}

describe('slot watcher (real @parcel/watcher backend)', () => {
  it('records create / modify / delete of a tracked file', async () => {
    const slot = makeSlot();
    mkdirSync(join(slot, 'src'), { recursive: true });
    startSlotWatch(slot);
    // Give the native subscribe() a moment to arm before the first write.
    await new Promise((r) => setTimeout(r, 300));

    const file = join(slot, 'src', 'main.cpp');
    writeFileSync(file, 'v1');
    await waitFor(() => change(getSlotChanges(slot), 'src/main.cpp'));
    expect(change(getSlotChanges(slot), 'src/main.cpp')).toBeTruthy();

    // A brand-new-then-modified file stays 'add'.
    writeFileSync(file, 'v2');
    await new Promise((r) => setTimeout(r, 300));
    expect(change(getSlotChanges(slot), 'src/main.cpp')?.kind).toBe('add');
  }, 20000);

  it('nets an add+delete within the session to nothing', async () => {
    const slot = makeSlot();
    startSlotWatch(slot);
    await new Promise((r) => setTimeout(r, 300));

    const file = join(slot, 'scratch.tmp2');
    writeFileSync(file, 'x');
    await waitFor(() => change(getSlotChanges(slot), 'scratch.tmp2'));
    unlinkSync(file);
    await waitFor(() => !change(getSlotChanges(slot), 'scratch.tmp2'));
    expect(change(getSlotChanges(slot), 'scratch.tmp2')).toBeFalsy();
  }, 20000);

  it('never records events inside a built-in ignored dir (Saved/)', async () => {
    const slot = makeSlot();
    mkdirSync(join(slot, 'Saved', 'deep'), { recursive: true });
    startSlotWatch(slot);
    await new Promise((r) => setTimeout(r, 300));

    // A tracked file AND an ignored-tree file, written together.
    writeFileSync(join(slot, 'tracked.txt'), 'x');
    for (let i = 0; i < 50; i++) writeFileSync(join(slot, 'Saved', 'deep', `g${i}.tmp`), 'x');

    await waitFor(() => change(getSlotChanges(slot), 'tracked.txt'));
    const changes = getSlotChanges(slot);
    expect(change(changes, 'tracked.txt')).toBeTruthy();
    expect(changes.some((c) => c.path.startsWith('Saved/'))).toBe(false);
  }, 20000);

  it('trips spam detection on an unpredicted exploder and auto-mutes it', async () => {
    const slot = makeSlot();
    // A dir NOT in the built-in prune list, so it reaches the handler and must
    // be caught dynamically (CHURN_CAP, or a drop-overflow — both route through
    // the same spam trip).
    const exploder = join(slot, 'GeneratedShaders');
    // Pre-create the subdirs BEFORE the watch starts. On Linux, inotify adds a
    // watch per directory, and files created in a brand-new subdir race that
    // add and are missed — so creating dirs after startSlotWatch would let the
    // churn slip past CHURN_CAP and never trip. FSEvents/RDCW watch the whole
    // tree and don't have this race, but pre-creating is correct everywhere.
    // Spread across MANY subdirs, all pre-created before the watch: the wide
    // spread defeats FSEvents' per-directory coalescing on macOS (batching into
    // a few dirs delivered too few events to reach CHURN_CAP), while pre-creating
    // avoids the Linux inotify new-subdir race.
    const subs = 60;
    for (let d = 0; d < subs; d++) mkdirSync(join(exploder, `batch${d}`), { recursive: true });
    startSlotWatch(slot);
    await new Promise((r) => setTimeout(r, 400));

    // Dump well past CHURN_CAP (4000) into the ALREADY-WATCHED subdirs, one dir
    // per drain so every backend keeps up and delivers discrete per-file events
    // (keeping churnByDir populated with concrete subdirs, so the suggested root
    // resolves under the exploder). Loop until it trips, with a hard bound.
    for (let round = 0; round < 3 && !getSpamSuggestion(slot); round++) {
      for (let d = 0; d < subs && !getSpamSuggestion(slot); d++) {
        const sub = join(exploder, `batch${d}`);
        for (let i = 0; i < 100; i++) writeFileSync(join(sub, `shader_${round}_${i}.gen`), 'x');
        await new Promise((r) => setTimeout(r, 20)); // let the watcher drain
      }
    }

    const suggestion = await waitFor(() => getSpamSuggestion(slot), 20000, 100);
    expect(suggestion).toBeTruthy();
    expect(suggestion?.startsWith('GeneratedShaders')).toBe(true);

    // Detection MUTED the exploder root: tripSpam drops the subtree's accumulated
    // changes and future events under it, so no GeneratedShaders/ path survives.
    // (Deterministic — asserted on the muted state, not on freshly-delivered
    // events, whose post-burst timing is backend-dependent and flaky in CI.)
    expect(getSlotChanges(slot).some((c) => c.path.startsWith('GeneratedShaders'))).toBe(false);
  }, 45000);

  // macOS-only: this exercises the FSEvents-specific "events dropped, must
  // re-scan" ERROR that arrives on a still-live subscription — the exact shape
  // the recoverable-overflow handler is written for. Linux (inotify) and Windows
  // (ReadDirectoryChangesW) surface overflow differently and with different
  // timing, so a real-FS burst there is inherently flaky; the handler logic
  // itself is platform-agnostic and covered by the spam test above.
  it.skipIf(process.platform !== 'darwin')(
    'keeps the slot watch alive after a fast-burst FSEvents overflow',
    async () => {
      // The regression guard: a burst big/fast enough to make FSEvents DROP
      // events (and emit a "must be re-scanned" error) must NOT tear the slot
      // down. The old handler called slots.delete() here, orphaning the still-
      // live native watch so the slot silently stopped tracking edits forever.
      const slot = makeSlot();
      const exploder = join(slot, 'Torrent');
      mkdirSync(exploder, { recursive: true });
      startSlotWatch(slot);
      await new Promise((r) => setTimeout(r, 300));

      // Hammer as fast as possible (no yields) to provoke a drop.
      for (let i = 0; i < 12000; i++) writeFileSync(join(exploder, `f_${i}.gen`), 'x');
      await new Promise((r) => setTimeout(r, 1500));

      // Whatever happened (drop or discrete), a normal edit AFTER the burst must
      // still be recorded — proving the watch survived.
      writeFileSync(join(slot, 'after-burst.txt'), 'x');
      await waitFor(() => change(getSlotChanges(slot), 'after-burst.txt'), 8000);
      expect(change(getSlotChanges(slot), 'after-burst.txt')).toBeTruthy();
    },
    40000,
  );
});
