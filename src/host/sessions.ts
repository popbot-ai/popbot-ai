/**
 * The host's live sessions: one backend session per chat, driven by the
 * desktop over HTTP, with every event it produces appended to a per-chat
 * log the desktop tails (and replays from its last seq after a
 * disconnect). The host persists nothing else — the transcript is the
 * desktop's.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent, PermissionDecision, PermissionRule } from '@shared/agent';
import { resolvePermissionRules } from '@shared/agent';
import type { PickedAttachment } from '@shared/ipc';
import type {
  HostFrame,
  HostMcpRequest,
  HostMcpResponse,
  HostRules,
  HostSendBody,
  HostSpawnBody,
  HostSpawnResult,
} from '@shared/hostProtocol';
import { ClaudeBackend } from '../main/agents/ClaudeBackend';
import { CodexBackend } from '../main/agents/CodexBackend';
import type { AgentSession } from '../main/agents/types';
import { dlog } from '../main/diagLog';
import type { HostConfig } from './config';
import { FrameLog } from './frameLog';
import type { HostWorkspaces } from './workspaces';

/** Frames kept per chat. A long turn is a few thousand at most. */
const LOG_CAP = 20_000;
/** How long a popbot MCP call waits for the desktop: send_to_chat's
 *  longest wait (30 minutes) and some room. */
const MCP_RELAY_TIMEOUT_MS = 35 * 60_000;

type McpAnswer = Omit<HostMcpResponse, 'id'>;

/**
 * How a bot's chat runs. The host's own settings, whoever asks: a
 * desktop that spawns a bot chat gets the bot, not what it sent — its
 * checkout, its context, its GitHub identity and its tools.
 */
export interface BotSpawn {
  /** The bot's own checkout (made on first use). */
  cwd(): Promise<string>;
  /** The native session of the task it is on; null starts a clean one. */
  sessionId: string | null;
  claudeModel: HostSpawnBody['claudeModel'];
  claudeReasoningEffort: HostSpawnBody['claudeReasoningEffort'];
  /** Added to the CLI's environment (GH_TOKEN, git identity). */
  env: Record<string, string>;
  /** The bot's standing orders, after Claude Code's own prompt. */
  appendSystemPrompt: string;
  /** Its MCP servers — the bots server, never the desktop's popbot. */
  mcpServers: Record<string, { type: 'http'; url: string }>;
  /** Nobody is there to answer a prompt: these decide every tool. */
  rules: HostRules;
  /** Where the event log is kept, and how many frames of it. */
  logPath: string;
  logCap: number;
  onSessionId(sessionId: string): void;
}

/** What the bots tell and ask of the session layer. */
export interface BotHooks {
  /** The bot whose chat this is, or null for an ordinary chat. */
  spawnFor(chatId: string): BotSpawn | null;
  /** The chat's turn ended — or its session did. */
  idle(chatId: string): void;
}

/** A frame before its seq is assigned (Omit over a union would collapse
 *  it to the common keys, so it is spelled out per kind). */
type FrameBody = { [K in HostFrame['kind']]: Omit<Extract<HostFrame, { kind: K }>, 'seq'> }[HostFrame['kind']];

interface LiveChat {
  session: AgentSession;
  cwd: string;
  rules: HostRules;
  frames: HostFrame[];
  seq: number;
  listeners: Set<(frame: HostFrame) => void>;
  /** popbot MCP calls the desktop has not answered, by frame id. */
  mcpPending: Map<string, (answer: McpAnswer) => void>;
  /** Frames kept for replay. */
  cap: number;
  /** A bot's log, kept on disk. */
  log: FrameLog | null;
  /** A message went in and the turn it started has not ended. */
  busy: boolean;
  /** The message that started the turn in flight, while there is one. */
  lastAsk: string | null;
  /** Which spawn's session this is: a replaced session's last events
   *  (an abort, a closing status) are dropped, not logged as current. */
  token: object;
}

export class HostSessions {
  private readonly chats = new Map<string, LiveChat>();
  private mcpUrlFor: ((chatId: string) => string) | null = null;
  private bots: BotHooks | null = null;

  constructor(
    private readonly config: HostConfig,
    private readonly cli: { claude: string | null; codex: string | null },
    private readonly workspaces: HostWorkspaces,
  ) {}

  list(): Array<{ chatId: string; alive: boolean; lastSeq: number }> {
    return [...this.chats.entries()].map(([chatId, c]) => ({ chatId, alive: c.session.isAlive(), lastSeq: c.seq }));
  }

  get(chatId: string): LiveChat | undefined {
    return this.chats.get(chatId);
  }

  /** Bot chats are run by the bots (see bots.ts). */
  useBots(hooks: BotHooks): void {
    this.bots = hooks;
  }

  isBot(chatId: string): boolean {
    return !!this.bots?.spawnFor(chatId);
  }

  /** What the chat was asked to do in the turn it is in, if it is in one. */
  inFlight(chatId: string): string | null {
    const live = this.chats.get(chatId);
    return live?.busy ? live.lastAsk : null;
  }

  /** No chat here — bot or not — is in the middle of a turn. */
  allIdle(): boolean {
    return [...this.chats.values()].every((c) => !c.busy || !c.session.isAlive());
  }

  /** Alive, and not in the middle of a turn. */
  isIdle(chatId: string): boolean {
    const live = this.chats.get(chatId);
    return !!live && live.session.isAlive() && !live.busy;
  }

  /** Where agents reach the popbot relay (see mcpRelay.ts). */
  useMcpRelay(urlFor: (chatId: string) => string): void {
    this.mcpUrlFor = urlFor;
  }

  /** Start (or restart) the chat's session. A live one is disposed first. */
  async spawn(chatId: string, body: HostSpawnBody): Promise<HostSpawnResult> {
    const prior = this.chats.get(chatId);
    if (prior) {
      await prior.session.dispose().catch(() => undefined);
    }
    const bot = this.bots?.spawnFor(chatId) ?? null;
    const workspace = bot
      ? { cwd: await bot.cwd(), kind: 'root' as const, slotId: null, branch: null }
      : await this.workspaces.ensure(chatId, body.workspace);
    const cwd = workspace.cwd;
    // A bot's log is on disk, so a host restart neither loses what a
    // desktop has yet to see nor restarts the numbering it reads by.
    const opened = !prior && bot ? FrameLog.open(bot.logPath, bot.logCap) : null;
    const live: LiveChat = {
      // Filled in below; the backend calls onEvent synchronously during
      // spawn in some paths, so the record exists before it.
      session: null as unknown as AgentSession,
      cwd,
      rules: bot ? bot.rules : normalizeRules(body.rules),
      frames: prior?.frames ?? opened?.frames ?? [],
      seq: prior?.seq ?? opened?.seq ?? 0,
      listeners: prior?.listeners ?? new Set(),
      mcpPending: prior?.mcpPending ?? new Map(),
      cap: bot ? bot.logCap : LOG_CAP,
      log: prior?.log ?? opened?.log ?? null,
      busy: false,
      lastAsk: null,
      token: {},
    };
    const token = live.token;
    const current = (): boolean => this.chats.get(chatId)?.token === token;
    this.chats.set(chatId, live);
    // Frames of this session start after this seq.
    const startSeq = live.seq;
    const isCodex = !bot && body.agent === 'codex';
    const backend = isCodex ? CodexBackend : ClaudeBackend;
    const popbotMcp = !bot && body.popbotMcp && this.mcpUrlFor ? this.mcpUrlFor(chatId) : null;
    const mcpServers = bot
      ? bot.mcpServers
      : popbotMcp ? { popbot: { type: 'http' as const, url: popbotMcp } } : null;
    live.session = backend.spawn({
      chatId,
      history: [],
      cwd,
      sessionId: bot ? bot.sessionId : body.sessionId ?? null,
      claudeModel: isCodex ? null : (bot ? bot.claudeModel : body.claudeModel) ?? null,
      claudeReasoningEffort: isCodex ? null : (bot ? bot.claudeReasoningEffort : body.claudeReasoningEffort) ?? null,
      codexModel: isCodex ? body.codexModel ?? null : null,
      codexReasoningEffort: isCodex ? body.codexReasoningEffort ?? null : null,
      pathToClaudeCodeExecutable: this.cli.claude,
      pathToCodexExecutable: this.cli.codex,
      ...(mcpServers ? { mcpServers } : {}),
      ...(bot ? { env: bot.env, appendSystemPrompt: bot.appendSystemPrompt } : {}),
      onEvent: (event: AgentEvent) => { if (current()) this.push(chatId, { kind: 'event', event }); },
      onSessionId: (sessionId) => {
        if (!current()) return;
        bot?.onSessionId(sessionId);
        this.push(chatId, { kind: 'session-id', sessionId });
      },
      resolveRule: (tool) => resolveHostRule(this.chats.get(chatId)?.rules, tool),
    });
    this.push(chatId, { kind: 'spawned', cwd });
    dlog('host.spawn', { chatId, agent: isCodex ? 'codex' : 'claude', cwd, kind: workspace.kind, slotId: workspace.slotId, resume: bot ? bot.sessionId : body.sessionId ?? null, startSeq, popbotMcp: !!popbotMcp, bot: !!bot });
    return { cwd, seq: startSeq, workspace };
  }

  /** A line in the chat about the chat itself (a bot was reset), and
   *  the end of whatever turn was running — a desktop showing it as
   *  working would otherwise wait for an idle that is not coming. */
  note(chatId: string, text: string): void {
    const live = this.chats.get(chatId);
    if (!live) return;
    const ts = Date.now();
    if (live.busy) {
      live.busy = false;
      this.push(chatId, { kind: 'event', event: { type: 'session-status', chatId, status: 'idle', ts } });
    }
    this.push(chatId, { kind: 'event', event: { type: 'note', chatId, prefix: 'bot', text, ts } });
  }

  /** Put a bot's answer to a chat's message in its log, for the
   *  desktop that issued the reply id to deliver. */
  reply(chatId: string, replyId: string, text: string): void {
    this.must(chatId);
    this.push(chatId, { kind: 'reply', replyId, text });
  }

  /** The host's own message to a chat — a bot's trigger, or another
   *  bot. Recorded in the log first, so a desktop shows it as the turn
   *  it is. */
  async prompt(chatId: string, text: string, from: { id: string; name: string }): Promise<void> {
    const live = this.must(chatId);
    this.push(chatId, { kind: 'prompt', text, from });
    live.busy = true;
    live.lastAsk = text;
    await live.session.sendUser(text, []);
  }

  async send(chatId: string, body: HostSendBody): Promise<void> {
    const live = this.must(chatId);
    const attachments = this.storeAttachments(chatId, body.attachments ?? []);
    live.busy = true;
    live.lastAsk = body.text;
    await live.session.sendUser(body.text, attachments);
    this.noteAlive(chatId);
  }

  approve(chatId: string, permissionId: string, decision: PermissionDecision): void {
    this.must(chatId).session.approve(permissionId, decision);
  }

  stop(chatId: string): void {
    this.must(chatId).session.stop();
  }

  async compact(chatId: string): Promise<boolean> {
    const live = this.must(chatId);
    if (!live.session.compact) return false;
    await live.session.compact();
    return true;
  }

  setRules(chatId: string, rules: HostRules | undefined): void {
    const live = this.must(chatId);
    // A bot's rules are its own; a desktop's do not apply to it.
    if (this.isBot(chatId)) return;
    live.rules = normalizeRules(rules);
  }

  /** Send the agent's popbot MCP call up the chat's stream and wait for
   *  the desktop's answer. A desktop that is away gets it on replay. */
  relayMcp(chatId: string, request: HostMcpRequest, signal: AbortSignal): Promise<McpAnswer> {
    const live = this.must(chatId);
    const id = randomUUID();
    if (signal.aborted) return Promise.reject(new Error('the agent hung up'));
    return new Promise<McpAnswer>((resolve, reject) => {
      const settle = (): void => {
        live.mcpPending.delete(id);
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => { settle(); reject(new Error('the agent hung up')); };
      const timer = setTimeout(() => { settle(); reject(new Error('the desktop did not answer in time')); }, MCP_RELAY_TIMEOUT_MS);
      signal.addEventListener('abort', onAbort, { once: true });
      live.mcpPending.set(id, (answer) => { settle(); resolve(answer); });
      this.push(chatId, { kind: 'mcp-request', id, request });
    });
  }

  /** The desktop's answer to an `mcp-request`; false when nobody waits
   *  for it any more (answered already, or the agent hung up). */
  answerMcp(chatId: string, response: HostMcpResponse): boolean {
    const waiter = this.chats.get(chatId)?.mcpPending.get(response.id);
    if (!waiter) return false;
    waiter({ status: response.status, contentType: response.contentType, body: response.body });
    return true;
  }

  async dispose(chatId: string): Promise<void> {
    const live = this.chats.get(chatId);
    if (!live) return;
    this.chats.delete(chatId);
    for (const l of live.listeners) l({ seq: live.seq + 1, kind: 'dead' });
    await live.session.dispose().catch(() => undefined);
    dlog('host.dispose', { chatId });
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.chats.keys()].map((id) => this.dispose(id)));
  }

  /** Subscribe to a chat's frames: first the log after `after`, then live. */
  subscribe(chatId: string, after: number, listener: (frame: HostFrame) => void): () => void {
    const live = this.must(chatId);
    for (const f of live.frames) {
      if (f.seq <= after) continue;
      // An answered call must not run twice on the desktop.
      if (f.kind === 'mcp-request' && !live.mcpPending.has(f.id)) continue;
      listener(f);
    }
    live.listeners.add(listener);
    if (!live.session.isAlive()) listener({ seq: live.seq + 1, kind: 'dead' });
    return () => { live.listeners.delete(listener); };
  }

  private push(chatId: string, frame: FrameBody): void {
    const live = this.chats.get(chatId);
    if (!live) return;
    live.seq += 1;
    const full = { ...frame, seq: live.seq } as HostFrame;
    live.frames.push(full);
    if (live.frames.length > live.cap) live.frames.splice(0, live.frames.length - live.cap);
    live.log?.append(full, live.frames);
    for (const l of live.listeners) l(full);
    if (full.kind === 'event') this.noteTurn(chatId, live, full.event);
  }

  /** Track whether a turn is in flight, and tell the bots when one ends. */
  private noteTurn(chatId: string, live: LiveChat, event: AgentEvent): void {
    if (event.type === 'turn-start') {
      live.busy = true;
      return;
    }
    if (event.type === 'session-status' && (event.status === 'idle' || event.status === 'errored' || event.status === 'complete')) {
      if (!live.busy) return;
      live.busy = false;
      this.bots?.idle(chatId);
    }
  }

  /** After a send, a session whose query has ended is reported so the
   *  desktop respawns rather than queuing into a dead one. */
  private noteAlive(chatId: string): void {
    const live = this.chats.get(chatId);
    if (live && !live.session.isAlive()) {
      for (const l of live.listeners) l({ seq: live.seq + 1, kind: 'dead' });
    }
  }

  private must(chatId: string): LiveChat {
    const live = this.chats.get(chatId);
    if (!live) throw new HostError(404, `no session for chat ${chatId}; spawn it first`);
    return live;
  }

  /** Attachments arrive as bytes; the backends want paths. */
  private storeAttachments(chatId: string, incoming: HostSendBody['attachments'] & object): PickedAttachment[] {
    if (!incoming || incoming.length === 0) return [];
    const dir = join(this.config.workspacesDir, 'attachments', chatId);
    mkdirSync(dir, { recursive: true });
    return incoming.map((att, i) => {
      const safe = att.name.replace(/[^A-Za-z0-9._-]+/g, '_') || `attachment-${i}`;
      const path = join(dir, `${Date.now()}-${safe}`);
      const bytes = Buffer.from(att.dataBase64, 'base64');
      writeFileSync(path, bytes);
      return { id: `att_${Date.now()}_${i}`, path, name: att.name, sizeBytes: bytes.length, isImage: att.isImage };
    });
  }
}

/** The chat's rules answer first; the global ones only when they are silent. */
function resolveHostRule(rules: HostRules | undefined, tool: string): 'allow' | 'deny' | null {
  if (!rules) return null;
  return resolvePermissionRules(rules.chat, tool) ?? resolvePermissionRules(rules.global, tool);
}

function normalizeRules(rules: Partial<HostRules> | PermissionRule[] | undefined): HostRules {
  // An older desktop sends one flat list; treat it as the chat's.
  if (Array.isArray(rules)) return { chat: rules, global: [] };
  return {
    chat: Array.isArray(rules?.chat) ? rules.chat : [],
    global: Array.isArray(rules?.global) ? rules.global : [],
  };
}

export class HostError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HostError';
  }
}
