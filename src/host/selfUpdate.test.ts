import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostRepoRoot, planUpdate } from './selfUpdate';

vi.mock('../main/diagLog', () => ({ dlog: () => undefined }));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
}

/** GitHub (a bare repo), a developer's clone that pushes, and a host's clone. */
function world(): { dev: string; host: string; first: string } {
  const root = mkdtempSync(join(tmpdir(), 'popbot-selfupdate-'));
  dirs.push(root);
  const remote = join(root, 'github.git');
  git(root, 'init', '--bare', remote);
  const dev = join(root, 'dev');
  git(root, 'clone', remote, dev);
  writeFileSync(join(dev, 'package.json'), '{"name":"popbot"}\n');
  writeFileSync(join(dev, 'app.ts'), 'v1\n');
  git(dev, 'add', '.');
  git(dev, 'commit', '-m', 'v1');
  git(dev, 'push', 'origin', 'HEAD:main');
  const host = join(root, 'host');
  git(root, 'clone', remote, host);
  return { dev, host, first: git(dev, 'rev-parse', 'HEAD') };
}

function commit(dev: string, file: string, content: string, branch = 'main'): string {
  writeFileSync(join(dev, file), content);
  git(dev, 'add', '.');
  git(dev, 'commit', '-m', `change ${file}`);
  git(dev, 'push', 'origin', `HEAD:${branch}`);
  return git(dev, 'rev-parse', 'HEAD');
}

describe("a host moving to its desktop's version", () => {
  it('has nothing to do on the same commit, short or long', async () => {
    const { host, first } = world();
    expect(await planUpdate(host, first)).toEqual({ action: 'none' });
    expect(await planUpdate(host, first.slice(0, 7))).toEqual({ action: 'none' });
  });

  it('fast-forwards to a newer commit on its branch, and knows whether dependencies changed', async () => {
    const { dev, host } = world();
    const v2 = commit(dev, 'app.ts', 'v2\n');
    expect(await planUpdate(host, v2.slice(0, 7))).toMatchObject({ action: 'update', to: v2, fastForward: true, depsChanged: false });
    const v3 = commit(dev, 'package.json', '{"name":"popbot","version":"3"}\n');
    expect(await planUpdate(host, v3)).toMatchObject({ action: 'update', to: v3, depsChanged: true });
  });

  it("goes to an older commit or another branch's by checking it out — the desktop's version is the right one", async () => {
    const { dev, host, first } = world();
    const v2 = commit(dev, 'app.ts', 'v2\n');
    git(host, 'pull', '--quiet');
    expect(await planUpdate(host, first)).toMatchObject({ action: 'update', to: first, fastForward: false });
    git(dev, 'switch', '-c', 'feat/x', first);
    const feat = commit(dev, 'app.ts', 'feature\n', 'feat/x');
    expect(await planUpdate(host, feat)).toMatchObject({ action: 'update', to: feat, fastForward: false });
    expect(v2).not.toBe(feat);
  });

  it('refuses a checkout someone is working in, and a commit GitHub does not have', async () => {
    const { dev, host } = world();
    const v2 = commit(dev, 'app.ts', 'v2\n');
    writeFileSync(join(host, 'app.ts'), 'edited on the host\n');
    expect(await planUpdate(host, v2)).toEqual({ action: 'skip', reason: 'the checkout has uncommitted changes' });
    git(host, 'checkout', '--', 'app.ts');
    // An untracked file (a build output, a log) is not someone's work.
    mkdirSync(join(host, 'dist-host'));
    writeFileSync(join(host, 'dist-host', 'popbot-host.cjs'), '// built\n');
    expect((await planUpdate(host, v2)).action).toBe('update');
    expect(await planUpdate(host, 'abcdef1234567')).toMatchObject({ action: 'skip', reason: expect.stringContaining('not on GitHub') });
    expect(await planUpdate(host, 'not-a-sha')).toMatchObject({ action: 'skip' });
  });

  it('finds the repository it was built from', () => {
    const { host } = world();
    expect(hostRepoRoot(join(host, 'dist-host', 'popbot-host.cjs'))).toBe(host);
    expect(hostRepoRoot(join(tmpdir(), 'nowhere', 'dist-host', 'popbot-host.cjs'))).toBeNull();
  });
});
