/**
 * The bots MCP server: how a host's bots find and message each other.
 * Bots only — no ordinary chat is given it — and this machine only.
 * Served by the host itself, so it works with no desktop anywhere.
 *
 * Same shape as the desktop's popbot server: Streamable HTTP on
 * 127.0.0.1, a random port, a per-launch secret in the path, and the
 * calling bot's id after it, so a tool knows who is asking.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { dlog } from '../main/diagLog';
import type { HostBots } from './bots';

const PATH_RE = /^\/mcp\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?$/;

export interface BotMcpServer {
  urlFor(botId: string): string;
  close(): Promise<void>;
}

function text(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function register(server: McpServer, bots: HostBots, caller: string): void {
  server.registerTool('list_bots', {
    title: 'List bots',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description: 'The bots you talk to: id, name, the GitHub account each acts as, what wakes it, what it is doing (idle, working, paused, error), and the pull requests it is watching.',
    inputSchema: {},
  }, async () => text(bots.peersOf(caller).map((b) => ({
    id: b.id,
    name: b.name,
    githubLogin: b.githubLogin,
    triggers: b.triggers.map((t) => (t.kind === 'github' ? { github: t.repo ?? '(its repo)', labels: t.labels } : { schedule: t.schedule })),
    state: b.state,
    watching: b.watching.map((pr) => ({ repo: pr.repo, number: pr.number, title: pr.title, ci: pr.ci, decision: pr.decision })),
  }))));

  server.registerTool('message_bot', {
    title: 'Message another bot',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: 'Send a message to a bot you talk to (list_bots) — whenever you like — or answer one that messaged you. It arrives in that bot\'s chat attributed to you, as a turn of its own (queued behind any work it is doing). It does not wait for an answer: if one is wanted, that bot messages you back the same way. Name the pull request a message is about.',
    inputSchema: {
      to: z.string().describe('The bot\'s id or name'),
      text: z.string().min(1),
    },
  }, async ({ to, text: body }) => text(await bots.message(caller, to, body)));

  server.registerTool('reply_to_chat', {
    title: 'Answer a chat',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: 'Answer a message a PopBot chat sent you, by the reply id it gave. Each id answers once. It arrives in that chat attributed to you — at once if the desktop that has the chat is connected, otherwise when it next is. This is the only way to reach a chat: you cannot start a conversation with one.',
    inputSchema: {
      replyId: z.string().describe('The reply id from the chat\'s message'),
      text: z.string().min(1),
    },
  }, async ({ replyId, text: body }) => text(await bots.replyToChat(caller, replyId, body)));
}

export async function startBotMcp(bots: HostBots, version: string): Promise<BotMcpServer> {
  const secret = randomBytes(12).toString('base64url');
  const http: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: err instanceof Error ? err.message : String(err) }, id: null }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const m = PATH_RE.exec(req.url ?? '');
    if (!m || m[1] !== secret || !bots.bot(m[2])) {
      res.writeHead(404).end();
      return;
    }
    const server = new McpServer({ name: 'bots', version });
    register(server, bots, m[2]);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => {
      http.off('error', reject);
      resolve();
    });
  });
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  dlog('host.bots.mcp-listening', { port });
  return {
    urlFor: (botId) => `http://127.0.0.1:${port}/mcp/${secret}/${botId}`,
    close: () => new Promise<void>((resolve) => { http.close(() => resolve()); http.closeAllConnections?.(); }),
  };
}
