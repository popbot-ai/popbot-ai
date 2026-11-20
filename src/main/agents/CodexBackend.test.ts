import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/agent';
import type { SpawnOpts } from './types';

// The Codex SDK, as the test plays it: every turn is recorded and stays
// open until the test finishes it (or it is aborted, as Stop does).
interface FakeTurn {
  input: unknown;
  finish: () => void;
  aborted: boolean;
}
const sdk = { turns: [] as FakeTurn[] };

vi.mock('../diagLog', () => ({ dlog: () => undefined }));
vi.mock('@openai/codex-sdk', () => {
  class Thread {
    async runStreamed(input: unknown, opts: { signal: AbortSignal }): Promise<{ events: AsyncGenerator<unknown> }> {
      let finish: () => void = () => undefined;
      const done = new Promise<void>((resolve) => { finish = resolve; });
      const turn: FakeTurn = { input, finish, aborted: false };
      sdk.turns.push(turn);
      const stopped = new Promise<never>((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => { turn.aborted = true; reject(new Error('aborted')); });
      });
      const n = sdk.turns.length;
      async function* events(): AsyncGenerator<unknown> {
        if (n === 1) yield { type: 'thread.started', thread_id: 'thread-1' };
        yield { type: 'turn.started' };
        await Promise.race([done, stopped]);
        yield { type: 'item.completed', item: { type: 'agent_message', id: 'item_0', text: `reply ${n}` } };
        yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
      }
      return { events: events() };
    }
  }
  class Codex {
    startThread(): Thread { return new Thread(); }
    resumeThread(): Thread { return new Thread(); }
  }
  return { Codex };
});

const { CodexBackend } = await import('./CodexBackend');
const { HELD_LEAD, HELD_NOW, withHeldMessages } = await import('./codexShared');

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

function harness() {
  const events: AgentEvent[] = [];
  const session = CodexBackend.spawn({
    chatId: 'chat_1',
    history: [],
    cwd: '/work',
    onEvent: (e: AgentEvent) => events.push(e),
    resolveRule: () => null,
  } as unknown as SpawnOpts);
  const statuses = (): string[] => events.filter((e) => e.type === 'session-status').map((e) => (e as { status: string }).status);
  return { session, events, statuses };
}

beforeEach(() => {
  sdk.turns = [];
});

describe('Codex exec session: messages sent while a turn is running', () => {
  it('runs them one after another when the turn is left to finish', async () => {
    const h = harness();
    await h.session.sendUser('first');
    await h.session.sendUser('second');
    await flush();
    expect(sdk.turns.map((t) => t.input)).toEqual(['first']);
    sdk.turns[0].finish();
    await flush();
    expect(sdk.turns.map((t) => t.input)).toEqual(['first', 'second']);
  });

  it('Stop starts nothing more, and the next message brings what was still waiting', async () => {
    const h = harness();
    await h.session.sendUser('first');
    await h.session.sendUser('do it the other way');
    await h.session.sendUser('and add tests');
    await flush();

    h.session.stop();
    await flush();
    expect(sdk.turns).toHaveLength(1);
    expect(sdk.turns[0].aborted).toBe(true);
    expect(h.statuses().at(-1)).toBe('idle');

    await h.session.sendUser('go on');
    await flush();
    expect(sdk.turns).toHaveLength(2);
    expect(sdk.turns[1].input).toBe([HELD_LEAD, 'do it the other way', 'and add tests', HELD_NOW, 'go on'].join('\n\n'));

    // Sent once: the message after that goes alone.
    sdk.turns[1].finish();
    await flush();
    await h.session.sendUser('thanks');
    await flush();
    expect(sdk.turns[2].input).toBe('thanks');
  });

  it('keeps holding across a second Stop', async () => {
    const h = harness();
    await h.session.sendUser('first');
    await h.session.sendUser('waiting 1');
    await flush();
    h.session.stop();
    await flush();
    // The next turn starts with the held message; a message sent behind it is then stopped too.
    await h.session.sendUser('second');
    await h.session.sendUser('waiting 2');
    await flush();
    expect(sdk.turns[1].input).toBe([HELD_LEAD, 'waiting 1', HELD_NOW, 'second'].join('\n\n'));
    h.session.stop();
    await flush();
    await h.session.sendUser('third');
    await flush();
    expect(sdk.turns[2].input).toBe([HELD_LEAD, 'waiting 2', HELD_NOW, 'third'].join('\n\n'));
  });
});

describe('withHeldMessages', () => {
  const image = { path: '/tmp/a.png', isImage: true, name: 'a.png' } as never;
  const file = { path: '/tmp/b.txt', isImage: false, name: 'b.txt' } as never;

  it('leaves a message alone when nothing is held', () => {
    const next = { text: 'hello' };
    expect(withHeldMessages([], next)).toBe(next);
  });

  it('puts held messages first, oldest first, and says which is which', () => {
    expect(withHeldMessages([{ text: 'one' }, { text: ' two ' }], { text: 'three' }).text)
      .toBe([HELD_LEAD, 'one', 'two', HELD_NOW, 'three'].join('\n\n'));
  });

  it('brings the held messages’ attachments, ahead of the new ones', () => {
    const whole = withHeldMessages([{ text: 'see this', attachments: [image] }], { text: 'and this', attachments: [file] });
    expect(whole.attachments).toEqual([image, file]);
  });

  it('copes with a held message that was only an attachment, and a new one that is', () => {
    expect(withHeldMessages([{ text: '', attachments: [image] }], { text: 'look' })).toEqual({ text: 'look', attachments: [image] });
    expect(withHeldMessages([{ text: 'earlier' }], { text: '', attachments: [file] })).toEqual({
      text: [HELD_LEAD, 'earlier'].join('\n\n'),
      attachments: [file],
    });
  });
});
