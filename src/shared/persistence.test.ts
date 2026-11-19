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
  it('defaults new Codex chats to GPT-6.1 Sol', () => {
    expect(DEFAULT_CODEX_MODEL).toBe('gpt-6.1-sol');
    expect(normalizeCodexModel(null)).toBe('gpt-6.1-sol');
    expect(normalizeCodexModel('gpt-4o')).toBe('gpt-6.1-sol');
  });

  it('moves chats on any earlier Sol up to GPT-6.1 Sol, quietly', () => {
    // Sol supersedes itself, like Opus: GPT-6.1 Sol replaces GPT-5.6 Sol.
    for (const prior of ['gpt-5.6-sol', 'gpt-6-sol', 'gpt-5.5-sol']) {
      expect(normalizeCodexModel(prior)).toBe('gpt-6.1-sol');
    }
    expect(CODEX_MODELS).not.toContain('gpt-5.6-sol');
    // Another tier on the Sol line is not an earlier Sol.
    expect(normalizeCodexModel('gpt-6.1-sol-pro')).toBe(DEFAULT_CODEX_MODEL);
    // Terra, Luna and Astra are separate models and stay where they are.
    for (const other of ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra'] as const) {
      expect(normalizeCodexModel(other)).toBe(other);
    }
  });

  it('rolls retired gpt-5.5 chats forward to Terra, its price/performance equal', () => {
    // Not Sol: rolling a mid-tier chat onto the flagship would quietly raise
    // its cost, so retired models map to the closest tier, not the default.
    expect(normalizeCodexModel('gpt-5.5')).toBe('gpt-5.6-terra');
    expect(CODEX_MODELS).not.toContain('gpt-5.5');
  });

  it('offers GPT-6.1 Sol Fast: Sol on the priority tier, opt-in only', () => {
    expect(CODEX_MODELS).toContain('gpt-6.1-sol-fast');
    expect(CODEX_MODEL_LABELS['gpt-6.1-sol-fast']).toBe('GPT-6.1 Sol Fast');
    expect(codexWireModel('gpt-6.1-sol-fast')).toEqual({ model: 'gpt-6.1-sol', serviceTier: 'priority' });
    expect(codexWireModel('gpt-6.1-sol')).toEqual({ model: 'gpt-6.1-sol', serviceTier: null });
    expect(codexReasoningEffortsForModel('gpt-6.1-sol-fast')).toEqual(codexReasoningEffortsForModel('gpt-6.1-sol'));
    // Never a default, and nothing rolls onto it.
    expect(DEFAULT_CODEX_MODEL).not.toBe('gpt-6.1-sol-fast');
    expect(normalizeCodexModel('gpt-6.1-sol-fast')).toBe('gpt-6.1-sol-fast');
    expect(normalizeCodexModel('gpt-5.6-sol')).toBe('gpt-6.1-sol');
  });

  it('exposes GPT-6.1 Sol and the GPT-5.6 tiers', () => {
    expect(CODEX_MODELS).toContain('gpt-6.1-sol');
    expect(CODEX_MODELS).toContain('gpt-5.6-terra');
    expect(CODEX_MODELS).toContain('gpt-5.6-luna');
  });

  it('offers Anthropic\'s current line-up — Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.2', () => {
    expect(CLAUDE_MODELS).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2']);
    expect(CODEX_MODELS).toEqual(['gpt-6.1-sol', 'gpt-6.1-sol-fast', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra']);
  });

  it('defaults new chats to Opus 5.5 and Sol; Astra stays opt-in', () => {
    expect(DEFAULT_CLAUDE_MODEL).toBe('claude-opus-5-5');
    expect(normalizeClaudeModel(undefined)).toBe('claude-opus-5-5');
    expect(normalizeClaudeModel(null)).toBe('claude-opus-5-5');
    expect(normalizeClaudeModel('gpt-4o')).toBe('claude-opus-5-5');
    expect(DEFAULT_CODEX_MODEL).not.toBe('gpt-6-astra');
    expect(normalizeCodexModel(undefined)).toBe('gpt-6.1-sol');
    expect(normalizeCodexModel('gpt-6-astra')).toBe('gpt-6-astra');
    for (const current of ['gpt-6.1-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const) {
      expect(normalizeCodexModel(current)).toBe(current);
    }
    expect(normalizeCodexModel('gpt-5.5')).toBe('gpt-5.6-terra');
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
