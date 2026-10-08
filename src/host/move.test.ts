import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HostWorkspaceResult, PackedWork } from '@shared/hostProtocol';
import { packWork } from '../main/git/moveWork';
import { HostBots } from './bots';
import { defaultConfig, type HostConfig } from './config';
import { createHostServer } from './server';
import { HostSessions } from './sessions';
import { HostWorkspaces } from './workspaces';

vi.mock('../main/agents/ClaudeBackend', () => ({ ClaudeBackend: { spawn: () => { throw new Error('not used'); } } }));
vi.mock('../main/agents/CodexBackend', () => ({ CodexBackend: { spawn: () => { throw new Error('not used'); } } }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
}

describe('a chat moving onto a host and off again', () => {
  let root: string;
  let desk: string;
  let url: string;
  let close: () => void;
  const token = 'test-token';

  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? String(res.status));
    return json;
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'popbot-host-move-'));
    const remote = join(root, 'remote.git');
    git(root, 'init', '--bare', remote);
    const seed = join(root, 'seed');
    git(root, 'clone', remote, seed);
    writeFileSync(join(seed, 'page.txt'), 'v1\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'base');
    git(seed, 'push', 'origin', 'HEAD:main');
    desk = join(root, 'desk');
    git(root, 'clone', remote, desk);
    const hostRepo = join(root, 'host-site');
    git(root, 'clone', remote, hostRepo);

    const config: HostConfig = {
      ...defaultConfig(),
      token,
      workspacesDir: join(root, 'workspaces'),
      repos: [{ id: 'site', path: hostRepo, defaultBase: 'main', slotPrefix: 'site', slotCount: 0, mode: 'ephemeral' }],
    };
    const workspaces = new HostWorkspaces(config);
    const sessions = new HostSessions(config, { claude: null, codex: null }, workspaces);
    const bots = new HostBots(config, join(root, 'config.json'), sessions);
    const server = createHostServer({ config, version: 'test', configPath: join(root, 'config.json'), sessions, workspaces, bots, cli: { claude: null, codex: null } });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => {
    close();
    rmSync(root, { recursive: true, force: true });
  });

  it('unpacks a chat’s branch, commits and uncommitted work into a checkout on the host', async () => {
    git(desk, 'switch', '-c', 'feat/hero');
    writeFileSync(join(desk, 'page.txt'), 'v2\n');
    git(desk, 'commit', '-am', 'hero copy');
    writeFileSync(join(desk, 'page.txt'), 'v2 — not committed\n');
    writeFileSync(join(desk, 'notes.md'), 'scratch notes\n');
    const work = await packWork(desk, 'feat/hero', { withChanges: true });

    const ws = await post<HostWorkspaceResult>('/v1/chats/chat_move/unpack', {
      workspace: { kind: 'worktree', repoId: 'site', branch: 'feat/hero', baseBranch: 'main' },
      work,
    });
    expect(ws.kind).toBe('ephemeral');
    expect(ws.branch).toBe('feat/hero');
    expect(readFileSync(join(ws.cwd, 'page.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('v2 — not committed\n');
    expect(readFileSync(join(ws.cwd, 'notes.md'), 'utf8')).toBe('scratch notes\n');
    expect(git(ws.cwd, 'log', '-1', '--format=%s')).toBe('hero copy');
  });

  it('packs it back up from that checkout, more work included, and releases it with a stash a reopen will not pop', async () => {
    const held = await post<HostWorkspaceResult>('/v1/chats/chat_move/workspace', { kind: 'worktree', repoId: 'site', branch: 'feat/hero' });
    writeFileSync(join(held.cwd, 'notes.md'), 'scratch notes\nmore, written on the host\n');
    const { work } = await post<{ work: PackedWork | null }>('/v1/chats/chat_move/pack', {});
    expect(work?.branch).toBe('feat/hero');
    expect(Buffer.from(work!.patchBase64!, 'base64').toString()).toContain('more, written on the host');

    await post('/v1/chats/chat_move/release', { stash: true, moved: true });
    expect(existsSync(held.cwd)).toBe(false);
    const stashes = git(join(root, 'host-site'), 'stash', 'list');
    expect(stashes).toContain('popbot/moved/chat_chat_move/');
    expect(stashes).not.toContain('popbot/chat_chat_move/');
  });

  it('says why when the work cannot land', async () => {
    const work: PackedWork = { branch: 'feat/ghost', head: 'deadbeef'.repeat(5), bundleBase64: null, patchBase64: null };
    await expect(post('/v1/chats/chat_ghost/unpack', {
      workspace: { kind: 'worktree', repoId: 'site', branch: 'feat/ghost', baseBranch: 'main' },
      work,
    })).rejects.toThrow(/cannot get commit/);
  });
});
