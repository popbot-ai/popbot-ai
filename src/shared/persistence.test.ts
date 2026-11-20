import { describe, expect, it } from 'vitest';
import {
  CLAUDE_MODELS,
  CLAUDE_MODEL_LABELS,
  CODEX_MODELS,
  CODEX_MODEL_LABELS,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  closestReasoningEffort,
  codexReasoningEffortsForModel,
  codexWireModel,
  normalizeClaudeModel,
  normalizeCodexModel,
} from './persistence';

describe('model registry', () => {
  it('defaults new Codex chats to GPT-6.2 Sol', () => {
    expect(DEFAULT_CODEX_MODEL).toBe('gpt-6.2-sol');
    expect(normalizeCodexModel(null)).toBe('gpt-6.2-sol');
    expect(normalizeCodexModel(undefined)).toBe('gpt-6.2-sol');
    expect(normalizeCodexModel('gpt-4o')).toBe('gpt-6.2-sol');
  });

  it('offers the current Codex line-up — 6.2 Sol (and Fast), 6.1 Terra, 6 Luna, 6.2 Astra', () => {
    expect(CODEX_MODELS).toEqual(['gpt-6.2-sol', 'gpt-6.2-sol-fast', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6.2-astra']);
    for (const current of CODEX_MODELS) expect(normalizeCodexModel(current)).toBe(current);
  });

  it('moves every earlier Codex version up to the current model of its own line', () => {
    for (const prior of ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.5-sol']) {
      expect(normalizeCodexModel(prior)).toBe('gpt-6.2-sol');
    }
    expect(normalizeCodexModel('gpt-6.1-sol-fast')).toBe('gpt-6.2-sol-fast');
    expect(normalizeCodexModel('gpt-5.6-terra')).toBe('gpt-6.1-terra');
    expect(normalizeCodexModel('gpt-5.6-luna')).toBe('gpt-6-luna');
    expect(normalizeCodexModel('gpt-6-astra')).toBe('gpt-6.2-astra');
    // A retired model with no line of its own maps to its closest tier.
    expect(normalizeCodexModel('gpt-5.5')).toBe('gpt-6.1-terra');
    // Another tier on the Sol line is not an earlier Sol.
    expect(normalizeCodexModel('gpt-6.2-sol-pro')).toBe(DEFAULT_CODEX_MODEL);
  });

  it('keeps Astra opt-in: never the default, reached only from an earlier Astra', () => {
    expect(DEFAULT_CODEX_MODEL).not.toBe('gpt-6.2-astra');
    for (const other of ['gpt-6.1-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-4o']) {
      expect(normalizeCodexModel(other)).not.toBe('gpt-6.2-astra');
    }
  });

  it('offers GPT-6.2 Sol Fast: Sol on the priority tier, opt-in only', () => {
    expect(CODEX_MODEL_LABELS['gpt-6.2-sol-fast']).toBe('GPT-6.2 Sol Fast');
    expect(codexWireModel('gpt-6.2-sol-fast')).toEqual({ model: 'gpt-6.2-sol', serviceTier: 'priority' });
    expect(codexWireModel('gpt-6.2-sol')).toEqual({ model: 'gpt-6.2-sol', serviceTier: null });
    expect(codexReasoningEffortsForModel('gpt-6.2-sol-fast')).toEqual(codexReasoningEffortsForModel('gpt-6.2-sol'));
    expect(DEFAULT_CODEX_MODEL).not.toBe('gpt-6.2-sol-fast');
    // A plain Sol never lands on the fast tier.
    expect(normalizeCodexModel('gpt-6.1-sol')).not.toBe('gpt-6.2-sol-fast');
  });

  it('offers Anthropic\'s current line-up — Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.2', () => {
    expect(CLAUDE_MODELS).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2']);
  });

  it('defaults new Claude chats to Opus 5.5', () => {
    expect(DEFAULT_CLAUDE_MODEL).toBe('claude-opus-5-5');
    expect(normalizeClaudeModel(undefined)).toBe('claude-opus-5-5');
    expect(normalizeClaudeModel(null)).toBe('claude-opus-5-5');
    expect(normalizeClaudeModel('gpt-4o')).toBe('claude-opus-5-5');
  });

  it('keeps a chat on any current model it chose', () => {
    for (const current of CLAUDE_MODELS) expect(normalizeClaudeModel(current)).toBe(current);
  });

  it('moves every earlier version up to the current model of its own line', () => {
    // Each line supersedes itself; upstream keeps the old versions only as
    // legacy and retires them, so a pinned chat must move, not fail.
    for (const old of ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-opus-4-1']) {
      expect(normalizeClaudeModel(old)).toBe('claude-opus-5-5');
    }
    expect(normalizeClaudeModel('claude-sonnet-5')).toBe('claude-sonnet-5-5');
    expect(normalizeClaudeModel('claude-sonnet-4-6')).toBe('claude-sonnet-5-5');
    expect(normalizeClaudeModel('claude-fable-5-1')).toBe('claude-fable-5-2');
    expect(normalizeClaudeModel('claude-fable-5')).toBe('claude-fable-5-2');
    expect(normalizeClaudeModel('claude-haiku-4-5')).toBe('claude-haiku-5-5');
    // Never across lines: a Sonnet doesn't become an Opus.
    expect(normalizeClaudeModel('claude-sonnet-5')).not.toBe('claude-opus-5-5');
  });

  it('labels every model in the pickers', () => {
    for (const model of CLAUDE_MODELS) {
      expect(CLAUDE_MODEL_LABELS[model]).toBeTruthy();
    }
    for (const model of CODEX_MODELS) {
      expect(CODEX_MODEL_LABELS[model]).toBeTruthy();
    }
  });

  it('offers each Codex model the reasoning ladder from the CLI model catalog', () => {
    // Per the catalog in Codex 0.160.x: every model reaches `max`; `ultra`
    // is the top rung on Sol, Terra and Astra (Luna caps at `max`); and no
    // model has `none` any more — every ladder starts at `low`.
    for (const model of CODEX_MODELS) {
      expect(codexReasoningEffortsForModel(model)).toContain('max');
    }
    for (const model of ['gpt-6.1-sol', 'gpt-5.6-terra', 'gpt-6-astra'] as const) {
      expect(codexReasoningEffortsForModel(model)).toContain('ultra');
    }
    expect(codexReasoningEffortsForModel('gpt-5.6-luna')).not.toContain('ultra');
    expect(codexReasoningEffortsForModel('gpt-6-astra')).not.toContain('none');
    expect(codexReasoningEffortsForModel('gpt-6-astra')[0]).toBe('low');
    for (const model of CODEX_MODELS) {
      expect(codexReasoningEffortsForModel(model)).not.toContain('none');
      expect(codexReasoningEffortsForModel(model)[0]).toBe('low');
    }
  });

  it('snaps an `ultra` chat to `max` — not the default — when it moves to Luna', () => {
    expect(
      closestReasoningEffort(
        'ultra',
        codexReasoningEffortsForModel('gpt-5.6-luna'),
        DEFAULT_CODEX_REASONING_EFFORT,
      ),
    ).toBe('max');
  });

  it('snaps a `none` chat to `low` — not the default — when it moves to Astra', () => {
    expect(
      closestReasoningEffort(
        'none',
        codexReasoningEffortsForModel('gpt-6-astra'),
        DEFAULT_CODEX_REASONING_EFFORT,
      ),
    ).toBe('low');
  });

  it('keeps a chat on its own effort when the new model supports it', () => {
    expect(
      closestReasoningEffort(
        'xhigh',
        codexReasoningEffortsForModel('gpt-6-astra'),
        DEFAULT_CODEX_REASONING_EFFORT,
      ),
    ).toBe('xhigh');
  });
});
