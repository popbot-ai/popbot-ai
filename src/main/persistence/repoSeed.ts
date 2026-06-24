/**
 * Boot-time seed: ensure the `repos` table has a row reflecting the
 * current user's settings. v1 only has one repo (`app`), so this
 * runs unconditionally — upserts a single row built from
 * `settings.git` + `settings.slots`. Idempotent: re-runs just sync
 * the row to current settings.
 *
 * Goes away when multi-repo lands: at that point repos are managed
 * explicitly through Preferences and settings.git becomes per-repo
 * UI state, not the source of truth.
 */
import { basename } from 'node:path';
import { dlog } from '../diagLog';
import { getSetting } from './settings';
import { upsertRepo } from './repos';

interface GitSettings {
  repoPath?: string;
  repoName?: string;
  repoColor?: string;
  slotPrefix?: string;
  defaultBase?: string;
}

interface SlotsSettings { maxCount?: number }

export function seedDefaultRepoFromSettings(): void {
  const git = getSetting<GitSettings>('git');
  if (!git?.repoPath) {
    dlog('repo.seed.skip', { reason: 'no-repo-path-configured' });
    return;
  }
  const id = (git.repoName?.trim()
    || basename(git.repoPath).toLowerCase()
    || 'app');
  const slots = getSetting<SlotsSettings>('slots');
  const slotCount = typeof slots?.maxCount === 'number' && slots.maxCount > 0
    ? Math.floor(slots.maxCount)
    : 4;
  upsertRepo({
    id,
    repoPath: git.repoPath,
    color: git.repoColor?.trim() || '#6b7cff',
    slotPrefix: git.slotPrefix?.trim() || 'slot',
    defaultBase: git.defaultBase?.trim() || 'develop',
    slotCount,
    // The pre-multi-repo install uses slots; ephemeral mode is opt-in
    // when the user creates a *new* repo through Preferences. The seed
    // path never converts an existing slot repo to ephemeral.
    mode: 'slots',
  });
  dlog('repo.seed.done', { id, slotCount });
}
