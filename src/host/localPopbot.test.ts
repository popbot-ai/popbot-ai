import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { botChatId, type HostFrame, type HostSpawnBody } from '@shared/hostProtocol';
import type { SpawnOpts } from '../main/agents/types';
import { startPopbotMcpServer, type PopbotMcpServer } from '../main/mcp/server';
import { HostBots } from './bots';
import { defaultConfig, type HostConfig } from './config';
import { localPopbotHandlers, popbotRoute } from './localPopbot';
import { startMcpRelay, type McpRelayServer } from './mcpRelay';
import { HostSessions } from './sessions';
import { HostWorkspaces } from './workspaces';

// The agent is a fake: every message it is sent gets a one-message turn
// answering "echo: <the message's last line>".
const sent = new Map<string, string[]>();
vi.mock('../main/agents/ClaudeBackend', () => ({
  ClaudeBackend: {
    spawn: (opts: SpawnOpts) => {
      let n = 0;
      return {
        isAlive: () => true,
        dispose: async () => undefined,
        approve: () => undefined,
        stop: () => undefined,
        sendUser: async (text: string) => {
          sent.set(opts.chatId, [...(sent.get(opts.chatId) ?? []), text]);
          const id = `m${(n += 1)}`;
          const chatId = opts.chatId;
          const ts = Date.now();
          setTimeout(() => {
            opts.onEvent({ type: 'turn-start', chatId, ts });
            opts.onEvent({ type: 'message-start', chatId, messageId: id, role: 'agent', ts });
            opts.onEvent({ type: 'text-delta', chatId, messageId: id, delta: `echo: ${text.trim().split('\n').pop()}`, ts });
            opts.onEvent({ type: 'message-end', chatId, messageId: id, ts });
            opts.onEvent({ type: 'session-status', chatId, status: 'idle', ts });
          }, 10);
        },
      };
    },
  },
}));
vi.mock('../main/agents/CodexBackend', () => ({ CodexBackend: { spawn: () => { throw new Error('not used'); } } }));

const spawnBody = (chatName: string): HostSpawnBody => ({ agent: 'claude', rules: { chat: [], global: [] }, popbotMcp: true, chatName });

describe("a host's chats with no desktop connected", () => {
  let dir: string;
  let config: HostConfig;
  let sessions: HostSessions;
  let bots: HostBots;
  let local: PopbotMcpServer;
  let relay: McpRelayServer;

  function start(): HostSessions {
    const workspaces = new HostWorkspaces(config);
    const s = new HostSessions(config, { claude: null, codex: null }, workspaces);
    bots = new HostBots(config, join(dir, 'config.json'), s);
    s.useBots(bots);
    return s;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'popbot-local-tools-'));
    config = { ...defaultConfig(), name: 'winbox', workspacesDir: join(dir, 'workspaces') };
    sessions = start();
    local = await startPopbotMcpServer(localPopbotHandlers({
      hostName: config.name, version: 'test', cli: { claude: null, codex: null }, repos: () => [],
      sessions, workspaces: new HostWorkspaces(config), bots,
    }), { version: 'test' });
    relay = await startMcpRelay(popbotRoute(sessions, local.urlFor));
    sessions.useMcpRelay(relay.urlFor);
    await sessions.spawn('chat_alpha', spawnBody('Alpha'));
    await sessions.spawn('chat_beta', spawnBody('Beta'));
  });
  afterAll(async () => {
    bots.stop();
    await relay.close();
    await local.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function call(chatId: string, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const client = new Client({ name: 'agent', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(relay.urlFor(chatId))));
    try {
      const res = await client.callTool({ name: tool, arguments: args });
      const content = res.content as Array<{ type: string; text: string }>;
      return { text: content.map((c) => c.text).join('\n'), isError: res.isError === true };
    } finally {
      await client.close();
    }
  }

  it('lists the chats on the host, by the names the desktop gave them', async () => {
    const res = await call('chat_alpha', 'list_chats', {});
    const chats = JSON.parse(res.text) as Array<{ id: string; name: string; host: string; isCaller: boolean }>;
    expect(chats.map((c) => c.name).sort()).toEqual(['Alpha', 'Beta']);
    expect(chats.find((c) => c.id === 'chat_alpha')).toMatchObject({ isCaller: true, host: 'winbox' });
  });

  it('delivers a message to another chat and returns its answer', async () => {
    const res = await call('chat_alpha', 'send_to_chat', { chatId: 'chat_beta', text: 'what is the build status?' });
    expect(JSON.parse(res.text)).toMatchObject({ outcome: 'replied', reply: 'echo: what is the build status?' });
    // Logged as from Alpha, for the desktop to record when it is back.
    const prompt = sessions.get('chat_beta')!.frames.find((f): f is Extract<HostFrame, { kind: 'prompt' }> => f.kind === 'prompt');
    expect(prompt).toMatchObject({ text: 'what is the build status?', from: { id: 'chat_alpha', name: 'Alpha', waiting: true } });
    // The agent is told who it is from.
    expect(sent.get('chat_beta')!.at(-1)).toContain('PopBot chat "Alpha" (chat id chat_alpha)');
  });

  it('finds a chat by its name too', async () => {
    const res = await call('chat_beta', 'send_to_chat', { chatId: 'Alpha', text: 'thanks', waitForReply: false });
    expect(JSON.parse(res.text)).toMatchObject({ outcome: 'sent' });
  });

  it('says what needs the desktop', async () => {
    const res = await call('chat_alpha', 'start_code_review', { prNumber: 12 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/needs PopBot's desktop.*chat tools/);
  });

  it('does not wake a chat the desktop closed', async () => {
    sessions.setMeta('chat_beta', { open: false });
    const res = await call('chat_alpha', 'send_to_chat', { chatId: 'chat_beta', text: 'hello?' });
    expect(res.text).toMatch(/closed/);
    sessions.setMeta('chat_beta', { open: true, name: 'Beta (renamed)' });
    const list = JSON.parse((await call('chat_alpha', 'list_chats', {})).text) as Array<{ name: string }>;
    expect(list.map((c) => c.name)).toContain('Beta (renamed)');
  });

  it('lets a chat message a bot, and the bot answer it by the reply id', async () => {
    bots.save(null, { name: 'Helper', prompt: 'Help.', triggers: [] });
    const waited = await call('chat_alpha', 'message_bot', { bot: 'Helper', text: 'review #12', waitForReply: true });
    expect(JSON.parse(waited.text)).toMatchObject({ outcome: 'replied', reply: 'echo: review #12' });

    await call('chat_alpha', 'message_bot', { bot: 'helper', text: 'and #13 when you can' });
    const told = sent.get(botChatId('helper'))!.at(-1)!;
    const replyId = /replyId "(r_[a-f0-9]+)"/.exec(told)![1];
    expect(await bots.replyToChat('helper', replyId, '#13 looks good')).toEqual({ ok: true });
    const last = sessions.get('chat_alpha')!.frames.filter((f) => f.kind === 'prompt').at(-1);
    expect(last).toMatchObject({ text: '#13 looks good', from: { id: botChatId('helper'), name: 'Helper' } });
    // Once only.
    expect(await bots.replyToChat('helper', replyId, 'again')).toMatchObject({ error: expect.any(String) });
  });

  it('sends the call to the desktop instead while one is reading the chat', async () => {
    const frames: HostFrame[] = [];
    const off = sessions.subscribe('chat_alpha', sessions.get('chat_alpha')!.seq, (f) => frames.push(f));
    const route = popbotRoute(sessions, local.urlFor);
    const answer = route('chat_alpha', { method: 'POST', headers: {}, body: '{}' }, new AbortController().signal);
    await vi.waitFor(() => expect(frames.some((f) => f.kind === 'mcp-request')).toBe(true));
    const req = frames.find((f): f is Extract<HostFrame, { kind: 'mcp-request' }> => f.kind === 'mcp-request')!;
    sessions.answerMcp('chat_alpha', { id: req.id, status: 200, contentType: 'application/json', body: '"from the desktop"' });
    expect(await answer).toMatchObject({ status: 200, body: '"from the desktop"' });
    off();
    expect(sessions.desktopAttached('chat_alpha')).toBe(false);
  });

  it('reads a chat as the host has it — both sides, without the desktop\'s preamble', async () => {
    await sessions.send('chat_beta', { text: '[System] Starting up on the host "winbox".\n\nhello from the desktop' });
    await vi.waitFor(() => expect(sessions.isBusy('chat_beta')).toBe(false));
    const res = await call('chat_alpha', 'get_chat_transcript', { chatId: 'Beta (renamed)' });
    const out = JSON.parse(res.text) as { chatId: string; text: string };
    expect(out.chatId).toBe('chat_beta');
    expect(out.text).toContain('(from Alpha) what is the build status?');
    expect(out.text).toContain('echo: what is the build status?');
    expect(out.text).toContain('user @');
    expect(out.text).toContain('hello from the desktop');
    expect(out.text).not.toContain('[System]');
  });

  it('searches the chats on the host', async () => {
    const res = await call('chat_alpha', 'search_chats', { query: 'build status', allChats: true });
    const { matches } = JSON.parse(res.text) as { matches: Array<{ chatId: string; match: string }> };
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((m) => m.chatId === 'chat_beta' && m.match === 'build status')).toBe(true);
    const words = JSON.parse((await call('chat_alpha', 'search_chats', { query: 'status build', allChats: true, mode: 'fts' })).text) as { matches: unknown[] };
    expect(words.matches.length).toBeGreaterThan(0);
  });

  it('makes a chat on the host, for the desktop to adopt, and sends it a first message', async () => {
    const res = await call('chat_alpha', 'create_chat', { name: 'Gamma', firstMessage: 'start on the docs' });
    const { chat } = JSON.parse(res.text) as { chat: { id: string; name: string; host: string } };
    expect(chat).toMatchObject({ name: 'Gamma', host: 'winbox' });
    await vi.waitFor(() => expect(sent.get(chat.id)?.at(-1)).toContain('start on the docs'));
    expect(sessions.rosterInfo().find((r) => r.chatId === chat.id)).toMatchObject({ createdByHost: true, open: true, changedBy: 'host', kind: 'scratch' });
  });

  it('closes and reopens a chat on the host, and says so to the desktop', async () => {
    expect(JSON.parse((await call('chat_beta', 'close_chat', { chatId: 'chat_alpha' })).text)).toMatchObject({ ok: true });
    expect(sessions.get('chat_alpha')).toBeUndefined();
    expect(sessions.rosterInfo().find((r) => r.chatId === 'chat_alpha')).toMatchObject({ open: false, changedBy: 'host' });
    const reopened = JSON.parse((await call('chat_beta', 'reopen_chat', { chatId: 'chat_alpha' })).text) as { chat: { closed: boolean } };
    expect(reopened.chat.closed).toBe(false);
    // The desktop settles it: the state is its own again.
    sessions.setMeta('chat_alpha', { open: true });
    expect(sessions.rosterInfo().find((r) => r.chatId === 'chat_alpha')).toMatchObject({ open: true, changedBy: 'desktop' });
    await sessions.wake('chat_alpha');
  });

  it('asks a desktop it has heard from first, and answers itself when none picks the call up', async () => {
    const route = popbotRoute(sessions, local.urlFor, { waitMs: 150 });
    const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_chats', arguments: {} } };
    sessions.noteDesktop();
    const before = sessions.get('chat_alpha')!.seq;
    const started = Date.now();
    const answer = await route('chat_alpha', { method: 'POST', headers, body: JSON.stringify(call) }, new AbortController().signal);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(answer.status).toBe(200);
    expect(answer.body).toContain('Alpha');
    // It was offered to the desktop first, in the chat's log.
    expect(sessions.get('chat_alpha')!.frames.some((f) => f.seq > before && f.kind === 'mcp-request')).toBe(true);
    // The protocol's own requests never wait.
    const init = { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    const quick = Date.now();
    const initAnswer = await route('chat_alpha', { method: 'POST', headers, body: JSON.stringify(init) }, new AbortController().signal);
    expect(initAnswer.status).toBe(200);
    expect(Date.now() - quick).toBeLessThan(140);
  });

  it('remembers its chats across a restart, and wakes one to deliver a message', async () => {
    const before = sessions.get('chat_beta')!.seq;
    const restarted = start();
    const handlers = localPopbotHandlers({
      hostName: config.name, version: 'test', cli: { claude: null, codex: null }, repos: () => [],
      sessions: restarted, workspaces: new HostWorkspaces(config), bots,
    });
    expect(restarted.get('chat_beta')).toBeUndefined();
    const res = await handlers.sendToChat({ chatId: 'chat_beta', text: 'still there?', waitForReply: true, timeoutSeconds: 10 }, 'chat_alpha');
    expect(res).toMatchObject({ outcome: 'replied', reply: 'echo: still there?' });
    // Its log went on from where it was, so a desktop reading by seq misses nothing.
    const frames = restarted.get('chat_beta')!.frames;
    expect(frames[0].seq).toBe(1);
    expect(restarted.get('chat_beta')!.seq).toBeGreaterThan(before);
  });
});
