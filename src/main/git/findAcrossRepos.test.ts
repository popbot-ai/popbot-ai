import { describe, expect, it, vi } from 'vitest';
import { findAcrossRepos } from './findAcrossRepos';

const miss = (message: string): Error & { code: 'NOT_FOUND' } =>
  Object.assign(new Error(message), { code: 'NOT_FOUND' as const });
const isMiss = (error: unknown): boolean =>
  (error as { code?: string }).code === 'NOT_FOUND';

describe('findAcrossRepos', () => {
  it('finds an item outside the first configured repository', async () => {
    const lookup = vi.fn(async (repoPath: string) => {
      if (repoPath === '/repos/frontend') return { number: 16190, isDraft: true };
      throw miss('no pull request in this repository');
    });

    await expect(findAcrossRepos(
      ['/repos/cloud', '/repos/frontend', '/repos/backend'],
      lookup,
      isMiss,
    )).resolves.toEqual({
      repoPath: '/repos/frontend',
      value: { number: 16190, isDraft: true },
    });
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('returns null when every repository reports a miss', async () => {
    await expect(findAcrossRepos(
      ['/repos/one', '/repos/two'],
      async () => { throw miss('not found'); },
      isMiss,
    )).resolves.toBeNull();
  });

  it('preserves a hard failure when no repository matches', async () => {
    const authError = Object.assign(new Error('not logged in'), { code: 'AUTH' });
    await expect(findAcrossRepos(
      ['/repos/one', '/repos/two'],
      async (repoPath) => {
        if (repoPath === '/repos/one') throw miss('not found');
        throw authError;
      },
      isMiss,
    )).rejects.toBe(authError);
  });
});
