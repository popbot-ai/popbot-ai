/**
 * Per-slot filesystem watcher — the bridge that makes Perforce behave like
 * git.
 *
 * Perforce only tracks files you explicitly `p4 edit`/`add`/`delete`, but a
 * PopBot agent edits files freely (like git) and `p4 reconcile` is a
 * 20-minute tree walk on a game depot — unusable. Instead we watch the slot
 * mount with a single recursive `fs.watch` (ReadDirectoryChangesW on
 * Windows, FSEvents on macOS, inotify on Linux) and record the exact changed
 * path + kind.
 * The PerforceProvider then opens just those files with targeted
 * `p4 edit/add/delete` — never a reconcile — so `p4 opened` reflects the
 * working tree the way `git status` does.
 *
 * Paths are stored worktree-relative, which under the `p4-init` client view
 * equals the provider's path key (`depot/...`), so the provider can map a
 * change straight to `//<path>`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { subscribe, type AsyncSubscription, type Event as ParcelEvent } from '@parcel/watcher';

export type ChangeKind = 'modify' | 'add' | 'delete';
export interface SlotChange {
  /** Worktree-relative path (forward slashes), = the provider path key. */
  path: string;
  kind: ChangeKind;
}

interface SlotState {
  /** @parcel/watcher subscription (native, off-thread, ignore-pruned). Null
   *  until subscribe() resolves (it's async). */
  subscription: AsyncSubscription | null;
  /** path → kind (latest wins, with add+delete cancelling out). */
  changes: Map<string, ChangeKind>;
  /** The slot's ignore matcher, computed ONCE at watch start. */
  ignore: IgnoreMatcher;
  /** Events per PARENT DIRECTORY — to locate a spamming subtree by its common
   *  ancestor (NOT just the top-level segment, which is too coarse). */
  churnByDir: Map<string, number>;
  /** Total non-muted events since the last detection — trips at CHURN_CAP. */
  churnTotal: number;
  /** Path prefixes currently muted: events under them are dropped cheaply. Holds
   *  auto-detected spam roots AND the user's "ignore this session" picks. */
  mutedPrefixes: string[];
  /** A freshly-detected spam root (the suggested common subpath) awaiting the
   *  user's decision, or null. Pre-fills the "ignore/reconcile which root?" box. */
  spam: string | null;
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

/** Glob patterns handed to @parcel/watcher to PRUNE the heavy generated dirs
 *  from the watch entirely — a build dumping 100k files into them never reaches
 *  the watcher (no inotify watches consumed there, no flood). Correct-case AND
 *  lowercase variants of the engine builtins; dirs nobody could predict are
 *  caught dynamically at runtime (CHURN_CAP). */
const PRUNE_DIR_NAMES = [
  '.git', '.vs', '.shado', 'node_modules',
  'Intermediate', 'Saved', 'DerivedDataCache', 'Library', 'Binaries', 'Build', 'Logs',
  'intermediate', 'saved', 'deriveddatacache', 'library', 'binaries', 'build', 'logs',
];
function pruneGlobs(extra: Iterable<string> = []): string[] {
  const globs: string[] = [];
  for (const d of [...PRUNE_DIR_NAMES, ...extra]) globs.push(`**/${d}`, `**/${d}/**`);
  return globs;
}

/** A single top-level folder emitting more than this many events is treated as
 *  generated/build output (hand-authored change sets are far smaller) → auto-
 *  muted so an UNPREDICTED exploder can't flood the watcher, and surfaced for a
 *  one-click ignore (.p4ignore / .gitignore / a PopBot preference). */
const CHURN_CAP = 4000;
/** A directory must itself emit at least this many events to count toward the
 *  spam root's common subpath — so a handful of legit edits elsewhere don't drag
 *  the suggested root up to the slot root. */
const HOT_DIR_MIN = 25;

/** Longest common ANCESTOR path of a set of dir paths (forward-slash, no
 *  trailing slash). '' when they share no leading segment. */
function commonPathPrefix(dirs: string[]): string {
  if (dirs.length === 0) return '';
  let segs = dirs[0].split('/');
  for (let i = 1; i < dirs.length && segs.length; i++) {
    const o = dirs[i].split('/');
    let k = 0;
    while (k < segs.length && k < o.length && segs[k] === o[k]) k++;
    segs = segs.slice(0, k);
  }
  return segs.join('/');
}

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
function recordEvent(state: SlotState, rel: string, type: ParcelEvent['type']): void {
  // Dropped while paused: PopBot's own p4 writes (a shelve's revert, a sync)
  // rewrite files on disk; recording them would re-open reverted files.
  if (state.paused) return;
  // Muted subtree? drop cheaply (the common case during a build burst).
  for (let i = 0; i < state.mutedPrefixes.length; i++) {
    const p = state.mutedPrefixes[i];
    if (rel === p || rel.startsWith(p + '/')) return;
  }
  // Tally per parent dir + total, and trip the spam detector once the total
  // blows past the cap — generated/build output we couldn't predict statically.
  const lastSlash = rel.lastIndexOf('/');
  const dir = lastSlash === -1 ? '' : rel.slice(0, lastSlash);
  state.churnByDir.set(dir, (state.churnByDir.get(dir) ?? 0) + 1);
  if (++state.churnTotal > CHURN_CAP && !state.spam) {
    // The spam root = common ancestor of the genuinely-hot dirs (legit sparse
    // edits elsewhere are excluded by HOT_DIR_MIN so they can't widen it).
    const hot = [...state.churnByDir.entries()].filter(([, c]) => c >= HOT_DIR_MIN).map(([d]) => d);
    const root = commonPathPrefix(hot.length ? hot : [...state.churnByDir.keys()]);
    state.spam = root; // pending the user's decision (pre-fills the dialog)
    muteSubtreeState(state, root);
    // Reset so a DIFFERENT folder spamming later re-trips detection.
    state.churnByDir.clear();
    state.churnTotal = 0;
    return;
  }
  const prev = state.changes.get(rel);
  if (type === 'delete') {
    // created-then-deleted within the session nets to nothing; else a real delete.
    if (prev === 'add') state.changes.delete(rel);
    else state.changes.set(rel, 'delete');
  } else if (type === 'create') {
    state.changes.set(rel, prev === 'delete' ? 'modify' : 'add');
  } else {
    // 'update' — content modification of an existing file.
    if (prev !== 'add') state.changes.set(rel, 'modify');
  }
}

/** Start watching a slot mount (idempotent). Uses @parcel/watcher: a NATIVE,
 *  off-thread recursive watch that PRUNES the ignored dirs during setup. So it
 *  never freezes the app (the old recursive `fs.watch` blocked ~14s scanning a
 *  game tree) and a build churning ignored folders never reaches our handler. */
export function startSlotWatch(worktreePath: string, extraIgnoreRels: string[] = []): void {
  if (slots.has(worktreePath) || !existsSync(worktreePath)) return;
  const state: SlotState = {
    subscription: null,
    changes: new Map(),
    ignore: loadIgnore(worktreePath),
    churnByDir: new Map(),
    churnTotal: 0,
    mutedPrefixes: [],
    spam: null,
    paused: false,
  };
  slots.set(worktreePath, state); // register EARLY so concurrent/deferred calls no-op
  void subscribe(
    worktreePath,
    (err, events) => {
      if (err) return handleWatchError(worktreePath, err);
      const st = slots.get(worktreePath);
      if (!st) return;
      for (const ev of events) {
        const rel = relative(worktreePath, ev.path).split(sep).join('/');
        // Secondary fine-grained filter (leaf suffix/prefix/metadata) — the
        // heavy DIRECTORIES were already pruned natively by @parcel, so this
        // only ever sees the kept tree.
        if (!rel || ignored(rel, st.ignore)) continue;
        recordEvent(st, rel, ev.type);
      }
    },
    // Built-in heavy dirs + the persisted per-folder ignores (.p4ignore entries /
    // PopBot prefs) the provider passes — so an ignored exploder is PRUNED
    // natively (consumes no inotify), not just dropped at our handler. A deep
    // path anchors to the slot root (absolute); a bare name matches anywhere.
    {
      ignore: [
        ...pruneGlobs(),
        ...extraIgnoreRels.map((r) => (r.includes('/') ? join(worktreePath, r) : `**/${r}`)),
      ],
    },
  ).then(
    (sub) => {
      const st = slots.get(worktreePath);
      if (st) st.subscription = sub;
      else void sub.unsubscribe().catch(() => {}); // stopped before subscribe resolved
    },
    (err) => handleWatchError(worktreePath, err),
  );
}

function handleWatchError(worktreePath: string, err: unknown): void {
  const code = (err as NodeJS.ErrnoException)?.code;
  console.error(`[p4/watcher] watch failed for ${worktreePath}: ${(err as Error)?.message ?? String(err)}`);
  if (code === 'ENOSPC' || code === 'EMFILE') {
    console.error(
      `[p4/watcher] system watch limit hit — exclude build/output folders via ` +
        `.p4ignore (and/or raise fs.inotify.max_user_watches).`,
    );
  }
  // Drop the entry so a later startSlotWatch() re-establishes it.
  slots.delete(worktreePath);
}

/** Stop watching a slot and drop its accumulated changes. */
export function stopSlotWatch(worktreePath: string): void {
  const s = slots.get(worktreePath);
  if (!s) return;
  slots.delete(worktreePath);
  void s.subscription?.unsubscribe().catch(() => {});
}

/** Re-subscribe a slot with an updated ignore set (after the user persists a
 *  folder to .p4ignore / PopBot prefs). Tears the old native watch down first
 *  (no overlap), then carries the session's mutes AND other folders' pending
 *  changes into the fresh state — only the newly-ignored subtree is dropped. */
export async function reloadSlotWatch(worktreePath: string, extraIgnoreRels: string[] = []): Promise<void> {
  const old = slots.get(worktreePath);
  const carriedMutes = old ? [...old.mutedPrefixes] : [];
  const carriedChanges = old ? new Map(old.changes) : null;
  slots.delete(worktreePath);
  if (old?.subscription) {
    try { await old.subscription.unsubscribe(); } catch { /* already gone */ }
  }
  startSlotWatch(worktreePath, extraIgnoreRels); // registers fresh state synchronously
  const ns = slots.get(worktreePath);
  if (!ns) return;
  if (carriedChanges) for (const [k, v] of carriedChanges) ns.changes.set(k, v);
  for (const p of carriedMutes) muteSubtreeState(ns, p); // re-apply session mutes
  for (const r of extraIgnoreRels) muteSubtreeState(ns, r); // drop carried changes now ignored
}

/** Unsubscribe EVERY slot watcher — call on app quit so @parcel/watcher's native
 *  threads shut down cleanly instead of crashing on teardown (napi_throw when a
 *  native callback fires into an already-torn-down JS context). */
export async function disposeAllWatches(): Promise<void> {
  const subs = [...slots.values()]
    .map((s) => s.subscription)
    .filter((s): s is AsyncSubscription => s != null);
  slots.clear();
  await Promise.allSettled(subs.map((sub) => sub.unsubscribe()));
}

/** Mute a subtree in a slot's state: drop its accumulated changes + future
 *  events. Shared by the detector and the user's "ignore this session" pick. */
function muteSubtreeState(state: SlotState, prefix: string): void {
  const p = prefix.replace(/^\/+|\/+$/g, '');
  if (p && !state.mutedPrefixes.includes(p)) state.mutedPrefixes.push(p);
  const pre = p ? p + '/' : '';
  for (const k of state.changes.keys()) if (k === p || (pre && k.startsWith(pre))) state.changes.delete(k);
}

/** A freshly-detected spam root (suggested common subpath) awaiting the user's
 *  decision, or null. Consumed by the surfacing dialog to pre-fill its path box. */
export function getSpamSuggestion(worktreePath: string): string | null {
  return slots.get(worktreePath)?.spam ?? null;
}

/** Clear the pending spam suggestion once the user has decided. */
export function clearSpamSuggestion(worktreePath: string): void {
  const s = slots.get(worktreePath);
  if (s) s.spam = null;
}

/** Mute a subtree for the rest of the session (the "ignore this session" pick).
 *  Events under it are dropped; nothing is persisted. */
export function muteSubtree(worktreePath: string, prefix: string): void {
  const s = slots.get(worktreePath);
  if (s) muteSubtreeState(s, prefix);
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
