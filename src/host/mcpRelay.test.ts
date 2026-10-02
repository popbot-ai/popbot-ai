import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { HostFrame } from '@shared/hostProtocol';
import { startPopbotMcpServer, type ChatSummary, type PopbotMcpServer, type PopbotToolHandlers } from '../main/mcp/server';
import type { SpawnOpts } from '../main/agents/types';
import type { HostConfig } from './config';
import { startMcpRelay, type McpRelayServer } from './mcpRelay';
import { HostSessions } from './sessions';
import type { HostWorkspaces } from './workspaces';

// The agent backend is a fake that records what it was spawned with.
const spawned: SpawnOpts[] = [];
vi.mock('../main/agents/ClaudeBackend', () => ({
  ClaudeBackend: {
    spawn: (opts: SpawnOpts) => {
      spawned.push(opts);
      return { isAlive: () => true, dispose: async () => undefined, sendUser: async () => undefined, approve: () => undefined, stop: () => undefined };
    },
  },
}));
vi.mock('../main/agents/CodexBackend', () => ({ CodexBackend: { spawn: () => { throw new Error('not used'); } } }));

const chat = (id: string, caller: string | null): ChatSummary => ({
  id, name: id, status: 'idle', agent: 'claude', repoId: 'app', branch: null, ticket: null, pr: null,
  cloud: false, host: null, closed: false, lastActiveAt: 1, isCaller: id === caller,
});
const callers: Array<string | null> = [];
const handlers = {
  listChats: (_input: unknown, caller: string | null) => { callers.push(caller); return [chat('chat_a', caller), chat('chat_b', caller)]; },
} as unknown as PopbotToolHandlers;

const workspaces = {
  ensure: async () => ({ cwd: '/tmp/host', kind: 'scratch' as const, slotId: null, branch: null }),
} as unknown as HostWorkspaces;

describe('popbot MCP relay from a host to the desktop', () => {
  let popbot: PopbotMcpServer;
  let relay: McpRelayServer;
  let sessions: HostSessions;
  let desktopAway = false;

  /** The desktop's half (RemoteBackend.onMcpRequest): run the call on
   *  the local popbot server as the chat it streams, and answer. */
  const desktop = (chatId: string) => async (frame: HostFrame): Promise<void> => {
    if (frame.kind !== 'mcp-request' || desktopAway) return;
    const res = await fetch(popbot.urlFor(chatId), { method: 'POST', headers: frame.request.headers, body: frame.request.body });
    sessions.answerMcp(chatId, { id: frame.id, status: res.status, contentType: res.headers.get('content-type'), body: await res.text() });
  };

  beforeAll(async () => {
    popbot = await startPopbotMcpServer(handlers, { version: 'test' });
    sessions = new HostSessions({ workspacesDir: '/tmp/host' } as HostConfig, { claude: null, codex: null }, workspaces);
    relay = await startMcpRelay((chatId, request, signal) => sessions.relayMcp(chatId, request, signal));
    sessions.useMcpRelay(relay.urlFor);
    await sessions.spawn('chat_a', { agent: 'claude', rules: { chat: [], global: [] }, popbotMcp: true });
    sessions.subscribe('chat_a', 0, (f) => void desktop('chat_a')(f));
  });
  afterAll(async () => {
    await relay.close();
    await popbot.close();
  });

  async function connect(chatId: string): Promise<Client> {
    const client = new Client({ name: 'host-agent', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(relay.urlFor(chatId))));
    return client;
  }

  it('points the agent at the relay only when the desktop asks for the tools', async () => {
    expect(spawned.at(-1)?.mcpServers).toEqual({ popbot: { type: 'http', url: relay.urlFor('chat_a') } });
    await sessions.spawn('chat_plain', { agent: 'claude', rules: { chat: [], global: [] } });
    expect(spawned.at(-1)?.mcpServers).toBeUndefined();
  });

  it('lists and calls the desktop tools as the streaming chat', async () => {
    const client = await connect('chat_a');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('send_to_chat');
    const res = await client.callTool({ name: 'list_chats', arguments: {} });
    const body = JSON.parse((res.content as Array<{ text: string }>)[0].text) as ChatSummary[];
    expect(body.find((c) => c.isCaller)?.id).toBe('chat_a');
    expect(callers.at(-1)).toBe('chat_a');
    await client.close();
  });

  it('leaves answered calls out of a replay', () => {
    const replayed: HostFrame[] = [];
    const off = sessions.subscribe('chat_a', 0, (f) => replayed.push(f));
    off();
    expect(replayed.some((f) => f.kind === 'spawned')).toBe(true);
    expect(replayed.filter((f) => f.kind === 'mcp-request')).toEqual([]);
  });

  it('holds a call until a desktop that was away reattaches', async () => {
    const client = await connect('chat_a');
    desktopAway = true;
    const call = client.callTool({ name: 'list_chats', arguments: {} });
    await vi.waitFor(() => {
      const pending: HostFrame[] = [];
      sessions.subscribe('chat_a', 0, (f) => pending.push(f))();
      expect(pending.some((f) => f.kind === 'mcp-request')).toBe(true);
    });
    desktopAway = false;
    // The reattaching desktop replays the log and answers what waits.
    const off = sessions.subscribe('chat_a', 0, (f) => void desktop('chat_a')(f));
    const res = await call;
    off();
    expect(JSON.parse((res.content as Array<{ text: string }>)[0].text)).toHaveLength(2);
    await client.close();
  });

  it('refuses a request without the secret', async () => {
    const wrong = relay.urlFor('chat_a').replace(/\/mcp\/[^/]+\//, '/mcp/nope/');
    expect((await fetch(wrong, { method: 'POST', body: '{}' })).status).toBe(404);
  });
});
