/**
 * Codex backend over `codex app-server` — the JSON-RPC protocol the Codex
 * desktop app and IDE extension use. Opt-in (Preferences ▸ Agents); the
 * default remains CodexBackend, which drives the exec SDK.
 *
 * Why a second backend exists: the exec SDK takes one prompt and runs one
 * turn. It has no way to hand the model anything while that turn is
 * running, so a message sent mid-turn can only wait for the turn to end.
 * The app-server has `turn/steer`: the message is folded into the ACTIVE
 * turn, and the model sees it at its very next step — typically the
 * moment the tool call in flight returns. Same protocol also reports
 * context usage after every step, compacts on request, and interrupts a
 * turn properly instead of killing a process.
 *
 * One `codex app-server` process per chat session (about 50 MB each):
 * the simplest lifecycle, and a crash takes down one chat, not all of
 * them. Threads are the same rollouts under ~/.codex/sessions that the
 * exec SDK writes, so a chat moves between the two backends freely.
 *
 * Per CORE_MODEL.md: this backend never writes to the DB. It emits
 * AgentEvents; AgentHost persists + broadcasts.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import type { AgentEvent, PermissionDecision } from '@shared/agent';
import type { PickedAttachment } from '@shared/ipc';
import { DEFAULT_CONTEXT_BUDGET } from '@shared/contextUsage';
import { DEFAULT_CODEX_MODEL, DEFAULT_CODEX_REASONING_EFFORT } from '@shared/persistence';
import type { AgentBackend, AgentSession, SpawnOpts } from './types';
import { dlog } from '../diagLog';
import {
  CodexRpcClient,
  CodexRpcError,
  RPC_CLOSED,
  RPC_METHOD_NOT_FOUND,
  spawnCodexAppServer,
  type LineTransport,
} from './codexRpc';
import {
  EXPECTED_CODEX_LIMIT,
  codexMessageId,
  codexPermissions,
  codexToolId,
  codexWireReasoningEffort,
  stringifyForDisplay,
} from './codexShared';

// --- Wire shapes. Only what this file reads; generate the full set with
// --- `codex app-server generate-ts --out <dir>` when extending it.

type WireInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'localImage'; path: string };

interface WireItem {
  type: string;
  id: string;
  clientId?: string | null;
  text?: string;
  command?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  changes?: Array<{ path: string; kind?: { type?: string } }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string } | null;
  query?: string;
}

interface WireTurn {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error: { message?: string; codexErrorInfo?: unknown } | null;
}

/**
 * A message steered into a turn, kept until Codex shows it was injected.
 *
 * `accepted` decides who owns it if the turn ends first. While the steer
 * request is still in flight the send that made it owns it, and will
 * start a turn with it if the answer is "no active turn". Once accepted,
 * the turn-completion handler owns it and re-sends it if it never
 * surfaced. Exactly one of them acts, so it is neither lost nor doubled.
 */
interface PendingSteer {
  clientId: string;
  input: WireInput[];
  accepted: boolean;
}

export const CodexAppServerBackend: AgentBackend = {
  id: 'codex',
  capabilities: { skills: true, memory: true, subAgents: true, mcpHttp: true },

  spawn(opts: SpawnOpts): AgentSession {
    return new CodexAppServerSession(opts, () => {
      const bin = resolveCodexBinary(opts.pathToCodexExecutable ?? null);
      return spawnCodexAppServer(bin.path, bin.pathDirs);
    });
  },
};

/** Test seam: the same session against a scripted transport. */
export function createCodexAppServerSession(
  opts: SpawnOpts,
  connect: () => LineTransport,
): AgentSession {
  return new CodexAppServerSession(opts, connect);
}

class CodexAppServerSession implements AgentSession {
  private readonly chatId: string;
  private readonly onEvent: (event: AgentEvent) => void;
  private readonly onSessionId?: (id: string) => void;
  private readonly onCodexEvent?: SpawnOpts['onCodexEvent'];
  private readonly model: string;
  private readonly effort: string;
  private readonly rpc: CodexRpcClient;
  private readonly ready: Promise<void>;

  private threadId: string | null;
  private activeTurnId: string | null = null;
  private disposed = false;
  private closed = false;
  /** `turn/steer` answered "method not found": an older CLI. Messages
   *  sent mid-turn then wait for the turn to end, as with the exec SDK. */
  private steerSupported = true;
  /** Sends are decided one at a time — whether to steer or start a turn
   *  depends on state the previous send may still be changing. */
  private sendChain: Promise<void> = Promise.resolve();
  /** Bumped by Stop; work queued under an older generation is dropped. */
  private generation = 0;
  /** Steered, accepted, not yet seen as a userMessage item. If the turn
   *  ends first they are re-sent as a new turn: a message is never lost. */
  private pendingSteers: PendingSteer[] = [];
  /** Messages that could not be steered (a compact or review turn, or an
   *  old CLI) — sent together as the next turn when this one ends. */
  private deferred: WireInput[][] = [];

  private turnHadVisibleActivity = false;
  /** Latest context fill, for a compaction's before/after. */
  private lastUsedTokens = 0;
  private compactionPreTokens: number | null = null;
  private compactionStartedAt = 0;
  /** A non-retried error the server reported for the running turn. */
  private lastTurnError: string | null = null;

  private readonly openMessages = new Set<string>();
  private readonly agentTextByItem = new Map<string, string>();
  private readonly openTools = new Set<string>();
  private planToolTurn: string | null = null;

  constructor(opts: SpawnOpts, connect: () => LineTransport) {
    this.chatId = opts.chatId;
    this.onEvent = opts.onEvent;
    this.onSessionId = opts.onSessionId;
    this.onCodexEvent = opts.onCodexEvent;
    this.threadId = opts.sessionId ?? null;
    this.model = opts.codexModel ?? DEFAULT_CODEX_MODEL;
    this.effort = codexWireReasoningEffort(
      this.model,
      opts.codexReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
    );

    let transport: LineTransport;
    try {
      transport = connect();
    } catch (err) {
      transport = deadTransport(err instanceof Error ? err.message : String(err));
    }
    this.rpc = new CodexRpcClient(transport, {
      onNotification: (method, params) => this.handleNotification(method, params),
      onServerRequest: (id, method, params) => this.handleServerRequest(id, method, params),
      onClose: (reason) => this.handleClose(reason),
    });
    this.ready = this.open(opts);
    // Surfaced by whichever send awaits it; never an unhandled rejection.
    this.ready.catch(() => undefined);
  }

  // ---------------------------------------------------------------- lifecycle

  private async open(opts: SpawnOpts): Promise<void> {
    const permissions = codexPermissions(opts);
    await this.rpc.request('initialize', {
      clientInfo: { name: 'popbot', title: 'PopBot', version: safeAppVersion() },
      capabilities: null,
    });
    this.rpc.notify('initialized');

    const overrides = {
      model: this.model,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      // PopBot has already resolved its shared policy into the sandbox
      // below. Ask fails closed until approvals are surfaced to the host.
      approvalPolicy: 'never',
      sandbox: permissions.sandboxMode,
      config: {
        model_reasoning_effort: this.effort,
        web_search: permissions.webSearchMode,
        sandbox_workspace_write: { network_access: permissions.networkAccessEnabled },
      },
    };
    dlog('codex.app-server.start', {
      chatId: this.chatId,
      cwd: opts.cwd ?? null,
      resumeId: this.threadId,
      model: this.model,
      reasoningEffort: this.effort,
      permissions,
      codexPath: opts.pathToCodexExecutable ?? null,
    });

    if (this.threadId) {
      try {
        await this.rpc.request('thread/resume', {
          threadId: this.threadId,
          excludeTurns: true,
          ...overrides,
        });
      } catch (err) {
        // Worded so AgentHost recognises a lost thread and restarts the
        // chat with its transcript, as it does for the exec backend.
        throw new Error(`Codex thread not found — could not resume ${this.threadId}: ${errorText(err)}`);
      }
    } else {
      const started = await this.rpc.request<{ thread: { id: string } }>('thread/start', overrides);
      this.threadId = started.thread.id;
    }
    if (this.threadId) this.onSessionId?.(this.threadId);
  }

  async sendUser(text: string, attachments?: PickedAttachment[]): Promise<void> {
    if (this.disposed) return;
    const generation = this.generation;
    const input = buildInput(text, attachments);
    // Resolve at once. AgentHost records the send (and arms its stall
    // clock) the instant this returns; doing the RPC first would let the
    // server's answer race that bookkeeping.
    this.sendChain = this.sendChain
      .then(() => this.deliver(input, generation))
      .catch((err) => this.failSend(err));
  }

  private async deliver(input: WireInput[], generation: number): Promise<void> {
    await this.ready;
    if (this.disposed || generation !== this.generation) return;

    if (this.activeTurnId) {
      if (!this.steerSupported) {
        this.deferred.push(input);
        return;
      }
      const steer: PendingSteer = { clientId: randomUUID(), input, accepted: false };
      const expectedTurnId = this.activeTurnId;
      this.pendingSteers.push(steer);
      try {
        await this.rpc.request('turn/steer', {
          threadId: this.threadId,
          expectedTurnId,
          clientUserMessageId: steer.clientId,
          input,
        });
        steer.accepted = true;
        const surfaced = !this.pendingSteers.includes(steer);
        if (surfaced || this.activeTurnId === expectedTurnId) {
          dlog('codex.app-server.steered', { chatId: this.chatId, turnId: expectedTurnId });
          this.emit({ type: 'turn-steered', chatId: this.chatId, ts: Date.now() });
          return;
        }
        // Accepted, but by the time we heard, that turn was over and the
        // message never surfaced in it. It goes as a turn instead.
        this.pendingSteers = this.pendingSteers.filter((s) => s !== steer);
        dlog('codex.app-server.steer-missed-turn', { chatId: this.chatId, turnId: expectedTurnId });
      } catch (err) {
        this.pendingSteers = this.pendingSteers.filter((s) => s !== steer);
        const why = classifySteerFailure(err);
        dlog('codex.app-server.steer-refused', {
          chatId: this.chatId,
          turnId: expectedTurnId,
          why,
          error: errorText(err),
        });
        if (why === 'unsupported') this.steerSupported = false;
        if (why === 'unsupported' || why === 'not-steerable') {
          // The turn carries on without it; it goes next.
          this.deferred.push(input);
          return;
        }
        if (why === 'closed') throw err;
        // 'no-active-turn' — the turn ended while we were asking. This
        // send still owns the message, so it starts the turn itself.
      }
      if (this.activeTurnId) {
        // Another turn is already under way (a held message got there
        // first). Go round again and steer into that one.
        if (this.disposed || generation !== this.generation) return;
        await this.deliver(input, generation);
        return;
      }
    }
    if (this.disposed || generation !== this.generation) return;
    await this.startTurn(input);
  }

  private async startTurn(input: WireInput[]): Promise<void> {
    this.emit({ type: 'session-status', chatId: this.chatId, status: 'running', ts: Date.now() });
    const res = await this.rpc.request<{ turn: { id: string } }>('turn/start', {
      threadId: this.threadId,
      input,
      effort: this.effort,
    });
    // `turn/started` usually lands first; either way this is the turn.
    if (!this.activeTurnId && res?.turn?.id) this.activeTurnId = res.turn.id;
  }

  private failSend(err: unknown): void {
    if (this.disposed) return;
    const message = errorText(err);
    dlog('codex.app-server.send-failed', { chatId: this.chatId, error: message });
    const ts = Date.now();
    this.emit({
      type: 'error',
      chatId: this.chatId,
      message,
      level: EXPECTED_CODEX_LIMIT.test(message) ? 'warning' : 'error',
      ts,
    });
    this.emit({ type: 'session-status', chatId: this.chatId, status: 'errored', ts });
  }

  approve(_permissionId: string, _decision: PermissionDecision): void {
    // approvalPolicy is 'never': Codex doesn't ask. See handleServerRequest.
  }

  stop(): void {
    this.generation += 1;
    this.deferred = [];
    this.pendingSteers = [];
    const turnId = this.activeTurnId;
    dlog('codex.app-server.stop', { chatId: this.chatId, turnId });
    if (turnId && this.threadId) {
      this.rpc
        .request('turn/interrupt', { threadId: this.threadId, turnId })
        .catch((err) => dlog('codex.app-server.interrupt-failed', { chatId: this.chatId, error: errorText(err) }));
    }
    this.emit({ type: 'session-status', chatId: this.chatId, status: 'idle', ts: Date.now() });
  }

  /** Manual compaction. Runs as a turn of its own; progress arrives as a
   *  `contextCompaction` item and is reported from there. Fire-and-return
   *  for the same reason sendUser is. */
  async compact(): Promise<void> {
    await this.ready;
    if (this.disposed) return;
    if (this.activeTurnId) throw new Error('Codex is busy — compact once the current turn ends.');
    this.rpc.request('thread/compact/start', { threadId: this.threadId }).catch((err) => {
      if (this.disposed) return;
      const ts = Date.now();
      this.emit({ type: 'compaction', chatId: this.chatId, phase: 'failed', error: errorText(err), ts });
      this.emit({ type: 'session-status', chatId: this.chatId, status: 'idle', ts });
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.rpc.close();
  }

  isAlive(): boolean {
    return !this.disposed && !this.closed;
  }

  private handleClose(reason: string): void {
    this.closed = true;
    if (this.disposed) return;
    dlog('codex.app-server.closed', { chatId: this.chatId, reason, activeTurn: this.activeTurnId });
    // Between turns a dead process is harmless: isAlive() is false, so
    // AgentHost respawns and resumes the thread on the next send.
    if (!this.activeTurnId) return;
    this.activeTurnId = null;
    const ts = Date.now();
    this.finishOpenMessages(ts);
    this.emit({
      type: 'error',
      chatId: this.chatId,
      message: reason,
      level: EXPECTED_CODEX_LIMIT.test(reason) ? 'warning' : 'error',
      ts,
    });
    this.emit({ type: 'session-status', chatId: this.chatId, status: 'errored', ts });
  }

  // ------------------------------------------------------------ server → us

  private handleServerRequest(id: number | string, method: string, _params: unknown): void {
    dlog('codex.app-server.server-request', { chatId: this.chatId, method });
    // Not expected under approvalPolicy 'never'. If one arrives anyway,
    // refuse rather than leave the turn waiting on an answer forever.
    if (/requestApproval$|Approval$/.test(method)) {
      this.rpc.respond(id, { decision: 'decline' });
      return;
    }
    this.rpc.respondError(id, RPC_METHOD_NOT_FOUND, `PopBot does not handle ${method}`);
  }

  private handleNotification(method: string, raw: unknown): void {
    if (this.disposed) return;
    const p = (raw ?? {}) as Record<string, unknown>;
    const ts = Date.now();
    this.cacheRaw(method, raw);

    switch (method) {
      case 'turn/started': {
        const turn = p.turn as WireTurn | undefined;
        if (!turn?.id) return;
        this.activeTurnId = turn.id;
        this.turnHadVisibleActivity = false;
        this.lastTurnError = null;
        this.planToolTurn = null;
        // Stronger than the optimistic 'running' emitted on send: Codex has
        // actually picked the prompt up. Clears AgentHost's queued count.
        this.emit({ type: 'turn-start', chatId: this.chatId, ts });
        return;
      }
      case 'item/started':
        this.handleItem(p.item as WireItem | undefined, String(p.turnId ?? ''), false, ts);
        return;
      case 'item/completed':
        this.handleItem(p.item as WireItem | undefined, String(p.turnId ?? ''), true, ts);
        return;
      case 'item/agentMessage/delta':
        this.handleAgentDelta(String(p.turnId ?? ''), String(p.itemId ?? ''), String(p.delta ?? ''), ts);
        return;
      case 'turn/plan/updated':
        this.handlePlan(String(p.turnId ?? ''), p.plan, ts);
        return;
      case 'thread/tokenUsage/updated': {
        const usage = p.tokenUsage as
          | { last?: { totalTokens?: number }; modelContextWindow?: number | null }
          | undefined;
        const used = usage?.last?.totalTokens;
        if (typeof used !== 'number') return;
        this.lastUsedTokens = used;
        this.emit({
          type: 'usage',
          chatId: this.chatId,
          tokens: { used, budget: usage?.modelContextWindow || DEFAULT_CONTEXT_BUDGET },
          ts,
        });
        return;
      }
      case 'error': {
        const message = (p.error as { message?: string } | undefined)?.message ?? 'Codex reported an error';
        dlog('codex.app-server.error', { chatId: this.chatId, willRetry: p.willRetry === true, message });
        // Codex retries these itself; only the last word matters, and
        // that arrives on the failed turn.
        if (p.willRetry !== true) this.lastTurnError = message;
        return;
      }
      case 'turn/completed':
        this.handleTurnCompleted(p.turn as WireTurn | undefined, ts);
        return;
      default:
        return;
    }
  }

  private handleTurnCompleted(turn: WireTurn | undefined, ts: number): void {
    if (!turn) return;
    this.finishOpenMessages(ts);
    this.activeTurnId = null;

    // Anything that never made it INTO the turn goes next, as one turn:
    // steers Codex accepted but never injected, and messages that could
    // not be steered at all. A steer whose request is still in flight is
    // not ours to take — see PendingSteer.
    const leftovers = [
      ...this.pendingSteers.filter((s) => s.accepted).map((s) => s.input),
      ...this.deferred,
    ];
    this.pendingSteers = this.pendingSteers.filter((s) => !s.accepted);
    this.deferred = [];

    if (turn.status === 'failed') {
      const message = turn.error?.message ?? this.lastTurnError ?? 'Codex turn failed';
      dlog('codex.app-server.turn-failed', { chatId: this.chatId, turnId: turn.id, message });
      this.emit({
        type: 'error',
        chatId: this.chatId,
        message,
        // An access / usage limit is an ordinary condition the user has
        // to act on — yellow. Anything else is genuinely unexpected — red.
        level: EXPECTED_CODEX_LIMIT.test(message) ? 'warning' : 'error',
        ts,
      });
      this.emit({ type: 'session-status', chatId: this.chatId, status: 'errored', ts });
      return;
    }

    // Also after an interrupt: Stop clears its own queue, so anything
    // still here was sent AFTER the Stop and is a fresh instruction.
    if (leftovers.length > 0) {
      const generation = this.generation;
      dlog('codex.app-server.deferred-turn', { chatId: this.chatId, messages: leftovers.length });
      // Through deliver(), not startTurn(): by the time this runs a send
      // that was already in flight may have started the next turn, and
      // then these belong in it.
      this.sendChain = this.sendChain
        .then(() => this.deliver(leftovers.flat(), generation))
        .catch((err) => this.failSend(err));
      return;
    }

    // A send is mid-flight and will start the next turn itself; saying
    // 'idle' now would only flicker.
    if (this.pendingSteers.length > 0) return;

    if (turn.status === 'completed' && !this.turnHadVisibleActivity) {
      dlog('codex.app-server.turn-empty', { chatId: this.chatId, threadId: this.threadId });
      this.emit({
        type: 'error',
        chatId: this.chatId,
        message: 'Codex completed the turn without producing a response.',
        level: 'notice',
        retryable: true,
        ts,
      });
      return;
    }
    // Completed, or interrupted by Stop (which already reported idle).
    this.emit({ type: 'session-status', chatId: this.chatId, status: 'idle', ts });
  }

  private handleItem(item: WireItem | undefined, turnId: string, terminal: boolean, ts: number): void {
    if (!item?.type || !item.id) return;
    const itemId = `${turnId}_${item.id}`;
    switch (item.type) {
      case 'userMessage':
        // A steered message surfacing in the turn: it is in. PopBot already
        // has the user's bubble, so there is nothing to render.
        if (item.clientId) {
          this.pendingSteers = this.pendingSteers.filter((s) => s.clientId !== item.clientId);
        }
        return;
      case 'agentMessage':
        this.handleAgentMessage(itemId, item.text ?? '', terminal, ts);
        return;
      case 'commandExecution': {
        const status = item.status ?? 'inProgress';
        this.handleToolItem(
          itemId,
          'Bash',
          { command: item.command ?? '' },
          item.aggregatedOutput || (terminal ? status : ''),
          terminal,
          status === 'failed' || status === 'declined' || (item.exitCode != null && item.exitCode !== 0),
          ts,
        );
        return;
      }
      case 'fileChange': {
        const changes = (item.changes ?? []).map((c) => ({ kind: c.kind?.type ?? 'update', path: c.path }));
        this.handleToolItem(
          itemId,
          'ApplyPatch',
          { changes },
          terminal ? `Patch ${item.status ?? 'completed'}: ${changes.map((c) => `${c.kind} ${c.path}`).join(', ')}` : '',
          terminal,
          item.status === 'failed' || item.status === 'declined',
          ts,
        );
        return;
      }
      case 'mcpToolCall':
        this.handleToolItem(
          itemId,
          `${item.server ?? 'mcp'}.${item.tool ?? 'tool'}`,
          { arguments: item.arguments },
          terminal ? item.error?.message ?? stringifyForDisplay(item.result ?? item.status) : '',
          terminal,
          item.status === 'failed',
          ts,
        );
        return;
      case 'webSearch':
        this.handleToolItem(itemId, 'WebSearch', { query: item.query ?? '' }, terminal ? item.query ?? '' : '', terminal, false, ts);
        return;
      case 'contextCompaction':
        this.handleCompactionItem(terminal, ts);
        return;
      default:
        // reasoning, plan text, review markers, sub-agent activity: not
        // transcript rows today.
        return;
    }
  }

  private handleAgentMessage(itemId: string, text: string, terminal: boolean, ts: number): void {
    const messageId = this.openMessage(itemId, ts);
    const prior = this.agentTextByItem.get(itemId) ?? '';
    // Deltas normally carry the text; the item's own text is the source
    // of truth for anything they missed.
    if (text && text !== prior) {
      const delta = text.startsWith(prior) ? text.slice(prior.length) : prior ? '' : text;
      if (delta) this.emit({ type: 'text-delta', chatId: this.chatId, messageId, delta, ts });
      this.agentTextByItem.set(itemId, text);
    }
    if ((this.agentTextByItem.get(itemId) ?? '').trim()) this.turnHadVisibleActivity = true;
    if (terminal) {
      this.emit({ type: 'message-end', chatId: this.chatId, messageId, ts });
      this.openMessages.delete(messageId);
      this.agentTextByItem.delete(itemId);
    }
  }

  private handleAgentDelta(turnId: string, rawItemId: string, delta: string, ts: number): void {
    if (!rawItemId || !delta) return;
    const itemId = `${turnId}_${rawItemId}`;
    const messageId = this.openMessage(itemId, ts);
    this.agentTextByItem.set(itemId, (this.agentTextByItem.get(itemId) ?? '') + delta);
    this.turnHadVisibleActivity = true;
    this.emit({ type: 'text-delta', chatId: this.chatId, messageId, delta, ts });
  }

  private openMessage(itemId: string, ts: number): string {
    const messageId = codexMessageId(this.chatId, itemId);
    if (!this.openMessages.has(messageId)) {
      this.openMessages.add(messageId);
      this.agentTextByItem.set(itemId, '');
      this.emit({ type: 'message-start', chatId: this.chatId, messageId, role: 'agent', ts });
    }
    return messageId;
  }

  private handleToolItem(
    itemId: string,
    name: string,
    args: Record<string, unknown>,
    result: string,
    terminal: boolean,
    isError: boolean,
    ts: number,
  ): void {
    this.turnHadVisibleActivity = true;
    const toolUseId = codexToolId(this.chatId, itemId);
    if (!this.openTools.has(itemId)) {
      this.openTools.add(itemId);
      this.emit({ type: 'tool-use', chatId: this.chatId, messageId: '', toolUseId, name, args, ts });
    }
    if (result || terminal) {
      this.emit({ type: 'tool-result', chatId: this.chatId, messageId: '', toolUseId, text: result, isError, ts });
    }
    if (terminal) this.openTools.delete(itemId);
  }

  /** The plan is a per-turn checklist that is rewritten as it progresses;
   *  one TodoWrite row per turn, updated in place. */
  private handlePlan(turnId: string, plan: unknown, ts: number): void {
    if (!Array.isArray(plan) || plan.length === 0) return;
    this.turnHadVisibleActivity = true;
    const steps = plan as Array<{ step?: string; status?: string }>;
    const toolUseId = codexToolId(this.chatId, `${turnId}_plan`);
    const items = steps.map((s) => ({ text: s.step ?? '', completed: s.status === 'completed' }));
    if (this.planToolTurn !== turnId) {
      this.planToolTurn = turnId;
      this.emit({ type: 'tool-use', chatId: this.chatId, messageId: '', toolUseId, name: 'TodoWrite', args: { items }, ts });
    }
    this.emit({
      type: 'tool-result',
      chatId: this.chatId,
      messageId: '',
      toolUseId,
      text: items.map((t) => `${t.completed ? '[x]' : '[ ]'} ${t.text}`).join('\n'),
      isError: false,
      ts,
    });
  }

  /** Manual (`thread/compact/start`) and Codex's own automatic compaction
   *  both show up as this item. Usage is reported between its start and
   *  its completion, which is where the "after" figure comes from. */
  private handleCompactionItem(terminal: boolean, ts: number): void {
    this.turnHadVisibleActivity = true;
    if (!terminal) {
      this.compactionPreTokens = this.lastUsedTokens || null;
      this.compactionStartedAt = ts;
      this.emit({ type: 'compaction', chatId: this.chatId, phase: 'started', ts });
      return;
    }
    const pre = this.compactionPreTokens;
    const post = this.lastUsedTokens;
    this.compactionPreTokens = null;
    this.emit({
      type: 'compaction',
      chatId: this.chatId,
      phase: 'done',
      ...(pre && post && post < pre ? { preTokens: pre, postTokens: post } : {}),
      ...(this.compactionStartedAt ? { durationMs: ts - this.compactionStartedAt } : {}),
      ts,
    });
  }

  private finishOpenMessages(ts: number): void {
    for (const messageId of this.openMessages) {
      this.emit({ type: 'message-end', chatId: this.chatId, messageId, ts });
    }
    this.openMessages.clear();
    this.agentTextByItem.clear();
    this.openTools.clear();
  }

  /** PopBot keeps its own recovery copy of the raw stream. Deltas are
   *  skipped: they are the bulk of the traffic and the completed items
   *  carry the same content. */
  private cacheRaw(method: string, payload: unknown): void {
    if (!this.onCodexEvent || !this.threadId) return;
    if (/delta|Delta$/.test(method)) return;
    if (!/^(turn|item|thread\/(started|compacted|tokenUsage)|error)/.test(method)) return;
    this.onCodexEvent({ chatId: this.chatId, threadId: this.threadId, eventType: method, payload });
  }

  private emit(event: AgentEvent): void {
    if (this.disposed) return;
    this.onEvent(event);
  }
}

// ------------------------------------------------------------------ helpers

function buildInput(text: string, attachments?: PickedAttachment[]): WireInput[] {
  const input: WireInput[] = [];
  for (const att of attachments ?? []) {
    if (att.isImage) input.push({ type: 'localImage', path: att.path });
    else input.push({ type: 'text', text: `Attached file: \`${att.path}\``, text_elements: [] });
  }
  // Attachments first, then the ask — same order as the exec backend.
  if (text.trim() || input.length === 0) input.push({ type: 'text', text, text_elements: [] });
  return input;
}

type SteerFailure = 'unsupported' | 'not-steerable' | 'no-active-turn' | 'closed';

function classifySteerFailure(err: unknown): SteerFailure {
  if (!(err instanceof CodexRpcError)) return 'closed';
  if (err.code === RPC_METHOD_NOT_FOUND) return 'unsupported';
  if (err.code === RPC_CLOSED) return 'closed';
  const info = (err.data as { codexErrorInfo?: unknown } | undefined)?.codexErrorInfo;
  if (info && typeof info === 'object' && 'activeTurnNotSteerable' in info) return 'not-steerable';
  if (/cannot steer/i.test(err.message)) return 'not-steerable';
  // "no active turn to steer", or an expectedTurnId that no longer matches.
  return 'no-active-turn';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeAppVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return '0.0.0';
  }
}

/** A transport that was never there — so a failed spawn surfaces through
 *  the same path as a process that died. */
function deadTransport(reason: string): LineTransport {
  let onClose: ((reason: string) => void) | null = null;
  queueMicrotask(() => onClose?.(`could not start codex app-server: ${reason}`));
  return {
    send: () => undefined,
    onLine: () => undefined,
    onClose: (h) => {
      onClose = h;
    },
    close: () => undefined,
  };
}

const PLATFORM_PACKAGE: Record<string, { pkg: string; triple: string }> = {
  'darwin-arm64': { pkg: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
  'darwin-x64': { pkg: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' },
  'linux-arm64': { pkg: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
  'linux-x64': { pkg: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
  'win32-arm64': { pkg: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
  'win32-x64': { pkg: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
};

/**
 * The user's own `codex` when the startup probe found one — freshest
 * version, and exactly the auth they test in a terminal. Otherwise the
 * binary that ships with the SDK dependency (same lookup the SDK does),
 * and failing that, whatever `codex` resolves to on PATH.
 */
export function resolveCodexBinary(userPath: string | null): { path: string; pathDirs: string[] } {
  if (userPath) return { path: userPath, pathDirs: [] };
  try {
    const target = PLATFORM_PACKAGE[`${process.platform}-${process.arch}`];
    const appRoot = typeof (app as { getAppPath?: () => string }).getAppPath === 'function'
      ? app.getAppPath()
      : process.cwd();
    if (target) {
      const fromApp = createRequire(join(appRoot, 'package.json'));
      const fromCodex = createRequire(fromApp.resolve('@openai/codex/package.json'));
      const root = join(dirname(fromCodex.resolve(`${target.pkg}/package.json`)), 'vendor', target.triple);
      const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
      for (const [bin, extra] of [[join(root, 'bin', exe), join(root, 'codex-path')], [join(root, 'codex', exe), join(root, 'path')]]) {
        // A binary inside app.asar can't be executed; use the unpacked copy.
        const real = bin.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
        if (existsSync(real)) return { path: real, pathDirs: existsSync(extra) ? [extra] : [] };
      }
    }
  } catch {
    // fall through
  }
  return { path: 'codex', pathDirs: [] };
}
