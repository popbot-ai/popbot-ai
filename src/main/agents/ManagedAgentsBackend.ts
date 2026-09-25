/**
 * Cloud chats: an Anthropic Managed Agents session in place of a local
 * CLI. The session lives on Anthropic's side (an API-key resource, not
 * the claude.ai subscription) and keeps working after PopBot quits.
 *
 * One AgentSession per chat:
 *   - the first message creates the session — the account's PopBot
 *     environment, the agent for the chat's model + effort, and, for a
 *     chat with a repository, that repository mounted from GitHub at the
 *     chat's branch (pushed first); every later spawn reattaches;
 *   - `sendUser` posts a `user.message`; the reply arrives on the
 *     session's event stream and is translated (managedAgents.ts) into
 *     the same AgentEvents the local backends emit;
 *   - on reattach the events missed while PopBot was away are listed
 *     and replayed first, from the newest one the chat had seen.
 *
 * The backend never writes the DB: what it learns (session id, mount
 * path, last event) goes back through `cloud.onCloudUpdate`.
 */
import { promises as fsp } from 'node:fs';
import { basename, extname } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { Stream } from '@anthropic-ai/sdk/core/streaming';
import type {
  BetaManagedAgentsDocumentBlock,
  BetaManagedAgentsImageBlock,
  BetaManagedAgentsTextBlock,
} from '@anthropic-ai/sdk/resources/beta/sessions/events';
import type { SessionCreateParams } from '@anthropic-ai/sdk/resources/beta/sessions/sessions';
import type { AgentEvent, PermissionDecision } from '@shared/agent';
import type { PickedAttachment } from '@shared/ipc';
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_REASONING_EFFORT,
  type ClaudeModelId,
  type ClaudeReasoningEffort,
} from '@shared/persistence';
import { dlog } from '../diagLog';
import type { AgentBackend, AgentSession, CloudSpawnOpts, SpawnOpts } from './types';
import { branchOnOrigin, currentBranch, githubOriginUrl, pushBranch } from './cloudGit';
import {
  cloudClient,
  describeApiError,
  ensureAgent,
  ensureEnvironment,
  resolveGithubToken,
} from './managedAgentsClient';
import {
  cloudPreamble,
  eventId,
  mountPathFor,
  newTurnState,
  translateEvent,
  type CloudStreamEvent,
  type CloudTurnState,
} from './managedAgents';

/** Something about the chat's setup (key, repo, token, push) the user
 *  has to fix. AgentHost shows the message as the chat's error. */
export class CloudSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudSetupError';
  }
}

type UserContentBlock = BetaManagedAgentsTextBlock | BetaManagedAgentsImageBlock | BetaManagedAgentsDocumentBlock;

const IMAGE_MEDIA: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
/** Text attachments are inlined as documents up to this size; the
 *  sandbox cannot read the user's disk. */
const MAX_INLINE_TEXT_BYTES = 512 * 1024;
/** Ids remembered to drop stream events already applied from history. */
const SEEN_CAP = 5000;
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const LAST_EVENT_FLUSH_MS = 1_500;

export const ManagedAgentsBackend: AgentBackend = {
  id: 'cloud',
  // The sandbox cannot reach this machine, so no editor / popbot MCP.
  capabilities: { skills: false, memory: false, subAgents: false, mcpHttp: false },

  spawn(opts: SpawnOpts): AgentSession {
    if (!opts.cloud) throw new Error('ManagedAgentsBackend.spawn: missing cloud options');
    return new ManagedAgentsSession(opts, opts.cloud);
  },
};

class ManagedAgentsSession implements AgentSession {
  private readonly chatId: string;
  private readonly onEvent: (event: AgentEvent) => void;
  private readonly cloud: CloudSpawnOpts;
  private readonly model: ClaudeModelId;
  private readonly effort: ClaudeReasoningEffort;
  private client: Anthropic | null = null;
  private sessionId: string | null;
  private lastEventId: string | null;
  private lastEventTimer: NodeJS.Timeout | null = null;
  private readonly st: CloudTurnState;
  private attaching: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private readonly seen = new Set<string>();
  /** What the agent is told with the first message of a session. */
  private preamble: string | null = null;
  private disposed = false;

  constructor(opts: SpawnOpts, cloud: CloudSpawnOpts) {
    this.chatId = opts.chatId;
    this.onEvent = opts.onEvent;
    this.cloud = cloud;
    this.model = opts.claudeModel ?? DEFAULT_CLAUDE_MODEL;
    this.effort = opts.claudeReasoningEffort ?? DEFAULT_CLAUDE_REASONING_EFFORT;
    this.st = newTurnState(opts.chatId);
    const info = cloud.info;
    // An ended session is not resumed; the next message starts a new one.
    this.sessionId = info.ended ? null : info.sessionId;
    this.lastEventId = info.ended ? null : info.lastEventId ?? null;
    if (this.sessionId) {
      // Reattach right away so the chat catches up on what it missed.
      void this.ensureAttached().catch((err) => this.reportStreamFailure(err));
    }
  }

  isAlive(): boolean {
    return !this.disposed && !this.st.ended;
  }

  async sendUser(text: string, attachments?: PickedAttachment[]): Promise<void> {
    if (!this.sessionId) await this.createSession();
    await this.ensureAttached();
    const client = this.api();
    const content = await buildUserContent(text, attachments, this.preamble);
    this.preamble = null;
    try {
      await client.beta.sessions.events.send(this.sessionId!, {
        events: [{ type: 'user.message', content }],
      });
    } catch (err) {
      throw new CloudSetupError(`the message could not be sent to the cloud session: ${describeApiError(err)}`);
    }
    dlog('cloud.sent', { chatId: this.chatId, sessionId: this.sessionId, textLen: text.length, blocks: content.length });
  }

  approve(permissionId: string, decision: PermissionDecision): void {
    if (!this.sessionId) return;
    const result = decision.startsWith('allow') ? 'allow' : 'deny';
    this.st.pendingConfirmations.delete(permissionId);
    dlog('cloud.confirm', { chatId: this.chatId, permissionId, result });
    void this.api().beta.sessions.events.send(this.sessionId, {
      events: [{
        type: 'user.tool_confirmation',
        tool_use_id: permissionId,
        result,
        ...(result === 'deny' ? { deny_message: 'Denied by the user in PopBot.' } : {}),
      }],
    }).catch((err) => {
      this.onEvent({
        type: 'error', chatId: this.chatId, level: 'error', retryable: false, ts: Date.now(),
        message: `the decision could not be sent to the cloud session: ${describeApiError(err)}`,
      });
    });
  }

  stop(): void {
    if (!this.sessionId) return;
    dlog('cloud.interrupt', { chatId: this.chatId, sessionId: this.sessionId });
    void this.api().beta.sessions.events.send(this.sessionId, { events: [{ type: 'user.interrupt' }] })
      .catch((err) => dlog('cloud.interrupt.failed', { chatId: this.chatId, error: describeApiError(err) }));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.abort?.abort();
    this.abort = null;
    this.flushLastEvent();
  }

  // ---- session setup ----

  private api(): Anthropic {
    if (!this.client) this.client = cloudClient();
    return this.client;
  }

  /**
   * Create the session: environment + agent (cached per account /
   * model), and the chat's repository mounted from GitHub at its branch.
   * Setup problems are CloudSetupErrors — the message is for the user.
   */
  private async createSession(): Promise<void> {
    const client = this.api();
    let environmentId: string;
    let agentId: string;
    try {
      [environmentId, agentId] = await Promise.all([
        ensureEnvironment(client),
        ensureAgent(client, this.model, this.effort),
      ]);
    } catch (err) {
      throw err instanceof CloudSetupError ? err
        : new CloudSetupError(`the cloud could not be set up: ${describeApiError(err)}`);
    }

    const ws = this.cloud.workspace;
    let repo: { url: string; branch: string; mountPath: string; token: string } | null = null;
    let resource: SessionCreateParams['resources'] = undefined;
    if (ws) {
      const url = await githubOriginUrl(ws.localPath);
      if (!url) {
        throw new CloudSetupError(
          'the repository’s origin is not a GitHub URL — the cloud clones from GitHub, so add a github.com origin first',
        );
      }
      const branch = ws.branch ?? (await currentBranch(ws.localPath));
      if (!branch) throw new CloudSetupError('the checkout is on a detached HEAD; check out a branch first');
      const token = await resolveGithubToken();
      if (!token) {
        throw new CloudSetupError(
          'no GitHub token for the sandbox to clone with — add one in Preferences ▸ Agents ▸ Cloud chats, or sign in with `gh auth login`',
        );
      }
      // The sandbox clones what is on origin: a slot / worktree branch is
      // pushed every time (it is the chat's own), the repo root's branch
      // only when origin does not have it yet.
      if (ws.ownBranch || !(await branchOnOrigin(ws.localPath, branch))) {
        try {
          await pushBranch(ws.localPath, branch);
        } catch (err) {
          throw new CloudSetupError(`could not push ${branch} to origin for the cloud to clone — ${(err as Error).message}`);
        }
        this.note(`Pushed ${branch} to origin.`);
      }
      repo = { url, branch, mountPath: mountPathFor(url), token: token.token };
      resource = [{
        type: 'github_repository',
        url,
        authorization_token: token.token,
        checkout: { type: 'branch', name: branch },
        mount_path: repo.mountPath,
      }];
      dlog('cloud.session.repo', { chatId: this.chatId, url, branch, token: token.source, pushed: ws.ownBranch });
    }

    let sessionId: string;
    try {
      const session = await client.beta.sessions.create({
        agent: agentId,
        environment_id: environmentId,
        title: this.cloud.title.slice(0, 200),
        metadata: { popbot_chat_id: this.chatId },
        ...(resource ? { resources: resource } : {}),
      });
      sessionId = session.id;
    } catch (err) {
      throw new CloudSetupError(`the cloud session could not be created: ${describeApiError(err)}`);
    }
    this.sessionId = sessionId;
    this.lastEventId = null;
    this.seen.clear();
    this.st.ended = false;
    this.preamble = cloudPreamble(repo, this.cloud.languageDirective);
    this.cloud.onCloudUpdate({
      sessionId,
      url: null,
      startedAt: Date.now(),
      lastEventId: null,
      mountPath: repo?.mountPath ?? null,
      branch: repo?.branch ?? null,
      ended: false,
    });
    dlog('cloud.session.created', { chatId: this.chatId, sessionId, agentId, environmentId, repo: repo?.url ?? null });
    this.note(repo
      ? `Cloud session started with ${repo.url} at ${repo.branch}. It keeps running after PopBot quits.`
      : 'Cloud session started (no repository). It keeps running after PopBot quits.');
  }

  // ---- the event stream ----

  private ensureAttached(): Promise<void> {
    if (!this.attaching) {
      this.attaching = this.attach().catch((err) => {
        this.attaching = null;
        throw err;
      });
    }
    return this.attaching;
  }

  /**
   * Open the live stream first (it only carries what happens from now
   * on), then replay the history after the last event this chat saw,
   * then tail the stream. Ids from history are remembered so the two
   * never overlap.
   */
  private async attach(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId || this.disposed) return;
    const client = this.api();
    const controller = new AbortController();
    this.abort = controller;
    let stream: Stream<CloudStreamEvent>;
    try {
      stream = await client.beta.sessions.events.stream(
        sessionId,
        { event_deltas: ['agent.message'] },
        { signal: controller.signal },
      );
    } catch (err) {
      throw new CloudSetupError(`could not attach to the cloud session: ${describeApiError(err)}`);
    }
    await this.catchUp(client, sessionId);
    this.reconnectDelay = RECONNECT_MIN_MS;
    dlog('cloud.attached', { chatId: this.chatId, sessionId, after: this.lastEventId });
    void this.pump(stream, controller);
  }

  private async catchUp(client: Anthropic, sessionId: string): Promise<void> {
    // A session this process just created has nothing to catch up on.
    if (!this.lastEventId && this.preamble !== null) return;
    let skipping = !!this.lastEventId;
    let replayed = 0;
    for await (const ev of client.beta.sessions.events.list(sessionId, { order: 'asc' })) {
      if (skipping) {
        if (ev.id === this.lastEventId) skipping = false;
        this.remember(ev.id);
        continue;
      }
      this.handle(ev as CloudStreamEvent);
      replayed += 1;
    }
    // The watermark was never reached: the session's history no longer
    // contains it (a different session, or events were pruned) — in
    // which case everything above was replayed as new. Fine either way.
    dlog('cloud.catch-up', { chatId: this.chatId, sessionId, replayed, found: !skipping });
  }

  private async pump(stream: Stream<CloudStreamEvent>, controller: AbortController): Promise<void> {
    try {
      for await (const ev of stream) {
        if (controller.signal.aborted) return;
        this.handle(ev);
      }
    } catch (err) {
      if (controller.signal.aborted || this.disposed) return;
      dlog('cloud.stream.dropped', { chatId: this.chatId, error: describeApiError(err) });
    }
    if (controller.signal.aborted || this.disposed || this.st.ended) return;
    // The server closed the stream (or the connection dropped): come back.
    this.attaching = null;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    dlog('cloud.stream.reconnect', { chatId: this.chatId, inMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      void this.ensureAttached().catch((e) => this.reportStreamFailure(e));
    }, delay);
  }

  private handle(ev: CloudStreamEvent): void {
    const id = eventId(ev);
    if (id) {
      if (this.seen.has(id)) return;
      this.remember(id);
    }
    const events = translateEvent(ev, this.st, Date.now());
    for (const e of events) this.onEvent(e);
    if (id) this.recordLastEvent(id);
    if (this.st.ended) {
      this.flushLastEvent();
      this.cloud.onCloudUpdate({ ended: true });
      this.abort?.abort();
    }
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > SEEN_CAP) {
      const oldest = this.seen.values().next().value;
      if (oldest) this.seen.delete(oldest);
    }
  }

  /** The watermark is written a beat after the last event, not on every
   *  one — a turn can produce hundreds. */
  private recordLastEvent(id: string): void {
    this.lastEventId = id;
    if (this.lastEventTimer) return;
    this.lastEventTimer = setTimeout(() => this.flushLastEvent(), LAST_EVENT_FLUSH_MS);
  }

  private flushLastEvent(): void {
    if (this.lastEventTimer) clearTimeout(this.lastEventTimer);
    this.lastEventTimer = null;
    if (this.lastEventId) this.cloud.onCloudUpdate({ lastEventId: this.lastEventId });
  }

  private reportStreamFailure(err: unknown): void {
    if (this.disposed) return;
    const message = err instanceof Error ? err.message : String(err);
    dlog('cloud.attach.failed', { chatId: this.chatId, sessionId: this.sessionId, error: message });
    this.onEvent({ type: 'error', chatId: this.chatId, level: 'warning', retryable: false, message, ts: Date.now() });
  }

  private note(text: string): void {
    this.onEvent({ type: 'note', chatId: this.chatId, prefix: 'cloud', text, ts: Date.now() });
  }
}

/**
 * The user's message as content blocks. Images go in as base64; text
 * files are inlined as documents (the sandbox cannot read this machine's
 * disk); anything else is named so the agent knows it was meant to be
 * there. The typed text goes last, after any preamble.
 */
export async function buildUserContent(
  text: string,
  attachments: PickedAttachment[] | undefined,
  preamble: string | null,
): Promise<UserContentBlock[]> {
  const blocks: UserContentBlock[] = [];
  for (const att of attachments ?? []) {
    const block = await attachmentBlock(att);
    blocks.push(block);
  }
  const body = `${preamble ?? ''}${text}`;
  if (body.trim().length > 0 || blocks.length === 0) blocks.push({ type: 'text', text: body });
  return blocks;
}

async function attachmentBlock(att: PickedAttachment): Promise<UserContentBlock> {
  const media = IMAGE_MEDIA[extname(att.path).toLowerCase()];
  try {
    if (att.isImage && media) {
      const buf = await fsp.readFile(att.path);
      return { type: 'image', source: { type: 'base64', media_type: media, data: buf.toString('base64') } };
    }
    if (att.sizeBytes <= MAX_INLINE_TEXT_BYTES) {
      const buf = await fsp.readFile(att.path);
      if (!buf.subarray(0, 8192).includes(0)) {
        return {
          type: 'document',
          source: { type: 'text', media_type: 'text/plain', data: buf.toString('utf8') },
          title: att.name || basename(att.path),
        };
      }
    }
  } catch {
    /* fall through to the name-only block */
  }
  return {
    type: 'text',
    text: `(The user attached \`${att.name || basename(att.path)}\`, which could not be sent to the cloud sandbox — binary, or too large.)`,
  };
}
