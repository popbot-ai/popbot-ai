import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startPopbotMcpServer, type ChatSummary, type PopbotMcpServer, type PopbotToolHandlers } from './server';

const chat = (id: string, name: string, caller: string | null): ChatSummary => ({
  id, name, status: 'idle', agent: 'claude', repoId: 'app', branch: null, ticket: null, pr: null,
  cloud: false, host: null, closed: false, lastActiveAt: 1, isCaller: id === caller,
});

const calls: Array<{ tool: string; input: unknown; caller: string | null }> = [];
const handlers: PopbotToolHandlers = {
  listChats: (input, caller) => { calls.push({ tool: 'list_chats', input, caller }); return [chat('chat_a', 'A', caller), chat('chat_b', 'B', caller)]; },
  listHosts: async () => [{ id: 'host_1', name: 'benscomfypc', openChats: 1, reachable: true, version: '0.2.0', claude: true, codex: true, repos: [{ id: 'popbot', defaultBase: 'main', mode: 'slots', slotCount: 4 }] }],
  createChat: async (input, caller) => { calls.push({ tool: 'create_chat', input, caller }); return { chat: { ...chat('chat_new', input.name, caller), host: input.host ?? null } }; },
  closeChat: async (input, caller) => (input.chatId === caller ? { error: 'you cannot close the chat you are running in' } : { ok: true, chatId: input.chatId }),
  reopenChat: async (input, caller) => ({ chat: chat(input.chatId, 'R', caller) }),
  sendToChat: async (input) => ({ outcome: 'replied', reply: `echo: ${input.text}`, entries: 1 }),
  startCodeReview: async (input, caller) => ({ chat: chat('chat_cr', `[CR] PR #${input.prNumber}`, caller), existing: false }),
  openTicketChat: async (input, caller) => ({ chat: chat('chat_t', input.ticket, caller), existing: true }),
  getTranscript: (input, caller) => ({ chatId: input.chatId ?? caller ?? '?', text: '#0 user @ t\nhi\n', count: 1, total: 1, truncated: false }),
  searchTranscripts: () => ({ matches: [] }),
  listRefs: () => ({ tickets: [], prs: [], chats: [] }),
  goToMessage: (input) => (input.messageId ? { ok: true } : { error: 'no message' }),
  listBots: async () => [{
    id: 'webreviewer', name: 'Web Reviewer', host: 'winbox', hostReachable: true, chatId: 'chat_bot_webreviewer', state: 'idle',
    githubLogin: 'webreviewer-bot', triggers: [{ github: 'Comfy-Org/website', labels: ['website-review'] }], watching: [], lastError: null,
  }],
  messageBot: async (input, caller) => { calls.push({ tool: 'message_bot', input, caller }); return { outcome: 'sent', reply: '', entries: 0, chatId: 'chat_bot_webreviewer' }; },
  transferFile: async (input, caller) => { calls.push({ tool: 'transfer_file', input, caller }); return transfer('offered'); },
  acceptFileTransfer: async () => transfer('done'),
  declineFileTransfer: async () => transfer('declined'),
  getFileTransfer: async () => transfer('sending'),
  cancelFileTransfer: async () => transfer('cancelled'),
};

function transfer(state: 'offered' | 'done' | 'declined' | 'sending' | 'cancelled') {
  return {
    transferId: 'xfer_1', from: 'this computer', fromPath: '/tmp/model.bin', to: 'Bens PC', fromChat: 'A', toChat: 'B',
    destPath: state === 'done' ? 'C:\\Users\\b\\popbot\\sent_files\\model.bin' : null, state, bytes: 0, size: 10, percent: 0, attempt: 1,
    sha256: null, error: null,
  };
}

describe('popbot MCP server over Streamable HTTP', () => {
  let server: PopbotMcpServer;
  beforeAll(async () => { server = await startPopbotMcpServer(handlers, { version: 'test' }); });
  afterAll(async () => { await server.close(); });

  async function connect(chatId: string): Promise<Client> {
    const client = new Client({ name: 'test-client', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.urlFor(chatId))));
    return client;
  }

  it('lists the tools with their schemas', async () => {
    const client = await connect('chat_a');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'accept_file_transfer', 'cancel_file_transfer', 'close_chat', 'create_chat', 'decline_file_transfer',
      'get_chat_transcript', 'get_file_transfer', 'go_to_message', 'list_bots', 'list_chats', 'list_hosts', 'list_refs',
      'message_bot', 'open_ticket_chat', 'reopen_chat', 'search_chats', 'send_to_chat', 'start_code_review', 'transfer_file',
    ]);
    // A file is offered to a chat: transfer_file has no destination of its own.
    const offer = tools.find((t) => t.name === 'transfer_file')!;
    expect(Object.keys((offer.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(['from', 'message', 'path', 'toChat']);
    // Codex runs only tools marked non-destructive under its `never` policy.
    for (const name of ['transfer_file', 'accept_file_transfer', 'decline_file_transfer', 'cancel_file_transfer']) {
      expect(tools.find((t) => t.name === name)?.annotations?.destructiveHint).toBe(false);
    }
    // Chats see bots and talk to them; making, pausing and killing them is a person's.
    expect(tools.map((t) => t.name).filter((n) => /bot/.test(n)).sort()).toEqual(['list_bots', 'message_bot']);
    const send = tools.find((t) => t.name === 'send_to_chat')!;
    expect(JSON.stringify(send.inputSchema)).toContain('"waitForReply"');
    await client.close();
  });

  it('binds the calling chat from the URL and applies schema defaults', async () => {
    const client = await connect('chat_a');
    const res = await client.callTool({ name: 'list_chats', arguments: {} });
    const body = JSON.parse((res.content as Array<{ text: string }>)[0].text) as ChatSummary[];
    expect(body.find((c) => c.id === 'chat_a')?.isCaller).toBe(true);
    expect(calls.at(-1)).toMatchObject({ tool: 'list_chats', input: { includeClosed: false }, caller: 'chat_a' });

    const created = await client.callTool({ name: 'create_chat', arguments: { name: 'New' } });
    expect(JSON.parse((created.content as Array<{ text: string }>)[0].text)).toMatchObject({ chat: { id: 'chat_new', name: 'New' } });
    expect(calls.at(-1)).toMatchObject({ input: { name: 'New', workspace: 'repo-root' } });
    await client.close();
  });

  it('lists hosts, filters chats by host, and creates a chat on one', async () => {
    const client = await connect('chat_a');
    const hosts = await client.callTool({ name: 'list_hosts', arguments: {} });
    expect(JSON.parse((hosts.content as Array<{ text: string }>)[0].text)).toMatchObject([{ name: 'benscomfypc', reachable: true, repos: [{ id: 'popbot' }] }]);

    await client.callTool({ name: 'list_chats', arguments: { host: 'benscomfypc' } });
    expect(calls.at(-1)).toMatchObject({ tool: 'list_chats', input: { includeClosed: false, host: 'benscomfypc' } });

    const created = await client.callTool({ name: 'create_chat', arguments: { name: 'Remote', host: 'benscomfypc', repoId: 'popbot', workspace: 'slot' } });
    expect(JSON.parse((created.content as Array<{ text: string }>)[0].text)).toMatchObject({ chat: { name: 'Remote', host: 'benscomfypc' } });
    expect(calls.at(-1)).toMatchObject({ input: { host: 'benscomfypc', repoId: 'popbot', workspace: 'slot' } });
    await client.close();
  });

  it('reports a handler failure as a tool error, not a protocol error', async () => {
    const client = await connect('chat_a');
    const res = await client.callTool({ name: 'close_chat', arguments: { chatId: 'chat_a' } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain('cannot close');
    await client.close();
  });

  it('rejects a wrong secret', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp/nope/chat_a`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });
});
