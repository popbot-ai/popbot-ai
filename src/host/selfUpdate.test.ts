import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdate, hostRepoRoot } from './selfUpdate';

vi.mock('../main/diagLog', () => ({ dlog: () => undefined }));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
}

/** GitHub (a bare repo), a developer's clone that pushes, and a host's clone. */
function world(): { dev: string; host: string } {
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
  return { dev, host };
}

function push(dev: string, file: string, content: string): string {
  writeFileSync(join(dev, file), content);
  git(dev, 'add', '.');
  git(dev, 'commit', '-m', `change ${file}`);
  git(dev, 'push', 'origin', 'HEAD:main');
  return git(dev, 'rev-parse', 'HEAD');
}

describe('a host keeping itself current with GitHub', () => {
  it('has nothing to do when it already runs the latest commit', async () => {
    const { host } = world();
    expect(await checkForUpdate(host, 'main')).toEqual({ action: 'none' });
  });

  it('takes a pushed commit, and knows whether dependencies changed', async () => {
    const { dev, host } = world();
    const to = push(dev, 'app.ts', 'v2\n');
    expect(await checkForUpdate(host, 'main')).toMatchObject({ action: 'update', to, depsChanged: false });
    push(dev, 'package.json', '{"name":"popbot","version":"2"}\n');
    expect(await checkForUpdate(host, 'main')).toMatchObject({ action: 'update', depsChanged: true });
  });

  it('leaves a checkout alone that someone is working in, or that is elsewhere', async () => {
    const { dev, host } = world();
    push(dev, 'app.ts', 'v2\n');
    writeFileSync(join(host, 'app.ts'), 'edited on the host\n');
    expect(await checkForUpdate(host, 'main')).toEqual({ action: 'skip', reason: 'the checkout has uncommitted changes' });
    git(host, 'checkout', '--', 'app.ts');
    // An untracked file (a build output, a log) is not someone's work.
    mkdirSync(join(host, 'dist-host'));
    writeFileSync(join(host, 'dist-host', 'popbot-host.cjs'), '// built\n');
    expect((await checkForUpdate(host, 'main')).action).toBe('update');
    git(host, 'switch', '-c', 'experiment');
    expect(await checkForUpdate(host, 'main')).toMatchObject({ action: 'skip', reason: expect.stringContaining('"experiment"') });
  });

  it('does not take a commit that is not a fast-forward', async () => {
    const { dev, host } = world();
    push(dev, 'app.ts', 'v2\n');
    writeFileSync(join(host, 'local.ts'), 'a local commit\n');
    git(host, 'add', '.');
    git(host, 'commit', '-m', 'local');
    expect(await checkForUpdate(host, 'main')).toEqual({ action: 'skip', reason: 'the checkout has diverged from origin/main' });
  });

  it('finds the repository it was built from', () => {
    const { host } = world();
    expect(hostRepoRoot(join(host, 'dist-host', 'popbot-host.cjs'))).toBe(host);
    expect(hostRepoRoot(join(tmpdir(), 'nowhere', 'dist-host', 'popbot-host.cjs'))).toBeNull();
  });
});
