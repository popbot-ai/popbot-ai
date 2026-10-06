import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer, connect, type Server as NetServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HostBots } from '../../host/bots';
import { defaultConfig, type HostConfig } from '../../host/config';
import { createHostServer } from '../../host/server';
import { HostSessions } from '../../host/sessions';
import { HostWorkspaces } from '../../host/workspaces';
import { hostEndpoint, localEndpoint, runTransfer, type Endpoint, type TransferProgress } from './transfer';

vi.mock('../agents/ClaudeBackend', () => ({ ClaudeBackend: { spawn: () => { throw new Error('not used'); } } }));
vi.mock('../agents/CodexBackend', () => ({ CodexBackend: { spawn: () => { throw new Error('not used'); } } }));
vi.mock('../diagLog', () => ({ dlog: () => undefined }));

const token = 'files-test-token';
let root: string;
const closers: Array<() => void> = [];

async function startHost(name: string): Promise<{ url: string; name: string; token: string }> {
  const config: HostConfig = { ...defaultConfig(), token, name, workspacesDir: join(root, name, 'ws') };
  const workspaces = new HostWorkspaces(config);
  const sessions = new HostSessions(config, { claude: null, codex: null }, workspaces);
  const bots = new HostBots(config, join(root, name, 'config.json'), sessions);
  const server = createHostServer({ config, version: 'test', configPath: join(root, name, 'config.json'), sessions, workspaces, bots, cli: { claude: null, codex: null } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  closers.push(() => { server.closeAllConnections?.(); server.close(); });
  return { name, token, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** A proxy in front of a host that cuts the first connection carrying an
 *  upload once `cutAfter` bytes have gone through — a network drop. */
async function flakyProxy(targetUrl: string, cutAfter: number): Promise<{ url: string; cuts: () => number }> {
  const target = new URL(targetUrl);
  let cuts = 0;
  const server: NetServer = createNetServer((client: Socket) => {
    const upstream = connect(Number(target.port), target.hostname);
    let sent = 0;
    let isUpload = false;
    client.on('data', (chunk: Buffer) => {
      if (!isUpload && chunk.toString('latin1', 0, 4) === 'PUT ') isUpload = true;
      sent += chunk.length;
      if (isUpload && cuts === 0 && sent > cutAfter) {
        cuts += 1;
        client.destroy();
        upstream.destroy();
        return;
      }
      upstream.write(chunk);
    });
    upstream.on('data', (chunk) => client.write(chunk));
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  closers.push(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, cuts: () => cuts };
}

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('moving a file between machines', () => {
  let hostA: Endpoint;
  let hostB: Endpoint;
  let hostBInfo: { url: string; name: string; token: string };
  const here = localEndpoint();
  let big: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'popbot-transfer-'));
    big = join(root, 'here', 'model.bin');
    mkdirSync(join(root, 'here'), { recursive: true });
    writeFileSync(big, randomBytes(48 * 1024 * 1024));
    hostA = hostEndpoint(await startHost('Host A'));
    hostBInfo = await startHost('Host B');
    hostB = hostEndpoint(hostBInfo);
  }, 60_000);
  afterAll(() => {
    for (const c of closers.splice(0)) c();
    rmSync(root, { recursive: true, force: true });
  });

  it('carries a large file this computer → host → host → this computer, unchanged', async () => {
    const want = sha(big);
    const onA = join(root, 'A', 'incoming', 'model.bin');
    const a = await runTransfer({ from: here, fromPath: big, to: hostA, toPath: onA, overwrite: false }, () => undefined);
    expect(a).toMatchObject({ path: onA, size: 48 * 1024 * 1024, sha256: want });
    const onB = join(root, 'B', 'model.bin');
    const b = await runTransfer({ from: hostA, fromPath: onA, to: hostB, toPath: onB, overwrite: false }, () => undefined);
    expect(b.sha256).toBe(want);
    const back = join(root, 'here', 'back', 'model.bin');
    await runTransfer({ from: hostB, fromPath: onB, to: here, toPath: back, overwrite: false }, () => undefined);
    expect(sha(back)).toBe(want);
    expect(existsSync(`${back}.popbot-part`)).toBe(false);
  }, 120_000);

  it('resumes after the connection drops, rather than starting over', async () => {
    const proxy = await flakyProxy(hostBInfo.url, 16 * 1024 * 1024);
    const viaProxy = hostEndpoint({ ...hostBInfo, url: proxy.url });
    const seen: TransferProgress[] = [];
    const dest = join(root, 'B', 'resumed.bin');
    const landed = await runTransfer({ from: here, fromPath: big, to: viaProxy, toPath: dest, overwrite: false }, (p) => seen.push(p));
    expect(proxy.cuts()).toBe(1);
    expect(landed.sha256).toBe(sha(big));
    const retries = seen.filter((p) => p.attempt === 2 && p.phase === 'sending');
    expect(retries.length).toBeGreaterThan(0);
    // It picked up where it stopped: the second attempt began past zero.
    expect(retries[0].done).toBeGreaterThan(0);
  }, 120_000);

  it('lands in a directory under the file’s own name, and will not overwrite unless asked', async () => {
    const dir = join(root, 'A', 'drop');
    mkdirSync(dir, { recursive: true });
    const first = await runTransfer({ from: here, fromPath: big, to: hostA, toPath: dir, overwrite: false }, () => undefined);
    expect(first.path).toBe(join(dir, 'model.bin'));
    await expect(runTransfer({ from: here, fromPath: big, to: hostA, toPath: dir, overwrite: false }, () => undefined)).rejects.toThrow(/already exists/);
    await expect(runTransfer({ from: here, fromPath: big, to: hostA, toPath: dir, overwrite: true }, () => undefined)).resolves.toMatchObject({ path: join(dir, 'model.bin') });
  }, 120_000);

  it('discards a file that arrived damaged instead of giving it the name', async () => {
    const small = join(root, 'here', 'small.txt');
    writeFileSync(small, 'the right bytes\n');
    const dest = join(root, 'A', 'damaged.txt');
    // Something else of the same length is already waiting as the part.
    writeFileSync(`${dest}.popbot-part`, 'the wrong bytes\n');
    await expect(runTransfer({ from: here, fromPath: small, to: hostA, toPath: dest, overwrite: false }, () => undefined)).rejects.toThrow(/damaged/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.popbot-part`)).toBe(false);
    // Sent again from scratch, it lands.
    await runTransfer({ from: here, fromPath: small, to: hostA, toPath: dest, overwrite: false }, () => undefined);
    expect(readFileSync(dest, 'utf8')).toBe('the right bytes\n');
  });

  it('says so when the source is not there', async () => {
    await expect(runTransfer({ from: hostA, fromPath: join(root, 'nope.bin'), to: here, toPath: join(root, 'x.bin'), overwrite: false }, () => undefined))
      .rejects.toThrow(/Host A has no/);
  });
});
