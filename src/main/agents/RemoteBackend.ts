/**
 * A chat whose agent runs on a PopBot host (another box running
 * `popbot-host`): the session here is a client of the host's session.
 * Messages, approvals and stops go over as requests; everything the
 * agent does comes back as frames on the chat's event stream and is
 * handed to the AgentHost like a local backend's events — so the
 * transcript, search and settings stay in this desktop's database.
 *
 * The host keeps the session and its event log; this side keeps the
 * last frame seq it applied (in the chat's host info) and, on any
 * reconnect — a dropped stream, PopBot restarting — asks for what came
 * after it. Disposing this session only detaches: the host keeps
 * working, and the next message reattaches. Ending the session on the
 * host is a separate, explicit action (the chat menu).
 */
import type { AgentEvent, PermissionDecision } from '@shared/agent';
import type { PickedAttachment } from '@shared/ipc';
import type {
  HostApproveBody,
  HostFrame,
  HostInfo,
  HostRules,
  HostSendBody,
  HostSpawnBody,
  HostSpawnResult,
} from '@shared/hostProtocol';
import type { HostRecord } from '@shared/persistence';
import { dlog } from '../diagLog';
import { encodeAttachments, hostRequest, HostRequestError, readHostEvents } from './hostClient';
import type { AgentBackend, AgentSession, RemoteSpawnOpts, SpawnOpts } from './types';

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** How long applied seqs wait before they are written to the chat row. */
const SEQ_FLUSH_MS = 1_500;

export const RemoteBackend: AgentBackend = {
  id: 'remote',
  // What the host's CLI has. The popbot MCP and editor MCPs are on this
  // machine's localhost, which the host cannot reach.
  capabilities: { skills: true, memory: true, subAgents: true, mcpHttp: false },
  spawn(opts: SpawnOpts): AgentSession {
    if (!opts.remote) throw new Error('RemoteBackend.spawn: remote options are required');
    return new RemoteSession(opts, opts.remote);
  },
};

class RemoteSession implements AgentSession {
  private readonly chatId: string;
  private readonly host: HostRecord;
  private readonly onEvent: (event: AgentEvent) => void;
  private readonly onSessionId?: (sessionId: string) => void;
  private readonly body: Omit<HostSpawnBody, 'rules'>;
  private readonly resumes: boolean;

  private alive = true;
  private disposed = false;
  private lastSeq: number;
  private cwd: string | null;
  private starting: Promise<{ fresh: boolean }> | null = null;
  /** The first message after a spawn tells the agent where it is. */
  private preambleDue = false;
  private stream: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = RECONNECT_MIN_MS;
  private seqFlush: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: SpawnOpts, private readonly remote: RemoteSpawnOpts) {
    this.chatId = opts.chatId;
    this.host = remote.host;
    this.onEvent = opts.onEvent;
    this.onSessionId = opts.onSessionId;
    this.lastSeq = remote.info.lastSeq;
    this.cwd = remote.info.cwd;
    this.resumes = !!opts.sessionId;
    const isCodex = remote.agent === 'codex';
    this.body = {
      agent: remote.agent,
      sessionId: opts.sessionId ?? null,
      claudeModel: isCodex ? null : opts.claudeModel ?? null,
      claudeReasoningEffort: isCodex ? null : opts.claudeReasoningEffort ?? null,
      codexModel: isCodex ? opts.codexModel ?? null : null,
      codexReasoningEffort: isCodex ? opts.codexReasoningEffort ?? null : null,
      workspace: remote.info.kind === 'scratch' || !remote.info.repoId
        ? { kind: 'scratch' }
        : {
            kind: remote.info.kind,
            repoId: remote.info.repoId,
            branch: remote.info.branch,
            baseBranch: remote.info.baseBranch,
            // The slot it held before, when the host still has it free.
            slotId: remote.info.slotId,
          },
    };
  }

  /** Reattach to a session the host still has, else spawn one. Once. */
  private ensureStarted(): Promise<{ fresh: boolean }> {
    if (!this.starting) this.starting = this.start();
    return this.starting;
  }

  private async start(): Promise<{ fresh: boolean }> {
    const info = await hostRequest<HostInfo>(this.host, 'GET', '/v1/info');
    const live = info.chats?.find((c) => c.chatId === this.chatId && c.alive);
    if (live) {
      // Frames since the last one applied here are replayed into the
      // transcript; a stored seq past the host's log means the log was
      // reset, so read it from the start.
      const after = Math.min(this.lastSeq, live.lastSeq);
      this.lastSeq = after;
      dlog('remote.attach', { chatId: this.chatId, host: this.host.name, after, hostSeq: live.lastSeq });
      this.openStream(after);
      return { fresh: false };
    }
    const spawned = await hostRequest<HostSpawnResult>(
      this.host,
      'POST',
      `/v1/chats/${encodeURIComponent(this.chatId)}/spawn`,
      { ...this.body, rules: this.remote.rules() } satisfies HostSpawnBody,
      60_000,
    );
    this.cwd = spawned.cwd;
    this.lastSeq = spawned.seq;
    this.preambleDue = true;
    this.remote.onHostUpdate({
      cwd: spawned.cwd,
      lastSeq: spawned.seq,
      ...(spawned.workspace ? { slotId: spawned.workspace.slotId, branch: spawned.workspace.branch ?? this.remote.info.branch } : {}),
    });
    dlog('remote.spawned', { chatId: this.chatId, host: this.host.name, cwd: spawned.cwd, seq: spawned.seq, resume: this.body.sessionId });
    this.openStream(spawned.seq);
    return { fresh: true };
  }

  private openStream(after: number): void {
    if (this.disposed) return;
    const ctl = new AbortController();
    this.stream = ctl;
    void readHostEvents(this.host, this.chatId, after, ctl.signal, (frame) => this.onFrame(frame))
      .then(() => {
        if (!ctl.signal.aborted) this.scheduleReconnect('stream ended');
      })
      .catch((err: unknown) => {
        if (!ctl.signal.aborted) this.scheduleReconnect(err instanceof Error ? err.message : String(err));
      });
  }

  private scheduleReconnect(reason: string): void {
    if (this.disposed || !this.alive || this.reconnectTimer) return;
    dlog('remote.stream.lost', { chatId: this.chatId, host: this.host.name, reason, retryMs: this.backoffMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openStream(this.lastSeq);
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
  }

  private onFrame(frame: HostFrame): void {
    if (frame.kind === 'dead') {
      // The host's session is gone: the next message spawns a new one
      // (resuming the native session). Not a log entry — its seq is
      // not recorded.
      dlog('remote.dead', { chatId: this.chatId, host: this.host.name, lastSeq: this.lastSeq });
      this.alive = false;
      this.stopStream();
      return;
    }
    // Replay after a reconnect can repeat what was already applied.
    if (frame.seq <= this.lastSeq) return;
    this.lastSeq = frame.seq;
    this.backoffMs = RECONNECT_MIN_MS;
    this.queueSeqFlush();
    switch (frame.kind) {
      case 'event':
        this.onEvent(frame.event);
        break;
      case 'session-id':
        this.onSessionId?.(frame.sessionId);
        break;
      case 'spawned':
        this.cwd = frame.cwd;
        this.remote.onHostUpdate({ cwd: frame.cwd });
        break;
      default:
        break;
    }
  }

  private queueSeqFlush(): void {
    if (this.seqFlush) return;
    this.seqFlush = setTimeout(() => {
      this.seqFlush = null;
      this.remote.onHostUpdate({ lastSeq: this.lastSeq });
    }, SEQ_FLUSH_MS);
  }

  private stopStream(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.stream) {
      this.stream.abort();
      this.stream = null;
    }
  }

  /** What the agent is told on its first message of a session there —
   *  the counterpart of the local working-directory preamble. */
  private hostPreamble(): string {
    const now = new Date().toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });
    const where = this.cwd ? ` in this working directory: ${this.cwd}` : '';
    return this.resumes
      ? `[System] This chat resumed at ${now} on the host "${this.host.name}"${where} — use this path for ` +
          `all file reads, edits, and commands from here on; any path you recall from earlier may be stale.\n\n`
      : `[System] Starting up at ${now} on the host "${this.host.name}"${where}.${this.remote.languageDirective} ` +
          `This machine is not the one the person is using: files and tools are here, on the host. ` +
          `Instructions will follow.\n\n`;
  }

  async sendUser(text: string, attachments?: PickedAttachment[]): Promise<void> {
    const started = await this.ensureStarted();
    if (!this.alive) {
      throw new Error(`the session on ${this.host.name} has ended; send again to start a new one`);
    }
    const preamble = this.preambleDue && started.fresh ? this.hostPreamble() : '';
    this.preambleDue = false;
    const body: HostSendBody = { text: preamble + text, attachments: await encodeAttachments(attachments) };
    try {
      await hostRequest(this.host, 'POST', `/v1/chats/${encodeURIComponent(this.chatId)}/send`, body, 60_000);
    } catch (err) {
      // The host has no session for this chat (it restarted): the next
      // send starts one.
      if (err instanceof HostRequestError && err.status === 404) this.alive = false;
      throw err;
    }
    dlog('remote.sent', { chatId: this.chatId, host: this.host.name, textLen: text.length, attachments: body.attachments?.length ?? 0 });
  }

  approve(permissionId: string, decision: PermissionDecision): void {
    void (async () => {
      try {
        // The decision may have added a rule; the host resolves rules
        // for later calls from what it was last given.
        await hostRequest(this.host, 'POST', `/v1/chats/${encodeURIComponent(this.chatId)}/rules`, {
          rules: this.remote.rules() satisfies HostRules,
        });
        await hostRequest(this.host, 'POST', `/v1/chats/${encodeURIComponent(this.chatId)}/approve`, {
          permissionId,
          decision,
        } satisfies HostApproveBody);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        dlog('remote.approve.failed', { chatId: this.chatId, permissionId, error: message });
        this.onEvent({ type: 'error', chatId: this.chatId, message: `host: ${message}`, level: 'error', ts: Date.now() });
      }
    })();
  }

  stop(): void {
    void hostRequest(this.host, 'POST', `/v1/chats/${encodeURIComponent(this.chatId)}/stop`, {}).catch((err: unknown) => {
      dlog('remote.stop.failed', { chatId: this.chatId, error: err instanceof Error ? err.message : String(err) });
    });
  }

  async compact(): Promise<void> {
    await this.ensureStarted();
    const res = await hostRequest<{ ok: boolean }>(this.host, 'POST', `/v1/chats/${encodeURIComponent(this.chatId)}/compact`, {}, 120_000);
    if (!res?.ok) throw new Error(`${this.host.name}: this agent cannot compact on request`);
  }

  /** Detach. The session on the host keeps going. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stopStream();
    if (this.seqFlush) {
      clearTimeout(this.seqFlush);
      this.seqFlush = null;
      try {
        this.remote.onHostUpdate({ lastSeq: this.lastSeq });
      } catch {
        // the DB may be closing — the seq is only a replay hint
      }
    }
    dlog('remote.detach', { chatId: this.chatId, host: this.host.name, lastSeq: this.lastSeq });
  }

  isAlive(): boolean {
    return this.alive && !this.disposed;
  }
}
