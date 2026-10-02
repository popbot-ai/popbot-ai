import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { botChatId, type HostFrame } from '@shared/hostProtocol';
import type { SpawnOpts } from '../main/agents/types';
import { startBotMcp, type BotMcpServer } from './botMcp';
import { HostBots } from './bots';
import { defaultConfig, type HostConfig } from './config';
import { HostSessions } from './sessions';
import type { HostWorkspaces } from './workspaces';

// The agent backend is a fake that records what it was spawned with and
// what it was sent.
const spawned = new Map<string, SpawnOpts>();
const sent = new Map<string, string[]>();
vi.mock('../main/agents/ClaudeBackend', () => ({
  ClaudeBackend: {
    spawn: (opts: SpawnOpts) => {
      spawned.set(opts.chatId, opts);
      return {
        isAlive: () => true,
        dispose: async () => undefined,
        sendUser: async (text: string) => { sent.set(opts.chatId, [...(sent.get(opts.chatId) ?? []), text]); },
        approve: () => undefined,
        stop: () => undefined,
      };
    },
  },
}));
vi.mock('../main/agents/CodexBackend', () => ({ CodexBackend: { spawn: () => { throw new Error('not used'); } } }));

const workspaces = {
  ensure: async () => { throw new Error('a bot never takes a workspace'); },
} as unknown as HostWorkspaces;

describe('bots on a host', () => {
  let dir: string;
  let config: HostConfig;
  let sessions: HostSessions;
  let bots: HostBots;
  let mcp: BotMcpServer;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'popbot-bots-'));
    config = { ...defaultConfig(), name: 'winbox', workspacesDir: join(dir, 'workspaces') };
    sessions = new HostSessions(config, { claude: null, codex: null }, workspaces);
    bots = new HostBots(config, join(dir, 'config.json'), sessions);
    sessions.useBots(bots);
    mcp = await startBotMcp(bots, 'test');
    bots.useMcp(mcp.urlFor);
  });
  afterAll(async () => {
    bots.stop();
    await mcp.close();
  });

  async function connect(botId: string): Promise<Client> {
    const client = new Client({ name: 'bot-agent', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.urlFor(botId))));
    return client;
  }

  it('makes a bot from a name and starts its chat as itself', async () => {
    const info = bots.save(null, { name: 'Web Reviewer', prompt: 'Review pull requests.', githubLogin: 'webreviewer-bot', githubToken: 'tok-review' });
    expect(info.id).toBe('web-reviewer');
    expect(info.chatId).toBe(botChatId('web-reviewer'));
    expect(info.hasToken).toBe(true);
    // Never sent back to a desktop.
    expect(JSON.stringify(info)).not.toContain('tok-review');
    await vi.waitFor(() => expect(spawned.get(info.chatId)).toBeDefined());
    const opts = spawned.get(info.chatId)!;
    expect(opts.env?.GH_TOKEN).toBe('tok-review');
    expect(opts.env?.GH_CONFIG_DIR).toBe(join(config.workspacesDir, 'bots', 'web-reviewer', 'gh'));
    expect(opts.env?.GIT_AUTHOR_EMAIL).toBe('webreviewer-bot@users.noreply.github.com');
    expect(opts.env?.GIT_CONFIG_VALUE_0).toBe('');
    expect(opts.env?.GIT_CONFIG_VALUE_1).toBe('!gh auth git-credential');
    expect(opts.appendSystemPrompt).toContain('Review pull requests.');
    expect(opts.appendSystemPrompt).toContain('@webreviewer-bot');
    // The bots tools, and never the desktop's popbot tools.
    expect(Object.keys(opts.mcpServers ?? {})).toEqual(['bots']);
    // Nobody is there to answer: everything is allowed but asking.
    expect(opts.resolveRule?.('Bash')).toBe('allow');
    expect(opts.resolveRule?.('AskUserQuestion')).toBe('deny');
  });

  it('gives a bot with no token no GitHub identity to borrow', async () => {
    const info = bots.save(null, { name: 'Web Shepherd', prompt: 'Shepherd them.', githubLogin: 'webshepherd-bot' });
    await vi.waitFor(() => expect(spawned.get(info.chatId)).toBeDefined());
    const env = spawned.get(info.chatId)!.env!;
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GH_CONFIG_DIR).toContain(join('bots', 'web-shepherd', 'gh'));
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(info.hasToken).toBe(false);
  });

  it('lets a bot see and message only the bots on its list', async () => {
    const client = await connect('web-reviewer');
    const listed = async (): Promise<string[]> =>
      (JSON.parse(((await client.callTool({ name: 'list_bots', arguments: {} })).content as Array<{ text: string }>)[0].text) as Array<{ id: string }>).map((b) => b.id);
    const say = async (c: Client, to: string, body: string): Promise<string> =>
      ((await c.callTool({ name: 'message_bot', arguments: { to, text: body } })).content as Array<{ text: string }>)[0].text;

    // Not on its list: as far as it can tell, no such bot.
    expect(await listed()).toEqual([]);
    expect(JSON.parse(await say(client, 'web-shepherd', 'hi'))).toEqual({ error: 'no bot "web-shepherd"' });
    expect(JSON.parse(await say(client, 'nobody', 'hi'))).toEqual({ error: 'no bot "nobody"' });

    // On its list, a typo too. Its orders never name the list: list_bots
    // is the only way it learns of a bot.
    const before = spawned.get(botChatId('web-reviewer'));
    bots.save('web-reviewer', { name: 'Web Reviewer', peers: ['web-shepherd', 'web-shepard'] });
    await vi.waitFor(() => expect(spawned.get(botChatId('web-reviewer'))).not.toBe(before));
    expect(spawned.get(botChatId('web-reviewer'))?.appendSystemPrompt).not.toMatch(/web-shep/);
    expect(await listed()).toEqual(['web-shepherd']);
    // By name or id.
    expect(JSON.parse(await say(client, 'Web Shepherd', 'Review is up on #12.'))).toEqual({ ok: true });
    const shepherdChat = botChatId('web-shepherd');
    await vi.waitFor(() => expect(sent.get(shepherdChat)?.at(-1)).toContain('Review is up on #12.'));
    expect(sent.get(shepherdChat)!.at(-1)).toContain('Message from the bot "Web Reviewer"');

    // A desktop shows it as a turn from the reviewer.
    const frames: HostFrame[] = [];
    sessions.subscribe(shepherdChat, 0, (f) => frames.push(f))();
    const prompt = frames.find((f): f is Extract<HostFrame, { kind: 'prompt' }> => f.kind === 'prompt');
    expect(prompt?.from).toEqual({ id: botChatId('web-reviewer'), name: 'Web Reviewer' });

    // The shepherd does not list the reviewer, but it may answer it.
    const shepherd = await connect('web-shepherd');
    expect(JSON.parse(await say(shepherd, 'web-reviewer', 'On it.'))).toEqual({ ok: true });
    expect(JSON.parse(await say(client, 'web-reviewer', 'hi'))).toEqual({ error: 'that is you' });
    await shepherd.close();
    await client.close();

    // An ordinary chat's id gets nothing.
    expect((await fetch(mcp.urlFor('chat_plain'), { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('answers a chat only by the reply id its message carried', async () => {
    const client = await connect('web-reviewer');
    const bad = await client.callTool({ name: 'reply_to_chat', arguments: { replyId: 'chat_abc123', text: 'hello' } });
    expect((bad.content as Array<{ text: string }>)[0].text).toContain('not a reply id');
    const ok = await client.callTool({ name: 'reply_to_chat', arguments: { replyId: 'r_0123456789abcdef', text: 'Done: approved #12.' } });
    expect(JSON.parse((ok.content as Array<{ text: string }>)[0].text)).toEqual({ ok: true });
    // The reply names the id, never a chat: the desktop that issued it delivers.
    const frames: HostFrame[] = [];
    sessions.subscribe(botChatId('web-reviewer'), 0, (f) => frames.push(f))();
    expect(frames.find((f) => f.kind === 'reply')).toMatchObject({ replyId: 'r_0123456789abcdef', text: 'Done: approved #12.' });
    await client.close();
  });

  it("keeps a bot's chat log on disk", () => {
    expect(existsSync(join(config.workspacesDir, 'bots', 'web-shepherd', 'events.jsonl'))).toBe(true);
  });

  it('commits under the email it is given', async () => {
    expect(() => bots.save('web-reviewer', { name: 'Web Reviewer', email: 'not an email' })).toThrow(/not an email address/);
    bots.save('web-reviewer', { name: 'Web Reviewer', email: 'webreviewer@comfy.org' });
    // What its next session gets (a busy one restarts when it is idle).
    expect(bots.spawnFor(botChatId('web-reviewer'))?.env).toMatchObject({
      GIT_AUTHOR_EMAIL: 'webreviewer@comfy.org',
      GIT_COMMITTER_EMAIL: 'webreviewer@comfy.org',
    });
    expect(bots.list().find((b) => b.id === 'web-reviewer')?.email).toBe('webreviewer@comfy.org');
  });

  it('keeps a small picture and refuses anything else', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(bots.save('web-reviewer', { name: 'Web Reviewer', avatar: png }).avatar).toBe(png);
    expect(() => bots.save('web-reviewer', { name: 'Web Reviewer', avatar: 'data:text/html;base64,PGI+' })).toThrow(/picture/);
    expect(() => bots.save('web-reviewer', { name: 'Web Reviewer', avatar: `data:image/png;base64,${'A'.repeat(300 * 1024)}` })).toThrow(/picture/);
    // Left out: kept. Empty: removed.
    expect(bots.save('web-reviewer', { name: 'Web Reviewer' }).avatar).toBe(png);
    expect(bots.save('web-reviewer', { name: 'Web Reviewer', avatar: null }).avatar).toBeNull();
  });

  it('refuses triggers it could not run', () => {
    expect(() => bots.save('web-reviewer', { name: 'Web Reviewer', triggers: [{ id: 't1', kind: 'github', repo: 'o/r', labels: [], team: 'devs', pollSeconds: 30 }] }))
      .toThrow(/at least one label/);
    expect(() => bots.save('web-reviewer', { name: 'Web Reviewer', triggers: [{ id: 't1', kind: 'github', repo: null, labels: ['x'], team: 'devs', pollSeconds: 30 }] }))
      .toThrow(/repository/);
    expect(() => bots.save('web-reviewer', { name: 'Web Reviewer', triggers: [{ id: 't1', kind: 'github', repo: 'o/r', labels: ['x'], team: 'not a team!', pollSeconds: 30 }] }))
      .toThrow(/not a team/);
    // Blank is allowed in the config — it just matches no one.
    expect(bots.save('web-reviewer', { name: 'Web Reviewer', triggers: [{ id: 't1', kind: 'github', repo: 'o/r', labels: ['x'], team: '', pollSeconds: 30 }] }).triggers).toHaveLength(1);
    expect(() => bots.save('web-reviewer', { name: 'Web Reviewer', triggers: [{ id: 't1', kind: 'github', repo: null, labels: ['x'], team: 'devs', pollSeconds: 30 }] }))
      .toThrow(/repository/);
    expect(() => bots.save('web-reviewer', { name: 'Web Reviewer', triggers: [{ id: 't1', kind: 'cron', schedule: '0 9 * *', message: '' }] }))
      .toThrow(/five fields/);
    // A good one is kept, and the stored token survives an edit that leaves it out.
    const ok = bots.save('web-reviewer', { name: 'Web Reviewer', triggers: [{ id: 't1', kind: 'cron', schedule: '0 9 * * 1-5', message: 'Morning sweep.' }] });
    expect(ok.triggers).toHaveLength(1);
    expect(ok.hasToken).toBe(true);
  });

  it('kills a bot: gone from the config, its session and its folder', async () => {
    expect(await bots.kill('web-shepherd')).toBe(true);
    expect(bots.bot('web-shepherd')).toBeNull();
    expect(sessions.get(botChatId('web-shepherd'))).toBeUndefined();
    expect(existsSync(join(config.workspacesDir, 'bots', 'web-shepherd'))).toBe(false);
    expect(config.bots.map((b) => b.id)).toEqual(['web-reviewer']);
    // Its name stays on the reviewer's list — set with its config — but a
    // bot that is not running does not exist for it.
    expect(bots.bot('web-reviewer')?.peers).toEqual(['web-shepherd', 'web-shepard']);
    expect(bots.peersOf('web-reviewer')).toEqual([]);
    expect(await bots.message('web-reviewer', 'web-shepherd', 'hi')).toEqual({ error: 'no bot "web-shepherd"' });
  });
});
