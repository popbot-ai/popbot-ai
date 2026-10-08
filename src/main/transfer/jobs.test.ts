import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Every machine in this test shares one disk; its home is a scratch folder,
// so nothing lands in the real ~/popbot.
const home = mkdtempSync(join(tmpdir(), 'popbot-offers-'));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => home }));
vi.mock('../agents/ClaudeBackend', () => ({ ClaudeBackend: { spawn: () => { throw new Error('not used'); } } }));
vi.mock('../agents/CodexBackend', () => ({ CodexBackend: { spawn: () => { throw new Error('not used'); } } }));
vi.mock('../diagLog', () => ({ dlog: () => undefined }));
const hosts: Array<{ id: string; name: string; url: string; token: string; createdAt: number; updatedAt: number }> = [];
vi.mock('../persistence/hosts', () => ({ listHosts: () => hosts }));

const { HostBots } = await import('../../host/bots');
const { defaultConfig } = await import('../../host/config');
const { createHostServer } = await import('../../host/server');
const { HostSessions } = await import('../../host/sessions');
const { HostWorkspaces } = await import('../../host/workspaces');
const jobs = await import('./jobs');

const closers: Array<() => void> = [];

async function startHost(name: string): Promise<void> {
  const config = { ...defaultConfig(), token: 't', name, workspacesDir: join(home, name, 'ws') };
  const workspaces = new HostWorkspaces(config);
  const sessions = new HostSessions(config, { claude: null, codex: null }, workspaces);
  const bots = new HostBots(config, join(home, name, 'config.json'), sessions);
  const server = createHostServer({ config, version: 'test', configPath: join(home, name, 'config.json'), sessions, workspaces, bots, cli: { claude: null, codex: null } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  closers.push(() => { server.closeAllConnections?.(); server.close(); });
  hosts.push({ id: name.toLowerCase().replace(/\s/g, '-'), name, token: 't', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, createdAt: 0, updatedAt: 0 });
}

describe('a file offered from one chat to another', () => {
  const file = join(home, 'report.pdf');
  beforeAll(async () => {
    writeFileSync(file, 'the report\n');
    await startHost('Host A');
    await startHost('Host B');
  });
  afterAll(() => {
    for (const c of closers.splice(0)) c();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('moves nothing until the receiving chat accepts — and only it may', async () => {
    const offer = await jobs.offerFileTransfer({ from: 'this computer', fromPath: file, to: 'Host B', fromChatId: 'chat_sender', toChatId: 'chat_receiver' }, () => undefined);
    expect(offer).toMatchObject({ phase: 'offered', to: 'Host B', destPath: null, size: 11 });
    await expect(jobs.acceptFileTransfer(offer.id, 'chat_someone_else')).rejects.toThrow(/offered to another chat/);
    await jobs.acceptFileTransfer(offer.id, 'chat_receiver');
    const done = await jobs.whenFinished(offer.id);
    expect(done).toMatchObject({ phase: 'done', destPath: join(home, 'popbot', 'sent_files', 'report.pdf') });
    expect(readFileSync(done!.destPath!, 'utf8')).toBe('the report\n');
    await expect(jobs.acceptFileTransfer(offer.id, 'chat_receiver')).rejects.toThrow(/not waiting/);
  });

  it('lands next to, never over, a file of the same name', async () => {
    const offer = await jobs.offerFileTransfer({ from: 'Host A', fromPath: file, to: 'this computer', fromChatId: 'chat_sender', toChatId: 'chat_receiver' }, () => undefined);
    await jobs.acceptFileTransfer(offer.id, 'chat_receiver');
    const done = await jobs.whenFinished(offer.id);
    // The first one is still there (all machines share this test's disk).
    expect(done?.destPath).toBe(join(home, 'popbot', 'sent_files', 'report (2).pdf'));
  });

  it('can be declined, or withdrawn, and then cannot be accepted', async () => {
    const declined = await jobs.offerFileTransfer({ from: 'this computer', fromPath: file, to: 'Host A', fromChatId: 'chat_sender', toChatId: 'chat_receiver' }, () => undefined);
    expect(jobs.declineFileTransfer(declined.id, 'chat_receiver').phase).toBe('declined');
    await expect(jobs.acceptFileTransfer(declined.id, 'chat_receiver')).rejects.toThrow(/declined/);
    const withdrawn = await jobs.offerFileTransfer({ from: 'this computer', fromPath: file, to: 'Host A', fromChatId: 'chat_sender', toChatId: 'chat_receiver' }, () => undefined);
    expect(() => jobs.cancelFileTransfer(withdrawn.id, 'chat_bystander')).toThrow(/either end/);
    expect(jobs.cancelFileTransfer(withdrawn.id, 'chat_sender').phase).toBe('cancelled');
  });

  it('refuses what cannot work: the same machine, a missing file, an unknown machine', async () => {
    await expect(jobs.offerFileTransfer({ from: 'Host A', fromPath: file, to: 'Host A', fromChatId: 'a', toChatId: 'b' }, () => undefined)).rejects.toThrow(/already is/);
    await expect(jobs.offerFileTransfer({ from: 'this computer', fromPath: join(home, 'nope.bin'), to: 'Host A', fromChatId: 'a', toChatId: 'b' }, () => undefined)).rejects.toThrow(/has no/);
    await expect(jobs.offerFileTransfer({ from: 'this computer', fromPath: file, to: 'Mars', fromChatId: 'a', toChatId: 'b' }, () => undefined)).rejects.toThrow(/no machine "Mars"/);
  });
});
