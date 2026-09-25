/**
 * The host's live sessions: one backend session per chat, driven by the
 * desktop over HTTP, with every event it produces appended to a per-chat
 * log the desktop tails (and replays from its last seq after a
 * disconnect). The host persists nothing else — the transcript is the
 * desktop's.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent, PermissionDecision, PermissionRule } from '@shared/agent';
import { resolvePermissionRules } from '@shared/agent';
import type { PickedAttachment } from '@shared/ipc';
import type { HostFrame, HostRules, HostSendBody, HostSpawnBody, HostSpawnResult } from '@shared/hostProtocol';
import { ClaudeBackend } from '../main/agents/ClaudeBackend';
import { CodexBackend } from '../main/agents/CodexBackend';
import type { AgentSession } from '../main/agents/types';
import { dlog } from '../main/diagLog';
import type { HostConfig } from './config';
import type { HostWorkspaces } from './workspaces';

/** Frames kept per chat. A long turn is a few thousand at most. */
const LOG_CAP = 20_000;

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
}

export class HostSessions {
  private readonly chats = new Map<string, LiveChat>();

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

  /** Start (or restart) the chat's session. A live one is disposed first. */
  async spawn(chatId: string, body: HostSpawnBody): Promise<HostSpawnResult> {
    const prior = this.chats.get(chatId);
    if (prior) {
      await prior.session.dispose().catch(() => undefined);
    }
    const workspace = await this.workspaces.ensure(chatId, body.workspace);
    const cwd = workspace.cwd;
    const live: LiveChat = {
      // Filled in below; the backend calls onEvent synchronously during
      // spawn in some paths, so the record exists before it.
      session: null as unknown as AgentSession,
      cwd,
      rules: normalizeRules(body.rules),
      frames: prior?.frames ?? [],
      seq: prior?.seq ?? 0,
      listeners: prior?.listeners ?? new Set(),
    };
    this.chats.set(chatId, live);
    // Frames of this session start after this seq.
    const startSeq = live.seq;
    const backend = body.agent === 'codex' ? CodexBackend : ClaudeBackend;
    const isCodex = body.agent === 'codex';
    live.session = backend.spawn({
      chatId,
      history: [],
      cwd,
      sessionId: body.sessionId ?? null,
      claudeModel: isCodex ? null : body.claudeModel ?? null,
      claudeReasoningEffort: isCodex ? null : body.claudeReasoningEffort ?? null,
      codexModel: isCodex ? body.codexModel ?? null : null,
      codexReasoningEffort: isCodex ? body.codexReasoningEffort ?? null : null,
      pathToClaudeCodeExecutable: this.cli.claude,
      pathToCodexExecutable: this.cli.codex,
      onEvent: (event: AgentEvent) => this.push(chatId, { kind: 'event', event }),
      onSessionId: (sessionId) => this.push(chatId, { kind: 'session-id', sessionId }),
      resolveRule: (tool) => resolveHostRule(this.chats.get(chatId)?.rules, tool),
    });
    this.push(chatId, { kind: 'spawned', cwd });
    dlog('host.spawn', { chatId, agent: body.agent, cwd, kind: workspace.kind, slotId: workspace.slotId, resume: body.sessionId ?? null, startSeq });
    return { cwd, seq: startSeq, workspace };
  }

  async send(chatId: string, body: HostSendBody): Promise<void> {
    const live = this.must(chatId);
    const attachments = this.storeAttachments(chatId, body.attachments ?? []);
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
    this.must(chatId).rules = normalizeRules(rules);
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
    for (const f of live.frames) if (f.seq > after) listener(f);
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
    if (live.frames.length > LOG_CAP) live.frames.splice(0, live.frames.length - LOG_CAP);
    for (const l of live.listeners) l(full);
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
