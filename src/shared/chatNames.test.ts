import { describe, expect, it } from 'vitest';
import { chatShortName } from './chatNames';

describe("a chat's short name", () => {
  it('is a trailing UPPERCASE word', () => {
    expect(chatShortName('Magic Patch  - DANNY')).toBe('DANNY');
    expect(chatShortName('convert more packs MERVYN')).toBe('MERVYN');
    expect(chatShortName('run secure cloud on linux cuda - JERRY')).toBe('JERRY');
    expect(chatShortName('Docs rewrite (FREDDY)')).toBe('FREDDY');
    // Three letters is a name too (AMY, MOE) — so a trailing acronym reads as one.
    expect(chatShortName('convert more packs AMY')).toBe('AMY');
  });

  it('is the whole name when there is none', () => {
    expect(chatShortName('This chat is not a name')).toBe('This chat is not a name');
    expect(chatShortName('V2 API main chat')).toBe('V2 API main chat');
  });
});
