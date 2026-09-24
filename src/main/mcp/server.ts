/**
 * The `popbot` MCP server: the tools every chat's agent gets to drive
 * PopBot itself — list, create, close and reopen chats, message another
 * chat and wait for its answer, start code reviews and ticket chats,
 * read and search transcripts.
 *
 * Transport: MCP Streamable HTTP on 127.0.0.1, a random port, and a
 * per-launch secret in the path — so only processes PopBot itself
 * started can find it, and no header-based auth is needed (Codex's
 * config and Claude's `mcpServers` both take a bare URL). The chat id is
 * in the path too, so a tool knows which chat is calling: a chat cannot
 * close or message itself, and "this chat" is a valid transcript target.
 *
 * Stateless: every request gets its own McpServer + transport bound to
 * the calling chat (the SDK's recommended shape for stateless HTTP; a
 * server per request is cheap and no request ids collide). The tool
 * handlers are injected so this file is testable against fakes and the
 * real ones (popbotTools.ts) can reach the DB and AgentHost.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { TranscriptSearchHit } from '@shared/ipc';

export interface ChatSummary {
  id: string;
  name: string;
  status: string;
  agent: string;
  repoId: string;
  branch: string | null;
  ticket: string | null;
  pr: number | null;
  cloud: boolean;
  closed: boolean;
  lastActiveAt: number;
  /** The chat the tool call came from. */
  isCaller: boolean;
}

export type ToolFailure = { error: string };

/** Everything the tools do, as plain functions. `caller` is the chat id
 *  the request came from (null for a request with no chat, e.g. tests). */
export interface PopbotToolHandlers {
  listChats(input: { includeClosed: boolean }, caller: string | null): ChatSummary[];
  createChat(
    input: { name: string; repoId?: string; workspace: 'slot' | 'repo-root' | 'cloud'; baseBranch?: string; branch?: string; agent?: 'claude' | 'codex'; firstMessage?: string },
    caller: string | null,
  ): Promise<{ chat: ChatSummary } | ToolFailure>;
  closeChat(input: { chatId: string; keepChanges: boolean }, caller: string | null): Promise<{ ok: true; chatId: string } | ToolFailure>;
  reopenChat(input: { chatId: string }, caller: string | null): Promise<{ chat: ChatSummary } | ToolFailure>;
  sendToChat(
    input: { chatId: string; text: string; waitForReply: boolean; timeoutSeconds: number },
    caller: string | null,
  ): Promise<{ outcome: 'sent' | 'replied' | 'timeout' | 'needs-permission' | 'errored'; reply: string; entries: number } | ToolFailure>;
  startCodeReview(input: { prNumber: number; scm: 'git' | 'perforce' }, caller: string | null): Promise<{ chat: ChatSummary; existing: boolean } | ToolFailure>;
  openTicketChat(input: { ticket: string; repoId?: string; baseBranch?: string }, caller: string | null): Promise<{ chat: ChatSummary; existing: boolean } | ToolFailure>;
  getTranscript(
    input: { chatId?: string; from?: number; to?: number; includeTools: boolean; maxChars: number },
    caller: string | null,
  ): { chatId: string; text: string; count: number; total: number; truncated: boolean } | ToolFailure;
  searchTranscripts(
    input: {
      query: string; chatId?: string; allChats: boolean; includeClosed: boolean; mode: 'text' | 'fts';
      contextChars: number; maxResults: number; caseSensitive: boolean;
    },
    caller: string | null,
  ): { matches: TranscriptSearchHit[] } | ToolFailure;
}

function text(value: unknown): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  if (value && typeof value === 'object' && 'error' in value && typeof (value as ToolFailure).error === 'string') {
    return { content: [{ type: 'text', text: `error: ${(value as ToolFailure).error}` }], isError: true };
  }
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

async function guarded<T>(fn: () => T | Promise<T>): Promise<ReturnType<typeof text>> {
  try {
    return text(await fn());
  } catch (err) {
    return text({ error: err instanceof Error ? err.message : String(err) });
  }
}

/** Register the popbot tools on an McpServer, bound to the calling chat. */
export function registerPopbotTools(server: McpServer, h: PopbotToolHandlers, caller: string | null): void {
  server.registerTool('list_chats', {
    title: 'List chats',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description: 'PopBot chats: id, name, status (idle/run/wait/err), agent, repo, branch, ticket, PR, whether it is a cloud chat, and which one is you (isCaller). Closed (archived) chats are included on request.',
    inputSchema: { includeClosed: z.boolean().default(false).describe('Also list closed/archived chats') },
  }, async ({ includeClosed }) => guarded(() => h.listChats({ includeClosed }, caller)));

  server.registerTool('create_chat', {
    title: 'Create a chat',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: 'Create a new PopBot chat with its own agent. workspace "slot" gives it a fresh git worktree on a new branch off baseBranch; "repo-root" runs it at the repository root with no branch; "cloud" makes a Claude Code cloud session (Claude only). Optionally send it a first message right away (it runs in the background — use send_to_chat to wait for an answer).',
    inputSchema: {
      name: z.string().min(1).describe('Chat name (also seeds the branch name for a slot chat)'),
      repoId: z.string().optional().describe('Repository id from list_chats / PopBot Preferences; defaults to the last one used'),
      workspace: z.enum(['slot', 'repo-root', 'cloud']).default('repo-root'),
      baseBranch: z.string().optional().describe('Slot chats: the branch to start from (default: the repo default base)'),
      branch: z.string().optional().describe('Slot chats: the branch name to create (default: derived from the name)'),
      agent: z.enum(['claude', 'codex']).optional().describe('Default: the last agent used in PopBot'),
      firstMessage: z.string().optional().describe('Sent to the new chat immediately, without waiting for the reply'),
    },
  }, async (input) => guarded(() => h.createChat(input, caller)));

  server.registerTool('close_chat', {
    title: 'Close (archive) a chat',
    // Not destructive: a close keeps the chat and (by default) its work,
    // and reopen_chat undoes it. Codex refuses destructive-annotated
    // tools outright under its `never` approval policy.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: 'Close a chat: its agent session ends and its slot is released. A slot chat’s work is kept on its branch (keepChanges true, the default) or discarded. You cannot close the chat you are running in.',
    inputSchema: {
      chatId: z.string(),
      keepChanges: z.boolean().default(true).describe('Keep uncommitted changes with the chat’s branch so a reopen restores them'),
    },
  }, async (input) => guarded(() => h.closeChat(input, caller)));

  server.registerTool('reopen_chat', {
    title: 'Reopen an archived chat',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: 'Reopen a closed chat: a slot chat gets a workspace again with its branch and saved changes restored, and its agent resumes with its full history.',
    inputSchema: { chatId: z.string() },
  }, async (input) => guarded(() => h.reopenChat(input, caller)));

  server.registerTool('send_to_chat', {
    title: 'Message another chat',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: 'Send a message to another chat’s agent. With waitForReply (default) it waits for that agent’s turn to finish and returns what it said; a chat that is mid-turn gets the message queued behind its current work. Outcomes: replied, timeout (still working; call get_chat_transcript later), needs-permission (waiting on the user), errored. You cannot message the chat you are running in.',
    inputSchema: {
      chatId: z.string(),
      text: z.string().min(1),
      waitForReply: z.boolean().default(true),
      timeoutSeconds: z.number().int().min(5).max(1800).default(300),
    },
  }, async (input) => guarded(() => h.sendToChat(input, caller)));

  server.registerTool('start_code_review', {
    title: 'Start a code review chat',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: 'Open a review chat for a pull request (GitHub, by number) or a Helix Swarm review (scm "perforce", by id), the same way PopBot’s Reviews list does: a repo-root chat named "[CR] PR #n · title" that is sent the configured start-review prompt. Returns the existing chat if one already reviews that PR.',
    inputSchema: {
      prNumber: z.number().int().positive(),
      scm: z.enum(['git', 'perforce']).default('git'),
    },
  }, async (input) => guarded(() => h.startCodeReview(input, caller)));

  server.registerTool('open_ticket_chat', {
    title: 'Open a chat for a ticket',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: 'Open a work chat for an issue from the configured tracker (Linear/Jira/GitHub identifier such as ENG-123): a slot chat on a "<you>/<ticket>-<slug>" branch, sent the configured start-ticket prompt with the ticket’s description, and the ticket moved to In Progress. Returns the existing chat if one is already open (or reopens a closed one).',
    inputSchema: {
      ticket: z.string().min(1).describe('The ticket identifier, e.g. ENG-123 or owner/repo#42'),
      repoId: z.string().optional(),
      baseBranch: z.string().optional(),
    },
  }, async (input) => guarded(() => h.openTicketChat(input, caller)));

  server.registerTool('get_chat_transcript', {
    title: 'Read a chat’s transcript',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description: 'The messages of a chat (yours when chatId is omitted) as numbered entries: "#index role @ time" then the text; tool calls are summarized. Use from/to (entry indices, inclusive) to read a part; the result says the total so you can page.',
    inputSchema: {
      chatId: z.string().optional().describe('Default: the chat you are running in'),
      from: z.number().int().min(0).optional(),
      to: z.number().int().min(0).optional(),
      includeTools: z.boolean().default(false).describe('Include tool calls and their results'),
      maxChars: z.number().int().min(1000).max(200_000).default(40_000),
    },
  }, async (input) => guarded(() => h.getTranscript(input, caller)));

  server.registerTool('search_chats', {
    title: 'Search chat transcripts',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description: 'Full-text search over chat transcripts — what the user and the agent wrote; tool calls and their output (command output, patches) only with from:tool, system notes with from:system. Scope: your chat by default, another with chatId, every open chat with allChats, or the whole archive with includeClosed. Indexed (trigram), so a fragment of an identifier or error message is enough — the query is a case-insensitive substring, 3+ characters. Filter tags in the query: ticket:ENG-123 (or bare ticket: for any ticket chat), cr:67 (or cr:), last:week | last:month | last:3d, from:user | from:agent | from:tool | from:system (comma list), tool:Bash, agent:codex, in:archive | in:open, chat:login+bug (every +-joined word must be in the chat name) or chat:<chat id> for one chat, repo:<id>; tags alone (no text) list the newest matching entries. Each hit comes with the text around it, the chat, and the entry index to read more with get_chat_transcript. Best matches first.',
    inputSchema: {
      query: z.string().min(1),
      chatId: z.string().optional().describe('Search only this chat (default: the chat you are running in)'),
      allChats: z.boolean().default(false).describe('Search every open chat'),
      includeClosed: z.boolean().default(false).describe('Search every chat, archived ones included (implies allChats)'),
      mode: z.enum(['text', 'fts']).default('text').describe('text: a literal substring; fts: FTS5 syntax — "a phrase", AND, OR, NOT, NEAR(a b)'),
      contextChars: z.number().int().min(0).max(2000).default(200),
      maxResults: z.number().int().min(1).max(200).default(20),
      caseSensitive: z.boolean().default(false).describe('text mode only: drop hits whose case differs'),
    },
  }, async (input) => guarded(() => h.searchTranscripts(input, caller)));


}

export interface PopbotMcpServer {
  port: number;
  secret: string;
  urlFor(chatId: string): string;
  close(): Promise<void>;
}

const PATH_RE = /^\/mcp\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?$/;

/** Start the HTTP server. `port` 0 (default) picks a free one. */
export async function startPopbotMcpServer(
  handlers: PopbotToolHandlers,
  opts: { port?: number; version?: string } = {},
): Promise<PopbotMcpServer> {
  const secret = randomBytes(12).toString('base64url');
  const version = opts.version ?? '0';
  const http: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: err instanceof Error ? err.message : String(err) }, id: null }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const m = PATH_RE.exec(req.url ?? '');
    if (!m || m[1] !== secret) {
      res.writeHead(404).end();
      return;
    }
    const caller = m[2] === '_' ? null : m[2];
    const server = new McpServer({ name: 'popbot', version });
    registerPopbotTools(server, handlers, caller);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port ?? 0, '127.0.0.1', () => {
      http.off('error', reject);
      resolve();
    });
  });
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    port,
    secret,
    urlFor: (chatId) => `http://127.0.0.1:${port}/mcp/${secret}/${chatId || '_'}`,
    close: () => new Promise<void>((resolve) => { http.close(() => resolve()); http.closeAllConnections?.(); }),
  };
}
