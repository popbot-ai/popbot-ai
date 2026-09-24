import { describe, expect, it } from 'vitest';
import {
  agentCacheKey,
  blocksToText,
  cloudPreamble,
  eventId,
  githubRepoUrl,
  mountPathFor,
  newTurnState,
  translateEvent,
  type CloudStreamEvent,
} from './managedAgents';

const ts = 1_700_000_000_000;
const at = '2026-09-23T10:00:00Z';

function run(events: CloudStreamEvent[]) {
  const st = newTurnState('chat_1');
  return { st, out: events.flatMap((ev) => translateEvent(ev, st, ts)) };
}

describe('translateEvent', () => {
  it('streams an agent message from its preview, then tops it up from the final event', () => {
    const { out } = run([
      { type: 'event_start', event: { type: 'agent.message', id: 'sevt_a' } },
      { type: 'event_delta', event_id: 'sevt_a', delta: { type: 'content_delta', index: 0, content: { type: 'text', text: 'Hello' } } },
      { type: 'event_delta', event_id: 'sevt_a', delta: { type: 'content_delta', index: 0, content: { type: 'text', text: ', wor' } } },
      { type: 'agent.message', id: 'sevt_a', processed_at: at, content: [{ type: 'text', text: 'Hello, world.' }] },
    ]);
    expect(out.map((e) => e.type)).toEqual(['message-start', 'text-delta', 'text-delta', 'text-delta', 'message-end']);
    const deltas = out.filter((e) => e.type === 'text-delta').map((e) => (e as { delta: string }).delta);
    expect(deltas.join('')).toBe('Hello, world.');
    expect(out.every((e) => !('messageId' in e) || e.messageId === 'sevt_a')).toBe(true);
  });

  it('emits a whole message when no preview streamed (history replay, shed deltas)', () => {
    const { out } = run([
      { type: 'agent.message', id: 'sevt_b', processed_at: at, content: [{ type: 'text', text: 'Done.' }, { type: 'redacted' }] },
    ]);
    expect(out.map((e) => e.type)).toEqual(['message-start', 'text-delta', 'message-end']);
    expect((out[1] as { delta: string }).delta).toBe('Done.[redacted]');
  });

  it('drops an empty message and ignores thinking previews', () => {
    const { out } = run([
      { type: 'event_start', event: { type: 'agent.thinking', id: 'sevt_t' } },
      { type: 'agent.message', id: 'sevt_e', processed_at: at, content: [] },
    ]);
    expect(out).toEqual([]);
  });

  it('maps tool calls and results, naming MCP tools the way PopBot rules expect', () => {
    const { out } = run([
      { type: 'agent.tool_use', id: 'sevt_tu', processed_at: at, name: 'bash', input: { command: 'ls' } },
      { type: 'agent.tool_result', id: 'sevt_tr', processed_at: at, tool_use_id: 'sevt_tu', content: [{ type: 'text', text: 'a\nb' }] },
      { type: 'agent.mcp_tool_use', id: 'sevt_mu', processed_at: at, name: 'get_issue', mcp_server_name: 'linear', input: { id: 'ENG-1' } },
      { type: 'agent.mcp_tool_result', id: 'sevt_mr', processed_at: at, mcp_tool_use_id: 'sevt_mu', is_error: true, content: [{ type: 'text', text: 'nope' }] },
    ]);
    expect(out).toEqual([
      { type: 'tool-use', chatId: 'chat_1', messageId: '', toolUseId: 'sevt_tu', name: 'bash', args: { command: 'ls' }, ts },
      { type: 'tool-result', chatId: 'chat_1', messageId: '', toolUseId: 'sevt_tu', isError: false, text: 'a\nb', ts },
      { type: 'tool-use', chatId: 'chat_1', messageId: '', toolUseId: 'sevt_mu', name: 'mcp__linear__get_issue', args: { id: 'ENG-1' }, ts },
      { type: 'tool-result', chatId: 'chat_1', messageId: '', toolUseId: 'sevt_mu', isError: true, text: 'nope', ts },
    ]);
  });

  it('turns a tool call that needs confirmation into a permission request and remembers it', () => {
    const { st, out } = run([
      { type: 'agent.tool_use', id: 'sevt_ask', processed_at: at, name: 'bash', input: { command: 'rm -rf x' }, evaluated_permission: 'ask' },
      { type: 'session.status_idle', id: 'sevt_idle', processed_at: at, stop_reason: { type: 'requires_action', event_ids: ['sevt_ask'] } },
    ]);
    expect(out.map((e) => e.type)).toEqual(['tool-use', 'permission-request', 'session-status']);
    expect(out[1]).toMatchObject({ permissionId: 'sevt_ask', tool: 'bash' });
    expect(out[2]).toMatchObject({ status: 'paused' });
    expect([...st.pendingConfirmations]).toEqual(['sevt_ask']);
  });

  it('brackets a turn with turn-start / running and idle', () => {
    const { out } = run([
      { type: 'session.status_running', id: 'sevt_r', processed_at: at },
      { type: 'session.status_idle', id: 'sevt_i', processed_at: at, stop_reason: { type: 'end_turn' } },
    ]);
    expect(out.map((e) => e.type)).toEqual(['turn-start', 'session-status', 'session-status']);
    expect(out[1]).toMatchObject({ status: 'running' });
    expect(out[2]).toMatchObject({ status: 'idle' });
  });

  it('reports errors by their retry status and ends the session on a terminal one', () => {
    const { st, out } = run([
      { type: 'session.error', id: 'sevt_e1', processed_at: at, error: { type: 'model_overloaded_error', message: 'Overloaded', retry_status: { type: 'retrying' } } },
      { type: 'session.error', id: 'sevt_e2', processed_at: at, error: { type: 'unknown_error', message: 'Boom', retry_status: { type: 'terminal' } } },
      { type: 'session.status_terminated', id: 'sevt_term', processed_at: at },
      { type: 'session.status_terminated', id: 'sevt_term2', processed_at: at },
    ]);
    expect(out[0]).toMatchObject({ type: 'error', level: 'notice', message: 'Overloaded — the cloud is retrying…' });
    expect(out[1]).toMatchObject({ type: 'error', level: 'error', message: 'Boom The cloud session has ended.' });
    expect(st.ended).toBe(true);
    // The terminal error already ended it: the terminated event adds nothing.
    expect(out.slice(2)).toEqual([]);
  });

  it('notes the end of a session that simply terminated, once', () => {
    const { out } = run([
      { type: 'session.status_terminated', id: 'sevt_term', processed_at: at },
      { type: 'session.deleted', id: 'sevt_del', processed_at: at },
    ]);
    expect(out.map((e) => e.type)).toEqual(['note', 'session-status']);
    expect(out[0]).toMatchObject({ prefix: 'cloud' });
  });

  it('reads the context size off each model request and compaction off the thread', () => {
    const { out } = run([
      { type: 'span.model_request_end', id: 'sevt_m', processed_at: at, is_error: false, model_request_start_id: 'sevt_s',
        model_usage: { input_tokens: 1000, cache_read_input_tokens: 20000, cache_creation_input_tokens: 500, output_tokens: 300 } },
      { type: 'agent.thread_context_compacted', id: 'sevt_c', processed_at: at },
    ]);
    expect(out[0]).toMatchObject({ type: 'usage', tokens: { used: 21800, budget: 200000 } });
    expect(out[1]).toMatchObject({ type: 'compaction', phase: 'done', trigger: 'auto' });
  });

  it('ignores the echoes of what the user sent', () => {
    const { out } = run([
      { type: 'user.message', id: 'sevt_u', content: [{ type: 'text', text: 'hi' }] },
      { type: 'user.interrupt', id: 'sevt_x' },
      { type: 'user.tool_confirmation', id: 'sevt_y', tool_use_id: 'sevt_ask', result: 'allow' },
    ]);
    expect(out).toEqual([]);
  });
});

describe('eventId', () => {
  it('has ids for persisted events only', () => {
    expect(eventId({ type: 'event_start', event: { type: 'agent.message', id: 'sevt_a' } })).toBeNull();
    expect(eventId({ type: 'session.status_running', id: 'sevt_r', processed_at: at })).toBe('sevt_r');
  });
});

describe('blocksToText', () => {
  it('flattens text, redactions, and search results', () => {
    expect(blocksToText([
      { type: 'text', text: 'a' },
      { type: 'redacted' },
      { type: 'search_result', title: 'T', source: 'https://x', citations: { enabled: false }, content: [{ type: 'text', text: 'body' }] },
    ])).toBe('a[redacted]T — https://x\nbody');
    expect(blocksToText(undefined)).toBe('');
  });
});

describe('githubRepoUrl', () => {
  it('normalizes the remote forms git produces to the one form the API takes', () => {
    expect(githubRepoUrl('https://github.com/popbot-ai/popbot-ai.git')).toBe('https://github.com/popbot-ai/popbot-ai');
    expect(githubRepoUrl('git@github.com:popbot-ai/popbot-ai.git')).toBe('https://github.com/popbot-ai/popbot-ai');
    expect(githubRepoUrl('ssh://git@github.com/popbot-ai/popbot-ai')).toBe('https://github.com/popbot-ai/popbot-ai');
    expect(githubRepoUrl('https://me@github.com/popbot-ai/popbot-ai/')).toBe('https://github.com/popbot-ai/popbot-ai');
    expect(githubRepoUrl('https://gitlab.com/x/y.git')).toBeNull();
    expect(githubRepoUrl('')).toBeNull();
  });
});

describe('the rest', () => {
  it('mounts under /workspace by repo name and keys agents by model + effort', () => {
    expect(mountPathFor('https://github.com/popbot-ai/popbot-ai')).toBe('/workspace/popbot-ai');
    expect(agentCacheKey('claude-opus-5', 'high')).toBe('claude-opus-5|high');
  });

  it('tells the agent where the repository is and where to push', () => {
    const text = cloudPreamble({ url: 'https://github.com/o/r', branch: 'ben/x', mountPath: '/workspace/r' }, '');
    expect(text).toContain('/workspace/r');
    expect(text).toContain('push it to branch ben/x');
    expect(cloudPreamble(null, ' Respond in French.')).toContain('No repository is mounted');
    expect(cloudPreamble(null, ' Respond in French.')).toContain('Respond in French.');
  });
});
