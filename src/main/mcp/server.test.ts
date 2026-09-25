import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startPopbotMcpServer, type ChatSummary, type PopbotMcpServer, type PopbotToolHandlers } from './server';

const chat = (id: string, name: string, caller: string | null): ChatSummary => ({
  id, name, status: 'idle', agent: 'claude', repoId: 'app', branch: null, ticket: null, pr: null,
  cloud: false, closed: false, lastActiveAt: 1, isCaller: id === caller,
});

const calls: Array<{ tool: string; input: unknown; caller: string | null }> = [];
const handlers: PopbotToolHandlers = {
  listChats: (input, caller) => { calls.push({ tool: 'list_chats', input, caller }); return [chat('chat_a', 'A', caller), chat('chat_b', 'B', caller)]; },
  createChat: async (input, caller) => { calls.push({ tool: 'create_chat', input, caller }); return { chat: chat('chat_new', input.name, caller) }; },
  closeChat: async (input, caller) => (input.chatId === caller ? { error: 'you cannot close the chat you are running in' } : { ok: true, chatId: input.chatId }),
  reopenChat: async (input, caller) => ({ chat: chat(input.chatId, 'R', caller) }),
  sendToChat: async (input) => ({ outcome: 'replied', reply: `echo: ${input.text}`, entries: 1 }),
  startCodeReview: async (input, caller) => ({ chat: chat('chat_cr', `[CR] PR #${input.prNumber}`, caller), existing: false }),
  openTicketChat: async (input, caller) => ({ chat: chat('chat_t', input.ticket, caller), existing: true }),
  getTranscript: (input, caller) => ({ chatId: input.chatId ?? caller ?? '?', text: '#0 user @ t\nhi\n', count: 1, total: 1, truncated: false }),
  searchTranscripts: () => ({ matches: [] }),
  listRefs: () => ({ tickets: [], prs: [], chats: [] }),
  goToMessage: (input) => (input.messageId ? { ok: true } : { error: 'no message' }),
};

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
      'close_chat', 'create_chat', 'get_chat_transcript', 'go_to_message', 'list_chats', 'list_refs',
      'open_ticket_chat', 'reopen_chat', 'search_chats', 'send_to_chat', 'start_code_review',
    ]);
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
