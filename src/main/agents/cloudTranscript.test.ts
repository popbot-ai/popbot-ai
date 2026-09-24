import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TerminalTranscript, parseTranscriptLines } from './cloudTranscript';

const fixture = (name: string): string => readFileSync(join(process.cwd(), 'test', 'fixtures', name), 'utf8');

/** The captures were made at 140×40 — the emulator must match. */
function render(raw: string): TerminalTranscript {
  const t = new TerminalTranscript(140, 40);
  t.write(raw);
  return t;
}

describe('TerminalTranscript on captured Claude Code sessions', () => {
  it('reads a prompt and the agent’s reply, and sees the attached input box', async () => {
    const t = render(fixture('claude-tui-text.bin'));
    await new Promise((r) => setTimeout(r, 50));
    const tr = t.transcript();
    expect(tr.attached).toBe(true);
    expect(tr.running).toBe(false);
    expect(tr.blocks).toEqual([
      { kind: 'user', text: 'Reply with exactly these two words and nothing else: PONG DONE' },
      { kind: 'agent', text: 'PONG DONE' },
    ]);
    t.dispose();
  });

  it('reads a collapsed tool call as a tool block, then the reply', async () => {
    const t = render(fixture('claude-tui-tool.bin'));
    await new Promise((r) => setTimeout(r, 50));
    const tr = t.transcript();
    expect(tr.attached).toBe(true);
    expect(tr.blocks).toEqual([
      { kind: 'user', text: 'Run ls src with Bash, then tell me how many entries it printed, in one short sentence.' },
      { kind: 'tool', text: 'Listed 1 directory' },
      { kind: 'agent', text: 'The ls src command printed 4 entries: main, preload, renderer, and shared.' },
    ]);
    t.dispose();
  });
});

describe('parseTranscriptLines', () => {
  it('joins continuation lines, reads expanded tool calls, and spots a running turn', () => {
    const tr = parseTranscriptLines([
      ' ▐▛███▛█   Claude Code v2.1.281',
      '',
      '❯ do the thing',
      '',
      '⏺ Bash(ls src)',
      '  ⎿  main',
      '     preload',
      '',
      '⏺ Two lines of',
      '  prose here.',
      '',
      '✻ Thinking… (esc to interrupt)',
      '',
      '────────────────────────────────',
      '❯ ',
      '────────────────────────────────',
      '  ? for shortcuts',
    ]);
    expect(tr.attached).toBe(true);
    expect(tr.running).toBe(true);
    expect(tr.blocks).toEqual([
      { kind: 'user', text: 'do the thing' },
      { kind: 'tool', text: 'Bash(ls src)', output: 'main\npreload' },
      { kind: 'agent', text: 'Two lines of\nprose here.' },
    ]);
  });

  it('is not attached without the input box, and ignores the banner', () => {
    const tr = parseTranscriptLines(['❯ claude --cloud "hi"', ' ▐▛███▛█   Claude Code v2.1.281', 'more banner', '❯ hi', '', '⏺ hello']);
    expect(tr.attached).toBe(false);
    expect(tr.blocks).toEqual([{ kind: 'user', text: 'hi' }, { kind: 'agent', text: 'hello' }]);
  });
});
