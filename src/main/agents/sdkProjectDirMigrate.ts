/**
 * One-shot boot helper: rename the SDK's per-project session
 * directories under `~/.claude/projects/` from the legacy
 * `-popbot-worktrees-slot-N` shape to the new
 * `-popbot-workspaces-autorpg-slot-N` shape.
 *
 * Background: the Claude Agent SDK derives a project_key by
 * sanitizing the cwd (replacing `/` with `-`). When we moved slot
 * worktrees from `~/popbot/worktrees/slot-N` to
 * `~/popbot/workspaces/autorpg/slot-N`, the SDK started looking for
 * session state under a different encoded directory and couldn't
 * find any of the pre-move JSONLs. This helper does the matching
 * directory rename so the SDK resumes correctly without manual
 * intervention.
 *
 * Idempotent: if the destination already exists the source is left
 * alone (so re-runs are safe). New installs find nothing to migrate.
 * Cross-user-safe: the substring we look for is `popbot-worktrees-`
 * which embeds the app + old layout but no user-specific path
 * segments.
 */
import { existsSync, readdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dlog } from '../diagLog';

const OLD_FRAGMENT = '-popbot-worktrees-';
const NEW_FRAGMENT = '-popbot-workspaces-autorpg-';

export function migrateSdkProjectDirs(): void {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) {
    dlog('sdk.projectdir.migrate.skip', { reason: 'projects-dir-missing' });
    return;
  }
  let scanned = 0;
  let renamed = 0;
  let skippedExists = 0;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (err) {
    dlog('sdk.projectdir.migrate.readdir-failed', { error: (err as Error).message });
    return;
  }
  for (const name of entries) {
    scanned += 1;
    if (!name.includes(OLD_FRAGMENT)) continue;
    const newName = name.replace(OLD_FRAGMENT, NEW_FRAGMENT);
    const src = join(root, name);
    const dst = join(root, newName);
    if (existsSync(dst)) {
      // Destination already exists — probably from a prior partial
      // migration, or the SDK created a fresh dir at the new path
      // before we got here. Don't merge, just leave the source where
      // it is so the operator can decide.
      skippedExists += 1;
      dlog('sdk.projectdir.migrate.dst-exists', { src: name, dst: newName });
      continue;
    }
    try {
      renameSync(src, dst);
      renamed += 1;
      dlog('sdk.projectdir.migrate.renamed', { from: name, to: newName });
    } catch (err) {
      dlog('sdk.projectdir.migrate.failed', {
        from: name, to: newName, error: (err as Error).message,
      });
    }
  }
  dlog('sdk.projectdir.migrate.done', { scanned, renamed, skippedExists });
}
