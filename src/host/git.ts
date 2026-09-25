/** The git the host needs on its own: branch listings for the new-chat
 *  dialog. Worktrees are workspaces.ts. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** Local and origin branches, newest commit first, with the usual base
 *  branches floated to the front — the same shape the desktop offers. */
export async function listBranches(repoPath: string): Promise<string[]> {
  const { stdout } = await execFileP(
    'git',
    ['-c', 'safe.directory=*', 'for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin'],
    { cwd: repoPath, maxBuffer: 4 * 1024 * 1024 },
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    const ref = line.trim();
    // `refs/remotes/origin/HEAD` shortens to plain `origin`; it is a
    // pointer, not a branch.
    if (!ref || ref === 'origin' || ref === 'origin/HEAD') continue;
    const name = ref.replace(/^origin\//, '');
    if (!name || name === 'HEAD' || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  const front = ['main', 'master', 'develop'].filter((b) => seen.has(b));
  return [...front, ...out.filter((b) => !front.includes(b))];
}
