import { describe, expect, it } from 'vitest';
import { trimSentInBody, trimToolBody } from './janitor';

describe('janitor trimming', () => {
  it('keeps the head of long tool output and says how much went', () => {
    const t = trimToolBody({ toolUseId: 't', name: 'Bash', args: { command: 'ls' }, result: 'x'.repeat(10_000) });
    expect(t?.trimmed).toBe(true);
    expect(t?.args).toEqual({ command: 'ls' });
    expect(t?.result?.startsWith('x'.repeat(2048) + '\n\n[trimmed by PopBot retention: 7952 more bytes dropped]')).toBe(true);
  });

  it('shortens long arguments (a whole file passed to Write)', () => {
    const t = trimToolBody({ toolUseId: 't', name: 'Write', args: { file_path: '/a.ts', content: 'y'.repeat(5_000) } });
    expect(t?.args.file_path).toBe('/a.ts');
    expect(String(t?.args.content)).toMatch(/^y{500}… \[4500 more characters trimmed\]$/);
  });

  it('leaves short or already-trimmed rows alone', () => {
    expect(trimToolBody({ toolUseId: 't', name: 'Bash', args: {}, result: 'ok' })).toBeNull();
    expect(trimToolBody({ toolUseId: 't', name: 'Bash', args: {}, result: 'x'.repeat(9_000), trimmed: true } as never)).toBeNull();
  });

  it('trims messages sent in by other chats, never the user’s own', () => {
    const long = 'z'.repeat(6_000);
    expect(trimSentInBody({ text: long, from: { chatId: 'chat_b', chatName: 'JERRY' } })?.text).toMatch(/^z{2048}\n\n\[trimmed by PopBot retention: 3952 more bytes dropped\]$/);
    expect(trimSentInBody({ text: long })).toBeNull();
    expect(trimSentInBody({ text: 'short', from: { chatId: 'popbot' } })).toBeNull();
  });
});
