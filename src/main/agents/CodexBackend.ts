import {
  Codex,
  type Input as CodexInput,
  type ModelReasoningEffort,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
} from '@openai/codex-sdk';
import type { AgentEvent, PermissionDecision } from '@shared/agent';
import type { PickedAttachment } from '@shared/ipc';
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  codexReasoningEffortsForModel,
} from '@shared/persistence';
import type { AgentBackend, AgentSession, SpawnOpts } from './types';
import { dlog } from '../diagLog';

function toCodexSdkReasoningEffort(
  model: string,
  effort: typeof DEFAULT_CODEX_REASONING_EFFORT | SpawnOpts['codexReasoningEffort'],
): ModelReasoningEffort {
  const resolved = effort ?? DEFAULT_CODEX_REASONING_EFFORT;
  if (resolved === 'none') return 'minimal';
  // `max` is GPT-5.6 Sol's top reasoning rung. The SDK forwards the value
  // verbatim as `model_reasoning_effort`, but its type union hasn't caught
  // up to the CLI yet — hence the cast. Clamp to xhigh for models that
  // don't support max (Terra/Luna/5.5).
  if (resolved === 'max') {
    return codexReasoningEffortsForModel(model).includes('max')
      ? ('max' as ModelReasoningEffort)
      : 'xhigh';
  }
  return resolved;
}

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
  private abortController: AbortController | null = null;
  private running = false;
  private disposed = false;

  constructor(opts: SpawnOpts) {
    this.chatId = opts.chatId;
    this.onEvent = opts.onEvent;
    this.onCodexEvent = opts.onCodexEvent;
    this.onSessionId = opts.onSessionId;
    this.knownThreadId = opts.sessionId ?? null;

    const model = opts.codexModel ?? DEFAULT_CODEX_MODEL;
    const reasoningEffort = opts.codexReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT;
    const sdkReasoningEffort = toCodexSdkReasoningEffort(model, reasoningEffort);
    const codex = new Codex({
      codexPathOverride: opts.pathToCodexExecutable ?? undefined,
    });
    const threadOptions = {
      model,
      modelReasoningEffort: sdkReasoningEffort,
      ...(opts.cwd ? { workingDirectory: opts.cwd } : {}),
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write' as const,
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
      codexPath: opts.pathToCodexExecutable ?? null,
    });
  }

  async sendUser(text: string, attachments?: PickedAttachment[]): Promise<void> {
    if (this.disposed) return;
    if (this.running) {
      this.emit({
        type: 'error',
        chatId: this.chatId,
        message: 'Codex is already running a turn for this chat.',
        ts: Date.now(),
      });
      return;
    }

    this.running = true;
    this.abortController = new AbortController();
    this.emit({ type: 'session-status', chatId: this.chatId, status: 'running', ts: Date.now() });

    try {
      const input = buildCodexInput(text, attachments);
      const { events } = await this.thread.runStreamed(input, {
        signal: this.abortController.signal,
      });
      for await (const event of events) {
        if (this.disposed) return;
        this.cacheRawEvent(event);
        this.handleThreadEvent(event);
      }
    } catch (err) {
      if (this.disposed) return;
      const message = err instanceof Error ? err.message : String(err);
      dlog('codex.turn.error', { chatId: this.chatId, error: message });
      this.emit({
        type: 'error',
        chatId: this.chatId,
        message: this.abortController?.signal.aborted ? 'Codex turn stopped.' : message,
        ts: Date.now(),
      });
      this.emit({
        type: 'session-status',
        chatId: this.chatId,
        status: this.abortController?.signal.aborted ? 'idle' : 'errored',
        ts: Date.now(),
      });
    } finally {
      this.running = false;
      this.abortController = null;
    }
  }

  approve(_permissionId: string, _decision: PermissionDecision): void {
    // The current Codex SDK event stream does not expose interactive
    // approval requests. We run with approvalPolicy='never' and let
    // sandbox-denied operations fail inside the turn.
  }

  stop(): void {
    this.abortController?.abort();
    this.emit({ type: 'session-status', chatId: this.chatId, status: 'idle', ts: Date.now() });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.abortController?.abort();
    this.abortController = null;
    this.running = false;
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
        this.emit({ type: 'session-status', chatId: this.chatId, status: 'running', ts });
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
          ts,
        });
        this.emit({ type: 'session-status', chatId: this.chatId, status: 'errored', ts });
        return;
      case 'error':
        this.emit({ type: 'error', chatId: this.chatId, message: event.message, ts });
        this.emit({ type: 'session-status', chatId: this.chatId, status: 'errored', ts });
        return;
    }
  }

  private handleItem(item: ThreadItem, terminal: boolean, ts: number): void {
    switch (item.type) {
      case 'agent_message':
        this.handleAgentMessage(item.id, item.text, terminal, ts);
        return;
      case 'command_execution':
        this.handleToolItem(
          item.id,
          'Bash',
          { command: item.command },
          item.aggregated_output || `${item.status}`,
          terminal || item.status !== 'in_progress',
          item.status === 'failed' || item.exit_code != null && item.exit_code !== 0,
          ts,
        );
        return;
      case 'file_change':
        this.handleToolItem(
          item.id,
          'ApplyPatch',
          { changes: item.changes },
          `Patch ${item.status}: ${item.changes.map((c) => `${c.kind} ${c.path}`).join(', ')}`,
          terminal || item.status !== 'completed',
          item.status === 'failed',
          ts,
        );
        return;
      case 'mcp_tool_call':
        this.handleToolItem(
          item.id,
          `${item.server}.${item.tool}`,
          { arguments: item.arguments },
          item.error?.message ?? stringifyForDisplay(item.result ?? item.status),
          terminal || item.status !== 'in_progress',
          item.status === 'failed',
          ts,
        );
        return;
      case 'web_search':
        this.handleToolItem(
          item.id,
          'WebSearch',
          { query: item.query },
          item.query,
          terminal,
          false,
          ts,
        );
        return;
      case 'todo_list':
        this.handleToolItem(
          item.id,
          'TodoWrite',
          { items: item.items },
          item.items.map((todo) => `${todo.completed ? '[x]' : '[ ]'} ${todo.text}`).join('\n'),
          terminal,
          false,
          ts,
        );
        return;
      case 'reasoning':
        dlog('codex.reasoning', { chatId: this.chatId, itemId: item.id, textLen: item.text.length });
        return;
      case 'error':
        this.emit({ type: 'error', chatId: this.chatId, message: item.message, ts });
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

function messageIdFor(chatId: string, itemId: string): string {
  return `codex_msg_${safeId(chatId)}_${safeId(itemId)}`;
}

function toolIdFor(chatId: string, itemId: string): string {
  return `codex_tool_${safeId(chatId)}_${safeId(itemId)}`;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_:-]/g, '_').slice(0, 160);
}

function stringifyForDisplay(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value, null, 2);
    return json.length > 5000 ? `${json.slice(0, 5000)}...` : json;
  } catch {
    return String(value);
  }
}
