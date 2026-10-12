import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/agent';

// One chat, its status and last rows as the test sets them; the agent
// host records what it is sent and decided.
const state = {
  status: 'idle' as string,
  lastActiveAt: 0,
  lastTool: null as null | { name: string; args: Record<string, unknown> },
  lastAgentText: '',
  pendingPermission: null as null | string,
};
const settings = new Map<string, unknown>();
const sent: string[] = [];
const decided: Array<{ permissionId: string; decision: string; reason?: string }> = [];
const listeners: Array<(e: AgentEvent) => void> = [];

vi.mock('../persistence/db', () => ({ isDbOpen: () => true }));
vi.mock('../diagLog', () => ({ dlog: () => undefined }));
vi.mock('../persistence/settings', () => ({
  getSetting: (k: string) => settings.get(k),
  setSetting: (k: string, v: unknown) => { settings.set(k, v); },
}));
vi.mock('../persistence/chats', () => ({
  getChat: (id: string) => (id === 'chat_1' ? { id, status: state.status, lastActiveAt: state.lastActiveAt, host: null } : null),
  listOpenChats: () => [{ id: 'chat_1' }],
  updateChatStatus: (_id: string, status: string) => { state.status = status; },
}));
vi.mock('../persistence/messages', () => ({
  lastMessageOfKind: (_id: string, kind: string) => {
    if (kind === 'tool') return state.lastTool ? { body: JSON.stringify(state.lastTool) } : null;
    return { body: JSON.stringify({ text: state.lastAgentText }), createdAt: Date.now() };
  },
  listMessages: () => (state.pendingPermission
    ? [{ kind: 'permission', body: JSON.stringify({ permissionId: state.pendingPermission, tool: 'Bash', args: {} }) },
       { kind: 'permission', body: JSON.stringify({ permissionId: 'perm_2', tool: 'Edit', args: {} }) }]
    : []),
}));
vi.mock('./AgentHost', () => ({
  AgentHost: {
    onEvent: (l: (e: AgentEvent) => void) => { listeners.push(l); return () => undefined; },
    emit: (e: AgentEvent) => { for (const l of listeners) l(e); },
    send: async (_id: string, text: string) => { sent.push(text); },
    isAttached: () => true,
    approve: (_id: string, permissionId: string, decision: string, reason?: string) => { decided.push({ permissionId, decision, ...(reason ? { reason } : {}) }); },
  },
}));

const ac = await import('./autoContinue');
const emit = (e: Partial<AgentEvent> & { type: AgentEvent['type'] }): void => {
  for (const l of listeners) l({ chatId: 'chat_1', ts: Date.now(), ...e } as AgentEvent);
};

describe('auto-continue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000);
    Object.assign(state, { status: 'idle', lastActiveAt: Date.now(), lastTool: null, lastAgentText: '', pendingPermission: null });
    settings.clear();
    sent.length = 0;
    decided.length = 0;
    ac.startAutoContinue();
    emit({ type: 'turn-start' });
  });
  afterEach(() => {
    ac.stopAutoContinue();
    vi.useRealTimers();
  });

  it('nudges a chat that has been idle a minute, and again after each idle minute (forever)', async () => {
    ac.setAutoContinue('chat_1', 'forever');
    emit({ type: 'session-status', status: 'idle' } as Partial<AgentEvent> & { type: 'session-status' });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent).toEqual(['[Auto-continue from PopBot, not from the user] Please check for and continue any outstanding work.']);
    // Not again until that nudge's turn has run and gone quiet a minute.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(1);
    emit({ type: 'turn-start' });
    emit({ type: 'session-status', status: 'idle' } as Partial<AgentEvent> & { type: 'session-status' });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(sent).toHaveLength(2);
  });

  it('leaves a chat that is working, and gives one waiting on background work longer', async () => {
    ac.setAutoContinue('chat_1', 'forever');
    state.status = 'run';
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toEqual([]);
    state.status = 'idle';
    state.lastTool = { name: 'Bash', args: { run_in_background: true } };
    emit({ type: 'session-status', status: 'idle' } as Partial<AgentEvent> & { type: 'session-status' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(sent).toHaveLength(1);
  });

  it('denies a permission still pending after three minutes — the user is away', async () => {
    ac.setAutoContinue('chat_1', 'forever');
    state.status = 'wait';
    state.pendingPermission = 'perm_1';
    emit({ type: 'permission-request', permissionId: 'perm_1', tool: 'Bash', args: {} } as Partial<AgentEvent> & { type: 'permission-request' });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(decided).toEqual([]);
    await vi.advanceTimersByTimeAsync(70_000);
    // Every one it is waiting on (tools run in parallel).
    expect(decided).toEqual([
      { permissionId: 'perm_1', decision: 'deny', reason: 'User not available. Auto-continue mode on' },
      { permissionId: 'perm_2', decision: 'deny', reason: 'User not available. Auto-continue mode on' },
    ]);
    expect(sent).toEqual([]);
  });

  it('answers a question left three minutes: the user is away, carry on', async () => {
    ac.setAutoContinue('chat_1', 'until-complete');
    state.status = 'wait';
    emit({ type: 'session-status', status: 'paused' } as Partial<AgentEvent> & { type: 'session-status' });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(sent).toEqual(['[Auto-continue from PopBot, not from the user] User is not available now. Please check and continue any outstanding work. If all work is complete respond ALL WORK COMPLETE']);
  });

  it('stops for good once a nudge is answered ALL WORK COMPLETE (until-complete) — not on a mention of it', async () => {
    ac.setAutoContinue('chat_1', 'until-complete');
    // Said before any nudge: not the answer to one.
    state.lastAgentText = 'I will say ALL WORK COMPLETE when done.';
    emit({ type: 'session-status', status: 'idle' } as Partial<AgentEvent> & { type: 'session-status' });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(sent).toHaveLength(1);
    expect(ac.autoContinueModes()).toEqual({ chat_1: 'until-complete' });
    // The nudge's answer ends with it.
    emit({ type: 'turn-start' });
    state.lastAgentText = 'Checked everything. ALL WORK COMPLETE';
    emit({ type: 'session-status', status: 'idle' } as Partial<AgentEvent> & { type: 'session-status' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ac.autoContinueModes()).toEqual({});
    expect(state.status).toBe('done');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sent).toHaveLength(1);
  });
});
