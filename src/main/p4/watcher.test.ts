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
    // be caught dynamically (CHURN_CAP, or the macOS FSEvents drop-overflow — both
    // route through the same spam trip).
    const exploder = join(slot, 'GeneratedShaders');
    mkdirSync(exploder, { recursive: true });
    startSlotWatch(slot);
    await new Promise((r) => setTimeout(r, 300));

    // Dump well past CHURN_CAP (4000). PACE the writes (yield every batch) so
    // FSEvents delivers discrete per-dir events instead of dropping the whole
    // burst — that keeps churnByDir populated with concrete subdirs, so the
    // suggested spam root resolves to the exploder folder rather than "".
    for (let d = 0; d < 60 && !getSpamSuggestion(slot); d++) {
      const sub = join(exploder, `batch${d}`);
      mkdirSync(sub, { recursive: true });
      for (let i = 0; i < 100; i++) writeFileSync(join(sub, `shader_${i}.gen`), 'x');
      await new Promise((r) => setTimeout(r, 20)); // let the watcher drain
    }

    const suggestion = await waitFor(() => getSpamSuggestion(slot), 20000, 100);
    expect(suggestion).toBeTruthy();
    expect(suggestion?.startsWith('GeneratedShaders')).toBe(true);
    const root = suggestion as string;

    // Post-detection: the exploder root is muted, so a fresh event under it is
    // dropped, while a normal edit elsewhere is still recorded.
    mkdirSync(join(slot, root), { recursive: true });
    writeFileSync(join(slot, root, 'late.gen'), 'x');
    writeFileSync(join(slot, 'normal.txt'), 'x');
    await waitFor(() => change(getSlotChanges(slot), 'normal.txt'), 5000);
    const after = getSlotChanges(slot);
    expect(change(after, 'normal.txt')).toBeTruthy();
    expect(change(after, `${root}/late.gen`)).toBeFalsy();
  }, 40000);

  it('keeps the slot watch alive after a fast-burst FSEvents overflow', async () => {
    // The macOS regression guard: a burst big/fast enough to make FSEvents DROP
    // events (and emit a "must be re-scanned" error) must NOT tear the slot down.
    // The old handler called slots.delete() here, orphaning the still-live native
    // watch so the slot silently stopped tracking edits forever.
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
  }, 40000);
});
