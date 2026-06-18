import { randomUUID } from 'node:crypto';
import type { AgentEvent, PermissionDecision } from '@shared/agent';
import type { AgentBackend, AgentSession, SpawnOpts } from './types';

/**
 * A no-LLM backend useful for wiring + UI tests. Echoes the user's message
 * back as a streamed agent response, with an occasional fake tool call.
 *
 * Replaced by ClaudeBackend once the SDK swap lands.
 */
export const StubBackend: AgentBackend = {
  id: 'stub',
  capabilities: { skills: false, memory: false, subAgents: false, mcpHttp: false },

  spawn(opts: SpawnOpts): AgentSession {
    return new StubSession(opts);
  },
};

class StubSession implements AgentSession {
  private readonly chatId: string;
  private readonly onEvent: (event: AgentEvent) => void;
  private cancelled = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(opts: SpawnOpts) {
    this.chatId = opts.chatId;
    this.onEvent = opts.onEvent;
  }

  async sendUser(text: string): Promise<void> {
    this.cancelled = false;
    const messageId = 'msg_' + randomUUID().replace(/-/g, '').slice(0, 12);
    const ts = Date.now();

    this.emit({ type: 'session-status', chatId: this.chatId, status: 'running', ts });
    this.emit({ type: 'message-start', chatId: this.chatId, messageId, role: 'agent', ts });

    const response = buildStubResponse(text);
    let i = 0;
    let tokens = 0;

    const stream = (): void => {
      if (this.cancelled) return;
      if (i >= response.length) {
        this.emit({
          type: 'message-end',
          chatId: this.chatId,
          messageId,
          ts: Date.now(),
        });
        this.emit({
          type: 'session-status',
          chatId: this.chatId,
          status: 'idle',
          ts: Date.now(),
        });
        return;
      }
      const chunkSize = 1 + Math.floor(Math.random() * 4);
      const delta = response.slice(i, i + chunkSize);
      i += chunkSize;
      tokens += chunkSize;
      this.emit({
        type: 'text-delta',
        chatId: this.chatId,
        messageId,
        delta,
        ts: Date.now(),
      });
      if (i % 60 === 0) {
        this.emit({
          type: 'usage',
          chatId: this.chatId,
          tokens: { used: tokens * 4, budget: 1_000_000 },
          ts: Date.now(),
        });
      }
      const t = setTimeout(stream, 18);
      this.timers.push(t);
    };

    stream();
  }

  approve(_permissionId: string, _decision: PermissionDecision): void {
    // Stub doesn't request permissions; no-op.
  }

  stop(): void {
    this.cancelled = true;
    this.clearTimers();
    this.emit({
      type: 'session-status',
      chatId: this.chatId,
      status: 'idle',
      ts: Date.now(),
    });
  }

  async dispose(): Promise<void> {
    this.cancelled = true;
    this.clearTimers();
  }

  isAlive(): boolean {
    return !this.cancelled;
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private emit(event: AgentEvent): void {
    if (this.cancelled) return;
    this.onEvent(event);
  }
}

function buildStubResponse(userText: string): string {
  const trimmed = userText.trim();
  if (!trimmed) {
    return "(empty message — stub backend has nothing to echo. Try typing something.)";
  }
  return (
    `**Stub backend** received: "${trimmed}"\n\n` +
    `This is a fake response that streams character-by-character to validate the live event pipeline ` +
    `before the real Claude Agent SDK is wired in. The real backend will:\n\n` +
    `- read the conversation history\n` +
    `- call tools (file edits, MCP servers, terminal commands)\n` +
    `- request permission for risky actions\n` +
    `- stream actual reasoning back to this column\n`
  );
}
