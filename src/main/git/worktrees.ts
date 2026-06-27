/**
 * Git worktree management for the slot system.
 *
 * Lifecycle (parking-branch model):
 *   - Each slot N has a long-lived worktree at <worktreesDir>/slot-N
 *     on its parking branch `popbot/slot-N`. Idle slots stay on this
 *     branch — they never hold develop/main.
 *   - When a chat opens on slot N, we switch the worktree to the chat's
 *     branch (creating it off `baseBranch` if new).
 *   - When the chat closes, we optionally stash dirty changes, then
 *     `git checkout popbot/slot-N` to release the chat's branch back to
 *     the user. The worktree itself stays, so the next allocation is
 *     cheap.
 *
 * Invariants:
 *   - Every git invocation has an explicit cwd (repo or worktree).
 *   - We never operate on the repo's main checkout itself.
 *   - `--force` is used on the destructive path (full removeWorktree)
 *     so a half-broken worktree from a crash can't strand a slot.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

const execFileP = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    // `safe.directory=*` (scoped to this invocation) trusts the dir regardless
    // of owner — shado slot clones are created elevated and end up owned by the
    // Administrators group, which would otherwise trip git's dubious-ownership
    // guard. No-op for the user's own repos. Avoids recursive ACL rewrites that
    // would be ruinously slow + COW-bloating on a real game tree.
    const { stdout, stderr } = await execFileP('git', ['-c', 'safe.directory=*', ...args], { cwd, maxBuffer: 4 * 1024 * 1024 });
    return { stdout, stderr };
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`git ${args.join(' ')} failed: ${e.stderr?.trim() || e.message}`);
  }
}

export class GitWorktreeError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'GitWorktreeError';
  }
}

/**
 * Parking branch convention: `<reponame>/slot<N>` — e.g.
 * `app/slot1`. Namespacing by repo lets a single PopBot install
 * eventually manage multiple repos without slot-branch collisions.
 */
export function parkingBranch(repoName: string, slotId: number): string {
  return `${repoName}/slot${slotId}`;
}

async function branchExistsLocal(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export interface EnsureSlotWorktreeOpts {
  repoPath: string;
  worktreePath: string;
  parkBranch: string;
  baseBranch: string;
}

/**
 * Idempotent: ensures a worktree exists at `worktreePath` on
 * `parkBranch`. Creates the parking branch off `baseBranch` if needed.
 * No-ops if the worktree is already set up.
 */
export async function ensureSlotWorktree(opts: EnsureSlotWorktreeOpts): Promise<void> {
  const { repoPath, worktreePath, parkBranch, baseBranch } = opts;
  if (!existsSync(repoPath)) {
    throw new GitWorktreeError('repo-missing', `Repo not found at ${repoPath}`);
  }
  if (existsSync(worktreePath)) {
    // Already set up. Trust it; we'll catch later mismatches when we
    // try to switch branches.
    return;
  }
  mkdirSync(dirname(worktreePath), { recursive: true });
  if (await branchExistsLocal(repoPath, parkBranch)) {
    await git(repoPath, ['worktree', 'add', worktreePath, parkBranch]);
  } else {
    await git(repoPath, ['worktree', 'add', '-b', parkBranch, worktreePath, baseBranch]);
  }
}

export interface CheckoutBranchOpts {
  worktreePath: string;
  branch: string;
  baseBranch: string;
}

/**
 * In the slot's worktree, switch to `branch` (creating it from
 * `baseBranch` if it doesn't yet exist). Caller is responsible for
 * making sure the worktree is currently clean — the chat-create flow
 * always operates on a freshly-parked slot.
 *
 * Always fetches before creating a new branch so the chat starts off
 * the latest remote base, not a stale local copy. Fail-soft on fetch
 * (offline / origin unreachable) — we still proceed with whatever
 * local refs we have. When the base branch tracks a remote, we
 * branch off `origin/<baseBranch>` directly rather than the local
 * ref so newer commits on origin are picked up even when the user's
 * local base hasn't been pulled in a while.
 */
export async function checkoutBranch(opts: CheckoutBranchOpts): Promise<void> {
  const { worktreePath, branch, baseBranch } = opts;
  if (!existsSync(worktreePath)) {
    throw new GitWorktreeError('worktree-missing', `Worktree gone: ${worktreePath}`);
  }
  // We're inside the worktree, so a local branch lookup uses the same
  // ref space as the parent repo (worktrees share refs/heads).
  const exists = await branchExistsLocal(worktreePath, branch);
  if (exists) {
    await git(worktreePath, ['checkout', branch]);
    return;
  }
  // Refresh remote-tracking refs so origin/<baseBranch> reflects the
  // freshest upstream tip. Fail-soft: a network hiccup shouldn't
  // block creating the chat.
  await git(worktreePath, ['fetch', 'origin', '--prune', '--quiet']).catch(() => undefined);
  // Prefer the remote-tracking ref when present — that's the
  // authoritative latest. Fall back to the local name if origin
  // doesn't have it (rare: brand-new local branch never pushed).
  const remoteRef = `refs/remotes/origin/${baseBranch}`;
  const hasRemoteBase = await git(worktreePath, ['show-ref', '--verify', '--quiet', remoteRef])
    .then(() => true)
    .catch(() => false);
  const startPoint = hasRemoteBase ? `origin/${baseBranch}` : baseBranch;
  await git(worktreePath, ['checkout', '-b', branch, startPoint]);
}

export interface WorktreeStatus {
  /** Has uncommitted changes (staged / unstaged / untracked). */
  dirty: boolean;
  /** Up to N porcelain status lines for the close-confirm UI. */
  files: string[];
}

export async function worktreeStatus(worktreePath: string): Promise<WorktreeStatus> {
  if (!existsSync(worktreePath)) {
    return { dirty: false, files: [] };
  }
  const { stdout } = await git(worktreePath, ['status', '--porcelain']);
  const files = stdout.split('\n').filter((l) => l.trim().length > 0);
  return { dirty: files.length > 0, files };
}

export interface ParkSlotOpts {
  worktreePath: string;
  parkBranch: string;
  /** Run `git stash push -u` before parking. Mutually exclusive with
   *  `discard` (caller picks one). */
  stash?: boolean;
  /** Run `git checkout -- . && git clean -fd` before parking. */
  discard?: boolean;
  stashMessage?: string;
}

/**
 * Release the slot's worktree back to its parking branch. The chat's
 * branch remains in the repo (user can resume work via `git checkout`
 * or by reopening the chat). Optionally stash or discard local
 * changes first.
 */
export async function parkSlot(opts: ParkSlotOpts): Promise<void> {
  const { worktreePath, parkBranch, stash, discard, stashMessage } = opts;
  if (!existsSync(worktreePath)) return;

  if (stash) {
    try {
      const msg = stashMessage ?? `popbot:slot-park`;
      await git(worktreePath, ['stash', 'push', '-u', '-m', msg]);
    } catch (err) {
      // Nothing to stash → not fatal.
      const m = (err as Error).message;
      if (!/no local changes/i.test(m)) throw err;
    }
  } else if (discard) {
    // Drop tracked + untracked changes. `git checkout -- .` reverts
    // tracked files; `git clean -fd` removes untracked.
    await git(worktreePath, ['checkout', '--', '.']).catch(() => {/* clean repo */});
    await git(worktreePath, ['clean', '-fd']).catch(() => {/* nothing to clean */});
  }

  // Now safe to switch branches. Make sure the parking branch exists
  // (in case it got pruned by a user mid-session).
  if (!(await branchExistsLocal(worktreePath, parkBranch))) {
    await git(worktreePath, ['checkout', '-b', parkBranch]);
  } else {
    await git(worktreePath, ['checkout', parkBranch]);
  }
}

/**
 * Per-chat stash naming. Format: `popbot/chat_<id>/<ISO-UTC>`.
 *
 * Each close-with-stash writes a new entry under this prefix (the ISO
 * timestamp keeps them unique). On reopen we look up the most recent
 * stash whose message starts with `popbot/chat_<id>/` and pop it
 * (`git stash pop` deletes the entry — exactly what we want).
 */
export function chatStashPrefix(chatId: string): string {
  return `popbot/chat_${chatId}/`;
}

export function newChatStashName(chatId: string): string {
  return `${chatStashPrefix(chatId)}${new Date().toISOString()}`;
}

/**
 * Find the most recent stash whose message starts with `prefix`.
 * Returns the `stash@{N}` ref or null. Stashes are listed newest first,
 * so the first match is the latest.
 */
export async function findLatestStashRef(
  worktreePath: string,
  prefix: string,
): Promise<string | null> {
  if (!existsSync(worktreePath)) return null;
  try {
    // Custom separator (`||`) so we don't have to disambiguate against
    // colons inside ISO timestamps. `%gd` = stash@{N}, `%gs` = subject.
    const { stdout } = await git(worktreePath, ['stash', 'list', '--format=%gd||%gs']);
    for (const line of stdout.split('\n')) {
      const idx = line.indexOf('||');
      if (idx <= 0) continue;
      const ref = line.slice(0, idx);
      const subject = line.slice(idx + 2);
      // git prepends "On <branch>: " to stash messages.
      const colon = subject.indexOf(': ');
      const msg = colon >= 0 ? subject.slice(colon + 2) : subject;
      if (msg.startsWith(prefix)) return ref;
    }
  } catch {
    // no stashes yet
  }
  return null;
}

/**
 * Pop a specific stash ref. `git stash pop` removes the entry on
 * success — that's intentional, so a chat's stash is consumed when
 * we restore it. Falls back to a quiet no-op if the ref vanished.
 */
export async function popStash(worktreePath: string, ref: string): Promise<void> {
  await git(worktreePath, ['stash', 'pop', ref]).catch(() => {/* best-effort */});
}

/**
 * Fire-and-forget refresh of the parking branch — fetches origin and
 * fast-forwards the parking branch to `origin/<baseBranch>` so the next
 * chat that lands here starts from up-to-date code. We never block the
 * UI on this; failures (no origin, network down, FF refused) are
 * logged and dropped.
 */
/**
 * Run before allocating a slot for a new chat: bring both the parking
 * branch (currently checked out in the slot worktree) and the local
 * base-branch ref up to origin, so the chat branch we're about to
 * fork off `baseBranch` starts from genuinely current code AND so
 * the parking branch doesn't drift weeks behind in low-network or
 * no-shutdown sessions where the post-close background refresh has
 * been failing silently.
 *
 * Three best-effort steps, all fast-forward-only — divergence is
 * rejected by git natively and we just log + fall through:
 *
 *   1. `git fetch origin <baseBranch>` — single network round-trip;
 *      both follow-ups are local.
 *   2. `git merge --ff-only origin/<baseBranch>` — advances the
 *      parking branch (currently checked out).
 *   3. `git fetch origin <baseBranch>:<baseBranch>` — advances the
 *      local base ref. The refspec form is FF-only by definition,
 *      and works because the worktree's currently-checked-out branch
 *      is the parking branch, not the base, so git allows the update.
 *      (Falls back silently if base is checked out somewhere else.)
 *
 * No-throws: chat creation continues even if every step fails. The
 * worst case is the chat branches off slightly-stale local code,
 * which the user can rebase by hand if needed.
 */
export async function refreshSlotForAllocation(opts: {
  worktreePath: string;
  baseBranch: string;
}): Promise<void> {
  const { worktreePath, baseBranch } = opts;
  if (!existsSync(worktreePath)) return;
  // Step 1: pull origin into the worktree. Without this both follow-ups
  // are no-ops against an out-of-date remote-tracking ref.
  try {
    await git(worktreePath, ['fetch', 'origin', baseBranch]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[slots] fetch failed for ${baseBranch}: ${(err as Error).message}`);
    return;
  }
  // Step 2: fast-forward the parking branch (currently checked out
  // here) to origin/base. Diverged → leave alone.
  try {
    await git(worktreePath, ['merge', '--ff-only', `origin/${baseBranch}`]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[slots] park-branch FF failed: ${(err as Error).message}`);
  }
  // Step 3: advance the local base-branch ref so future forks see it.
  // Refspec form rejects non-FF and refuses if base is checked out
  // somewhere else — both safe failure modes.
  try {
    await git(worktreePath, ['fetch', 'origin', `${baseBranch}:${baseBranch}`]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[slots] base ref FF failed for ${baseBranch}: ${(err as Error).message}`);
  }
}

export function refreshParkBranchInBackground(opts: {
  worktreePath: string;
  parkBranch: string;
  baseBranch: string;
}): void {
  const { worktreePath, parkBranch, baseBranch } = opts;
  void (async () => {
    if (!existsSync(worktreePath)) return;
    try {
      await git(worktreePath, ['fetch', 'origin', baseBranch]);
      // Only fast-forward — never merge or rebase noisily. If the
      // parking branch has diverged for some reason, leave it alone.
      await git(worktreePath, ['merge', '--ff-only', `origin/${baseBranch}`]);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[slots] background refresh failed for ${parkBranch}: ${(err as Error).message}`);
    }
  })();
}

/**
 * Best-effort `git branch -D <name>` from the main repo. Used during
 * "delete all slots" to clean up parking branches. Swallows errors
 * (branch may already be gone, may have unmerged commits, etc.).
 */
export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  if (!existsSync(repoPath)) return;
  await git(repoPath, ['branch', '-D', branch]).catch(() => {/* best-effort */});
}

/**
 * Pick a folder name for an ephemeral chat worktree. Order:
 *   1. lowercased ticket id (e.g. `eng-20145`)
 *   2. `pr-<n>` if no ticket but a PR is attached
 *   3. last-12 of the chat id (`chat-a7b3c2d4...`)
 *
 * Pure naming — caller is responsible for collision handling against
 * disk (e.g. suffix with chat-id when the preferred name is taken).
 */
export function ephemeralWorktreeSlug(opts: {
  ticket: string | null;
  pr: number | null;
  chatId: string;
}): string {
  if (opts.ticket) {
    return opts.ticket.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  }
  if (typeof opts.pr === 'number') {
    return `pr-${opts.pr}`;
  }
  const tail = opts.chatId.replace(/^chat_/, '').slice(-12);
  return `chat-${tail || opts.chatId}`;
}

export interface EnsureChatWorktreeOpts {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
}

/**
 * Idempotent worktree-on-the-chat-branch for ephemeral mode.
 *
 * - If the worktree directory already exists, trust it (we'll catch
 *   any branch mismatch on next git op).
 * - If the chat branch already exists in the repo, attach the
 *   worktree to it directly (`git worktree add <path> <branch>`). Used
 *   on reopen — we don't want to re-fork off base and clobber the
 *   chat's existing commits.
 * - Otherwise we fetch origin's base, then add a new worktree that
 *   creates the branch off `origin/<baseBranch>` (or local `baseBranch`
 *   if origin doesn't have it). Used on first open.
 *
 * Fail-soft on the fetch: offline / unreachable origin still produces
 * a working worktree, just off the local base.
 */
export async function ensureChatWorktree(opts: EnsureChatWorktreeOpts): Promise<void> {
  const { repoPath, worktreePath, branch, baseBranch } = opts;
  if (!existsSync(repoPath)) {
    throw new GitWorktreeError('repo-missing', `Repo not found at ${repoPath}`);
  }
  if (existsSync(worktreePath)) return;
  mkdirSync(dirname(worktreePath), { recursive: true });

  if (await branchExistsLocal(repoPath, branch)) {
    await git(repoPath, ['worktree', 'add', worktreePath, branch]);
    return;
  }
  // Refresh origin so the new branch starts from the freshest base.
  await git(repoPath, ['fetch', 'origin', baseBranch]).catch(() => undefined);
  const remoteRef = `refs/remotes/origin/${baseBranch}`;
  const hasRemoteBase = await git(repoPath, ['show-ref', '--verify', '--quiet', remoteRef])
    .then(() => true)
    .catch(() => false);
  const startPoint = hasRemoteBase ? `origin/${baseBranch}` : baseBranch;
  await git(repoPath, ['worktree', 'add', '-b', branch, worktreePath, startPoint]);
}

export interface RemoveChatWorktreeOpts {
  repoPath: string;
  worktreePath: string;
  /** Pre-clean: stash dirty changes before removal. Mutually exclusive
   *  with `discard`. Stash is named with `stashMessage` so the chat
   *  can recover it on reopen via the same `findLatestStashRef`
   *  mechanism slot mode uses. */
  stash?: boolean;
  /** Pre-clean: discard tracked + untracked changes before removal.
   *  Used when the user explicitly chose "discard" on close-confirm. */
  discard?: boolean;
  stashMessage?: string;
}

/**
 * Tear down an ephemeral chat worktree. Intended close path: the
 * caller has already shown the dirty-prompt UI and resolved
 * stash/discard. We pre-clean the working tree per the flag, then
 * `git worktree remove --force` it (force so a partial-state worktree
 * from a prior crash can't strand the chat).
 *
 * The chat's branch is left in the repo — the user can `git checkout`
 * it later or reopen the chat (which will recreate a worktree on the
 * same branch via {@link ensureChatWorktree}). Deleting the branch is
 * a separate explicit action (only on hard-delete of the chat, and
 * even there gated by a setting).
 *
 * No-throws on missing worktree (idempotent close).
 */
export async function removeChatWorktree(opts: RemoveChatWorktreeOpts): Promise<void> {
  const { repoPath, worktreePath, stash, discard, stashMessage } = opts;
  if (!existsSync(worktreePath)) return;

  if (stash) {
    try {
      const msg = stashMessage ?? `popbot:chat-close`;
      await git(worktreePath, ['stash', 'push', '-u', '-m', msg]);
    } catch (err) {
      const m = (err as Error).message;
      if (!/no local changes/i.test(m)) throw err;
    }
  } else if (discard) {
    await git(worktreePath, ['checkout', '--', '.']).catch(() => {/* clean repo */});
    await git(worktreePath, ['clean', '-fd']).catch(() => {/* nothing to clean */});
  }

  if (existsSync(repoPath)) {
    try {
      await git(repoPath, ['worktree', 'remove', '--force', worktreePath]);
    } catch (err) {
      const m = (err as Error).message;
      if (!/not a working tree|does not exist/i.test(m)) throw err;
    }
    await git(repoPath, ['worktree', 'prune']).catch(() => {/* best-effort */});
  }
  if (existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true });
  }
}

/**
 * Hard tear-down: removes the worktree entirely. Used by uninstall /
 * "purge slot" tooling, NOT by the normal close path.
 */
export async function removeWorktree(opts: {
  repoPath: string;
  worktreePath: string;
}): Promise<void> {
  const { repoPath, worktreePath } = opts;
  if (existsSync(repoPath)) {
    try {
      await git(repoPath, ['worktree', 'remove', '--force', worktreePath]);
    } catch (err) {
      const m = (err as Error).message;
      if (!/not a working tree|does not exist/i.test(m)) throw err;
    }
    await git(repoPath, ['worktree', 'prune']).catch(() => {/* best-effort */});
  }
  if (existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true });
  }
}
