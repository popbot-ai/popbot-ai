import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/agent';
import { createCodexAppServerSession } from './CodexAppServerBackend';
import type { LineTransport } from './codexRpc';
import type { SpawnOpts } from './types';

interface Sent {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/**
 * A scripted `codex app-server`. Requests are answered by `answer`, which
 * a test can replace; notifications are pushed with `notify`.
 */
class FakeServer implements LineTransport {
  readonly sent: Sent[] = [];
  answer: (msg: Sent) => { result?: unknown; error?: { code: number; message: string; data?: unknown } } | null =
    defaultAnswer;
  private lineHandler: (line: string) => void = () => undefined;
  private closeHandler: (reason: string) => void = () => undefined;
  closedByClient = false;

  send(line: string): void {
    const msg = JSON.parse(line) as Sent;
    this.sent.push(msg);
    if (msg.id === undefined || msg.method === undefined) return;
    const reply = this.answer(msg);
    if (!reply) return;
    // Like a real pipe: the answer arrives on a later tick.
    queueMicrotask(() => this.lineHandler(JSON.stringify({ id: msg.id, ...reply })));
  }
  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler;
  }
  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }
  close(): void {
    this.closedByClient = true;
  }

  notify(method: string, params: unknown): void {
    this.lineHandler(JSON.stringify({ method, params }));
  }
  die(reason: string): void {
    this.closeHandler(reason);
  }
  methods(): string[] {
    return this.sent.filter((m) => m.method).map((m) => m.method as string);
  }
  last(method: string): Sent {
    const found = [...this.sent].reverse().find((m) => m.method === method);
    if (!found) throw new Error(`no ${method} was sent; saw ${this.methods().join(', ')}`);
    return found;
  }
}

function defaultAnswer(msg: Sent): { result: unknown } {
  switch (msg.method) {
    case 'thread/start':
      return { result: { thread: { id: 'thread-1' } } };
    case 'turn/start':
      return { result: { turn: { id: 'turn-1' } } };
    case 'turn/steer':
      return { result: { turnId: 'turn-1' } };
    default:
      return { result: {} };
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

function harness(over: Partial<SpawnOpts> = {}) {
  const server = new FakeServer();
  const events: AgentEvent[] = [];
  const sessionIds: string[] = [];
  const session = createCodexAppServerSession(
    {
      chatId: 'chat_1',
      history: [],
      cwd: '/work',
      codexModel: 'gpt-5.6-sol',
      codexReasoningEffort: 'high',
      onEvent: (e) => events.push(e),
      onSessionId: (id) => sessionIds.push(id),
      resolveRule: () => null,
      ...over,
    },
    () => server,
  );
  const types = (): string[] => events.map((e) => (e.type === 'session-status' ? `status:${e.status}` : e.type));
  const startTurn = async (id = 'turn-1'): Promise<void> => {
    server.notify('turn/started', { threadId: 'thread-1', turn: { id, status: 'inProgress', error: null } });
    await flush();
  };
  const completeTurn = async (id = 'turn-1', status = 'completed', error: unknown = null): Promise<void> => {
    server.notify('turn/completed', { threadId: 'thread-1', turn: { id, status, error } });
    await flush();
  };
  return { server, events, sessionIds, session, types, startTurn, completeTurn };
}

describe('Codex app-server session', () => {
  it('handshakes, starts a thread with PopBot’s policy, and starts the first turn', async () => {
    const h = harness();
    await h.session.sendUser('hello');
    await flush();

    expect(h.server.methods()).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
    const start = h.server.last('thread/start').params!;
    expect(start).toMatchObject({
      model: 'gpt-5.6-sol',
      cwd: '/work',
      approvalPolicy: 'never',
      // No rule allows writes, so the policy fails closed.
      sandbox: 'read-only',
      config: { model_reasoning_effort: 'high', web_search: 'disabled' },
    });
    expect(h.server.last('turn/start').params).toMatchObject({
      threadId: 'thread-1',
      effort: 'high',
      input: [{ type: 'text', text: 'hello' }],
    });
    expect(h.sessionIds).toEqual(['thread-1']);

    await h.startTurn();
    expect(h.types()).toEqual(['status:running', 'turn-start']);
  });

  it('resumes the pinned thread instead of starting a new one', async () => {
    const h = harness({ sessionId: 'thread-old' });
    await h.session.sendUser('continue');
    await flush();
    expect(h.server.methods()).toContain('thread/resume');
    expect(h.server.methods()).not.toContain('thread/start');
    expect(h.server.last('thread/resume').params).toMatchObject({ threadId: 'thread-old', model: 'gpt-5.6-sol' });
    expect(h.server.last('turn/start').params).toMatchObject({ threadId: 'thread-old' });
  });

  it('reports a thread that can no longer be resumed in words AgentHost recognises', async () => {
    const h = harness({ sessionId: 'thread-gone' });
    h.server.answer = (msg) => (msg.method === 'thread/resume'
      ? { error: { code: -32600, message: 'no rollout found for thread id thread-gone' } }
      : defaultAnswer(msg));
    await h.session.sendUser('continue');
    await flush();
    const err = h.events.find((e) => e.type === 'error');
    // AgentHost.shouldRestartCodexWithContext keys on "thread … not found".
    expect(err && err.type === 'error' && err.message.toLowerCase()).toMatch(/thread.*not found/);
    expect(h.types()).toContain('status:errored');
  });

  it('STEERS a message sent while a turn is running, and tells the host', async () => {
    const h = harness();
    await h.session.sendUser('build the thing');
    await flush();
    await h.startTurn();

    await h.session.sendUser('actually, tests first');
    await flush();

    // Folded into the running turn — not a second turn, and not queued.
    expect(h.server.methods().filter((m) => m === 'turn/start')).toHaveLength(1);
    const steer = h.server.last('turn/steer').params!;
    expect(steer).toMatchObject({
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'actually, tests first' }],
    });
    expect(typeof steer.clientUserMessageId).toBe('string');
    expect(h.types()).toContain('turn-steered');
  });

  it('never loses a steered message: if the turn ends before Codex injects it, it becomes the next turn', async () => {
    const h = harness();
    await h.session.sendUser('first');
    await flush();
    await h.startTurn();
    await h.session.sendUser('second');
    await flush();
    expect(h.server.methods()).toContain('turn/steer');

    // The turn finishes without ever surfacing the steered message.
    h.server.notify('item/started', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'a1', text: '' } });
    h.server.notify('item/completed', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'a1', text: 'done' } });
    await h.completeTurn();

    const starts = h.server.sent.filter((m) => m.method === 'turn/start');
    expect(starts).toHaveLength(2);
    expect(starts[1].params).toMatchObject({ input: [{ type: 'text', text: 'second' }] });
    // The chat does not drop to idle in between.
    expect(h.types().at(-1)).toBe('status:running');
  });

  it('does not re-send a steered message once Codex has injected it', async () => {
    const h = harness();
    await h.session.sendUser('first');
    await flush();
    await h.startTurn();
    await h.session.sendUser('second');
    await flush();
    const clientId = h.server.last('turn/steer').params!.clientUserMessageId;

    h.server.notify('item/started', { turnId: 'turn-1', item: { type: 'userMessage', id: 'u2', clientId, content: [] } });
    h.server.notify('item/completed', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'a1', text: 'ok, tests first' } });
    await h.completeTurn();

    expect(h.server.sent.filter((m) => m.method === 'turn/start')).toHaveLength(1);
    expect(h.types().at(-1)).toBe('status:idle');
  });

  it('starts a turn instead when the turn ended while the steer was in flight', async () => {
    const h = harness();
    await h.session.sendUser('first');
    await flush();
    await h.startTurn();
    h.server.answer = (msg) => {
      if (msg.method !== 'turn/steer') return defaultAnswer(msg);
      // The server finished the turn just before our steer reached it.
      queueMicrotask(() => h.server.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } }));
      return { error: { code: -32600, message: 'no active turn to steer' } };
    };
    h.server.notify('item/completed', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'a1', text: 'done' } });
    await h.session.sendUser('one more thing');
    await flush();

    const starts = h.server.sent.filter((m) => m.method === 'turn/start');
    expect(starts).toHaveLength(2);
    expect(starts[1].params).toMatchObject({ input: [{ type: 'text', text: 'one more thing' }] });
    expect(h.types()).not.toContain('turn-steered');
  });

  it('holds a message behind a turn that cannot be steered (compaction), then sends it', async () => {
    const h = harness();
    await h.session.sendUser('first');
    await flush();
    await h.startTurn();
    h.server.answer = (msg) => (msg.method === 'turn/steer'
      ? { error: { code: -32600, message: 'cannot steer a compact turn', data: { codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'compact' } } } } }
      : defaultAnswer(msg));
    h.server.notify('item/started', { turnId: 'turn-1', item: { type: 'contextCompaction', id: 'c1' } });
    await h.session.sendUser('while you compact');
    await flush();
    expect(h.server.sent.filter((m) => m.method === 'turn/start')).toHaveLength(1);

    h.server.notify('item/completed', { turnId: 'turn-1', item: { type: 'contextCompaction', id: 'c1' } });
    await h.completeTurn();
    const starts = h.server.sent.filter((m) => m.method === 'turn/start');
    expect(starts).toHaveLength(2);
    expect(starts[1].params).toMatchObject({ input: [{ type: 'text', text: 'while you compact' }] });
  });

  it('falls back to queueing, permanently, on a CLI without turn/steer', async () => {
    const h = harness();
    await h.session.sendUser('first');
    await flush();
    await h.startTurn();
    h.server.answer = (msg) => (msg.method === 'turn/steer'
      ? { error: { code: -32601, message: 'method not found' } }
      : defaultAnswer(msg));
    await h.session.sendUser('second');
    await h.session.sendUser('third');
    await flush();
    // Asked once, learned, did not ask again.
    expect(h.server.sent.filter((m) => m.method === 'turn/steer')).toHaveLength(1);

    h.server.notify('item/completed', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'a1', text: 'done' } });
    await h.completeTurn();
    const starts = h.server.sent.filter((m) => m.method === 'turn/start');
    expect(starts).toHaveLength(2);
    // Both waiting messages go as ONE turn, in order.
    expect(starts[1].params).toMatchObject({
      input: [{ type: 'text', text: 'second' }, { type: 'text', text: 'third' }],
    });
  });

  it('Stop interrupts the turn and drops anything still waiting', async () => {
    const h = harness();
    await h.session.sendUser('first');
    await flush();
    await h.startTurn();
    h.server.answer = (msg) => (msg.method === 'turn/steer'
      ? { error: { code: -32601, message: 'method not found' } }
      : defaultAnswer(msg));
    await h.session.sendUser('queued behind it');
    await flush();

    h.session.stop();
    await flush();
    expect(h.server.last('turn/interrupt').params).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
    await h.completeTurn('turn-1', 'interrupted');

    expect(h.server.sent.filter((m) => m.method === 'turn/start')).toHaveLength(1);
    expect(h.types().filter((t) => t === 'status:errored')).toHaveLength(0);
    expect(h.types().at(-1)).toBe('status:idle');
  });

  it('streams agent text from deltas and does not repeat it from the completed item', async () => {
    const h = harness();
    await h.session.sendUser('hi');
    await flush();
    await h.startTurn();
    h.server.notify('item/started', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'a1', text: '' } });
    h.server.notify('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'a1', delta: 'Hello ' });
    h.server.notify('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'a1', delta: 'there' });
    h.server.notify('item/completed', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'a1', text: 'Hello there' } });
    await h.completeTurn();

    const text = h.events.filter((e) => e.type === 'text-delta').map((e) => (e.type === 'text-delta' ? e.delta : ''));
    expect(text.join('')).toBe('Hello there');
    expect(h.types().filter((t) => t === 'message-start')).toHaveLength(1);
    expect(h.types().filter((t) => t === 'message-end')).toHaveLength(1);
  });

  it('uses the completed item’s text when no deltas arrived', async () => {
    const h = harness();
    await h.session.sendUser('hi');
    await flush();
    await h.startTurn();
    h.server.notify('item/completed', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'a1', text: 'All at once' } });
    await h.completeTurn();
    const text = h.events.filter((e) => e.type === 'text-delta').map((e) => (e.type === 'text-delta' ? e.delta : ''));
    expect(text).toEqual(['All at once']);
  });

  it('maps a shell command to a Bash tool row with its output and exit status', async () => {
    const h = harness();
    await h.session.sendUser('run it');
    await flush();
    await h.startTurn();
    h.server.notify('item/started', { turnId: 'turn-1', item: { type: 'commandExecution', id: 'c1', command: 'npm test', status: 'inProgress' } });
    h.server.notify('item/completed', { turnId: 'turn-1', item: { type: 'commandExecution', id: 'c1', command: 'npm test', status: 'completed', aggregatedOutput: '1 failed', exitCode: 1 } });
    await flush();

    const use = h.events.find((e) => e.type === 'tool-use');
    const result = h.events.find((e) => e.type === 'tool-result');
    expect(use).toMatchObject({ name: 'Bash', args: { command: 'npm test' } });
    expect(result).toMatchObject({ text: '1 failed', isError: true });
    expect(use && result && use.type === 'tool-use' && result.type === 'tool-result' && use.toolUseId === result.toolUseId).toBe(true);
  });

  it('reports context usage against the model’s window', async () => {
    const h = harness();
    await h.session.sendUser('hi');
    await flush();
    h.server.notify('thread/tokenUsage/updated', {
      tokenUsage: { last: { totalTokens: 11_484 }, total: { totalTokens: 90_000 }, modelContextWindow: 258_400 },
    });
    await flush();
    expect(h.events.find((e) => e.type === 'usage')).toMatchObject({ tokens: { used: 11_484, budget: 258_400 } });
  });

  it('compacts on request and reports before/after from the usage around it', async () => {
    const h = harness();
    await h.session.sendUser('hi');
    await flush();
    await h.startTurn();
    h.server.notify('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 12_107 }, modelContextWindow: 258_400 } });
    h.server.notify('item/completed', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'a1', text: 'hello' } });
    await h.completeTurn();

    await h.session.compact?.();
    await flush();
    expect(h.server.last('thread/compact/start').params).toEqual({ threadId: 'thread-1' });

    await h.startTurn('turn-2');
    h.server.notify('item/started', { turnId: 'turn-2', item: { type: 'contextCompaction', id: 'c1' } });
    h.server.notify('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 4_840 }, modelContextWindow: 258_400 } });
    h.server.notify('item/completed', { turnId: 'turn-2', item: { type: 'contextCompaction', id: 'c1' } });
    await h.completeTurn('turn-2');

    const phases = h.events.filter((e) => e.type === 'compaction');
    expect(phases.map((e) => (e.type === 'compaction' ? e.phase : ''))).toEqual(['started', 'done']);
    expect(phases[1]).toMatchObject({ preTokens: 12_107, postTokens: 4_840 });
    // A compaction turn says nothing, and must not be retried as "empty".
    expect(h.events.some((e) => e.type === 'error')).toBe(false);
    expect(h.types().at(-1)).toBe('status:idle');
  });

  it('shows an account limit as a warning, not a fault', async () => {
    const h = harness();
    await h.session.sendUser('hi');
    await flush();
    await h.startTurn();
    await h.completeTurn('turn-1', 'failed', {
      message: "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.",
    });
    expect(h.events.find((e) => e.type === 'error')).toMatchObject({ level: 'warning' });
    expect(h.types().at(-1)).toBe('status:errored');
  });

  it('flags a turn that produced nothing as retryable, like the exec backend', async () => {
    const h = harness();
    await h.session.sendUser('hi');
    await flush();
    await h.startTurn();
    await h.completeTurn();
    expect(h.events.find((e) => e.type === 'error')).toMatchObject({ level: 'notice', retryable: true });
  });

  it('declines an approval request rather than leaving the turn waiting', async () => {
    const h = harness();
    await h.session.sendUser('hi');
    await flush();
    h.server.notify = h.server.notify.bind(h.server);
    // A server→client REQUEST carries an id.
    (h.server as unknown as { lineHandler: (l: string) => void }).lineHandler(
      JSON.stringify({ id: 77, method: 'item/commandExecution/requestApproval', params: {} }),
    );
    await flush();
    expect(h.server.sent.find((m) => m.id === 77)).toMatchObject({ result: { decision: 'decline' } });
  });

  it('surfaces a server that dies mid-turn, and is no longer alive', async () => {
    const h = harness();
    await h.session.sendUser('hi');
    await flush();
    await h.startTurn();
    h.server.die('codex app-server stopped (exit code 1): not logged in');
    await flush();
    expect(h.session.isAlive()).toBe(false);
    expect(h.events.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringContaining('exit code 1') });
    expect(h.types().at(-1)).toBe('status:errored');
  });

  it('stays quiet when the server goes away between turns — the host just respawns', async () => {
    const h = harness();
    await h.session.sendUser('hi');
    await flush();
    await h.startTurn();
    h.server.notify('item/completed', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'a1', text: 'done' } });
    await h.completeTurn();
    h.server.die('codex app-server stopped (signal SIGTERM)');
    await flush();
    expect(h.session.isAlive()).toBe(false);
    expect(h.events.some((e) => e.type === 'error')).toBe(false);
  });

  it('sends images as local images, ahead of the text', async () => {
    const h = harness();
    await h.session.sendUser('what is this?', [
      { id: '1', path: '/tmp/shot.png', name: 'shot.png', sizeBytes: 10, isImage: true },
      { id: '2', path: '/tmp/log.txt', name: 'log.txt', sizeBytes: 10, isImage: false },
    ]);
    await flush();
    expect(h.server.last('turn/start').params!.input).toEqual([
      { type: 'localImage', path: '/tmp/shot.png' },
      { type: 'text', text: 'Attached file: `/tmp/log.txt`', text_elements: [] },
      { type: 'text', text: 'what is this?', text_elements: [] },
    ]);
  });

  it('dispose closes the connection and silences late events', async () => {
    const h = harness();
    await h.session.sendUser('hi');
    await flush();
    await h.session.dispose();
    const before = h.events.length;
    h.server.notify('turn/started', { turn: { id: 'turn-9', status: 'inProgress', error: null } });
    await flush();
    expect(h.server.closedByClient).toBe(true);
    expect(h.events.length).toBe(before);
    expect(h.session.isAlive()).toBe(false);
  });
});
