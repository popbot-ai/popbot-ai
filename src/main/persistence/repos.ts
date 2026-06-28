/**
 * Persistence helpers for the `repos` table — the source-of-truth for
 * each source repository popbot can run chats against.
 *
 * v1 there's one repo (`app`); the table is the foundation for
 * multi-repo support. Call sites that currently read `settings.git`
 * for repoPath / color / slotPrefix / defaultBase / slot-count will
 * migrate to read from here as that wiring lands. Until then, the
 * row is kept in sync with settings by `seedDefaultRepoFromSettings`
 * at boot.
 */
import type { PerforceRepoConfig, RepoRecord, RepoWorktreeMode } from '@shared/persistence';
import type { SourceControlProviderId } from '@shared/sourceControl';
import { db } from './db';

interface RepoRow {
  id: string;
  repo_path: string;
  color: string;
  slot_prefix: string;
  default_base: string;
  slot_count: number;
  mode: string;
  scm: string | null;
  p4_config: string | null;
  created_at: number;
  updated_at: number;
}

function rowToRecord(r: RepoRow): RepoRecord {
  let p4: PerforceRepoConfig | undefined;
  if (r.p4_config) {
    try {
      p4 = JSON.parse(r.p4_config) as PerforceRepoConfig;
    } catch {
      p4 = undefined;
    }
  }
  return {
    id: r.id,
    repoPath: r.repo_path,
    color: r.color,
    slotPrefix: r.slot_prefix,
    defaultBase: r.default_base,
    slotCount: r.slot_count,
    mode: (r.mode === 'ephemeral' ? 'ephemeral' : 'slots') as RepoWorktreeMode,
    scm: (r.scm ?? 'git') as SourceControlProviderId,
    ...(p4 ? { p4 } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Read one repo by id. Returns null when not yet seeded. */
export function getRepo(id: string): RepoRecord | null {
  const row = db().prepare<[string], RepoRow>('SELECT * FROM repos WHERE id = ?').get(id);
  return row ? rowToRecord(row) : null;
}

/** All known repos in stable id order. Renderer-friendly. */
export function listRepos(): RepoRecord[] {
  const rows = db()
    .prepare<[], RepoRow>('SELECT * FROM repos ORDER BY id ASC')
    .all();
  return rows.map(rowToRecord);
}

/**
 * Upsert a repo. `id` is the primary key — passing the same id replaces
 * the row. NOTE: `mode` and `scm` are INSERT-only by design — once a repo
 * exists we never rewrite them here, because switching either after chats
 * have been created against it would orphan their worktrees / change the
 * provider out from under them. The UI enforces this by only exposing
 * them at create time; this helper mirrors that contract by leaving them
 * untouched on the UPDATE leg. `p4_config` IS updatable so a base recache
 * can advance the stored base changelist.
 */
export function upsertRepo(input: Omit<RepoRecord, 'createdAt' | 'updatedAt'>): RepoRecord {
  // Enforce the Perforce invariant at the persistence boundary so an invalid
  // state (scm='perforce' with no connection config) can never be written.
  if (input.scm === 'perforce' && !input.p4) {
    throw new Error(`Perforce repo "${input.id}" requires p4 config (port, user, depot, base changelist)`);
  }
  const now = Date.now();
  db().prepare(
    `INSERT INTO repos (id, repo_path, color, slot_prefix, default_base, slot_count, mode, scm, p4_config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       repo_path    = excluded.repo_path,
       color        = excluded.color,
       slot_prefix  = excluded.slot_prefix,
       default_base = excluded.default_base,
       slot_count   = excluded.slot_count,
       -- COALESCE so an update that omits p4 (e.g. the edit-repo flow) can't
       -- NULL a Perforce config; a base recache still updates it with a real
       -- (non-null) value. scm is intentionally absent → insert-only/immutable.
       p4_config    = COALESCE(excluded.p4_config, repos.p4_config),
       updated_at   = excluded.updated_at`,
  ).run(
    input.id,
    input.repoPath,
    input.color,
    input.slotPrefix,
    input.defaultBase,
    input.slotCount,
    input.mode,
    input.scm ?? 'git',
    input.p4 ? JSON.stringify(input.p4) : null,
    now,
    now,
  );
  const out = getRepo(input.id);
  if (!out) throw new Error(`upsertRepo: row missing immediately after insert for ${input.id}`);
  return out;
}

/** Targeted update of just `slot_count`. The Configure Slots flow
 *  uses this after the per-slot worktree work succeeds, so the
 *  row's count only ever reflects worktrees that actually exist on
 *  disk. Distinct from {@link upsertRepo} so a partially-failed
 *  resize doesn't have to round-trip every other field. */
export function setRepoSlotCount(id: string, n: number): void {
  db()
    .prepare('UPDATE repos SET slot_count = ?, updated_at = ? WHERE id = ?')
    .run(Math.max(1, Math.floor(n)), Date.now(), id);
}

/** Count chats (open OR closed, but not soft-deleted) referencing this
 *  repo. Used by the delete-repo confirm UI to warn the user how many
 *  chats will be detached. Detached chats persist in the DB; if the
 *  user later re-adds a repo with the same id, those chats reattach
 *  automatically (the `repo_id` column is a string-match join, not a
 *  hard FK). */
export function countChatsForRepo(id: string): number {
  const row = db()
    .prepare<[string], { n: number }>(
      `SELECT COUNT(*) AS n FROM chats WHERE repo_id = ? AND deleted_at IS NULL`,
    )
    .get(id);
  return row?.n ?? 0;
}

/** Remove a repo by id. Chats with `repo_id = id` are NOT touched —
 *  they remain in the DB in a detached state and will silently
 *  reattach if a future `upsertRepo` recreates the same id. The UI is
 *  responsible for the loud "type the repo name to confirm" gate
 *  before calling this; the helper itself is unconditional. */
export function deleteRepo(id: string): void {
  db().prepare('DELETE FROM repos WHERE id = ?').run(id);
}
