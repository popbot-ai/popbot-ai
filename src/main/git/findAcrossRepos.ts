/**
 * Run a repository-scoped lookup against every configured repo in parallel.
 *
 * GitHub PR numbers are only unique inside one repository. Callers that span
 * several configured repos therefore cannot safely run a number lookup from
 * an arbitrary first repo. Results preserve configured-repo order when the
 * same number happens to exist in more than one repo.
 */
export async function findAcrossRepos<T>(
  repoPaths: readonly string[],
  lookup: (repoPath: string) => Promise<T>,
  isMiss: (error: unknown) => boolean,
): Promise<{ repoPath: string; value: T } | null> {
  const settled = await Promise.allSettled(repoPaths.map((repoPath) => lookup(repoPath)));

  for (let i = 0; i < settled.length; i += 1) {
    const result = settled[i];
    if (result.status === 'fulfilled') {
      return { repoPath: repoPaths[i], value: result.value };
    }
  }

  // A real failure (missing gh, auth, network, malformed output) is more
  // useful than "not found" when the remaining repositories were only misses.
  const hardFailure = settled.find(
    (result): result is PromiseRejectedResult =>
      result.status === 'rejected' && !isMiss(result.reason),
  );
  if (hardFailure) throw hardFailure.reason;
  return null;
}
