import {
  Codex,
  type Input as CodexInput,
  type ModelReasoningEffort,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
} from '@openai/codex-sdk';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, PermissionDecision } from '@shared/agent';
import type { PickedAttachment } from '@shared/ipc';
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
} from '@shared/persistence';
import type { AgentBackend, AgentSession, SpawnOpts } from './types';
import { dlog } from '../diagLog';
import {
  EXPECTED_CODEX_LIMIT,
  codexMcpConfig,
  codexMessageId as messageIdFor,
  codexPermissions,
  codexToolId as toolIdFor,
  codexWireReasoningEffort,
  stringifyForDisplay,
} from './codexShared';

/**
 * Real Codex backend. The Codex TypeScript SDK wraps `codex exec
 * --experimental-json`, persists native threads in ~/.codex/sessions,
 * and exposes structured events we adapt into PopBot's AgentEvent
 * stream.
 *
 * PopBot still owns its UI transcript and raw Codex event cache. The
 * native Codex thread id is only the resume handle.
 */
export const CodexBackend: AgentBackend = {
  id: 'codex',
  capabilities: { skills: true, memory: true, subAgents: true, mcpHttp: true },

  spawn(opts: SpawnOpts): AgentSession {
    return new CodexSession(opts);
  },
};

class CodexSession implements AgentSession {
  private readonly chatId: string;
  private readonly onEvent: (event: AgentEvent) => void;
  private readonly onCodexEvent?: SpawnOpts['onCodexEvent'];
  private readonly onSessionId?: (sessionId: string) => void;
  private readonly thread: Thread;
  private knownThreadId: string | null;
  private readonly rawBacklog: ThreadEvent[] = [];
  private readonly openMessages = new Set<string>();
  private readonly agentTextByItem = new Map<string, string>();
  private readonly toolNamesByItem = new Map<string, string>();
  /** Codex item ids (`item_0`, `item_1`, …) restart on every turn. They are
   * only turn-local, while PopBot message ids are SQLite primary keys. Give
   * each backend instance + turn its own namespace so later turns cannot
   * overwrite or fail to insert the earlier turn's visible output. */
  private readonly itemNamespace = randomUUID().replace(/-/g, '').slice(0, 10);
  private turnSequence = 0;
  private abortController: AbortController | null = null;
  private disposed = false;
  /** Whether the current turn emitted anything that makes replay unsafe or
   * unnecessary. A bare turn.started -> turn.completed is an empty response,
   * even when the SDK reports usage for it. */
  private turnHadVisibleActivity = false;
  /** Codex `runStreamed` accepts one turn at a time. The UI intentionally lets
   * users send while an agent is working, so serialize those sends instead of
   * rejecting the second one after PopBot has already persisted it. */
  private turnTail: Promise<void> = Promise.resolve();
  /** Incremented by Stop. Queued callbacks capture the generation they were
   * submitted in and become no-ops when that generation is cancelled. */
  private queueGeneration = 0;

  constructor(opts: SpawnOpts) {
    this.chatId = opts.chatId;
    this.onEvent = opts.onEvent;
    this.onCodexEvent = opts.onCodexEvent;
    this.onSessionId = opts.onSessionId;
    this.knownThreadId = opts.sessionId ?? null;

    const model = opts.codexModel ?? DEFAULT_CODEX_MODEL;
    const reasoningEffort = opts.codexReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT;
    // The SDK forwards this verbatim as `model_reasoning_effort`.
    const sdkReasoningEffort = codexWireReasoningEffort(model, reasoningEffort) as ModelReasoningEffort;
    const permissions = codexPermissions(opts);
    const mcpConfig = codexMcpConfig(opts.mcpServers);
    const codex = new Codex({
      codexPathOverride: opts.pathToCodexExecutable ?? undefined,
      ...(mcpConfig ? { config: { mcp_servers: mcpConfig } } : {}),
    });
    const threadOptions = {
      model,
      modelReasoningEffort: sdkReasoningEffort,
      ...(opts.cwd ? { workingDirectory: opts.cwd } : {}),
      skipGitRepoCheck: true,
      sandboxMode: permissions.sandboxMode,
      networkAccessEnabled: permissions.networkAccessEnabled,
      webSearchMode: permissions.webSearchMode,
      // PopBot has already resolved the shared policy above. Ask fails closed
      // for Codex until its SDK exposes approval requests to the host.
      approvalPolicy: 'never' as const,
    };
    this.thread = this.knownThreadId
      ? codex.resumeThread(this.knownThreadId, threadOptions)
      : codex.startThread(threadOptions);

    dlog('codex.start', {
      chatId: this.chatId,
      cwd: opts.cwd ?? null,
      resumeId: this.knownThreadId,
      model,
      reasoningEffort,
      permissions,
      codexPath: opts.pathToCodexExecutable ?? null,
    });
  }

  async sendUser(text: string, attachments?: PickedAttachment[]): Promise<void> {
    if (this.disposed) return;
    const generation = this.queueGeneration;
    const turn = this.turnTail.then(async () => {
      if (this.disposed || generation !== this.queueGeneration) return;
      await this.runTurn(text, attachments);
    });
    // Accept the turn as soon as it is queued. AgentHost must be able to arm
    // its silence watchdog immediately; awaiting `runTurn` here means a hung
    // Codex stream also hangs the IPC send and the watchdog never starts.
    // Turn failures are emitted by runTurn through the normal event path.
    this.turnTail = turn.catch(() => undefined);
  }

  private async runTurn(text: string, attachments?: PickedAttachment[]): Promise<void> {
    if (this.disposed) return;

    this.turnHadVisibleActivity = false;
    const controller = new AbortController();
    this.abortController = controller;
    this.emit({ type: 'session-status', chatId: this.chatId, status: 'running', ts: Date.now() });

    try {
      const input = buildCodexInput(text, attachments);
      const { events } = await this.thread.runStreamed(input, {
        signal: controller.signal,
      });
      for await (const event of events) {
        if (this.disposed) return;
        this.cacheRawEvent(event);
        this.handleThreadEvent(event);
      }
    } catch (err) {
      if (this.disposed) return;
      const message = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted) {
        dlog('codex.turn.stopped', { chatId: this.chatId });
        this.emit({ type: 'session-status', chatId: this.chatId, status: 'idle', ts: Date.now() });
        return;
      }
      dlog('codex.turn.error', { chatId: this.chatId, error: message });
      this.emit({
        type: 'error',
        chatId: this.chatId,
        message,
        level: EXPECTED_CODEX_LIMIT.test(message) ? 'warning' : 'error',
        ts: Date.now(),
      });
      this.emit({
        type: 'session-status',
        chatId: this.chatId,
        status: 'errored',
        ts: Date.now(),
      });
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }

  approve(_permissionId: string, _decision: PermissionDecision): void {
    // The current Codex SDK event stream does not expose interactive
    // approval requests. We run with approvalPolicy='never' and let
    // sandbox-denied operations fail inside the turn.
  }

  stop(): void {
    this.queueGeneration += 1;
    dlog('codex.stop', {
      chatId: this.chatId,
      generation: this.queueGeneration,
      hadActiveTurn: this.abortController !== null,
    });
    this.abortController?.abort();
    this.emit({ type: 'session-status', chatId: this.chatId, status: 'idle', ts: Date.now() });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.abortController?.abort();
    this.abortController = null;
  }

  isAlive(): boolean {
    return !this.disposed;
  }

  private handleThreadEvent(event: ThreadEvent): void {
    const ts = Date.now();
    switch (event.type) {
      case 'thread.started': {
        this.knownThreadId = event.thread_id;
        this.onSessionId?.(event.thread_id);
        this.flushRawBacklog();
        return;
      }
      case 'turn.started':
        this.turnSequence += 1;
        // This is stronger than our optimistic `running` emitted on send: the
        // CLI has actually dequeued the prompt. AgentHost uses turn-start to
        // clear queued-turn bookkeeping so an old settle timer cannot mark a
        // demonstrably active Codex turn idle.
        this.emit({ type: 'turn-start', chatId: this.chatId, ts });
        return;
      case 'item.started':
      case 'item.updated':
        this.handleItem(event.item, false, ts);
        return;
      case 'item.completed':
        this.handleItem(event.item, true, ts);
        return;
      case 'turn.completed':
        this.finishOpenMessages(ts);
        if (!this.turnHadVisibleActivity) {
          dlog('codex.turn.empty', {
            chatId: this.chatId,
            threadId: this.knownThreadId,
            usage: event.usage,
          });
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
        this.emit({
          type: 'usage',
          chatId: this.chatId,
          tokens: {
            used:
              event.usage.input_tokens
              + event.usage.output_tokens
              + event.usage.reasoning_output_tokens,
            budget: 1_000_000,
          },
          ts,
        });
        this.emit({ type: 'session-status', chatId: this.chatId, status: 'idle', ts });
        return;
      case 'turn.failed':
        this.finishOpenMessages(ts);
        this.emit({
          type: 'error',
          chatId: this.chatId,
          message: event.error.message,
          // An access / usage limit is an ordinary condition the user has
          // to act on (switch model, sign in with an API key, wait) —
          // yellow. Anything else is genuinely unexpected — red.
          level: EXPECTED_CODEX_LIMIT.test(event.error.message) ? 'warning' : 'error',
          ts,
        });
        this.emit({ type: 'session-status', chatId: this.chatId, status: 'errored', ts });
        return;
      case 'error':
        this.emit({
          type: 'error',
          chatId: this.chatId,
          message: event.message,
          level: EXPECTED_CODEX_LIMIT.test(event.message) ? 'warning' : 'error',
          ts,
        });
        this.emit({ type: 'session-status', chatId: this.chatId, status: 'errored', ts });
        return;
    }
  }

  private handleItem(item: ThreadItem, terminal: boolean, ts: number): void {
    const itemId = `${this.itemNamespace}_${this.turnSequence}_${item.id}`;
    switch (item.type) {
      case 'agent_message':
        if (item.text.trim()) this.turnHadVisibleActivity = true;
        this.handleAgentMessage(itemId, item.text, terminal, ts);
        return;
      case 'command_execution':
        this.turnHadVisibleActivity = true;
        this.handleToolItem(
          itemId,
          'Bash',
          { command: item.command },
          item.aggregated_output || `${item.status}`,
          terminal || item.status !== 'in_progress',
          item.status === 'failed' || item.exit_code != null && item.exit_code !== 0,
          ts,
        );
        return;
      case 'file_change':
        this.turnHadVisibleActivity = true;
        this.handleToolItem(
          itemId,
          'ApplyPatch',
          { changes: item.changes },
          `Patch ${item.status}: ${item.changes.map((c) => `${c.kind} ${c.path}`).join(', ')}`,
          terminal || item.status !== 'completed',
          item.status === 'failed',
          ts,
        );
        return;
      case 'mcp_tool_call':
        this.turnHadVisibleActivity = true;
        this.handleToolItem(
          itemId,
          `${item.server}.${item.tool}`,
          { arguments: item.arguments },
          item.error?.message ?? stringifyForDisplay(item.result ?? item.status),
          terminal || item.status !== 'in_progress',
          item.status === 'failed',
          ts,
        );
        return;
      case 'web_search':
        this.turnHadVisibleActivity = true;
        this.handleToolItem(
          itemId,
          'WebSearch',
          { query: item.query },
          item.query,
          terminal,
          false,
          ts,
        );
        return;
      case 'todo_list':
        this.turnHadVisibleActivity = true;
        this.handleToolItem(
          itemId,
          'TodoWrite',
          { items: item.items },
          item.items.map((todo) => `${todo.completed ? '[x]' : '[ ]'} ${todo.text}`).join('\n'),
          terminal,
          false,
          ts,
        );
        return;
      case 'reasoning':
        dlog('codex.reasoning', { chatId: this.chatId, itemId, textLen: item.text.length });
        return;
      case 'error':
        this.emit({
          type: 'error',
          chatId: this.chatId,
          message: item.message,
          level: EXPECTED_CODEX_LIMIT.test(item.message) ? 'warning' : 'error',
          ts,
        });
        return;
    }
  }

  private handleAgentMessage(itemId: string, text: string, terminal: boolean, ts: number): void {
    const messageId = messageIdFor(this.chatId, itemId);
    if (!this.openMessages.has(messageId)) {
      this.openMessages.add(messageId);
      this.agentTextByItem.set(itemId, '');
      this.emit({
        type: 'message-start',
        chatId: this.chatId,
        messageId,
        role: 'agent',
        ts,
      });
    }

    const prior = this.agentTextByItem.get(itemId) ?? '';
    if (text !== prior) {
      const delta = text.startsWith(prior) ? text.slice(prior.length) : text;
      if (delta) {
        this.emit({
          type: 'text-delta',
          chatId: this.chatId,
          messageId,
          delta,
          ts,
        });
      }
      this.agentTextByItem.set(itemId, text);
    }

    if (terminal) {
      this.emit({ type: 'message-end', chatId: this.chatId, messageId, ts });
      this.openMessages.delete(messageId);
      this.agentTextByItem.delete(itemId);
    }
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
    const toolUseId = toolIdFor(this.chatId, itemId);
    if (!this.toolNamesByItem.has(itemId)) {
      this.toolNamesByItem.set(itemId, name);
      this.emit({
        type: 'tool-use',
        chatId: this.chatId,
        messageId: '',
        toolUseId,
        name,
        args,
        ts,
      });
    }
    if (result || terminal) {
      this.emit({
        type: 'tool-result',
        chatId: this.chatId,
        messageId: '',
        toolUseId,
        text: result,
        isError,
        ts,
      });
    }
    if (terminal) this.toolNamesByItem.delete(itemId);
  }

  private finishOpenMessages(ts: number): void {
    for (const messageId of this.openMessages) {
      this.emit({ type: 'message-end', chatId: this.chatId, messageId, ts });
    }
    this.openMessages.clear();
    this.agentTextByItem.clear();
  }

  private cacheRawEvent(event: ThreadEvent): void {
    if (event.type === 'thread.started') {
      this.knownThreadId = event.thread_id;
    }
    if (!this.knownThreadId) {
      this.rawBacklog.push(event);
      return;
    }
    this.onCodexEvent?.({
      chatId: this.chatId,
      threadId: this.knownThreadId,
      eventType: event.type,
      payload: event,
    });
  }

  private flushRawBacklog(): void {
    if (!this.knownThreadId || this.rawBacklog.length === 0) return;
    const backlog = this.rawBacklog.splice(0);
    for (const event of backlog) this.cacheRawEvent(event);
  }

  private emit(event: AgentEvent): void {
    if (this.disposed) return;
    this.onEvent(event);
  }
}

function buildCodexInput(text: string, attachments?: PickedAttachment[]): CodexInput {
  if (!attachments || attachments.length === 0) return text;
  const input: Array<{ type: 'text'; text: string } | { type: 'local_image'; path: string }> = [];
  for (const att of attachments) {
    if (att.isImage) {
      input.push({ type: 'local_image', path: att.path });
    } else {
      input.push({ type: 'text', text: `Attached file: \`${att.path}\`` });
    }
  }
  if (text.trim()) input.push({ type: 'text', text });
  return input;
}
