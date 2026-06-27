/**
 * Per-slot filesystem watcher — the bridge that makes Perforce behave like
 * git.
 *
 * Perforce only tracks files you explicitly `p4 edit`/`add`/`delete`, but a
 * PopBot agent edits files freely (like git) and `p4 reconcile` is a
 * 20-minute tree walk on a game depot — unusable. Instead we watch the slot
 * mount with a single recursive `fs.watch` (ReadDirectoryChangesW on
 * Windows, FSEvents on macOS) and record the exact changed path + kind.
 * The PerforceProvider then opens just those files with targeted
 * `p4 edit/add/delete` — never a reconcile — so `p4 opened` reflects the
 * working tree the way `git status` does.
 *
 * Paths are stored worktree-relative, which under the `p4-init` client view
 * equals the provider's path key (`depot/...`), so the provider can map a
 * change straight to `//<path>`.
 */
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

export type ChangeKind = 'modify' | 'add' | 'delete';
export interface SlotChange {
  /** Worktree-relative path (forward slashes), = the provider path key. */
  path: string;
  kind: ChangeKind;
}

interface SlotState {
  watcher: FSWatcher;
  /** path → kind (latest wins, with add+delete cancelling out). */
  changes: Map<string, ChangeKind>;
  /** The slot's ignore matcher, computed ONCE at watch start. */
  ignore: IgnoreMatcher;
  /** While true, events are DROPPED — set around PopBot's own p4 writes
   *  (revert/shelve/sync) so those file rewrites aren't recorded as edits and
   *  re-opened on the next status. */
  paused: boolean;
}

const slots = new Map<string, SlotState>();

/*
 * ============================ PERFORMANCE CONTRACT ============================
 * This watch is a HOT PATH and a known timebomb: game builds/exports dump
 * 100k+ files into ignored dirs (Saved/, Intermediate/, DerivedDataCache/, …)
 * in seconds. Every byte of work per event matters. Rules:
 *
 *  1. The watch CALLBACK does the minimum: a fast ignore check on the RAW path,
 *     then (only if kept) one Map.set. NO async, NO p4, NO I/O on this path.
 *  2. The ignore check is O(path-depth) Set lookups that SHORT-CIRCUIT on the
 *     first ignored segment — no regex, runs before any path normalization.
 *  3. Ignored DIRECTORIES are pre-filtered, so a burst inside a build/cache dir
 *     costs ~one Set lookup per event. The ignore Set is built ONCE per slot at
 *     watch start (built-ins + the slot's `.p4ignore` dir patterns) — never
 *     parsed per event.
 *  4. The only syscall here is `existsSync`, and ONLY for an ambiguous 'rename'
 *     of a NON-ignored file. 'change' events and ignored events never stat.
 *  5. The watcher's filter is COARSE (dir-level, for speed). The AUTHORITATIVE
 *     ignore is `.p4ignore` enforced by `p4 add` with P4IGNORE set — wildcard /
 *     file / negation patterns are handled THERE, not here. Correctness does
 *     not depend on the watcher matching `.p4ignore` exactly.
 *  6. `changes` holds only non-ignored paths → ignored churn never grows
 *     memory. The expensive `p4 edit/add` is DEFERRED + BATCHED (openChanges),
 *     never per-event.
 *  7. Lossy is acceptable for ignored bursts (ReadDirectoryChangesW overflows
 *     and drops events) — we'd skip them anyway.
 * ============================================================================
 */

/** Built-in ignored directory names (lowercased): VCS/tooling + the heavy
 *  derived/cache dirs common to game engines. */
const BUILTIN_IGNORE_DIRS = [
  '.git', '.vs', '.shado', 'node_modules',
  'intermediate', 'saved', 'deriveddatacache', 'library', 'binaries',
];
/** Metadata files never opened (leaf-name match). */
const IGNORE_FILES = new Set([
  '.p4config', '.p4ignore', '.p4root', '.p4tickets', '.p4trust', '.popbot-p4.json',
]);

/**
 * Pre-parsed ignore, categorized by the cheapest string op that decides it —
 * the patterns we know for CERTAIN always qualify, matched fast:
 *  - `dirs`       a path SEGMENT equals this  (Set.has — O(1), the common case)
 *  - `endsWith`   the leaf ends with this      (`*.tmp` → '.tmp', `*~` → '~')
 *  - `startsWith` the leaf starts with this    (`temp*` → 'temp')
 * Built ONCE per slot. Richer patterns (path globs, `**`, negation) aren't put
 * here — `p4 add` + P4IGNORE enforce the full `.p4ignore` authoritatively.
 */
interface IgnoreMatcher {
  dirs: Set<string>; // lowercased segment names
  endsWith: string[]; // lowercased leaf suffixes
  startsWith: string[]; // lowercased leaf prefixes
  /** Patterns that don't fit a fast category (path globs, `**`, mixed
   *  wildcards). Checked LAST, the slow way, against the normalized path. */
  exceptions: RegExp[];
}

/** Convert a `.p4ignore`/gitignore-style glob to a regex matched against the
 *  normalized (lowercased, forward-slash) path at any segment boundary. */
function globToRegex(pat: string): RegExp | null {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i];
    if (ch === '*') {
      if (pat[i + 1] === '*') { re += '.*'; i++; } else { re += '[^/]*'; }
    } else if (ch === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(ch)) re += '\\' + ch;
    else re += ch;
  }
  try {
    return new RegExp(`(^|/)${re}($|/)`);
  } catch {
    return null;
  }
}

/**
 * Fast skip. ONE pass over the raw path: each directory segment is a Set
 * lookup that SHORT-CIRCUITS the whole path on the first hit — so an event deep
 * in an ignored tree dies after ~one lookup (the overwhelmingly common case for
 * a build burst). Only the leaf runs the (short) endsWith / startsWith lists.
 * No regex; no allocation beyond per-segment slices, and only up to the first
 * hit. The authoritative `.p4ignore` match happens LAST, at `p4 add`.
 */
function ignored(raw: string, m: IgnoreMatcher): boolean {
  const n = raw.length;
  let start = 0;
  for (let i = 0; i <= n; i++) {
    const c = i < n ? raw.charCodeAt(i) : 47; // treat string end as a separator
    if (c !== 47 && c !== 92) continue; // not '/' or '\'
    if (i > start) {
      const seg = raw.slice(start, i).toLowerCase();
      if (m.dirs.has(seg)) return true; // an ignored dir anywhere (or ignored leaf)
      if (i === n) {
        // Leaf-only: metadata file, then the suffix / prefix lists.
        if (IGNORE_FILES.has(seg)) return true;
        for (let k = 0; k < m.endsWith.length; k++) if (seg.endsWith(m.endsWith[k])) return true;
        for (let k = 0; k < m.startsWith.length; k++) if (seg.startsWith(m.startsWith[k])) return true;
      }
    }
    start = i + 1;
  }
  // Slow path — only when there ARE exception globs and the fast path missed.
  // Normalize once, then test the (rare) exception regexes.
  if (m.exceptions.length) {
    const p = raw.split('\\').join('/').toLowerCase();
    for (let k = 0; k < m.exceptions.length; k++) if (m.exceptions[k].test(p)) return true;
  }
  return false;
}

/** Build a slot's {@link IgnoreMatcher} ONCE from the built-ins + the cheap,
 *  fast-matchable lines of its `.p4ignore` (plain names, `*suffix`, `prefix*`).
 *  Path/glob patterns are skipped here and enforced by `p4 add` + P4IGNORE. */
function loadIgnore(wt: string): IgnoreMatcher {
  const dirs = new Set<string>(BUILTIN_IGNORE_DIRS);
  const endsWith: string[] = [];
  const startsWith: string[] = [];
  const exceptions: RegExp[] = [];
  try {
    for (const raw of readFileSync(join(wt, '.p4ignore'), 'utf8').split(/\r?\n/)) {
      const line = raw.trim().toLowerCase();
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      const pat = line.replace(/^\/+|\/+$/g, '');
      if (!pat) continue;
      const simple = !pat.includes('/');
      if (simple && !pat.includes('*') && !pat.includes('?') && !pat.includes('[')) {
        dirs.add(pat); // plain name
      } else if (simple && pat.startsWith('*') && !/[*?[\]]/.test(pat.slice(1))) {
        endsWith.push(pat.slice(1)); // '*.tmp' → '.tmp', '*~' → '~'
      } else if (simple && pat.endsWith('*') && !/[*?[\]]/.test(pat.slice(0, -1))) {
        startsWith.push(pat.slice(0, -1)); // 'temp*' → 'temp'
      } else {
        // Doesn't fit a fast category — compile it for the slow path.
        const re = globToRegex(pat);
        if (re) exceptions.push(re);
      }
    }
  } catch {
    /* no .p4ignore — built-ins only */
  }
  return { dirs, endsWith, startsWith, exceptions };
}

/**
 * TRADEOFF: this watch is FAST but LOSSY. `ReadDirectoryChangesW` has a fixed
 * internal buffer; a bulk write (a checkout/generate of thousands of files, a
 * fast build) can overflow it and silently drop events, so a real edit might
 * never get `p4 edit`-ed and would be absent from a submit. There is no
 * safety-net reconcile (it's a 20-min tree walk on a game depot). For
 * correctness-critical commits, a future opt-in have-list seed / scoped
 * verify is the intended escape hatch. We accept the tradeoff for the agent
 * loop where speed dominates.
 */
function record(state: SlotState, wt: string, rel: string, event: string): void {
  // Dropped while paused: PopBot's own p4 writes (a shelve's revert, a sync)
  // rewrite files on disk; recording them would re-open reverted files.
  if (state.paused) return;
  // NOTE: the ignore check already ran (fast, on the raw path) in the watch
  // callback — `rel` here is always a kept, non-ignored path.
  const prev = state.changes.get(rel);
  // 'change' = content modification of an existing file — no stat needed.
  // Only the ambiguous 'rename' (create OR delete) requires a filesystem
  // check, so we keep the synchronous stat off the common edit path.
  if (event === 'change') {
    if (prev !== 'add') state.changes.set(rel, 'modify');
    return;
  }
  if (!existsSync(join(wt, rel))) {
    // Disappeared. created-then-deleted within the session nets to nothing;
    // an existing file deleted is a real delete.
    if (prev === 'add') state.changes.delete(rel);
    else state.changes.set(rel, 'delete');
    return;
  }
  state.changes.set(rel, prev === 'add' ? 'add' : 'modify');
}

/** Start watching a slot mount (idempotent). */
export function startSlotWatch(worktreePath: string): void {
  if (slots.has(worktreePath) || !existsSync(worktreePath)) return;
  const state: SlotState = {
    watcher: undefined as unknown as FSWatcher,
    changes: new Map(),
    ignore: loadIgnore(worktreePath),
    paused: false,
  };
  const w = watch(worktreePath, { recursive: true }, (event, filename) => {
    if (filename == null) return;
    const raw = filename.toString();
    // FAST ignore on the raw path FIRST — most bulk-burst events die here with
    // no normalization, no Map work, no allocation past the first segment.
    if (ignored(raw, state.ignore)) return;
    record(state, worktreePath, raw.split('\\').join('/'), event);
  });
  w.on('error', () => {
    // The handle died (e.g. the VHDX volume unmounted). Drop the entry so a
    // later startSlotWatch() re-establishes it instead of silently no-op'ing
    // because the map still holds a dead watcher.
    try {
      w.close();
    } catch {
      /* already closed */
    }
    if (slots.get(worktreePath)?.watcher === w) slots.delete(worktreePath);
  });
  state.watcher = w;
  slots.set(worktreePath, state);
}

/** Stop watching a slot and drop its accumulated changes. */
export function stopSlotWatch(worktreePath: string): void {
  const s = slots.get(worktreePath);
  if (!s) return;
  try {
    s.watcher.close();
  } catch {
    /* already closed */
  }
  slots.delete(worktreePath);
}

/** Changes seen since the watch started (or last clear). */
export function getSlotChanges(worktreePath: string): SlotChange[] {
  const s = slots.get(worktreePath);
  if (!s) return [];
  return [...s.changes.entries()].map(([path, kind]) => ({ path, kind }));
}

/** Cheap dirty flag — true if the agent has touched anything. */
export function isSlotDirty(worktreePath: string): boolean {
  const s = slots.get(worktreePath);
  return !!s && s.changes.size > 0;
}

/** Forget accumulated changes (after submit/revert opens them in p4). */
export function clearSlotChanges(worktreePath: string): void {
  slots.get(worktreePath)?.changes.clear();
}

/** Stop recording events for a slot (around a PopBot-initiated p4 write).
 *  No-op if the slot isn't watched. */
export function pauseSlotWatch(worktreePath: string): void {
  const s = slots.get(worktreePath);
  if (s) s.paused = true;
}

/** Resume recording for a slot. */
export function resumeSlotWatch(worktreePath: string): void {
  const s = slots.get(worktreePath);
  if (s) s.paused = false;
}
